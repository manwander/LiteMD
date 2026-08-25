// 文件树目录 IO 操作（依赖 fs.ts 的 Tauri 命令，状态写入 store）。
// 与旧 App.svelte 的 loadFolderNode/reloadFolder/refreshTree 对应，行为保持一致。
import { listDir } from "../fs";
import type { TreeState, TreeStore } from "./store";
import { baseName, normPath, parentDir, type FileTreeNode } from "./types";
import type { FsChange } from "./watcher";

/** 大小写不敏感查找 nodeMap 中的规范 key（Windows 路径大小写不敏感，避免 key 不一致导致重复写） */
function resolveNodeKey(nodeMap: Map<string, FileTreeNode>, path: string): string | null {
  const np = normPath(path);
  if (nodeMap.has(np)) return np;
  for (const k of nodeMap.keys()) {
    if (k.toLowerCase() === np.toLowerCase()) return k;
  }
  return null;
}

/** 从 listDir 原始结果构造 files / children。
 * 合并旧节点中的「乐观子节点」——这些节点由新建/移动乐观插入、尚在 Windows 通知延迟窗口内
 * 未被 listDir 枚举到；若不保留，watcher 的 reloadFolder 会把刚新建的项覆盖掉（B-01）。 */
function buildNodeContent(
  store: TreeStore,
  np: string,
  rawItems: { name: string; path: string; is_dir: boolean; is_md: boolean; size: number; mtime: number }[]
): { files: FileTreeNode["files"]; children: FileTreeNode["children"] } {
  const items = rawItems.map((i) => ({ ...i, path: normPath(i.path) }));
  const freshFilePaths = new Set(
    items.filter((i) => !i.is_dir).map((i) => i.path)
  );
  const files = items
    .filter((i) => !i.is_dir)
    .map((i) => ({ name: i.name, path: i.path, isMd: i.is_md, size: i.size, mtime: i.mtime }));
  const freshChildPaths = new Set(
    items.filter((i) => i.is_dir).map((i) => i.path)
  );
  const children: FileTreeNode[] = items
    .filter((i) => i.is_dir)
    .map((i): FileTreeNode => {
      // 保留已加载子文件夹的 loaded 状态，避免重置为 false 导致显示"加载中…"
      const existing = store.get().nodeMap.get(i.path);
      return { name: i.name, path: i.path, files: [], children: [], loaded: existing?.loaded ?? false };
    });
  // 合并乐观节点（不在本次 listDir 结果中的旧乐观 child/file）——对抗 Windows 通知延迟窗口，
  // 否则 watcher/reveal 的 reloadFolder 会把刚新建的项覆盖掉（B-01，文件夹与文件均覆盖）。
  const oldNode = store.get().nodeMap.get(np);
  if (oldNode) {
    for (const old of oldNode.children) {
      if (old.optimistic && !freshChildPaths.has(normPath(old.path))) {
        children.push({ ...old, optimistic: true });
      }
    }
    for (const old of oldNode.files) {
      if (old.optimistic && !freshFilePaths.has(normPath(old.path))) {
        files.push({ ...old });
      }
    }
  }
  // 去重：按路径移除重复项（optimisticMove 残留 / 合并乐观节点与真实枚举重叠时），
  // 否则同一目录出现两条相同 path 会在 flatten 后让 keyed-each 抛重复 key 并卡死。
  const childSeen = new Set<string>();
  const dedupChildren = children.filter((c) => {
    const k = normPath(c.path);
    if (childSeen.has(k)) return false;
    childSeen.add(k);
    return true;
  });
  const fileSeen = new Set<string>();
  const dedupFiles = files.filter((f) => {
    const k = normPath(f.path);
    if (fileSeen.has(k)) return false;
    fileSeen.add(k);
    return true;
  });
  return { files: dedupFiles, children: dedupChildren };
}

