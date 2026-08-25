// revealCreated / applyFsChanges 集成测试：复现「新建文件夹后无法访问 / 新建项不显示」场景
import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadFolderNode, revealCreated, applyFsChanges, reloadFolder } from "../filetree/ops";
import { createTreeStore } from "../filetree/store";
import { flatten } from "../filetree/flatten";
import type { DirItem } from "../fs";

vi.mock("../fs", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../fs")>();
  return { ...orig, listDir: vi.fn() };
});

import { listDir } from "../fs";
const listDirMock = vi.mocked(listDir);

function item(name: string, path: string, is_dir: boolean): DirItem {
  return { name, path, is_dir, is_md: !is_dir && name.endsWith(".md"), hidden: false, size: 1, mtime: 1 };
}

/** 构造：Desktop 已加载（含 sub 壳），11 也是根 */
function mkStore() {
  const store = createTreeStore();
  store.mutate((s) => ({
    ...s,
    nodeMap: new Map([
      ["C:/Desktop", { name: "Desktop", path: "C:/Desktop", loaded: true, files: [], children: [{ name: "sub", path: "C:/Desktop/sub", files: [], children: [], loaded: false }] }],
      ["C:/Desktop/sub", { name: "sub", path: "C:/Desktop/sub", files: [], children: [], loaded: false }],
    ]),
    loadState: new Map(),
    rootPaths: ["C:/Desktop"],
  }));
  return store;
}

let flatVersion = 100;
function flatNames(store: ReturnType<typeof mkStore>) {
  const s = store.get();
  // version 递增绕过 flatten 模块级 memo（memo 键不含 nodeMap 内容，测试间需隔离）
  return flatten({
    nodeMap: s.nodeMap, loadState: s.loadState, rootPaths: s.rootPaths,
    collapsed: s.collapsed, filter: s.filter, showHidden: s.showHidden,
    showNonMd: s.showNonMd, assetsDir: "_attachment", hiddenPaths: [], sort: s.sort, version: ++flatVersion,
  }).map((n) => n.name);
}

describe("新建文件夹后 revealCreated", () => {
  beforeEach(() => {
    listDirMock.mockReset();
    listDirMock.mockImplementation(async (dir: string) => {
      // 默认：子目录都是空目录
      return [];
    });
  });

  it("新建后刷新父目录，新建项出现在树中且无加载中残留", async () => {
    const store = mkStore();
    // 磁盘上已有新建文件夹；其内部为空
    listDirMock.mockImplementation(async (dir: string) => {
      if (dir === "C:/Desktop") {
        return [
          item("sub", "C:/Desktop/sub", true),
          item("新建文件夹", "C:/Desktop/新建文件夹", true),
        ];
      }
      return [];
    });
    await revealCreated(store, "C:/Desktop/新建文件夹");
    const names = flatNames(store);
    expect(names).toContain("新建文件夹");
    // 无 error 行
    expect(names).not.toContain("无法访问");
    // 新建文件夹已被立即加载（listDir 被调用过）；sub 仍是未加载壳（显示加载中属预期）
    expect(listDirMock).toHaveBeenCalledWith("C:/Desktop/新建文件夹", false);
  });

  it("watcher 事件与 revealCreated 竞态：最终新建项可见且无无法访问", async () => {
    const store = mkStore();
    // listDir 延迟模拟慢 IO，制造并发窗口
    listDirMock.mockImplementation(async (dir: string) => {
      await new Promise((r) => setTimeout(r, 10));
      if (dir === "C:/Desktop") {
        return [
          item("sub", "C:/Desktop/sub", true),
          item("新建文件夹", "C:/Desktop/新建文件夹", true),
        ];
      }
      return [];
    });
    // watcher 先触发（Create 事件），revealCreated 后触发
    const watcherP = applyFsChanges(store, [{ path: "C:/Desktop/新建文件夹", kind: "create" }]);
    const revealP = revealCreated(store, "C:/Desktop/新建文件夹");
    await Promise.all([watcherP, revealP]);

    const names = flatNames(store);
    expect(names).toContain("新建文件夹");
    expect(names).not.toContain("无法访问");
  });

  it("新建在未加载目录下：先加载父目录再显示", async () => {
    const store = mkStore();
    listDirMock.mockImplementation(async (dir: string) => {
      if (dir === "C:/Desktop/sub") {
        return [item("new.md", "C:/Desktop/sub/new.md", false)];
      }
      return [];
    });
    // 在未加载的 sub 下新建文件
    await revealCreated(store, "C:/Desktop/sub/new.md");
    const names = flatNames(store);
    expect(names).toContain("sub");
    expect(names).toContain("new.md");
    expect(names).not.toContain("无法访问");
  });

  it("父目录被删除后刷新：目录不存在时显示无法访问（预期行为，非崩溃）", async () => {
    const store = mkStore();
    // 目录被外部删除：listDir 失败
    listDirMock.mockRejectedValue(new Error("路径不是文件夹或不存在"));
    await reloadFolder(store, "C:/Desktop/sub", false);
    const names = flatNames(store);
    expect(names).toContain("sub");
    expect(names).toContain("无法访问");
    // 重试恢复：目录回来了
    listDirMock.mockReset();
    listDirMock.mockResolvedValue([item("sub.md", "C:/Desktop/sub/sub.md", false)]);
    await reloadFolder(store, "C:/Desktop/sub", false);
    const names2 = flatNames(store);
    expect(names2).toContain("sub.md");
    expect(names2).not.toContain("无法访问");
  });
});

describe("applyFsChanges 事件处理", () => {
  beforeEach(() => {
    listDirMock.mockReset();
    listDirMock.mockImplementation(async () => []);
  });

  it("只刷新受影响的已加载目录", async () => {
    const store = mkStore();
    listDirMock.mockImplementation(async (dir: string) => {
      if (dir === "C:/Desktop") {
        return [
          item("sub", "C:/Desktop/sub", true),
          item("外部新增.md", "C:/Desktop/外部新增.md", false),
        ];
      }
      return [];
    });
    await applyFsChanges(store, [
      { path: "C:/Desktop/外部新增.md", kind: "create" },
      { path: "C:/Desktop/sub/内部文件.md", kind: "create" },
    ]);
    // Desktop 被刷新（包含外部新增），sub 未加载不刷新
    const names = flatNames(store);
    expect(names).toContain("外部新增.md");
    expect(listDirMock).toHaveBeenCalledWith("C:/Desktop", false);
    // sub 是未加载壳，不应触发 listDir(sub)
    expect(listDirMock).not.toHaveBeenCalledWith("C:/Desktop/sub", false);
  });

  it("变更路径是根时刷新该根；根已删除则显示无法访问", async () => {
    const store = mkStore();
    // 显式实现抛错（mockRejectedValue 存在跨用例状态泄漏风险）
    listDirMock.mockImplementation(async () => {
      throw new Error("根不存在");
    });
    // 根被删除：Remove 事件 p = 根路径
    await applyFsChanges(store, [{ path: "C:/Desktop", kind: "remove" }]);
    const names = flatNames(store);
    // 根行仍显示（壳），子行显示无法访问
    expect(names[0]).toBe("Desktop");
    expect(names).toContain("无法访问");
  });
});
