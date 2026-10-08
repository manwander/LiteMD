/**
 * 编辑器格式/表格命令单元测试 —— 对应测试矩阵 FMT-001~015、TBL-001~004（矩阵 §2、§3）。
 *
 * 目的：把此前只有「静态接线」证据的核心格式命令升级为「运行时验证」，用真实 CodeMirror
 * EditorView 逐条固化 toggle / 边界 / 短路 / 非表格让位 的实际行为。断言的是**实测行为**，
 * 若与矩阵文案不符处（如 FMT-013「混合行按各自状态处理」），在注释中标注为待产品确认，
 * 不粉饰。
 */
import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  wrapSelection,
  wrapTags,
  toggleLinePrefix,
  setHeading,
  toParagraph,
  insertLink,
  insertCodeBlock,
  insertTable,
  duplicateTableRow,
  addTableColumn,
  setTableColumnAlign,
} from "../editor";

const MAX_FMT = 256 * 1024; // editor.ts:30

function makeView(doc: string): EditorView {
  return new EditorView({ state: EditorState.create({ doc }) });
}
/** 选中 [from,to) 后执行命令 */
function selectAnd(view: EditorView, from: number, to: number, fn: (v: EditorView) => void): void {
  view.dispatch({ selection: { anchor: from, head: to } });
  fn(view);
}
/** 光标（无选区）置于 pos 后执行命令 */
function cursorAnd(view: EditorView, pos: number, fn: (v: EditorView) => void): void {
  view.dispatch({ selection: { anchor: pos } });
  fn(view);
}

// ---------------- FMT-001 加粗（wrapSelection "**"） ----------------
describe("FMT-001 加粗 toggle", () => {
  it("正：有选区加 ** 包裹", () => {
    const v = makeView("文本");
    selectAnd(v, 0, 2, (view) => wrapSelection(view, "**"));
    expect(v.state.doc.toString()).toBe("**文本**");
  });
  it("边：无选区插入占位「文本」并居中", () => {
    const v = makeView("");
    cursorAnd(v, 0, (view) => wrapSelection(view, "**"));
    expect(v.state.doc.toString()).toBe("**文本**");
  });
  it("边：再次 toggle 剥除已包裹选区（选区本身含 **）", () => {
    const v = makeView("**粗**");
    selectAnd(v, 0, 5, (view) => wrapSelection(view, "**"));
    expect(v.state.doc.toString()).toBe("粗");
  });
  it("边：空选区且光标两侧恰为 ** → 剥除", () => {
    const v = makeView("****");
    cursorAnd(v, 2, (view) => wrapSelection(view, "**"));
    expect(v.state.doc.toString()).toBe("");
  });
});

// ---------------- FMT-002/003/004 斜体/下划线/删除线 ----------------
describe("FMT-002/003/004 行内标记 toggle", () => {
  it.each([
    ["斜体 *", "*", "x", "*x*"],
    ["下划线 __", "__", "x", "__x__"],
    ["删除线 ~~", "~~", "x", "~~x~~"],
  ])("%s：包裹后二次 toggle 还原", (_name, marker, text, wrapped) => {
    const v = makeView(text);
    selectAnd(v, 0, text.length, (view) => wrapSelection(view, marker));
    expect(v.state.doc.toString()).toBe(wrapped);
    selectAnd(v, 0, wrapped.length, (view) => wrapSelection(view, marker));
    expect(v.state.doc.toString()).toBe(text);
  });
});

// ---------------- FMT-006 插入链接 ----------------
describe("FMT-006 插入链接", () => {
  it("正：选区作链接文字，产出 [x](https://)", () => {
    const v = makeView("Google");
    selectAnd(v, 0, 6, (view) => insertLink(view));
    expect(v.state.doc.toString()).toBe("[Google](https://)");
  });
  it("边：无选区插入占位「链接文字」", () => {
    const v = makeView("");
    cursorAnd(v, 0, (view) => insertLink(view));
    expect(v.state.doc.toString()).toBe("[链接文字](https://)");
  });
});

