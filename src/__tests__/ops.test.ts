// ops（目录 IO 操作）单测：mock fs 层，验证状态写入 store 的正确性
import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadFolderNode, reloadFolder, refreshFolderOf } from "../filetree/ops";
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
