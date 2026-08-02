// CodeMirror 6 封装：创建编辑器、外观（主题 + 字号）热切换、格式化命令、数据驱动快捷键。
// 所有命令供工具栏按钮与「快捷键设置」面板统一调用。
import { EditorView, lineNumbers, highlightActiveLineGutter, highlightSpecialChars,
  drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightActiveLine,
  keymap, gutter, GutterMarker, type KeyBinding, type Command } from "@codemirror/view";
import { EditorState, EditorSelection, Compartment, StateField } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { LanguageDescription, LanguageSupport, StreamLanguage, syntaxHighlighting, defaultHighlightStyle, indentOnInput, indentUnit, bracketMatching, foldGutter, foldKeymap } from "@codemirror/language";
import { oneDark } from "@codemirror/theme-one-dark";
import { history, historyKeymap, indentWithTab, undo, redo } from "@codemirror/commands";
import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from "@codemirror/autocomplete";
import { highlightSelectionMatches, searchKeymap, openSearchPanel } from "@codemirror/search";

// 撤销 / 重做命令再导出，供工具栏按钮调用
export { undo, redo };

// 自组 setup（等效 basicSetup 但去掉 @codemirror/lint，省 30~40KB）：
// 历史 / 行号 / 代码折叠 / 括号补全 / 自动补全 / 选区高亮 / 搜索 / 缩进
const liteSetup = [
  lineNumbers(),
  highlightActiveLineGutter(),
  highlightSpecialChars(),
  history(),
  foldGutter(),
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  indentOnInput(),
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  bracketMatching(),
  closeBrackets(),
  autocompletion(),
  rectangularSelection(),
  crosshairCursor(),
  highlightActiveLine(),
  highlightSelectionMatches(),
  keymap.of([...closeBracketsKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap]),
];

// 注意：本模块刻意不依赖 ./settings —— 快捷键映射由 App 层转成
// 「actionId -> CM key」字典传入，避免 editor / app 分块循环引用。

// ---------------- 代码块语言白名单 ----------------
// 不再引入 @codemirror/language-data 全量（60+ 语言 → 60+ 异步 chunk）。
// 这里只保留 Markdown 里高频出现的语言，且全部走 dynamic import，主包零负担。
const codeLanguages: LanguageDescription[] = [
  LanguageDescription.of({
    name: "JavaScript",
    alias: ["js", "jsx", "node"],
    extensions: ["js", "mjs", "cjs", "jsx"],
    load: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true })),
  }),
  LanguageDescription.of({
    name: "TypeScript",
    alias: ["ts", "tsx"],
    extensions: ["ts", "mts", "cts", "tsx"],
    load: () =>
      import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true, typescript: true })),
  }),
  LanguageDescription.of({
    name: "JSON",
    alias: ["json", "json5"],
    extensions: ["json", "jsonc"],
    load: () => import("@codemirror/lang-json").then((m) => m.json()),
  }),
  LanguageDescription.of({
    name: "HTML",
    alias: ["html", "htm", "vue", "svelte"],
    extensions: ["html", "htm"],
    load: () => import("@codemirror/lang-html").then((m) => m.html()),
  }),
  LanguageDescription.of({
    name: "CSS",
    alias: ["css", "scss", "less"],
    extensions: ["css"],
    load: () => import("@codemirror/lang-css").then((m) => m.css()),
  }),
  LanguageDescription.of({
    name: "Python",
    alias: ["python", "py"],
    extensions: ["py"],
    load: () => import("@codemirror/lang-python").then((m) => m.python()),
  }),
  LanguageDescription.of({
    name: "Rust",
    alias: ["rust", "rs"],
    extensions: ["rs"],
    load: () => import("@codemirror/lang-rust").then((m) => m.rust()),
  }),
  LanguageDescription.of({
    name: "Go",
    alias: ["go", "golang"],
    extensions: ["go"],
    load: () => import("@codemirror/lang-go").then((m) => m.go()),
  }),
  LanguageDescription.of({
    name: "Java",
    alias: ["java", "kotlin", "kt"],
    extensions: ["java"],
    load: () => import("@codemirror/lang-java").then((m) => m.java()),
  }),
  LanguageDescription.of({
    name: "C++",
    alias: ["cpp", "c", "c++", "cc", "h"],
    extensions: ["cpp", "cc", "c", "h", "hpp"],
    load: () => import("@codemirror/lang-cpp").then((m) => m.cpp()),
  }),
  LanguageDescription.of({
    name: "SQL",
    alias: ["sql", "mysql", "postgres"],
    extensions: ["sql"],
    load: () => import("@codemirror/lang-sql").then((m) => m.sql()),
  }),
  LanguageDescription.of({
    name: "XML",
    alias: ["xml", "svg"],
    extensions: ["xml", "svg"],
    load: () => import("@codemirror/lang-xml").then((m) => m.xml()),
  }),
  LanguageDescription.of({
    name: "YAML",
    alias: ["yaml", "yml"],
    extensions: ["yaml", "yml"],
    load: () => import("@codemirror/lang-yaml").then((m) => m.yaml()),
  }),
  LanguageDescription.of({
    name: "Shell",
    alias: ["shell", "sh", "bash", "zsh", "console"],
    extensions: ["sh", "bash"],
    load: () =>
      import("@codemirror/legacy-modes/mode/shell").then(
        (m) => new LanguageSupport(StreamLanguage.define(m.shell))
      ),
  }),
];