// ---------------- FMT-009 超大选区短路 ----------------
describe("FMT-009 >256KB 选区短路保护", () => {
  it("选区 = 262144（临界内）：正常包裹", () => {
    const doc = "a".repeat(MAX_FMT); // 262144
    const v = makeView(doc);
    let skipped = false;
    selectAnd(v, 0, doc.length, (view) => wrapSelection(view, "**", () => (skipped = true)));
    expect(skipped).toBe(false);
    expect(v.state.doc.toString().startsWith("**")).toBe(true);
  });
  it("选区 = 262145（临界外）：短路不物化、onSkip 触发、文档不变", () => {
    const doc = "a".repeat(MAX_FMT + 1); // 262145 > MAX
    const v = makeView(doc);
    let skipped = false;
    selectAnd(v, 0, doc.length, (view) => wrapSelection(view, "**", () => (skipped = true)));
    expect(skipped).toBe(true);
    expect(v.state.doc.toString()).toBe(doc); // 未被破坏
  });
});

// ---------------- FMT-010/011 标题 ----------------
describe("FMT-010 标题设级 / FMT-011 转正文", () => {
  it("正：普通行设 H1，行尾补换行光标续写", () => {
    const v = makeView("标题");
    cursorAnd(v, 0, (view) => setHeading(view, 1));
    expect(v.state.doc.toString()).toBe("# 标题\n");
  });
  it("边：已是 H1 再按 Alt+1 → 还原正文（仅剥前缀，不补换行）", () => {
    const v = makeView("# 标题");
    cursorAnd(v, 2, (view) => setHeading(view, 1));
    expect(v.state.doc.toString()).toBe("标题");
  });
  it("边：H2 行按 Alt+1 → 改为 H1（剥旧级不误伤内容）", () => {
    const v = makeView("## 标题");
    cursorAnd(v, 3, (view) => setHeading(view, 1));
    expect(v.state.doc.toString()).toBe("# 标题\n");
  });
  it("FMT-011 转正文：光标在前缀内(caret=0)正常剥离标题前缀", () => {
    const v = makeView("#### 段落");
    cursorAnd(v, 0, (view) => toParagraph(view));
    expect(v.state.doc.toString()).toBe("段落");
  });
  it("FMT-011 转正文：光标落在标题正文内(常见)不再抛错、正常剥离（D-1 已修）", () => {
    // 回归守护：旧实现返回未映射原坐标 selection，caret≥新长度时抛 RangeError 且文档不变。
    const v = makeView("#### 段落");
    cursorAnd(v, 5, (view) => toParagraph(view));
    expect(v.state.doc.toString()).toBe("段落");
  });
});

// ---------------- FMT-012 引用 toggle ----------------
describe("FMT-012 引用 toggle", () => {
  it("正：多行一次加 `> ` 前缀", () => {
    const v = makeView("a\nb\nc");
    selectAnd(v, 0, v.state.doc.length, (view) => toggleLinePrefix(view, "> "));
    expect(v.state.doc.toString()).toBe("> a\n> b\n> c");
  });
  it("正：单行移除 `> ` 前缀", () => {
    const v = makeView("> a");
    selectAnd(v, 0, 3, (view) => toggleLinePrefix(view, "> "));
    expect(v.state.doc.toString()).toBe("a");
  });
  it("正：多行选区整体移除前缀不再越界抛错（D-2 已修）", () => {
    // 回归守护：旧实现多行剥离时 range.to 越过变短后的新文档末尾 → RangeError。
    const v = makeView("> a\n> b\n> c");
    selectAnd(v, 0, v.state.doc.length, (view) => toggleLinePrefix(view, "> "));
    expect(v.state.doc.toString()).toBe("a\nb\nc");
  });
  it("FMT-013 逐行判定：混合选区中已带前缀行被剥离、未带前缀行被加前缀（D-3 已修）", () => {
    // 矩阵 FMT-013「混合行按各自状态处理」：旧实现为 all-or-nothing，现已改逐行。
    const v = makeView("普通\n- 列表");
    selectAnd(v, 0, v.state.doc.length, (view) => toggleLinePrefix(view, "- "));
    expect(v.state.doc.toString()).toBe("- 普通\n列表");
  });
});

// ---------------- FMT-015 代码块 ----------------
describe("FMT-015 代码块插入", () => {
  it("正：无选区插入空围栏", () => {
    const v = makeView("x");
    cursorAnd(v, 1, (view) => insertCodeBlock(view, ""));
    expect(v.state.doc.toString()).toBe("x\n```\n\n```\n");
  });
  it("正：选中代码包裹为围栏并标注语言", () => {
    const v = makeView("let a=1");
    selectAnd(v, 0, 7, (view) => insertCodeBlock(view, "js"));
    expect(v.state.doc.toString()).toBe("\n```js\nlet a=1\n```\n");
  });
});

