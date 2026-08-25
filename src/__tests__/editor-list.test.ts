/**
 * 编辑器命令单元测试（对应 m-01 setOrderedList/renumberBlock 边界 与 M-02 applyExternalEdit 增量写）
 *
 * 说明：
 *  - `setOrderedList` 是导出函数，覆盖「创建 / 切换 / 嵌套 / 混合 / start 偏移 / 空行 / 单选光标」边界。
 *  - `renumberBlock` 为模块内私有函数，这里显式导出于测试；其边界逻辑（\d+\.\s 缩进匹配 + 跨空行块扩展）
 *    直接验证。
 *  - `applyExternalEdit` 是 M-02 增量同步的最终写入口，验证越界防御与最小写入。
 *
 * 关于 setOrderedList 的「尾部换行」：转化为有序列表后，代码会在最后一项追加一个 "\n"
 * 以便光标落到下一行继续输入（与 Typora/MarkText 等行为一致），测试已据此固化该行为。
 */
import { describe, it, expect } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { setOrderedList, applyExternalEdit, renumberBlock } from "../editor";

function makeView(doc: string): EditorView {
  return new EditorView({ state: EditorState.create({ doc }) });
}

/** 选中整篇文档后执行命令 */
function selectAllAnd(view: EditorView, fn: (v: EditorView) => void): void {
  view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
  fn(view);
}

describe("m-01 setOrderedList 基础", () => {
  it("普通多行文本转为有序列表（从 1 开始，末尾追加换行便于续写）", () => {
    const v = makeView("a\nb\nc");
    selectAllAnd(v, (view) => setOrderedList(view, 1));
    expect(v.state.doc.toString()).toBe("1. a\n2. b\n3. c\n");
  });

  it("已是全部有序列表时再调用 → 切换取消编号", () => {
    const v = makeView("1. a\n2. b\n3. c");
    selectAllAnd(v, (view) => setOrderedList(view, 1));
    expect(v.state.doc.toString()).toBe("a\nb\nc");
  });

  it("start 偏移生效：从 5 开始编号", () => {
    const v = makeView("a\nb");
    selectAllAnd(v, (view) => setOrderedList(view, 5));
    expect(v.state.doc.toString()).toBe("5. a\n6. b\n");
  });
});

describe("m-01 setOrderedList 边界：嵌套 / 混合 / 空行 / 单选", () => {
  it("缩进（嵌套）列表保留前导空白", () => {
    const v = makeView("  a\n  b");
    selectAllAnd(v, (view) => setOrderedList(view, 1));
    const out = v.state.doc.toString();
    expect(out).toContain("1. ");
    // 前导缩进被保留在编号之后
    expect(out.split("\n")[0].startsWith("1.  ")).toBe(true);
  });

  it("混合行（部分已编号）也能连续重排，不破坏结构", () => {
    const v = makeView("1. a\nb");
    selectAllAnd(v, (view) => setOrderedList(view, 1));
    expect(v.state.doc.toString()).toBe("1. a\n2. b\n");
  });

  it("空行夹杂在列表之间：空行也被编号（既有行为，已固化，确保不抛错且后续项连续）", () => {
    const v = makeView("a\n\nb\nc");
    selectAllAnd(v, (view) => setOrderedList(view, 1));
    // 注意：空行被编号为 "2. "（带尾随空格），第 3/4 行顺延为 3./4.
    expect(v.state.doc.toString()).toBe("1. a\n2. \n3. b\n4. c\n");
  });

  it("仅放置光标（无选区）于单行时，给当前行加编号", () => {
    const v = makeView("hello");
    v.dispatch({ selection: EditorSelection.cursor(0) });
    setOrderedList(v, 1);
    expect(v.state.doc.toString()).toBe("1. hello\n");
  });

  it("已编号行再调用 start=1 时切换取消编号（幂等正确）", () => {
    const v = makeView("1. x\n2. y");
    selectAllAnd(v, (view) => setOrderedList(view, 1));
    expect(v.state.doc.toString()).toBe("x\ny");
  });
});

describe("m-01 renumberBlock 删除中间行后自动重排", () => {
  it("删除有序列表中间行后，后续编号自动修正为连续", () => {
    const v = makeView("1. a\n2. b\n3. c\n4. d");
    // 删除第 2 行（含换行）："2. b\n" 长度 5，区间 [5,10)
    v.dispatch({ changes: { from: 5, to: 10 } });
    // 文档变为 "1. a\n3. c\n4. d"；触发重编号（等价于 orderedListRenumber 监听的行为）
    renumberBlock(v, 1);
    expect(v.state.doc.toString()).toBe("1. a\n2. c\n3. d");
  });

  it("重编号不改变行数、不增删行，仅改行内编号文字", () => {
    const v = makeView("1. a\n5. b\n9. c");
    renumberBlock(v, 1);
    expect(v.state.doc.toString()).toBe("1. a\n2. b\n3. c");
  });

  it("单行有序列表不会误触发重编号（无变化返回 false）", () => {
    const v = makeView("1. a");
    expect(renumberBlock(v, 1)).toBe(false);
  });

  it("嵌套缩进的有序列表重编号保留缩进", () => {
    const v = makeView("  1. a\n  2. b\n  9. c");
    renumberBlock(v, 1);
    const out = v.state.doc.toString();
    expect(out).toBe("  1. a\n  2. b\n  3. c");
  });
});

describe("M-02 applyExternalEdit 增量写与越界防御", () => {
  it("正常局部替换返回 true 且文档更新", () => {
    const v = makeView("abc");
    const ok = applyExternalEdit(v, 1, 2, "X");
    expect(ok).toBe(true);
    expect(v.state.doc.toString()).toBe("aXc");
  });

  it("from<0 越界 → 返回 false 且不修改文档", () => {
    const v = makeView("abc");
    const ok = applyExternalEdit(v, -1, 2, "X");
    expect(ok).toBe(false);
    expect(v.state.doc.toString()).toBe("abc");
  });

  it("from>to 非法区间 → 返回 false", () => {
    const v = makeView("abc");
    const ok = applyExternalEdit(v, 5, 3, "X");
    expect(ok).toBe(false);
    expect(v.state.doc.toString()).toBe("abc");
  });

  it("from===to 且 insert 为空 → 返回 false（无操作）", () => {
    const v = makeView("abc");
    const ok = applyExternalEdit(v, 2, 2, "");
    expect(ok).toBe(false);
    expect(v.state.doc.toString()).toBe("abc");
  });

  it("from===to 且 insert 非空 → 视为插入", () => {
    const v = makeView("abc");
    const ok = applyExternalEdit(v, 3, 3, "Z");
    expect(ok).toBe(true);
    expect(v.state.doc.toString()).toBe("abcZ");
  });
});
