/**
 * insert-actions.ts —— 纯编辑器命令助手（E6 / B2 集成供血）
 *
 * 背景：menu-registry 中一批 action 有定义无 handler（format.h2-h6/paragraph/code/
 * clearFormat、insert.math/datetime/hr/toc、edit.selectAll 等）。本模块把它们实现为
 * **纯 CM6 view 操作**——不依赖 App 状态、入参显式传 view，供集成方直接进
 * ACTION_HANDLERS（如 `"format.h2": () => setHeadingLevel(view, 2)`）。
 *
 * 实现原则（复用优先，不重造）：
 * - 标题/行前缀/行内包裹全部委托 editor.ts 既有导出（setHeading / toParagraph /
 *   wrapSelection），toggle 语义与快捷键路径完全一致；
 * - 目录生成委托 outline.ts 的 extractOutline（围栏代码块/setext 已处理）；
 * - 纯函数：无 DOM 查询、无 Tauri、无模块级副作用，可在 Node 下安全 import（供单测）。
 */
import type { EditorView } from "@codemirror/view";
import { getDoc, setHeading, toParagraph, wrapSelection } from "./editor";
import { extractOutline } from "./outline";

/** 与 editor.ts 各命令一致：dispatch 后异步聚焦，避免同步 focus 打断输入法合成 */
function focusView(view: EditorView): void {
  requestAnimationFrame(() => view.focus());
}

/**
 * 设置标题级别 1-6；level<=0 表示清除标题回正文（委托 toParagraph，
 * setHeading 不接受 0——它的取消语义是「已是该级别则移除」，与「无条件回正文」不同）。
 * level 超出 1-6 时收敛到边界值（6），防调用方传入脏数据。
 */
export function setHeadingLevel(view: EditorView, level: number): void {
  if (level <= 0) {
    toParagraph(view);
    return;
  }
  setHeading(view, Math.min(6, Math.max(1, Math.round(level))));
}

/** 行内代码包裹（` 包裹/取消，委托 wrapSelection 的 toggle 语义） */
export function wrapInlineCode(view: EditorView): void {
  wrapSelection(view, "`");
}

/**
 * 公式包裹：
 * - 有选区 → 行内 `$选区$`（wrapSelection toggle，再选一次取消）；
 * - 无选区 → 块级骨架 `$$ \n\n $$`，光标落在中间空行，直接输入公式。
 */
export function wrapMath(view: EditorView): void {
  const sel = view.state.selection.main;
  if (!sel.empty) {
    wrapSelection(view, "$");
    return;
  }
  const insert = "$$\n\n$$";
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert },
    // "$$\n\n$$"：下标 0/1 为开 $$，2/3 为两个换行——光标落在空行（下标 3 处）
    selection: { anchor: sel.from + 3 },
  });
  focusView(view);
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * 在光标处插入本地时间 `YYYY-MM-DD HH:mm`（有选区则替换选区），光标停在插入文本之后。
 * 秒不纳入（分钟级时间戳是笔记场景的常用精度，且避免每次按键格式抖动）。
 */
export function insertDateTime(view: EditorView): void {
  const sel = view.state.selection.main;
  const d = new Date();
  const stamp = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(
    d.getHours()
  )}:${pad2(d.getMinutes())}`;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: stamp },
    selection: { anchor: sel.from + stamp.length },
  });
  focusView(view);
}

/**
 * 在光标处插入水平线 `---`，保证其独占一行：
 * - 光标不在行首 → 前补 `\n`（与前方内容分行）；
 * - 光标后同行还有内容 → 后补 `\n`（与后方内容分行）；
 * - 光标在行首且行尾无内容 → 只插 `---`（不制造连续空行）。
 */
export function insertHorizontalRule(view: EditorView): void {
  const { state } = view;
  const sel = state.selection.main;
  const line = state.doc.lineAt(sel.from);
  const col = sel.from - line.from;
  const after = line.text.slice(col);
  const insert = `${col === 0 ? "" : "\n"}---${after ? "\n" : ""}`;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert },
    selection: { anchor: sel.from + insert.length },
  });
  focusView(view);
}

/** 标题 → GitHub 风格锚点：小写、去特殊字符（保留文字/数字/空格/连字符）、空格转连字符 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

/**
 * 在光标处插入 markdown 目录（extractOutline 抽标题 → `- [标题](#锚点)`，按文档序）。
 * 空文档/无标题 → 返回 false 不插入（集成方据此决定是否 toast 提示）。
 *
 * 已知局限（注释明示，不粉饰）：
 * - 锚点为静态 slug，不做同题去重（与 GitHub 实际渲染的重复锚点规则有差异）；
 * - 扁平列表不带层级缩进（outline 条目含 level，需要缩进版本时在此 map 即可）。
 */
export function insertToc(view: EditorView): boolean {
  const items = extractOutline(getDoc(view));
  if (!items.length) return false;
  const insert = items.map((it) => `- [${it.text}](#${slugify(it.text)})`).join("\n") + "\n";
  const sel = view.state.selection.main;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert },
    selection: { anchor: sel.from + insert.length },
  });
  focusView(view);
  return true;
}

/** 全选文档（edit.selectAll 的编辑器域实现；焦点在编辑器外时由 App 层兜底转交） */
export function selectAllDoc(view: EditorView): void {
  view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
  focusView(view);
}

/** 常见行首块级标记：ATX 标题 / 引用 / 无序列表（含任务列表复选框）/ 有序列表 */
const LINE_PREFIX_RE = /^(#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+\.\s+)/;

/**
 * 清除格式（行前缀版）：按当前选区涉及行剥离开头标记（#/>/-/+/数字.）。
 *
 * 已知局限：只清**行首块级标记**；行内加粗/斜体/删除线/行内代码/公式等富格式
 * 不在本函数范围（CM6 无「清除行内格式」原语，逐 marker toggle 会误伤正文中的
 *  同名符号，需要时应在编辑器域单独实现，勿在此堆叠）。
 */
export function clearFormatting(view: EditorView): void {
  const { state } = view;
  const seen = new Set<number>();
  const specs: { from: number; to: number; insert: string }[] = [];
  for (const range of state.selection.ranges) {
    const startLine = state.doc.lineAt(range.from);
    const endLine = state.doc.lineAt(range.to);
    for (let i = startLine.number; i <= endLine.number; i++) {
      if (seen.has(i)) continue;
      seen.add(i);
      const line = state.doc.line(i);
      const stripped = line.text.replace(LINE_PREFIX_RE, "");
      if (stripped !== line.text) {
        specs.push({ from: line.from, to: line.to, insert: stripped });
      }
    }
  }
  if (!specs.length) return;
  view.dispatch({ changes: state.changes(specs) });
  focusView(view);
}
