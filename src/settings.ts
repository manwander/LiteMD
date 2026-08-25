// 设置模型 + 快捷键注册表 + 本地持久化。
// 纯数据模块（无 Tauri 依赖）：持久化经由 ./settings-store.ts 桥接。
import type { SettingsBridge } from "./settings-store";

export type ThemeName = "light" | "dark" | "auto";

export interface Settings {
  /** 主题 */
  theme: ThemeName;
  /** 编辑器字号 px */
  fontSize: number;
  /** 编辑器自动换行（长行软折行，不改变文档内容） */
  wrap: boolean;
  /** 是否开启自动保存 */
  autoSave: boolean;
  /** 自动保存防抖毫秒 */
  autoSaveDelay: number;
  /** 侧边目录是否展开 */
  showTree: boolean;
  /** 预览是否展开 */
  showPreview: boolean;
  /** 上次打开的文件夹（重启后自动恢复目录树） */
  lastFolder: string | null;
  /** 多根工作区：文件树根目录列表（懒加载）；为空时回退到 lastFolder 作为唯一根 */
  roots: string[];
  /** 上次打开的文件（重启后自动恢复内容） */
  lastFile: string | null;
  /** 会话恢复：上次打开的所有标签路径（保持关闭时顺序，第一个为激活标签） */
  openTabs: string[];
  /** 隐藏的文件/文件夹路径（文件树不显示，可管理取消隐藏） */
  hiddenPaths: string[];
  /** 文件树排序方式（name/mtime/size/type，文件夹恒在前） */
  treeSort: "name" | "mtime" | "size" | "type";
  /** 已折叠的文件夹路径（相对各根的绝对路径；上限 500 条，超出丢最旧） */
  treeCollapsed: string[];
  /** 文件树是否显示非 .md 附件/资源文件 */
  showNonMd: boolean;
  /** 文件树是否隐藏附件文件夹（perDocument 模式为 `<文档名>_attachment`，shared 模式为 assetsDir；磁盘仍保留） */
  hideAttachments: boolean;
  /** 附件组织模式：perDocument=每篇文档带自己的 `<文档名>_attachment`；shared=统一收编进 assetsDir */
  attachmentMode: "perDocument" | "shared";
  /** perDocument 模式下，附件目录名模板，{filename} 会被替换为文档名（去扩展名） */
  attachmentTemplate: string;
  /** 文件树目录监视开关（外部变更自动刷新） */
  treeWatch: boolean;
  /** 最近打开的文件（最多 5 个，新的在前） */
  recentFiles: string[];
  /** 附件文件夹名（插图时自动收编到笔记目录下的该文件夹） */
  assetsDir: string;
  /** 收编图片时是否压缩（仅 JPEG/PNG，且压缩后更小才采用） */
  compressImages: boolean;
  /** JPEG 压缩质量（1-100，越小体积越小） */
  jpegQuality: number;
  /** 预览实时模式阈值（KB）：文档超过该大小后预览改为手动刷新，避免超大文档打字时反复跑预览管线 */
  previewRealtimeMaxKB: number;
  /** 低端设备降级模式：auto=按检测，on=强制降级，off=强制标准。影响预览阈值/预读/图片转码等（P1-7） */
  lowEndMode: "auto" | "on" | "off";
  /** 快捷键：actionId -> 加速键字符串 */
  shortcuts: Record<string, string>;
  /** 是否已显示过快捷键示意图（首次启动后置 false） */
  shortcutGuideShown: boolean;
}

// ---------------- 快捷键注册表（对齐 MarkLite-快捷键设置-spec.md）----------------

export type ActionScope = "app" | "editor";

export interface ActionDef {
  id: string;
  label: string;
  /** app：窗口级（文件/视图）；editor：CodeMirror keymap 内处理 */
  scope: ActionScope;
  /** 只读项不允许重绑定（保留给系统级键位） */
  readonly?: boolean;
}

export interface ActionGroup {
  title: string;
  actions: ActionDef[];
}

