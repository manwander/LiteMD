/**
 * insert-actions 单元测试（E6）——纯 CM6 view 命令助手。
 *
 * 与 editor-format.test.ts 同构：真实 EditorView + 断言实测行为（文档内容 + 光标）。
 * 覆盖每个导出至少一条正用例 + 边界（空文档/无选区/选区跨行/无标题）。
 * 集成方按本文件固化行为写入 ACTION_HANDLERS。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  setHeadingLevel,
  wrapInlineCode,
  wrapMath,
  insertDateTime,
  insertHorizontalRule,
  insertToc,
  selectAllDoc,
  clearFormatting,
} from "../insert-actions";

function makeView(doc: string): EditorView {
  return new EditorView({ state: EditorState.create({ doc }) });
}
function selectAnd(view: EditorView, from: number, to: number, fn: (v: EditorView) => void): void {
  view.dispatch({ selection: { anchor: from, head: to } });
  fn(view);
}
function cursorAnd(view: EditorView, pos: number, fn: (v: EditorView) => void): void {
  view.dispatch({ selection: { anchor: pos } });
  fn(view);
}

// ---------------- setHeadingLevel ----------------
describe("setHeadingLevel", () => {
  it("正：level 2 设二级标题（行尾补换行，光标落新行）", () => {
    const v = makeView("abc");
    cursorAnd(v, 0, (view) => setHeadingLevel(view, 2));
    expect(v.state.doc.toString()).toBe("## abc\n");
    expect(v.state.selection.main.head).toBe(7);
  });
  it("正：level 0 清除标题回正文（委托 toParagraph）", () => {
    const v = makeView("## 标题");
    cursorAnd(v, 0, (view) => setHeadingLevel(view, 0));
    expect(v.state.doc.toString()).toBe("标题");
  });
  it("边：level 9 收敛到 6（防脏数据）", () => {
    const v = makeView("abc");
    cursorAnd(v, 0, (view) => setHeadingLevel(view, 9));
    expect(v.state.doc.toString()).toBe("###### abc\n");
  });
  it("边：负数同样回正文", () => {
    const v = makeView("### 深标题");
    cursorAnd(v, 0, (view) => setHeadingLevel(view, -1));
    expect(v.state.doc.toString()).toBe("深标题");
  });
});

// ---------------- wrapInlineCode ----------------
describe("wrapInlineCode", () => {
  it("正：选区包 `", () => {
    const v = makeView("code");
    selectAnd(v, 0, 4, (view) => wrapInlineCode(view));
    expect(v.state.doc.toString()).toBe("`code`");
  });
  it("边：无选区插入占位文本", () => {
    const v = makeView("");
    cursorAnd(v, 0, (view) => wrapInlineCode(view));
    expect(v.state.doc.toString()).toBe("`文本`");
  });
  it("边：toggle 取消（复用 wrapSelection 语义）", () => {
    const v = makeView("`code`");
    selectAnd(v, 0, 6, (view) => wrapInlineCode(view));
    expect(v.state.doc.toString()).toBe("code");
  });
});

// ---------------- wrapMath ----------------
describe("wrapMath", () => {
  it("正：有选区走行内 $ 包裹", () => {
    const v = makeView("x=1");
    selectAnd(v, 0, 3, (view) => wrapMath(view));
    expect(v.state.doc.toString()).toBe("$x=1$");
  });
  it("边：无选区插块级骨架 $$\\n\\n$$，光标落中间空行", () => {
    const v = makeView("");
    cursorAnd(v, 0, (view) => wrapMath(view));
    expect(v.state.doc.toString()).toBe("$$\n\n$$");
    expect(v.state.selection.main.head).toBe(3);
  });
});

// ---------------- insertDateTime ----------------
describe("insertDateTime", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  it("正：插入本地时间 YYYY-MM-DD HH:mm（补零），光标停在文末", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 2, 3, 4, 5)); // 2026-01-02 03:04:05 本地
    const v = makeView("记录于：");
    cursorAnd(v, 4, (view) => insertDateTime(view));
    expect(v.state.doc.toString()).toBe("记录于：2026-01-02 03:04");
    expect(v.state.selection.main.head).toBe(4 + "2026-01-02 03:04".length);
  });
  it("边：有选区则替换选区", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 11, 31, 23, 59));
    const v = makeView("占位符");
    selectAnd(v, 0, 2, (view) => insertDateTime(view)); // 选「占位」，留「符」
    expect(v.state.doc.toString()).toBe("2026-12-31 23:59符");
  });
});

// ---------------- insertHorizontalRule ----------------
describe("insertHorizontalRule", () => {
  it("正：光标在行尾 → 仅前补换行", () => {
    const v = makeView("abc");
    cursorAnd(v, 3, (view) => insertHorizontalRule(view));
    expect(v.state.doc.toString()).toBe("abc\n---");
  });
  it("正：光标在行中 → 前后各补换行", () => {
    const v = makeView("abcdef");
    cursorAnd(v, 3, (view) => insertHorizontalRule(view));
    expect(v.state.doc.toString()).toBe("abc\n---\ndef");
  });
  it("边：光标在行首 → 仅后补换行", () => {
    const v = makeView("abc");
    cursorAnd(v, 0, (view) => insertHorizontalRule(view));
    expect(v.state.doc.toString()).toBe("---\nabc");
  });
  it("边：空文档 → 裸 ---", () => {
    const v = makeView("");
    cursorAnd(v, 0, (view) => insertHorizontalRule(view));
    expect(v.state.doc.toString()).toBe("---");
  });
});

// ---------------- insertToc ----------------
describe("insertToc", () => {
  it("正：按文档序生成 - [标题](#锚点)，光标落目录后", () => {
    const v = makeView("# 标题一\n\n正文\n\n## 标题二\n");
    cursorAnd(v, 0, (view) => {
      expect(insertToc(view)).toBe(true);
    });
    expect(v.state.doc.toString()).toBe("- [标题一](#标题一)\n- [标题二](#标题二)\n# 标题一\n\n正文\n\n## 标题二\n");
    expect(v.state.selection.main.head).toBe("- [标题一](#标题一)\n- [标题二](#标题二)\n".length);
  });
  it("正：锚点小写去特殊字符、空格转连字符", () => {
    const v = makeView("# Hello World!\n");
    cursorAnd(v, 0, (view) => insertToc(view));
    expect(v.state.doc.toString()).toBe("- [Hello World!](#hello-world)\n# Hello World!\n");
  });
  it("边：空文档 → false 且不修改", () => {
    const v = makeView("");
    cursorAnd(v, 0, (view) => {
      expect(insertToc(view)).toBe(false);
    });
    expect(v.state.doc.toString()).toBe("");
  });
  it("边：无标题文档 → false 且不修改", () => {
    const v = makeView("只有正文\n没有标题\n");
    cursorAnd(v, 0, (view) => {
      expect(insertToc(view)).toBe(false);
    });
    expect(v.state.doc.toString()).toBe("只有正文\n没有标题\n");
  });
  it("边：围栏代码块内的 # 不算标题（复用 outline 语义）", () => {
    const v = makeView("```\n# 不是标题\n```\n");
    cursorAnd(v, 0, (view) => {
      expect(insertToc(view)).toBe(false);
    });
    expect(v.state.doc.toString()).toBe("```\n# 不是标题\n```\n");
  });
});

// ---------------- selectAllDoc ----------------
describe("selectAllDoc", () => {
  it("正：全选文档（anchor 0 → head 文档长）", () => {
    const v = makeView("a\nb");
    cursorAnd(v, 1, (view) => selectAllDoc(view));
    const sel = v.state.selection.main;
    expect(sel.from).toBe(0);
    expect(sel.to).toBe(3);
  });
  it("边：空文档全选不抛错", () => {
    const v = makeView("");
    cursorAnd(v, 0, (view) => selectAllDoc(view));
    expect(v.state.selection.main.to).toBe(0);
  });
});

// ---------------- clearFormatting ----------------
describe("clearFormatting", () => {
  it("正：跨行选区剥各类行首标记", () => {
    const v = makeView("# 标题\n- 项\n> 引用\n1. 有序\n普通行");
    selectAnd(v, 0, v.state.doc.length, (view) => clearFormatting(view));
    expect(v.state.doc.toString()).toBe("标题\n项\n引用\n有序\n普通行");
  });
  it("正：任务列表复选框一并剥除", () => {
    const v = makeView("- [x] 完成");
    selectAnd(v, 0, v.state.doc.length, (view) => clearFormatting(view));
    expect(v.state.doc.toString()).toBe("完成");
  });
  it("边：行内 ** 富格式不在范围（明示局限）", () => {
    const v = makeView("**粗** 普通");
    selectAnd(v, 0, v.state.doc.length, (view) => clearFormatting(view));
    expect(v.state.doc.toString()).toBe("**粗** 普通");
  });
  it("边：无标记行 → 文档不变", () => {
    const v = makeView("干净行\n另一行");
    selectAnd(v, 0, v.state.doc.length, (view) => clearFormatting(view));
    expect(v.state.doc.toString()).toBe("干净行\n另一行");
  });
});
