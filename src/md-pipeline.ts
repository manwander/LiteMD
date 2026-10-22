/**
 * md-pipeline.ts — Markdown 渲染管线（E5 lane：渲染补强）
 *
 * 设计裁定落地（C-4 / C-5 / C-6）：
 *   - C-4 任务列表：复选框一律 disabled，点击回写由集成方在预览层做（占位）；
 *   - C-5 KaTeX：$...$ 行内 / $$...$$ 块级数学公式，katex 动态装载；
 *   - C-6 Mermaid：只留占位（不引库），围栏原文进 data-src（URI 编码）供集成方替换渲染。
 *
 * 契约（集成阶段按此接线，见 App.svelte initMd）：
 *   createMd()            — 返回配置完整的 markdown-it 实例；
 *   needsMath(doc)        — 文档是否含 $...$ / $$...$$，供集成方做懒加载判断；
 *   renderMathPlaceholder — KaTeX 不可用时的降级占位（依赖已装，此路径仅兜底）。
 *
 * 依赖装载策略（主 chunk 体积控制，对齐既有 initMd）：
 *   markdown-it / katex / markdown-it-task-lists 全部经动态 import 装载，
 *   由 Vite 按 import 边界切成独立 chunk；本模块自身亦应由集成方动态
 *   import，静态引用不会进入主 chunk。
 *
 * 安全边界：本模块产出的一切 HTML 仍必须经 sanitize.ts 清洗后才可注入 DOM
 *   （C-01：markdown-it 以 html:true 运行，原始 HTML 会透传）。
 */

import type MarkdownIt from "markdown-it";
import type { Options, Renderer, StateBlock, StateInline, Token } from "markdown-it";

/**
 * markdown-it-task-lists 无官方/社区类型声明（npm 无 @types 包），
 * 以窄接口描述调用契约；仅按默认形态使用：
 *   li 挂 task-list-item 类，复选框输出 <input disabled type="checkbox">
 * （disableCheckboxes 默认真——点击回写由预览层负责，C-4）。
 */
interface TaskListsOptions {
  /** true = 复选框可交互；默认 false = disabled */
  enabled?: boolean;
  label?: boolean;
  labelAfter?: boolean;
}

type TaskListsPlugin = (md: MarkdownIt, options?: TaskListsOptions) => void;

// @ts-ignore -- 运行时形态即 TaskListsPlugin（见上方接口）；无类型声明故抑制 TS7016
import taskLists from "markdown-it-task-lists";

/**
 * KaTeX 渲染入口窄接口（katex 包的类型默认导出是值形态，窄化后不依赖其导出形状）。
 * renderToString 的 options 只用到 displayMode/output/throwOnError 三项。
 */
interface KatexLike {
  renderToString(latex: string, options?: Record<string, unknown>): string;
}

/** createMd 可选项：集成方注入代码高亮回调（其余管线规则由本模块负责） */
export interface CreateMdOptions {
  /** 透传给 markdown-it 的 highlight 选项；缺省则不高亮代码块 */
  highlight?: Options["highlight"];
  /**
   * 是否需要数学支持。默认 true（createMd 内 await import("katex")，独立 chunk）。
   * 传 false 时跳过 katex 装载——数学公式退化为 math-pending 占位；
   * 供集成方按 needsMath(doc) 做懒加载：无数学的文档不必背 361kB katex。
   * 文档后续出现数学时，重新 createMd({ math: true }) 即可恢复。
   */
  math?: boolean;
}

/** KaTeX 渲染选项：纯 HTML 输出（不带 MathML，缩小 sanitize 审查面） */
const KATEX_RENDER_OPTIONS = {
  output: "html",
  throwOnError: false,
} as const;

/**
 * 构造配置完整的 markdown-it 解析器。
 *
 * 管线内容：
 *   1. html:true + linkify 收窄（只识别显式 http(s)://，对齐原 initMd 策略）
 *   2. markdown-it-task-lists（C-4，默认形态 = disabled 复选框）
 *   3. 数学规则（C-5）：$...$ 行内 / $$...$$ 块级，katex 动态装载
 *      （options.math !== false 时；可按 needsMath(doc) 跳过）
 *   4. Mermaid 占位（C-6）：```mermaid 围栏 → div.mermaid-placeholder
 *
 * 图片 asset:// 转换、代码高亮等宿主相关规则由集成方在返回后继续挂载
 * （renderer.rules.image 等后置赋值即可，不影响本管线）。
 */