/** 懒加载单个文件夹层级（单级 list_dir）。失败按节点记录 error，不抛给调用方。 */
export async function loadFolderNode(
  store: TreeStore,
  path: string,
  showHidden: boolean,
  force: boolean = false
): Promise<void> {
  const np = normPath(path);
  const ls = store.get().loadState.get(np);
  if (!force && ls?.loading) return;

  store.setLoadState(np, { loading: true, error: null });

  try {
    const rawItems = await listDir(np, showHidden);
    const { files, children } = buildNodeContent(store, np, rawItems);

    store.mutate((st) => {
      const nodeMap = new Map(st.nodeMap);
      nodeMap.set(np, { name: baseName(np), path: np, files, children, loaded: true });
      for (const c of children) {
        if (!nodeMap.has(c.path)) nodeMap.set(c.path, { ...c, optimistic: c.optimistic ?? false });
      }
      // 清除本层及现存子目录的陈旧 error——移动/重命名后旧路径重新出现时会残留「无法访问」状态
      const loadState = new Map(st.loadState);
      loadState.set(np, { loading: false, error: null });
      for (const c of children) {
        loadState.set(c.path, { loading: false, error: null });
      }
      return {
        ...st,
        nodeMap,
        loadState,
      };
    });
  } catch (e) {
    store.mutate((st) => {
      const nodeMap = new Map(st.nodeMap);
      if (!nodeMap.has(np)) {
        nodeMap.set(np, { name: baseName(np), path: np, files: [], children: [], loaded: false });
      }
      return {
        ...st,
        nodeMap,
        loadState: new Map(st.loadState).set(np, { loading: false, error: String(e) }),
      };
    });
  }
}

/** 重载单个目录层级：直接强制重新加载。
 *  旧实现先 delete 再 load，若 load 失败则节点永久丢失 → "无法访问"。
 *  新实现：loadFolderNode 会覆盖 nodeMap 中的旧节点；失败时保留旧节点不变，仅记录 error。
 */
export function reloadFolder(store: TreeStore, path: string, showHidden: boolean): Promise<void> {
  return loadFolderNode(store, path, showHidden, true);
}

/** 刷新某路径所在的父目录（删除/移动/复制/新建后精准刷新，无需重建整树） */
export async function refreshFolderOf(store: TreeStore, path: string, showHidden: boolean): Promise<void> {
  const p = normPath(path);
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  const parent = i < 0 ? p : p.slice(0, i);
  await reloadFolder(store, parent, showHidden);
}

/** 刷新整个树：重置缓存并重新列举所有根层 */
export async function refreshTree(store: TreeStore, showHidden: boolean): Promise<void> {
  const roots = store.get().rootPaths;
  if (!roots.length) return;
  store.clearLoadState();
  const removedRoots: string[] = [];
  for (const rp of roots) {
    store.deleteNode(rp);
    await loadFolderNode(store, rp, showHidden);
    const s = store.get();
    const node = s.nodeMap.get(rp);
    const ls = s.loadState.get(rp);
    if (node && !node.loaded && ls?.error) {
      removedRoots.push(rp);
    }
  }
  if (removedRoots.length) {
    const s = store.get();
    store.setRoots(s.rootPaths.filter((p) => !removedRoots.includes(p)));
  }
}

/** 重新列举所有已加载层级（含根）——「显示隐藏项」切换后让显隐立即生效 */
export async function reloadAllLoaded(store: TreeStore, showHidden: boolean): Promise<void> {
  const s = store.get();
  const loaded = [...s.rootPaths];
  for (const p of s.nodeMap.keys()) {
    if (s.nodeMap.get(p)?.loaded && !s.rootPaths.includes(p)) loaded.push(p);
  }
  store.clearLoadState();
  for (const p of loaded) {
    store.deleteNode(p);
    await loadFolderNode(store, p, showHidden);
  }
}

/**
 * 乐观更新：在树中直接插入新创建的文件夹节点。
 * 不依赖 listDir 返回值，创建成功后立即显示，避免文件系统延迟导致的"加载中…"问题。
 */
