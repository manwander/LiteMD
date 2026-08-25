// 文件管理器修复验证（纯逻辑层）：覆盖 P-01/P-02 路径归一化、P-04 大小写不敏感、
// B-01 乐观子节点在 listDir 刷新后被合并保留、B-08 空文件夹提示。
import { describe, it, expect, vi, beforeEach } from "vitest";

// 拦截 listDir（避免真实 Tauri invoke）
const listDirMock = vi.fn();
vi.mock("../fs", () => ({
  listDir: (dir: string, showHidden: boolean) => listDirMock(dir, showHidden),
}));

import { normPath, parentDir, baseName } from "./types";
import { flatten } from "./flatten";
import { createTreeStore, migrateCollapsed } from "./store";
import { loadFolderNode, addFolderNode, addFileNode, revealCreated as opsRevealCreated, applyFsChanges as opsApplyFsChanges } from "./ops";
import type { FileTreeNode } from "./types";

describe("路径归一化 P-01/P-02", () => {
  it("盘符根目录保持 C:/，不退化成相对路径 C:", () => {
    expect(normPath("C:\\")).toBe("C:/");
    expect(normPath("C:/")).toBe("C:/");
  });
  it("parentDir 对盘符根返回根自身（norm 后仍是 C:/）", () => {
    expect(normPath(parentDir("C:/"))).toBe("C:/");
    expect(normPath(parentDir("D:/22"))).toBe("D:/");
  });
  it("普通路径去尾部斜杠", () => {
    expect(normPath("D:\\22\\")).toBe("D:/22");
    expect(parentDir("D:/22/a/b.md")).toBe("D:/22/a");
  });
});

describe("B-01 乐观子节点合并保留", () => {
  beforeEach(() => listDirMock.mockReset());
  it("loadFolderNode 刷新父目录时保留未枚举到的乐观子节点", async () => {
    const store = createTreeStore();
    const parent = "D:/22";
    // 预置父目录已加载
    listDirMock.mockResolvedValueOnce([
      { name: "existing", path: "D:/22/existing", is_dir: true, is_md: false, size: 0, mtime: 0 },
    ]);
    await loadFolderNode(store, parent, false);
    // 乐观插入新文件夹
    addFolderNode(store, parent, "新建文件夹");
    const before = store.get().nodeMap.get(parent)!.children.map((c) => c.name);
    expect(before).toContain("新建文件夹");
    // 模拟 watcher 刷新：listDir 暂时只枚举到 existing（Windows 通知延迟）
    listDirMock.mockResolvedValueOnce([
      { name: "existing", path: "D:/22/existing", is_dir: true, is_md: false, size: 0, mtime: 0 },
    ]);
    await loadFolderNode(store, parent, false, true);
    const after = store.get().nodeMap.get(parent)!.children.map((c) => c.name);
    expect(after).toContain("新建文件夹"); // 乐观节点未被清掉
    expect(after).toContain("existing");
  });
  it("listDir 真实枚举到后，乐观节点被真实节点替换（去重）", async () => {
    const store = createTreeStore();
    const parent = "D:/22";
    listDirMock.mockResolvedValueOnce([]);
    await loadFolderNode(store, parent, false);
    addFolderNode(store, parent, "真实");
    listDirMock.mockResolvedValueOnce([
      { name: "真实", path: "D:/22/真实", is_dir: true, is_md: false, size: 0, mtime: 0 },
    ]);
    await loadFolderNode(store, parent, false, true);
    const names = store.get().nodeMap.get(parent)!.children.map((c) => c.name);
    expect(names.filter((n) => n === "真实").length).toBe(1); // 不重复
  });
  it("乐观新建文件在父目录刷新后同样被保留（B-01 文件分支）", async () => {
    const store = createTreeStore();
    const parent = "D:/22";
    listDirMock.mockResolvedValueOnce([]);
    await loadFolderNode(store, parent, false);
    // 乐观插入新文件
    addFileNode(store, parent, "草稿.md", true);
    const before = store.get().nodeMap.get(parent)!.files.map((f) => f.name);
    expect(before).toContain("草稿.md");
    // watcher 刷新：Windows 通知延迟，listDir 暂时未枚举到该文件
    listDirMock.mockResolvedValueOnce([]);
    await loadFolderNode(store, parent, false, true);
    const after = store.get().nodeMap.get(parent)!.files.map((f) => f.name);
    expect(after).toContain("草稿.md"); // 乐观文件未被清掉
    // 真实枚举到后去重（仅一份）
    listDirMock.mockResolvedValueOnce([
      { name: "草稿.md", path: "D:/22/草稿.md", is_dir: false, is_md: true, size: 12, mtime: 99 },
    ]);
    await loadFolderNode(store, parent, false, true);
    const files = store.get().nodeMap.get(parent)!.files;
    expect(files.filter((f) => f.name === "草稿.md").length).toBe(1);
    expect(files.find((f) => f.name === "草稿.md")!.size).toBe(12); // 真实属性覆盖乐观占位
  });
});

