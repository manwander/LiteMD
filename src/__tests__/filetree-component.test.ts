// FileTree 组件冒烟测试：在 jsdom 中真实挂载组件，
// 复现「嵌套根导致 keyed each 重复 key 崩溃」与「树形缩进」。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { tick } from "svelte";
import FileTree from "../FileTree.svelte";
import { createTreeStore } from "../filetree/store";
import type { TreeHandlers } from "../filetree/types";
import { listDir } from "../fs";

vi.mock("../fs", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../fs")>();
  return {
    ...orig,
    listDir: vi.fn(async (dir: string) => {
      if (dir === "C:/Users/manwa/Desktop") {
        return [
          { name: "sub", path: "C:/Users/manwa/Desktop/sub", is_dir: true, is_md: false, hidden: false, size: 0, mtime: 0 },
          { name: "a.md", path: "C:/Users/manwa/Desktop/a.md", is_dir: false, is_md: true, hidden: false, size: 10, mtime: 1 },
        ];
      }
      if (dir === "C:/Users/manwa/Desktop/sub") {
        return [
          { name: "c.md", path: "C:/Users/manwa/Desktop/sub/c.md", is_dir: false, is_md: true, hidden: false, size: 5, mtime: 2 },
        ];
      }
      if (dir === "C:/Users/manwa/Desktop/新建文件夹") {
        return [
          { name: "2", path: "C:/Users/manwa/Desktop/新建文件夹/2", is_dir: true, is_md: false, hidden: false, size: 0, mtime: 0 },
          { name: "未命名.md", path: "C:/Users/manwa/Desktop/新建文件夹/未命名.md", is_dir: false, is_md: true, hidden: false, size: 10, mtime: 1 },
        ];
      }
      if (dir === "C:/Users/manwa/Desktop/新建文件夹/2") {
        return [
          { name: "inner.md", path: "C:/Users/manwa/Desktop/新建文件夹/2/inner.md", is_dir: false, is_md: true, hidden: false, size: 5, mtime: 2 },
        ];
      }
      return [];
    }),
  };
});

function makeHandlers(): TreeHandlers {
  return {
    openFile: vi.fn(),
    setStatus: vi.fn(),
    confirm: vi.fn().mockResolvedValue(true),
    prompt: vi.fn().mockResolvedValue(null),
    pickFolder: vi.fn().mockResolvedValue(null),
    onTabRenamed: vi.fn(),
    onTabRemoved: vi.fn(),
    setHiddenPaths: vi.fn(),
    setTreePrefs: vi.fn(),
    onRootsChanged: vi.fn(),
  };
}

/** 构造嵌套根数据：Desktop 是根，Desktop/11 也是根（11 未加载）；sub 已加载含 c.md */
function mountNestedRoots() {
  const store = createTreeStore();
  store.mutate((s) => ({
    ...s,
    nodeMap: new Map([
      ["C:/Users/manwa/Desktop", {
        name: "Desktop", path: "C:/Users/manwa/Desktop", loaded: true,
        files: [{ name: "a.md", path: "C:/Users/manwa/Desktop/a.md", isMd: true, size: 10, mtime: 1 }],
        children: [
          { name: "11", path: "C:/Users/manwa/Desktop/11", files: [], children: [], loaded: false },
          { name: "sub", path: "C:/Users/manwa/Desktop/sub", files: [{ name: "c.md", path: "C:/Users/manwa/Desktop/sub/c.md", isMd: true, size: 5, mtime: 2 }], children: [], loaded: true },
        ],
      }],
      ["C:/Users/manwa/Desktop/11", { name: "11", path: "C:/Users/manwa/Desktop/11", files: [], children: [], loaded: false }],
      ["C:/Users/manwa/Desktop/sub", { name: "sub", path: "C:/Users/manwa/Desktop/sub", files: [{ name: "c.md", path: "C:/Users/manwa/Desktop/sub/c.md", isMd: true, size: 5, mtime: 2 }], children: [], loaded: true }],
    ]),
    loadState: new Map(),
    rootPaths: ["C:/Users/manwa/Desktop", "C:/Users/manwa/Desktop/11"],
  }));
  const target = document.createElement("div");
  document.body.appendChild(target);
  const comp = new FileTree({
    target,
    props: {
      store,
      sidebarWidth: 240,
      currentPath: null,
      defaultDir: null,
      hiddenPaths: [],
      handlers: makeHandlers(),
    },
  });
  return { comp, target, store };
}