export function addFolderNode(store: TreeStore, parentPath: string, folderName: string): string {
  const parent = normPath(parentPath);
  const childPath = normPath(`${parent}/${folderName}`);
  const child: FileTreeNode = { name: folderName, path: childPath, files: [], children: [], loaded: true, optimistic: true };
  store.mutate((st) => {
    const nodeMap = new Map(st.nodeMap);
    nodeMap.set(childPath, child);
    const parentKey = resolveNodeKey(nodeMap, parent); // P-04：用规范 key 写回，避免大小写重复节点
    if (parentKey) {
      const pNode = nodeMap.get(parentKey)!;
      const existingIdx = pNode.children.findIndex((c) => normPath(c.path) === childPath);
      if (existingIdx >= 0) {
        const newChildren = [...pNode.children];
        newChildren[existingIdx] = child;
        nodeMap.set(parentKey, { ...pNode, children: newChildren, loaded: true });
      } else {
        nodeMap.set(parentKey, { ...pNode, children: [...pNode.children, child], loaded: true });
      }
    }
    return {
      ...st,
      nodeMap,
      loadState: new Map(st.loadState).set(childPath, { loading: false, error: null }),
    };
  });
  // B-02：父目录不在树中（如多根切换/未加载），乐观插入失败但文件已在磁盘——
  // 回退：强制加载父目录，让真实内容呈现（含新文件夹）。
  if (!resolveNodeKey(store.get().nodeMap, parent)) {
    void loadFolderNode(store, parent, store.get().showHidden, true).catch(() => {});
  }
  return childPath;
}

/**
 * 乐观更新：在树中直接插入新创建的文件节点。
 */
export function addFileNode(
  store: TreeStore,
  parentPath: string,
  fileName: string,
  isMd: boolean = true
): string {
  const parent = normPath(parentPath);
  const filePath = normPath(`${parent}/${fileName}`);
  store.mutate((st) => {
    const nodeMap = new Map(st.nodeMap);
    const parentKey = resolveNodeKey(nodeMap, parent);
    if (parentKey) {
      const pNode = nodeMap.get(parentKey)!;
      const existingIdx = pNode.files.findIndex((f) => normPath(f.path) === filePath);
      const newFile = { name: fileName, path: filePath, isMd, size: 0, mtime: Date.now() / 1000, optimistic: true };
      if (existingIdx >= 0) {
        const newFiles = [...pNode.files];
        newFiles[existingIdx] = newFile;
        nodeMap.set(parentKey, { ...pNode, files: newFiles });
      } else {
        nodeMap.set(parentKey, { ...pNode, files: [...pNode.files, newFile] });
      }
    }
    return { ...st, nodeMap };
  });
  // B-02：父目录不在树中时回退加载
  if (!resolveNodeKey(store.get().nodeMap, parent)) {
    void loadFolderNode(store, parent, store.get().showHidden, true).catch(() => {});
  }
  return filePath;
}

/**
 * 新建文件/文件夹后让其在树中可见：刷新父目录（B-01 乐观合并保护乐观插入的节点，
 * 重载不会把刚建的文件夹/文件清掉），并若新建项是目录则直接加载它——使其显示为空文件夹
 * （而非"加载中…"），并触发「（空文件夹）」提示。文件无需单独加载（叶子节点）。
 */
export async function revealCreated(store: TreeStore, usedPath: string): Promise<void> {
  const np = normPath(usedPath);
  const parent = parentDir(np);
  const s = store.get();
  if (s.collapsed.has(parent)) {
    const next = new Set(s.collapsed);
    next.delete(parent);
    store.setCollapsed(next);
  }
  // 刷新父目录：让新建项出现在树中
  await reloadFolder(store, parent, s.showHidden);
  // 若新建项是文件夹（nodeMap 中以文件夹节点存在），直接加载它，使其立即显示为空文件夹
  if (store.get().nodeMap.has(np)) {
    await reloadFolder(store, np, store.get().showHidden);
  }
}