describe("P-04 大小写不敏感查找父节点", () => {
  beforeEach(() => listDirMock.mockReset());
  it("父目录 key 大小写不同也能插入乐观节点", async () => {
    const store = createTreeStore();
    // 预置小写父目录
    listDirMock.mockResolvedValueOnce([]);
    await loadFolderNode(store, "d:/work", false);
    // 用大写路径新建子项
    addFolderNode(store, "D:/work", "Sub");
    const children = store.get().nodeMap.get("d:/work")!.children.map((c) => c.name);
    expect(children).toContain("Sub");
  });
});

describe("B-08 空文件夹提示", () => {
  it("已加载且无子项的文件夹渲染空提示行", () => {
    const nodeMap = new Map<string, FileTreeNode>();
    nodeMap.set("D:/22", { name: "22", path: "D:/22", files: [], children: [], loaded: true });
    const out = flatten({
      nodeMap,
      loadState: new Map(),
      rootPaths: ["D:/22"],
      collapsed: new Set(),
      filter: "",
      showHidden: false,
      showNonMd: false,
      assetsDir: "_attachment",
      hiddenPaths: [],
      sort: "name",
      version: 1,
    });
    expect(out.some((n) => n.kind === "hint" && n.name.includes("空文件夹"))).toBe(true);
  });
  it("未加载文件夹不显示空提示（显示加载中）", () => {
    const nodeMap = new Map<string, FileTreeNode>();
    nodeMap.set("D:/22", { name: "22", path: "D:/22", files: [], children: [], loaded: false });
    const out = flatten({
      nodeMap,
      loadState: new Map(),
      rootPaths: ["D:/22"],
      collapsed: new Set(),
      filter: "",
      showHidden: false,
      showNonMd: false,
      assetsDir: "_attachment",
      hiddenPaths: [],
      sort: "name",
      version: 1,
    });
    expect(out.some((n) => n.kind === "hint")).toBe(false);
    expect(out.some((n) => n.kind === "loading")).toBe(true);
  });
});