export const SHORTCUT_GROUPS: ActionGroup[] = [
  {
    title: "文件",
    actions: [
      { id: "file.new", label: "新建笔记", scope: "app" },
      { id: "file.open", label: "打开文件", scope: "app" },
      { id: "file.openFolder", label: "打开文件夹", scope: "app" },
      { id: "file.save", label: "保存", scope: "app" },
      { id: "file.saveAs", label: "另存为", scope: "app" },
      { id: "file.export", label: "导出", scope: "app" },
    ],
  },
  {
    title: "编辑",
    actions: [
      { id: "edit.undo", label: "撤销", scope: "editor" },
      { id: "edit.redo", label: "重做", scope: "editor" },
      { id: "edit.find", label: "查找", scope: "editor" },
      { id: "edit.replace", label: "替换", scope: "editor" },
      { id: "table.duplicateRow", label: "复制表格行到下方", scope: "editor" },
    ],
  },
  {
    title: "格式",
    actions: [
      { id: "format.bold", label: "加粗", scope: "editor" },
      { id: "format.italic", label: "斜体", scope: "editor" },
      { id: "format.underline", label: "下划线", scope: "editor" },
      { id: "format.strike", label: "删除线", scope: "editor" },
      { id: "format.link", label: "插入链接", scope: "editor" },
      { id: "format.h1", label: "一级标题", scope: "editor" },
      { id: "format.h2", label: "二级标题", scope: "editor" },
      { id: "format.h3", label: "三级标题", scope: "editor" },
      { id: "format.h4", label: "四级标题", scope: "editor" },
      { id: "format.h5", label: "五级标题", scope: "editor" },
      { id: "format.quote", label: "引用", scope: "app" },
    ],
  },
  {
    title: "插入",
    actions: [
      { id: "insert.image", label: "插入图片", scope: "app" },
      { id: "insert.codeBlock", label: "插入代码块", scope: "app" },
      { id: "insert.table", label: "插入表格", scope: "app" },
      { id: "table.addColumn", label: "表格添加列", scope: "app" },
      { id: "insert.bullet", label: "无序号列表", scope: "app" },
    ],
  },
  {
    title: "视图",
    actions: [
      { id: "view.togglePreview", label: "切换预览/分屏", scope: "app" },
      { id: "view.focusMode", label: "专注模式", scope: "app" },
      { id: "view.fontIncrease", label: "增大字号", scope: "app" },
      { id: "view.fontDecrease", label: "减小字号", scope: "app" },
    ],
  },
];

export const ALL_ACTIONS: ActionDef[] = SHORTCUT_GROUPS.flatMap((g) => g.actions);

export function actionLabel(id: string): string {
  return ALL_ACTIONS.find((a) => a.id === id)?.label ?? id;
}

export const DEFAULT_SHORTCUTS: Record<string, string> = {
  "file.new": "Ctrl+N",
  "file.open": "Ctrl+O",
  "file.openFolder": "Ctrl+Shift+O",
  "file.save": "Ctrl+S",
  "file.saveAs": "Ctrl+Shift+S",
  "file.export": "Ctrl+E",

  "edit.undo": "Ctrl+Z",
  "edit.redo": "Ctrl+Y",
  "edit.find": "Ctrl+F",
  "edit.replace": "Ctrl+H",
  "table.duplicateRow": "Alt+Enter",

  "format.bold": "Alt+B",
  "format.italic": "Ctrl+I",
  "format.underline": "Ctrl+U",
  "format.strike": "Ctrl+Shift+X",
  "format.link": "Ctrl+K",
  "format.h1": "Alt+1",
  "format.h2": "Alt+2",
  "format.h3": "Alt+3",
  "format.h4": "Alt+4",
  "format.h5": "Alt+5",
  "format.quote": "Alt+>",

  "insert.image": "Alt+Q",
  "insert.codeBlock": "Alt+W",
  "insert.table": "Alt+E",
  "table.addColumn": "Alt+\\",
  "insert.bullet": "Alt+`",

  "view.togglePreview": "Ctrl+\\",
  "view.focusMode": "F11",
  "view.fontIncrease": "Ctrl+=",
  "view.fontDecrease": "Ctrl+-",
};