/**
 * 外部目录监视事件处理（FEAT-2）：只刷新「受影响的已加载目录」。
 * 规则：变更路径的父目录若已加载则刷新；变更路径本身若是已加载目录则刷新；
 * 变更路径若是某个根则刷新该根。
 */
/** 判断某路径是否仍属于当前渲染树（是根，或作为某个节点的子项存在） */
function isPathInTree(state: TreeState, path: string): boolean {
  if (state.rootPaths.some((r) => normPath(r) === path)) return true;
  for (const n of state.nodeMap.values()) {
    if (n.children.some((c) => normPath(c.path) === path)) return true;
  }
  return false;
}

export async function applyFsChanges(store: TreeStore, changes: FsChange[]): Promise<void> {
  const s = store.get();
  const affected = new Set<string>();
  const toDelete = new Set<string>();

  for (const c of changes) {
    const p = normPath(c.path);
    const parent = parentDir(p);
    const isRoot = s.rootPaths.some((r) => normPath(r) === p);

    // 删除/重命名事件：非根路径本身已不存在，重载它会失败并残留「无法访问」。
    // 直接从 nodeMap 清理，由父目录刷新反映最新状态；根路径仍要重载以显示错误。
    if (c.kind === "remove" || c.kind === "rename") {
      if (isRoot) {
        affected.add(p);
      } else {
        toDelete.add(p);
      }
      if (s.nodeMap.get(parent)?.loaded) affected.add(parent);
      continue;
    }

    // 对于 create 事件：若父目录已加载且已包含该路径（乐观插入或已真实存在），
    // 跳过刷新父目录——避免 watcher 延迟刷新用空列表覆盖 revealCreated 刚确认/合并的项
    // （典型场景：新建二级及以上文件夹时，watcher 的 Create 事件 300ms 后批量到达，
    // 此时 revealCreated 已完成父目录加载，若 watcher 的 listDir 恰好处在 Windows 通知
    // 延迟窗口而返回空，会把刚显示的子文件夹清掉，出现「空文件夹」假象）。
    if (c.kind === "create") {
      const pNode = s.nodeMap.get(parent);
      if (pNode?.loaded) {
        const hasChild = pNode.children.some((cc) => normPath(cc.path) === p);
        const hasFile = pNode.files.some((f) => normPath(f.path) === p);
        if (hasChild || hasFile) continue;
      }
    }

    if (s.nodeMap.get(parent)?.loaded) affected.add(parent);
    if (s.nodeMap.get(p)?.loaded) affected.add(p);
    if (isRoot) affected.add(p);
  }

  // 清理已删除/重命名路径的子树（含 loadState），避免后续 reload 失败或状态残留
  if (toDelete.size) {
    store.mutate((st) => {
      const nodeMap = new Map(st.nodeMap);
      const loadState = new Map(st.loadState);
      for (const d of toDelete) {
        for (const k of Array.from(nodeMap.keys())) {
          const nk = normPath(k);
          if (nk === d || nk.startsWith(d + "/")) {
            nodeMap.delete(k);
            loadState.delete(k);
          }
        }
      }
      return { ...st, nodeMap, loadState };
    });
  }

  // 先刷新父目录，再检查子路径是否仍属于树；已被移出的节点直接删除，不重载
  const sorted = [...affected].sort((a, b) => a.length - b.length);
  for (const d of sorted) {
    const st = store.get();
    if (!st.rootPaths.some((r) => normPath(r) === d) && !isPathInTree(st, d)) {
      store.mutate((st2) => {
        const nodeMap = new Map(st2.nodeMap);
        const loadState = new Map(st2.loadState);
        for (const k of Array.from(nodeMap.keys())) {
          const nk = normPath(k);
          if (nk === d || nk.startsWith(d + "/")) {
            nodeMap.delete(k);
            loadState.delete(k);
          }
        }
        return { ...st2, nodeMap, loadState };
      });
      continue;
    }
    await reloadFolder(store, d, st.showHidden);
  }
}