describe("watcher Create 事件避免覆盖 revealCreated 刚确认的子项", () => {
  beforeEach(() => listDirMock.mockReset());
  it("新建二级文件夹后，watcher 延迟空刷新不会把子文件夹清掉", async () => {
    const store = createTreeStore();
    const root = "D:/111";
    // 1. 加载根目录
    listDirMock.mockResolvedValueOnce([
      { name: "新建文件夹", path: `${root}/新建文件夹`, is_dir: true, is_md: false, size: 0, mtime: 0 },
    ]);
    await loadFolderNode(store, root, false);

    // 2. 在根下新建「一级」并 reveal
    addFolderNode(store, root, "一级");
    listDirMock.mockResolvedValueOnce([
      { name: "新建文件夹", path: `${root}/新建文件夹`, is_dir: true, is_md: false, size: 0, mtime: 0 },
      { name: "一级", path: `${root}/一级`, is_dir: true, is_md: false, size: 0, mtime: 0 },
    ]); // reveal 父目录（root）
    listDirMock.mockResolvedValueOnce([]); // reveal 子目录（一级）本身
    await opsRevealCreated(store, `${root}/一级`);

    // 3. 在「一级」下新建「二级」并 reveal
    addFolderNode(store, `${root}/一级`, "二级");
    listDirMock.mockResolvedValueOnce([
      { name: "二级", path: `${root}/一级/二级`, is_dir: true, is_md: false, size: 0, mtime: 0 },
    ]); // reveal 父目录（一级）
    listDirMock.mockResolvedValueOnce([]); // reveal 子目录（二级）本身
    await opsRevealCreated(store, `${root}/一级/二级`);

    // 4. watcher 300ms 后批量 Create 事件到达；模拟 Windows 通知延迟导致父目录返回空
    listDirMock.mockResolvedValueOnce([]);
    await opsApplyFsChanges(store, [{ path: `${root}/一级/二级`, kind: "create" }]);

    const parent = store.get().nodeMap.get(`${root}/一级`)!;
    expect(parent.loaded).toBe(true);
    expect(parent.children.map((c) => c.name)).toContain("二级");
  });

  it("revealCreated 自身在延迟空刷新下仍保留乐观子节点", async () => {
    const store = createTreeStore();
    const root = "D:/111";
    store.addRoot(root);

    // 1. 加载根目录（含一级文件夹）
    listDirMock.mockResolvedValueOnce([
      { name: "新建文件夹", path: `${root}/新建文件夹`, is_dir: true, is_md: false, size: 0, mtime: 0 },
    ]);
    await loadFolderNode(store, root, false);
    // 2. 加载一级文件夹（空）
    listDirMock.mockResolvedValueOnce([]);
    await loadFolderNode(store, `${root}/新建文件夹`, false);

    // 3. 在一级下新建「二级」（乐观插入）
    addFolderNode(store, `${root}/新建文件夹`, "二级");
    expect(store.get().nodeMap.get(`${root}/新建文件夹`)!.children.map((c) => c.name)).toContain("二级");

    // 4. revealCreated 时父目录 listDir 返回空（Windows 通知延迟）
    listDirMock.mockResolvedValueOnce([]); // reloadFolder(父)
    listDirMock.mockResolvedValueOnce([]); // reloadFolder(子)
    await opsRevealCreated(store, `${root}/新建文件夹/二级`);

    const parent = store.get().nodeMap.get(`${root}/新建文件夹`)!;
    expect(parent.loaded).toBe(true);
    expect(parent.children.map((c) => c.name)).toContain("二级");

    const flat = flatten({ ...store.get(), hiddenPaths: [], assetsDir: "_attachment", version: store.get().version });
    expect(flat.some((n) => n.kind === "folder" && n.path === `${root}/新建文件夹/二级`)).toBe(true);
    // 新建的二级文件夹本身是空的，应显示「（空文件夹）」提示，而不是让父目录误报空。
    expect(flat.some((n) => n.kind === "hint" && n.path.startsWith(`${root}/新建文件夹/二级`))).toBe(true);
    expect(flat.some((n) => n.kind === "hint" && n.path.startsWith(`${root}/新建文件夹\x00`))).toBe(false);
  });

  it("store.addRoot/setRoots 对根路径归一化并去重，避免反斜杠/尾部斜杠导致重复根", () => {
    const store = createTreeStore();
    store.setRoots(["D:\\111\\", "D:/111"]);
    expect(store.get().rootPaths).toEqual(["D:/111"]);
    store.addRoot("D:\\111");
    store.addRoot("D:/222");
    expect(store.get().rootPaths).toEqual(["D:/111", "D:/222"]);
  });
});

