// ops（目录 IO 操作）单测：mock fs 层，验证状态写入 store 的正确性
import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadFolderNode, reloadFolder, refreshFolderOf, applyFsChanges, refreshTree } from "../filetree/ops";
import { createTreeStore } from "../filetree/store";
import type { DirItem } from "../fs";

vi.mock("../fs", () => ({
  listDir: vi.fn(),
}));

import { listDir } from "../fs";
const listDirMock = vi.mocked(listDir);

function dirItem(partial: Partial<DirItem> & { name: string; path: string }): DirItem {
  return {
    is_dir: false,
    is_md: false,
    hidden: false,
    size: 0,
    mtime: 0,
    ...partial,
  };
}

describe("loadFolderNode", () => {
  beforeEach(() => {
    listDirMock.mockReset();
  });

  it("写入节点并把子文件夹壳加入 nodeMap（懒加载多级树的根基）", async () => {
    listDirMock.mockResolvedValue([
      dirItem({ name: "sub", path: "C:/a/sub", is_dir: true }),
      dirItem({ name: "a.md", path: "C:/a/a.md", is_md: true, size: 10, mtime: 5 }),
      dirItem({ name: "pic.png", path: "C:/a/pic.png", is_md: false, size: 20, mtime: 6 }),
    ]);
    const store = createTreeStore();
    await loadFolderNode(store, "C:\\a", false);

    const s = store.get();
    const node = s.nodeMap.get("C:/a");
    expect(node?.loaded).toBe(true);
    expect(node?.files.map((f) => f.name)).toEqual(["a.md", "pic.png"]);
    expect(node?.files[0].isMd).toBe(true);
    expect(node?.files[0].size).toBe(10);
    // 关键：子文件夹壳写入 nodeMap
    const subShell = s.nodeMap.get("C:/a/sub");
    expect(subShell).toBeDefined();
    expect(subShell?.loaded).toBe(false);
    expect(s.loadState.get("C:/a")?.loading).toBe(false);
    expect(s.loadState.get("C:/a")?.error).toBeNull();
    // 版本号递增（memo 失效）
    expect(s.version).toBeGreaterThan(0);
  });

  it("加载失败时保留壳节点并记录错误（不抛给调用方）", async () => {
    listDirMock.mockRejectedValue(new Error("权限不足"));
    const store = createTreeStore();
    await loadFolderNode(store, "C:/a", false);

    const s = store.get();
    const node = s.nodeMap.get("C:/a");
    expect(node).toBeDefined();
    expect(node?.loaded).toBe(false);
    expect(s.loadState.get("C:/a")?.error).toContain("权限不足");
  });

  it("重复调用不重复加载（loading 中跳过）", async () => {
    let calls = 0;
    listDirMock.mockImplementation(async () => {
      calls++;
      return [];
    });
    const store = createTreeStore();
    // 先手动置 loading
    store.setLoadState("C:/a", { loading: true, error: null });
    await loadFolderNode(store, "C:/a", false);
    expect(calls).toBe(0);
  });

  it("并发加载同目录时只有最新请求的结果落地（W5 代际保护）", async () => {
    let resolveFirst!: (v: DirItem[]) => void;
    let resolveSecond!: (v: DirItem[]) => void;
    const first = new Promise<DirItem[]>((r) => (resolveFirst = r));
    const second = new Promise<DirItem[]>((r) => (resolveSecond = r));
    listDirMock.mockImplementationOnce(() => first).mockImplementationOnce(() => second);
    const store = createTreeStore();
    const p1 = loadFolderNode(store, "C:/a", false);
    const p2 = reloadFolder(store, "C:/a", false); // force：第二次请求

    // 后发先至：新结果先落地，随后旧结果才返回——不得覆盖新结果
    resolveSecond([dirItem({ name: "new.md", path: "C:/a/new.md", is_md: true })]);
    await p2;
    resolveFirst([dirItem({ name: "old.md", path: "C:/a/old.md", is_md: true })]);
    await p1;

    const node = store.get().nodeMap.get("C:/a");
    expect(node?.files.map((f) => f.name)).toEqual(["new.md"]);
    expect(store.get().loadState.get("C:/a")?.loading).toBe(false);
  });
});