// ---------------- 外观：浅色主题 + 字号 ----------------
const liteTheme = EditorView.theme(
  {
    "&": { height: "100%", backgroundColor: "var(--bg)", color: "var(--text)" },
    ".cm-scroller": {
      fontFamily: '"JetBrains Mono", "SF Mono", Consolas, monospace',
      lineHeight: "1.6",
    },
    ".cm-gutters": { backgroundColor: "transparent", border: "none", color: "var(--text-2)" },
    ".cm-activeLine": { backgroundColor: "rgba(15,110,86,0.06)" },
    ".cm-activeLineGutter": { backgroundColor: "transparent" },
    "&.cm-focused": { outline: "none" },
    ".cm-content": { padding: "16px 0" },
    ".cm-cursor": { borderLeftColor: "var(--accent)" },
  },
  { dark: false }
);

const darkPatch = EditorView.theme({ "&": { height: "100%" } }, { dark: true });

// 字号主题按尺寸缓存，避免每次调整都新建 StyleModule
const fontThemes = new Map<number, ReturnType<typeof EditorView.theme>>();
function fontTheme(size: number) {
  let t = fontThemes.get(size);
  if (!t) {
    t = EditorView.theme({ "&": { fontSize: `${size}px` } });
    fontThemes.set(size, t);
  }
  return t;
}

function appearance(dark: boolean, fontSize: number) {
  // 字号放最后，保证同优先级下样式后写入、覆盖主题默认值
  return [dark ? [oneDark, darkPatch] : liteTheme, fontTheme(fontSize)];
}

const appearanceCompartment = new Compartment();
const keymapCompartment = new Compartment();

// ---------------- 数据驱动快捷键 ----------------
function wrapCmd(marker: string): Command {
  return (v) => {
    wrapSelection(v, marker);
    return true;
  };
}

const linkCmd: Command = (v) => {
  insertLink(v);
  return true;
};

function headingCmd(level: number): Command {
  return (v) => {
    setHeading(v, level);
    return true;
  };
}

// actionId -> CodeMirror 命令（仅 scope === "editor" 的动作）
const EDITOR_COMMANDS: Record<string, Command> = {
  "format.bold": wrapCmd("**"),
  "format.italic": wrapCmd("*"),
  "format.underline": wrapCmd("__"),
  "format.strike": wrapCmd("~~"),
  "format.link": linkCmd,
  "format.h1": headingCmd(1),
  "format.h2": headingCmd(2),
  "format.h3": headingCmd(3),
  "format.h4": headingCmd(4),
  "format.h5": headingCmd(5),
  "edit.undo": undo,
  "edit.redo": redo,
  "edit.find": openSearchPanel,
  "edit.replace": openSearchPanel, // CM6 搜索面板自带替换行
  "table.duplicateRow": duplicateTableRow,
};