export const DEFAULT_SETTINGS: Settings = {
  theme: "light",
  fontSize: 14,
  wrap: true,
  autoSave: true,
  autoSaveDelay: 800,
  showTree: true,
  showPreview: true,
  lastFolder: null,
  roots: [],
  lastFile: null,
  openTabs: [],
  hiddenPaths: [],
  treeSort: "name",
  treeCollapsed: [],
  showNonMd: false,
  hideAttachments: true,
  attachmentMode: "perDocument",
  attachmentTemplate: "{filename}_attachment",
  treeWatch: true,
  recentFiles: [],
  assetsDir: "_attachment",
  compressImages: true,
  jpegQuality: 80,
  previewRealtimeMaxKB: 2048,
  lowEndMode: "auto",
  shortcuts: { ...DEFAULT_SHORTCUTS },
  shortcutGuideShown: false,
};

export const FONT_SIZE_MIN = 11;
export const FONT_SIZE_MAX = 24;

// ---------------- 加速键解析 / 匹配 / 展示 ----------------

const MOD_ALIASES: Record<string, string> = {
  ctrl: "Ctrl",
  control: "Ctrl",
  cmd: "Ctrl",
  command: "Ctrl",
  meta: "Ctrl",
  mod: "Ctrl",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
};

/** 符号键物理键位 → 未按 Shift 的基础字符（把按键归一化，使快捷键无需配合 Shift 触发） */
const CODE_TO_BASE: Record<string, string> = {
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
};

/** 符号键 Shift 变体 → 基础字符（把配置/保存的加速键归一化，与按键归一保持一致） */
const SHIFTED_TO_BASE: Record<string, string> = {
  "~": "`",
  "_": "-",
  "+": "=",
  "{": "[",
  "}": "]",
  "|": "\\",
  ":": ";",
  "\"": "'",
  "<": ",",
  ">": ".",
  "?": "/",
};

/** 统一加速键写法：修饰键顺序固定 Ctrl → Alt → Shift，主键大写 */
export function normalizeAccel(accel: string): string {
  const parts = accel
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) return "";
  let ctrl = false;
  let alt = false;
  let shift = false;
  let key = "";
  for (const p of parts) {
    const m = MOD_ALIASES[p.toLowerCase()];
    if (m === "Ctrl") ctrl = true;
    else if (m === "Alt") alt = true;
    else if (m === "Shift") shift = true;
    else {
      let k = p.length === 1 ? p.toUpperCase() : p;
      // 符号键统一归一到未按 Shift 的基础字符（| → \、~ → ` 等），使 "Alt+|" 与 "Alt+\" 视为同一物理键
      if (k.length === 1 && SHIFTED_TO_BASE[k]) k = SHIFTED_TO_BASE[k];
      key = k;
    }
  }
  const out: string[] = [];
  if (ctrl) out.push("Ctrl");
  if (alt) out.push("Alt");
  if (shift) out.push("Shift");
  if (key) out.push(key);
  return out.join("+");
}

/** 从 keydown 事件解析主键名（过滤纯修饰键） */
function eventKeyName(e: KeyboardEvent): string | null {
  const k = e.key;
  if (k === "Control" || k === "Alt" || k === "Shift" || k === "Meta") return null;
  if (/^F\d{1,2}$/.test(k)) return k;
  if (k === " ") return "Space";
  if (k.length === 1) {
    // Shift 会改变 e.key（5 → %），用物理键位兜底
    if (/^Digit\d$/.test(e.code)) return e.code.slice(5);
    if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3);
    // 符号键同样按物理键位归一为基础字符（如 \ 键无论是否按 Shift 都返回 \），让 "Alt+\" 无需 Shift 即可触发
    const base = CODE_TO_BASE[e.code];
    if (base) return base;
    return k.toUpperCase();
  }
  return k; // Enter / Escape / Tab / Home / ArrowUp ...
}

/** 把 keydown 事件转成加速键字符串；纯修饰键返回 null */
export function accelFromEvent(e: KeyboardEvent): string | null {
  const key = eventKeyName(e);
  if (!key) return null;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  // 数字/字母记录 Shift（物理键位）；符号键已归一为基础字符（见 eventKeyName），
  // Shift 不再改变字符，故不追加，使 "Alt+\" 无论是否按 Shift 都能匹配
  const isSymbol = key.length === 1 && !/[A-Za-z0-9]/.test(key);
  if (e.shiftKey && !isSymbol) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}

