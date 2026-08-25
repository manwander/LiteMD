// flatten（文件树扁平化）纯函数单测：排序 / 过滤 / 隐藏 / 折叠剪枝 / 多根 / memo
import { describe, it, expect } from "vitest";
import { flatten, indexOfPath, type FlattenInput } from "../filetree/flatten";
import type { FileTreeNode } from "../filetree/types";

function node(name: string, path: string, children: FileTreeNode[] = [], files: FileTreeNode["files"] = []): FileTreeNode {
  return { name, path, files, children, loaded: true };
}

function base(over: Partial<FlattenInput> = {}): FlattenInput {
  const rootA = node("A", "/a", [
    node("sub", "/a/sub", [], [
      { name: "b.md", path: "/a/sub/b.md", isMd: true, size: 100, mtime: 10 },
      { name: "a.md", path: "/a/sub/a.md", isMd: true, size: 50, mtime: 20 },
    ]),
  ], [
    { name: "z.md", path: "/a/z.md", isMd: true, size: 300, mtime: 30 },
    { name: "a.md", path: "/a/a.md", isMd: true, size: 200, mtime: 5 },
  ]);
  const nodeMap = new Map<string, FileTreeNode>([["/a", rootA], ["/a/sub", node("sub", "/a/sub", [], [{ name: "b.md", path: "/a/sub/b.md", isMd: true, size: 100, mtime: 10 }, { name: "a.md", path: "/a/sub/a.md", isMd: true, size: 50, mtime: 20 }])]]);
  return {
    nodeMap,
    loadState: new Map(),
    rootPaths: ["/a"],
    collapsed: new Set(),
    filter: "",
    showHidden: false,
    showNonMd: false,
    hiddenPaths: [],
    hideAttachments: true,
    assetsDir: "_attachment",
    sort: "name",
    version: 1,
    ...over,
  };
}

describe("flatten 基础结构", () => {
  it("文件夹在前、文件按名称排序", () => {
    const flat = flatten(base());
    const names = flat.map((n) => n.name);
    // A → sub → sub 内文件 → A 内文件
    expect(names).toEqual(["A", "sub", "a.md", "b.md", "a.md", "z.md"]);
  });

  it("多根工作区全部展示", () => {
    const nodeMap = new Map<string, FileTreeNode>([
      ["/a", node("A", "/a")],
      ["/b", node("B", "/b")],
    ]);
    const flat = flatten(base({ nodeMap, rootPaths: ["/a", "/b"] }));
    // 空根已加载会多一行「（空文件夹）」提示，故按 folder 行断言根路径
    const folderPaths = flat.filter((n) => n.kind === "folder").map((n) => n.path);
    expect(folderPaths).toEqual(["/a", "/b"]);
    expect(flat.find((n) => n.path === "/a")?.isRoot).toBe(true);
  });

  it("折叠剪枝：折叠的目录不输出子项", () => {
    const flat = flatten(base({ collapsed: new Set(["/a/sub"]) }));
    const paths = flat.map((n) => n.path);
    expect(paths).toContain("/a/sub");
    expect(paths).not.toContain("/a/sub/a.md");
    expect(paths).toContain("/a/a.md");
  });

  it("未加载目录输出 loading 行，错误输出 error 行", () => {
    const nodeMap = new Map<string, FileTreeNode>([
      ["/a", { name: "A", path: "/a", files: [], children: [{ name: "sub", path: "/a/sub", files: [], children: [], loaded: false }], loaded: true }],
      ["/a/sub", { name: "sub", path: "/a/sub", files: [], children: [], loaded: false }],
    ]);
    const loadState = new Map([["/a/sub", { loading: true, error: null }]]);
    const flat = flatten(base({ nodeMap, loadState }));
    expect(flat.some((n) => n.kind === "loading")).toBe(true);

    const loadStateErr = new Map([["/a/sub", { loading: false, error: "权限不足" }]]);
    const flat2 = flatten(base({ nodeMap, loadState: loadStateErr, version: 2 }));
    const err = flat2.find((n) => n.kind === "error");
    expect(err?.error).toBe("权限不足");
  });
});

