/**
 * 查找/替换核心逻辑单元测试 —— 对应矩阵 SR-003~SR-010。
 *
 * search-panel 的匹配/替换/转义/回绕函数此前模块私有、无法测（§5.5 缺口）。现已导出并补测，
 * 同时固化 D-4（CM6 SearchQuery 对非法正则不抛异常、仅置 valid=false）的契约：buildQuery
 * 对半截正则必须返回 valid=false，调用方据此拒绝再走 getCursor，避免冒泡成全屏错误页。
 */
import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { SearchQuery } from "@codemirror/search";
import {
  unquoteText,
  buildQuery,
  matchesOf,
  selectMatch,
  selectAllMatches,
  replaceCurrent,
  replaceAllMatches,
} from "../search-panel";

function makeView(doc: string, readOnly = false): EditorView {
  // 真实编辑器经 ED-003 enableMultipleSelections 允许多选区；裸 EditorState 默认关闭，
  // 会把多匹配选区折叠成 1 段，故测试视图显式开启。
  const extensions = [EditorState.allowMultipleSelections.of(true)];
  if (readOnly) extensions.push(EditorState.readOnly.of(true));
  return new EditorView({ state: EditorState.create({ doc, extensions }) });
}
function setSel(view: EditorView, from: number, to: number): void {
  view.dispatch({ selection: { anchor: from, head: to } });
}

describe("SR-010 unquoteText 转义", () => {
  it("\\n \\t \\\\ 还原为真实字符", () => {
    expect(unquoteText("a\\nb")).toBe("a\nb");
    expect(unquoteText("x\\ty")).toBe("x\ty");
    expect(unquoteText("p\\\\q")).toBe("p\\q");
    expect(unquoteText("no escape")).toBe("no escape");
  });
});

describe("SR-004 buildQuery / D-4 非法正则契约", () => {
  it("合法正则 → valid=true 并可匹配", () => {
    const q = buildQuery("\\d+", false, true);
    expect(q.valid).toBe(true);
    const v = makeView("abc 1234 def");
    expect(matchesOf(v, q).length).toBe(1);
  });
  it("半截/非法正则 → valid=false（不得再走 getCursor）", () => {
    expect(buildQuery("(", false, true).valid).toBe(false);
    expect(buildQuery("[a-", false, true).valid).toBe(false);
  });
  it("字面量模式下 '(' 只是普通字符，valid=true", () => {
    const q = buildQuery("(", false, false);
    expect(q.valid).toBe(true);
    expect(matchesOf(makeView("a(b"), q).length).toBe(1);
  });
});

describe("SR-003 大小写敏感", () => {
  it("敏感=1 处、不敏感=3 处", () => {
    const v = makeView("Lite lite LITE");
    expect(matchesOf(v, buildQuery("Lite", true, false)).length).toBe(1);
    expect(matchesOf(v, buildQuery("Lite", false, false)).length).toBe(3);
  });
});

describe("SR-005 计数上限（limit）", () => {
  it("matchesOf 尊重 limit，不多扫", () => {
    const v = makeView("a a a a a");
    const q = buildQuery("a", false, false);
    expect(matchesOf(v, q).length).toBe(5);
    expect(matchesOf(v, q, 3).length).toBe(3);
  });
});

describe("SR-006 上一个/下一个回绕", () => {
  it("next 依序推进并回绕，跳过与当前重合的匹配", () => {
    const v = makeView("a foo b foo c foo"); // foo 在 2-5 / 8-11 / 14-17
    const q = buildQuery("foo", false, false);
    setSel(v, 0, 0);
    expect(selectMatch(v, q, 1)).toBe(true);
    expect(v.state.selection.main.from).toBe(2);
    selectMatch(v, q, 1);
    expect(v.state.selection.main.from).toBe(8);
    selectMatch(v, q, 1);
    expect(v.state.selection.main.from).toBe(14);
    selectMatch(v, q, 1); // 末尾 → 回绕到开头
    expect(v.state.selection.main.from).toBe(2);
    selectMatch(v, q, -1); // 开头 → 回绕到末尾
    expect(v.state.selection.main.from).toBe(14);
  });
  it("无匹配返回 false", () => {
    expect(selectMatch(makeView("hello"), buildQuery("zzz", false, false), 1)).toBe(false);
  });
});

describe("SR-008 全部选择匹配", () => {
  it("选中所有匹配并返回计数", () => {
    const v = makeView("foo foo foo");
    expect(selectAllMatches(v, buildQuery("foo", false, false))).toBe(3);
    expect(v.state.selection.ranges.length).toBe(3);
  });
});

describe("SR-009 替换当前 / 全部替换 / readOnly", () => {
  it("替换当前匹配并前进，未选中匹配则仅跳转", () => {
    const v = makeView("foo bar foo");
    const q = new SearchQuery({ search: "foo", replace: "X" });
    setSel(v, 0, 3); // 选中的正是第一个匹配
    expect(replaceCurrent(v, q)).toBe(true);
    expect(v.state.doc.toString()).toBe("X bar foo");
  });
  it("全部替换返回处数并落盘", () => {
    const v = makeView("foo foo foo");
    const q = new SearchQuery({ search: "foo", replace: "bar" });
    expect(replaceAllMatches(v, q)).toBe(3);
    expect(v.state.doc.toString()).toBe("bar bar bar");
  });
  it("readOnly：替换被拒、文档不变", () => {
    const v = makeView("foo foo", true);
    const q = new SearchQuery({ search: "foo", replace: "X" });
    setSel(v, 0, 3);
    expect(replaceCurrent(v, q)).toBe(false);
    expect(replaceAllMatches(v, q)).toBe(0);
    expect(v.state.doc.toString()).toBe("foo foo");
  });
});
