// HTML 清洗层（安全边界）
//
// 背景（C-01 / M-04）：
//   markdown-it 以 `html: true` 运行，用户 .md 里的原始 HTML 会被原样透传；
//   而预览 / 预览编辑 / 导出三条链路最终都用 innerHTML 或 {@html} 注入到
//   **具备 Tauri IPC 权限的 WebView**。一旦文档里带 <script> / <img onerror>
//   / <iframe src="javascript:">，脚本就能以应用身份 invoke 读写用户任意文件。
//   这等价于「打开一个 .md = 本地 RCE」。
//
// 策略：保留 html:true 的正常能力（<br> <sub> <details> <kbd> 等排版类 HTML
//   仍可用），但**所有注入 DOM 的 HTML 必须先过这里**。白名单由 DOMPurify
//   默认集收窄而来：额外禁掉 style/iframe/form 等可被滥用的标签，
//   并显式放行 Tauri 的 asset:// 协议（本地图片预览依赖它）。
//
// 单一出口原则：任何新增的 innerHTML/{@html} 注入点都必须调用本模块，
//   不要绕过。搜索 `sanitizeHtml(` 即可枚举全部注入点。

import DOMPurify from "dompurify";

/** markdown-it 的最小结构约定（避免为清洗层引入完整类型依赖） */
export interface RenderLike {
  render(src: string): string;
}

/**
 * 允许的 URI 协议。
 * 在 DOMPurify 默认集（http/https/mailto/tel/callto/sms/cid/xmpp/data-for-img）基础上
 * 追加 Tauri 资源协议：
 *  - Windows / Android：convertFileSrc() 产出 http://asset.localhost/...（已被 http 覆盖）
 *  - macOS / Linux：产出 asset://localhost/...，必须显式放行，否则本地图片全部被剥离
 *  - tauri:// 为 IPC 内部协议，一并放行以兼容旧版 convertFileSrc
 */
const ALLOWED_URI_REGEXP =
  /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|asset|tauri):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;

/**
 * 禁用标签：
 *  - script/iframe/frame/object/embed/applet：直接的脚本 / 外部内容执行面
 *  - style/link/base/meta：可注入 CSS 泄漏（背景图外链）或改写文档基址
 *  - form/input(非任务列表)/button/textarea/select：诱导性交互面
 * 说明：任务列表复选框由 block-splitter 后处理生成，需保留 input，
 *      因此 input 不在禁用列表，而是通过属性白名单限制为 type=checkbox+disabled。
 */
const FORBID_TAGS = [
  "script",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "style",
  "link",
  "base",
  "meta",
  "form",
  "button",
  "textarea",
  "select",
  "option",
];

/** 禁用属性：所有事件处理器由 DOMPurify 默认拦截，这里再显式兜底几个高频项 */
const FORBID_ATTR = [
  "onerror",
  "onload",
  "onclick",
  "onmouseover",
  "onfocus",
  "onanimationstart",
  "onanimationend",
  "ontransitionend",
  "srcdoc",
  "formaction",
  "xlink:href",
];

let hookInstalled = false;

/**
 * 允许保留的内联样式属性白名单（markdown-it 高亮/表格对齐等正常场景）。
 * 明确排除 position/z-index/behavior/transform 等可做点击劫持或布局覆盖的属性；
 * 值与属性名同时检查，阻断 url()/expression()/@import 等外链与脚本面。
 */
const SAFE_STYLE_PROPS = new Set([
  "color",
  "background",
  "background-color",
  "font",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "line-height",
  "letter-spacing",
  "text-align",
  "text-decoration",
  "text-indent",
  "white-space",
  "vertical-align",
  "border",
  "border-color",
  "border-style",
  "border-width",
  "border-radius",
  "border-collapse",
  "border-spacing",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "width",
  "min-width",
  "max-width",
  "height",
  "min-height",
  "max-height",
  "opacity",
  "list-style-type",
]);

