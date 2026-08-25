import { describe, it, expect } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { setOrderedList } from "../editor";

function makeView(doc: string): EditorView {
  return new EditorView({ state: EditorState.create({ doc }) });
}

describe("setOrderedList selection position probe", () => {
  it("cursor at line start", () => {
    const v = makeView("hello");
    v.dispatch({ selection: EditorSelection.cursor(0) });
    setOrderedList(v, 1);
    expect(v.state.doc.toString()).toBe("1. hello\n");
    expect(v.state.selection.main.head).toBe(3);
  });

  it("cursor inside text", () => {
    const v = makeView("hello");
    v.dispatch({ selection: EditorSelection.cursor(2) }); // he|llo
    setOrderedList(v, 1);
    expect(v.state.doc.toString()).toBe("1. hello\n");
    expect(v.state.selection.main.head).toBe(5);
  });

  it("cursor at line end", () => {
    const v = makeView("hello");
    v.dispatch({ selection: EditorSelection.cursor(5) });
    setOrderedList(v, 1);
    expect(v.state.doc.toString()).toBe("1. hello\n");
    expect(v.state.selection.main.head).toBe(9); // 越过追加换行，落到下一行开头
  });

  it("forward selection", () => {
    const v = makeView("hello");
    v.dispatch({ selection: EditorSelection.range(1, 4) }); // h|ell|o
    setOrderedList(v, 1);
    expect(v.state.doc.toString()).toBe("1. hello\n");
    expect(v.state.selection.main.head).toBe(7); // 保留相对正文选区
  });

  it("backward selection", () => {
    const v = makeView("hello");
    v.dispatch({ selection: EditorSelection.range(4, 1) }); // h|ell|o (backward)
    setOrderedList(v, 1);
    expect(v.state.doc.toString()).toBe("1. hello\n");
    expect(v.state.selection.main.head).toBe(4);
  });
});
