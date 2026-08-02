<script lang="ts">
  import { onMount } from "svelte";
  import MarkdownIt from "markdown-it";
  import { convertFileSrc } from "@tauri-apps/api/core";
  import SettingsModal from "./SettingsModal.svelte";
  import FolderSearch from "./FolderSearch.svelte";
    import PromptModal from "./PromptModal.svelte";
  import ConfirmModal from "./ConfirmModal.svelte";
  import { initHighlight, highlightCode, setOnLangLoaded } from "./highlight";
  import {
    createEditor,
    setAppearance,
    setKeymap,
    setDoc,
    wrapSelection,
    toggleLinePrefix,
    insertLink,
    insertImage,
    insertCodeBlock,
    insertTable,
    addTableColumn,
    setHeading,
    toParagraph,
    undo,
    redo,
    wrapHtmlSpan,
    setTableColumnAlign,
    setOrderedList,
    detectMarkers,
    applyMarkers,
    gotoLine,
  } from "./editor";
  import {
    pickOpenFile,
    readFile,
    pickOpenFolder,
    readMdTree,
    createFile,
    createDir,
    deletePath,
    movePath,
    copyPath,
    writeFile,
    pickSaveFile,
    pickImageFile,
    importAsset,
    importAssetBytes,
    listMdFiles,
    cleanupOrphans,
    exportHtml,
    settingsFilePath,
  } from "./fs";
  import type { FolderNode } from "./fs";
  import {
    loadSettings,
    persistSettings,
    initSettingsBridge,
    matchAccel,
    displayAccel,
    toCmKey,
    DEFAULT_SETTINGS,
    DEFAULT_SHORTCUTS,
    ALL_ACTIONS,
    FONT_SIZE_MIN,
    FONT_SIZE_MAX,
    type Settings,
  } from "./settings";
  import { settingsBridge } from "./settings-store";

  // Tauri 窗口 API（生产环境更新标题 + 关闭拦截）
  let tauriWindow: { setTitle(t: string): Promise<void>; onCloseRequested(cb: (e: any) => void): Promise<() => void> } | null = null;

  // 设置持久化桥接（Tauri invoke；浏览器调试自动回退 localStorage）
  initSettingsBridge(settingsBridge);

  // 快捷键 -> CodeMirror key 映射（编辑动作：撤销/重做/查找/替换/加粗…）
  const cmKeysOf = (shortcuts: Record<string, string>) => {
    const out: Record<string, string> = {};
    for (const a of ALL_ACTIONS) {
      if (a.scope !== "editor") continue;
      const accel = shortcuts[a.id] ?? DEFAULT_SHORTCUTS[a.id];
      const key = toCmKey(accel);
      if (key) out[a.id] = key;
    }
    return out;
  };

  const md = new MarkdownIt({
    html: true,
    linkify: true,
    highlight: (code, lang) => highlightCode(code, lang),
  });

  // 图片渲染：本地绝对路径转 Tauri asset 协议 URL，预览区才能加载
  const defaultImageRender =
    md.renderer.rules.image ||
    ((tokens: any, idx: number, options: any, _env: any, self: any) =>
      self.renderToken(tokens, idx, options));
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const srcIndex = token.attrIndex("src");
    if (srcIndex >= 0) {
      let src = token.attrs![srcIndex][1];
      // markdown-it 会把 \ 编码为 %5C、空格编码为 %20、中文转为 percent-encoding；
      // 先解码还原真实路径，再判断是否为本地绝对路径
      try {
        src = decodeURIComponent(src);
      } catch {
        /* 解码失败保持原样 */
      }
      // 相对路径（收编后的 assets/xxx）：按当前笔记所在目录拼成绝对路径后再转换
      const isRemote = /^(https?:|data:|blob:)/.test(src);
      if (!isRemote && !/^([A-Za-z]:[\\/]|\/)/.test(src) && currentPath) {
        src = dirname(currentPath) + "/" + src;
      }
      // 本地绝对路径（Windows 盘符或 Unix / 开头）转 asset URL
      if (/^([A-Za-z]:[\\/]|\/)/.test(src)) {
        token.attrs![srcIndex][1] = convertFileSrc(src);
      }
    }
    return defaultImageRender(tokens, idx, options, env, self);
  };

  let source = `# 欢迎使用 LiteMD

- 左侧：文件目录（二级文件夹结构）
- 中间：Markdown 编辑器（CodeMirror 6）
- 右侧：实时预览（markdown-it）

> 超轻量 Markdown 编辑器，Rust + Tauri 构建。

\`\`\`js
console.log("Hello LiteMD");
\`\`\`
`;

  // ---- 设置 ----
  let settings: Settings = { ...DEFAULT_SETTINGS, shortcuts: { ...DEFAULT_SHORTCUTS } };
  let configPath = "";
  let showSettings = false;

  // ---- 运行时布局（settings 里的同名字段是「启动时」默认值）----
  let showTree = true;
  let showPreview = true;
  let focusMode = false;
  let beforeFocus = { tree: true, preview: true };

  let view: ReturnType<typeof createEditor> | undefined;
  let editorHost: HTMLDivElement;
  let previewHost: HTMLDivElement;
  let hlReady = false;

  // ---- 文件状态 ----
  let currentPath: string | null = null;
  let tree: FolderNode[] = [];
  let collapsed = new Set<string>(); // 已折叠的文件夹路径（默认全部展开）
  let status = "就绪";
  let menuOpen = false;
  
    // ---- 格式刷 / 调色板 / 跨文件搜索 状态 ----
    let painter: { markers: string[]; locked: boolean } | null = null;
    let colorMenu: { type: "fg" | "bg" } | null = null;
    let showFolderSearch = false;

    // ---- 自定义输入对话框（替代 window.prompt，避免标题栏出现 tauri.localhost）----
    type PromptResult = { name: string; path: string };
    let promptState: {
      title: string;
      label: string;
      value: string;
      path: string;
      resolve: (v: PromptResult | null) => void;
    } | null = null;

    function askPrompt(opts: { title: string; label: string; value: string; path: string }): Promise<PromptResult | null> {
      return new Promise((resolve) => {
        promptState = { ...opts, resolve };
      });
    }
    function onPromptConfirm(e: CustomEvent<PromptResult>) {
      promptState?.resolve(e.detail);
      promptState = null;
    }
    function onPromptCancel() {
      promptState?.resolve(null);
      promptState = null;
    }
    // 浏览按钮：调系统文件夹选择器修改保存路径
    async function onPromptBrowse() {
      if (!promptState) return;
      const folder = await pickOpenFolder();
      if (folder && promptState) {
        promptState = { ...promptState, path: folder };
      }
    }

    // ---- 自定义确认对话框（替代 window.confirm，避免 tauri.localhost）----
    let confirmState: {
      title: string;
      message: string;
      confirmText: string;
      danger: boolean;
      resolve: (ok: boolean) => void;
    } | null = null;

    function askConfirm(opts: { title: string; message: string; confirmText?: string; danger?: boolean }): Promise<boolean> {
      return new Promise((resolve) => {
        confirmState = {
          title: opts.title,
          message: opts.message,
          confirmText: opts.confirmText ?? "确定",
          danger: opts.danger ?? false,
          resolve,
        };
      });
    }
    function onConfirmYes() {
      confirmState?.resolve(true);
      confirmState = null;
    }
    function onConfirmNo() {
      confirmState?.resolve(false);
      confirmState = null;
    }

    // ---- 文件树右键菜单（删除 / 移动 / 复制）----
    let ctxMenu: { x: number; y: number; kind: "file" | "folder"; path: string; name: string } | null = null;

    function openCtx(e: MouseEvent, kind: "file" | "folder", path: string, name: string) {
      e.preventDefault();
      ctxMenu = { x: e.clientX, y: e.clientY, kind, path, name };
    }
    function closeCtx() {
      ctxMenu = null;
    }

    // 右键菜单中需要读取当前节点路径的快捷动作（模板表达式不支持 TS 断言，故用函数包装）
    function ctxNewFile() {
      const p = ctxMenu?.path;
      closeCtx();
      if (p) newFileIn(p);
    }
    function ctxNewFolder() {
      const p = ctxMenu?.path;
      closeCtx();
      if (p) newFolderIn(p);
    }
    function ctxOpen() {
      const p = ctxMenu?.path;
      closeCtx();
      if (p) openFileByPath(p);
    }

    async function ctxCopy() {
      const c = ctxMenu;
      ctxMenu = null;
      if (!c) return;
      const dest = await pickOpenFolder();
      if (!dest) {
        status = "已取消复制";
        return;
      }
      try {
        await copyPath(c.path, dest);
        status = `已复制 ${c.name} 到 ${dest}`;
        await refreshTree();
      } catch (e) {
        status = "复制失败：" + String(e);
      }
    }

    async function ctxMove() {
      const c = ctxMenu;
      ctxMenu = null;
      if (!c) return;
      const dest = await pickOpenFolder();
      if (!dest) {
        status = "已取消移动";
        return;
      }
      try {
        const newPath = await movePath(c.path, dest);
        // 若移动的是当前打开的文件，更新 currentPath，让后续保存落到新位置
        if (c.kind === "file" && currentPath === c.path) {
          currentPath = newPath;
          settings.lastFile = newPath;
          persist();
          updateTitle();
        }
        status = `已移动 ${c.name} 到 ${dest}`;
        await refreshTree();
      } catch (e) {
        status = "移动失败：" + String(e);
      }
    }

    async function ctxDelete() {
      const c = ctxMenu;
      ctxMenu = null;
      if (!c) return;
      const ok = await askConfirm({
        title: "删除确认",
        message:
          c.kind === "folder"
            ? `确定要删除文件夹「${c.name}」及其全部内容吗？此操作不可撤销。`
            : `确定要删除文件「${c.name}」吗？此操作不可撤销。`,
        confirmText: "删除",
        danger: true,
      });
      if (!ok) return;
      try {
        await deletePath(c.path);
        // 若删除的是当前打开的文件，清空编辑器并取消挂起的自动保存
        if (c.kind === "file" && currentPath === c.path) {
          if (saveTimer) {
            clearTimeout(saveTimer);
            saveTimer = null;
          }
          currentPath = null;
          if (view) setDoc(view, "");
          source = "";
          lastSaved = "";
          settings.lastFile = null;
          persist();
          updateTitle();
        }
        status = `已删除 ${c.name}`;
        await refreshTree();
      } catch (e) {
        status = "删除失败：" + String(e);
      }
    }

    // ---- 分栏拖动（侧边栏宽度 / 预览宽度）----
    let sidebarWidth = 240;
    let previewWidth = 440;
    let dragMode: "sidebar" | "preview" | null = null;
    let dragStartX = 0;
    let dragStartW = 0;

    function startDrag(mode: "sidebar" | "preview", e: MouseEvent) {
      e.preventDefault();
      dragMode = mode;
      dragStartX = e.clientX;
      dragStartW = mode === "sidebar" ? sidebarWidth : previewWidth;
    }
    function onDragMove(e: MouseEvent) {
      if (!dragMode) return;
      const dx = e.clientX - dragStartX;
      if (dragMode === "sidebar") {
        sidebarWidth = Math.max(150, Math.min(640, dragStartW + dx));
      } else {
        previewWidth = Math.max(240, Math.min(900, dragStartW - dx));
      }
    }
    function onDragEnd() {
      dragMode = null;
    }
    const PALETTE = [
      "#e53935", "#fb8c00", "#fdd835", "#43a047", "#1e88e5",
      "#8e24aa", "#6d4c41", "#546e7a", "#000000", "#ffffff",
    ];
  let lastSaved: string | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let suppressSave = false; // 打开文件时抑制自动保存

  // ---- 光标位置 ----
  let cursorLine = 1;
  let cursorCol = 1;

  // ---- 行内快捷菜单（gutter 按钮弹出）----
  let quickMenu: { top: number; left: number } | null = null;
  function onQuickAction(rect: DOMRect) {
    // 菜单出现在按钮右侧；贴近底部时向上翻转
    const menuH = 260;
    const top = rect.bottom + menuH > window.innerHeight ? rect.top - menuH : rect.bottom + 4;
    quickMenu = { top, left: rect.right + 6 };
  }
  function closeQuickMenu() {
    quickMenu = null;
  }
  function quickHeading(level: number) {
    if (view) setHeading(view, level);
    closeQuickMenu();
  }
  function quickParagraph() {
    if (view) toParagraph(view);
    closeQuickMenu();
  }
  function quickBold() {
    if (view) wrapSelection(view, "**");
    closeQuickMenu();
  }
  function quickCodeBlock() {
    codeBlock();
    closeQuickMenu();
  }

  // ---- 未保存标记 ----
  $: dirty = lastSaved !== null && source !== lastSaved;

  // 高亮引擎异步就绪后重跑一次渲染；预览渲染防抖 200ms
  let rendered = "";
  let renderTimer: ReturnType<typeof setTimeout> | null = null;
  let hlVersion = 0; // 语言包加载完成后自增，触发重渲染
  setOnLangLoaded(() => { hlVersion++; });
  $: scheduleRender(source, hlReady, hlVersion, currentPath);
  function scheduleRender(text: string, _ready: boolean, _ver: number, _path: string | null) {
    if (renderTimer) clearTimeout(renderTimer);
    renderTimer = setTimeout(() => {
      rendered = renderTaskLists(md.render(text));
    }, 200);
  }

  // 任务列表：- [ ] / - [x] 渲染为复选框
  function renderTaskLists(html: string): string {
    return html
      .replace(/<li>\[ \] /g, '<li class="task"><input type="checkbox" disabled> ')
      .replace(/<li>\[[xX]\] /g, '<li class="task"><input type="checkbox" checked disabled> ');
  }

  // ---- 字数 / 字符统计（CJK 按字计，拉丁按词计）----
  $: stats = computeStats(source);
  function computeStats(text: string) {
    const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
    const latin = (text
      .replace(/[\u4e00-\u9fff\u3400-\u4dbf]/g, " ")
      .match(/[A-Za-z0-9]+/g) || []).length;
    return { words: cjk + latin, chars: text.replace(/\n/g, "").length };
  }

  function basename(p: string): string {
    return p.split(/[\\/]/).pop() || p;
  }

  function dirname(p: string): string {
    return p.replace(/[\\/][^\\/]+$/, "") || p;
  }

  function persist() {
    persistSettings(settings);
  }

  function updateTitle() {
    const name = currentPath ? basename(currentPath) : "未命名.md";
    const title = dirty ? `${name} ● - LiteMD` : `${name} - LiteMD`;
    tauriWindow?.setTitle(title);
  }

  // 未保存状态变化时同步标题
  $: if (dirty !== undefined) updateTitle();

  function applyAppearance() {
    document.documentElement.dataset.theme = settings.theme;
    if (view) setAppearance(view, settings.theme === "dark", settings.fontSize);
  }

  onMount(() => {
    let disposed = false;

    // 初始化 Tauri 窗口 API
    import("@tauri-apps/api/window").then((mod) => {
      tauriWindow = mod.getCurrentWindow() as any;
      // 关闭拦截：未保存时确认
      tauriWindow.onCloseRequested((e: any) => {
        // 先拦截（阻止默认关闭），再走统一确认流程（兼容 Alt+F4 等系统关闭）
        e.preventDefault();
        // 延迟到事件处理结束后再弹同步确认框，避免阻塞关闭事件回调
        setTimeout(() => requestClose(), 0);
      }).then((fn) => { unlistenClose = fn; }).catch(() => {});
      // 拖拽文件到窗口：.md 直接打开；图片文件收编并插入
      // 注意：getCurrentWindow().onDragDropEvent 的数据在 e.payload 里（payload.type / payload.paths），
      // 顶层没有 type/paths 字段——直接读 e.type 会永远为 undefined 导致拖拽失效。
      (tauriWindow as any).onDragDropEvent((e: any) => {
        const payload = e?.payload;
        if (payload?.type === "drop" && payload.paths?.length) {
          const paths: string[] = payload.paths;
          const mdFile = paths.find((p: string) => /\.(md|markdown)$/i.test(p));
          if (mdFile) { openFileByPath(mdFile); return; }
          const imgFile = paths.find((p: string) => /\.(png|jpe?g|gif|webp|bmp|svg|ico)$/i.test(p));
          if (imgFile) void insertImageByPath(imgFile);
        }
      }).then((fn: () => void) => { unlistenDrop = fn; }).catch(() => {});
    }).catch(() => {
      // 浏览器调试模式，无 Tauri 窗口 API
    });

    // 粘贴图片：窗口级拦截（仅当剪贴板含图片时生效）
    window.addEventListener("paste", onPaste);

    let unlistenClose: (() => void) | null = null;
    let unlistenDrop: (() => void) | null = null;

    (async () => {
      settings = await loadSettings();
      if (disposed) return;

      showTree = settings.showTree;
      showPreview = settings.showPreview;
      document.documentElement.dataset.theme = settings.theme;

      view = createEditor({
        parent: editorHost,
        doc: source,
        dark: settings.theme === "dark",
        fontSize: settings.fontSize,
        cmKeys: cmKeysOf(settings.shortcuts),
        onChange: (v) => (source = v),
        onCursor: (l, c) => { cursorLine = l; cursorCol = c; },
        onQuickAction,
      });
      lastSaved = source;

      // 滚动同步：编辑器 → 预览（按比例单向，避免反馈循环）
      view.scrollDOM.addEventListener("scroll", () => {
        if (!showPreview || !previewHost) return;
        const scroller = view!.scrollDOM;
        const max = scroller.scrollHeight - scroller.clientHeight;
        if (max <= 0) return;
        const ratio = scroller.scrollTop / max;
        const pMax = previewHost.scrollHeight - previewHost.clientHeight;
        previewHost.scrollTop = ratio * pMax;
      });

      // 恢复上次的目录与文件
      if (settings.lastFolder) {
        try {
          tree = await readMdTree(settings.lastFolder);
        } catch {
          settings.lastFolder = null;
        }
      }
      if (settings.lastFile) {
        try {
          const content = await readFile(settings.lastFile);
          currentPath = settings.lastFile;
          setDoc(view, content);
          lastSaved = content;
          status = "已恢复 " + basename(settings.lastFile);
        } catch {
          settings.lastFile = null;
        }
      }

      configPath = await settingsFilePath();
      await initHighlight();
      if (!disposed) hlReady = true;
    })();

    return () => {
      disposed = true;
      view?.destroy();
      unlistenClose?.();
      unlistenDrop?.();
      window.removeEventListener("paste", onPaste);
    };
  });

  // ---------- 设置变更 ----------
  function onSettingsChange() {
    applyAppearance();
    if (view) setKeymap(view, cmKeysOf(settings.shortcuts));
    persist();
  }

  function bumpFont(delta: number) {
    const next = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, settings.fontSize + delta));
    if (next === settings.fontSize) return;
    settings.fontSize = next;
    applyAppearance();
    persist();
    status = `字号 ${next}px`;
  }

  function toggleTheme() {
    settings.theme = settings.theme === "dark" ? "light" : "dark";
    applyAppearance();
    persist();
  }

  function toggleFocus() {
    if (!focusMode) {
      beforeFocus = { tree: showTree, preview: showPreview };
      showTree = false;
      showPreview = false;
      focusMode = true;
      status = "专注模式（再按一次退出）";
    } else {
      showTree = beforeFocus.tree;
      showPreview = beforeFocus.preview;
      focusMode = false;
      status = "已退出专注模式";
    }
  }

  // ---------- 文件操作 ----------
  async function openFile() {
    const p = await pickOpenFile();
    if (!p) return;
    await openFileByPath(p);
  }

  async function openFileByPath(p: string) {
    const content = await readFile(p);
    currentPath = p;
    suppressSave = true;
    if (view) setDoc(view, content);
    source = content;
    lastSaved = content;
    suppressSave = false;
    settings.lastFile = p;
    // 更新最近打开列表（去重，新的在前，最多 5 个）
    settings.recentFiles = [p, ...settings.recentFiles.filter((f) => f !== p)].slice(0, 5);
    persist();
    status = "已打开 " + basename(p);
    updateTitle();
  }

  async function openFolder() {
    const folder = await pickOpenFolder();
    if (!folder) return;
    await loadFolder(folder);
  }

  async function loadFolder(folder: string) {
    tree = await readMdTree(folder);
    settings.lastFolder = folder;
    persist();
    status = tree.length === 0 ? "该文件夹下未找到 .md" : "已加载目录 " + basename(folder);
  }

  async function refreshTree() {
    if (!settings.lastFolder) {
      status = "尚未打开文件夹";
      return;
    }
    try {
      tree = await readMdTree(settings.lastFolder);
      status = "目录已刷新";
    } catch {
      status = "刷新失败：目录不可读";
    }
  }

  // ---- 文件树扁平化（递归树 → 带深度的平铺列表，供模板渲染）----
  interface FlatNode {
    kind: "folder" | "file";
    name: string;
    path: string;
    depth: number;
    expanded: boolean;
  }

  function flattenTree(nodes: FolderNode[], collapsedSet: Set<string>, depth = 0): FlatNode[] {
    const out: FlatNode[] = [];
    for (const folder of nodes) {
      const expanded = !collapsedSet.has(folder.path);
      out.push({ kind: "folder", name: folder.name, path: folder.path, depth, expanded });
      if (expanded) {
        for (const file of folder.files) {
          out.push({ kind: "file", name: file.name, path: file.path, depth: depth + 1, expanded: false });
        }
        out.push(...flattenTree(folder.children, collapsedSet, depth + 1));
      }
    }
    return out;
  }

  let flatTree: FlatNode[] = [];
  $: flatTree = flattenTree(tree, collapsed);

  function toggleFolder(path: string) {
    const next = new Set(collapsed);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    collapsed = next;
  }

  // ---- 新建文件 / 文件夹（落盘到默认目录并刷新树）----
  // 若尚未打开文件夹，先弹出选择框让用户选一个，选好后继续新建
  async function ensureFolder(): Promise<string | null> {
    if (settings.lastFolder) return settings.lastFolder;
    const folder = await pickOpenFolder();
    if (!folder) return null;
    await loadFolder(folder);
    return folder;
  }

  // 新建文件/文件夹后让其在树中可见：
  // 若位于当前打开文件夹内，仅刷新树；否则把树根切换到新路径。
  async function revealCreated(usedPath: string) {
    const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const root = settings.lastFolder ? norm(settings.lastFolder) : "";
    const used = norm(usedPath);
    if (root && (used === root || used.startsWith(root + "/"))) {
      await refreshTree();
    } else {
      await loadFolder(usedPath);
    }
  }

  async function newFileIn(dir: string | null) {
    const target0 = dir ?? (await ensureFolder());
    if (!target0) {
      status = "未选择文件夹，已取消新建";
      return;
    }
    const res = await askPrompt({ title: "新建笔记", label: "笔记名", value: "未命名.md", path: target0 });
    if (!res || !res.name.trim()) return;
    const target = res.path.trim() || target0;
    const fname = /\.md$/i.test(res.name.trim()) ? res.name.trim() : res.name.trim() + ".md";
    try {
      await createFile(`${target}/${fname}`);
      status = "已新建 " + fname;
      await revealCreated(target);
    } catch (e) {
      status = "新建失败：" + String(e);
    }
  }

  async function newFolderIn(dir: string | null) {
    const target0 = dir ?? (await ensureFolder());
    if (!target0) {
      status = "未选择文件夹，已取消新建";
      return;
    }
    const res = await askPrompt({ title: "新建文件夹", label: "文件夹名", value: "新建文件夹", path: target0 });
    if (!res || !res.name.trim()) return;
    const target = res.path.trim() || target0;
    const fname = res.name.trim();
    try {
      await createDir(`${target}/${fname}`);
      status = "已新建文件夹 " + fname;
      // 展开父文件夹，让新建的文件夹可见
      if (collapsed.has(target)) {
        const next = new Set(collapsed);
        next.delete(target);
        collapsed = next;
      }
      await revealCreated(target);
    } catch (e) {
      status = "新建失败：" + String(e);
    }
  }

  async function save() {
    if (!currentPath) return saveAs();
    await writeFile(currentPath, source);
    lastSaved = source;
    status = "已保存 " + basename(currentPath);
    updateTitle();
  }

  async function saveAs() {
    const p = await pickSaveFile();
    if (!p) return;
    await writeFile(p, source);
    currentPath = p;
    lastSaved = source;
    settings.lastFile = p;
    persist();
    status = "已保存 " + basename(p);
    updateTitle();
  }

  async function exportDoc() {
    const p = await pickSaveFile();
    if (!p) return;
    const title = currentPath ? basename(currentPath) : "document";
    const full = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body{max-width:780px;margin:40px auto;padding:0 20px;font-family:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;line-height:1.7;color:#1f2329}
  pre{background:#f7f8f9;border:1px solid #e5e7eb;border-radius:6px;padding:12px;overflow:auto}
  code{font-family:"JetBrains Mono",Consolas,monospace;font-size:13px}
  blockquote{border-left:3px solid #0f6e56;margin:0;padding-left:12px;color:#5f5e5a}
  a{color:#0f6e56}
</style>
</head>
<body>
${md.render(source)}
</body>
</html>`;
    await exportHtml(p, full);
    status = "已导出 " + basename(p);
  }

  // ---------- 自动保存 ----------
  $: queueAutoSave(source, settings);

  function queueAutoSave(text: string, cfg: Settings) {
    if (!cfg.autoSave || !currentPath || suppressSave) return;
    if (text === lastSaved) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      if (!currentPath || suppressSave) return;
      try {
        await writeFile(currentPath, text);
        lastSaved = text;
        status = "已自动保存";
        updateTitle();
      } catch (e) {
        status = "自动保存失败：" + String(e);
      }
    }, cfg.autoSaveDelay);
  }

  // ---------- 工具栏命令 ----------
  const bold = () => view && wrapSelection(view, "**");
  const italic = () => view && wrapSelection(view, "*");
  const underline = () => view && wrapSelection(view, "__");
  const strike = () => view && wrapSelection(view, "~~");
  const h1 = () => view && toggleLinePrefix(view, "# ");
  const ul = () => view && toggleLinePrefix(view, "- ");
  const ol = () => view && toggleLinePrefix(view, "1. ");
  const task = () => view && toggleLinePrefix(view, "- [ ] ");
  const quote = () => view && toggleLinePrefix(view, "> ");
  const link = () => view && insertLink(view);

  // ---------- 撤销 / 重做（工具栏按钮）----------
  const doUndo = () => view && undo(view);
  const doRedo = () => view && redo(view);

  // ---------- 格式刷：单击采样并应用一次；双击锁定多次；Esc 退出 ----------
  function armPainter(locked: boolean) {
    if (!view) return;
    const markers = detectMarkers(view);
    if (!markers.length) {
      status = "未检测到格式（请先选中加粗/斜体等文本）";
      return;
    }
    painter = { markers, locked };
    status = locked ? "格式刷已固定：连续选择目标文本应用（Esc 退出）" : "格式刷：选择目标文本应用一次";
  }

  // 编辑器内松开鼠标：若格式刷已就绪且有选区，则应用格式
  function onEditorMouseUp() {
    if (!painter || !view) return;
    const sel = view.state.selection.main;
    if (sel.empty) return;
    applyMarkers(view, painter.markers);
    if (!painter.locked) {
      painter = null;
      status = "格式刷已应用";
    } else {
      status = "格式刷：继续选择目标（Esc 退出）";
    }
  }

  // ---------- 字体颜色 / 背景颜色（HTML 内联样式）----------
  function openColorMenu(type: "fg" | "bg") {
    colorMenu = colorMenu && colorMenu.type === type ? null : { type };
  }

  function pickColor(hex: string) {
    if (!view || !colorMenu) return;
    const css = colorMenu.type === "fg" ? `color:${hex}` : `background-color:${hex}`;
    wrapHtmlSpan(view, css);
    status = colorMenu.type === "fg" ? "已设置字体颜色" : "已设置背景颜色";
    colorMenu = null;
  }

  // 自定义取色器回调（模板表达式不支持 TS as 断言，故置于 script 内）
  function onCustomColor(e: Event) {
    pickColor((e.target as HTMLInputElement).value);
  }

  // ---------- 表格列对齐 ----------
  function alignCol(align: "left" | "center" | "right") {
    if (!view) return;
    if (!setTableColumnAlign(view, align)) status = "请将光标置于表格内再设置对齐";
    else status = "已设置列对齐";
  }

  // ---------- 有序列表（Alt+Shift+1~9，数字为起始编号）----------
  function orderedList(start: number) {
    if (!view) return;
    setOrderedList(view, start);
  }

  // ---------- 跨文件查找替换 ----------
  function openFolderSearch() {
    if (!settings.lastFolder) {
      status = "请先打开文件夹再使用文件夹内查找";
      return;
    }
    showFolderSearch = true;
  }

  // 点击查找结果：打开对应文件并定位到行
  async function gotoSearchResult(e: CustomEvent<{ path: string; line: number }>) {
    const { path, line } = e.detail;
    await openFileByPath(path);
    if (view) gotoLine(view, line);
  }

  async function insertImg() {
    if (!view) return;
    const p = await pickImageFile();
    if (!p) return;
    await insertImageByPath(p);
  }

  // 统一插图：当前笔记有目录则收编（可选压缩）用相对引用；否则用绝对路径
  async function insertImageByPath(p: string) {
    if (!view) return;
    if (currentPath) {
      try {
        const rel = await importAsset(p, dirname(currentPath), settings.assetsDir, settings.compressImages, settings.jpegQuality);
        insertImage(view, rel);
        status = "图片已收编 " + basename(rel);
        return;
      } catch (e) {
        // 收编失败回退绝对路径
        insertImage(view, p);
        status = "收编失败，已插入绝对路径：" + String(e);
        return;
      }
    }
    // 未保存笔记（无目录）：插入绝对路径
    insertImage(view, p);
    status = "已插入图片 " + basename(p);
  }

  // 字节数组转 base64（分块处理，避免大图调用栈溢出）
  function uint8ToBase64(bytes: Uint8Array): string {
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  // 粘贴图片：读取剪贴板图片，收编并插入相对引用（仅已保存笔记可用）
  async function insertPastedImage(file: File) {
    if (!view) return;
    if (!currentPath) {
      status = "请先保存笔记，再粘贴图片";
      return;
    }
    try {
      const buf = await file.arrayBuffer();
      const b64 = uint8ToBase64(new Uint8Array(buf));
      const ext = (file.type.split("/")[1] || "png").replace("jpeg", "jpg");
      const rel = await importAssetBytes(dirname(currentPath), settings.assetsDir, ext, b64, settings.compressImages, settings.jpegQuality);
      insertImage(view, rel);
      status = "图片已收编 " + basename(rel);
    } catch (e) {
      status = "粘贴图片失败：" + String(e);
    }
  }

  // 窗口级粘贴监听：仅拦截含图片的剪贴板，文本粘贴照常交给 CodeMirror
  function onPaste(e: ClipboardEvent) {
    if (showSettings || !view) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          void insertPastedImage(file);
          return;
        }
      }
    }
  }

  // 迁移单篇内容：把绝对路径图片收编到该笔记目录下的附件文件夹，改写为相对引用
  async function migrateNoteContent(text: string, dir: string): Promise<{ text: string; count: number; failed: number }> {
    const imgRe = /!\[([^\]]*)\]\((<[^>]+>|[^)\s]+)\)/g;
    const jobs: { full: string; alt: string; src: string }[] = [];
    let m: RegExpExecArray | null;
    while ((m = imgRe.exec(text))) {
      let src = m[2];
      if (src.startsWith("<") && src.endsWith(">")) src = src.slice(1, -1);
      // 只处理本地绝对路径（盘符或 / 开头），跳过 http 与已有的相对引用
      if (/^([A-Za-z]:[\\/]|\/)/.test(src)) {
        jobs.push({ full: m[0], alt: m[1], src });
      }
    }
    let next = text;
    let count = 0;
    let failed = 0;
    for (const job of jobs) {
      try {
        const rel = await importAsset(job.src, dir, settings.assetsDir, settings.compressImages, settings.jpegQuality);
        next = next.replace(job.full, `![${job.alt}](${rel})`);
        count++;
      } catch {
        failed++;
      }
    }
    return { text: next, count, failed };
  }

  // 一键迁移：当前笔记
  async function migrateImages() {
    if (!view || !currentPath) {
      status = "请先打开并保存一篇笔记再迁移";
      return;
    }
    const res = await migrateNoteContent(source, dirname(currentPath));
    if (res.count === 0 && res.failed === 0) {
      status = "没有需要迁移的绝对路径图片";
      return;
    }
    if (res.count > 0) {
      setDoc(view, res.text);
      source = res.text;
      // lastSaved 保持旧内容 → dirty 为 true，提示用户确认后保存
      updateTitle();
    }
    status = `迁移完成：成功 ${res.count} 张${res.failed ? `，失败 ${res.failed} 张` : ""}`;
  }

  // 批量迁移：递归处理整个文件夹下所有 .md（附件分别收编到各自笔记目录）
  async function migrateFolder() {
    const root = settings.lastFolder ?? (currentPath ? dirname(currentPath) : null);
    if (!root) {
      status = "请先打开一个文件夹再批量迁移";
      return;
    }
    const ok = window.confirm(
      `将批量迁移文件夹下所有 .md 的绝对路径图片为相对引用：\n${root}\n\n会把图片复制到各自笔记的「${settings.assetsDir}/」并改写文件。确定继续？`
    );
    if (!ok) return;
    try {
      const files = await listMdFiles(root);
      let filesChanged = 0;
      let totalMigrated = 0;
      let totalFailed = 0;
      const norm = (s: string) => s.replace(/\\/g, "/").toLowerCase();
      for (const f of files) {
        try {
          const content = await readFile(f);
          const res = await migrateNoteContent(content, dirname(f));
          totalFailed += res.failed;
          if (res.count > 0) {
            await writeFile(f, res.text);
            filesChanged++;
            totalMigrated += res.count;
            // 若为当前打开的文件，同步编辑器并标记已保存（已写盘）
            if (view && currentPath && norm(f) === norm(currentPath)) {
              suppressSave = true;
              setDoc(view, res.text);
              source = res.text;
              lastSaved = res.text;
              suppressSave = false;
              updateTitle();
            }
          }
        } catch {
          totalFailed++;
        }
      }
      status = `批量迁移完成：${filesChanged} 个文件，成功 ${totalMigrated} 张${totalFailed ? `，失败 ${totalFailed} 张` : ""}`;
    } catch (e) {
      status = "批量迁移失败：" + String(e);
    }
  }

  // 清理未引用附件：递归扫描文件夹，删除每一处附件文件夹中未被任何 .md 引用的文件
  async function cleanupAssets() {
    // 优先用已打开的文件夹（递归清理各级子目录的附件）；否则回退当前笔记目录
    const dir = settings.lastFolder ?? (currentPath ? dirname(currentPath) : null);
    if (!dir) {
      status = "请先打开一篇笔记或一个文件夹";
      return;
    }
    const ok = window.confirm(
      `将递归扫描目录：\n${dir}\n\n并删除每一处「${settings.assetsDir}/」下未被任何 .md 引用的附件。\n此操作不可撤销，确定继续？`
    );
    if (!ok) return;
    try {
      const deleted = await cleanupOrphans(dir, settings.assetsDir);
      status = deleted.length
        ? `已清理 ${deleted.length} 个未引用附件`
        : "没有发现未引用的附件";
    } catch (e) {
      status = "清理失败：" + String(e);
    }
  }

  function codeBlock() {
    if (!view) return;
    insertCodeBlock(view, "");
    status = "已插入代码块";
  }

  function table() {
    if (!view) return;
    insertTable(view);
    status = "已插入表格";
  }

  function addColumn() {
    if (!view) return;
    if (addTableColumn(view)) status = "已添加一列";
  }

  function unorderedList() {
    if (!view) return;
    toggleLinePrefix(view, "- ");
    status = "无序号列表";
  }

  // ---------- 应用级快捷键（文件 / 视图，键位来自设置）----------
  function onKeydown(e: KeyboardEvent) {
    if (showSettings) return; // 设置面板自己接管键盘
    // Esc 退出格式刷（固定模式）
    if (e.key === "Escape" && painter) {
      painter = null;
      status = "已退出格式刷";
      return;
    }
    // Alt+Shift+1~9：有序列表，数字为起始编号
    if (e.altKey && e.shiftKey && !e.ctrlKey && /^Digit[1-9]$/.test(e.code)) {
      run(e, () => orderedList(parseInt(e.code.slice(5), 10)));
      return;
    }
    // Ctrl+Shift+F：文件夹内查找替换
    if (e.ctrlKey && e.shiftKey && !e.altKey && e.code === "KeyF") {
      run(e, openFolderSearch);
      return;
    }
    const s = settings.shortcuts;
    const hit = (id: string) => matchAccel(e, s[id] ?? DEFAULT_SHORTCUTS[id]);

    if (hit("file.open")) run(e, openFile);
    else if (hit("file.openFolder")) run(e, openFolder);
    else if (hit("file.save")) run(e, save);
    else if (hit("file.saveAs")) run(e, saveAs);
    else if (hit("file.export")) run(e, exportDoc);
    else if (hit("insert.image")) run(e, insertImg);
    else if (hit("insert.codeBlock")) run(e, codeBlock);
    else if (hit("insert.table")) run(e, table);
    else if (hit("table.addColumn")) run(e, addColumn);
    else if (hit("insert.bullet")) run(e, unorderedList);
    else if (hit("view.togglePreview")) run(e, () => (showPreview = !showPreview));
    else if (hit("view.focusMode")) run(e, toggleFocus);
    else if (hit("view.fontIncrease")) run(e, () => bumpFont(1));
    else if (hit("view.fontDecrease")) run(e, () => bumpFont(-1));
  }

  // 点击菜单外区域关闭文件菜单
  function onWindowClick(e: MouseEvent) {
    if (menuOpen) {
      const target = e.target as HTMLElement;
      if (!target.closest(".menu")) menuOpen = false;
    }
    if (colorMenu) {
      const target = e.target as HTMLElement;
      if (!target.closest(".color-wrap")) colorMenu = null;
    }
  }

  function run(e: KeyboardEvent, fn: () => unknown) {
    e.preventDefault();
    fn();
  }

  const accel = (id: string) => displayAccel(settings.shortcuts[id] ?? DEFAULT_SHORTCUTS[id]);

  // ---------- 自定义窗口控制（decorations: false）----------
  function winMinimize() {
    tauriWindow && (tauriWindow as any).minimize();
  }
  function winToggleMax() {
    tauriWindow && (tauriWindow as any).toggleMaximize();
  }
  function winClose() {
    requestClose();
  }

  // 统一关闭：未保存先确认，确认后 destroy() 强制关闭。
  // 不用 close()——它会被 onCloseRequested 再次拦截（双重确认甚至无法关闭）；destroy() 绕过拦截。
  function requestClose() {
    if (source !== lastSaved && currentPath) {
      const ok = window.confirm("当前文件有未保存的修改，确定要关闭吗？");
      if (!ok) return;
    }
    if (tauriWindow) {
      (tauriWindow as any).destroy().catch(() => window.close());
    } else {
      window.close();
    }
  }
  // 边缘拖动缩放窗口（decorations: false 无系统缩放边框，需手动触发）
  function winResize(direction: string) {
    tauriWindow && (tauriWindow as any).startResizeDragging(direction);
  }
</script>

<svelte:window on:keydown={onKeydown} on:click={onWindowClick} on:mousemove={onDragMove} on:mouseup={onDragEnd} />

<div class="app" class:dragging={dragMode !== null}>
  <header class="titlebar" data-tauri-drag-region>
    <span class="brand">LiteMD</span>

    <div class="menu">
      <button on:click={() => (menuOpen = !menuOpen)} title="文件">文件 ▾</button>
      {#if menuOpen}
        <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
        <div class="menu-list" on:mouseleave={() => (menuOpen = false)}>
          <div on:click={() => { menuOpen = false; openFile(); }}>
            打开文件 <span>{accel("file.open")}</span>
          </div>
          <div on:click={() => { menuOpen = false; openFolder(); }}>
            打开文件夹 <span>{accel("file.openFolder")}</span>
          </div>
          {#if settings.recentFiles.length}
            <div class="sep-line" />
            <div class="menu-header">最近打开</div>
            {#each settings.recentFiles as rf}
              <div on:click={() => { menuOpen = false; openFileByPath(rf); }} title={rf}>
                {basename(rf)}
              </div>
            {/each}
          {/if}
          <div class="sep-line" />
          <div on:click={() => { menuOpen = false; save(); }}>
            保存 <span>{accel("file.save")}</span>
          </div>
          <div on:click={() => { menuOpen = false; saveAs(); }}>
            另存为 <span>{accel("file.saveAs")}</span>
          </div>
          <div on:click={() => { menuOpen = false; exportDoc(); }}>
            导出 HTML <span>{accel("file.export")}</span>
          </div>
          <div class="sep-line" />
          <div on:click={() => { menuOpen = false; openFolderSearch(); }}>
            文件夹内查找替换 <span>Ctrl + Shift + F</span>
          </div>
          <div class="sep-line" />
          <div on:click={() => { menuOpen = false; migrateImages(); }}>
            迁移图片附件 <span>绝对路径→相对</span>
          </div>
          <div on:click={() => { menuOpen = false; migrateFolder(); }}>
            批量迁移文件夹图片 <span>递归</span>
          </div>
          <div on:click={() => { menuOpen = false; cleanupAssets(); }}>
            清理未引用附件 <span>{settings.assetsDir}/</span>
          </div>
          <div class="sep-line" />
          <div on:click={() => { menuOpen = false; showSettings = true; }}>
            设置 <span>快捷键 / 外观</span>
          </div>
        </div>
      {/if}
    </div>

    <div class="tb">
      <button on:click={doUndo} title="撤销 {accel('edit.undo')}">↶</button>
      <button on:click={doRedo} title="重做 {accel('edit.redo')}">↷</button>
      <button on:click={openFolderSearch} title="文件夹内查找替换 Ctrl+Shift+F">🔍</button>
      <span class="sep" />
      <button on:click={bold} title="加粗 {accel('format.bold')}"><b>B</b></button>
      <button on:click={italic} title="斜体 {accel('format.italic')}"><i>I</i></button>
      <button on:click={underline} title="下划线 {accel('format.underline')}"><u>U</u></button>
      <button on:click={strike} title="删除线 {accel('format.strike')}">S</button>
      <button
        on:click={() => armPainter(false)}
        on:dblclick={() => armPainter(true)}
        class:on={!!painter}
        title="格式刷（单击应用一次 / 双击固定，Esc 退出）">🖌</button>
      <span class="color-wrap">
        <button on:click={() => openColorMenu("fg")} class:on={colorMenu?.type === "fg"} title="字体颜色"><span class="fg-a">A</span></button>
        <button on:click={() => openColorMenu("bg")} class:on={colorMenu?.type === "bg"} title="背景颜色">🖍</button>
        {#if colorMenu}
          <div class="color-pop">
            {#each PALETTE as hex}
              <button class="swatch" style="background:{hex}" title={hex} on:click={() => pickColor(hex)} />
            {/each}
            <label class="custom-color" title="自定义颜色">
              <input type="color" value="#ff0000" on:change={onCustomColor} />
              自定义
            </label>
          </div>
        {/if}
      </span>
      <span class="sep" />
      <button on:click={h1} title="标题">H</button>
      <button on:click={ul} title="无序列表">•</button>
      <button on:click={ol} title="有序列表">1.</button>
      <button on:click={task} title="任务列表">☐</button>
      <button on:click={quote} title="引用">❝</button>
      <button on:click={link} title="插入链接 {accel('format.link')}">🔗</button>
      <button on:click={insertImg} title="插入图片">🖼</button>
      <button on:click={codeBlock} title="插入代码块">{'{ }'}</button>
      <span class="sep" />
      <button on:click={() => alignCol("left")} title="左对齐（表格列）">⬅</button>
      <button on:click={() => alignCol("center")} title="居中对齐（表格列）">☰</button>
      <button on:click={() => alignCol("right")} title="右对齐（表格列）">➡</button>
      <span class="sep" />
      <button on:click={toggleTheme} title="切换主题">
        {settings.theme === "dark" ? "☀" : "🌙"}
      </button>
      <button
        on:click={toggleFocus}
        class:on={focusMode}
        title="专注模式 {accel('view.focusMode')}">⛶</button
      >
      <button on:click={() => (showSettings = true)} title="设置">⚙</button>
    </div>

    <!-- 自定义窗口控制按钮 -->
    <div class="win-ctrl">
      <button class="wc" on:click={winMinimize} title="最小化">─</button>
      <button class="wc" on:click={winToggleMax} title="最大化 / 还原">□</button>
      <button class="wc wc-close" on:click={winClose} title="关闭">✕</button>
    </div>
  </header>

  <div class="body">
    {#if showTree}
      <aside class="sidebar" style="width:{sidebarWidth}px">
        <div class="panel-head">
          <span>文件</span>
          <span style="flex:1" />
          <button on:click={() => newFileIn(settings.lastFolder)} title="新建笔记（未打开文件夹时会先让你选文件夹）">📄+</button>
          <button on:click={() => newFolderIn(settings.lastFolder)} title="新建文件夹（未打开文件夹时会先让你选文件夹）">📁+</button>
          <button on:click={refreshTree} title="刷新目录">↻</button>
          <button on:click={() => (showTree = false)} title="折叠">‹</button>
        </div>
        {#if flatTree.length}
          <ul>
            {#each flatTree as node (node.path)}
              {#if node.kind === "folder"}
                <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
                <li
                  class="folder"
                  style="padding-left:{6 + node.depth * 18}px"
                  on:click={() => toggleFolder(node.path)}
                  on:contextmenu={(e) => openCtx(e, "folder", node.path, node.name)}
                >
                  <span class="fold">{node.expanded ? "▾" : "▸"}</span>
                  <span class="fname">{node.name}</span>
                  <span class="factions">
                    <button class="mini" title="新建笔记" on:click|stopPropagation={() => newFileIn(node.path)}>📄</button>
                    <button class="mini" title="新建文件夹" on:click|stopPropagation={() => newFolderIn(node.path)}>📁</button>
                  </span>
                </li>
              {:else}
                <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
                <li
                  class="file"
                  style="padding-left:{6 + node.depth * 18}px"
                  class:active={currentPath === node.path}
                  on:click={() => openFileByPath(node.path)}
                  on:contextmenu={(e) => openCtx(e, "file", node.path, node.name)}
                >
                  <span class="ficon">📄</span>
                  <span class="fnm">{node.name}</span>
                </li>
              {/if}
            {/each}
          </ul>
        {:else}
          <ul>
            <li class="hint">打开文件夹后显示 .md 列表</li>
          </ul>
        {/if}
      </aside>
      <!-- svelte-ignore a11y-no-static-element-interactions -->
      <div class="splitter" on:mousedown={(e) => startDrag("sidebar", e)} title="拖动调整宽度" />
    {/if}

    <main class="editor">
      <div class="panel-head">
        {#if !showTree}
          <button on:click={() => (showTree = true)} title="展开目录">›</button>
        {/if}
        <span class="filename">{currentPath ? basename(currentPath) : "未命名.md"}{#if dirty}<span class="dirty">●</span>{/if}</span>
        <span style="flex:1" />
        <button on:click={() => (showPreview = !showPreview)} class:on={showPreview} title="开关预览">🖼</button>
      </div>
      <div class="editor-host" bind:this={editorHost} on:mouseup={onEditorMouseUp}></div>
    </main>

    {#if showPreview}
      <!-- svelte-ignore a11y-no-static-element-interactions -->
      <div class="splitter" on:mousedown={(e) => startDrag("preview", e)} title="拖动调整宽度" />
      <section class="preview" style="width:{previewWidth}px">
        <div class="panel-head">
          <span>预览</span>
        </div>
        <div class="preview-content" bind:this={previewHost}>{@html rendered}</div>
      </section>
    {/if}
  </div>

  <footer class="statusbar">
    <span class="sb-path" title={currentPath ?? ""}>{currentPath ?? "未保存"}</span>
    <span>{status}</span>
    <span class="spacer" />
    <span>行 {cursorLine} : 列 {cursorCol}</span>
    <span>{stats.words} 字 · {stats.chars} 字符</span>
    <span>{settings.autoSave ? "自动保存开" : "自动保存关"}</span>
    <span>{settings.fontSize}px</span>
  </footer>

  <!-- 行内快捷菜单（gutter 按钮弹出）-->
  {#if quickMenu}
    <!-- svelte-ignore a11y-click-events-have-key-events -->
    <div class="quick-overlay" on:click={closeQuickMenu}>
      <!-- svelte-ignore a11y-click-events-have-key-events -->
      <div
        class="quick-menu"
        style="top:{quickMenu.top}px;left:{quickMenu.left}px"
        on:click|stopPropagation
      >
        <div class="quick-item" on:click={() => quickHeading(1)}><span class="qh">H1</span>一级标题</div>
        <div class="quick-item" on:click={() => quickHeading(2)}><span class="qh">H2</span>二级标题</div>
        <div class="quick-item" on:click={() => quickHeading(3)}><span class="qh">H3</span>三级标题</div>
        <div class="quick-item" on:click={() => quickHeading(4)}><span class="qh">H4</span>四级标题</div>
        <div class="quick-item" on:click={() => quickHeading(5)}><span class="qh">H5</span>五级标题</div>
        <div class="quick-sep" />
        <div class="quick-item" on:click={quickParagraph}><span class="qh">¶</span>正文</div>
        <div class="quick-item" on:click={quickCodeBlock}><span class="qh">{'{}'}</span>代码块</div>
        <div class="quick-item" on:click={quickBold}><span class="qh"><b>B</b></span>加粗</div>
      </div>
    </div>
  {/if}

  <!-- 窗口边缘 / 四角缩放手柄（decorations: false 无系统缩放边框） -->
  {#each [
    ["rh-n", "North"], ["rh-s", "South"], ["rh-w", "West"], ["rh-e", "East"],
    ["rh-nw", "NorthWest"], ["rh-ne", "NorthEast"], ["rh-sw", "SouthWest"], ["rh-se", "SouthEast"],
  ] as [cls, dir]}
    <!-- svelte-ignore a11y-no-static-element-interactions -->
    <div class="rh {cls}" on:mousedown={() => winResize(dir)} />
  {/each}
</div>

{#if showSettings}
  <SettingsModal
    bind:settings
    {configPath}
    on:change={onSettingsChange}
    on:close={() => (showSettings = false)}
    on:pickFolder={async () => {
      const f = await pickOpenFolder();
      if (f) await loadFolder(f);
    }}
    on:export={() => {
      showSettings = false;
      exportDoc();
    }}
  />
{/if}

{#if showFolderSearch && settings.lastFolder}
  <FolderSearch
    folder={settings.lastFolder}
    on:close={() => (showFolderSearch = false)}
    on:open={gotoSearchResult}
  />
{/if}

{#if promptState}
  <PromptModal
    title={promptState.title}
    label={promptState.label}
    value={promptState.value}
    path={promptState.path}
    on:confirm={onPromptConfirm}
    on:cancel={onPromptCancel}
    on:browse={onPromptBrowse}
  />
{/if}

{#if confirmState}
  <ConfirmModal
    title={confirmState.title}
    message={confirmState.message}
    confirmText={confirmState.confirmText}
    danger={confirmState.danger}
    on:confirm={onConfirmYes}
    on:cancel={onConfirmNo}
  />
{/if}

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
      <div class="ctx-title" title={ctxMenu.path}>{ctxMenu.name}</div>
      {#if ctxMenu.kind === "folder"}
        <button class="ctx-item" on:click={ctxNewFile}>📄 新建笔记</button>
        <button class="ctx-item" on:click={ctxNewFolder}>📁 新建文件夹</button>
        <div class="ctx-sep" />
      {:else}
        <button class="ctx-item" on:click={ctxOpen}>📂 打开</button>
        <div class="ctx-sep" />
      {/if}
      <button class="ctx-item" on:click={ctxCopy}>📋 复制到…</button>
      <button class="ctx-item" on:click={ctxMove}>➡ 移动到…</button>
      <div class="ctx-sep" />
      <button class="ctx-item danger" on:click={ctxDelete}>🗑 删除</button>
    </div>
  </div>
{/if}