export function buildKeymap(cmKeys: Record<string, string>): KeyBinding[] {
  const out: KeyBinding[] = [];
  for (const [id, run] of Object.entries(EDITOR_COMMANDS)) {
    const key = cmKeys[id];
    if (key) out.push({ key, preventDefault: true, run });
  }
  return out;
}

// ---------------- 行内快捷按钮（gutter）----------------
// 跟踪光标所在行号，仅在该行左侧显示一个小按钮
const activeLineField = StateField.define<number>({
  create: (state) => state.doc.lineAt(state.selection.main.head).number,
  update: (value, tr) =>
    tr.selection || tr.docChanged
      ? tr.state.doc.lineAt(tr.state.selection.main.head).number
      : value,
});

class QuickActionMarker extends GutterMarker {
  constructor(private onPick: (rect: DOMRect) => void) {
    super();
  }
  toDOM(): HTMLElement {
    const el = document.createElement("div");
    el.className = "cm-quick-btn";
    el.textContent = "⚡";
    el.title = "快捷格式化";
    // mousedown + preventDefault：点击不移动光标/不抢焦点
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.onPick(el.getBoundingClientRect());
    });
    return el;
  }
}

/** 生成快捷按钮 gutter；onPick 收到按钮位置，由上层弹出菜单 */
function quickActionGutter(onPick: (rect: DOMRect) => void) {
  return [
    activeLineField,
    gutter({
      class: "cm-quick-gutter",
      lineMarker(view, line) {
        const lineNo = view.state.doc.lineAt(line.from).number;
        return view.state.field(activeLineField) === lineNo
          ? new QuickActionMarker(onPick)
          : null;
      },
      // 占位，保证 gutter 宽度稳定（不随按钮出现/消失抖动）
      initialSpacer: () => new QuickActionMarker(() => {}),
    }),
  ];
}

// ---------------- 创建 / 更新 ----------------
export function createEditor(opts: {
  parent: HTMLElement;
  doc: string;
  dark: boolean;
  fontSize: number;
  /** actionId -> CM key（Mod-Shift-o） */
  cmKeys: Record<string, string>;
  onChange: (value: string) => void;
  onCursor?: (line: number, col: number) => void;
  /** 行内快捷按钮被点击，传入按钮位置供上层弹出菜单 */
  onQuickAction?: (rect: DOMRect) => void;
}): EditorView {
  return new EditorView({
    parent: opts.parent,
    state: EditorState.create({
      doc: opts.doc,
      extensions: [
        // 用户键位优先于基础键位
        keymapCompartment.of(keymap.of(buildKeymap(opts.cmKeys))),
        // 换行：Enter 跳出表格/代码块成为全新一行（普通文本走默认回车）；
        // Shift+Enter 留在块内（表格格内插 <br>、代码块加一行代码）；Alt+Enter 复制表格行（用户键位）
        keymap.of([
          { key: "Enter", run: smartEnter },
          { key: "Shift-Enter", preventDefault: true, run: (v) => { softBreak(v); return true; } },
        ]),
        liteSetup,
        // Tab 缩进为 4 个半角空格（约两个中文字符宽）
        indentUnit.of("    "),
        keymap.of([indentWithTab]),
        markdown({ base: markdownLanguage, codeLanguages }),
        quickActionGutter((rect) => opts.onQuickAction?.(rect)),
        orderedListRenumber,
        appearanceCompartment.of(appearance(opts.dark, opts.fontSize)),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) opts.onChange(u.state.doc.toString());
          if (opts.onCursor && (u.docChanged || u.selectionSet)) {
            const head = u.state.selection.main.head;
            const line = u.state.doc.lineAt(head);
            opts.onCursor(line.number, head - line.from + 1);
          }
        }),
      ],
    }),
  });
}

