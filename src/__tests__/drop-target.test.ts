import { describe, it, expect } from "vitest";
import { resolveDropTargetDir } from "../filetree/drop-target";

describe("resolveDropTargetDir", () => {
  const root = "C:/Users/manwa/Desktop/111";

  it("落在文件夹行 → 返回该文件夹自身", () => {
    expect(resolveDropTargetDir("C:/a/b", true, [root])).toBe("C:/a/b");
  });

  it("落在文件行 → 返回文件所在目录（parentDir）", () => {
    expect(resolveDropTargetDir("C:/a/b/note.md", false, [root])).toBe("C:/a/b");
  });

  it("data-path 缺失 → 回退到第一个根目录", () => {
    expect(resolveDropTargetDir(null, false, [root, "D:/x"])).toBe(root);
  });

  it("无任何根且落点缺失 → 返回 null（调用方应提示先打开文件夹）", () => {
    expect(resolveDropTargetDir(null, false, [])).toBeNull();
  });

  it("反斜杠路径归一化", () => {
    expect(resolveDropTargetDir("C:\\a\\b\\note.md", false, [root])).toBe("C:/a/b");
  });
});
