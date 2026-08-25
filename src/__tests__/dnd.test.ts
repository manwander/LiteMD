// 拖拽目标校验：覆盖「子项拖到父/祖先目录（向上移动）」
import { describe, it, expect } from "vitest";
import { dragTargetValid } from "../filetree/dnd";

describe("dragTargetValid", () => {
  it("允许把深层文件拖到根目录（向上移动到 1 级）", () => {
    expect(dragTargetValid("C:/1/2/3/4/12.md", "C:/1")).toBe(true);
  });
  it("允许把子文件夹拖到祖先目录（向上移动）", () => {
    expect(dragTargetValid("C:/1/2/3", "C:/1")).toBe(true);
    expect(dragTargetValid("C:/1/2/3/4", "C:/1/2")).toBe(true);
  });
  it("禁止把目录拖进它自己的子孙", () => {
    expect(dragTargetValid("C:/1/2/3", "C:/1/2/3/4")).toBe(false);
  });
  it("禁止拖到自身", () => {
    expect(dragTargetValid("C:/1/2/3", "C:/1/2/3")).toBe(false);
  });
  it("允许把文件拖到同级其它目录（reorder）", () => {
    expect(dragTargetValid("C:/1/2/a.md", "C:/1/2/3")).toBe(true);
  });
  it("盘符根路径也能正确判定向上移动", () => {
    expect(dragTargetValid("D:/a/b/c.md", "D:/")).toBe(true);
  });
});