export async function createMd(options: CreateMdOptions = {}): Promise<MarkdownIt> {
  const { default: MarkdownItCtor } = await import("markdown-it");

  // KaTeX 动态 import：独立 chunk，不进主 chunk；math:false 时整体跳过装载
  // （无数学文档不必背 katex；数学公式退化为 math-pending 占位）。
  // 装载失败时数学规则同样降级占位。
  let katex: KatexLike | null = null;
  if (options.math !== false) {
    try {
      const katexModule = await import("katex");
      katex = katexModule.default ?? (katexModule as unknown as KatexLike);
    } catch {
      katex = null;
    }
  }

  const instance = new MarkdownItCtor({
    html: true, // 原始 HTML 透传；安全性由 sanitize.ts 白名单兜底（C-01）
    // linkify 收窄：markdown-it 的 linkify 选项只判真假，传对象恒为真，
    // 必须构造后用 set() 收窄，否则含 URL/邮箱文本的解析耗时放大 9~22 倍。
    linkify: true,
    highlight: options.highlight,
  });
  instance.linkify.set({ fuzzyLink: false, fuzzyEmail: false });

  // C-4：任务列表（默认形态：disabled 复选框 + li.task-list-item）
  instance.use(taskLists as TaskListsPlugin);

  // C-5：数学公式（行内 / 块级）
  installMathRules(instance, katex);

  // C-6：Mermaid 占位（不引库）
  installMermaidPlaceholder(instance);

  return instance;
}

/**
 * 文档是否包含数学公式（供集成方决定是否懒加载 KaTeX 资源/CSS）。
 * 实现拆至零依赖模块 needs-math.ts（可静态进主 chunk）；此处 re-export
 * 保持既有导入路径（测试与外部调用方契约不变）。
 */
export { needsMath } from "./needs-math";

/**
 * KaTeX 不可用时的数学占位（兜底路径；当前依赖已安装，生产不会走到）。
 * 行内输出 <span class="math-pending">，块级输出 <div class="math-pending math-pending-block">。
 */
export function renderMathPlaceholder(latex: string, displayMode = false): string {
  const text = displayMode ? `$$${latex}$$` : `$${latex}$`;
  const cls = displayMode ? "math-pending math-pending-block" : "math-pending";
  const tag = displayMode ? "div" : "span";
  return `<${tag} class="${cls}">${escapeHtml(text)}</${tag}>`;
}

/**
 * 行内数学规则（$...$）。
 *
 * 判定复刻 GitHub 风格，避免常见误判：
 *   - 开 $ 后不能紧跟空白（"price is $ 5" 不是数学）；
 *   - 闭合 $ 前不能是空白、后不能是数字（"$5 and $10" 不是数学）；
 *   - $$ 不交由本规则（块级规则负责，行内 $$ 按普通文本渲染）；
 *   - 跳过 \$ 转义（escape 规则已先行消费，这里双保险）。
 */
function mathInlineRule(state: StateInline, silent: boolean): boolean {
  if (state.src.charCodeAt(state.pos) !== 0x24 /* $ */) return false;
  if (state.src.charCodeAt(state.pos + 1) === 0x24) return false;

  const start = state.pos + 1;
  const next = state.src.charCodeAt(start);
  // 开 $ 后禁空白/行尾（charCodeAt 越界返回 NaN，一并排除）
  if (next === 0x20 || next === 0x09 || next === 0x0a || Number.isNaN(next)) return false;

  // 扫描闭合 $（跳过奇数个反斜杠的转义位）
  let closed = -1;
  let res = start;
  while ((res = state.src.indexOf("$", res)) !== -1) {
    let back = res - 1;
    while (back >= start && state.src.charCodeAt(back) === 0x5c /* \ */) back--;
    if ((res - 1 - back) % 2 === 1) {
      res += 1; // 奇数个反斜杠 = 转义，继续找
      continue;
    }
    closed = res;
    break;
  }
  if (closed < 0 || closed === start) return false; // 无闭合 / 空内容

  const content = state.src.slice(start, closed);
  if (/\s$/.test(content)) return false; // 闭合 $ 前禁空白
  const after = state.src.charCodeAt(closed + 1);
  if (after >= 0x30 && after <= 0x39 /* 0-9 */) return false; // 闭合 $ 后禁数字

  if (!silent) {
    const token: Token = state.push("math_inline", "span", 0);
    token.markup = "$";
    token.content = content;
    token.meta = { displayMode: false };
  }
  state.pos = closed + 1;
  return true;
}

/**
 * 块级数学规则（$$...$$）。
 *
 * 两种形态（与 GitHub 一致）：
 *   - 单行闭合：行首 $$ 开头、同行 $$ 收尾（闭合后只允许空白）；
 *   - 多行闭合：行首 $$ 独占一行，后续行直到含 $$ 的闭行（闭行 $$ 后只允许空白）。
 * 未找到合法闭合时返回 false，交回段落规则按普通文本渲染（不吞内容）。
 */
