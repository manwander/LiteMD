<script lang="ts">
  // 文件树面板（重构版）：纯 UI + 交互，数据经 filetree store / ops / locate / watcher 管理。
  // 所有副作用（打开文件/对话框/标签联动/设置持久化）通过 handlers 回调上抛给 App。
  import { onMount } from "svelte";
  import { createEventDispatcher } from "svelte";
  import {
    createFile,
    createDir,
    renamePath,
    deletePath,
    deletePathPermanent,
    isTrashUnavailable,
    movePath,
    copyPath,
    revealInExplorer,
    uniquePath,
    importFiles,
    searchFilenames,
  } from "./fs";
  import { sanitizeName } from "./commands/file-commands";
  import { logOp, logError } from "./logger";
  import { flatten } from "./filetree/flatten";
  import { loadFolderNode, reloadFolder, refreshFolderOf, reloadAllLoaded, refreshTree as refreshAllTree, revealCreated as opsRevealCreated, applyFsChanges as opsApplyFsChanges, addFolderNode, addFileNode } from "./filetree/ops";
  import { ensureVisible } from "./filetree/locate";
  import { startWatching, stopWatching, pauseWatcher, resumeWatcher } from "./filetree/watcher";
  import type { FsChange } from "./filetree/watcher";
  import type { TreeStore } from "./filetree/store";
  import {
    normPath,
    parentDir,
    baseName,
    isUnder,
  } from "./filetree/types";
  import type { FlatNode, TreeHandlers } from "./filetree/types";
  import { dragTargetValid } from "./filetree/dnd";
  import { resolveDropTargetDir } from "./filetree/drop-target";
  import { showToast } from "./toast";
  import { getCurrentWebview } from "@tauri-apps/api/webview";
  import type { UnlistenFn } from "@tauri-apps/api/event";

  export let store: TreeStore;
  export let sidebarWidth: number;
  export let currentPath: string | null = null;
  export let defaultDir: string | null = null;
  export let hiddenPaths: string[] = [];
  /** 文件树是否隐藏附件文件夹（名称由 assetsDir 指定，默认 _attachment） */
  export let hideAttachments: boolean = true;
  /** 附件文件夹名（shared 模式下用于判断文件树中隐藏哪个统一附件目录） */
  export let assetsDir: string = "_attachment";
  /** 附件组织模式：perDocument=每篇文档带自己的 <文档名>_attachment；shared=统一收编进 assetsDir */
  export let attachmentMode: "perDocument" | "shared" = "perDocument";
  /** perDocument 模式下的附件目录名模板（{filename} 渲染为文档名） */
  export let attachmentTemplate: string = "{filename}_attachment";
  export let handlers: TreeHandlers;

  const norm = normPath;
  const dispatch = createEventDispatcher();

  // ================= 响应式：状态 → 平铺列表（无 hack，Svelte 直接追踪依赖） =================
  $: state = $store;
  $: flatTree = flatten({
    nodeMap: state.nodeMap,
    loadState: state.loadState,
    rootPaths: state.rootPaths,
    collapsed: state.collapsed,
    filter: state.filter,
    showHidden: state.showHidden,
    showNonMd: state.showNonMd,
    hideAttachments,
    assetsDir,
    attachmentMode,
    attachmentTemplate,
    hiddenPaths,
    sort: state.sort,
    version: state.version,
  });

  // ================= 虚拟滚动（紧凑单行固定行高，D-7） =================
  const TREE_ROW_H = 27;
  const TREE_VIRTUAL_THRESHOLD = 500;
  let treeScrollTop = 0;
  let treeViewportH = 600;
  let listEl: HTMLUListElement;
  $: treeVirtual = flatTree.length > TREE_VIRTUAL_THRESHOLD;
  $: treeRange = computeRange(treeVirtual, treeScrollTop, treeViewportH, flatTree.length);
  function computeRange(virtual: boolean, top: number, vh: number, len: number) {
    if (!virtual) return { s: 0, e: len, top: 0, bottom: 0 };
    const s = Math.max(0, Math.floor(top / TREE_ROW_H) - 10);
    const e = Math.min(len, Math.ceil((top + vh) / TREE_ROW_H) + 10);
    return { s, e, top: s * TREE_ROW_H, bottom: (len - e) * TREE_ROW_H };
  }
  let scrollRaf = 0;
  function onTreeScroll(e: Event) {
    // M-04：用 requestAnimationFrame 节流，避免大目录快速滚动时密集触发响应式更新
    if (scrollRaf) return;
    const el = e.currentTarget as HTMLElement;
    scrollRaf = requestAnimationFrame(() => {
      treeScrollTop = el.scrollTop;
      scrollRaf = 0;
    });
  }
  /** 供父组件/内部滚动到指定行（定位当前文件用） */
  export function scrollToIndex(index: number) {
    if (!treeVirtual) return;
    treeScrollTop = Math.max(0, index * TREE_ROW_H - treeViewportH / 2);
    if (listEl) listEl.scrollTop = treeScrollTop;
  }
  function indexOfPath(path: string): number {
    const np = norm(path);
    return flatTree.findIndex((f) => norm(f.path) === np);
  }

  // ================= 键盘导航（FEAT-6） =================
  let focusIndex = -1;
  function setFocus(i: number) {
    focusIndex = Math.max(-1, Math.min(flatTree.length - 1, i));
    if (focusIndex >= 0) {
      scrollToIndex(focusIndex);
      // C-02：键盘导航也同步上下文目录
      const n = flatTree[focusIndex];
      if (n.kind === "folder") setContextDir(n.path);
      else if (n.kind === "file") setContextDir(parentDir(n.path));
    }
  }
  function onListKeydown(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
    const n: FlatNode | undefined = focusIndex >= 0 ? flatTree[focusIndex] : undefined;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setFocus(focusIndex + 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        setFocus(focusIndex - 1);
        break;
      case "ArrowRight":
        e.preventDefault();
        if (n && n.kind === "folder") {
          if (!n.expanded) toggleFolder(n.path);
          else setFocus(focusIndex + 1);
        }
        break;
      case "ArrowLeft":
        e.preventDefault();
        if (n && n.kind === "folder" && n.expanded) {
          toggleFolder(n.path);
        } else if (n) {
          const p = parentDir(n.path);
          const pi = indexOfPath(p);
          if (pi >= 0) setFocus(pi);
        }
        break;
      case "Enter":
        e.preventDefault();
        if (!n) break;
        if (n.kind === "folder") toggleFolder(n.path);
        else if (n.kind === "file") {
          selectNode(n);
          handlers.openFile(n.path);
        } else if (n.kind === "remote") void openRemote(n);
        break;
      case "F2":
        e.preventDefault();
        if (n && (n.kind === "file" || n.kind === "folder")) startRename(n);
        break;
      case "Delete":
        e.preventDefault();
        if (n && (n.kind === "file" || n.kind === "folder")) void batchDelete([n.path]);
        break;
      case "Escape":
        if (renaming) cancelRename();
        else if (state.filter) store.setFilter("");
        break;
    }
  }

  // ================= 多选（FEAT-10） =================
  let selection = new Set<string>();
  let anchor: string | null = null;
  /**
   * 当前上下文目录（必为文件夹路径或 null）：新建文件/文件夹、拖拽落点的唯一来源。
   * 鼠标点击 / 键盘导航 / 面包屑 / 定位 / 文件点击 全部同步更新，
   * 彻底消除「顶部按钮与快捷键使用不同上下文」导致的二级目录新建失效（C-01~C-07）。
   */
  let contextDir: string | null = null;
  function setContextDir(p: string | null) {
    contextDir = p ? norm(p) : null;
  }
  /** 新建目标目录：上下文优先；否则当前打开文件所在目录；否则回退 defaultDir（根） */
  function newTargetDir(): string | null {
    if (contextDir) return contextDir;
    if (currentPath) return parentDir(currentPath);
    return null;
  }
  function selectNode(n: FlatNode) {
    selection = new Set([n.path]);
    anchor = n.path;
    focusIndex = indexOfPath(n.path);
    scrollToIndex(focusIndex);
  }
  function onNodeClick(n: FlatNode, e: MouseEvent) {
    if (dragJustEnded) {
      // 拖拽结束后 WebView2 仍会触发一次 click，避免误折叠/打开
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (n.kind !== "file" && n.kind !== "folder") return;
    if (n.kind === "file" && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      selectNode(n);
      setContextDir(parentDir(n.path)); // C-03：点文件 → 上下文设为文件所在目录
      handlers.openFile(n.path);
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(selection);
      if (next.has(n.path)) next.delete(n.path);
      else next.add(n.path);
      selection = next;
      anchor = n.path;
      return;
    }
    if (e.shiftKey && anchor) {
      const a = indexOfPath(anchor);
      const b = indexOfPath(n.path);
      if (a >= 0 && b >= 0) {
        const next = new Set<string>();
        const [lo, hi] = a < b ? [a, b] : [b, a];
        for (let i = lo; i <= hi; i++) {
          const nn = flatTree[i];
          if (nn.kind === "file" || nn.kind === "folder") next.add(nn.path);
        }
        selection = next;
        anchor = n.path;
      }
      return;
    }
    // 单击文件夹：展开/折叠 + 单选 + 同步上下文（C-02：点击即更新上下文）
    if (n.kind === "folder") {
      selectNode(n);
      setContextDir(n.path);
      focusDir = n.path; // C-11：点击树节点时同步面包屑焦点，避免面包屑与树显示层级不一致
      toggleFolder(n.path);
    }
  }
  function selectedPaths(): string[] {
    if (selection.size > 1) return [...selection];
    return selection.size === 1 ? [...selection] : [];
  }
  function clearSelection() {
    selection = new Set();
  }

  // ================= 拖拽移动/复制（FEAT-9，Pointer Events 实现） =================
  // Windows 下 Tauri 原生 OLE 拖拽处理器与 WebView 内部 HTML5 drag 互斥（官方 not planned），
  // 因此内部拖拽改用 Pointer Events（OLE 不拦截指针事件），外部文件拖入由 Tauri 的
  // drag-drop 事件接管（dragDropEnabled=true）。两套机制互不干扰，得以共存。
  let dragPath: string | null = null;
  let dragOverPath: string | null = null;
  let dragIsCopy = false;
  let dragPaths: string[] = []; // D-08：多选批量拖拽
  let dragExpandTimer: ReturnType<typeof setTimeout> | null = null;
  let dragJustEnded = false; // 区分拖拽与点击：拖拽结束后若 click 触发则忽略
  let pendingDrag: { path: string; x: number; y: number; paths: string[] } | null = null;
  let dragPreview: HTMLElement | null = null;
  let grabOffsetX = 0; // 抓取点在行内的偏移，使镜像锚定在光标下（对齐原生拖拽，避免文件相对鼠标错位）
  let grabOffsetY = 0;
  const DRAG_THRESHOLD = 5; // 超过该像素位移才视为拖拽，否则按点击处理

  function onPointerDown(e: PointerEvent, path: string) {
    if (e.button !== 0) return; // 仅左键
    const t = e.target as HTMLElement;
    // 行内按钮（新建/重命名等）不触发拖拽
    if (t.closest("button, input, .rename-input, .factions")) return;
    dragJustEnded = false;
    const paths = selection.has(path) && selection.size > 1 ? [...selection] : [path];
    pendingDrag = { path, x: e.clientX, y: e.clientY, paths };
  }

  function onPointerMove(e: PointerEvent) {
    if (pendingDrag && !dragPath) {
      const dx = e.clientX - pendingDrag.x;
      const dy = e.clientY - pendingDrag.y;
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      // 超过阈值 → 进入拖拽状态
      dragPath = pendingDrag.path;
      dragPaths = pendingDrag.paths;
      dragIsCopy = e.ctrlKey;
      document.body.style.userSelect = "none"; // 拖拽中禁止文本选中
      pauseWatcher(); // 拖拽期间暂停文件监视刷新，避免与乐观更新竞态
      const src = document.elementFromPoint(pendingDrag.x, pendingDrag.y) as HTMLElement | null;
      const row = src?.closest("li.folder, li.file") as HTMLElement | null;
      if (row) {
        const el = row.cloneNode(true) as HTMLElement;
        el.style.opacity = "0.75";
        el.style.position = "fixed";
        el.style.pointerEvents = "none";
        el.style.zIndex = "9999";
        el.style.margin = "0";
        el.style.left = "0";
        el.style.top = "0";
        el.style.willChange = "transform"; // 提升合成层，避免 left/top 触发布局导致的掉帧
        el.style.width = row.offsetWidth + "px";
        const rect = row.getBoundingClientRect();
        // 记录抓取点相对行左上角的偏移，使镜像始终锚定在光标下（与系统原生拖拽一致）
        grabOffsetX = pendingDrag.x - rect.left;
        grabOffsetY = pendingDrag.y - rect.top;
        el.style.transform = `translate(${rect.left}px, ${rect.top}px)`;
        document.body.appendChild(el);
        dragPreview = el;
      }
    }
    if (!dragPath) return;
    dragIsCopy = e.ctrlKey;
    const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    const row = el?.closest("li.folder, li.file") as HTMLElement | null;
    const dataPath = row ? row.getAttribute("data-path") : null;
    const isFolder = row ? row.classList.contains("folder") : false;
    const targetDir = dataPath
      ? isFolder
        ? normPath(dataPath)
        : normPath(parentDir(dataPath))
      : null;
    if (targetDir && dragTargetValid(dragPath, targetDir)) {
      dragOverPath = targetDir;
      if (dragPreview) {
        // 用 transform 把抓取点锚在光标下，避免文件相对鼠标错位（原生拖拽行为）
        dragPreview.style.transform = `translate(${e.clientX - grabOffsetX}px, ${e.clientY - grabOffsetY}px)`;
      }
      // D-09：悬停折叠文件夹 700ms 自动展开
      if (store.get().collapsed.has(targetDir)) {
        if (dragExpandTimer) clearTimeout(dragExpandTimer);
        dragExpandTimer = setTimeout(() => {
          if (dragOverPath === targetDir) store.toggleCollapsed(targetDir);
        }, 700);
      } else if (dragExpandTimer) {
        clearTimeout(dragExpandTimer);
        dragExpandTimer = null;
      }
    } else {
      dragOverPath = null;
      if (dragExpandTimer) {
        clearTimeout(dragExpandTimer);
        dragExpandTimer = null;
      }
    }
  }

  function onPointerUp(e: PointerEvent) {
    if (dragPath) {
      // 真实发生了拖拽
      e.preventDefault();
      const target = dragOverPath ?? resolveDropTargetDir(null, false, state.rootPaths);
      const srcs = dragPaths.length ? dragPaths : [dragPath];
      const isCopy = dragIsCopy;
      cleanupDrag();
      if (target && dragTargetValid(srcs[0], target)) {
        void performDrop(srcs, target, isCopy);
      }
    } else if (pendingDrag) {
      // 未超阈值 → 视为点击，交由 onNodeClick 处理（不抑制点击）
      pendingDrag = null;
    }
  }

  function cleanupDrag() {
    dragPath = null;
    dragOverPath = null;
    dragIsCopy = false;
    dragPaths = [];
    dragJustEnded = true; // 拖拽结束后 WebView2 可能触发一次 click，忽略之
    setTimeout(() => (dragJustEnded = false), 60);
    pendingDrag = null;
    resumeWatcher();
    if (dragExpandTimer) {
      clearTimeout(dragExpandTimer);
      dragExpandTimer = null;
    }
    document.body.style.userSelect = "";
    if (dragPreview) {
      dragPreview.remove();
      dragPreview = null;
    }
  }
  /** 目录移动/重命名后，把 focusDir/contextDir 中旧路径前缀迁移到新路径，
   * 避免面包屑与上下文目录指向已不存在的陈旧路径（C-11）。 */
  function syncDirAfterMove(newPath: string, oldPath: string) {
    if (focusDir && (focusDir === oldPath || isUnder(focusDir, oldPath))) {
      focusDir = newPath + focusDir.slice(oldPath.length);
    }
    if (contextDir && (contextDir === oldPath || isUnder(contextDir, oldPath))) {
      setContextDir(newPath + contextDir.slice(oldPath.length));
    }
  }

  /** 乐观移动/复制：先在树中更新节点，避免刷新前的闪断/不一致（D-05） */
  function optimisticMove(srcs: string[], targetDir: string, isCopy: boolean) {
    store.mutate((st) => {
      const nodeMap = new Map(st.nodeMap);
      const tp = norm(targetDir);
      for (const src of srcs) {
        const sp = norm(src);
        const parent = norm(parentDir(sp));
        const pNode = nodeMap.get(parent);
        if (!pNode) continue;
        const movedFile = pNode.files.find((f) => norm(f.path) === sp);
        const movedChild = movedFile ? undefined : pNode.children.find((c) => norm(c.path) === sp);
        if (movedFile) {
          if (!isCopy) nodeMap.set(parent, { ...pNode, files: pNode.files.filter((f) => norm(f.path) !== sp) });
          const tNode = nodeMap.get(tp);
          const newPath = `${tp}/${movedFile.name}`;
          if (tNode) {
            // 先移除目标中同名项，避免来回移动时乐观节点残留导致重复 key（Svelte keyed-each 崩溃）
            const newFiles = tNode.files.filter((f) => norm(f.path) !== newPath);
            nodeMap.set(tp, { ...tNode, files: [...newFiles, { ...movedFile, path: newPath, optimistic: true }] });
          }
        } else if (movedChild) {
          if (!isCopy) nodeMap.set(parent, { ...pNode, children: pNode.children.filter((c) => norm(c.path) !== sp) });
          const tNode = nodeMap.get(tp);
          const newPath = `${tp}/${movedChild.name}`;
          if (tNode) {
            const newChildren = tNode.children.filter((c) => norm(c.path) !== newPath);
            nodeMap.set(tp, {
              ...tNode,
              children: [...newChildren, { ...movedChild, path: newPath, loaded: movedChild.loaded, optimistic: true }],
            });
          }
          nodeMap.set(newPath, { ...movedChild, path: newPath });
        }
      }
      return { ...st, nodeMap };
    });
  }
  async function performDrop(srcs: string[], targetDir: string, isCopy: boolean) {
    const valid = srcs.filter((s) => dragTargetValid(s, targetDir));
    if (!valid.length) return;
    try {
      // D-05：乐观更新先呈现结果
      optimisticMove(valid, targetDir, isCopy);
      for (const src of valid) {
        const srcName = baseName(src);
        const targetPath = `${norm(targetDir)}/${srcName}`;
        const targetExists = await handlers.checkPathExists?.(targetPath);
        if (targetExists) {
          const action = isCopy ? "复制" : "移动";
          const ok = await handlers.confirm({
            title: "目标已存在",
            message: `目标位置已存在同名"${srcName}"，是否覆盖？`,
          });
          if (!ok) {
            handlers.setStatus(`${action}已取消`);
            optimisticMove(valid, targetDir, isCopy); // 无覆盖：仍保留乐观（等效无操作），随后由刷新校正
            await refreshAllAffected(valid, targetDir);
            return;
          }
          await deletePath(targetPath);
        }
        if (isCopy) {
          const np = await copyPath(src, targetDir);
          logOp("复制文件: " + src + " → " + np);
          handlers.setStatus(`已复制 ${baseName(src)} → ${baseName(targetDir)}（${baseName(np)}）`);
        } else {
          const np = await movePath(src, targetDir);
          logOp("移动文件: " + src + " → " + norm(np));
          if (norm(np) !== norm(src)) {
            handlers.onTabRenamed(src, norm(np));
            store.migrateCollapsedForMove(src, norm(np)); // 折叠态跟随目录迁移
            syncDirAfterMove(norm(np), norm(src)); // C-11：面包屑焦点与上下文目录跟随移动
          }
          handlers.setStatus(`已移动 ${baseName(src)} → ${baseName(targetDir)}`);
        }
      }
      await refreshAllAffected(valid, targetDir);
    } catch (err) {
      // 失败：重新加载相关目录，恢复真实文件系统状态（D-05 回滚）
      await refreshAllAffected(valid, targetDir);
      handlers.setStatus("操作失败：" + String(err));
    }
  }
  /** 刷新目标目录与所有源父目录（移动/复制/取消/失败统一入口） */
  async function refreshAllAffected(srcs: string[], targetDir: string) {
    await refreshFolderOf(store, targetDir, store.get().showHidden);
    for (const s of srcs) await refreshFolderOf(store, s, store.get().showHidden);
  }

  // ================= 行内重命名（FEAT-6） =================
  let renaming: FlatNode | null = null;
  let renameValue = "";
  function startRename(n: FlatNode) {
    renaming = n;
    renameValue = n.name;
  }
  function cancelRename() {
    renaming = null;
  }
  async function commitRename() {
    const n = renaming;
    renaming = null;
    if (!n) return;
    const name = renameValue.trim();
    if (!name) return;
    const isFile = n.kind === "file";
    let newName = sanitizeName(name);
    if (!newName || newName === sanitizeName(n.name)) return;
    if (isFile && n.isMd !== false && !/\.md$/i.test(newName)) newName += ".md";
    const dest = `${parentDir(n.path)}/${newName}`;
    try {
      await renamePath(n.path, dest);
      const np = norm(dest);
      logOp("重命名文件: " + n.path + " → " + np);
      if (np !== norm(n.path)) {
        handlers.onTabRenamed(n.path, np);
        syncDirAfterMove(np, norm(n.path)); // C-11：重命名也同步面包屑焦点与上下文目录
      }
      handlers.setStatus(`已重命名 ${n.name} → ${newName}`);
      await refreshFolderOf(store, n.path, store.get().showHidden);
    } catch (e) {
      handlers.setStatus("重命名失败：" + String(e));
    }
  }
  function onRenameKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      void commitRename();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelRename();
    }
  }

  // ================= 右键菜单 =================
  let ctxMenu: {
    x: number;
    y: number;
    kind: "file" | "folder" | "root" | "multi";
    path: string;
    name: string;
  } | null = null;
  function openCtx(e: MouseEvent, kind: "file" | "folder" | "root" | "multi", path: string, name: string) {
    e.preventDefault();
    e.stopPropagation();
    ctxMenu = { x: e.clientX, y: e.clientY, kind, path, name };
  }
  function closeCtx() {
    ctxMenu = null;
  }
  function onNodeContext(e: MouseEvent, n: FlatNode) {
    if (n.kind === "loading" || n.kind === "error" || n.kind === "remote") return;
    // 右键即选中：若该行不在选择集则单选它
    if (!selection.has(n.path)) {
      selection = new Set([n.path]);
      anchor = n.path;
      focusIndex = indexOfPath(n.path);
    }
    const multi = selection.size > 1;
    openCtx(
      e,
      multi ? "multi" : n.kind === "file" ? "file" : n.isRoot ? "root" : "folder",
      n.path,
      n.name
    );
  }
  function ctxTargets(): string[] {
    const c = ctxMenu;
    if (!c) return [];
    return selection.size > 1 ? [...selection] : [c.path];
  }
  function ctxNewFile() {
    const c = ctxMenu;
    closeCtx();
    if (!c) return;
    const target = c.kind === "file" ? parentDir(c.path) : c.path;
    void newFileIn(target);
  }
  function ctxNewFolder() {
    const c = ctxMenu;
    closeCtx();
    if (!c) return;
    const target = c.kind === "file" ? parentDir(c.path) : c.path;
    void newFolderIn(target);
  }
  function ctxOpen() {
    const p = ctxMenu?.path;
    closeCtx();
    if (p) handlers.openFile(p);
  }
  function ctxRename() {
    const c = ctxMenu;
    closeCtx();
    if (!c) return;
    const idx = indexOfPath(c.path);
    if (idx >= 0 && (flatTree[idx].kind === "file" || flatTree[idx].kind === "folder")) {
      startRename(flatTree[idx]);
    }
  }
  async function ctxReveal() {
    const c = ctxMenu;
    closeCtx();
    if (!c) return;
    try {
      await revealInExplorer(c.path);
    } catch (e) {
      handlers.setStatus("无法打开资源管理器：" + String(e));
    }
  }
  async function ctxRefreshFolder() {
    const c = ctxMenu;
    closeCtx();
    if (!c) return;
    await refreshFolderOf(store, c.path, store.get().showHidden);
    handlers.setStatus("已刷新 " + c.name);
  }
  async function ctxAddRoot() {
    closeCtx();
    await addRoot();
  }
  function ctxRemoveRoot() {
    const c = ctxMenu;
    closeCtx();
    if (!c) return;
    removeRoot(c.path);
    handlers.setStatus("已移除根目录 " + c.name);
  }
  async function ctxCopy() {
    const paths = ctxTargets();
    closeCtx();
    if (paths.length) await batchCopy(paths);
  }
  async function ctxMove() {
    const paths = ctxTargets();
    closeCtx();
    if (paths.length) await batchMove(paths);
  }
  function ctxHide() {
    const paths = ctxTargets();
    closeCtx();
    if (paths.length) batchHide(paths);
  }
  async function ctxDelete() {
    const paths = ctxTargets();
    closeCtx();
    if (paths.length) await batchDelete(paths);
  }

  // ================= 新建 / 删除 / 移动 / 复制 / 隐藏（ops） =================
  async function ensureFolder(): Promise<string | null> {
    if (defaultDir) return norm(defaultDir);
    const folder = await handlers.pickFolder();
    if (!folder) return null;
    // 直接加入工作区根（不再二次弹窗，见 addRoot 的独立调用场景）
    const np = norm(folder);
    if (!state.rootPaths.includes(np)) {
      store.addRoot(np);
      await loadFolderNode(store, np, state.showHidden, true); // force 重加载，清掉历史 error
      handlers.onRootsChanged(store.get().rootPaths, np);
    }
    return np;
  }
  async function newFileIn(dir: string | null) {
    const target0 = dir ?? (await ensureFolder());
    if (!target0) {
      handlers.setStatus("未选择文件夹，已取消新建");
      return;
    }
    // 默认名自动去重（FEAT-3）：未命名.md → 未命名(1).md
    let def = "未命名.md";
    try {
      const u = await uniquePath(`${norm(target0)}/未命名.md`);
      if (u) def = baseName(norm(u));
    } catch (e) {
      logError("获取唯一文件名失败（使用默认名）: " + String(e)); // M-06：异常留痕而非静默吞掉
    }
    const res = await handlers.prompt({ title: "新建笔记", label: "笔记名", value: def, path: target0 });
    if (!res || !res.name.trim()) return;
    const target = norm(res.path.trim() || target0);
    const cleanName = sanitizeName(res.name.trim());
    if (!cleanName) {
      handlers.setStatus("文件名不能为空或仅含非法字符");
      return;
    }
    const fname = /\.md$/i.test(cleanName) ? cleanName : `${cleanName}.md`;
    try {
      const actualPath = await createFile(`${target}/${fname}`);
      const actualFile = baseName(norm(actualPath));
      logOp("新建文件: " + actualPath);
      // 乐观更新：立即在树中插入新文件节点，使用实际创建路径（避免 uniquePath 后缀不一致）
      addFileNode(store, target, actualFile, true);
      setContextDir(target); // 新建后上下文保持在当前目录，便于连续创建
      handlers.setStatus(`已创建 ${actualFile}`);
      await revealCreated(actualPath);
      // 新建后直接打开为标签（对齐旧行为）
      handlers.openFile(actualPath);
    } catch (e) {
      logError("新建文件失败: " + target + "/" + fname + " - " + String(e));
      handlers.setStatus("新建失败：" + String(e));
    }
  }
  async function newFolderIn(dir: string | null) {
    const target0 = dir ?? (await ensureFolder());
    if (!target0) {
      handlers.setStatus("未选择文件夹，已取消新建");
      return;
    }
    let def = "新建文件夹";
    try {
      const u = await uniquePath(`${norm(target0)}/新建文件夹`);
      if (u) def = baseName(norm(u));
    } catch (e) {
      logError("获取唯一文件夹名失败（使用默认名）: " + String(e));
    }
    const res = await handlers.prompt({ title: "新建文件夹", label: "文件夹名", value: def, path: target0 });
    if (!res || !res.name.trim()) return;
    const target = norm(res.path.trim() || target0);
    const cleanName = sanitizeName(res.name.trim());
    if (!cleanName) {
      handlers.setStatus("文件夹名不能为空或仅含非法字符");
      return;
    }
    const fname = cleanName;
    try {
      const actualPath = await createDir(`${target}/${fname}`);
      const actualFolder = baseName(norm(actualPath));
      logOp("新建文件夹: " + actualPath);
      // 乐观更新：立即在树中插入新文件夹节点，使用实际创建路径（避免 uniquePath 后缀不一致）
      addFolderNode(store, target, actualFolder);
      setContextDir(target); // 新建后上下文保持在当前目录，便于连续创建
      handlers.setStatus(`已创建文件夹 ${actualFolder}`);
      await revealCreated(actualPath);
    } catch (e) {
      logError("新建文件夹失败: " + target + "/" + fname + " - " + String(e));
      handlers.setStatus("新建失败：" + String(e));
    }
  }
  /** 新建后刷新父目录、展开、滚动到新项 */
  async function revealCreated(usedPath: string) {
    await opsRevealCreated(store, usedPath);
    // 滚动到新项（等待响应式 flatTree 更新）
    await new Promise((r) => setTimeout(r, 50));
    const idx = indexOfPath(usedPath);
    if (idx >= 0) {
      setFocus(idx);
      scrollToIndex(idx);
    }
  }
  async function batchCopy(paths: string[]) {
    logOp("批量复制: " + paths.length + " 项");
    const dest = await handlers.pickFolder();
    if (!dest) {
      handlers.setStatus("已取消复制");
      return;
    }
    for (const p of paths) {
      try {
        const np = await copyPath(p, dest);
        handlers.setStatus(`已复制 ${baseName(p)} → ${baseName(dest)}（${baseName(np)}）`);
      } catch (e) {
        handlers.setStatus("复制失败：" + String(e));
        break;
      }
    }
    await refreshAfterBatch(paths, norm(dest));
  }
  async function batchMove(paths: string[]) {
    logOp("批量移动: " + paths.length + " 项");
    const dest = await handlers.pickFolder();
    if (!dest) {
      handlers.setStatus("已取消移动");
      return;
    }
    for (const p of paths) {
      try {
        const np = await movePath(p, dest);
        if (norm(np) !== norm(p)) handlers.onTabRenamed(p, norm(np));
        handlers.setStatus(`已移动 ${baseName(p)} → ${baseName(dest)}`);
      } catch (e) {
        handlers.setStatus("移动失败：" + String(e));
        break;
      }
    }
    await refreshAfterBatch(paths, norm(dest));
  }
  async function refreshAfterBatch(paths: string[], destDir: string) {
    const dirs = new Set<string>([destDir]);
    for (const p of paths) dirs.add(parentDir(norm(p)));
    for (const d of dirs) await reloadFolder(store, d, store.get().showHidden);
  }
  async function batchDelete(paths: string[]) {
    logOp("批量删除: " + paths.length + " 项");
    const roots = store.get().rootPaths.map(norm);
    // M-02：根目录只从工作区移除，绝不删除磁盘根内容
    const toRemoveRoots = paths.filter((p) => roots.includes(norm(p)));
    const toDelete = paths.filter((p) => !roots.includes(norm(p)));
    for (const r of toRemoveRoots) {
      removeRoot(r);
      // C-11：移除根后重置指向该根的面包屑焦点与上下文目录
      const nr = norm(r);
      if (focusDir && (focusDir === nr || isUnder(focusDir, nr))) focusDir = null;
      if (contextDir && (contextDir === nr || isUnder(contextDir, nr))) setContextDir(null);
    }
    if (toRemoveRoots.length && !toDelete.length) {
      handlers.setStatus(`已移除 ${toRemoveRoots.length} 个根目录（未删除磁盘内容）`);
      clearSelection();
      return;
    }
    const ok = await handlers.confirm({
      title: "删除确认",
      message:
        toDelete.length > 1
          ? `确定要把这 ${toDelete.length} 项移入回收站吗？\n可在系统回收站还原。`
          : `确定要把「${baseName(toDelete[0])}」移入回收站吗？\n可在系统回收站还原。`,
      confirmText: "移入回收站",
      danger: true,
    });
    if (!ok) return;
    let deleted = 0;
    for (const p of toDelete) {
      try {
        await deletePath(p);
        deleted++;
        handlers.onTabRemoved(p);
      } catch (e) {
        if (isTrashUnavailable(e)) {
          const force = await handlers.confirm({
            title: "回收站不可用",
            message: `系统回收站无法用于「${baseName(p)}」（常见于网络盘、U 盘或权限受限目录）。\n\n继续将【永久删除】，删除后无法恢复。确定继续吗？`,
            confirmText: "永久删除",
            danger: true,
          });
          if (!force) {
            handlers.setStatus("已取消删除");
            continue;
          }
          try {
            await deletePathPermanent(p);
            deleted++;
            handlers.onTabRemoved(p);
          } catch (e2) {
            handlers.setStatus("永久删除失败：" + String(e2));
          }
        } else {
          handlers.setStatus("删除失败：" + String(e));
        }
      }
    }
    handlers.setStatus(`已删除 ${deleted} 项`);
    // C-11：删除后若焦点/上下文指向已删路径，回退到父目录避免指向不存在路径
    for (const p of toDelete) {
      const np = norm(p);
      if (focusDir && (focusDir === np || isUnder(focusDir, np))) {
        focusDir = parentDir(np);
      }
      if (contextDir && (contextDir === np || isUnder(contextDir, np))) {
        setContextDir(parentDir(np));
      }
    }
    const dirs = new Set<string>();
    for (const p of toDelete) dirs.add(parentDir(norm(p)));
    for (const d of dirs) await reloadFolder(store, d, store.get().showHidden);
    clearSelection();
  }
  function batchHide(paths: string[]) {
    const merged = [...(hiddenPaths ?? [])];
    for (const p of paths) {
      const np = norm(p);
      if (!merged.some((h) => norm(h) === np)) merged.push(np);
    }
    handlers.setHiddenPaths(merged);
    handlers.setStatus(`已隐藏 ${paths.length} 项（可在隐藏管理中恢复）`);
  }
  function unhidePath(p: string) {
    handlers.setHiddenPaths((hiddenPaths ?? []).filter((h) => norm(h) !== norm(p)));
    handlers.setStatus("已取消隐藏 " + baseName(p));
  }

  // ================= 折叠 / 刷新 / 隐藏项 / 多根 =================
  /** 供父组件快捷键/工具栏调用：在当前上下文文件夹（或默认目录）新建笔记 */
  export function requestNewFile() {
    void newFileIn(newTargetDir());
  }
  /** 供父组件快捷键/工具栏调用：在当前上下文文件夹（或默认目录）新建文件夹 */
  export function requestNewFolder() {
    void newFolderIn(newTargetDir());
  }
  function toggleFolder(path: string) {
    store.toggleCollapsed(path);
    const s = store.get();
    if (!s.collapsed.has(path)) {
      const node = s.nodeMap.get(path);
      if (!node?.loaded && !s.loadState.get(path)?.loading) void loadFolderNode(store, path, s.showHidden);
    }
  }
  async function toggleHiddenItems() {
    const next = !state.showHidden;
    store.setShowHidden(next);
    await reloadAllLoaded(store, next);
  }
  async function doRefreshTree() {
    if (!state.rootPaths.length) {
      handlers.setStatus("尚未打开文件夹");
      return;
    }
    await refreshAllTree(store, state.showHidden);
    handlers.setStatus("目录已刷新");
  }
  async function addRoot() {
    const folder = await handlers.pickFolder();
    if (!folder) return;
    const np = norm(folder);
    logOp("添加根目录: " + np);
    if (!store.get().rootPaths.map(norm).includes(np)) store.addRoot(np);
    try {
      // 总是 force 重加载：清掉历史 error，避免首次 listDir 偶发失败残留「无法访问」后无法重试
      await loadFolderNode(store, np, store.get().showHidden, true);
      handlers.onRootsChanged(store.get().rootPaths, np);
      handlers.setStatus("已加载目录 " + baseName(np));
    } catch (e) {
      // loadFolderNode 内部已吞异常并写 loadState.error，这里仅记录
      logError("加载根目录失败: " + np + " - " + String(e));
      handlers.setStatus("加载失败：" + String(e));
    }
  }
  function removeRoot(path: string) {
    logOp("移除根目录: " + path);
    store.removeRoot(path);
    store.deleteNode(path);
    const remaining = store.get().rootPaths;
    handlers.onRootsChanged(remaining, remaining.length ? remaining[remaining.length - 1] : null);
  }
  async function locateCurrent() {
    if (!currentPath) {
      handlers.setStatus("当前没有打开的文件");
      return;
    }
    const ok = await ensureVisible(store, currentPath);
    if (ok) {
      await new Promise((r) => setTimeout(r, 50));
      const idx = indexOfPath(currentPath);
      if (idx >= 0) {
        setFocus(idx);
        scrollToIndex(idx);
      }
      setContextDir(parentDir(currentPath)); // C-02：定位当前文件后，上下文设为文件所在目录
      handlers.setStatus("已定位到 " + baseName(currentPath));
    } else {
      handlers.setStatus("当前文件不在任何已打开的工作区内");
    }
  }

  // ================= 远程过滤搜索（FEAT-1：未加载目录中的匹配） =================
  function onFilterInput(e: Event) {
    store.setFilter((e.currentTarget as HTMLInputElement).value);
  }
  let remoteRows: FlatNode[] = [];
  let remoteSearching = false;
  let remoteTruncated = false;
  let remoteTimer: ReturnType<typeof setTimeout> | null = null;
  $: if (state.filter.trim()) {
    if (remoteTimer) clearTimeout(remoteTimer);
    remoteTimer = setTimeout(() => void runRemoteSearch(), 400);
  } else {
    if (remoteTimer) clearTimeout(remoteTimer);
    remoteRows = [];
    remoteTruncated = false;
  }
  async function runRemoteSearch() {
    const q = state.filter.trim();
    if (!q) return;
    remoteSearching = true;
    try {
      const all: string[] = [];
      for (const root of state.rootPaths) {
        const hits = await searchFilenames(root, q, state.showHidden, 200).catch(() => [] as string[]);
        all.push(...hits);
      }
      const visible = new Set(flatTree.filter((f) => f.kind === "file" || f.kind === "folder").map((f) => norm(f.path)));
      const uniq = [...new Set(all.map(norm))].filter(
        (p) => !visible.has(p) && (state.showNonMd || baseName(p).toLowerCase().endsWith(".md"))
      );
      remoteTruncated = uniq.length > 50;
      remoteRows = uniq.slice(0, 50).map((p) => {
        const root = state.rootPaths.find((r) => isUnder(p, r));
        const rel = root ? p.slice(norm(root).length).replace(/^\//, "") : p;
        return { kind: "remote" as const, name: baseName(p), path: p, depth: 0, expanded: false, remoteRel: rel };
      });
    } finally {
      remoteSearching = false;
    }
  }
  async function openRemote(n: FlatNode) {
    const ok = await ensureVisible(store, n.path);
    if (ok) {
      await new Promise((r) => setTimeout(r, 50));
      const idx = indexOfPath(n.path);
      if (idx >= 0) {
        setFocus(idx);
        scrollToIndex(idx);
      }
    }
    handlers.openFile(n.path);
  }

  // ================= 面包屑（FEAT-12） =================
  let focusDir: string | null = null;
  $: if (currentPath) focusDir = null; // 打开文件变化时跟随文件所在目录
  $: crumbs = buildCrumbs(focusDir ?? (currentPath ? parentDir(currentPath) : state.rootPaths[0] ?? null));
  function buildCrumbs(p: string | null): { name: string; path: string }[] {
    if (!p) return [];
    const np = norm(p);
    const root = state.rootPaths.find((r) => isUnder(np, r));
    if (!root) return [];
    const nr = norm(root);
    const reversed: string[] = [];
    let cur = np;
    while (cur.length >= nr.length && isUnder(cur, nr)) {
      reversed.push(cur);
      if (cur === nr) break;
      cur = parentDir(cur);
    }
    const parts: { name: string; path: string }[] = [];
    for (let i = reversed.length - 1; i >= 0; i--) {
      parts.push({ name: baseName(reversed[i]), path: reversed[i] });
    }
    return parts;
  }
  async function jumpCrumb(path: string) {
    await ensureVisible(store, path);
    await new Promise((r) => setTimeout(r, 50));
    const idx = indexOfPath(path);
    if (idx >= 0) {
      setFocus(idx);
      scrollToIndex(idx);
    }
    focusDir = path;
    setContextDir(path); // C-07：面包屑跳转后同步上下文目录
  }

  // ================= 目录监视（FEAT-2） =================
  let watchOn = false;
  let watchBusy = false;
  $: watchRootsKey = state.rootPaths.join("|");
  $: if (watchRootsKey) void restartWatch();
  async function restartWatch() {
    if (!state.rootPaths.length) return;
    stopWatching();
    watchBusy = true;
    watchOn = await startWatching(state.rootPaths, onFsChange);
    watchBusy = false;
  }
  function toggleWatch() {
    if (watchOn) {
      stopWatching();
      watchOn = false;
      handlers.setStatus("目录监视已暂停");
    } else {
      void restartWatch();
      handlers.setStatus(watchOn ? "目录监视已开启" : "正在开启目录监视…");
    }
  }
  function onFsChange(changes: FsChange[]) {
    void opsApplyFsChanges(store, changes);
  }

  // ================= 折叠持久化（FEAT-7）/ 排序 / 附件可见性持久化 =================
  let prefsTimer: ReturnType<typeof setTimeout> | null = null;
  $: if (state.collapsed) {
    if (prefsTimer) clearTimeout(prefsTimer);
    prefsTimer = setTimeout(() => {
      handlers.setTreePrefs({
        collapsed: [...state.collapsed].slice(0, 500),
        sort: state.sort,
        showNonMd: state.showNonMd,
      });
    }, 300);
  }
  function toggleShowNonMd() {
    store.setShowNonMd(!state.showNonMd);
  }
  function collapseAll() {
    store.collapseAll();
  }
  const SORT_OPTIONS: { key: "name" | "mtime" | "size" | "type"; label: string }[] = [
    { key: "name", label: "按名称" },
    { key: "mtime", label: "按修改时间" },
    { key: "size", label: "按大小" },
    { key: "type", label: "按类型" },
  ];
  let sortOpen = false;
  function pickSort(key: "name" | "mtime" | "size" | "type") {
    store.setSort(key);
    sortOpen = false;
  }

  // ================= 隐藏管理 =================
  let showHiddenManage = false;

  // ================= 生命周期 =================
  // 自动加载当前可见的未加载展开文件夹：解决默认展开（collapsed 为空）时子文件夹只显示“加载中”
  // 但无人触发 list_dir 的问题。通过 $: 响应式追踪 flatTree / treeRange 变化，仅对当前渲染范围
  // 内、未在加载中的展开文件夹发起一次 loadFolderNode。
  $: {
    const s = $store;
    const { s: rangeStart, e: rangeEnd } = treeRange;
    const visible = flatTree.slice(rangeStart, rangeEnd);
    for (const n of visible) {
      if (n.kind !== "folder" || !n.expanded) continue;
      const node = s.nodeMap.get(n.path);
      if (!node || node.loaded) continue;
      if (s.loadState.get(n.path)?.loading) continue;
      void loadFolderNode(store, n.path, s.showHidden);
    }
  }

  onMount(() => {
    // 挂载时补一次已加载层刷新（弥补监视未启动期间的外部变更；读操作不会触发监视事件循环）
    if (store.get().rootPaths.length) void reloadAllLoaded(store, store.get().showHidden);
    // Pointer Events 内部拖拽：在 window 上监听 move/up，确保光标移出行外仍能追踪
    if (typeof window !== "undefined") {
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
    }
    // 从资源管理器拖入文件（dragDropEnabled=true 时 Tauri 派发，与内部 Pointer 拖拽互不冲突）
    let unlistenDrop: UnlistenFn | null = null;
    try {
      getCurrentWebview()
        .onDragDropEvent((event) => {
          if (event.payload.type === "drop") {
            void importOsFiles(event.payload.paths, event.payload.position);
          }
        })
        .then((fn) => (unlistenDrop = fn))
        .catch(() => {});
    } catch {
      // 非 Tauri 环境（浏览器调试 / jsdom 测试）getCurrentWebview 不存在，静默降级
    }
    return () => {
      if (typeof window !== "undefined") {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
      }
      if (unlistenDrop) unlistenDrop();
      stopWatching();
      if (prefsTimer) clearTimeout(prefsTimer);
      if (remoteTimer) clearTimeout(remoteTimer);
    };
  });

  /** 从资源管理器拖入：依据落点坐标解析目标目录，把外部文件复制进去（非破坏性） */
  async function importOsFiles(paths: string[], pos: { x: number; y: number }) {
    let target: string | null = null;
    try {
      const el = document.elementFromPoint(pos.x, pos.y) as HTMLElement | null;
      const row = el?.closest("li.folder, li.file") as HTMLElement | null;
      if (row) {
        const p = row.getAttribute("data-path");
        const isFolder = row.classList.contains("folder");
        target = resolveDropTargetDir(p, isFolder, state.rootPaths);
      }
    } catch {
      /* 坐标解析失败 → 回退根目录 */
    }
    if (!target) target = state.rootPaths.length ? normPath(state.rootPaths[0]) : null;
    if (!target) {
      handlers.setStatus("请先打开一个文件夹再导入文件");
      showToast("请先打开文件夹", "info");
      return;
    }
    try {
      const imported = await importFiles(paths, target);
      logOp(`导入文件: ${imported.length} 个 → ${target}`);
      handlers.setStatus(`已导入 ${imported.length} 个文件到 ${baseName(target)}`);
      showToast(`已导入 ${imported.length} 个文件到 ${baseName(target)}`, "success");
      await refreshFolderOf(store, target, state.showHidden);
    } catch (err) {
      handlers.setStatus("导入失败：" + String(err));
      showToast("导入失败：" + String(err), "error");
    }
  }

  // 文件图标
  function fileIcon(n: FlatNode): string {
    if (n.isMd) return "📄";
    const ext = n.name.slice(n.name.lastIndexOf(".") + 1).toLowerCase();
    if (["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico", "avif"].includes(ext)) return "🖼";
    return "📎";
  }
  function fmtSize(n: FlatNode): string {
    if (!n.size) return "";
    const s = n.size;
    if (s < 1024) return s + "B";
    if (s < 1024 * 1024) return (s / 1024).toFixed(1) + "KB";
    return (s / 1024 / 1024).toFixed(1) + "MB";
  }
  function fmtTime(n: FlatNode): string {
    if (!n.mtime) return "";
    const d = new Date(n.mtime * 1000);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    return sameDay ? d.toTimeString().slice(0, 5) : `${d.getMonth() + 1}/${d.getDate()}`;
  }
</script>

<aside class="sidebar" style="width:{sidebarWidth}px">
  <div class="panel-head">
    <span style="flex:1" />
    <button on:click={() => addRoot()} title="添加文件夹为根目录">＋</button>
    <button on:click={() => newFileIn(newTargetDir())} title="新建笔记（在当前上下文文件夹下创建）">📄+</button>
    <button on:click={() => newFolderIn(newTargetDir())} title="新建文件夹（在当前上下文文件夹下创建）">+</button>
    <button on:click={doRefreshTree} title="刷新目录">↻</button>
    <button
      on:click={toggleHiddenItems}
      class:on={state.showHidden}
      title="显示隐藏项（以 . 开头的文件/文件夹）">👁</button>
    <button
      on:click={() => (showHiddenManage = true)}
      class:on={showHiddenManage || hiddenPaths.length > 0}
      title="隐藏文件/文件夹管理（含取消隐藏）">隐</button>
    <button on:click={() => dispatch("collapse")} title="折叠">‹</button>
    <button
      on:click={locateCurrent}
      disabled={!currentPath}
      title="在树中定位当前文件">⌖</button>
  </div>

  <div class="tree-filter">
    <input
      type="text"
      placeholder="过滤文件名…"
      value={state.filter}
      on:input={onFilterInput}
    />
    {#if state.filter}
      <button class="tree-filter-clear" title="清除过滤 (Esc)" on:click={() => store.setFilter("")}>✕</button>
    {/if}
    <span class="sort-wrap">
      <button class="tree-sort-btn" class:on={sortOpen} title="排序方式" on:click={() => (sortOpen = !sortOpen)}>⇅</button>
      {#if sortOpen}
        <div class="sort-pop">
          {#each SORT_OPTIONS as o}
            <button class="sort-item" class:on={state.sort === o.key} on:click={() => pickSort(o.key)}>{o.label}</button>
          {/each}
        </div>
      {/if}
    </span>
  </div>

  {#if crumbs.length}
    <div class="tree-crumbs">
      {#each crumbs as c, i}
        <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
        <span class="crumb" class:last={i === crumbs.length - 1} on:click={() => jumpCrumb(c.path)} title={c.path} role="button" tabindex="-1">{c.name}</span>
        {#if i < crumbs.length - 1}<span class="crumb-sep">›</span>{/if}
      {/each}
    </div>
  {/if}

  <!-- svelte-ignore a11y-no-noninteractive-element-interactions a11y-no-noninteractive-tabindex -->
  <ul
    bind:this={listEl}
    bind:clientHeight={treeViewportH}
    on:scroll={onTreeScroll}
    on:keydown={onListKeydown}
    tabindex="0"
  >
    {#if flatTree.length}
      {#if treeVirtual && treeRange.top > 0}
        <li class="vsp" style="height:{treeRange.top}px" aria-hidden="true"></li>
      {/if}
      {#each flatTree.slice(treeRange.s, treeRange.e) as node (node.path + "|" + node.kind)}
        {#if node.kind === "loading"}
          <li class="hint" style="padding-left:{6 + node.depth * 18}px">⟳ {node.name}</li>
        {:else if node.kind === "hint"}
          <li class="hint" style="padding-left:{6 + node.depth * 18}px">{node.name}</li>
        {:else if node.kind === "error"}
          <li class="tree-err" style="padding-left:{6 + node.depth * 18}px">
            <span title={node.error ?? ""}>⚠ {node.name}</span>
            <button class="mini" title="重试" on:click|stopPropagation={() => reloadFolder(store, node.path, state.showHidden)}>↻</button>
          </li>
        {:else if node.kind === "folder"}
          <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
          <li
            class="folder"
            class:root={node.isRoot}
            class:focused={focusIndex >= 0 && flatTree[focusIndex] === node}
            class:selected={selection.has(node.path)}
            class:dragover={dragOverPath === node.path}
            data-path={node.path}
            style="--depth:{node.depth}; padding-left:{6 + node.depth * 18}px"
            on:pointerdown={(e) => onPointerDown(e, node.path)}
            on:click={(e) => onNodeClick(node, e)}
            on:contextmenu={(e) => onNodeContext(e, node)}
          >
            <span class="fold">{node.expanded ? "▾" : "▸"}</span>
            <span class="fname">{node.name}</span>
            <span class="factions">
              <button class="mini" title="新建笔记" on:click|stopPropagation={() => newFileIn(node.path)}>📄</button>
              <button class="mini" title="新建文件夹" on:click|stopPropagation={() => newFolderIn(node.path)}>📁</button>
            </span>
          </li>
        {:else if node.kind === "remote"}
          <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
          <li
            class="remote"
            on:click={() => openRemote(node)}
            on:contextmenu={(e) => openCtx(e, "file", node.path, node.name)}
          >
            <span class="ficon">🔎</span>
            <span class="fnm" title={node.remoteRel}>{node.name}</span>
            <span class="remote-rel">{node.remoteRel}</span>
          </li>
        {:else}
          <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
          <li
            class="file"
            class:active={currentPath === norm(node.path)}
            class:focused={focusIndex >= 0 && flatTree[focusIndex] === node}
            class:selected={selection.has(node.path) && currentPath !== norm(node.path)}
            data-path={node.path}
            style="--depth:{node.depth}; padding-left:{6 + node.depth * 18}px"
            on:pointerdown={(e) => onPointerDown(e, node.path)}
            on:click={(e) => onNodeClick(node, e)}
            on:contextmenu={(e) => onNodeContext(e, node)}
            title={node.name + (node.size ? "\n" + fmtSize(node) : "") + (node.mtime ? "\n修改于 " + new Date(node.mtime * 1000).toLocaleString() : "")}
          >
            <span class="ficon">{fileIcon(node)}</span>
            <span class="fnm">
              {#if renaming && renaming.path === node.path}
                <input
                  class="rename-input"
                  bind:value={renameValue}
                  on:keydown={onRenameKeydown}
                  on:blur={() => commitRename()}
                  on:click|stopPropagation
                  on:contextmenu|stopPropagation
                />
              {:else}
                {node.name}
              {/if}
            </span>
            {#if currentPath === norm(node.path)}
              <span class="cur-mark" title="当前打开">●</span>
            {/if}
          </li>
        {/if}
      {/each}
      {#if treeVirtual && treeRange.bottom > 0}
        <li class="vsp" style="height:{treeRange.bottom}px" aria-hidden="true"></li>
      {/if}
      {#if remoteRows.length || remoteSearching}
        <li class="remote-divider">
          {#if remoteSearching}正在搜索未加载目录…{:else}未加载目录中的匹配（{remoteRows.length}{remoteTruncated ? "+" : ""}）{/if}
        </li>
        {#each remoteRows as node (node.path)}
          <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
          <li class="remote" on:click={() => openRemote(node)}>
            <span class="ficon">🔎</span>
            <span class="fnm" title={node.remoteRel}>{node.name}</span>
            <span class="remote-rel">{node.remoteRel}</span>
          </li>
        {/each}
        {#if remoteTruncated}
          <li class="hint">仅显示前 50 条，请细化过滤词</li>
        {/if}
      {/if}
    {:else}
      {#if state.rootPaths.length}
        <li class="hint">{state.filter ? "无匹配" : "打开文件夹后显示 .md 列表"}</li>
      {:else}
        <li class="hint empty">
          <div class="empty-ic">📂</div>
          <div>尚未打开文件夹</div>
          <button class="empty-btn" on:click={addRoot}>打开文件夹</button>
          <div class="empty-kbd">Ctrl+Shift+O</div>
        </li>
      {/if}
    {/if}
  </ul>

  <div class="tree-status">
    <span class="ts-count" title="当前列表项数">{flatTree.length} 项</span>
    <span class="ts-spacer" />
    {#if state.rootPaths.length}
      <button
        class="ts-btn"
        class:on={state.showNonMd}
        title="显示资源文件（非 .md 附件）"
        on:click={toggleShowNonMd}>资源</button>
      <button class="ts-btn" title="全部折叠" on:click={collapseAll}>⤢</button>
      <button
        class="ts-btn"
        class:on={watchOn}
        title={watchBusy ? "正在启动监视…" : watchOn ? "目录监视中：外部变更自动刷新（点击暂停）" : "目录监视已暂停（点击开启）"}
        on:click={toggleWatch}>{watchOn ? "👁" : "🚫"}</button>
    {/if}
  </div>

  {#if ctxMenu}
    <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
    <div class="ctx-overlay" on:click={closeCtx} on:contextmenu|preventDefault={closeCtx}>
      <!-- svelte-ignore a11y-click-events-have-key-events -->
      <div
        class="ctx-menu"
        style="top:{ctxMenu.y}px;left:{ctxMenu.x}px"
        on:click|stopPropagation
        on:contextmenu|preventDefault|stopPropagation
      >
        <div class="ctx-title" title={ctxMenu.path}>
          {ctxMenu.kind === "multi" ? `${selection.size} 项` : ctxMenu.name}
        </div>
        {#if ctxMenu.kind === "root"}
          <button class="ctx-item" on:click={ctxNewFile}>📄 新建笔记</button>
          <button class="ctx-item" on:click={ctxNewFolder}>📁 新建文件夹</button>
          <button class="ctx-item" on:click={ctxRefreshFolder}>↻ 刷新此根</button>
          <div class="ctx-sep" />
          <button class="ctx-item" on:click={ctxAddRoot}>＋ 添加文件夹为根</button>
          <button class="ctx-item danger" on:click={ctxRemoveRoot}>✕ 移除根目录</button>
        {:else if ctxMenu.kind === "folder"}
          <button class="ctx-item" on:click={ctxNewFile}>📄 新建笔记</button>
          <button class="ctx-item" on:click={ctxNewFolder}>📁 新建文件夹</button>
          <button class="ctx-item" on:click={ctxRename}>✎ 重命名</button>
          <button class="ctx-item" on:click={ctxReveal}>📂 在资源管理器打开</button>
          <button class="ctx-item" on:click={ctxRefreshFolder}>↻ 刷新</button>
          <div class="ctx-sep" />
        {:else if ctxMenu.kind === "file"}
          <button class="ctx-item" on:click={ctxOpen}>📂 打开</button>
          <button class="ctx-item" on:click={ctxRename}>✎ 重命名</button>
          <button class="ctx-item" on:click={ctxReveal}>📂 在资源管理器打开</button>
          <div class="ctx-sep" />
          <button class="ctx-item" on:click={ctxNewFile}>📄 新建笔记</button>
          <button class="ctx-item" on:click={ctxNewFolder}>📁 新建文件夹</button>
          <div class="ctx-sep" />
        {:else}
          <button class="ctx-item" on:click={ctxCopy}>📋 复制到…</button>
          <button class="ctx-item" on:click={ctxMove}>➡ 移动到…</button>
          <div class="ctx-sep" />
          <button class="ctx-item" on:click={ctxHide}>🙈 隐藏</button>
          <div class="ctx-sep" />
          <button class="ctx-item danger" on:click={ctxDelete}>🗑 删除</button>
        {/if}
        {#if ctxMenu.kind !== "multi"}
          <button class="ctx-item" on:click={ctxCopy}>📋 复制到…</button>
          <button class="ctx-item" on:click={ctxMove}>➡ 移动到…</button>
          <div class="ctx-sep" />
          <button class="ctx-item" on:click={ctxHide}>🙈 隐藏</button>
          <div class="ctx-sep" />
          <button class="ctx-item danger" on:click={ctxDelete}>🗑 删除</button>
        {/if}
      </div>
    </div>
  {/if}

  {#if showHiddenManage}
    <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
    <div class="hm-mask" on:click={() => (showHiddenManage = false)}>
      <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
      <div class="hm-pop" on:click|stopPropagation>
        <div class="hm-title">隐藏文件 / 文件夹管理</div>
        {#if hiddenPaths.length === 0}
          <div class="hm-empty">暂无隐藏项。
在文件树中右键文件或文件夹，选择「🙈 隐藏」即可隐藏。</div>
        {:else}
          <div class="hm-list">
            {#each hiddenPaths as hp}
              <div class="hm-row">
                <span class="hm-path" title={hp}>{hp}</span>
                <button class="hm-unhide" on:click={() => unhidePath(hp)}>取消隐藏</button>
              </div>
            {/each}
          </div>
        {/if}
        <div class="hm-actions">
          <button class="cm-btn hm-close" on:click={() => (showHiddenManage = false)}>关闭</button>
        </div>
      </div>
    </div>
  {/if}
</aside>
