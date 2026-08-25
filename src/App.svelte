<script lang="ts">
  import { onMount, tick } from "svelte";
  import type MarkdownIt from "markdown-it";
  import { convertFileSrc, Channel, invoke } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";
  // 模态组件动态加载：不占用主 chunk 启动解析成本，首次打开时才拉对应 chunk
  type SvelteCmp = any;
  let modalCmps: { SettingsModal?: SvelteCmp; FolderSearch?: SvelteCmp; PromptModal?: SvelteCmp; ConfirmModal?: SvelteCmp } = {};
  const modalLoaders = {
    SettingsModal: () => import("./SettingsModal.svelte"),
    FolderSearch: () => import("./FolderSearch.svelte"),
    PromptModal: () => import("./PromptModal.svelte"),
    ConfirmModal: () => import("./ConfirmModal.svelte"),
  } as const;
  function loadModal(name: keyof typeof modalLoaders) {
    if (modalCmps[name]) return;
    modalLoaders[name]().then((m) => {
      modalCmps = { ...modalCmps, [name]: m.default };
    }).catch(() => {});
  }
  // 窗口级查找面板命令：焦点不在编辑器内容区时 Ctrl+F / Ctrl+H 也能打开（兜底）
  import { openSearchPanel as openSearchPanelCmd } from "./search-panel";
    // 预览编辑模式键盘增强（快捷键/智能 Enter 与源码编辑器对齐）
    import { attachPreviewEditKeys, insertImageAtCaret, insertTableAtCaret, scrollCaretIntoView } from "./preview-edit-keys";
  import { initHighlight, highlightCode, setOnLangLoaded } from "./highlight";
  // 安全边界：所有 HTML 注入（预览 / 预览编辑 / 导出）必须经此清洗，见 sanitize.ts 注释
  import { safeRender, sanitizeHtml } from "./sanitize";
  import VirtualPreview from "./preview/VirtualPreview.svelte";
  import StatusBar from "./StatusBar.svelte";
  import Toast from "./Toast.svelte";
  import FileTree from "./FileTree.svelte";
  import { renameTabPathDedup } from "./tabs";
  import { resolveLowEnd, buildDegrade } from "./lowend";
  import { setDims, getDims, loadDims, saveDims } from "./image-dims";
  import type { EditRange } from "./preview/block-splitter";
  import {
    createEditor,
    setAppearance,
    setKeymap,
    setWrap,
    setDoc,
    applyExternalEdit,
    diffRange,
    setDocStreaming,
    STREAM_THRESHOLD,
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
    getDoc,
    appendLoadChunk,
    finishStreamingLoad,
  } from "./editor";
  // 粘贴图片转码客户端（Worker 解码/降采样/WebP 编码，主线程零阻塞）
  import { imageWorkerSupported, processImageInWorker } from "./image-worker-client";
  import {
    pickOpenFile,
    readFile,
    fileSize,
    readFileHead,
    streamFileRest,
    type ReadHead,
    pickOpenFolder,
    writeFile,
    pickSaveFile,
    pickImageFile,
    importAsset,
    importAssetBytes,
    importAssetRaw,
    listMdFiles,
    listOrphanAssets,
    cleanupOrphansWith,
    readMdTree,
    renamePath,
    exportHtml,
    exportPdf,
    exportBundledMarkdown,
    pickSaveBundledFile,
    pickSavePdfFile,
    settingsFilePath,
    logFrontend,
    pathExists,
  } from "./fs";
  import { createTreeStore } from "./filetree/store";
  import { loadFolderNode, refreshTree } from "./filetree/ops";
  import {
    rewriteAttachmentRefs,
    resolveAttachmentDir,
    attachmentDirName,
  } from "./attachment";
  import { logOp, logInfo, logError, logWarn } from "./logger";
  import {
    loadSettings,
    persistSettings,
    saveSettings,
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
  // 预览编辑模式：contenteditable 预览 + turndown 回写 markdown
  import TurndownService from "turndown";
  import { gfm } from "turndown-plugin-gfm";

  // Tauri 窗口 API（生产环境更新标题 + 关闭拦截）
  let tauriWindow: {
    setTitle(t: string): Promise<void>;
    onCloseRequested(cb: (e: any) => void): Promise<() => void>;
    onMoved(cb: (e: any) => void): Promise<() => void>;
    onResized(cb: (e: any) => void): Promise<() => void>;
  } | null = null;

  // 设置持久化桥接（Tauri invoke；浏览器调试自动回退 localStorage）
  initSettingsBridge(settingsBridge);

  // 安全区域支持（刘海屏/圆角屏/windows 11 Mica 效果防裁剪）
  // 通过 env() 读取平台安全区域，fallback 到手动测量或零
  function safeTop() { return 0; } // 标题栏高度由 titlebar 自身撑起，此处预留

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

  // markdown-it 动态 import：解析器移出启动主 chunk，首次预览/导出时才加载
  let md: MarkdownIt | null = null;
  let mdLoading: Promise<MarkdownIt> | null = null;
  function initMd(): Promise<MarkdownIt> {
    if (md) return Promise.resolve(md);
    if (!mdLoading) {
      mdLoading = (async () => {
        const { default: MarkdownItCtor } = await import("markdown-it");
        const instance = new MarkdownItCtor({
          html: true,
          // linkify 收窄：只识别显式 http(s):// 链接，关闭模糊链接/邮箱识别（linkify 是 markdown-it 最贵的 inline 处理）。
          // 注意：markdown-it 的 linkify 选项只判真假，传对象（{fuzzyLink:false,...}）恒为真等于模糊匹配全开，
          // 必须构造后用 linkify.set() 收窄，否则含 URL/邮箱文本的解析耗时会被放大 9~22 倍。
          linkify: true,
          highlight: (code, lang) => highlightCode(code, lang),
        });
        instance.linkify.set({ fuzzyLink: false, fuzzyEmail: false });

        // 图片渲染：本地绝对路径转 Tauri asset 协议 URL，预览区才能加载
        const defaultImageRender =
          instance.renderer.rules.image ||
          ((tokens: any, idx: number, options: any, _env: any, self: any) =>
            self.renderToken(tokens, idx, options));
        instance.renderer.rules.image = (tokens, idx, options, env, self) => {
          const token = tokens[idx];
          const srcIndex = token.attrIndex("src");
          if (srcIndex >= 0) {
            const rawRef = token.attrs![srcIndex][1];
            let src = rawRef;
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
            // 懒加载：长文档多图时避免一次性全部解码，滚动到视口才加载
            if (token.attrIndex("loading") < 0) token.attrPush(["loading", "lazy"]);
            if (token.attrIndex("decoding") < 0) token.attrPush(["decoding", "async"]);
            // 尺寸内联（P1-5）：命中尺寸索引则注入 width/height，浏览器用 aspect-ratio
            // 预留空间，图片加载完成不再导致预览滚动跳变。缺失则不加，行为与普通图一致。
            if (!isRemote && currentPath) {
              const d = getDims(dirname(currentPath), rawRef);
              if (d) {
                if (token.attrIndex("width") < 0) token.attrPush(["width", String(d.w)]);
                if (token.attrIndex("height") < 0) token.attrPush(["height", String(d.h)]);
              }
            }
          }
          return defaultImageRender(tokens, idx, options, env, self);
        };
        md = instance;
        return instance;
      })();
    }
    return mdLoading;
  }

  const WELCOME_TEXT = `# 欢迎使用 LiteMD

- 左侧：文件目录（二级文件夹结构）
- 中间：Markdown 编辑器（CodeMirror 6）
- 右侧：实时预览（markdown-it）

> 超轻量 Markdown 编辑器，Rust + Tauri 构建。

\`\`\`js
console.log("Hello LiteMD");
\`\`\`
`;

  // 初始 source 不再默认渲染欢迎页，避免冷启动打开 .md 时「欢迎页一闪而过」（q15）。
  // 启动参数中的待打开文件由 onMount 先 take_open_files 再创建编辑器，据此填充 source。
  let source = "";

  // ---- 设置 ----
  let settings: Settings = { ...DEFAULT_SETTINGS, shortcuts: { ...DEFAULT_SHORTCUTS } };
  let configPath = "";
  let showSettings = false;

  // ---- 运行时布局（settings 里的同名字段是「启动时」默认值）----
  let showTree = true;
  let showPreview = true;
  let focusMode = false;
  let beforeFocus = { tree: true, preview: true };
  // 大文档自动单栏（P1-7 矩阵行）：用户手动开过预览后不再自动折叠（本次会话尊重用户选择）
  let paneUserOverride = false;
  function togglePreviewPane() {
    showPreview = !showPreview;
    if (showPreview) paneUserOverride = true;
  }

  let view: ReturnType<typeof createEditor> | undefined;
  let editorHost: HTMLDivElement;
  // VirtualPreview 组件实例引用（滚动同步用，真正可滚动的是其内部容器）
  let previewRef: VirtualPreview;
  let hlReady = false;

  // ---- 文件状态 ----
  let currentPath: string | null = null;
  // ---- 文件树：独立模块（store + ops + locate + watcher），逻辑见 src/filetree/ ----
  const treeStore = createTreeStore();
  let treeRef: FileTree | null = null;
  let status = "就绪";
  let menuOpen = false;
  // 全局致命错误兜底：未捕获异常时显示友好错误页，避免白屏（item 4）
  let fatalError: { msg: string; stack: string } | null = null;
  function copyFatalLog() {
    const text = fatalError ? `${fatalError.msg}\n${fatalError.stack}` : "";
    void navigator.clipboard?.writeText(text).catch(() => {});
  }

  // ---- 多标签管理 ----
  // 每个标签持有自己的完整状态；编辑器视图始终承载「激活标签」的文档，切换时整体交换。
  interface TabState {
    path: string;
    content: string; // 从编辑器拉出的最新全文（含未保存修改）
    savedContent: string; // 最后一次保存/打开时的内容
    dirty: boolean;
    cursorPos: number | null; // 光标偏移（会话恢复/切换用）
    /** 延迟载入：>8MB 大文档不在会话恢复时全量读盘，激活时才走分片流式载入（P0） */
    deferred?: boolean;
    /** 打开/载入失败：内容未与磁盘建立关联，禁止写盘，防止欢迎页/半载内容覆盖原文件（P0 数据安全） */
    loadFailed?: boolean;
  }
  let tabs: TabState[] = [];
  let activeIdx = 0;
  const activeTab = () => tabs[activeIdx] ?? null;

  // 路径统一正斜杠（Rust 返回 \\，对话框/拖拽可能混用，避免同一文件因分隔符不同重复开标签）
  // 路径内部统一正斜杠，并去掉末尾的斜杠（避免 nodeMap 里 "D:/22" 与 "D:/22/" 变成两个 key，导致新建后刷新不到父目录）
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");

  // 打开路径防御归一化：去首尾引号、去 file:// 前缀、统一正斜杠。
  // 文件关联启动 / 拖拽 / 命令行传入的路径可能带引号或 file:// 前缀，
  // 直接传入 fs 会找不到文件 → 双击 md 打开失败、停在首页。
  function normalizeOpenPath(p: string): string {
    let s = p.trim();
    if (s.length >= 2) {
      const first = s[0];
      const last = s[s.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        s = s.slice(1, -1);
      }
    }
    s = s.replace(/^file:\/\/\/?/i, "").replace(/^file:\//i, "");
    return s.replace(/\\/g, "/");
  }

  // 会话持久化：settings.openTabs 存路径顺序；localStorage 存内容/光标（未保存状态也恢复）
  const SESSION_KEY = "litemd-session-tabs";
  // 大文档体积闸门：超过 1MB 的内容不写入 localStorage（原本也会被配额静默拒绝，
  // 且会触发 100~200MB 瞬时分配与 300~500ms 主线程冻结）。恢复时回退磁盘读取。
  const SESSION_CONTENT_MAX = 1 << 20;
  // 手动刷新硬上限：标准 8MB / 低端 2MB（P1-7 降级矩阵），由 degrade 在设置加载后确定
  let manualRefreshMax = 8 << 20;
  // ---- 低端模式 + 降级矩阵（P1-7）----
  // lowEndMode 解析为布尔；degrade 持有全部降级参数；二者随 settings.lowEndMode 变化自动重算。
  $: lowEndMode = resolveLowEnd(settings.lowEndMode);
  $: degrade = buildDegrade(lowEndMode);
  $: manualRefreshMax = degrade.manualRefreshMax;
  // 实时预览阈值（字节）：低端下封顶 512KB，更激进进入预览降级
  $: previewMaxBytes = (lowEndMode
    ? Math.min(settings.previewRealtimeMaxKB, 512)
    : settings.previewRealtimeMaxKB) * 1024;
  $: if (typeof document !== "undefined") document.body.classList.toggle("low-end", lowEndMode);
  // 打开/切换文档时载入该笔记的图片尺寸索引（best-effort，失败静默）；按路径去重避免重复读取
  let lastDimsPath: string | null = null;
  $: if (currentPath && currentPath !== lastDimsPath) {
    lastDimsPath = currentPath;
    void loadDims(dirname(currentPath), currentAttachmentName());
  }
  // 大文档阈值：>8MB 打开期间显示载入遮罩，解耦 FCP 与文档大小
  const BIG_DOC_BYTES = 8 << 20;
  let sessionTimer: ReturnType<typeof setTimeout> | null = null;

  // 窗口拖拽/缩放期间置忙：挂起所有后台主线程任务（预览空闲预渲染、自动保存、统计），
  // 仅付 OS 合成器平移/缩放成本，确保拖拽 CPU 峰值 ≤30%、零掉帧。事件持续触发会不断
  // 续期，停止后 150ms 自动解除（P1-1）。
  let windowBusy = false;
  let windowBusyTimer: ReturnType<typeof setTimeout> | null = null;
  // 内存压力自愈状态（P0）：memReliefEnabled 粘性开启视口外 img 卸载
  let memReliefEnabled = false;
  // 连续低于阈值的采样次数（迟滞计数，避免在阈值附近抖动），见内存自愈定时器
  let memReliefLowSamples = 0;
  let memTimer: ReturnType<typeof setInterval> | null = null;
  let perfObservers: PerformanceObserver[] = [];
  function markWindowBusy() {
    if (!windowBusy) {
      windowBusy = true;
      document.body.classList.add("window-busy");
      previewRef?.pauseIdlePrerender(); // 挂起预览空闲预渲染
    }
    if (windowBusyTimer) clearTimeout(windowBusyTimer);
    windowBusyTimer = setTimeout(() => {
      windowBusy = false;
      windowBusyTimer = null;
      document.body.classList.remove("window-busy");
    }, 150);
  }
  function saveSession() {
    settings.openTabs = tabs.map((t) => t.path);
    const activePath = tabs[activeIdx]?.path;
    if (activePath) settings.lastFile = activePath;
    persist();
    try {
      const data = tabs.map((t) => {
        // 延迟载入标签（尚未读盘）与大文档只存指针，内容不进 localStorage
        const big = !!t.deferred || !!t.loadFailed || t.content.length > SESSION_CONTENT_MAX;
        return {
          path: t.path,
          // 大文档只存指针，内容不进 localStorage（重启后从磁盘读取）
          content: big ? null : t.content,
          saved: big || t.savedContent.length > SESSION_CONTENT_MAX ? null : t.savedContent,
          dirty: t.dirty,
          cursor: t.cursorPos,
          big,
        };
      });
      localStorage.setItem(SESSION_KEY, JSON.stringify(data));
    } catch {
      /* 内容超限时忽略，重启后回退读磁盘 */
    }
  }
  interface SessionTab {
    path: string;
    content: string | null;
    saved: string;
    dirty: boolean;
    cursor: number | null;
    big?: boolean;
  }
  function loadSession(): SessionTab[] {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return [];
      const data = JSON.parse(raw);
      if (!Array.isArray(data)) return [];
      return data
        .filter((d: any) => d && typeof d.path === "string")
        .map((d: any) => ({
          path: norm(d.path),
          content: typeof d.content === "string" ? d.content : null,
          saved: typeof d.saved === "string" ? d.saved : "",
          dirty: !!d.dirty,
          cursor: typeof d.cursor === "number" ? d.cursor : null,
          big: !!d.big,
        }));
    } catch {
      return [];
    }
  }
  // 编辑击键后防抖持久化会话（含未保存内容），窗口被强杀也能恢复
  function queueSessionSave() {
    if (sessionTimer) clearTimeout(sessionTimer);
    sessionTimer = setTimeout(() => {
      const cur = tabs[activeIdx];
      if (cur && view) {
        cur.content = pullDoc();
        cur.dirty = docDirty || (lastSaved !== null && source !== lastSaved);
        cur.savedContent = lastSaved ?? cur.savedContent;
        cur.cursorPos = view.state.selection.main.head;
      }
      saveSession();
    }, 1500);
  }

  // 标签状态与编辑器互斥交换：切换前把当前编辑器状态写回标签，切换后恢复目标标签状态
  function syncTabState(tab: TabState) {
    tab.content = pullDoc();
    tab.dirty = docDirty || (lastSaved !== null && source !== lastSaved);
    tab.savedContent = lastSaved ?? tab.savedContent;
    tab.cursorPos = view ? view.state.selection.main.head : null;
  }
  async function applyTabState(tab: TabState) {
    abortDocStream(); // 失效旧的分片流（切标签），并恢复编辑器可编辑
    if (tab.deferred) {
      // 延迟载入标签：不 setDoc 空内容，直接启动磁盘分片流式载入
      currentPath = tab.path;
      docMemo = null;
      docLength = 0;
      suppressSave = true;
      await startDocStream(tab);
      suppressSave = false;
      return;
    }
    currentPath = tab.path;
    docMemo = null; // 切换标签：释放上一文档的 50MB 副本
    docLength = tab.content.length;
    suppressSave = true;
    // 大文档（> STREAM_THRESHOLD）走分片流式载入：摊开解析、显示进度，
    // 期间遮罩保持；小文档直接 setDoc（一次性，无感知卡顿）。
    // 注意：载入过程必须 try/catch 关闭遮罩，否则异常时遮罩永久卡死
    const big = !!view && tab.content.length > STREAM_THRESHOLD;
    if (big) { loadingBigDoc = true; streamProgress = 0; }
    try {
      if (view) {
        await setDocStreaming(view, tab.content, {
          threshold: STREAM_THRESHOLD,
          onProgress: (r) => { streamProgress = r; },
        });
      }
    } catch (e) {
      loadingBigDoc = false;
      streamProgress = 0;
      suppressSave = false;
      tab.loadFailed = true; // P0 数据安全：载入失败，编辑器内容与磁盘无关联，禁止写盘
      lastSaved = null;
      status = "载入失败：" + String(e);
      return;
    }
    loadingBigDoc = false;
    streamProgress = 0;
    suppressSave = false;
    source = tab.content;
    lastSaved = tab.savedContent;
    docDirty = tab.dirty;
    if (view && tab.cursorPos != null) {
      view.dispatch({ selection: { anchor: Math.min(tab.cursorPos, tab.content.length) } });
    }
    cancelOpenPreview();
    pendingEdit = null;
    previewEdits = undefined;
    previewSource = "";
    scheduleStats(tab.content);
    scheduleOpenPreview(tab.content);
    // 显式同步推 preview（q14 根因：打开/切换文件后预览面板空白。之前依赖
    // scheduleOpenPreview 的 requestIdleCallback push 或 setDoc 副作用的 pushPreview，
    // 两者都不可靠：idle 回调可能被推迟、token 失效、降级判定短路 → previewSource
    // 停留在空串，VirtualPreview 永远空白。这里直接同步设 previewSource，响应式 rebuild 立即可见；
    // scheduleOpenPreview 的 idle push 因 previewSource 非空自动跳过，不冲突。）
    if (tab.content.length <= previewMaxBytes) {
      previewStale = false;
      previewSource = tab.content;
    }
    // 预览编辑模式下：渲染新标签内容到可编辑预览容器（否则内容停留在上一个标签）
    if (previewEditMode && md && previewEditEl) {
      previewEditEl.innerHTML = safeRender(md, tab.content); // C-01：清洗后注入
    }
  }
  async function activateTab(idx: number) {
    if (!view || !tabs[idx]) return;
    if (previewEditMode) flushPreviewEdit(); // 预览编辑未回写内容先同步进编辑器再切换
    // 仅在真正切换标签时同步旧标签；重复激活/首次打开（idx===activeIdx）不执行
    // syncTabState，否则会把编辑器残留内容（如欢迎页）写回刚读入的文件内容（P0 数据安全）
    if (idx !== activeIdx) {
      const cur = tabs[activeIdx];
      if (cur) syncTabState(cur);
    }
    activeIdx = idx;
    await applyTabState(tabs[idx]);
    status = "已切换到 " + basename(tabs[idx].path);
    updateTitle();
    saveSession();
  }
  async function openTabByPath(p: string) {
    const np = norm(p);
    const exist = tabs.findIndex((t) => t.path === np);
    if (exist >= 0) {
      await activateTab(exist);
      return;
    }
    // 大文档（>8MB）：延迟标签 + 分片流式载入，避免一次性 50MB IPC 长任务（P0）
    let size = 0;
    try { size = await fileSize(np); } catch { size = 0; }
    if (size > BIG_DOC_BYTES) {
      tabs = [...tabs, { path: np, content: "", savedContent: "", dirty: false, cursorPos: null, deferred: true }];
      await activateTab(tabs.length - 1); // → applyTabState → startDocStream
      return;
    }
    // 小文档（≤8MB）直接读取；读取为真实异步间隙，无需载入遮罩
    // （遮罩仅用于大文档流式载入，由 startDocStream/applyTabState 统一管理关闭）
    let content: string;
    try {
      content = await readFile(np);
    } catch (e) {
      status = "打开失败：" + String(e);
      return;
    }
    // 注意：此处不关闭遮罩——大文档的耗时主要在分片流式载入（applyTabState→
    // setDocStreaming），由它在载入结束时统一关闭并展示进度。
    tabs = [...tabs, { path: np, content, savedContent: content, dirty: false, cursorPos: null }];
    await activateTab(tabs.length - 1);
    settings.lastFile = np;
    settings.recentFiles = [np, ...settings.recentFiles.filter((f) => norm(f) !== np)].slice(0, 5);
    saveSession();
    status = "已打开 " + basename(np);
    updateTitle();
  }
  const isDirtyTab = (t: TabState) => t.dirty || t.content !== t.savedContent;

  // ---- 分片流式载入（P0）：Rust Channel 分片推送 + 空闲帧 append，载入期只读 ----
  const STREAM_HEAD_BYTES = 256 * 1024; // 头片：~8ms 建 rope，编辑器立刻出字可滚动
  let docStreamToken = 0;        // 失效令牌：切标签/关标签/重开使旧流作废
  let docStreamReadonly = false; // 载入期 contenteditable=false
  let docStreamTab: TabState | null = null; // 正在流式载入的标签（关标签时判断是否需中止）
  function abortDocStream() {
    docStreamToken++;
    docStreamTab = null;
    if (docStreamReadonly) {
      docStreamReadonly = false;
      if (view) view.contentDOM.removeAttribute("contenteditable");
      loadingBigDoc = false;
      streamProgress = 0;
    }
  }
  /** 对已存在的延迟标签启动磁盘流式载入；失败/被切换时安全退出 */
  async function startDocStream(tab: TabState): Promise<void> {
    const np = tab.path;
    loadingBigDoc = true;
    streamProgress = 0;
    let headInfo: ReadHead;
    try {
      headInfo = await readFileHead(np, STREAM_HEAD_BYTES);
    } catch (e) {
      loadingBigDoc = false;
      streamProgress = 0;
      tab.loadFailed = true; // P0 数据安全：读取失败，编辑器仍为欢迎页/旧内容，禁止写盘
      lastSaved = null;
      status = "打开失败：" + String(e);
      return;
    }
    // 等待期间用户已切走/关闭：放弃（不污染其它标签）
    if (!view || tabs[activeIdx] !== tab) { loadingBigDoc = false; streamProgress = 0; return; }
    const myToken = ++docStreamToken;
    docStreamTab = tab;
    docStreamReadonly = true;
    view.contentDOM.setAttribute("contenteditable", "false"); // 载入期只读

    // 头片先入编辑器：立刻出字、可滚动；不预览头片（cancelOpenPreview）
    setDoc(view, headInfo.head);
    cancelOpenPreview();
    pendingEdit = null;
    previewEdits = undefined;
    previewSource = "";

    const CHUNK = lowEndMode ? 512 * 1024 : 2 << 20; // 低端 512KB/片，每片 dispatch <10ms
    const pending: string[] = [];
    let received = headInfo.head.length;
    let streamDone = false;
    let appendScheduled = false;

    const ch = new Channel<string>();
    ch.onmessage = (c) => {
      if (myToken !== docStreamToken) return;
      pending.push(c);
      received += c.length;
      scheduleAppend();
    };

    const scheduleAppend = () => {
      if (appendScheduled || myToken !== docStreamToken) return;
      appendScheduled = true;
      const run = (dl?: IdleDeadline) => {
        appendScheduled = false;
        if (myToken !== docStreamToken || !view) return;
        // 空闲帧预算：timeRemaining()>6 才追加一片，任何一帧都不超预算，长任务归零
        while (pending.length && (dl ? dl.timeRemaining() > 6 : true)) {
          appendLoadChunk(view, pending.shift()!);
          streamProgress = Math.min(1, received / Math.max(1, headInfo.total));
        }
        if (pending.length) { scheduleAppend(); return; }
        if (streamDone) finish();
      };
      if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 200 });
      else setTimeout(run, 16);
    };

    const finish = () => {
      if (myToken !== docStreamToken) return;
      docStreamToken++; // 消费令牌，防重复 finish
      docStreamTab = null;
      docStreamReadonly = false;
      if (view) view.contentDOM.removeAttribute("contenteditable");
      loadingBigDoc = false;
      streamProgress = 0;
      tab.deferred = false;
      // 一次 toString → tab.content 稳态副本（同时种 docMemo，后续消费者零分配）
      const text = pullDoc();
      tab.content = text;
      tab.savedContent = text;
      source = text;
      lastSaved = text;
      docDirty = false;
      docLength = text.length;
      if (view) {
        finishStreamingLoad(view); // 围栏索引空闲帧重建
        if (tab.cursorPos != null) {
          view.dispatch({ selection: { anchor: Math.min(tab.cursorPos, text.length) } });
        }
      }
      scheduleOpenPreview(text);
      settings.lastFile = np;
      settings.recentFiles = [np, ...settings.recentFiles.filter((f) => norm(f) !== np)].slice(0, 5);
      saveSession();
      status = "已打开 " + basename(np);
      updateTitle();
    };

    streamFileRest(np, headInfo.headBytes, CHUNK, ch)
      .then(() => {
        if (myToken !== docStreamToken) return;
        streamDone = true;
        scheduleAppend();
      })
      .catch((e) => {
        if (myToken !== docStreamToken) return;
        abortDocStream();
        tab.deferred = false;
        tab.loadFailed = true; // P0 数据安全：流式中断，半载内容与磁盘无关联，禁止写盘
        lastSaved = null;
        status = "载入中断：" + String(e);
      });
  }

  // ---- 关闭标签：三按钮对话框（保存并关闭 / 不保存关闭 / 取消）----
  let closeTabDialog: { path: string } | null = null;
  function requestCloseTab(path: string) {
    const idx = tabs.findIndex((t) => t.path === path);
    if (idx < 0) return;
    const tab = tabs[idx];
    // P0 数据安全：从未成功载入的标签（deferred 载入中 / loadFailed 打开失败），
    // 编辑器内容与磁盘无关联，禁止「保存并关闭」把欢迎页/半载内容写回原文件
    if (tab.deferred || tab.loadFailed) {
      doCloseTab(path);
      return;
    }
    if (idx === activeIdx) syncTabState(tab);
    if (!isDirtyTab(tab)) {
      doCloseTab(path);
      return;
    }
    closeTabDialog = { path: tab.path };
  }
  async function onCloseTabSave() {
    const p = closeTabDialog?.path;
    closeTabDialog = null;
    if (!p) return;
    // 保存目标标签：若不是激活标签，先切过去保存再关闭
    const idx = tabs.findIndex((t) => t.path === p);
    if (idx >= 0 && idx !== activeIdx) await activateTab(idx);
    if (currentPath) await save();
    doCloseTab(p);
  }
  function onCloseTabNoSave() {
    const p = closeTabDialog?.path;
    closeTabDialog = null;
    if (p) doCloseTab(p);
  }
  function onCloseTabCancel() {
    closeTabDialog = null;
  }
  // 标签栏中键（按钮 1）点击：关闭该标签
  function onTabbarAuxClick(e: MouseEvent) {
    if (e.button !== 1) return;
    const el = (e.target as HTMLElement).closest(".tab") as HTMLElement | null;
    if (el && el.dataset.path) {
      e.preventDefault();
      requestCloseTab(el.dataset.path);
    }
  }
  function doCloseTab(path: string) {
    logOp("关闭标签: " + path);
    const idx = tabs.findIndex((t) => t.path === path);
    if (idx < 0) return;
    if (tabs[idx] === docStreamTab) abortDocStream(); // 关闭正在流式载入的标签才中止流
    const wasActive = idx === activeIdx;
    const wasPath = tabs[idx].path;
    const next = tabs.filter((t) => t.path !== path);
    tabs = next;
    if (next.length === 0) {
      // 预览编辑模式：丢弃未回写的编辑（标签已关闭），退出模式并清空容器，
      // 避免之后 flushPreviewEdit 把残留 HTML 回写到已清空的编辑器
      if (previewEditMode) {
        if (previewEditTimer) {
          clearTimeout(previewEditTimer);
          previewEditTimer = null;
        }
        detachPreviewKeys?.();
        detachPreviewKeys = null;
        previewEditMode = false;
        showPreview = previewEditBefore.preview;
        if (previewEditEl) previewEditEl.innerHTML = "";
      }
      if (view) setDoc(view, "");
      suppressSave = false;
      source = "";
      lastSaved = null;
      docDirty = false;
      currentPath = null;
      settings.lastFile = null;
      cancelOpenPreview();
      pendingEdit = null;
      previewEdits = undefined;
      previewSource = "";
      previewStale = false;
    } else if (wasActive) {
      activeIdx = Math.min(idx, next.length - 1);
      applyTabState(next[activeIdx]);
      settings.lastFile = next[activeIdx].path;
    }
    saveSession();
    updateTitle();
    status = "已关闭 " + basename(wasPath);
  }

  let showShortcutGuide = false;
  function closeShortcutGuide() {
    showShortcutGuide = false;
    settings.shortcutGuideShown = true;
    persist();
  }
  
    // ---- 格式刷 / 调色板 / 跨文件搜索 / 确认对话框 状态 ----
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

    // ---- 标签右键：关闭当前 / 关闭其他 / 关闭全部（文件树右键菜单在 FileTree 内部）----
    let ctxMenu: { x: number; y: number; path: string; name: string } | null = null;

    function closeCtx() {
      ctxMenu = null;
    }

    // 树内重命名/移动后：更新已打开标签的路径（供 FileTree handlers.onTabRenamed 使用）
    function updateTabPath(oldPath: string, newPath: string) {
      const np = norm(newPath);
      const { tabs: nextTabs, activeIdx: nextActive } = renameTabPathDedup(tabs, oldPath, newPath, activeIdx);
      tabs = nextTabs;
      // 仅当被改名的标签成为激活标签时，同步当前路径与最近文件（避免覆盖其它激活标签）
      if (nextActive >= 0 && tabs[nextActive] && norm(tabs[nextActive].path) === np) {
        currentPath = np;
        settings.lastFile = np;
      }
      activeIdx = nextActive;
      saveSession();
      updateTitle();
      // 附件文件夹联动：重命名 / 移动 .md 时一并处理其 {filename}_attachment（异步，不阻塞 UI）
      if (/\.md$/i.test(newPath)) void linkAttachmentOnRename(oldPath, newPath);
    }

    // 重命名 / 移动 .md 时，对附件目录做同样操作：
    //  - 重命名 → 同步改名「旧名_attachment」为「新名_attachment」，并改写文档内引用
    //  - 移动 → 把附件目录一起移到目标目录（目录名不变，相对引用仍有效，无需改写）
    async function linkAttachmentOnRename(mdOld: string, mdNew: string) {
      const oldAtt = resolveAttachmentDir(mdOld, settings);
      const newAtt = resolveAttachmentDir(mdNew, settings);
      if (oldAtt === newAtt) return; // shared 模式下附件目录与文档名无关，无需联动
      const oldName = basename(oldAtt);
      const newName = basename(newAtt);
      // 1) 移动 / 重命名磁盘上的附件目录（若存在）
      try {
        if (await pathExists(oldAtt)) {
          await renamePath(oldAtt, newAtt);
        }
      } catch (e) {
        logError("附件文件夹联动失败：" + String(e));
      }
      // 2) 仅目录名变化（重命名场景）才改写文档内引用；纯移动目录名不变，相对引用仍有效
      if (oldName !== newName) {
        try {
          const text = await readFile(mdNew);
          const res = rewriteAttachmentRefs(text, dirname(mdNew), [oldAtt], oldName, newName);
          if (res.count > 0) {
            await writeFile(mdNew, res.text);
            // 当前打开的文档：同步编辑器内容，避免预览里图裂
            if (currentPath && norm(currentPath) === norm(mdNew)) {
              suppressSave = true;
              setDoc(view, res.text);
              source = res.text;
              lastSaved = res.text;
              docDirty = false;
              suppressSave = false;
              updateTitle();
            }
          }
        } catch (e) {
          logError("改写附件引用失败：" + String(e));
        }
      }
    }

    // ---- 标签右键：关闭当前 / 关闭其他 / 关闭全部 ----
    function ctxCloseTab() {
      const p = ctxMenu?.path;
      ctxMenu = null;
      if (p) requestCloseTab(p);
    }
    function ctxCloseOthers() {
      const p = ctxMenu?.path;
      ctxMenu = null;
      if (!p) return;
      for (const t of [...tabs]) {
        if (t.path !== p) requestCloseTab(t.path);
      }
    }
    function ctxCloseAll() {
      ctxMenu = null;
      for (const t of [...tabs]) requestCloseTab(t.path);
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
  // docDirty：编辑器文档相对上次镜像 source 是否有新击键（O(1)）；
  // source !== lastSaved：低频同步点上的全量比较结果。两者任一成立即未保存。
  let docDirty = false;
  $: dirty = docDirty || (lastSaved !== null && source !== lastSaved);

  // 从编辑器拉全文：只在保存/预览防抖到期等低频点调用，避免每击键 O(n) 拷贝。
  // 版本号 memo：CodeMirror 的 Text 实例身份即版本号，同一版本命中零分配，
  // 消除「停手顿挫」中同窗口内 2~3 次重复 toString（50MB 下每次 ~45ms + 50MB 瞬时分配）。
  let docMemo: { doc: unknown; text: string } | null = null;
  function pullDoc(): string {
    if (!view) return source;
    const d = view.state.doc;
    if (docMemo && docMemo.doc === d) return docMemo.text; // 同版本命中，零分配
    const text = d.toString();
    docMemo = { doc: d, text };
    return text;
  }

  // 编辑器文档变化（每击键）：只做 O(1) 标记 + 累计脏区间 + 重新排防抖，不读全文、不做字符串比较
  // 脏区间以「上次推送的 previewSource」为坐标基准，供预览增量切块（splitFast）使用
  let pendingEdit: EditRange | null = null;
  // 文档当前字符数（O(1)，用于大文档手动刷新禁用等判定；避免每次都读 doc.length）
  let docLength = 0;
  // 大文档载入遮罩：打开 >8MB 文件期间显示，解耦 FCP 与文档大小
  let loadingBigDoc = false;
  // 分片流式载入进度（0~1），仅大文档载入时有效
  let streamProgress = 0;
  function onEditorDocChange(fromA: number, toA: number, fromB: number, toB: number) {
    docDirty = true;
    // 文档身份已变，立即释放上一版本的 50MB 字符串副本，避免常驻两份
    docMemo = null;
    if (view) docLength = view.state.doc.length;
    accumulateEdit(fromA, toA, fromB, toB);
    schedulePreview();
    queueAutoSave();
    queueSessionSave();
  }
  /** 把本事务变更区间合并进 pendingEdit（旧文档坐标）；始终维持「旧[from,to) 被长 insert 的新内容替换」不变式 */
  function accumulateEdit(fromA: number, toA: number, fromB: number, toB: number) {
    const ins = toB - fromB;
    const pe = pendingEdit;
    if (!pe) { pendingEdit = { from: fromA, to: toA, insert: ins }; return; }
    const delta = pe.insert - (pe.to - pe.from);
    const newEnd = pe.from + pe.insert; // 脏区新内容在当前文档中的结束位置
    if (fromA >= newEnd) {
      // 变更完全在脏区之后：映射回旧坐标，扩展右边界
      const gap = fromA - delta - pe.to; // 两区间之间未变的旧字符数
      pe.to = toA - delta;
      pe.insert += gap + ins;
    } else if (toA <= pe.from) {
      // 变更完全在脏区之前：之前无累计偏移，当前坐标即旧坐标
      const gap = pe.from - toA;
      pe.from = fromA;
      pe.insert += ins + gap;
    } else {
      // 与脏区重叠：保守扩展；被删除的新内容长度从 insert 中扣除
      const overlapNew = Math.max(0, Math.min(toA, newEnd) - Math.max(fromA, pe.from));
      const oldFrom = fromA <= pe.from ? fromA : (fromA >= newEnd ? fromA - delta : pe.from);
      const oldTo = toA <= pe.from ? toA : (toA >= newEnd ? toA - delta : pe.to);
      pe.from = Math.min(pe.from, oldFrom);
      pe.to = Math.max(pe.to, oldTo);
      pe.insert += ins - overlapNew;
    }
  }

  // 预览改为按视口增量渲染：VirtualPreview 内部自己切割块 + 调度渲染；
  // App.svelte 这边只需要在停顿 400ms 后把新 source 推过去，并同步刷新字数统计。
  // 原本的 md.render(text) 全量调用被取消，避免停顿后整个文档解析。
  let stats = { words: 0, chars: 0 };
  let renderTimer: ReturnType<typeof setTimeout> | null = null;
  let hlVersion = 0; // 语言包加载完成后自增，触发 VirtualPreview 重切块
  setOnLangLoaded(() => { hlVersion++; });
  // 延迟 source：防抖后 VirtualPreview 才看到新 source，减少每击键重新切块 + 滚动重算
  let previewSource = source;
  // 相对 previewSource 的脏区间（随 previewSource 同步推送；undefined = 全量切块）
  let previewEdits: EditRange | undefined = undefined;
  // 超大文档降级：文档超过阈值后暂停实时预览（不推新 source），面板提示并提供手动刷新；
  // 文档缩小回阈值内自动恢复实时模式。
  let previewStale = false;
  // ---- 打开文件时预览延迟到空闲帧：编辑器首帧不被大文档切块阻塞 ----
  // 打开瞬间先清空旧预览（previewSource=""），内容在 requestIdleCallback 空闲时再推；
  // 若用户已开始打字（docDirty），让位给防抖路径（pushPreview 直接推最新全文），
  // 避免此处与 pushPreview 双写 previewSource 导致脏区间坐标系错位。
  let openPreviewToken = 0;
  function cancelOpenPreview() {
    openPreviewToken++; // 使挂起的空闲推送失效（再次打开 / 删除当前文件时调用）
  }
  function scheduleOpenPreview(content: string) {
    const token = ++openPreviewToken;
    // 打开瞬间清空旧预览；脏区间基准随 previewSource 一起重置（新文档坐标系）
    pendingEdit = null;
    previewEdits = undefined;
    previewSource = "";
    previewStale = content.length > previewMaxBytes;
    // 超阈值走降级模式：不切块不推送（20MB 首帧不被 ~636ms 切块阻塞），面板提示手动刷新
    if (previewStale) return;
    // 大文档（>8MB）打开/切换时自动收起预览面板（该档预览已降级、手动刷新亦被禁用，
    // 面板仅占宽度）；用户手动重开（Ctrl+\ / 工具栏）后本次会话不再自动折叠。
    if (content.length > BIG_DOC_BYTES && showPreview && !paneUserOverride) {
      showPreview = false;
      status = "文档较大，已收起预览（可点击工具栏眼睛按钮重新开启）";
    }
    const push = () => {
      if (token !== openPreviewToken) return; // 已被取消 / 更新
      // 用户已开始打字：让防抖路径（pushPreview）负责推送最新全文（首轮全量切块，安全回退）
      // 关键修复：之前用 `if (docDirty) return` 会被打开文件副作用触发（setDoc → onEditorDocChange
      // 同步设 docDirty=true），导致打开文件后预览一直空白，必须手动编辑一下才推（q14）。
      // 改为更精确的判定：previewSource 已经非空（pushPreview 已推过最新 pullDoc）就让位。
      if (previewSource !== "") return;
      previewSource = content;
      scheduleStats(content);
    };
    if (typeof requestIdleCallback === "function") requestIdleCallback(push, { timeout: 600 });
    else setTimeout(push, 60);
  }
  function pushPreview() {
    // 降级判定改用 O(1) 的 doc.length，避免先拉全文再丢弃（50MB 下击键路径彻底零 O(n)）
    if (view && view.state.doc.length > previewMaxBytes) {
      previewStale = true;
      return;
    }
    const text = pullDoc();
    source = text;
    scheduleStats(text);
    // 校验累计脏区间（长度不变式 + 边界）；不合法则放弃走全量，绝不误用
    let ed: EditRange | undefined;
    const pe = pendingEdit;
    if (pe && pe.from >= 0 && pe.from <= pe.to && pe.to <= previewSource.length &&
        text.length === previewSource.length + pe.insert - (pe.to - pe.from)) {
      ed = pe;
    }
    if (text.length > previewMaxBytes) {
      previewStale = true;
      // 降级期间不推 source：保留并继续累计脏区间（基准仍是旧 previewSource），
      // 文档缩小回实时模式时仍能走增量路径；若误重置会导致坐标系错位
    } else {
      previewStale = false;
      previewEdits = ed;
      previewSource = text;
      pendingEdit = null;
    }
  }
  function schedulePreview() {
    if (renderTimer) clearTimeout(renderTimer);
    renderTimer = setTimeout(pushPreview, 400);
  }
  // 手动刷新：超大文档降级模式下用户点击后一次性更新预览
  function refreshPreview() {
    // 大文档禁用手动刷新：一次性全量切块会触发数百 ms 长任务，冻结主线程
    if (view && view.state.doc.length > manualRefreshMax) {
      const mb = manualRefreshMax >> 20;
      status = `文档过大（>${mb}MB），已禁用手动刷新以保持流畅`;
      return;
    }
    const text = pullDoc();
    source = text;
    pendingEdit = null;
    previewEdits = undefined;
    previewSource = text;
    previewStale = false;
    scheduleStats(text);
  }
  // 高亮语言包就绪 / 版本变化时，用当前文档重刷一次预览（source 未变也要重渲染）
  $: if (hlReady || hlVersion > 0) schedulePreview();

  // UX-1：预览被自动降级/禁用时的状态栏说明。
  // 两级：超过 previewMaxBytes → 实时预览暂停（仍可手动刷新）；
  //       超过 manualRefreshMax → 手动刷新也禁用（全量切块会造成数百 ms 长任务）。
  $: previewDisabledNotice =
    docLength > manualRefreshMax
      ? `预览已禁用（文档 ${(docLength / (1 << 20)).toFixed(1)}MB > ${manualRefreshMax >> 20}MB）`
      : previewStale && docLength > previewMaxBytes
        ? "实时预览已暂停（文档较大），可点刷新按钮更新"
        : "";

  // ---- 字数 / 字符统计（CJK 按字计，拉丁按词计）----
  // 单遍循环替代三次全文正则；并移出渲染关键路径，预览更新后空闲时再算
  function computeStats(text: string) {
    let cjk = 0, latinWords = 0, chars = 0, inWord = false;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c !== 10) chars++;
      if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf)) {
        cjk++;
        inWord = false;
        continue;
      }
      const isLatin = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
      if (isLatin) {
        if (!inWord) { latinWords++; inWord = true; }
      } else {
        inWord = false;
      }
    }
    return { words: cjk + latinWords, chars };
  }

  function scheduleStats(text: string) {
    const run = () => { stats = computeStats(text); };
    if (windowBusy) return; // 窗口拖拽/缩放期间跳过统计计算（P1-1）
    if (typeof requestIdleCallback === "function") requestIdleCallback(run);
    else setTimeout(run, 0);
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

  let lastTitle = "";
  function updateTitle() {
    const name = currentPath ? basename(currentPath) : "未命名.md";
    const title = dirty ? `${name} ● - LiteMD` : `${name} - LiteMD`;
    // 标题未变化时跳过 IPC，避免每次击键触发 setTitle 跨进程调用
    if (title === lastTitle) return;
    lastTitle = title;
    tauriWindow?.setTitle(title);
  }

  // 未保存状态变化时同步标题（dirty 翻转才触发，非每次击键）
  $: if (dirty !== undefined) updateTitle();

  // 解析最终主题：auto 时跟随系统配色（prefers-color-scheme）
  function resolvedTheme(): "light" | "dark" {
    if (settings.theme === "auto") {
      return typeof window !== "undefined" &&
        window.matchMedia &&
        window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
    }
    return settings.theme;
  }

  function applyAppearance() {
    const dark = resolvedTheme() === "dark";
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    if (view) setAppearance(view, dark, settings.fontSize);
  }
  // 主题变更（标题栏切换 / 设置面板选择）即时重渲染；auto 下依赖下方 matchMedia 监听
  $: if (view && settings.theme !== undefined) applyAppearance();

  onMount(() => {
    let disposed = false;

    // 轻量崩溃日志：仅记录未捕获异常，供排障回传（平时无日志、不影响体验）
    if (typeof window !== "undefined") {
      const sendLog = (msg: string) => { try { void logFrontend(msg); } catch { /* ignore */ } };
      window.addEventListener("error", (e: any) => {
        sendLog(`ERROR ${e.message} @ ${e.filename}:${e.lineno} :: ${e.error && e.error.stack ? e.error.stack : ""}`);
        // 仅对未在被 try/catch 兜住的运行时错误展示错误页（避免正常流程的轻微报错刷屏）
        if (!fatalError) fatalError = { msg: e.message || "未知错误", stack: e.error?.stack || "" };
      });
      window.addEventListener("unhandledrejection", (e: any) => {
        sendLog(`UNHANDLED_REJECTION ${e.reason && e.reason.stack ? e.reason.stack : String(e.reason)}`);
        if (!fatalError)
          fatalError = {
            msg: String(e.reason?.message || e.reason || "未处理的异步异常"),
            stack: e.reason?.stack || String(e.reason),
          };
      });

      // 自动主题：跟随系统配色（仅当 theme=auto 时响应系统切换）
      try {
        const mq = window.matchMedia("(prefers-color-scheme: dark)");
        const onScheme = () => {
          if (settings.theme === "auto") applyAppearance();
        };
        if (mq.addEventListener) mq.addEventListener("change", onScheme);
        else if ((mq as any).addListener) (mq as any).addListener(onScheme);
      } catch {
        /* 旧浏览器无 matchMedia，忽略 */
      }
    }

    // 窗口显示（幂等）：visible:false 时窗口靠前端主动 show。
    // 任何路径漏掉调用都会让用户看到「应用启动了但没界面」，故统一收口 + 超时兜底。
    let windowShown = false;
    const showWindowOnce = async () => {
      if (windowShown) return;
      windowShown = true;
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow().show();
      } catch { /* browser dev mode */ }
    };
    // 硬超时保险：初始化若卡死（await 永久 pending，catch 救不了），4s 后强制显示窗口
    const showFailsafe = setTimeout(() => { void showWindowOnce(); }, 4000);

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
      // 窗口拖拽/缩放：置忙挂起后台任务（P1-1）
      tauriWindow!.onMoved(markWindowBusy).then((fn: () => void) => { unlistenMoved = fn; }).catch(() => {});
      tauriWindow!.onResized(markWindowBusy).then((fn: () => void) => { unlistenResized = fn; }).catch(() => {});
    }).catch(() => {
      // 浏览器调试模式，无 Tauri 窗口 API
    });

    // 粘贴图片：窗口级拦截（仅当剪贴板含图片时生效）
    // m-05：先 remove 再 add，保证幂等。HMR 或异常路径下 onMount 可能重入，
    // 重复监听会让同一张图被插入两次。onPaste 是稳定函数引用，remove 必然命中。
    window.removeEventListener("paste", onPaste);
    window.addEventListener("paste", onPaste);

    // ---- 内存压力自愈（P0）：渲染进程堆超限时分级释放缓存，守住 ≤200MB 预算 ----
    // performance.memory 为 Chromium 专有；WebView2 不可用时静默跳过（降级为手动关标签释放）。
    memTimer = setInterval(() => {
      const m = (performance as any).memory;
      if (!m || typeof m.usedJSHeapSize !== "number") return;
      const usedMB = m.usedJSHeapSize / (1 << 20);
      const limitMB = lowEndMode ? 120 : 180;
      if (usedMB > limitMB && !memReliefEnabled) {
        memReliefEnabled = true;           // 开启视口外 img 卸载（回收解码位图）
        memReliefLowSamples = 0;
        previewRef?.clearCache();          // 预览块 HTML 缓存
        docMemo = null;                    // 文档字符串副本（下次消费者重新 toString）
        previewRef?.pauseIdlePrerender();
        console.warn(`[mem] 堆压力 ${usedMB.toFixed(0)}MB > ${limitMB}MB，已释放缓存`);
        status = `内存偏高（${usedMB.toFixed(0)}MB），已临时降低预览质量以保持流畅`;
      } else if (memReliefEnabled) {
        // UX-2：自愈可逆。旧实现「粘性不回退」，关掉大文档后低端设备也要重开应用
        // 才能恢复预渲染。改为带迟滞的自动退出：连续 3 次采样（约 15s）低于
        // 阈值的 70% 才恢复，避免在阈值附近反复开关引起抖动。
        if (usedMB < limitMB * 0.7) {
          memReliefLowSamples++;
          if (memReliefLowSamples >= 3) {
            memReliefEnabled = false;
            memReliefLowSamples = 0;
            previewRef?.resumeIdlePrerender();
            console.info(`[mem] 堆回落至 ${usedMB.toFixed(0)}MB，已恢复正常预览质量`);
            status = "内存已回落，预览质量恢复正常";
          }
        } else {
          memReliefLowSamples = 0;
        }
      }
    }, 5000);

    // ---- 性能度量埋点（dev build 常开）：长任务 / 输入延迟 ----
    if (import.meta.env.DEV && typeof PerformanceObserver !== "undefined") {
      try {
        perfObservers.push(new PerformanceObserver((l) => {
          for (const e of l.getEntries()) {
            if (e.duration > 50) console.warn("[longtask]", e.duration.toFixed(1), "ms");
          }
        }));
        perfObservers[perfObservers.length - 1].observe({ type: "longtask", buffered: true } as any);
      } catch { /* longtask 不支持时忽略 */ }
      try {
        perfObservers.push(new PerformanceObserver((l) => {
          for (const e of l.getEntries() as any[]) {
            if (e.name === "keydown" && e.duration > 16) {
              console.debug("[input]", (e.processingEnd - e.startTime).toFixed(1), "ms");
            }
          }
        }));
        perfObservers[perfObservers.length - 1].observe({ type: "event", durationThreshold: 16, buffered: true } as any);
      } catch { /* event timing 不支持时忽略 */ }
    }

    let unlistenClose: (() => void) | null = null;
    let unlistenDrop: (() => void) | null = null;
    let unlistenOpenFiles: (() => void) | null = null;
    let unlistenMoved: (() => void) | null = null;
    let unlistenResized: (() => void) | null = null;
    let bootReady = false;
    let pendingOpenFiles: string[] = [];

    (async () => {
      settings = await loadSettings();
      // 双保险：确保数组字段永不为 undefined/null，避免渲染时 .some/.filter 越界崩溃
      settings.hiddenPaths = settings.hiddenPaths ?? [];
      settings.roots = settings.roots ?? [];
      settings.openTabs = settings.openTabs ?? [];
      if (disposed) return;

      appliedFontSize = settings.fontSize; // 预测式缩放手感的基准字号（P1-3）
      showTree = settings.showTree;
      showPreview = settings.showPreview;
      applyAppearance();
      logInfo("LiteMD 启动");

      // 首次启动显示快捷键示意图
      if (!settings.shortcutGuideShown) {
        showShortcutGuide = true;
      }

      // 热启动事件监听：提前注册（在 take_open_files 之前），避免初始化期间
      // single-instance 插件转发的 open-files 事件因监听器尚未注册而丢失。
      // 若初始化未完成（bootReady=false），路径暂存到队列，初始化后统一处理。
      listen<string[]>("open-files", (e) => {
        const payload = e.payload || [];
        if (!bootReady) {
          pendingOpenFiles.push(...payload);
          return;
        }
        if (payload.length > 0 && view && tabs.length === 0) {
          setDoc(view, "");
          source = "";
          lastSaved = null;
        }
        for (const p of payload) openFileByPathSafe(p);
      }).then((unlisten) => {
        unlistenOpenFiles = unlisten;
      }).catch(() => {});

      // ---- 启动前先消费 Rust 端待打开文件，避免欢迎页先渲染再被替换（q15）----
      // 冷启动：take_open_files 拿到 .md 关联 / 命令行参数；热启动（single-instance 插件
      // 转发）由下方的 listen("open-files") 捕获。这里必须先 take_open_files 再创建编辑器，
      // 否则编辑器初始 doc 会被设为欢迎页（默认 source），再被 openFileByPath 覆盖造成闪烁。
      //
      // v1.4.0 强化：take_open_files 是**只读不删**（lib.rs），ack_open_files 才清空缓存；
      // 这里如果首次返回空（HMR、Slow webview、Vite 慢启动等 race 场景）则重试 4 次，
      // 总等待 ≤400ms，可覆盖所有已知 race。拿到路径后尽快 ack，避免下次启动残留。
      let initialPaths: string[] = [];
      // 冷启动重试加固：WebView2 冷启动较慢时，首次 invoke 可能尚未就绪而返回空，
      // 延长至 6 次 / 80ms（≈480ms）覆盖慢启动 race，避免 take_open_files 偶发空导致
      // 「双击 .md 却没打开 / 停在首页」的回归（q14 边界）。
      for (let attempt = 0; attempt < 6 && initialPaths.length === 0; attempt++) {
        try {
          initialPaths = await invoke<string[]>("take_open_files");
        } catch (e) {
          console.warn(`[boot] take_open_files 失败 (attempt ${attempt}):`, e);
        }
        if (initialPaths.length === 0 && attempt < 5) {
          await new Promise((r) => setTimeout(r, 80));
        }
      }
      console.info("[boot] initialPaths:", JSON.stringify(initialPaths));
      // 拿到路径即 ack 清空缓存（即使后续 openFileByPath 失败也不影响本次启动）
      if (initialPaths.length > 0) {
        invoke("ack_open_files").catch((e) => console.warn("[boot] ack_open_files 失败:", e));
      }

      // ---------- 预计算会话恢复数据（先收集内容，再统一设置 source → 避免闪烁）----------
      // 常规启动（initialPaths.length===0）：先算会话恢复的 restored[]，
      // 把第一个标签内容作为 createEditor 的 doc，后续 applyTabState 写回同内容，
      // 让用户看不到欢迎页或旧文档在闪。
      const openPathsForRestore: string[] =
        initialPaths.length === 0 && settings.openTabs.length
          ? settings.openTabs
          : initialPaths.length === 0 && settings.lastFile
            ? [settings.lastFile]
            : [];
      const sessionTabs = initialPaths.length === 0 ? loadSession() : [];
      type RestoredItem = {
        path: string; content: string | null; savedContent: string;
        dirty: boolean; cursorPos: number | null; deferred?: boolean;
      };
      const restoredEarly: RestoredItem[] = [];
      for (const p of openPathsForRestore) {
        const np = norm(p);
        if (restoredEarly.some((r) => r.path === np)) continue;
        const s = sessionTabs.find((st: any) => st.path === np);
        let content: string | null = s ? s.content : null;
        let savedContent = s ? s.saved : "";
        let dirty = s ? s.dirty : false;
        if (content === "") content = null;
        if (content === null) {
          try {
            let sz = 0;
            try { sz = await fileSize(np); } catch { sz = 0; }
            if (sz > BIG_DOC_BYTES) {
              restoredEarly.push({ path: np, content: "", savedContent: "", dirty: false, cursorPos: s ? s.cursor : null, deferred: true });
              continue;
            }
            content = await readFile(np);
            savedContent = content;
            dirty = false;
          } catch (e) {
            console.warn("[session] 恢复标签失败:", np, e);
            continue;
          }
        }
        restoredEarly.push({ path: np, content, savedContent: savedContent || content, dirty, cursorPos: s ? s.cursor : null });
      }

      // 设置编辑器初始 doc：
      // - 冷启动带文件：预读第一个待打开文件内容（同 v1.4.2）
      // - 常规启动有会话：用 restoredEarly[0].content，避免欢迎页一闪
      // - 都没有（首次启动/无会话）：空字符串，后序完成后再填欢迎页
      if (initialPaths.length > 0) {
        const first = normalizeOpenPath(initialPaths[0]);
        try {
          let sz = 0;
          try { sz = await fileSize(first); } catch { sz = 0; }
          if (sz <= BIG_DOC_BYTES) {
            const c = await readFile(first);
            if (c) source = c;
          }
        } catch { /* openFileByPath 兜底 */ }
      } else if (restoredEarly.length > 0 && restoredEarly[0].content && !restoredEarly[0].deferred) {
        source = restoredEarly[0].content;
      }

      view = createEditor({
        parent: editorHost,
        doc: source,
        dark: settings.theme === "dark",
        fontSize: settings.fontSize,
        cmKeys: cmKeysOf(settings.shortcuts),
        onChange: (fa, ta, fb, tb) => onEditorDocChange(fa, ta, fb, tb),
        onCursor: (l, c) => { cursorLine = l; cursorCol = c; },
        onQuickAction,
      });
      lastSaved = source;

      // 打开启动参数中的文件（编辑器已创建，因为 applyTabState 需要 view）
      if (initialPaths.length) {
        status = `打开 ${initialPaths.length} 个文件…`;
        for (const p of initialPaths) await openFileByPath(p);
      }

      // 滚动同步：编辑器 → 预览（按比例单向，避免反馈循环）。
      let syncPending = false;
      view.scrollDOM.addEventListener("scroll", () => {
        if (!showPreview || syncPending) return;
        syncPending = true;
        requestAnimationFrame(() => {
          syncPending = false;
          if (!showPreview || !previewRef || !view) return;
          const scroller = view.scrollDOM;
          const max = scroller.scrollHeight - scroller.clientHeight;
          if (max <= 0) return;
          previewRef.scrollToRatio(scroller.scrollTop / max);
        });
      }, { passive: true });

      // 恢复多根工作区（懒加载文件树：只列举根层，逐层展开，避免整树递归卡死/崩溃）
      const hlPromise = initHighlight();
      const mdPromise = initMd().catch(() => null);
      await Promise.all([hlPromise, mdPromise]);
      if (disposed) return;
      {
        const seeded: string[] =
          settings.roots && settings.roots.length
            ? settings.roots.slice()
            : settings.lastFolder
            ? [settings.lastFolder]
            : [];
        // 恢复文件树偏好：折叠集合 / 排序 / 附件可见性
        treeStore.setCollapsed(new Set(settings.treeCollapsed));
        treeStore.setSort(settings.treeSort);
        treeStore.setShowNonMd(settings.showNonMd);
        // 根路径统一归一化（settings.roots 可能为旧版反斜杠格式，避免与正斜杠路径重复添加）
        const normedRoots = seeded.map((r) => norm(r));
        treeStore.setRoots(normedRoots);
        // 根目录逐层懒加载；单个根失败不阻塞启动（错误在树节点上内联提示）
        // 加载完成后自动移除已不存在的根目录（用户手动删除后重启的场景）
        Promise.all(normedRoots.map((r) => loadFolderNode(treeStore, r, false)))
          .then(() => {
            const s = treeStore.get();
            const deadRoots = normedRoots.filter((rp) => {
              const node = s.nodeMap.get(rp);
              const ls = s.loadState.get(rp);
              return node && !node.loaded && ls?.error;
            });
            if (deadRoots.length) {
              console.warn("[startup] 移除已不存在的根目录:", deadRoots);
              treeStore.setRoots(s.rootPaths.filter((p) => !deadRoots.includes(p)));
              onTreeRootsChanged(treeStore.get().rootPaths, null);
            }
          })
          .catch(() => {});
      }

      // 关键修复：若本次启动是通过文件关联 / 命令行显式打开了文件（initialPaths 非空），
      // 则【不】恢复上次会话标签——initialPaths 的文件已在上方 openFileByPath 中打开并加入 tabs。
      if (initialPaths.length === 0) {
        try {
          if (restoredEarly.length > 0) {
            // restoredEarly 已预算并把第一个内容写进了编辑器，直接写入 tabs 并 apply 同一内容，
            // setDoc 用同文本不会有视觉闪烁。
            tabs = restoredEarly as unknown as TabState[];
            activeIdx = 0;
            applyTabState(restoredEarly[0] as unknown as TabState);
            settings.lastFile = restoredEarly[0].path;
            status = `已恢复 ${restoredEarly.length} 个标签`;
            saveSession();
          } else if (tabs.length === 0 && (!source || source === "")) {
            // 首次启动 / 无任何会话数据：最后才注入欢迎页，避免短暂出现后被替换
            source = WELCOME_TEXT;
            setDoc(view, source);
            lastSaved = source;
          }
        } catch (e) {
          // 恢复失败绝不让应用崩溃：回退到欢迎页，保证窗口可用，并记录错误便于定位
          console.error("[restore] failed:", e);
          try { if (view) setDoc(view, WELCOME_TEXT); } catch {}
          source = WELCOME_TEXT;
          lastSaved = source;
        }
      }

      configPath = await settingsFilePath();
      if (!disposed) hlReady = true;

      // 初始化完成：处理暂存的热启动事件（初始化期间 single-instance 转发的文件路径）
      bootReady = true;
      if (pendingOpenFiles.length > 0) {
        // 过滤掉已在 initialPaths 中处理过的文件，避免重复打开
        const newFiles = pendingOpenFiles.filter((p) => {
          const np = norm(p);
          return !initialPaths.some((ip) => norm(ip) === np);
        });
        // 只有当 initialPaths 为空且有新文件需要打开时，才清除会话恢复的标签
        if (initialPaths.length === 0 && newFiles.length > 0 && tabs.length > 0) {
          // 检查新文件是否已在恢复的标签中
          const alreadyOpen = newFiles.some((p) => tabs.some((t) => t.path === norm(p)));
          if (!alreadyOpen) {
            tabs = [];
            activeIdx = 0;
            if (view) { setDoc(view, ""); source = ""; lastSaved = null; }
          }
        }
        for (const p of newFiles) openFileByPathSafe(p);
        pendingOpenFiles = [];
      }

      // 窗口可见：初始化完成后才显示，避免欢迎页/空白一闪而过（visible:false in tauri.conf.json）
      clearTimeout(showFailsafe);
      if (!disposed) await showWindowOnce();
    })().catch((e) => {
      // 初始化失败也必须显示窗口，否则用户会看到应用「启动了但没界面」
      console.error("[boot] 初始化失败:", e);
      clearTimeout(showFailsafe);
      bootReady = true;
      void showWindowOnce();
    });

    return () => {
      disposed = true;
      clearTimeout(showFailsafe);
      view?.destroy();
      unlistenClose?.();
      unlistenDrop?.();
      unlistenMoved?.();
      unlistenOpenFiles?.();
      unlistenResized?.();
      if (windowBusyTimer) clearTimeout(windowBusyTimer);
      if (memTimer) { clearInterval(memTimer); memTimer = null; }
      perfObservers.forEach((o) => { try { o.disconnect(); } catch { /* ignore */ } });
      document.body.classList.remove("window-busy");
      window.removeEventListener("paste", onPaste);
    };
  });

  // ---------- 设置变更 ----------
  function onSettingsChange() {
    applyAppearance();
    if (view) setKeymap(view, cmKeysOf(settings.shortcuts));
    if (view) setWrap(view, settings.wrap);
    logOp("修改设置");
    persist();
  }

  // 预测式缩放（P1-3）：连续按 Ctrl+/- 时，先瞬时 transform:scale 编辑区（零 layout，<16ms 视觉反馈），
  // 再于 rAF 内提交真实字号（CodeMirror Compartment 重配置，仅视口几十行 O(视口)），主线程不阻塞。
  // appliedFontSize = 上次真实提交的字号，用作 transform 比例基准，避免多帧内连按时比例错位。
  let appliedFontSize = FONT_SIZE_MIN;
  let fontRaf = 0;
  function bumpFont(delta: number) {
    const next = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, settings.fontSize + delta));
    if (next === settings.fontSize) return;
    settings.fontSize = next;
    // 每次按键都用「最新目标字号 / 已提交基准字号」覆写 transform，保证同帧内连按时比例始终最新，
    // 提交瞬间视觉 = 基准×比例 = 最新字号，与真实字号无缝衔接（P1-3 预测式缩放）。
    if (editorHost) {
      const ratio = next / appliedFontSize;
      editorHost.style.transition = "none";
      editorHost.style.transformOrigin = "top left";
      editorHost.style.transform = `scale(${ratio})`;
    }
    if (!fontRaf) {
      fontRaf = requestAnimationFrame(() => {
        fontRaf = 0;
        appliedFontSize = settings.fontSize;
        if (editorHost) {
          editorHost.style.transition = "transform 70ms ease-out";
          editorHost.style.transform = "none";
        }
        applyAppearance(); // 真实字号落地；预览由 ResizeObserver 自行校正高度（配合 Fenwick 仍 O(log²n)）
        persist();
      });
    }
    status = `字号 ${settings.fontSize}px`;
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

  // ISSUE-011 修复：互斥锁串行化文件打开，防止并发调用导致标签重复/状态混乱
  let openingLock: Promise<void> = Promise.resolve();
  async function openFileByPath(p: string) {
    // 防御：文件关联/拖拽/命令行可能带来引号或 file:// 前缀（Windows 注册表 "%1"、某些环境 URI 形式）
    const np = normalizeOpenPath(p);
    logOp("打开文件: " + np);
    const prev = openingLock;
    let release!: () => void;
    openingLock = new Promise<void>((r) => { release = r; });
    try {
      await prev;
      await openTabByPath(np);
    } catch (e) {
      throw e;
    } finally {
      release();
    }
  }

  // ISSUE-006 修复：带错误反馈的 fire-and-forget 包装
  function openFileByPathSafe(p: string) {
    openFileByPath(p).catch((e) => {
      status = "打开失败：" + String(e);
    });
  }

  // 打开/添加文件夹为根（快捷键 Ctrl+Shift+O / 设置面板「选择目录」）
  async function openFolder() {
    const folder = await pickOpenFolder();
    if (!folder) return;
    logOp("打开文件夹: " + folder);
    await loadFolderIntoTree(folder);
  }
  // 加入工作区根并懒加载该层；同步持久化 settings.roots/lastFolder
  async function loadFolderIntoTree(folder: string) {
    const np = norm(folder);
    if (!treeStore.get().rootPaths.includes(np)) treeStore.addRoot(np);
    // 总是 force 重加载：清掉历史 error，避免首次 listDir 偶发失败残留「无法访问」后无法重试
    await loadFolderNode(treeStore, np, treeStore.get().showHidden, true);
    onTreeRootsChanged(treeStore.get().rootPaths, np);
    status = "已加载目录 " + basename(np);
  }
  // FileTree handlers.onRootsChanged：根列表/默认目录变化 → 持久化
  function onTreeRootsChanged(roots: string[], lastFolder: string | null) {
    settings.roots = roots;
    if (lastFolder) settings.lastFolder = lastFolder;
    persist();
  }
  // FileTree handlers.setTreePrefs：折叠集合/排序/附件可见性 → 持久化
  // 关键：仅在值真正变化时才 persist()，避免 FileTree 的 $: state.collapsed 响应式
  // 与 persist → settings 更新 → 重新渲染 → 再次触发 $: 形成无限循环
  // （每次循环都调用 resolveLowEnd → detectLowEnd → getGpuRenderer → 创建 WebGL 上下文 → 耗尽）
  function onTreePrefsChange(prefs: { collapsed: string[]; sort: string; showNonMd: boolean }) {
    const newSort = prefs.sort as "name" | "mtime" | "size" | "type";
    const changed =
      JSON.stringify(settings.treeCollapsed ?? []) !== JSON.stringify(prefs.collapsed) ||
      settings.treeSort !== newSort ||
      settings.showNonMd !== prefs.showNonMd;
    if (!changed) return;
    settings.treeCollapsed = prefs.collapsed;
    settings.treeSort = newSort;
    settings.showNonMd = prefs.showNonMd;
    persist();
  }
  // ---- 预览编辑模式：隐藏 markdown 编辑器，全屏显示可编辑的渲染预览 ----
  // contenteditable 渲染 HTML；编辑后防抖用 turndown 转回 markdown 写回 CodeMirror。
  let previewEditMode = false;
  let previewEditBefore = { preview: true };
  let previewEditEl: HTMLDivElement | null = null;
  let previewEditTimer: ReturnType<typeof setTimeout> | null = null;
  let detachPreviewKeys: (() => void) | null = null;
  let td: TurndownService | null = null;
  function initTurndown(): TurndownService {
    if (td) return td;
    const t = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
      emDelimiter: "*",
      bulletListMarker: "-",
    });
    t.use(gfm);
    // 图片：把渲染时生成的 asset URL / 转义还原为原始引用
    t.addRule("litemd-images", {
      filter: "img",
      replacement: (_content, node) => {
        const el = node as HTMLElement;
        // 预览编辑内插入的图片带 data-md-src（原始 markdown 引用），优先还原；
        // 渲染产生的图片只有 asset URL，走下方前缀还原
        const mdRef = el.getAttribute("data-md-src");
        let src = mdRef || el.getAttribute("src") || "";
        if (!mdRef) {
          // convertFileSrc 前缀还原：http://asset.localhost/<urlencoded 路径>
          const prefix = "http://asset.localhost/";
          if (src.startsWith(prefix)) {
            try {
              src = decodeURIComponent(src.slice(prefix.length));
            } catch {
              src = src.slice(prefix.length);
            }
          }
        }
        const alt = (el.getAttribute("alt") || "").replace(/"/g, '&quot;');
        return `![${alt}](${src})`;
      },
    });
    // 下划线：execCommand('underline') 产出 <u> → 还原为编辑器模式的 __ 标记
    t.addRule("litemd-underline", {
      filter: "u",
      replacement: (content) => (content ? `__${content}__` : ""),
    });
    // 硬换行：<br> → 「两个空格+换行」，对齐编辑器 Shift+Enter 软换行（同段内）
    t.addRule("litemd-br", { filter: "br", replacement: () => "  \n" });
    // 链接：覆盖默认 inlineLink，对纯 fragment 锚点（GitHub 风格目录跳转 #%E7%AC%AC...）
    // 做 decodeURIComponent 归一化，源码视图 / 回写都变成可读中文锚点，对齐其他编辑器
    t.addRule("inlineLink", {
      filter: (node) =>
        node.nodeName === "A" &&
        (node as Element).hasAttribute("href"),
      replacement: (content, node) => {
        const el = node as HTMLElement;
        let href = el.getAttribute("href") || "";
        // 仅对 fragment 锚点（href 以 # 开头、无 ?、无 / 段）解码——目录链接的典型形态
        // 解码后再 escapeLinkDestination 等价处理：<>、()、空格用 <...> 包裹
        if (href.charAt(0) === "#" && href.indexOf("?") === -1) {
          try {
            const dec = decodeURIComponent(href);
            // 解码后必须「无 % 残留」才算有效编码（避免误改含字面 % 的锚点）
            if (dec.indexOf("%") === -1) href = dec;
          } catch {
            /* 保留原值 */
          }
        }
        const escaped = href.replace(/([<>()])/g, "\\$1");
        const finalHref = escaped.indexOf(" ") >= 0 ? "<" + escaped + ">" : escaped;
        const title = el.getAttribute("title");
        const titlePart = title ? ` "${title.replace(/"/g, '\\"')}"` : "";
        return `[${content}](${finalHref}${titlePart})`;
      },
    });
    td = t;
    return t;
  }
  // 进入预览编辑的「进行中」守卫：enterPreviewEdit 是 async，previewEditMode 同步置位后
  // 存在 await 间隙；若此期间再次触发切换，三元表达式会误判为「已开启」从而调用 exit 中止进入，
  // 表现为「切换不灵 / 闪一下」。用该标志位阻断重入。
  let enteringPreview = false;

  async function enterPreviewEdit() {
    if (previewEditMode || enteringPreview || !view) return;
    enteringPreview = true;
    try {
      const text = pullDoc();
      source = text;
      previewEditBefore = { preview: showPreview };
      previewEditMode = true;
      showPreview = false;
      await tick();
      // 确保 contenteditable 已挂载（{if previewEditMode} 渲染后再 bind:this）
      if (!previewEditEl) await tick();
      if (!previewEditEl) {
        // 容器仍未就绪：回滚，避免停留在「空白预览编辑」半成品态
        previewEditMode = false;
        showPreview = previewEditBefore.preview;
        return;
      }
      const m = md ?? (await initMd());
      previewEditEl.innerHTML = safeRender(m, text); // C-01：清洗后注入
      // contenteditable 新段落统一用 <p>（turndown 往返稳定）
      document.execCommand("defaultParagraphSeparator", false, "p");
      // 挂载键盘增强：快捷键/智能 Enter/缩进/图片粘贴（与源码编辑器对齐）
      detachPreviewKeys?.();
      detachPreviewKeys = attachPreviewEditKeys(previewEditEl, {
        shortcuts: settings.shortcuts,
        onInput: onPreviewEditInput,
        onFind: (replace) => {
          exitPreviewEdit();
          if (view) {
            view.focus();
            openSearchPanelCmd(replace)(view);
          }
        },
        // 图片插入在预览编辑内完成（不退出模式）：光标处插 <img>，turndown 还原 markdown 引用
        onPickImage: async () => {
          const p = await pickImageFile();
          if (!p) return null;
          const r = await resolveImageRef(p);
          status = "图片已插入";
          return { url: convertFileSrc(r.abs), ref: r.ref };
        },
        onImportImageFile: async (f) => {
          const r = await assetFromImageFile(f);
          if (!r) return null;
          status = "图片已插入";
          return { url: convertFileSrc(r.abs), ref: r.ref };
        },
        setStatus: (msg) => { status = msg; },
      });
      previewEditEl.focus();
      status = "预览编辑模式：直接编辑渲染结果，自动同步 markdown（再次点击退出）";
    } catch (err) {
      // 渲染/挂载失败：回滚到 markdown 编辑，避免空白或卡死
      console.error("[preview-edit] 进入失败:", err);
      previewEditMode = false;
      showPreview = previewEditBefore.preview;
      status = "进入预览编辑失败，已恢复原编辑";
    } finally {
      enteringPreview = false;
    }
  }
  function togglePreviewEdit() {
    if (enteringPreview) return;
    if (previewEditMode) exitPreviewEdit();
    else void enterPreviewEdit();
  }
  function exitPreviewEdit() {
    if (!previewEditMode) return;
    flushPreviewEdit();
    detachPreviewKeys?.();
    detachPreviewKeys = null;
    previewEditMode = false;
    showPreview = previewEditBefore.preview;
    status = "已退出预览编辑，恢复 markdown 编辑";
  }
  function onPreviewEditInput() {
    if (previewEditTimer) clearTimeout(previewEditTimer);
    previewEditTimer = setTimeout(flushPreviewEdit, 800);
    // 工具栏点击标题/列表/插入表格/插入图片等通过 previewExec 触发回写后,
    // contenteditable 不会自动跟随光标。这里把光标滚入视口底部,
    // 保证"插入内容后立即可见",满足最后一行显示需求。
    // scrollCaretIntoView 自身有"已在可视区内则跳过"的判定,常规键入也安全。
    if (previewEditEl) scrollCaretIntoView(previewEditEl);
  }
  function flushPreviewEdit() {
    if (previewEditTimer) {
      clearTimeout(previewEditTimer);
      previewEditTimer = null;
    }
    if (!previewEditEl || !view) return;
    let text: string;
    try {
      // M-04：contenteditable 内容可能被粘贴进任意 HTML（含 <script>），
      // 先清洗再 turndown，杜绝恶意 HTML 经由「编辑→保存」落盘持久化。
      text = initTurndown().turndown(sanitizeHtml(previewEditEl.innerHTML));
    } catch (err) {
      // turndown 对畸形 DOM 可能抛错；此时保持编辑器原内容不动，避免清空文档
      console.error("[preview-edit] HTML→markdown 转换失败:", err);
      status = "预览编辑内容转换失败，已保留原文档内容";
      return;
    }
    // M-02 ①：内容无变化直接跳过。
    // 旧实现每次退出预览编辑都整篇 setDoc，即使一个字没改也会产生一条
    // 巨型 undo 记录并把 docDirty 置脏，导致「只是看了一眼就被标记为已修改」。
    const baseline = view.state.doc.length === source.length ? source : view.state.doc.toString();
    const d = diffRange(baseline, text);
    if (!d) return;
    // M-02 ②：只替换差异区间，撤销历史保持细粒度、光标由 CM 自动映射；
    // applyExternalEdit 不调用 focus()，避免防抖回写抢走 contenteditable 焦点。
    suppressSave = true;
    const changed = applyExternalEdit(view, d.from, d.to, d.insert);
    suppressSave = false;
    if (!changed) {
      // 基准失配（越界）→ 退回整篇替换兜底，保证内容不丢
      suppressSave = true;
      setDoc(view, text);
      suppressSave = false;
    }
    source = text;
    docDirty = true; // 预览编辑视为文档变更（自动保存/会话持久化照常）
    queueAutoSave();
    queueSessionSave();
    scheduleStats(text);
    updateTitle();
  }

  async function save() {
    if (previewEditMode) flushPreviewEdit(); // 预览编辑模式下先同步编辑器内容
    // P0 数据安全：applyTabState 期间（currentPath 已设、source/lastSaved 尚未同步到新文档）
    // 用户按 Ctrl+S 会被陈旧欢迎页/旧标签内容覆盖原文件。这里禁止写盘直到载入流程完成。
    if (suppressSave) {
      status = "正在切换文档，已暂存本次编辑（自动保存恢复后生效）";
      return;
    }
    if (tabs[activeIdx]?.loadFailed) {
      // P0 数据安全：该文件打开/载入失败，编辑器内容与磁盘无关联，禁止写盘覆盖原文件
      status = "文件加载失败，已禁止保存（原文件未被修改）";
      logError("保存被拦截：文件加载失败 " + (currentPath ?? ""));
      return;
    }
    if (!currentPath) return saveAs();
    // P0 数据安全：未建立保存基准（lastSaved=null）禁止写盘，对齐 queueAutoSave 的拦截
    if (lastSaved === null) {
      status = "保存基准未建立，已禁止保存（原文件未被修改）";
      return;
    }
    const text = pullDoc();
    // P0 数据安全：编辑器内容与 lastSaved 完全一致时为 no-op，避免无谓的磁盘写入
    if (text === lastSaved) {
      docDirty = false;
      updateTitle();
      return;
    }
    await writeFile(currentPath, text);
    source = text;
    lastSaved = text;
    docDirty = false;
    const tab = tabs[activeIdx];
    if (tab) {
      tab.content = text;
      tab.savedContent = text;
      tab.dirty = false;
    }
    status = "已保存 " + basename(currentPath);
    logOp("保存文件: " + currentPath);
    updateTitle();
    saveSession();
  }

  async function saveAs() {
    if (suppressSave) {
      status = "正在切换文档，已禁止另存为（自动保存恢复后生效）";
      return;
    }
    const p = await pickSaveFile();
    if (!p) return;
    const np = norm(p);
    const text = pullDoc();
    await writeFile(np, text);
    // 目标路径已在其它标签打开：写盘后关闭当前标签，已有标签采用最新内容（避免重复标签）
    const dup = tabs.findIndex((t) => t.path === np && t.path !== currentPath);
    if (dup >= 0) {
      const dupTab = tabs[dup];
      dupTab.content = text;
      dupTab.savedContent = text;
      dupTab.dirty = false;
      const curPath = currentPath!;
      doCloseTab(curPath);
      const newDup = tabs.findIndex((t) => t.path === np);
      if (newDup >= 0 && newDup !== activeIdx) await activateTab(newDup);
      settings.lastFile = np;
      saveSession();
      status = "已保存 " + basename(np);
      logOp("另存为文件: " + np);
      updateTitle();
      return;
    }
    const tab = tabs[activeIdx];
    if (tab) {
      tab.path = np;
      tab.content = text;
      tab.savedContent = text;
      tab.dirty = false;
    }
    settings.lastFile = np;
    saveSession();
    status = "已保存 " + basename(np);
    updateTitle();
  }

  // ---------- 导出：Markdown / PDF / HTML ----------
  async function exportMarkdown() {
    if (!currentPath) {
      status = "请先保存文件再导出";
      return;
    }
    const p = await pickSaveFile();
    if (!p) return;
    await writeFile(p, pullDoc());
    status = "已导出 " + basename(p);
  }

  async function exportPdfDoc() {
    if (!currentPath) {
      status = "请先保存文件再导出";
      return;
    }
    const p = await pickSavePdfFile();
    if (!p) return;
    const finalPath = /\.pdf$/i.test(p) ? p : p + ".pdf";
    await exportPdf(finalPath, pullDoc());
    status = "已导出 " + basename(finalPath);
    logOp("导出PDF: " + finalPath);
  }

  async function exportHtmlDoc() {
    if (!currentPath) {
      status = "请先保存文件再导出";
      return;
    }
    const p = await pickSaveFile();
    if (!p) return;
    const title = basename(currentPath);
    const m = md ?? (await initMd()); // 导出前确保解析器就绪（首导触发动态加载）
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
${safeRender(m, pullDoc())}
</body>
</html>`;
    await exportHtml(p, full);
    status = "已导出 " + basename(p);
    logOp("导出HTML: " + p);
  }

  async function exportBundledMd() {
    if (!currentPath) {
      status = "请先保存文件再导出";
      return;
    }
    const baseDir = currentPath.replace(/[\\/][^\\/]+$/, "") || currentPath;
    const savePath = await pickSaveBundledFile(currentPath);
    if (!savePath) return; // 用户取消
    const res = await exportBundledMarkdown(savePath, pullDoc(), baseDir);
    let msg = `已导出自包含 Markdown（内嵌 ${res.embedded} 张图片）`;
    if (res.failed > 0) msg += `，${res.failed} 张读取失败已保留原路径`;
    if (res.skipped > 0) msg += `，${res.skipped} 张为外链/已内嵌跳过`;
    status = msg;
    logOp("导出自包含MD: " + savePath);
  }

  // ---------- 自动保存 ----------
  // 由 onEditorDocChange 在每次击键时重新排防抖；到期时才拉全文并写盘（避免每击键比较全文）。
  // 拉全文（toString，50MB ~45ms）+ 写盘 IPC 移入空闲帧，确保「停手那一下」不被长任务冻结。
  function queueAutoSave() {
    if (!settings.autoSave || !currentPath || suppressSave) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!currentPath || suppressSave) return;
      const runSave = async () => {
        // 窗口拖拽/缩放进行中：延后到空闲再保存，避免与合成器抢帧（P1-1）
        if (windowBusy) {
          requestIdleCallback(runSave, { timeout: 2000 });
          return;
        }
        if (!currentPath || suppressSave) return;
        const curTab = tabs[activeIdx];
        // P0 数据安全：载入失败/从未建立保存基准（lastSaved=null）时禁止自动写盘，
        // 防止欢迎页或半载内容覆盖原文件
        if (curTab?.loadFailed || lastSaved === null) return;
        const text = pullDoc();
        if (text === lastSaved) return;
        try {
          await writeFile(currentPath, text);
          source = text;
          lastSaved = text;
          docDirty = false;
          status = "已自动保存";
          updateTitle();
        } catch (e) {
          status = "自动保存失败：" + String(e);
        }
      };
      if (typeof requestIdleCallback === "function") requestIdleCallback(runSave, { timeout: 2000 });
      else runSave();
    }, settings.autoSaveDelay);
  }

  // ---------- 工具栏命令 ----------
  /** 预览编辑模式下把格式命令转发到预览 DOM（选区校验后 execCommand），返回是否已处理；
   * 选区不在预览编辑内时返回 false，由调用方回退到编辑器（CodeMirror）路径
   *
   * 列表 / 标题类命令后置规整：execCommand 把当前块转成 <li> / <h1~6> 后，
   * Chrome 默认不一定把光标落在新建块的「末尾」——若光标落在块中间，
   * 紧接的 Enter 会绕过「li 末尾 Enter / heading Enter」分支（q10 二次修复），
   * 出现「列表 / 标题工具栏点击后按 Enter 不续行」。这里显式把光标放到
   * 新建块的末尾：① 紧接输入文字直接进入新块；② 紧接按 Enter 必命中续行分支 */
  function previewExec(cmd: string, arg?: string): boolean {
    if (!previewEditMode || !previewEditEl) return false;
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !previewEditEl.contains(sel.anchorNode)) return false;
    previewEditEl.focus();
    // 必须在任何 DOM 修改之前记录状态(因为 execCommand 走完后光标位置会变化,
    // 之后再查"是否在列表/标题内"已经不准确——这是历史上"工具栏点击不续行"的真正根因)
    const wasInList = !!closestAInPreview("LI");
    const origBlock = closestBlockInPreview(); // 标题/blockquote 兜底:execCommand 偶发失败时手动包装原块

    // 标题 (H1~H6):彻底绕开 document.execCommand 的不稳定行为,直接 DOM 操作:
    // 当前块替换为对应 heading,光标落在 heading 末尾,然后在 heading 后插入新段落作为续行。
    // 这样既不依赖 Chrome/WebView2 的已弃用 execCommand,也能 100% 保证续行生效——
    // 用户反复反馈"无法解决"的根因是这条路径。q15 已记。
    if (cmd === "formatBlock" && /^<h[1-6]>$/i.test(arg || "")) {
      const tag = (arg || "").slice(1, -1).toLowerCase();
      const upper = tag.toUpperCase();
      if (origBlock && origBlock.parentNode && origBlock.tagName !== upper) {
        const h = document.createElement(upper);
        while (origBlock.firstChild) h.appendChild(origBlock.firstChild);
        if (!h.childNodes.length) h.appendChild(document.createTextNode(""));
        if (origBlock.tagName === "LI") {
          // 列表项内设置标题:标题插到列表之后并移除该 LI,
          // 避免 <h1> 嵌套进 <ul> 产生无效 HTML
          const parentList = origBlock.parentElement;
          origBlock.remove();
          if (parentList) parentList.insertAdjacentElement("afterend", h);
          else previewEditEl.appendChild(h);
          // 清理可能变空的 UL/OL
          if (parentList && !parentList.childNodes.length) parentList.remove();
        } else {
          origBlock.replaceWith(h);
        }
        const s2 = window.getSelection();
        if (s2) {
          const r = document.createRange();
          r.selectNodeContents(h);
          r.collapse(false);
          s2.removeAllRanges();
          s2.addRange(r);
        }
        appendContinuationInPreview(h);
      } else if (origBlock && origBlock.tagName === upper) {
        // 已是该级别：还原为 <p>(toggle)
        const p = document.createElement("p");
        while (origBlock.firstChild) p.appendChild(origBlock.firstChild);
        if (!p.childNodes.length) p.appendChild(document.createTextNode(""));
        origBlock.replaceWith(p);
        const s2 = window.getSelection();
        if (s2) {
          const r = document.createRange();
          r.selectNodeContents(p);
          r.collapse(false);
          s2.removeAllRanges();
          s2.addRange(r);
        }
      }
      onPreviewEditInput();
      // 同步 scrollCaretIntoView 可能在 DOM layout 之前执行;用 rAF 推迟一帧
      requestAnimationFrame(() => scrollCaretIntoView(previewEditEl!));
      return true;
    }

    // 引用:同上,绕开 execCommand
    if (cmd === "formatBlock" && /^<blockquote>$/i.test(arg || "")) {
      if (origBlock && origBlock.parentNode && origBlock.tagName !== "BLOCKQUOTE") {
        const bq = document.createElement("blockquote");
        while (origBlock.firstChild) bq.appendChild(origBlock.firstChild);
        if (!bq.childNodes.length) bq.appendChild(document.createTextNode(""));
        origBlock.replaceWith(bq);
        const s2 = window.getSelection();
        if (s2) {
          const r = document.createRange();
          r.selectNodeContents(bq);
          r.collapse(false);
          s2.removeAllRanges();
          s2.addRange(r);
        }
        appendContinuationInPreview(bq);
      } else if (origBlock && origBlock.tagName === "BLOCKQUOTE") {
        // 还原引用:把引用内的子块提升为段落(不用 execCommand:对 blockquote>pre 等嵌套无效)
        const bq = origBlock;
        const frag = document.createDocumentFragment();
        for (const child of Array.from(bq.children)) {
          const cp = document.createElement("p");
          while (child.firstChild) cp.appendChild(child.firstChild);
          frag.appendChild(cp);
        }
        if (!bq.textContent?.trim()) frag.appendChild(document.createElement("p"));
        bq.replaceWith(frag);
      }
      onPreviewEditInput();
      // 同步 scrollCaretIntoView 可能在 DOM layout 之前执行;用 rAF 推迟一帧
      requestAnimationFrame(() => scrollCaretIntoView(previewEditEl!));
      return true;
    }

    // 列表:彻底绕开 execCommand。Chrome 的 insertOrderedList/insertUnorderedList
    // 在 contenteditable 中行为不稳定(切换 ul↔ol 时可能不创建新 li,或在 li 内
    // 嵌套时选区错乱)——这是预览编辑模式"工具栏点击列表不续行"的真正根因。
    // 直接 DOM 操作:从非列表块新建 li,或对已有 li 切换类型。完全可控。
    if (cmd === "insertUnorderedList" || cmd === "insertOrderedList") {
      const listTag = cmd === "insertUnorderedList" ? "UL" : "OL";
      const inLi = !!closestAInPreview("LI");
      if (!inLi) {
        // 非列表块 → 包成 ul/ol > li,光标落在 li 末尾,然后插一个新 li 续行
        const block = closestBlockInPreview();
        const root = previewEditEl;
        if (!root) return false;
        const list = document.createElement(listTag);
        const li = document.createElement("li");
        if (block && block.parentNode) {
          while (block.firstChild) li.appendChild(block.firstChild);
          block.replaceWith(list);
          list.appendChild(li);
        } else {
          li.appendChild(document.createTextNode(""));
          list.appendChild(li);
          root.appendChild(list);
        }
        placeCaretAtEnd(li);
        appendContinuationInPreview(li);
        onPreviewEditInput();
        // 同步 scrollCaretIntoView 可能在 DOM layout 之前执行;用 rAF 推迟一帧
        requestAnimationFrame(() => scrollCaretIntoView(previewEditEl!));
        return true;
      } else {
        // 已在 li 中:切换 ul↔ol 用 execCommand(行为稳定,因为只在已有 li 上做类型切换)
        const ok = document.execCommand(cmd);
        if (ok) {
          onPreviewEditInput();
          // 同步 scrollCaretIntoView 可能在 DOM layout 之前执行;用 rAF 推迟一帧
          requestAnimationFrame(() => scrollCaretIntoView(previewEditEl!));
        }
        return ok;
      }
    }

    // 其他 (bold/italic/underline/strike/codeBlock/table 等) 走 execCommand
    const ok = document.execCommand(cmd, false, arg);
    if (ok) {
      onPreviewEditInput();
      // 同步立即滚动(不等 800ms 防抖)
      // 同步 scrollCaretIntoView 可能在 DOM layout 之前执行;用 rAF 推迟一帧
      requestAnimationFrame(() => scrollCaretIntoView(previewEditEl!));
    }
    return ok;
  }
  /** 在 previewEditEl 内从当前选区向上找第一个匹配 tag 的元素 */
  function closestAInPreview(tag: string): HTMLElement | null {
    const root = previewEditEl;
    if (!root) return null;
    const node = window.getSelection()?.anchorNode ?? null;
    let n: Node | null = node;
    while (n && n !== root) {
      if (n.nodeType === 1 && (n as Element).tagName === tag.toUpperCase()) return n as HTMLElement;
      n = n.parentNode;
    }
    return null;
  }
  /** 在 previewEditEl 内从当前选区向上找第一个块级元素（p/h1~6/blockquote/pre/li 等） */
  function closestBlockInPreview(): HTMLElement | null {
    const root = previewEditEl;
    if (!root) return null;
    const BLOCKS = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "PRE", "LI", "DIV"]);
    const node = window.getSelection()?.anchorNode ?? null;
    let n: Node | null = node;
    while (n && n !== root) {
      if (n.nodeType === 1 && BLOCKS.has((n as Element).tagName)) return n as HTMLElement;
      n = n.parentNode;
    }
    return null;
  }
  /** 在当前块后插入「新的一行」（标题→新段落；列表项→新空 li）并跳光标过去 */
  function appendContinuationInPreview(block: Element): void {
    const root = previewEditEl;
    if (!root) return;
    let next: HTMLElement;
    if (block.tagName === "LI") {
      next = document.createElement("li");
      next.appendChild(document.createElement("br"));
    } else {
      next = document.createElement("p");
      // 加 <br> 占位:turndown 输出空 <p> 会丢失源代码中的空行,
      // 用 <br> 让 turndown 输出空字符串 + 但渲染时空段仍可见
      next.appendChild(document.createElement("br"));
    }
    // 确认 newNode 真在 root 内
    if (!root.contains(block)) {
      root.appendChild(next);
    } else {
      block.insertAdjacentElement("afterend", next);
    }
    // 立即设 selection 到新行开头
    const sel = window.getSelection();
    if (sel) {
      const r = document.createRange();
      r.setStart(next, 0);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    }
    // 强制 reflow + 滚动跟随:contenteditable 的滚动容器默认不跟随光标
    next.offsetHeight;
    requestAnimationFrame(() => {
      scrollCaretIntoView(root);
    });
  }
  /** 把光标放到 el 内最后一个可见内容之后（不创建 BR，避免破坏 tight li 结构） */
  function placeCaretAtEnd(el: HTMLElement): void {
    const sel = window.getSelection();
    if (!sel) return;
    const r = document.createRange();
    // selectNodeContents + collapse(false) 落在最后一个子节点之后；
    // 空块（如 <li><br></li>）会落在 <br> 之前，等价「块末尾」，Enter 必命中续行分支
    r.selectNodeContents(el);
    r.collapse(false);
    sel.removeAllRanges();
    sel.addRange(r);
  }
  const bold = () => (previewExec("bold") || (view && wrapSelection(view, "**")));
  const italic = () => (previewExec("italic") || (view && wrapSelection(view, "*")));
  const underline = () => (previewExec("underline") || (view && wrapSelection(view, "__")));
  const strike = () => (previewExec("strikeThrough") || (view && wrapSelection(view, "~~")));
  const h1 = () => (previewExec("formatBlock", "<h1>") || (view && toggleLinePrefix(view, "# ")));
  const ul = () => (previewExec("insertUnorderedList") || (view && toggleLinePrefix(view, "- ")));
  const ol = () => (previewExec("insertOrderedList") || (view && toggleLinePrefix(view, "1. ")));
  // 任务列表：预览编辑无原生 execCommand，退化为新列表项（内容不受影响）
  const task = () => (previewExec("insertUnorderedList") || (view && toggleLinePrefix(view, "- [ ] ")));
  const quote = () => (previewExec("formatBlock", "<blockquote>") || (view && toggleLinePrefix(view, "> ")));
  const link = () => {
    if (previewEditMode && previewEditEl) {
      const sel = window.getSelection();
      if (sel && sel.rangeCount && previewEditEl.contains(sel.anchorNode)) {
        previewEditEl.focus();
        const url = window.prompt("链接地址（URL）：", "https://");
        if (!url) return;
        document.execCommand("createLink", false, url);
        onPreviewEditInput();
        return;
      }
    }
    view && insertLink(view);
  };

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
    if (!colorMenu) return;
    const isFg = colorMenu.type === "fg";
    if (previewEditMode && previewEditEl) {
      const sel = window.getSelection();
      if (sel && sel.rangeCount && previewEditEl.contains(sel.anchorNode)) {
        previewEditEl.focus();
        document.execCommand(isFg ? "foreColor" : "hiliteColor", false, hex);
        onPreviewEditInput();
        status = isFg ? "已设置字体颜色" : "已设置背景颜色";
        colorMenu = null;
        return;
      }
    }
    if (!view) return;
    const css = isFg ? `color:${hex}` : `background-color:${hex}`;
    wrapHtmlSpan(view, css);
    status = isFg ? "已设置字体颜色" : "已设置背景颜色";
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
  // ---- M-03：文件夹批量替换与已打开标签的一致性 ----
  //
  // 根因：replace_in_folder 直接改磁盘，前端不感知。若被替换的文件正好开着，
  // 编辑器里的 content/lastSaved 仍是替换前的旧内容 —— 随后任何一次自动保存
  // 都会把「旧内容」写回磁盘，静默吞掉刚刚的批量替换结果。
  //
  // 两道防线：
  //  ① 替换前：folder 内存在未保存标签就直接拦下（脏内容无法自动合并，
  //     强行刷新等于丢用户编辑），要求先保存。
  //  ② 替换后：把 folder 内所有干净标签的内容从磁盘重新拉一次，
  //     基准（savedContent）一并更新，当前活动标签立即重载到编辑器。

  /** 路径 p 是否位于 folder 之内（大小写不敏感，避免 Windows 盘符/大小写差异漏判） */
  function isInsideFolder(p: string, folder: string): boolean {
    const f = norm(folder).toLowerCase().replace(/\/+$/, "");
    const pp = norm(p).toLowerCase();
    return pp === f || pp.startsWith(f + "/");
  }

  /** 返回 folder 内所有「有未保存修改」的标签文件名，供替换前拦截提示 */
  function dirtyFilesInFolder(folder: string): string[] {
    const out: string[] = [];
    for (let i = 0; i < tabs.length; i++) {
      const t = tabs[i];
      if (!isInsideFolder(t.path, folder)) continue;
      // 活动标签的脏状态以编辑器实时状态为准（tab.dirty 只在切换/防抖时同步）
      const dirty = i === activeIdx ? docDirty || (lastSaved !== null && source !== lastSaved) : t.dirty;
      if (dirty) out.push(basename(t.path));
    }
    return out;
  }

  /** 批量替换完成：重新拉取 folder 内已打开文件的磁盘内容，消除状态失配 */
  async function onFolderReplaced(e: CustomEvent<{ folder: string }>) {
    const folder = e.detail?.folder;
    if (!folder) return;
    let refreshed = 0;
    let activeNeedsReload = false;
    for (let i = 0; i < tabs.length; i++) {
      const t = tabs[i];
      if (!isInsideFolder(t.path, folder)) continue;
      if (t.deferred) continue; // 尚未载入的延迟标签，下次打开时自然读到新内容
      try {
        const fresh = await readFile(t.path);
        const before = i === activeIdx ? source : t.content;
        if (fresh === before) continue;
        t.content = fresh;
        t.savedContent = fresh;
        t.dirty = false;
        t.loadFailed = false;
        refreshed++;
        if (i === activeIdx) activeNeedsReload = true;
      } catch {
        // 单个文件读失败不影响其余标签（可能被外部移动/占用）
      }
    }
    if (!refreshed) return;
    tabs = tabs;
    if (activeNeedsReload && tabs[activeIdx]) {
      // 重载活动标签：applyTabState 内部已用 suppressSave 包裹，不会触发回写
      await applyTabState(tabs[activeIdx]);
      docDirty = false;
    }
    updateTitle();
    saveSession();
    status = `批量替换完成，已同步 ${refreshed} 个已打开文件`;
  }

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
    await openTabByPath(path);
    if (view) gotoLine(view, line);
  }

  async function insertImg() {
    if (previewEditMode && previewEditEl) {
      // 预览编辑模式：复用收编管线在光标处插入 <img>（不退出模式，与快捷键/粘贴/拖拽一致）
      await insertImageAtCaret(previewEditEl, async () => {
        const p = await pickImageFile();
        if (!p) return null;
        const r = await resolveImageRef(p);
        status = "图片已插入";
        return { url: convertFileSrc(r.abs), ref: r.ref };
      }, onPreviewEditInput);
      return;
    }
    if (!view) return;
    const p = await pickImageFile();
    if (!p) return;
    await insertImageByPath(p);
  }

  // 统一插图：当前笔记有目录则收编（可选压缩）用相对引用；否则用绝对路径。
  // 返回 { ref: markdown 引用, abs: 磁盘绝对路径 }；预览编辑插图与编辑器插图共用
  /**
   * m-08：解析笔记目录基准。
   * currentPath 在 applyTabState 切换的瞬时空窗期可能为 null，此时旧实现直接回退
   * 绝对路径，导致图片以 `C:\...` 形式写进 markdown（换机器/移动笔记即失效）。
   * 这里补一层兜底：优先当前标签，其次活动标签记录的路径，最后才放弃收编。
   */
  function noteBaseDir(): string | null {
    if (currentPath) return dirname(currentPath);
    const t = tabs[activeIdx];
    if (t?.path) return dirname(t.path);
    return null;
  }
  /** 当前正在编辑的 .md 路径（优先 currentPath，其次活动标签） */
  function currentMdPath(): string | null {
    if (currentPath) return currentPath;
    const t = tabs[activeIdx];
    return t?.path ?? null;
  }
  /** 当前 .md 对应的附件目录【名】（如 测试_attachment），用于插图/尺寸索引 */
  function currentAttachmentName(): string {
    const mp = currentMdPath();
    return mp ? attachmentDirName(mp, settings) : settings.assetsDir;
  }
  async function resolveImageRef(p: string): Promise<{ ref: string; abs: string }> {
    const base = noteBaseDir();
    if (base) {
      try {
        const ref = await importAsset(p, base, currentAttachmentName(), settings.compressImages, settings.jpegQuality);
        return { ref, abs: base + "/" + ref };
      } catch {
        // 收编失败回退绝对路径
      }
    }
    return { ref: p, abs: p };
  }
  async function insertImageByPath(p: string) {
    if (!view) return;
    const r = await resolveImageRef(p);
    insertImage(view, r.ref);
    if (r.ref === p && !noteBaseDir()) {
      // 明确告知：未保存的笔记无法收编附件，引用为绝对路径，移动笔记后会失效
      status = "已插入图片（绝对路径）：请先保存笔记再插入以自动收编为相对路径";
    } else {
      status = r.ref === p ? "已插入图片 " + basename(p) : "图片已收编 " + basename(r.ref);
    }
  }

  // 字节数组转 base64（分块处理，避免大图调用栈溢出）
  // m-03：原实现用 fromCharCode(...subarray) 展开参数，虽已按 0x8000 分块，
  // 但「单次调用实参个数」受引擎栈帧限制，各版本 WebView2 阈值不一致。
  // 改为逐字节拼接后按块 flush：无参数展开、无栈风险，吞吐差异可忽略。
  function uint8ToBase64(bytes: Uint8Array): string {
    const parts: string[] = [];
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      const end = Math.min(i + chunk, bytes.length);
      let bin = "";
      for (let j = i; j < end; j++) bin += String.fromCharCode(bytes[j]);
      parts.push(bin);
    }
    return btoa(parts.join(""));
  }

  // 粘贴图片：读取剪贴板图片，收编并插入相对引用（仅已保存笔记可用）
  // 传输优先走 raw IPC（Uint8Array 直传，零 base64）；运行时不支持 raw body 时
  // 回退 importAssetBytes（base64），行为等价。
  async function sendAssetBytes(
    ext: string,
    bytes: Uint8Array,
    compress: boolean,
    quality: number
  ): Promise<string> {
    const attName = currentAttachmentName();
    try {
      return await importAssetRaw(dirname(currentPath!), attName, ext, bytes, compress, quality);
    } catch {
      const b64 = uint8ToBase64(bytes);
      return importAssetBytes(dirname(currentPath!), attName, ext, b64, compress, quality);
    }
  }
  // 粘贴/拖拽图片收编：返回 { ref, abs }；未保存笔记返回 null（需要目录基准）
  async function assetFromImageFile(file: File): Promise<{ ref: string; abs: string } | null> {
    // m-08：开头就把基准目录快照下来。函数体内有多个 await（Worker 转码 / IPC 传输），
    // 期间用户可能切换标签使 currentPath 变化，若继续读 currentPath 会把图片
    // 收编到「另一篇笔记」的附件目录，产生跨笔记的坏引用。
    const base = noteBaseDir();
    if (!base) {
      status = "请先保存笔记，再插入图片";
      return null;
    }
    const t0 = performance.now();
    const ext = (file.type.split("/")[1] || "png").replace("jpeg", "jpg");
    // 小 PNG（多为截图）走 WebP 无损，避免文字发糊；其余转有损 WebP 大幅瘦身
    const lossless = file.type === "image/png" && file.size < 2 << 20;
    const maxEdge = degrade.imageMaxEdge;
    const quality = degrade.webpQuality;
    try {
      let rel: string;
      if (imageWorkerSupported()) {
        // 主线程零解码/转码：Worker 内完成降采样 + WebP 编码，仅回传数百 KB 字节（transferable）
        const res = await processImageInWorker(file, {
          maxEdge,
          quality: lossless ? 1 : quality,
          lossless,
          format: lossless ? "png" : "webp",
        });
        // 已在 Worker 内转 WebP/PNG，Rust 侧不再二次压缩（compress=false）；
        // raw IPC 直传数百 KB 字节，免 base64 编码（失败自动回退 base64）
        rel = await sendAssetBytes(res.format, res.bytes, false, settings.jpegQuality);
        // 记录并 best-effort 落盘图片尺寸，供预览渲染规则注入 width/height 预留空间（P1-5）
        setDims(base, rel, res.width, res.height);
        void saveDims(base, currentAttachmentName());
      } else {
        // 回退：旧 WebView / 无 Worker 环境；raw IPC 直传原图字节，
        // 免主线程 uint8ToBase64（10MB 图约 200~280ms 同步阻塞）
        const buf = await file.arrayBuffer();
        rel = await sendAssetBytes(ext, new Uint8Array(buf), settings.compressImages, settings.jpegQuality);
      }
      if (typeof console !== "undefined") {
        console.debug("[img] 主线程阻塞", (performance.now() - t0).toFixed(1), "ms");
      }
      return { ref: rel, abs: base + "/" + rel };
    } catch (e) {
      status = "图片收编失败：" + String(e);
      return null;
    }
  }
  async function insertPastedImage(file: File) {
    if (!view) return;
    const r = await assetFromImageFile(file);
    if (!r) return;
    insertImage(view, r.ref);
    status = "图片已收编 " + basename(r.ref);
  }

  // 窗口级粘贴监听：仅拦截含图片的剪贴板，文本粘贴照常交给 CodeMirror
  function onPaste(e: ClipboardEvent) {
    if (showSettings || !view) return;
    if (previewEditMode) return; // 预览编辑模式由 contenteditable 的 paste 监听处理（图片切回收编管线）
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
  async function migrateNoteContent(text: string, mdPath: string): Promise<{ text: string; count: number; failed: number }> {
    const dir = dirname(mdPath);
    const attName = attachmentDirName(mdPath, settings);
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
        const rel = await importAsset(job.src, dir, attName, settings.compressImages, settings.jpegQuality);
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
    const res = await migrateNoteContent(source, currentPath);
    if (res.count === 0 && res.failed === 0) {
      status = "没有需要迁移的绝对路径图片";
      return;
    }
    if (res.count > 0) {
      suppressSave = true;
      setDoc(view, res.text);
      suppressSave = false;
      source = res.text;
      docDirty = false;
      // lastSaved 保持旧内容 → dirty 为 true，提示用户确认后保存
      updateTitle();
    }
    status = `迁移完成：成功 ${res.count} 张${res.failed ? `，失败 ${res.failed} 张` : ""}`;
  }

    // ---- 清理未引用附件：递归扫描文件夹，删除每一处附件文件夹中未被任何 .md 引用的文件 ----
    let confirmCleanup = false;
    let cleanupPreview: string[] = [];
    async function doCleanupAssets() {
      const dir = settings.lastFolder ?? (currentPath ? dirname(currentPath) : null);
      if (!dir) { status = "请先打开一篇笔记或一个文件夹"; return; }
      try {
        cleanupPreview = await listOrphanAssets(dir, settings.assetsDir);
        if (!cleanupPreview.length) { status = "没有发现未引用的附件"; return; }
        confirmCleanup = true;
      } catch (e) { status = "扫描未引用附件失败：" + String(e); }
    }
    function onCleanupCancel() {
      confirmCleanup = false;
      cleanupPreview = [];
    }
    async function onCleanupConfirm() {
      confirmCleanup = false;
      const dir = settings.lastFolder ?? (currentPath ? dirname(currentPath) : null)!;
      try {
        const deleted = await cleanupOrphansWith(dir, settings.assetsDir, cleanupPreview);
        cleanupPreview = [];
        status = deleted.length ? `已清理 ${deleted.length} 个未引用附件` : "没有发现未引用的附件";
      } catch (e) { status = "清理失败：" + String(e); }
    }

    // ---- 批量迁移：递归处理整个文件夹下所有 .md（附件分别收编到各自笔记目录）----
    let confirmMigrate = false;
    async function doMigrateFolder() {
      const root = settings.lastFolder ?? (currentPath ? dirname(currentPath) : null);
      if (!root) { status = "请先打开一个文件夹再批量迁移"; return; }
      confirmMigrate = true;
    }
    async function onMigrateConfirm() {
      confirmMigrate = false;
      const root = settings.lastFolder ?? (currentPath ? dirname(currentPath) : null)!;
      try {
        const files = await listMdFiles(root);
        let filesChanged = 0, totalMigrated = 0, totalFailed = 0;
        const norm = (s: string) => s.replace(/\\/g, "/").toLowerCase();
        for (const f of files) {
          try {
            const content = await readFile(f);
            const res = await migrateNoteContent(content, f);
            totalFailed += res.failed;
            if (res.count > 0) {
              await writeFile(f, res.text);
              filesChanged++;
              totalMigrated += res.count;
              if (view && currentPath && norm(f) === norm(currentPath)) {
                suppressSave = true;
                setDoc(view, res.text);
                source = res.text;
                lastSaved = res.text;
                docDirty = false;
                suppressSave = false;
                updateTitle();
              }
            }
          } catch { totalFailed++; }
        }
        status = `批量迁移完成：${filesChanged} 个文件，成功 ${totalMigrated} 张${totalFailed ? `，失败 ${totalFailed} 张` : ""}`;
      } catch (e) { status = "批量迁移失败：" + String(e); }
    }

    // ---- 关闭流程（已迁移到脚本顶层）----

  function codeBlock() {
    if (previewEditMode && previewEditEl) {
      const sel = window.getSelection();
      if (sel && sel.rangeCount && previewEditEl.contains(sel.anchorNode)) {
        previewEditEl.focus();
        if (document.execCommand("formatBlock", false, "<pre>")) onPreviewEditInput();
        status = "已插入代码块";
        return;
      }
    }
    if (!view) return;
    insertCodeBlock(view, "");
    status = "已插入代码块";
  }

  function table() {
    // 预览编辑模式：直接在渲染区光标处插入表格，光标落在表格第一个单元格内（不退出模式）
    if (previewEditMode && previewEditEl) {
      insertTableAtCaret(previewEditEl, onPreviewEditInput);
      status = "已插入表格";
      return;
    }
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
    // 预览编辑模式下：全局快捷键基本交还给预览编辑自身的 keydown 处理，
    // 这里只放行 Ctrl+S（保存，内部会先回写预览编辑内容），其余一律不拦截，
    // 避免全局视图命令（Ctrl+\ 切换预览、Ctrl+= 字号等）与预览编辑模式冲突/误触发，
    // 否则会出现「切换不灵 / 全选后像跳出预览编辑」的错觉。
    if (previewEditMode) {
      const isSave = matchAccel(e, settings.shortcuts["file.save"] ?? DEFAULT_SHORTCUTS["file.save"]);
      if (isSave) { e.preventDefault(); save(); }
      return;
    }
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

    // 查找 / 替换：window 层统一兜底打开中文查找替换面板。
    // CodeMirror 的 Mod-f/Mod-h 绑定与这里等效（openSearchPanel 幂等，双触发无副作用）；
    // 某些输入环境下 CM keymap 可能不匹配（如自动化按键 key 为大写），故不在此让位。
    const isFind = hit("edit.find");
    const isReplace = hit("edit.replace");
    if (isFind || isReplace) {
      run(e, () => {
        if (!view) return;
        view.focus();
        openSearchPanelCmd(isReplace)(view);
      });
      return;
    }

    if (hit("file.new")) run(e, () => treeRef?.requestNewFile());
    else if (hit("file.open")) run(e, openFile);
    else if (hit("file.openFolder")) run(e, openFolder);
    else if (hit("file.save")) run(e, save);
    else if (hit("file.saveAs")) run(e, saveAs);
    else if (hit("file.export")) run(e, exportHtmlDoc);
    else if (hit("insert.image")) run(e, insertImg);
    else if (hit("insert.codeBlock")) run(e, codeBlock);
    else if (hit("insert.table")) run(e, table);
    else if (hit("table.addColumn")) run(e, addColumn);
    else if (hit("insert.bullet")) run(e, unorderedList);
    else if (hit("format.quote")) run(e, quote);
    else if (hit("view.togglePreview")) run(e, () => togglePreviewPane());
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

  // ---- 关闭流程（未保存确认）----
  async function saveAllBeforeExit(): Promise<void> {
    logInfo("正在保存所有文件...");
    // 关键修复：关闭前同步保存会话 + 设置，避免「正常启动打开过 A.md 关闭后下次启动
    // 会话丢失」的回归。persist() 有 300ms debounce，Alt+F4 会在 debounce 没到时间
    // 就关窗口，导致 settings.openTabs / lastFile 没写盘。
    const cur = tabs[activeIdx];
    if (cur && !cur.deferred && !cur.loadFailed) syncTabState(cur);
    saveSession();
    try {
      await saveSettings(settings);
    } catch {
      // Tauri save 失败：至少把设置写 localStorage 兜底（下次 Tauri 读失败时回退）
      try { localStorage.setItem("litemd.settings", JSON.stringify(settings)); } catch { /* ignore */ }
    }
  }
  function doClose() {
    logInfo("LiteMD 关闭");
    // saveAllBeforeExit 是异步 IPC（settings.json 写盘），需要先启动写操作
    // 再销毁窗口。destroy() 在 Windows 上很快，所以 Promise 不 await。
    // 如果 destroy() 已经执行完但 save 还没落地，就靠 localStorage 兜底。
    void saveAllBeforeExit();
    setTimeout(() => {
      if (tauriWindow) (tauriWindow as any).destroy().catch(() => window.close());
      else window.close();
    }, 80);
  }

  // 窗口关闭：任一标签未保存 → 三按钮对话框（保存全部并退出 / 直接退出 / 取消）
  let closeAllDialog = false;
  let closeAllDirtyNames = "";
  function requestClose() {
    if (tabs.length === 0) {
      doClose();
      return;
    }
    const cur = tabs[activeIdx];
    if (cur) syncTabState(cur);
    const dirtyTabs = tabs.filter((t) => isDirtyTab(t) && !t.loadFailed);
    if (dirtyTabs.length === 0) {
      doClose();
      return;
    }
    closeAllDirtyNames = dirtyTabs.slice(0, 5).map((t) => basename(t.path)).join("、")
      + (dirtyTabs.length > 5 ? ` 等 ${dirtyTabs.length} 个` : "");
    closeAllDialog = true;
  }
  async function onCloseAllSave() {
    closeAllDialog = false;
    // P0 数据安全：applyTabState 期间不能批量保存（编辑器里仍是旧标签/欢迎页内容）
    if (suppressSave) {
      status = "正在切换文档，已禁止批量保存（原文件未被修改）";
      return;
    }
    try {
      for (const tab of tabs) {
        if (isDirtyTab(tab) && !tab.loadFailed) {
          // P0 数据安全：缺保存基准的标签跳过，避免陈旧内容覆盖磁盘
          if (!tab.savedContent) {
            status = `已跳过 ${basename(tab.path)}（未建立保存基准）`;
            continue;
          }
          await writeFile(tab.path, tab.content);
          tab.savedContent = tab.content;
          tab.dirty = false;
        }
      }
    } catch (e) {
      status = "保存失败，已取消退出：" + String(e);
      return;
    }
    doClose();
  }
  function onCloseAllNoSave() {
    closeAllDialog = false;
    doClose();
  }
  function onCloseAllCancel() {
    closeAllDialog = false;
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
  // 边缘拖动缩放窗口（decorations: false 无系统缩放边框，需手动触发）
  function winResize(direction: string) {
    tauriWindow && (tauriWindow as any).startResizeDragging(direction);
  }

  // 挂起自动保存（用于 migrateFolder 内部写入后避免触发）

  // 模态按需加载：对应状态激活时才拉 chunk
  $: if (showSettings) loadModal("SettingsModal");
  $: if (showFolderSearch) loadModal("FolderSearch");
  $: if (promptState) loadModal("PromptModal");
  $: if (confirmState || closeTabDialog || closeAllDialog || confirmMigrate || confirmCleanup) loadModal("ConfirmModal");

  // ====== 脚本块结束，以下为模板 ======
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
          <div class="menu-header">导出</div>
          <div on:click={() => { menuOpen = false; exportMarkdown(); }}>
            导出 Markdown <span>.md</span>
          </div>
          <div on:click={() => { menuOpen = false; exportPdfDoc(); }}>
            导出 PDF <span>.pdf</span>
          </div>
          <div on:click={() => { menuOpen = false; exportHtmlDoc(); }}>
            导出 HTML <span>{accel("file.export")}</span>
          </div>
          <div on:click={() => { menuOpen = false; exportBundledMd(); }}>
            导出自包含 MD（图片内嵌）<span>单文件</span>
          </div>
          <div class="sep-line" />
          <div on:click={() => { menuOpen = false; openFolderSearch(); }}>
            文件夹内查找替换 <span>Ctrl + Shift + F</span>
          </div>
          <div class="sep-line" />
          <div on:click={() => { menuOpen = false; migrateImages(); }}>
            迁移图片附件 <span>绝对路径→相对</span>
          </div>
          <div on:click={() => { menuOpen = false; doMigrateFolder(); }}>
            批量迁移文件夹图片 <span>递归</span>
          </div>
          <div on:click={() => { menuOpen = false; doCleanupAssets(); }}>
            清理未引用附件 <span>{settings.attachmentMode === "shared" ? settings.assetsDir + "/" : "按文档目录"}</span>
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
      <FileTree
        bind:this={treeRef}
        store={treeStore}
        {sidebarWidth}
        {currentPath}
        defaultDir={settings.lastFolder}
        hiddenPaths={settings.hiddenPaths}
        hideAttachments={settings.hideAttachments}
        assetsDir={settings.assetsDir}
        attachmentMode={settings.attachmentMode}
        attachmentTemplate={settings.attachmentTemplate}
        handlers={{
          openFile: openFileByPathSafe,
          setStatus: (m) => (status = m),
          confirm: askConfirm,
          prompt: askPrompt,
          pickFolder: () => pickOpenFolder(),
          onTabRenamed: updateTabPath,
          onTabRemoved: (p) => requestCloseTab(p),
          setHiddenPaths: (paths) => {
            settings.hiddenPaths = paths;
            persist();
          },
          setTreePrefs: onTreePrefsChange,
          onRootsChanged: onTreeRootsChanged,
          checkPathExists: (p) => pathExists(p),
        }}
        on:collapse={() => (showTree = false)}
      />
      <!-- svelte-ignore a11y-no-static-element-interactions -->
      <div class="splitter" on:mousedown={(e) => startDrag("sidebar", e)} title="拖动调整宽度" />
    {/if}

    <main class="editor">
      {#if tabs.length > 0}
        <div class="tabbar" on:auxclick={onTabbarAuxClick}>
          <div class="tab-scroll">
            {#each tabs as tab, i (tab.path)}
              <div
                class="tab"
                class:active={i === activeIdx}
                data-path={tab.path}
                on:click={() => activateTab(i)}
                on:contextmenu|preventDefault={(e) => {
                  // 右键标签：显示操作菜单（关闭/关闭其他/关闭全部）
                  ctxMenu = { x: e.clientX, y: e.clientY, path: tab.path, name: basename(tab.path) };
                }}
                title={tab.path}
              >
                <span class="tab-name">{basename(tab.path)}{#if isDirtyTab(tab)}<span class="tab-dot">●</span>{/if}</span>
                <button
                  class="tab-close"
                  title="关闭标签"
                  on:click|stopPropagation={() => requestCloseTab(tab.path)}>✕</button>
              </div>
            {/each}
          </div>
          <span style="flex:1" />
          {#if !showTree}
            <button class="tab-act" on:click={() => (showTree = true)} title="展开目录">›</button>
          {/if}
          <button
            class="tab-act"
            class:on={previewEditMode}
            on:click={togglePreviewEdit}
            title="预览编辑模式：隐藏 markdown 编辑器，直接在渲染预览中编辑">✎</button>
          <button class="tab-act" class:on={showPreview} on:click={togglePreviewPane} title="开关预览" disabled={previewEditMode}>
            {#if showPreview}
              <!-- 眼睛（预览开启） -->
              <svg class="ico" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            {:else}
              <!-- 眼睛（预览关闭，带斜杠） -->
              <svg class="ico" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                <line x1="1" y1="1" x2="23" y2="23" />
              </svg>
            {/if}
          </button>
        </div>
      {/if}
      {#if previewEditMode}
        <div
          class="preview-edit"
          contenteditable="true"
          bind:this={previewEditEl}
          on:input={onPreviewEditInput}
          spellcheck="false"
        ></div>
      {/if}
      <!-- 编辑器容器始终保留在 DOM（仅隐藏），避免 CodeMirror 视图被销毁后无法重新挂载 -->
      <div
        class="editor-host"
        bind:this={editorHost}
        on:mouseup={onEditorMouseUp}
        style={previewEditMode ? "display:none" : ""}
      ></div>
      {#if loadingBigDoc}
        <div class="loading-veil" role="status" aria-live="polite">
          <div class="loading-spinner" />
          <div class="loading-text">正在载入大文档…{(streamProgress * 100).toFixed(0)}%</div>
          <div class="loading-bar"><div class="loading-bar-fill" style="width:{(streamProgress * 100).toFixed(1)}%" /></div>
        </div>
      {/if}
    </main>

    {#if showPreview}
      <!-- svelte-ignore a11y-no-static-element-interactions -->
      <div class="splitter" on:mousedown={(e) => startDrag("preview", e)} title="拖动调整宽度" />
      <section class="preview" style="width:{previewWidth}px">
        <div class="panel-head">
          <span>预览</span>
          <span style="flex:1" />
          {#if previewStale}
            <span class="pv-hint" title="文档超过实时预览阈值，打字时不再自动更新预览">已暂停实时预览</span>
            <button
              on:click={refreshPreview}
              title={docLength > manualRefreshMax ? `文档过大（>${manualRefreshMax >> 20}MB），已禁用手动刷新` : "立即刷新预览"}
              disabled={previewStale && docLength > manualRefreshMax}
            >↻</button>
          {/if}
        </div>
        <div class="preview-content">
          <VirtualPreview
            bind:this={previewRef}
            {md}
            source={previewSource}
            {hlVersion}
            edits={previewEdits}
            prerenderMargin={degrade.prerenderMargin}
            renderBudgetPerFrame={degrade.renderBudgetPerFrame}
            idlePrerenderScreens={degrade.idlePrerenderScreens}
            useWillChange={degrade.useWillChange}
            maxCacheEntries={degrade.maxCacheEntries}
            maxCacheBytes={degrade.maxCacheBytes}
            imgReclaim={degrade.imgReclaim || memReliefEnabled}
          />
        </div>
      </section>
    {/if}
  </div>

  <StatusBar
    {currentPath}
    {status}
    {cursorLine}
    {cursorCol}
    words={stats.words}
    chars={stats.chars}
    autoSave={settings.autoSave}
    fontSize={settings.fontSize}
    previewNotice={previewDisabledNotice}
  />

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

  <!-- 全局操作反馈 Toast（成功/失败/提示，自动消失） -->
  <Toast />

  <!-- 全局致命错误兜底：避免未捕获异常导致白屏 -->
  {#if fatalError}
    <div class="fatal-overlay" role="alertdialog" aria-modal="true">
      <div class="fatal-card">
        <div class="fatal-title">😵 出错了</div>
        <div class="fatal-msg">{fatalError.msg}</div>
        <pre class="fatal-stack">{fatalError.stack}</pre>
        <div class="fatal-actions">
          <button on:click={copyFatalLog}>复制错误信息</button>
          <button class="primary" on:click={() => location.reload()}>重启应用</button>
        </div>
      </div>
    </div>
  {/if}
</div>

{#if showSettings && modalCmps.SettingsModal}
  <svelte:component
    this={modalCmps.SettingsModal}
    bind:settings
    {configPath}
    on:change={onSettingsChange}
    on:close={() => (showSettings = false)}
    on:pickFolder={async () => {
      const f = await pickOpenFolder();
      if (f) await loadFolderIntoTree(f);
    }}
    on:export={() => {
      showSettings = false;
      exportHtmlDoc();
    }}
  />
{/if}

{#if showFolderSearch && settings.lastFolder && modalCmps.FolderSearch}
  <svelte:component
    this={modalCmps.FolderSearch}
    folder={settings.lastFolder}
    dirtyFilesIn={dirtyFilesInFolder}
    on:close={() => (showFolderSearch = false)}
    on:open={gotoSearchResult}
    on:replaced={onFolderReplaced}
  />
{/if}

{#if promptState && modalCmps.PromptModal}
  <svelte:component
    this={modalCmps.PromptModal}
    title={promptState.title}
    label={promptState.label}
    value={promptState.value}
    path={promptState.path}
    on:confirm={onPromptConfirm}
    on:cancel={onPromptCancel}
    on:browse={onPromptBrowse}
  />
{/if}

{#if confirmState && modalCmps.ConfirmModal}
  <svelte:component
    this={modalCmps.ConfirmModal}
    title={confirmState.title}
    message={confirmState.message}
    confirmText={confirmState.confirmText}
    danger={confirmState.danger}
    on:confirm={onConfirmYes}
    on:cancel={onConfirmNo}
  />
{/if}

{#if confirmMigrate && modalCmps.ConfirmModal}
  <svelte:component
    this={modalCmps.ConfirmModal}
    title="批量迁移确认"
    message={`将批量迁移文件夹下所有 .md 的绝对路径图片为相对引用。\n会把图片复制到各自笔记的「${settings.assetsDir}/」并改写文件。\n此操作不可撤销，确定继续？`}
    confirmText="确定迁移"
    danger={true}
    on:confirm={onMigrateConfirm}
    on:cancel={() => (confirmMigrate = false)}
  />
{/if}

{#if confirmCleanup && modalCmps.ConfirmModal}
  <svelte:component
    this={modalCmps.ConfirmModal}
    title="清理未引用附件"
    message={`将删除 ${cleanupPreview.length} 个未被任何 .md 引用的附件（前 20 项）：\n` +
      cleanupPreview.slice(0, 20).join("\n") +
      (cleanupPreview.length > 20 ? `\n…等共 ${cleanupPreview.length} 个` : "") +
      `\n此操作不可撤销，确定继续？`}
    confirmText={`确定清理 ${cleanupPreview.length} 个`}
    danger={true}
    on:confirm={onCleanupConfirm}
    on:cancel={onCleanupCancel}
  />
{/if}

{#if closeTabDialog && modalCmps.ConfirmModal}
  <svelte:component
    this={modalCmps.ConfirmModal}
    title="关闭文件"
    message={`文件「${basename(closeTabDialog.path)}」有未保存的修改。`}
    confirmText="不保存"
    thirdText="保存并关闭"
    danger={true}
    on:confirm={onCloseTabNoSave}
    on:third={onCloseTabSave}
    on:cancel={onCloseTabCancel}
  />
{/if}

{#if closeAllDialog && modalCmps.ConfirmModal}
  <svelte:component
    this={modalCmps.ConfirmModal}
    title="退出确认"
    message={`有 ${closeAllDirtyNames} 个文件未保存，退出前要保存吗？`}
    confirmText="直接退出"
    thirdText="保存并退出"
    danger={true}
    on:confirm={onCloseAllNoSave}
    on:third={onCloseAllSave}
    on:cancel={onCloseAllCancel}
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
      <button class="ctx-item" on:click={ctxCloseTab}>✕ 关闭标签</button>
      <button class="ctx-item" on:click={ctxCloseOthers}>✕ 关闭其他标签</button>
      <button class="ctx-item" on:click={ctxCloseAll}>✕ 关闭全部标签</button>
    </div>
  </div>
{/if}

<!-- 快捷键示意图（首次启动） -->
{#if showShortcutGuide}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="kg-mask" on:click={closeShortcutGuide}>
    <!-- svelte-ignore a11y-click-events-have-key-events -->
    <div class="kg-dialog" on:click|stopPropagation>
      <button class="kg-close" on:click={closeShortcutGuide} title="关闭">✕</button>
      <div class="kg-title">LiteMD 快捷键指南</div>
      <div class="kb-wrap">
        <div class="kb-section">
          <div class="kb-section-title">文件</div>
          <div class="kb-rows">
            <kbd>Ctrl</kbd>+<kbd>N</kbd> <span>新建笔记</span>
            <kbd>Ctrl</kbd>+<kbd>O</kbd> <span>打开文件</span>
            <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>O</kbd> <span>打开文件夹</span>
            <kbd>Ctrl</kbd>+<kbd>S</kbd> <span>保存</span>
            <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> <span>另存为</span>
            <kbd>Ctrl</kbd>+<kbd>E</kbd> <span>导出 PDF</span>
          </div>
        </div>
        <div class="kb-section">
          <div class="kb-section-title">编辑</div>
          <div class="kb-rows">
            <kbd>Ctrl</kbd>+<kbd>Z</kbd> <span>撤销</span>
            <kbd>Ctrl</kbd>+<kbd>Y</kbd> <span>重做</span>
            <kbd>Ctrl</kbd>+<kbd>F</kbd> <span>查找</span>
            <kbd>Ctrl</kbd>+<kbd>H</kbd> <span>替换</span>
          </div>
        </div>
        <div class="kb-section">
          <div class="kb-section-title">格式</div>
          <div class="kb-rows">
            <kbd>Alt</kbd>+<kbd>B</kbd> <span>加粗</span>
            <kbd>Ctrl</kbd>+<kbd>I</kbd> <span>斜体</span>
            <kbd>Ctrl</kbd>+<kbd>U</kbd> <span>下划线</span>
            <kbd>Ctrl</kbd>+<kbd>K</kbd> <span>插入链接</span>
            <kbd>Alt</kbd>+<kbd>1</kbd>~<kbd>5</kbd> <span>一~五级标题</span>
            <kbd>Alt</kbd>+<kbd>&gt;</kbd> <span>引用</span>
          </div>
        </div>
        <div class="kb-section">
          <div class="kb-section-title">插入</div>
          <div class="kb-rows">
            <kbd>Alt</kbd>+<kbd>Q</kbd> <span>插入图片</span>
            <kbd>Alt</kbd>+<kbd>W</kbd> <span>代码块</span>
            <kbd>Alt</kbd>+<kbd>E</kbd> <span>插入表格</span>
            <kbd>Alt</kbd>+<kbd>`</kbd> <span>无序列表</span>
          </div>
        </div>
        <div class="kb-section">
          <div class="kb-section-title">视图</div>
          <div class="kb-rows">
            <kbd>Ctrl</kbd>+<kbd>\</kbd> <span>切换预览/分屏</span>
            <kbd>F11</kbd> <span>专注模式</span>
            <kbd>Ctrl</kbd>+<kbd>=</kbd> <span>增大字号</span>
            <kbd>Ctrl</kbd>+<kbd>-</kbd> <span>减小字号</span>
          </div>
        </div>
      </div>
      <div class="kb-hint">可在 设置 → 快捷键 中自定义键位</div>
    </div>
  </div>
{/if}

