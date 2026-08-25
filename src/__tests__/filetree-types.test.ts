// filetree/types 纯工具函数单测
import { describe, it, expect } from "vitest";
import {
  normPath,
  baseName,
  parentDir,
  isPathHidden,
  isUnder,
  ancestorDirs,
} from "../filetree/types";

describe("路径工具", () => {
  it("normPath 统一正斜杠并去尾斜杠", () => {
    expect(normPath("C:\\a\\b\\")).toBe("C:/a/b");
    expect(normPath("C:\\a\\b")).toBe("C:/a/b");
    expect(normPath("/a/b/")).toBe("/a/b");
  });

  it("baseName / parentDir", () => {
    expect(baseName("C:/a/b.md")).toBe("b.md");
    expect(baseName("C:\\a\\b.md")).toBe("b.md");
    expect(parentDir("C:/a/b.md")).toBe("C:/a");
    expect(parentDir("C:/a/b")).toBe("C:/a");
  });

  it("isPathHidden：自身或祖先命中", () => {
    expect(isPathHidden("C:/a/sub/f.md", ["C:/a/sub"])).toBe(true);
    expect(isPathHidden("C:/a/sub2/f.md", ["C:/a/sub"])).toBe(false);
    expect(isPathHidden("C:/a", ["C:/a"])).toBe(true);
    // 反斜杠归一
    expect(isPathHidden("C:\\a\\sub\\f.md", ["C:/a/sub"])).toBe(true);
  });

  it("isUnder 判断归属", () => {
    expect(isUnder("C:/a/b.md", "C:/a")).toBe(true);
    expect(isUnder("C:/a", "C:/a")).toBe(true);
    expect(isUnder("C:/ab/c.md", "C:/a")).toBe(false);
  });

  it("ancestorDirs 推导祖先链", () => {
    expect(ancestorDirs("C:/a/b/c/d.md", "C:/a")).toEqual(["C:/a/b", "C:/a/b/c"]);
    expect(ancestorDirs("C:/a/b.md", "C:/a")).toEqual([]);
    expect(ancestorDirs("C:/a", "C:/a")).toEqual([]);
  });
});
