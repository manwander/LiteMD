// 格式化工具栏命令：每个函数都是 editor.ts 命令的薄封装，
// 负责：null-check → 调用编辑器命令 → 更新状态栏。
// 职责单一，供 App.svelte 的工具栏按钮直接调用。
import type { EditorView } from "@codemirror/view";
import type { Settings } from "../settings";
import {
  wrapSelection,
  toggleLinePrefix,
  insertLink,
  insertImage,
  insertCodeBlock,
  insertTable,
  addTableColumn,
  setHeading,
  wrapHtmlSpan,
  setTableColumnAlign,
  setOrderedList,
  detectMarkers,
  applyMarkers,
} from "../editor";

export function makeToolbarCommands(view: () => EditorView | undefined) {
  const withView = (fn: (v: EditorView) => void) => {
    const v = view();
    if (v) fn(v);
  };

  // ---- 行内格式 ----
  const bold = () => withView((v) => wrapSelection(v, "**"));
  const italic = () => withView((v) => wrapSelection(v, "*"));
  const underline = () => withView((v) => wrapSelection(v, "__"));
  const strike = () => withView((v) => wrapSelection(v, "~~"));

  // ---- 行前缀 ----
  const h1 = () => withView((v) => setHeading(v, 1));
  const h2 = () => withView((v) => setHeading(v, 2));
  const h3 = () => withView((v) => setHeading(v, 3));
  const h4 = () => withView((v) => setHeading(v, 4));
  const h5 = () => withView((v) => setHeading(v, 5));
  const ul = () => withView((v) => toggleLinePrefix(v, "- "));
  const ol = () => withView((v) => toggleLinePrefix(v, "1. "));
  const task = () => withView((v) => toggleLinePrefix(v, "- [ ] "));
  const quote = () => withView((v) => toggleLinePrefix(v, "> "));

  // ---- 块级插入 ----
  const link = () => withView((v) => insertLink(v));
  const codeBlock = () => withView((v) => { insertCodeBlock(v, ""); });
  const table = () => withView((v) => { insertTable(v); });

  // ---- 表格 ----
  const addColumn = () => withView((v) => { addTableColumn(v); });

  // ---- 有序列表（起始编号）----
  const orderedList = (start: number) => withView((v) => { setOrderedList(v, start); });

  // ---- 表格列对齐 ----
  const alignCol = (
    view: EditorView | undefined,
    setStatus: (s: string) => void,
    align: "left" | "center" | "right"
  ) => {
    if (!view) return;
    if (!setTableColumnAlign(view, align)) {
      setStatus("请将光标置于表格内再设置对齐");
    } else {
      setStatus("已设置列对齐");
    }
  };

  // ---- 颜色 ----
  const wrapColor = (view: EditorView | undefined, type: "fg" | "bg", hex: string, setStatus: (s: string) => void) => {
    if (!view) return;
    const css = type === "fg" ? `color:${hex}` : `background-color:${hex}`;
    wrapHtmlSpan(view, css);
    setStatus(type === "fg" ? "已设置字体颜色" : "已设置背景颜色");
  };

  // ---- 格式刷 ----
  function armPainter(view: EditorView | undefined, markers: string[], locked: boolean): string | null {
    if (!view) return null;
    const detected = detectMarkers(view);
    if (!detected.length) return null;
    // 若用户未手动选标记，使用当前检测到的标记
    return detected.join("");
  }

  function applyPainter(
    view: EditorView | undefined,
    markers: string[],
    locked: boolean
  ): { applied: boolean; locked: boolean } {
    if (!view) return { applied: false, locked };
    const sel = view.state.selection.main;
    if (sel.empty) return { applied: false, locked };
    applyMarkers(view, markers);
    return { applied: true, locked };
  }

  return {
    bold, italic, underline, strike,
    h1, h2, h3, h4, h5,
    ul, ol, task, quote,
    link, codeBlock, table,
    addColumn, orderedList,
    alignCol, wrapColor,
    armPainter, applyPainter,
  };
}