// ---------------- TBL-001 插入表格 ----------------
describe("TBL-001 插入表格", () => {
  it("正：产出 3 列表头+分隔行+数据行", () => {
    const v = makeView("");
    cursorAnd(v, 0, (view) => insertTable(view));
    const doc = v.state.doc.toString();
    expect(doc).toContain("| 列1 | 列2 | 列3 |");
    expect(doc).toContain("| --- | --- | --- |");
    expect(doc).toContain("| 内容 | 内容 | 内容 |");
  });
});

// ---------------- TBL-002 复制表格行 ----------------
describe("TBL-002 复制表格行", () => {
  it("正：表格行下方复制同列副本", () => {
    const v = makeView("| a | b |");
    cursorAnd(v, 2, (view) => expect(duplicateTableRow(view)).toBe(true));
    expect(v.state.doc.toString()).toBe("| a | b |\n| a | b |");
  });
  it("边：非表格行返回 false，交还默认回车，文档不变", () => {
    const v = makeView("普通段落");
    let ret = true;
    cursorAnd(v, 2, (view) => (ret = duplicateTableRow(view)));
    expect(ret).toBe(false);
    expect(v.state.doc.toString()).toBe("普通段落");
  });
});

// ---------------- TBL-003 添加列 ----------------
describe("TBL-003 表格添加列", () => {
  it("正：连续 | 行块统一补列，分隔行补 ---", () => {
    const v = makeView("| a | b |\n| --- | --- |");
    cursorAnd(v, 2, (view) => expect(addTableColumn(view)).toBe(true));
    expect(v.state.doc.toString()).toBe("| a | b |  |\n| --- | --- | --- |");
  });
  it("异：非连续普通行不受影响（仅作用于光标所在连续块）", () => {
    const v = makeView("| a |\n普通行\n| b |");
    cursorAnd(v, 2, (view) => addTableColumn(view));
    expect(v.state.doc.toString()).toBe("| a |  |\n普通行\n| b |");
  });
});

// ---------------- TBL-004 列对齐 ----------------
describe("TBL-004 表格列对齐", () => {
  it("正：光标在第 1 列设居中 → 分隔行首格 :---:", () => {
    const v = makeView("| a | b |\n| --- | --- |");
    cursorAnd(v, 2, (view) => expect(setTableColumnAlign(view, "center")).toBe(true));
    expect(v.state.doc.toString()).toBe("| a | b |\n| :---: | --- |");
  });
  it("边：无分隔行返回 false（非完整表格）", () => {
    const v = makeView("| a | b |");
    let ret = true;
    cursorAnd(v, 2, (view) => (ret = setTableColumnAlign(view, "left")));
    expect(ret).toBe(false);
  });
});

// ---------------- FMT-003b 下划线（wrapTags <u>，M1 修复：不再是加粗 __） ----------------
describe("下划线 wrapTags（M1：产出 <u> 而非 __）", () => {
  it("正：选区包裹成 <u>x</u>", () => {
    const v = makeView("x");
    selectAnd(v, 0, 1, (view) => wrapTags(view, "<u>", "</u>"));
    expect(v.state.doc.toString()).toBe("<u>x</u>");
    // 关键：不应产出被 markdown-it 解析为加粗的 __x__
    expect(v.state.doc.toString()).not.toBe("__x__");
  });
  it("toggle：已包裹的选区再执行剥回", () => {
    const v = makeView("<u>x</u>");
    selectAnd(v, 0, 8, (view) => wrapTags(view, "<u>", "</u>"));
    expect(v.state.doc.toString()).toBe("x");
  });
  it("空光标且两侧恰为 <u></u> → 剥除", () => {
    const v = makeView("<u></u>");
    cursorAnd(v, 3, (view) => wrapTags(view, "<u>", "</u>"));
    expect(v.state.doc.toString()).toBe("");
  });
  it("无选区插入占位「文本」", () => {
    const v = makeView("");
    cursorAnd(v, 0, (view) => wrapTags(view, "<u>", "</u>"));
    expect(v.state.doc.toString()).toBe("<u>文本</u>");
  });
});