export function setAppearance(view: EditorView, dark: boolean, fontSize: number): void {
  view.dispatch({
    effects: appearanceCompartment.reconfigure(appearance(dark, fontSize)),
  });
}

export function setKeymap(view: EditorView, cmKeys: Record<string, string>): void {
  view.dispatch({
    effects: keymapCompartment.reconfigure(keymap.of(buildKeymap(cmKeys))),
  });
}

// 整体替换文档内容（用于「打开文件」后载入）
export function setDoc(view: EditorView, text: string): void {
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
  });
  view.focus();
}

// ---------------- 编辑命令（工具栏共用）----------------

// 行内包裹 / 取消包裹：选中文本前后加 marker（如 ** 加粗、* 斜体、__ 下划线、~~ 删除线）
// 若选中文本已被同一 marker 包裹，则移除（toggle）。
export function wrapSelection(view: EditorView, marker: string): void {
  const { state } = view;
  const changes = state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to);
    // 检测是否已被包裹（选区内或光标两侧）
    if (text.startsWith(marker) && text.endsWith(marker) && text.length >= marker.length * 2) {
      // 取消包裹
      const inner = text.slice(marker.length, text.length - marker.length);
      return {
        changes: { from: range.from, to: range.to, insert: inner },
        range: EditorSelection.range(range.from, range.from + inner.length),
      };
    }
    // 检测光标两侧是否被包裹（未选中时）
    if (!text) {
      const before = state.sliceDoc(Math.max(0, range.from - marker.length), range.from);
      const after = state.sliceDoc(range.to, Math.min(state.doc.length, range.to + marker.length));
      if (before === marker && after === marker) {
        // 删除两侧 marker
        return {
          changes: [
            { from: range.from - marker.length, to: range.from, insert: "" },
            { from: range.to, to: range.to + marker.length, insert: "" },
          ],
          range: EditorSelection.cursor(range.from - marker.length),
        };
      }
    }
    const insert = text || "文本";
    return {
      changes: { from: range.from, to: range.to, insert: `${marker}${insert}${marker}` },
      range: EditorSelection.range(
        range.from + marker.length,
        range.from + marker.length + insert.length
      ),
    };
  });
  view.dispatch(changes);
  view.focus();
}

// 行前缀切换：列表 / 引用 / 标题（支持多行选区，再次点击取消）
export function toggleLinePrefix(view: EditorView, prefix: string): void {
  const { state } = view;
  const changes = state.changeByRange((range) => {
    const startLine = state.doc.lineAt(range.from);
    const endLine = state.doc.lineAt(range.to);
    const lineChanges: { from: number; to: number; insert: string }[] = [];
    // 判断是否所有行都已有前缀（是则移除，否则添加）
    let allHave = true;
    for (let i = startLine.number; i <= endLine.number; i++) {
      const line = state.doc.line(i);
      if (!line.text.startsWith(prefix)) {
        allHave = false;
        break;
      }
    }
    for (let i = startLine.number; i <= endLine.number; i++) {
      const line = state.doc.line(i);
      const next = allHave ? line.text.slice(prefix.length) : prefix + line.text;
      lineChanges.push({ from: line.from, to: line.to, insert: next });
    }
    return { changes: lineChanges, range };
  });
  view.dispatch(changes);
  view.focus();
}

