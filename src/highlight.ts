// 预览区代码高亮：highlight.js 核心 + 语言白名单。
// 核心先行加载（启动快），具体语言首次遇到时按需异步注册。
import type { HLJSApi } from "highlight.js";

type LangLoader = () => Promise<{ default: any }>;

const LANGUAGES: Record<string, LangLoader> = {
  javascript: () => import("highlight.js/lib/languages/javascript"),
  typescript: () => import("highlight.js/lib/languages/typescript"),
  json: () => import("highlight.js/lib/languages/json"),
  xml: () => import("highlight.js/lib/languages/xml"), // html / svg / vue 模板
  css: () => import("highlight.js/lib/languages/css"),
  python: () => import("highlight.js/lib/languages/python"),
  rust: () => import("highlight.js/lib/languages/rust"),
  go: () => import("highlight.js/lib/languages/go"),
  java: () => import("highlight.js/lib/languages/java"),
  cpp: () => import("highlight.js/lib/languages/cpp"),
  sql: () => import("highlight.js/lib/languages/sql"),
  yaml: () => import("highlight.js/lib/languages/yaml"),
  bash: () => import("highlight.js/lib/languages/bash"),
  markdown: () => import("highlight.js/lib/languages/markdown"),
  diff: () => import("highlight.js/lib/languages/diff"),
  ini: () => import("highlight.js/lib/languages/ini"), // toml
};

// 常见别名 → 规范语言名
const ALIASES: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  rs: "rust",
  golang: "go",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  html: "xml",
  vue: "xml",
  yml: "yaml",
  toml: "ini",
  c: "cpp",
  "c++": "cpp",
  cc: "cpp",
};

let hljs: HLJSApi | null = null;
let loading: Promise<void> | null = null;
const pending = new Set<string>(); // 正在加载的语言，避免重复触发
let onLangLoaded: (() => void) | null = null;

/** 语言加载完成后触发重渲染的回调（由 App 注册） */
export function setOnLangLoaded(cb: () => void): void {
  onLangLoaded = cb;
}

/** 异步初始化高亮引擎核心；重复调用共享同一个 Promise */
export function initHighlight(): Promise<void> {
  if (!loading) {
    loading = (async () => {
      const core = (await import("highlight.js/lib/core")).default;
      hljs = core;
    })();
  }
  return loading;
}

/** 按需注册语言；加载完成后回调 onLangLoaded 触发预览重渲染 */
function ensureLanguage(name: string): void {
  if (!hljs || pending.has(name)) return;
  const loader = LANGUAGES[name];
  if (!loader) return;
  pending.add(name);
  loader()
    .then((m) => {
      hljs?.registerLanguage(name, m.default);
      onLangLoaded?.();
    })
    .catch(() => {})
    .finally(() => pending.delete(name));
}

/** markdown-it 的 highlight 回调；语言未就绪时返回空串并触发按需加载 */
export function highlightCode(code: string, lang: string): string {
  if (!hljs || !lang) return "";
  const name = ALIASES[lang.toLowerCase()] ?? lang.toLowerCase();
  if (!hljs.getLanguage(name)) {
    ensureLanguage(name);
    return "";
  }
  try {
    return hljs.highlight(code, { language: name }).value;
  } catch {
    return "";
  }
}