function mathBlockRule(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  // ≥4 空格缩进是代码块，让位
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  const begin = state.bMarks[startLine] + state.tShift[startLine];
  if (state.src.charCodeAt(begin) !== 0x24 || state.src.charCodeAt(begin + 1) !== 0x24) return false;

  const firstLine = state.src.slice(begin + 2, state.eMarks[startLine]);
  let content: string;
  let nextLine = startLine + 1;

  const closeIdx = firstLine.indexOf("$$");
  if (closeIdx >= 0) {
    // 单行闭合；闭合 $$ 后只允许空白，否则不是数学块
    if (firstLine.slice(closeIdx + 2).trim() !== "") return false;
    content = firstLine.slice(0, closeIdx);
    nextLine = startLine + 1;
  } else {
    // 多行闭合：首行 $$ 之后到含 $$ 的闭行
    if (firstLine.trim() !== "") return false; // 首行有残留内容但未闭合 → 保守放弃
    let closed = false;
    let body = "";
    for (let ln = startLine + 1; ln < endLine; ln++) {
      const line = state.src.slice(state.bMarks[ln] + state.tShift[ln], state.eMarks[ln]);
      const idx = line.indexOf("$$");
      if (idx >= 0) {
        if (line.slice(idx + 2).trim() !== "") return false; // 闭行 $$ 后有残留 → 放弃
        body += line.slice(0, idx);
        nextLine = ln + 1;
        closed = true;
        break;
      }
      body += line + "\n";
    }
    if (!closed) return false; // 未找到闭合 → 交回段落
    content = body;
  }

  if (silent) return true;
  const token: Token = state.push("math_block", "div", 0);
  token.markup = "$$";
  token.map = [startLine, nextLine];
  token.content = content.trim();
  token.meta = { displayMode: true };
  state.line = nextLine;
  return true;
}

/** 挂载数学规则与渲染器（katex 为 null 时走 renderMathPlaceholder 兜底） */
function installMathRules(md: MarkdownIt, katex: KatexLike | null): void {
  // 块级先于 paragraph（catch-all）注册；行内接在 escape 之后
  md.block.ruler.before("paragraph", "math_block", mathBlockRule);
  md.inline.ruler.after("escape", "math_inline", mathInlineRule);

  md.renderer.rules.math_inline = (tokens: Token[], idx: number): string => {
    const latex = tokens[idx].content;
    if (katex) {
      try {
        return katex.renderToString(latex, { ...KATEX_RENDER_OPTIONS, displayMode: false });
      } catch {
        /* 极端失败降级占位 */
      }
    }
    return renderMathPlaceholder(latex, false);
  };

  md.renderer.rules.math_block = (tokens: Token[], idx: number): string => {
    const latex = tokens[idx].content;
    if (katex) {
      try {
        const html = katex.renderToString(latex, { ...KATEX_RENDER_OPTIONS, displayMode: true });
        // math-block 包裹层：给集成方一个 overflow/边距样式挂钩
        return `<div class="math-block">${html}</div>`;
      } catch {
        /* 同上 */
      }
    }
    return renderMathPlaceholder(latex, true);
  };
}

/**
 * C-6：Mermaid 占位。
 * ```mermaid 围栏 → <div class="mermaid-placeholder" data-src="...">原文文本</div>，
 * 不引库；集成方可在预览层检测该类并替换为真实渲染。
 *
 * data-src 编码说明（重要）：
 *   DOMPurify 默认 SAFE_FOR_XML=true 会剥除「属性值含 --> / ]]> 等」的属性
 *   （mXSS 防护），而 mermaid 流程图源码大量使用 -->。因此 data-src 以
 *   encodeURIComponent 编码存放，集成方读取时 decodeURIComponent 即可；
 *   同时原文以转义文本放进 div（sanitize 不拦文本节点），既是无 mermaid
 *   时的可见回退，也可直接 el.textContent 读取，双通道不依赖单一属性。
 */
function installMermaidPlaceholder(md: MarkdownIt): void {
  const defaultFence = md.renderer.rules.fence;
  md.renderer.rules.fence = (
    tokens: Token[],
    idx: number,
    options: Options,
    env: unknown,
    self: Renderer,
  ): string => {
    const token = tokens[idx];
    const lang = token.info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    if (lang === "mermaid") {
      const src = token.content;
      const encoded = encodeURIComponent(src);
      return `<div class="mermaid-placeholder" data-src="${encoded}">${md.utils.escapeHtml(src)}</div>`;
    }
    return defaultFence
      ? defaultFence(tokens, idx, options, env, self)
      : self.renderToken(tokens, idx, options);
  };
}

/** 最小 HTML 转义（占位降级路径自用，避免裸文本破坏结构） */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