// 设置标题级别：先剥离已有 # 前缀，再设为指定级别；已是该级别则移除（toggle）
// 设置标题后光标自动移到新的一行，方便继续输入正文
export function setHeading(view: EditorView, level: number): void {
  const { state } = view;
  const prefix = "#".repeat(level) + " ";
  const line = state.doc.lineAt(state.selection.main.head);
  const stripped = line.text.replace(/^#+\s+/, "");
  const isSameLevel = line.text.startsWith(prefix);
  if (isSameLevel) {
    // 取消标题：仅剥离前缀，光标留在原行
    view.dispatch({ changes: { from: line.from, to: line.to, insert: stripped } });
  } else {
    // 设置标题：行尾补一个换行，光标移到新行行首
    const insert = prefix + stripped + "\n";
    view.dispatch({
      changes: { from: line.from, to: line.to, insert },
      selection: { anchor: line.from + insert.length },
    });
  }
  view.focus();
}

// 转为正文：剥离标题前缀（任何级别）
export function toParagraph(view: EditorView): void {
  const { state } = view;
  const changes = state.changeByRange((range) => {
    const line = state.doc.lineAt(range.from);
    const stripped = line.text.replace(/^#+\s+/, "");
    return { changes: { from: line.from, to: line.to, insert: stripped }, range };
  });
  view.dispatch(changes);
  view.focus();
}

// 在光标处插入文本
export function insertText(view: EditorView, text: string): void {
  view.dispatch(view.state.replaceSelection(text));
  view.focus();
}

// 插入链接：选中文本作为链接文字
export function insertLink(view: EditorView): void {
  const { state } = view;
  const sel = state.selection.main;
  const text = state.sliceDoc(sel.from, sel.to) || "链接文字";
  const insert = `[${text}](https://)`;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert },
    selection: { anchor: sel.from + text.length + 3, head: sel.from + text.length + 3 + 8 },
  });
  view.focus();
}

// 插入图片：![描述](路径)；选中文本作为描述，光标定位到路径处
export function insertImage(view: EditorView, path: string): void {
  const { state } = view;
  const sel = state.selection.main;
  const alt = state.sliceDoc(sel.from, sel.to) || "图片描述";
  // 绝对路径（盘符或 / 开头）用尖括号包裹 + 正斜杠，兼容路径中的空格；
  // 相对路径（收编后的 assets/xxx，文件名无空格）直接引用，更干净、可移植
  const normalized = path.replace(/\\/g, "/");
  const isAbs = /^([A-Za-z]:\/|\/)/.test(normalized);
  const ref = isAbs ? `<${normalized}>` : normalized;
  const insert = `![${alt}](${ref})`;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert },
    selection: { anchor: sel.from + insert.length },
  });
  view.focus();
}

// 插入代码块：```lang\n代码\n```；选中文本作为初始代码，光标落在内容行
export function insertCodeBlock(view: EditorView, lang = ""): void {
  const { state } = view;
  const sel = state.selection.main;
  const code = state.sliceDoc(sel.from, sel.to);
  const insert = `\n\`\`\`${lang}\n${code}\n\`\`\`\n`;
  // 内容行起始位置：\n + ``` + lang + \n
  const contentStart = sel.from + 1 + 3 + lang.length + 1;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert },
    // 光标跳到内容行（有选中代码则落在其后，否则落在空行行首）
    selection: { anchor: contentStart + code.length },
  });
  view.focus();
}

// 复制表格行：当前行为表格行（以 | 开头）时，复制一份到下方并定位到新行同列；
// 非表格行返回 false，交还给其它绑定 / 默认行为
export function duplicateTableRow(view: EditorView): boolean {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  if (!/^\s*\|/.test(line.text)) return false;
  const colOffset = state.selection.main.head - line.from;
  view.dispatch({
    changes: { from: line.to, insert: "\n" + line.text },
    selection: { anchor: line.to + 1 + colOffset },
  });
  view.focus();
  return true;
}