describe("flatten 过滤 / 隐藏", () => {
  it("filter 只保留匹配项（大小写不敏感，父目录保留）", () => {
    const flat = flatten(base({ filter: "Z" }));
    const names = flat.map((n) => n.name);
    expect(names).toEqual(["A", "z.md"]);
  });

  it("hiddenPaths 隐藏自身及子孙", () => {
    const flat = flatten(base({ hiddenPaths: ["/a/sub"] }));
    const paths = flat.map((n) => n.path);
    expect(paths).not.toContain("/a/sub");
    expect(paths).not.toContain("/a/sub/a.md");
    expect(paths).toContain("/a/a.md");
  });

  it("showNonMd=false 时只显示 .md 文件", () => {
    const nodeMap = new Map<string, FileTreeNode>([
      ["/a", node("A", "/a", [], [
        { name: "note.md", path: "/a/note.md", isMd: true, size: 1, mtime: 1 },
        { name: "pic.png", path: "/a/pic.png", isMd: false, size: 2, mtime: 2 },
      ])],
    ]);
    const flat = flatten(base({ nodeMap }));
    expect(flat.some((n) => n.kind === "file" && n.name === "pic.png")).toBe(false);
    expect(flat.some((n) => n.kind === "file" && n.name === "note.md")).toBe(true);
  });

  it("showNonMd=true 时显示全部文件并带标志", () => {
    const nodeMap = new Map<string, FileTreeNode>([
      ["/a", node("A", "/a", [], [
        { name: "pic.png", path: "/a/pic.png", isMd: false, size: 2, mtime: 2 },
      ])],
    ]);
    const flat = flatten(base({ nodeMap, showNonMd: true }));
    const pic = flat.find((n) => n.name === "pic.png");
    expect(pic?.isMd).toBe(false);
  });
});