export function matchAccel(e: KeyboardEvent, accel: string): boolean {
  if (!accel) return false;
  const got = accelFromEvent(e);
  return !!got && got === normalizeAccel(accel);
}

/** 转成 CodeMirror keymap 的 key 写法（Ctrl → Mod） */
export function toCmKey(accel: string): string {
  const n = normalizeAccel(accel);
  if (!n) return "";
  const parts = n.split("+");
  const key = parts.pop() as string;
  const mods = parts.map((m) => (m === "Ctrl" ? "Mod" : m));
  return [...mods, key.length === 1 ? key.toLowerCase() : key].join("-");
}

/** 面板展示用：Ctrl + Shift + O */
export function displayAccel(accel: string): string {
  return normalizeAccel(accel).split("+").join(" + ");
}

/** 找出与给定加速键冲突的其它动作 id */
export function findConflict(
  shortcuts: Record<string, string>,
  accel: string,
  exceptId: string
): string | null {
  const target = normalizeAccel(accel);
  for (const [id, v] of Object.entries(shortcuts)) {
    if (id === exceptId) continue;
    if (normalizeAccel(v) === target) return id;
  }
  return null;
}

// ---------------- 持久化（桥接层注入）----------------

let bridge: SettingsBridge | null = null;

/** App 启动时注入真正的持久化实现（Tauri invoke，浏览器调试时回退 localStorage） */
export function initSettingsBridge(b: SettingsBridge): void {
  bridge = b;
}

const LS_KEY = "litemd.settings";