// 表格添加列：为光标所在表格的每一行追加一列（分隔行自动补 ---），光标落在当前行新单元格内
export function addTableColumn(view: EditorView): boolean {
  const { state } = view;
  const cursorLine = state.doc.lineAt(state.selection.main.head);
  if (!/^\s*\|/.test(cursorLine.text)) return false; // 不在表格内
  // 定位光标所属表格块（连续的 | 开头行）
  let start = cursorLine.number;
  while (start > 1 && /^\s*\|/.test(state.doc.line(start - 1).text)) start--;
  let end = cursorLine.number;
  while (end < state.doc.lines && /^\s*\|/.test(state.doc.line(end + 1).text)) end++;
  // 逐行追加单元格：分隔行（含 -）补 ---，其余行补空白单元格
  const changes: { from: number; to: number; insert: string }[] = [];
  for (let n = start; n <= end; n++) {
    const line = state.doc.line(n);
    const isSep = /^\s*\|[\s:|-]*-[\s:|-]*$/.test(line.text);
    changes.push({ from: line.to, to: line.to, insert: isSep ? " --- |" : "  |" });
  }
  const ch = state.changes(changes);
  // 「当前行行尾」映射到变更后即新单元格起点，+1 落在单元格内
  const anchor = ch.mapPos(cursorLine.to, -1) + 1;
  view.dispatch({ changes: ch, selection: { anchor } });
  view.focus();
  return true;
}

// 插入表格模板（3 列 × 表头 + 分隔行 + 1 数据行）
export function insertTable(view: EditorView): void {
  const { state } = view;
  const sel = state.selection.main;
  const table = "\n| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n| 内容 | 内容 | 内容 |\n";
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: table },
    selection: { anchor: sel.from + table.length },
  });
  view.focus();
}

// ---------------- 颜色：HTML 内联样式 ----------------
// 选区包裹 <span style="...">（字体颜色 / 背景颜色）；无选区时插入占位文字
export function wrapHtmlSpan(view: EditorView, css: string): void {
  const { state } = view;
  const changes = state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to) || "文本";
    const insert = `<span style="${css}">${text}</span>`;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.cursor(range.from + insert.length),
    };
  });
  view.dispatch(changes);
  view.focus();
}

// ---------------- 表格列对齐 ----------------
// 光标所在列号：统计光标前的 "|" 个数减 1（行以 | 开头时成立），clamp 到 >= 0
function tableColumnAt(lineText: string, offset: number): number {
  let pipes = 0;
  for (let i = 0; i < offset && i < lineText.length; i++) {
    if (lineText[i] === "|") pipes++;
  }
  return Math.max(0, pipes - 1);
}

// 改写分隔行第 col 个单元格为对齐标记（:--- / :---: / ---:），保留其余部分
function setSepCell(lineText: string, col: number, align: "left" | "center" | "right"): string | null {
  const pipes: number[] = [];
  for (let i = 0; i < lineText.length; i++) if (lineText[i] === "|") pipes.push(i);
  if (col < 0 || col + 1 >= pipes.length) return null;
  const marker = align === "left" ? ":---" : align === "center" ? ":---:" : "---:";
  const cellStart = pipes[col] + 1;
  const cellEnd = pipes[col + 1];
  return lineText.slice(0, cellStart) + " " + marker + " " + lineText.slice(cellEnd);
}

// 设置光标所在表格列的对齐方式；不在表格内返回 false
export function setTableColumnAlign(view: EditorView, align: "left" | "center" | "right"): boolean {
  const { state } = view;
  const cursorLine = state.doc.lineAt(state.selection.main.head);
  if (!/^\s*\|/.test(cursorLine.text)) return false;
  let start = cursorLine.number;
  while (start > 1 && /^\s*\|/.test(state.doc.line(start - 1).text)) start--;
  let end = cursorLine.number;
  while (end < state.doc.lines && /^\s*\|/.test(state.doc.line(end + 1).text)) end++;
  // 定位分隔行（含 - 的行）
  let sepLineNo = -1;
  for (let n = start; n <= end; n++) {
    if (/^\s*\|[\s:|-]*-[\s:|-]*$/.test(state.doc.line(n).text)) { sepLineNo = n; break; }
  }
  if (sepLineNo < 0) return false;
  const col = tableColumnAt(cursorLine.text, state.selection.main.head - cursorLine.from);
  const sepLine = state.doc.line(sepLineNo);
  const next = setSepCell(sepLine.text, col, align);
  if (next == null) return false;
  view.dispatch({ changes: { from: sepLine.from, to: sepLine.to, insert: next } });
  view.focus();
  return true;
}