describe("flatten 隐藏附件文件夹", () => {
  function attachInput(over: Partial<FlattenInput> = {}) {
    const a = node("A", "/a", [
      node("note_attachment", "/a/note_attachment"),
      node("otherfolder", "/a/otherfolder"),
    ], [
      { name: "note.md", path: "/a/note.md", isMd: true, size: 1, mtime: 1 },
      { name: "other.md", path: "/a/other.md", isMd: true, size: 1, mtime: 1 },
    ]);
    const nodeMap = new Map<string, FileTreeNode>([
      ["/a", a],
      ["/a/note_attachment", node("note_attachment", "/a/note_attachment")],
      ["/a/otherfolder", node("otherfolder", "/a/otherfolder")],
    ]);
    return base({ nodeMap, ...over });
  }

  it("默认隐藏：note_attachment 被过滤，同名 .md 与其它目录保留", () => {
    const flat = flatten(attachInput({ version: 20 }));
    const folders = flat.filter((n) => n.kind === "folder").map((n) => n.name);
    expect(folders).toContain("otherfolder");
    expect(folders).not.toContain("note_attachment");
    const files = flat.filter((n) => n.kind === "file").map((n) => n.name);
    expect(files).toContain("note.md");
  });

  it("关闭隐藏后 note_attachment 重新显示", () => {
    const flat = flatten(attachInput({ hideAttachments: false, version: 21 }));
    const folders = flat.filter((n) => n.kind === "folder").map((n) => n.name);
    expect(folders).toContain("note_attachment");
  });

  it("无同名 .md 时不误隐藏（带 attachment 的普通目录）", () => {
    const a = node("A", "/a", [node("report_attachment", "/a/report_attachment")], [
      { name: "note.md", path: "/a/note.md", isMd: true, size: 1, mtime: 1 },
    ]);
    const nodeMap = new Map<string, FileTreeNode>([
      ["/a", a],
      ["/a/report_attachment", node("report_attachment", "/a/report_attachment")],
    ]);
    const flat = flatten(base({ nodeMap, version: 22 }));
    const folders = flat.filter((n) => n.kind === "folder").map((n) => n.name);
    expect(folders).toContain("report_attachment"); // 没有 report.md → 不是附件文件夹
  });

  it("默认隐藏统一附件目录 _attachment（无论是否有同名 .md）", () => {
    const a = node("A", "/a", [
      node("_attachment", "/a/_attachment"),
      node("otherfolder", "/a/otherfolder"),
    ], [
      { name: "note.md", path: "/a/note.md", isMd: true, size: 1, mtime: 1 },
    ]);
    const nodeMap = new Map<string, FileTreeNode>([
      ["/a", a],
      ["/a/_attachment", node("_attachment", "/a/_attachment")],
      ["/a/otherfolder", node("otherfolder", "/a/otherfolder")],
    ]);
    const flat = flatten(base({ nodeMap, assetsDir: "_attachment", version: 23 }));
    const folders = flat.filter((n) => n.kind === "folder").map((n) => n.name);
    expect(folders).not.toContain("_attachment");
    expect(folders).toContain("otherfolder");
  });

  it("自定义 assetsDir 时隐藏对应统一附件目录", () => {
    const a = node("A", "/a", [
      node("assets", "/a/assets"),
      node("_attachment", "/a/_attachment"),
    ], [
      { name: "note.md", path: "/a/note.md", isMd: true, size: 1, mtime: 1 },
    ]);
    const nodeMap = new Map<string, FileTreeNode>([
      ["/a", a],
      ["/a/assets", node("assets", "/a/assets")],
      ["/a/_attachment", node("_attachment", "/a/_attachment")],
    ]);
    const flat = flatten(base({ nodeMap, assetsDir: "assets", version: 24 }));
    const folders = flat.filter((n) => n.kind === "folder").map((n) => n.name);
    expect(folders).toContain("_attachment");
    expect(folders).not.toContain("assets");
  });
});

describe("flatten 排序", () => {
  it("mtime 降序（目录内）", () => {
    const flat = flatten(base({ sort: "mtime" }));
    const files = flat.filter((n) => n.kind === "file");
    // 顺序：sub 内 [a.md(20), b.md(10)]，A 内 [z.md(30), a.md(5)]
    expect(files.map((n) => [n.name, n.mtime])).toEqual([
      ["a.md", 20],
      ["b.md", 10],
      ["z.md", 30],
      ["a.md", 5],
    ]);
  });

  it("size 降序（目录内）", () => {
    const flat = flatten(base({ sort: "size" }));
    const files = flat.filter((n) => n.kind === "file");
    expect(files.map((n) => n.size)).toEqual([100, 50, 300, 200]);
  });

  it("type 按扩展名分组", () => {
    const nodeMap = new Map<string, FileTreeNode>([
      ["/a", node("A", "/a", [], [
        { name: "b.md", path: "/a/b.md", isMd: true, size: 1, mtime: 1 },
        { name: "a.txt", path: "/a/a.txt", isMd: false, size: 1, mtime: 1 },
        { name: "c.md", path: "/a/c.md", isMd: true, size: 1, mtime: 1 },
      ])],
    ]);
    const flat = flatten(base({ nodeMap, sort: "type", showNonMd: true }));
    const files = flat.filter((n) => n.kind === "file").map((n) => n.name);
    // 扩展名排序：md < txt
    expect(files).toEqual(["b.md", "c.md", "a.txt"]);
  });
});