/** 附件文件夹名清洗：只保留单层文件夹名，剔除路径分隔符与非法字符，防止路径穿越 */
function sanitizeAssetsDir(v: unknown): string {
  if (typeof v !== "string") return DEFAULT_SETTINGS.assetsDir;
  const name = v
    .trim()
    .replace(/[\\/]+/g, "")
    .replace(/[<>:"|?*\u0000-\u001f]/g, "")
    .trim();
  if (!name || name === "." || name === "..") return DEFAULT_SETTINGS.assetsDir;
  return name;
}

function sanitize(raw: unknown): Settings {
  const s = (raw ?? {}) as Partial<Settings>;
  const shortcuts: Record<string, string> = { ...DEFAULT_SHORTCUTS };
  if (s.shortcuts && typeof s.shortcuts === "object") {
    for (const a of ALL_ACTIONS) {
      const v = (s.shortcuts as Record<string, unknown>)[a.id];
      if (typeof v === "string" && v.trim()) shortcuts[a.id] = normalizeAccel(v);
    }
  }
  // 迁移：「无序号列表」（原「插入 • 符号」）默认键由 Alt+· 改为 Alt+`（· 依赖输入法产生、按住 Alt
  // 时匹配失败；` 是键盘布局级字符、稳定可靠）。已保存值若仍为旧默认则跟随新默认；用户自定义键位不受影响。
  if (shortcuts["insert.bullet"] === normalizeAccel("Alt+·")) {
    shortcuts["insert.bullet"] = DEFAULT_SHORTCUTS["insert.bullet"];
  }
  // 迁移：「删除线」默认键由 Alt+Shift+5 改为 Ctrl+Shift+X（Alt+Shift+1~9 让位给「有序列表」起始编号）。
  // 已保存值若仍为旧默认则跟随新默认；用户自定义键位不受影响。
  if (shortcuts["format.strike"] === normalizeAccel("Alt+Shift+5")) {
    shortcuts["format.strike"] = DEFAULT_SHORTCUTS["format.strike"];
  }
  // 迁移：「引用」默认键由 Alt+R 改为 Alt+>（对应「>」引用标记，语义更直观）。
  // 已保存值若仍为旧默认则跟随新默认；用户自定义键位不受影响。
  if (shortcuts["format.quote"] === normalizeAccel("Alt+R")) {
    shortcuts["format.quote"] = DEFAULT_SHORTCUTS["format.quote"];
  }
  const fontSize = Number(s.fontSize);
  return {
    theme: s.theme === "dark" || s.theme === "auto" ? (s.theme as ThemeName) : "light",
    fontSize: Number.isFinite(fontSize)
      ? Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(fontSize)))
      : DEFAULT_SETTINGS.fontSize,
    wrap: s.wrap !== false,
    autoSave: s.autoSave !== false,
    autoSaveDelay:
      Number.isFinite(Number(s.autoSaveDelay)) && Number(s.autoSaveDelay) >= 300
        ? Number(s.autoSaveDelay)
        : DEFAULT_SETTINGS.autoSaveDelay,
    showTree: s.showTree !== false,
    showPreview: s.showPreview !== false,
    lastFolder: typeof s.lastFolder === "string" ? s.lastFolder : null,
    lastFile: typeof s.lastFile === "string" ? s.lastFile : null,
    openTabs: Array.isArray(s.openTabs)
      ? s.openTabs.filter((p): p is string => typeof p === "string" && !!p).slice(0, 30)
      : [],
    hiddenPaths: Array.isArray(s.hiddenPaths)
      ? s.hiddenPaths.filter((p): p is string => typeof p === "string" && !!p)
      : [],
    treeSort:
      s.treeSort === "mtime" || s.treeSort === "size" || s.treeSort === "type"
        ? s.treeSort
        : "name",
    treeCollapsed: Array.isArray(s.treeCollapsed)
      ? s.treeCollapsed.filter((p): p is string => typeof p === "string" && !!p).slice(0, 500)
      : [],
    showNonMd: s.showNonMd === true,
    hideAttachments: s.hideAttachments !== false,
    treeWatch: s.treeWatch !== false,
    roots: Array.isArray(s.roots)
      ? s.roots.filter((p): p is string => typeof p === "string" && !!p)
      : [],
    recentFiles: Array.isArray(s.recentFiles)
      ? s.recentFiles.filter((f): f is string => typeof f === "string").slice(0, 5)
      : [],
    assetsDir: sanitizeAssetsDir(s.assetsDir),
    attachmentMode: s.attachmentMode === "shared" ? "shared" : "perDocument",
    attachmentTemplate:
      typeof s.attachmentTemplate === "string" && s.attachmentTemplate.trim().length > 0
        ? s.attachmentTemplate.trim()
        : "{filename}_attachment",
    compressImages: s.compressImages !== false,
    jpegQuality:
      Number.isFinite(Number(s.jpegQuality))
        ? Math.min(95, Math.max(50, Math.round(Number(s.jpegQuality))))
        : DEFAULT_SETTINGS.jpegQuality,
    previewRealtimeMaxKB:
      Number.isFinite(Number(s.previewRealtimeMaxKB))
        ? Math.min(8192, Math.max(256, Math.round(Number(s.previewRealtimeMaxKB))))
        : DEFAULT_SETTINGS.previewRealtimeMaxKB,
    lowEndMode:
      s.lowEndMode === "on" || s.lowEndMode === "off" ? s.lowEndMode : "auto",
    shortcuts,
    shortcutGuideShown: s.shortcutGuideShown === true,
  };
}

export async function loadSettings(): Promise<Settings> {
  let text: string | null = null;
  if (bridge) {
    try {
      text = await bridge.load();
    } catch {
      text = null;
    }
  }
  if (!text) text = localStorage.getItem(LS_KEY);
  if (!text) return { ...DEFAULT_SETTINGS, shortcuts: { ...DEFAULT_SHORTCUTS } };
  try {
    return sanitize(JSON.parse(text));
  } catch {
    return { ...DEFAULT_SETTINGS, shortcuts: { ...DEFAULT_SHORTCUTS } };
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  const json = JSON.stringify(settings, null, 2);
  if (bridge) {
    try {
      await bridge.save(json);
      return;
    } catch {
      /* 回退 localStorage */
    }
  }
  localStorage.setItem(LS_KEY, json);
}

/** 写盘防抖，避免频繁改设置时反复落盘 */
let persistTimer: ReturnType<typeof setTimeout> | null = null;
export function persistSettings(settings: Settings, delay = 300): void {
  if (persistTimer) clearTimeout(persistTimer);
  const snapshot: Settings = { ...settings, shortcuts: { ...settings.shortcuts } };
  persistTimer = setTimeout(() => void saveSettings(snapshot), delay);
}