// ---------------- 有序列表 ----------------
// 选区各行加递增 "n. " 前缀（从 start 起）；若所有行已是 \d+. 则移除（toggle）
export function setOrderedList(view: EditorView, start: number): void {
  const { state } = view;
  const changes = state.changeByRange((range) => {
    const startLine = state.doc.lineAt(range.from);
    const endLine = state.doc.lineAt(range.to);
    const lineChanges: { from: number; to: number; insert: string }[] = [];
    let allOrdered = true;
    for (let i = startLine.number; i <= endLine.number; i++) {
      if (!/^\s*\d+\.\s/.test(state.doc.line(i).text)) { allOrdered = false; break; }
    }
    let n = start;
    for (let i = startLine.number; i <= endLine.number; i++) {
      const line = state.doc.line(i);
      const stripped = line.text.replace(/^\s*\d+\.\s+/, "");
      const next = allOrdered ? stripped : `${n}. ${stripped}`;
      if (!allOrdered) n++;
      lineChanges.push({ from: line.from, to: line.to, insert: next });
    }
    // 取消有序列表时保持光标不动
    if (allOrdered) return { changes: lineChanges, range };
    // 设置有序列表后，光标自动移到下一行，便于继续输入下一项
    const last = lineChanges[lineChanges.length - 1];
    last.insert += "\n";
    return { changes: lineChanges, range: EditorSelection.cursor(last.from + last.insert.length) };
  });
  view.dispatch(changes);
  view.focus();
}

// 有序列表自动重编号：对含 lineNo 的有序列表块，首项保留原号、后续递增重排。
// 仅在编号确实不连续时才派发修改；只改行内文字、不增删行，行号保持稳定。
function renumberBlock(view: EditorView, lineNo: number): boolean {
  const { state } = view;
  if (lineNo < 1 || lineNo > state.doc.lines) return false;
  let start = lineNo;
  while (start > 1 && /^\s*\d+\.\s/.test(state.doc.line(start - 1).text)) start--;
  let end = lineNo;
  while (end < state.doc.lines && /^\s*\d+\.\s/.test(state.doc.line(end + 1).text)) end++;
  if (start === end) return false;
  const first = state.doc.line(start).text.match(/^\s*(\d+)\.\s/);
  if (!first) return false;
  let n = parseInt(first[1], 10);
  const changes: { from: number; to: number; insert: string }[] = [];
  let need = false;
  for (let i = start; i <= end; i++) {
    const line = state.doc.line(i);
    const m = line.text.match(/^(\s*)(\d+)(\.\s)/);
    if (!m) continue;
    if (parseInt(m[2], 10) !== n) need = true;
    changes.push({ from: line.from, to: line.to, insert: `${m[1]}${n}${m[3]}${line.text.slice(m[0].length)}` });
    n++;
  }
  if (!need) return false;
  view.dispatch({ changes });
  return true;
}

// 仅当某次变更删除了含换行的片段（整行/多行被删）时，对受影响位置尝试重编号。
// guard 防递归；重编号不删换行，天然不会二次触发。
let renumberGuard = false;
const orderedListRenumber = EditorView.updateListener.of((u) => {
  if (!u.docChanged || renumberGuard) return;
  const positions: number[] = [];
  u.changes.iterChanges((fromA, toA, _fromB, toB) => {
    const deleted = u.startState.doc.sliceString(fromA, toA);
    if (deleted.includes("\n")) positions.push(toB);
  });
  if (!positions.length) return;
  const tried = new Set<number>();
  renumberGuard = true;
  try {
    for (const pos of positions) {
      const ln = u.state.doc.lineAt(Math.min(pos, u.state.doc.length)).number;
      for (const cand of [ln, ln - 1]) {
        if (cand >= 1 && !tried.has(cand)) { tried.add(cand); renumberBlock(u.view, cand); }
      }
    }
  } finally {
    renumberGuard = false;
  }
});