describe("flatten 多根嵌套（重复 key 崩溃回归）", () => {
  it("根是另一个根的子目录时只展示一次", () => {
    // roots = [C:/a, C:/a/b]，b 嵌套在 a 下
    const nodeMap = new Map<string, FileTreeNode>([
      ["C:/a", node("a", "C:/a", [node("b", "C:/a/b")], [{ name: "x.md", path: "C:/a/x.md", isMd: true, size: 1, mtime: 1 }])],
      ["C:/a/b", node("b", "C:/a/b", [], [{ name: "y.md", path: "C:/a/b/y.md", isMd: true, size: 1, mtime: 1 }])],
    ]);
    const flat = flatten(base({ nodeMap, rootPaths: ["C:/a", "C:/a/b"], version: 7 }));
    const paths = flat.map((n) => n.path);
    // C:/a/b 只出现一次（作为根），不再作为 a 的子目录
    expect(paths.filter((p) => p === "C:/a/b").length).toBe(1);
    expect(paths[0]).toBe("C:/a");
    // 深度优先：根 A 的内容（x.md）在第二个根 B 之前
    expect(paths[1]).toBe("C:/a/x.md");
    // 无任何重复 path
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("子目录位于其他根之下时跳过（不重复输出）", () => {
    const nodeMap = new Map<string, FileTreeNode>([
      ["C:/a", node("a", "C:/a", [node("mid", "C:/a/mid", [node("c", "C:/a/mid/c")])])],
      ["C:/a/mid", node("mid", "C:/a/mid", [node("c", "C:/a/mid/c")])],
      ["C:/a/mid/c", node("c", "C:/a/mid/c")],
    ]);
    const flat = flatten(base({ nodeMap, rootPaths: ["C:/a", "C:/a/mid/c"], version: 8 }));
    const paths = flat.map((n) => n.path);
    // 根 C:/a/mid/c 只出现一次（作为根），a 的子树中不再包含它
    expect(paths.filter((p) => p === "C:/a/mid/c").length).toBe(1);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("rootPaths 含重复项时防御性去重", () => {
    const nodeMap = new Map<string, FileTreeNode>([["C:/a", node("a", "C:/a")]]);
    const flat = flatten(base({ nodeMap, rootPaths: ["C:/a", "C:/a", "C:/a"], version: 9 }));
    const folderPaths = flat.filter((n) => n.kind === "folder").map((n) => n.path);
    expect(folderPaths).toEqual(["C:/a"]);
  });

  it("未加载目录的 folder 行与 loading 行 path 相同（key 由模板复合区分，flatten 不重复）", () => {
    const nodeMap = new Map<string, FileTreeNode>([
      ["C:/a", { name: "a", path: "C:/a", files: [], children: [{ name: "sub", path: "C:/a/sub", files: [], children: [], loaded: false }], loaded: true }],
      ["C:/a/sub", { name: "sub", path: "C:/a/sub", files: [], children: [], loaded: false }],
    ]);
    const loadState = new Map([["C:/a/sub", { loading: true, error: null }]]);
    const flat = flatten(base({ nodeMap, loadState, rootPaths: ["C:/a"], version: 10 }));
    // folder 行 + loading 行 path 相同是预期的，但 flat 中不应有第三种重复
    const kinds = flat.filter((n) => n.path === "C:/a/sub").map((n) => n.kind);
    expect(kinds).toEqual(["folder", "loading"]);
  });
});

describe("flatten 无全局 memo（每次调用返回新数组，M-01）", () => {
  it("相同输入返回新引用（避免跨调用共享数组被意外篡改）", () => {
    const inp = base();
    const a = flatten(inp);
    const b = flatten(inp);
    expect(a).not.toBe(b); // 每次调用独立计算（memo 已移除）
    // 内容仍一致
    expect(a.map((n) => n.path)).toEqual(b.map((n) => n.path));
  });

  it("version 变化也重新计算（返回新引用）", () => {
    const inp = base();
    const a = flatten(inp);
    const b = flatten({ ...inp, version: 2 });
    expect(b).not.toBe(a);
  });

  it("indexOfPath 定位", () => {
    const flat = flatten(base());
    expect(indexOfPath(flat, "/a/sub/a.md")).toBe(2);
    expect(indexOfPath(flat, "/nope")).toBe(-1);
  });
});
