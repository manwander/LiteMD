// 树中定位（FEAT-4）：展开目标路径的所有祖先目录、加载未加载层，
// 使目标行出现在 flat 列表中，供虚拟滚动滚动到该行。
import { loadFolderNode } from "./ops";
import type { TreeStore } from "./store";
import { ancestorDirs, isUnder, normPath } from "./types";

/**
 * 确保 path 在树中可见：找到所属根 → 展开祖先链 → 加载未加载层。
 * 返回 true 表示已就绪（调用方随后用 flatten 找行号并 scrollToIndex）。
 */
export async function ensureVisible(store: TreeStore, path: string): Promise<boolean> {
  const np = normPath(path);
  const s0 = store.get();
  const root = s0.rootPaths.find((r) => isUnder(np, r));
  if (!root) return false;

  const dirs = ancestorDirs(np, root);
  const chain = [normPath(root), ...dirs];

  // 1) 确保 chain 各级已加载（未加载则 list_dir）
  for (const d of chain) {
    const st = store.get();
    const node = st.nodeMap.get(d);
    if (!node || !node.loaded) {
      if (!st.loadState.get(d)?.loading) {
        await loadFolderNode(store, d, st.showHidden);
      } else {
        // 加载中：等待该层加载完成（轮询最多 2s）
        await waitLoaded(store, d, 2000);
      }
    }
  }
  // 2) 展开 chain（从 collapsed 移除），使目标行可见
  store.mutate((s) => {
    const next = new Set(s.collapsed);
    for (const d of chain) next.delete(d);
    return { ...s, collapsed: next };
  });
  return true;
}

function waitLoaded(store: TreeStore, path: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      const st = store.get();
      const node = st.nodeMap.get(path);
      if ((node && node.loaded) || !st.loadState.get(path)?.loading) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(timer);
        resolve();
      }
    }, 50);
  });
}