describe("FileTree 组件挂载", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("嵌套根 + 未加载目录不崩溃，且 11 只渲染一次", async () => {
    const { target } = mountNestedRoots();
    // 同步渲染（onMount 的 reloadAllLoaded 是异步的，此时仍是初始数据）
    const lis = target.querySelectorAll("li");
    expect(lis.length).toBeGreaterThan(0);
    // 11 目录行只出现一次
    const eleven = [...lis].filter((li) => li.textContent?.includes("11"));
    expect(eleven.length).toBe(1);
    // 根行存在
    expect([...lis].some((li) => li.textContent?.includes("Desktop"))).toBe(true);
    // 无 loading 崩溃：组件挂载成功（未抛错）即通过
  });

  it("多级树形缩进：depth 越大 padding-left 越大", () => {
    // 同步渲染阶段断言（初始数据已含完整已加载层级；reloadAllLoaded 异步执行不影响初始 DOM）
    const { target } = mountNestedRoots();
    const lis = [...target.querySelectorAll("li")];
    const padOf = (text: string) => {
      const li = lis.find((l) => l.textContent?.includes(text));
      return li ? parseInt(li.style.paddingLeft || "0", 10) : NaN;
    };
    const pDesktop = padOf("Desktop");
    const pSub = padOf("sub");
    const pC = padOf("c.md");
    // 根行缩进最小，子目录更大，文件最大（6 + depth*18）
    expect(pDesktop).toBe(6);
    expect(pSub).toBe(24); // depth 1
    expect(pC).toBe(42); // depth 2
    expect(pSub).toBeGreaterThan(pDesktop);
    expect(pC).toBeGreaterThan(pSub);
  });

  it("空工作区显示空态", () => {
    const store = createTreeStore();
    const target = document.createElement("div");
    document.body.appendChild(target);
    new FileTree({
      target,
      props: {
        store,
        sidebarWidth: 240,
        currentPath: null,
        defaultDir: null,
        hiddenPaths: [],
        handlers: makeHandlers(),
      },
    });
    expect(target.textContent).toContain("尚未打开文件夹");
  });

  it("hiddenPaths 为 undefined 时不崩溃（防御 .some 类型错误）", () => {
    const store = createTreeStore();
    store.mutate((s) => ({
      ...s,
      nodeMap: new Map([
        ["C:/a", {
          name: "a", path: "C:/a", loaded: true,
          files: [{ name: "x.md", path: "C:/a/x.md", isMd: true, size: 1, mtime: 1 }],
          children: [],
        }],
      ]),
      rootPaths: ["C:/a"],
    }));
    const target = document.createElement("div");
    document.body.appendChild(target);
    new FileTree({
      target,
      props: {
        store,
        sidebarWidth: 240,
        currentPath: null,
        defaultDir: null,
        hiddenPaths: undefined as unknown as string[],
        handlers: makeHandlers(),
      },
    });
    // 正常渲染出文件行，无 TypeError
    expect([...target.querySelectorAll("li")].some((li) => li.textContent?.includes("x.md"))).toBe(true);
  });

  it("默认展开未加载子文件夹时自动加载（避免添加根目录后持续显示“加载中”）", async () => {
    const store = createTreeStore();
    store.mutate((s) => ({
      ...s,
      nodeMap: new Map([
        ["C:/Users/manwa/Desktop/新建文件夹", {
          name: "新建文件夹", path: "C:/Users/manwa/Desktop/新建文件夹", loaded: true,
          files: [{ name: "未命名.md", path: "C:/Users/manwa/Desktop/新建文件夹/未命名.md", isMd: true, size: 10, mtime: 1 }],
          children: [
            { name: "2", path: "C:/Users/manwa/Desktop/新建文件夹/2", files: [], children: [], loaded: false },
          ],
        }],
        ["C:/Users/manwa/Desktop/新建文件夹/2", { name: "2", path: "C:/Users/manwa/Desktop/新建文件夹/2", files: [], children: [], loaded: false }],
      ]),
      loadState: new Map(),
      rootPaths: ["C:/Users/manwa/Desktop/新建文件夹"],
      collapsed: new Set(),
    }));
    const target = document.createElement("div");
    document.body.appendChild(target);
    const listDirMock = vi.mocked(listDir);
    listDirMock.mockClear();
    new FileTree({
      target,
      props: {
        store,
        sidebarWidth: 240,
        currentPath: null,
        defaultDir: null,
        hiddenPaths: [],
        handlers: makeHandlers(),
      },
    });
    // 等待响应式 auto-load 异步触发 list_dir
    await tick();
    await new Promise((r) => setTimeout(r, 200));
    await tick();
    expect(listDirMock).toHaveBeenCalledWith("C:/Users/manwa/Desktop/新建文件夹/2", false);
    expect(target.textContent).not.toContain("加载中");
  });
});