/** 危险 CSS 值模式：外链、脚本表达式、行为绑定；反斜杠用于阻断 CSS 转义绕过（u\72l(...)） */
const UNSAFE_STYLE_VALUE = /url\s*\(|expression\s*\(|javascript:|vbscript:|@import|behavior\s*:|-moz-binding|image-set\s*\(|element\s*\(|\\/i;

/** 清洗单个元素的内联 style：仅保留白名单属性与安全值，其余丢弃 */
function sanitizeStyleAttr(el: Element): void {
  const raw = el.getAttribute("style");
  if (!raw) return;
  const kept: string[] = [];
  // 限制单元素样式长度，避免超长垃圾串拖慢解析/渲染
  for (const decl of raw.slice(0, 4000).split(";")) {
    const idx = decl.indexOf(":");
    if (idx <= 0) continue;
    const prop = decl.slice(0, idx).trim().toLowerCase();
    const value = decl.slice(idx + 1).trim();
    if (!SAFE_STYLE_PROPS.has(prop)) continue;
    if (!value || UNSAFE_STYLE_VALUE.test(value)) continue;
    kept.push(`${prop}: ${value}`);
  }
  if (kept.length) el.setAttribute("style", kept.join("; "));
  else el.removeAttribute("style");
}

/**
 * 安装一次性 DOMPurify 钩子：
 * 1. 外链统一加 target=_blank + rel=noopener noreferrer（防 window.opener 劫持）
 * 2. 任务列表以外的 <input> 一律降级为禁用复选框，杜绝表单注入
 */
function ensureHooks(): void {
  if (hookInstalled) return;
  // jsdom / SSR 场景下 DOMPurify 可能未挂载（无 window），此时跳过钩子安装
  if (typeof DOMPurify.addHook !== "function") return;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    const el = node as unknown as Element;
    if (typeof el.getAttribute !== "function") return;
    // 内联样式走白名单：DOMPurify 默认放行 style 属性，但 CSS 可外链/覆盖布局
    if (el.hasAttribute("style")) sanitizeStyleAttr(el);
    if (el.tagName === "A") {
      const href = el.getAttribute("href") || "";
      // 仅对「外部 http(s) 链接」加 target=_blank + rel=noopener，
      // 避免给站内相对链接（local.md）/ 锚点（#x）也强加新窗口，破坏应用内导航。
      if (/^https?:\/\//i.test(href)) {
        el.setAttribute("target", "_blank");
        el.setAttribute("rel", "noopener noreferrer");
      }
    }
    if (el.tagName === "INPUT") {
      // 只允许「禁用的复选框」这一种形态（任务列表），其余属性一律剥离
      const checked = el.hasAttribute("checked");
      for (const attr of Array.from(el.attributes)) el.removeAttribute(attr.name);
      el.setAttribute("type", "checkbox");
      el.setAttribute("disabled", "");
      if (checked) el.setAttribute("checked", "");
    }
  });
  hookInstalled = true;
}

/**
 * 清洗任意 HTML 片段。所有 innerHTML / {@html} 注入前必须调用。
 *
 * 容错：DOMPurify 依赖 DOM。若运行环境无 DOM（理论上不会出现在 WebView 内），
 * 退化为「剥离 script/事件属性」的保守正则兜底，宁可少显示也不执行脚本。
 */
export function sanitizeHtml(html: string): string {
  if (!html) return "";
  if (typeof window === "undefined" || typeof DOMPurify.sanitize !== "function") {
    return fallbackStrip(html);
  }
  ensureHooks();
  return DOMPurify.sanitize(html, {
    FORBID_TAGS,
    FORBID_ATTR,
    ALLOWED_URI_REGEXP,
    ADD_ATTR: ["target", "loading", "decoding", "align", "colspan", "rowspan"],
    ALLOW_DATA_ATTR: false,
    // 保留完整文档片段结构（表格 / 列表等），不做 body 提取
    WHOLE_DOCUMENT: false,
    RETURN_DOM: false,
    RETURN_DOM_FRAGMENT: false,
  }) as unknown as string;
}

/** 无 DOM 环境的保守兜底：删标签对 + 事件属性 + javascript: 协议 */
function fallbackStrip(html: string): string {
  return html
    .replace(/<\s*(script|iframe|object|embed|style|link|base|meta)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*(script|iframe|object|embed|style|link|base|meta)\b[^>]*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "")
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, "")
    .replace(/(href|src)\s*=\s*("|')?\s*javascript:[^"'>\s]*/gi, "$1=#");
}

/**
 * 渲染 markdown 并清洗，供预览 / 预览编辑 / 导出统一使用。
 * 等价于 sanitizeHtml(md.render(src))，独立成函数是为了让调用点语义清晰、
 * 也便于将来接入「渲染缓存 + 清洗缓存」。
 */
export function safeRender(md: RenderLike, src: string): string {
  return sanitizeHtml(md.render(src));
}