describe("重复 key 兜底（移动多次卡死 M-03）", () => {
  it("flatten 对 nodeMap 中同一目录的重复文件只渲染一次，不抛重复 key", () => {
    const dupPath = "C:/Users/manwa/Desktop/111/新建文件夹/新建文件夹/新建文件夹/未命名.md";
    const p1 = "C:/Users/manwa/Desktop/111";
    const p2 = "C:/Users/manwa/Desktop/111/新建文件夹";
    const p3 = "C:/Users/manwa/Desktop/111/新建文件夹/新建文件夹";
    const p4 = "C:/Users/manwa/Desktop/111/新建文件夹/新建文件夹/新建文件夹";
    const nodeMap = new Map<string, FileTreeNode>();
    // 每层目录都注册进 nodeMap（与真实应用一致）
    nodeMap.set(p1, { name: "111", path: p1, loaded: true, files: [], children: [{ name: "新建文件夹", path: p2, loaded: true, files: [], children: [] }] });
    nodeMap.set(p2, { name: "新建文件夹", path: p2, loaded: true, files: [], children: [{ name: "新建文件夹", path: p3, loaded: true, files: [], children: [] }] });
    nodeMap.set(p3, { name: "新建文件夹", path: p3, loaded: true, files: [], children: [{ name: "新建文件夹", path: p4, loaded: true, files: [], children: [] }] });
    nodeMap.set(p4, {
      name: "新建文件夹",
      path: p4,
      loaded: true,
      files: [
        { name: "未命名.md", path: dupPath, isMd: true, size: 0, mtime: 0 },
        { name: "未命名.md", path: dupPath, isMd: true, size: 0, mtime: 0 }, // 重复：来回移动乐观节点残留
      ],
      children: [],
    });
    const out = flatten({
      nodeMap,
      loadState: new Map(),
      rootPaths: [p1],
      collapsed: new Set(),
      filter: "",
      showHidden: false,
      showNonMd: false,
      assetsDir: "_attachment",
      hiddenPaths: [],
      sort: "name",
      version: 1,
    });
    const keys = out.map((n) => n.path + "|" + n.kind);
    const uniqueKeys = new Set(keys);
    expect(uniqueKeys.size).toBe(keys.length); // 无重复 key
    // 该文件仍只出现一次
    expect(keys.filter((k) => k === dupPath + "|file").length).toBe(1);
  });

  it("真实枚举到的文件与乐观占位同名时，loadFolderNode 合并后仅保留一份", async () => {
    const store = createTreeStore();
    const dir = "D:/22/目标";
    // 预置目标目录已加载，含一个乐观残留文件（来回移动遗留）
    store.mutate((st) => {
      const m = new Map(st.nodeMap);
      m.set(dir, {
        name: "目标",
        path: dir,
        loaded: true,
        files: [{ name: "未命名.md", path: `${dir}/未命名.md`, isMd: true, size: 0, mtime: 0, optimistic: true }],
        children: [],
      });
      return { ...st, nodeMap: m };
    });
    // 真实 listDir 已枚举到该文件
    listDirMock.mockResolvedValueOnce([
      { name: "未命名.md", path: `${dir}/未命名.md`, is_dir: false, is_md: true, size: 13, mtime: 100 },
    ]);
    await loadFolderNode(store, dir, false, true);
    const files = store.get().nodeMap.get(dir)!.files;
    expect(files.filter((f) => f.name === "未命名.md").length).toBe(1);
    expect(files[0].size).toBe(13); // 真实属性覆盖乐观占位
  });

  it("migrateCollapsed：目录移动后折叠态 key 整体迁移到新路径", () => {
    const store = createTreeStore();
    const oldDir = "C:/a/old";
    const newDir = "C:/a/b/new";
    store.mutate((s) => ({ ...s, collapsed: new Set([oldDir, `${oldDir}/sub1`, `${oldDir}/sub2/x`]) }));
    store.migrateCollapsedForMove(oldDir, newDir);
    const c: Set<string> = store.get().collapsed;
    expect(c.has(newDir)).toBe(true);
    expect(c.has(`${newDir}/sub1`)).toBe(true);
    expect(c.has(`${newDir}/sub2/x`)).toBe(true);
    // 其他无关 key 不受影响
    expect(c.has("C:/a/other")).toBe(false);
  });

  it("migrateCollapsed：非前缀 key 保持不变", () => {
    const src = new Set(["C:/x/y", "C:/x/yy", "C:/z"]);
    const out = migrateCollapsed(src, "C:/x/y", "C:/m/n");
    expect(out.has("C:/m/n")).toBe(true);
    expect(out.has("C:/x/yy")).toBe(true); // 仅等长、非前缀
    expect(out.has("C:/z")).toBe(true);
  });
});
