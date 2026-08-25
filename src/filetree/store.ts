// 文件树状态仓库（Svelte 4 writable store）。
// 替代旧 App.svelte 的分散变量（nodeMap/loadState/rootPaths/collapsed/filter/showHidden）：
// - 所有变更走统一 mutate()，版本号自增，flatten 的 memo 据此失效（修 C-03/C-04/C-05）
// - 纯前端状态，不持有 IO；加载/操作逻辑在 ops.ts
import { writable } from "svelte/store";
import { normPath } from "./types";
import type { FileTreeNode, LoadState, TreeSortKey } from "./types";

export interface TreeState {
  nodeMap: Map<string, FileTreeNode>;
  loadState: Map<string, LoadState>;
  rootPaths: string[];
  collapsed: Set<string>;
  filter: string;
  showHidden: boolean;
  showNonMd: boolean;
  sort: TreeSortKey;
  version: number;
}

/**
 * 目录移动/重命名后，把折叠态集合里以 oldPath 为前缀的 key 整体迁移到 newPath。
 * 否则 rename/move 后旧路径 key 残留、新路径不折叠，导致折叠状态错位（Phase 3 状态一致性）。
 */
export function migrateCollapsed(collapsed: Set<string>, oldPath: string, newPath: string): Set<string> {
  const o = normPath(oldPath);
  const n = normPath(newPath);
  if (o === n) return collapsed;
  const next = new Set<string>();
  for (const c of collapsed) {
    if (c === o) next.add(n);
    else if (c.startsWith(o + "/")) next.add(n + c.slice(o.length));
    else next.add(c);
  }
  return next;
}

export function createTreeStore(initial: Partial<TreeState> = {}) {
  const { subscribe, update } = writable<TreeState>({
    nodeMap: new Map(),
    loadState: new Map(),
    rootPaths: [],
    collapsed: new Set(),
    filter: "",
    showHidden: false,
    showNonMd: false,
    sort: "name",
    version: 0,
    ...initial,
  });

  /** 统一变更入口：fn 修改 state，返回后版本号自增（一次更新 = 一次通知 + 一次 memo 失效） */
  function mutate(fn: (s: TreeState) => TreeState) {
    update((s) => {
      const next = fn(s);
      return next === s ? s : { ...next, version: next.version + 1 };
    });
  }

  return {
    subscribe,
    get(): TreeState {
      let s!: TreeState;
      subscribe((v) => (s = v))();
      return s;
    },
    mutate,
    // ---- 目录数据 ----
    setNode(path: string, node: FileTreeNode) {
      mutate((s) => ({ ...s, nodeMap: new Map(s.nodeMap).set(path, node) }));
    },
    deleteNode(path: string) {
      mutate((s) => {
        const m = new Map(s.nodeMap);
        m.delete(path);
        return { ...s, nodeMap: m };
      });
    },
    setLoadState(path: string, ls: LoadState) {
      mutate((s) => ({ ...s, loadState: new Map(s.loadState).set(path, ls) }));
    },
    clearLoadState() {
      mutate((s) => ({ ...s, loadState: new Map() }));
    },
    // ---- 根目录 ----
    setRoots(roots: string[]) {
      const nr = [...new Set(roots.map(normPath))];
      mutate((s) => ({ ...s, rootPaths: nr }));
    },
    addRoot(path: string) {
      const np = normPath(path);
      mutate((s) => {
        const roots = s.rootPaths.map(normPath);
        if (roots.includes(np)) return s;
        return { ...s, rootPaths: [...s.rootPaths, np] };
      });
    },
    removeRoot(path: string) {
      const np = normPath(path);
      mutate((s) => ({
        ...s,
        rootPaths: s.rootPaths.filter((p) => normPath(p) !== np),
      }));
    },
    // ---- 折叠 / 过滤 / 排序 / 显示 ----
    toggleCollapsed(path: string) {
      const np = normPath(path);
      mutate((s) => {
        const next = new Set(s.collapsed);
        if (next.has(np)) next.delete(np);
        else next.add(np);
        return { ...s, collapsed: next };
      });
    },
    setCollapsed(collapsed: Set<string>) {
      mutate((s) => ({ ...s, collapsed: new Set([...collapsed].map(normPath)) }));
    },
    collapseAll() {
      mutate((s) => {
        // 折叠所有已加载目录（保留根）
        const rootSet = new Set(s.rootPaths.map(normPath));
        const next = new Set<string>();
        for (const p of s.nodeMap.keys()) {
          if (!rootSet.has(normPath(p))) next.add(normPath(p));
        }
        return { ...s, collapsed: next };
      });
    },
    expandAll() {
      mutate((s) => ({ ...s, collapsed: new Set() }));
    },
    setFilter(filter: string) {
      mutate((s) => ({ ...s, filter }));
    },
    setSort(sort: TreeSortKey) {
      mutate((s) => ({ ...s, sort }));
    },
    setShowHidden(v: boolean) {
      mutate((s) => ({ ...s, showHidden: v }));
    },
    setShowNonMd(v: boolean) {
      mutate((s) => ({ ...s, showNonMd: v }));
    },
    // 目录移动/重命名后迁移折叠态，避免折叠 key 陈旧错位
    migrateCollapsedForMove(oldPath: string, newPath: string) {
      mutate((s) => {
        const next = migrateCollapsed(s.collapsed, oldPath, newPath);
        return next === s.collapsed ? s : { ...s, collapsed: next };
      });
    },
    // 加载期间锁定过滤（remote 搜索进行中不打断用户输入）
    replaceState(next: Partial<TreeState>) {
      mutate((s) => ({ ...s, ...next }));
    },
  };
}

export type TreeStore = ReturnType<typeof createTreeStore>;