describe("refreshTree 全树刷新", () => {
  beforeEach(() => {
    listDirMock.mockReset();
  });

  it("重载根层的同时也重载此前已展开的深层目录（W5）", async () => {
    listDirMock.mockImplementation(async (dir: string) => {
      if (dir === "C:/a") {
        return [
          dirItem({ name: "sub", path: "C:/a/sub", is_dir: true }),
          dirItem({ name: "root.md", path: "C:/a/root.md", is_md: true }),
        ];
      }
      if (dir === "C:/a/sub") {
        return [dirItem({ name: "old.md", path: "C:/a/sub/old.md", is_md: true })];
      }
      return [];
    });
    const store = createTreeStore();
    store.setRoots(["C:/a"]);
    await loadFolderNode(store, "C:/a", false);
    await loadFolderNode(store, "C:/a/sub", false);

    // 磁盘变化：根新增文件、深层子目录新增文件
    listDirMock.mockImplementation(async (dir: string) => {
      if (dir === "C:/a") {
        return [
          dirItem({ name: "sub", path: "C:/a/sub", is_dir: true }),
          dirItem({ name: "root.md", path: "C:/a/root.md", is_md: true }),
          dirItem({ name: "new.md", path: "C:/a/new.md", is_md: true }),
        ];
      }
      if (dir === "C:/a/sub") {
        return [
          dirItem({ name: "old.md", path: "C:/a/sub/old.md", is_md: true }),
          dirItem({ name: "deep.md", path: "C:/a/sub/deep.md", is_md: true }),
        ];
      }
      return [];
    });
    await refreshTree(store, false);

    const s = store.get();
    expect(s.nodeMap.get("C:/a")?.files.map((f) => f.name).sort()).toEqual(["new.md", "root.md"]);
    // 深层已展开目录必须同步刷新，而不是继续显示旧内容
    expect(s.nodeMap.get("C:/a/sub")?.files.map((f) => f.name).sort()).toEqual(["deep.md", "old.md"]);
  });
});

describe("applyFsChanges 多路径 rename", () => {
  beforeEach(() => {
    listDirMock.mockReset();
  });

  it("rename 同时刷新旧/新路径所在目录（跨目录移动条目立即可见）", async () => {
    listDirMock.mockImplementation(async (dir: string) => {
      if (dir === "C:/a") return [dirItem({ name: "x.md", path: "C:/a/x.md", is_md: true })];
      if (dir === "C:/b") return [dirItem({ name: "x.md", path: "C:/b/x.md", is_md: true })];
      return [];
    });
    const store = createTreeStore();
    store.mutate((s) => ({ ...s, rootPaths: ["C:/a", "C:/b"] }));
    await loadFolderNode(store, "C:/a", false);
    await loadFolderNode(store, "C:/b", false);

    listDirMock.mockClear();
    listDirMock.mockImplementation(async (dir: string) => {
      if (dir === "C:/a") return [];
      if (dir === "C:/b") return [dirItem({ name: "x.md", path: "C:/b/x.md", is_md: true })];
      return [];
    });
    await applyFsChanges(store, [
      { path: "C:/a/x.md", paths: ["C:/a/x.md", "C:/b/x.md"], kind: "rename" },
    ]);

    expect(listDirMock).toHaveBeenCalledWith("C:/a", false);
    expect(listDirMock).toHaveBeenCalledWith("C:/b", false);
  });

  it("无 paths 字段时回退到 path（兼容旧 payload）", async () => {
    listDirMock.mockImplementation(async (dir: string) => {
      if (dir === "C:/a") return [dirItem({ name: "x.md", path: "C:/a/x.md", is_md: true })];
      return [];
    });
    const store = createTreeStore();
    store.mutate((s) => ({ ...s, rootPaths: ["C:/a"] }));
    await loadFolderNode(store, "C:/a", false);

    listDirMock.mockClear();
    await applyFsChanges(store, [{ path: "C:/a/x.md", kind: "remove" }]);
    expect(listDirMock).toHaveBeenCalledWith("C:/a", false);
  });
});

describe("reloadFolder / refreshFolderOf", () => {
  beforeEach(() => {
    listDirMock.mockReset();
  });

  it("reloadFolder 删除旧缓存后重新列举", async () => {
    listDirMock.mockResolvedValue([
      dirItem({ name: "a.md", path: "C:/a/a.md", is_md: true }),
    ]);
    const store = createTreeStore();
    await loadFolderNode(store, "C:/a", false);

    listDirMock.mockResolvedValue([
      dirItem({ name: "a.md", path: "C:/a/a.md", is_md: true }),
      dirItem({ name: "b.md", path: "C:/a/b.md", is_md: true }),
    ]);
    await reloadFolder(store, "C:/a", false);
    const node = store.get().nodeMap.get("C:/a");
    expect(node?.files.map((f) => f.name)).toEqual(["a.md", "b.md"]);
  });

  it("refreshFolderOf 刷新父目录", async () => {
    listDirMock.mockResolvedValue([
      dirItem({ name: "f.md", path: "C:/a/sub/f.md", is_md: true }),
    ]);
    const store = createTreeStore();
    await loadFolderNode(store, "C:/a/sub", false);

    listDirMock.mockClear();
    await refreshFolderOf(store, "C:/a/sub/f.md", false);
    expect(listDirMock).toHaveBeenCalledWith("C:/a/sub", false);
  });
});