// ---------------- 软 / 硬换行 ----------------
// 判断 pos 是否在代码块内：当前行之前 ``` 行为奇数
function isInsideCodeBlock(state: EditorState, pos: number): boolean {
  const lineNo = state.doc.lineAt(pos).number;
  let fences = 0;
  for (let n = 1; n < lineNo; n++) {
    if (/^\s*```/.test(state.doc.line(n).text)) fences++;
  }
  return fences % 2 === 1;
}

// 软换行（Shift+Enter）：表格单元格内插 <br> 保持在格内；代码块 / 普通文本普通换行、留在当前块
export function softBreak(view: EditorView): void {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  view.dispatch(state.replaceSelection(/^\s*\|/.test(line.text) ? "<br>" : "\n"));
  view.focus();
}

// Enter 智能换行：表格内跳到表格块后、代码块内跳到闭合 ``` 后，成为全新一行；
// 普通文本返回 false，交还默认回车行为（正常换行、保留列表续行等）。
export function smartEnter(view: EditorView): boolean {
  const { state } = view;
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  if (/^\s*\|/.test(line.text)) {
    let end = line.number;
    while (end < state.doc.lines && /^\s*\|/.test(state.doc.line(end + 1).text)) end++;
    const pos = state.doc.line(end).to;
    view.dispatch({ changes: { from: pos, insert: "\n\n" }, selection: { anchor: pos + 2 } });
    view.focus();
    return true;
  }
  if (isInsideCodeBlock(state, head)) {
    let closeLine = -1;
    for (let n = line.number + 1; n <= state.doc.lines; n++) {
      if (/^\s*```/.test(state.doc.line(n).text)) { closeLine = n; break; }
    }
    if (closeLine > 0) {
      const pos = state.doc.line(closeLine).to;
      view.dispatch({ changes: { from: pos, insert: "\n\n" }, selection: { anchor: pos + 2 } });
      view.focus();
      return true;
    }
  }
  return false;
}

// ---------------- 格式刷 ----------------
const PAINT_MARKERS = ["**", "__", "~~", "*", "`"];

// 检测当前选区（或光标两侧）的包裹标记，由外到内返回（如 ["**", "*"]）
export function detectMarkers(view: EditorView): string[] {
  const { state } = view;
  const range = state.selection.main;
  const found: string[] = [];
  let text = state.sliceDoc(range.from, range.to);
  if (text) {
    // 逐层剥皮：优先取最长匹配（** 先于 *）
    while (text.length) {
      const m = PAINT_MARKERS.find((mk) => text.startsWith(mk) && text.endsWith(mk) && text.length >= mk.length * 2);
      if (!m) break;
      found.push(m);
      text = text.slice(m.length, text.length - m.length);
    }
  } else {
    let before = state.sliceDoc(Math.max(0, range.from - 12), range.from);
    let after = state.sliceDoc(range.to, Math.min(state.doc.length, range.to + 12));
    while (before.length && after.length) {
      const m = PAINT_MARKERS.find((mk) => before.endsWith(mk) && after.startsWith(mk));
      if (!m) break;
      found.push(m);
      before = before.slice(0, before.length - m.length);
      after = after.slice(m.length);
    }
  }
  return found;
}

// 将标记应用到选区（强制包裹，内层先包）；无选区时包裹占位文字
export function applyMarkers(view: EditorView, markers: string[]): void {
  if (!markers.length) return;
  const { state } = view;
  const changes = state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to) || "文本";
    let wrapped = text;
    for (const m of [...markers].reverse()) wrapped = `${m}${wrapped}${m}`;
    return {
      changes: { from: range.from, to: range.to, insert: wrapped },
      range: EditorSelection.range(range.from, range.from + wrapped.length),
    };
  });
  view.dispatch(changes);
  view.focus();
}

// ---------------- 跳转行（跨文件查找结果定位）----------------
export function gotoLine(view: EditorView, lineNo: number): void {
  const n = Math.max(1, Math.min(lineNo, view.state.doc.lines));
  const line = view.state.doc.line(n);
  view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
  view.focus();
}
