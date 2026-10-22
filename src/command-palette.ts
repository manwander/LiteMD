// 命令面板（Command Palette）核心逻辑：四类源的装配 + 模糊匹配排序。
// 纯函数模块（无 DOM / 无 Tauri 依赖），可单测；UI 见 CommandPalette.svelte。
//
// 四类源（B3 + LM-13）：
//   command —— 来自 settings.ts 的 ActionDef（surfaces 含 "palette" 或无 surfaces 字段的）
//   file    —— 来自 fs.ts listMdFiles 的文件路径列表
//   setting —— 设置项快捷跳转（调用方提供 id/label；本模块内置 DEFAULT_SETTING_LABELS）
//   outline —— 大纲标题跳转（LM-13：query 以 @ 前缀时专用，跳编辑器对应行）
import type { ActionDef } from "./settings";

/** 命令面板的一条候选 */
export interface PalItem {
  /** 命令：actionId；文件：完整路径；设置：设置项 id（如 "setting:theme"）；大纲：`outline:<line>` */
  id: string;
  label: string;
  /** 次要说明：文件为所在目录；大纲为行号提示；命令/设置可空 */
  hint?: string;
  group: "command" | "file" | "setting" | "outline";
  /** 大纲组专用：标题所在行（0-based，与 OutlinePanel/jumpToLine 契约一致） */
  line?: number;
  /** 匹配得分（buildSources 置 0，rank 时按 query 重算） */
  score: number;
}

/** rank 的组内上限；默认命令 6 / 文件 5 / 设置 4 / 大纲 6 */
export interface PalCaps {
  command: number;
  file: number;
  setting: number;
  outline: number;
}

export const DEFAULT_CAPS: PalCaps = { command: 6, file: 5, setting: 4, outline: 6 };

/** 组展示顺序：command → file → setting → outline（rank 输出与 UI 分组共用） */
export const GROUP_ORDER: PalItem["group"][] = ["command", "file", "setting", "outline"];

/** 组标题（UI 展示用，与 rank 的组序一致） */
export const GROUP_TITLES: Record<PalItem["group"], string> = {
  command: "命令",
  file: "文件",
  setting: "设置",
  outline: "大纲标题",
};

// ---------------- 内置设置源 ----------------

/**
 * 内置设置项快捷跳转列表。
 *
 * 说明：props 契约未提供 settingLabels 入参，故组件使用本默认列表装配 setting 源。
 * 集成方在 dispatch(id) 中按此前缀分发（如打开设置弹窗并定位到对应分区）。
 */
export const DEFAULT_SETTING_LABELS: { id: string; label: string }[] = [
  { id: "setting:theme", label: "主题（亮色 / 暗色 / 跟随系统）" },
  { id: "setting:fontSize", label: "编辑器字号" },
  { id: "setting:wrap", label: "编辑器自动换行" },
  { id: "setting:autoSave", label: "自动保存" },
  { id: "setting:showTree", label: "显示侧边目录" },
  { id: "setting:showPreview", label: "显示预览" },
  { id: "setting:lowEndMode", label: "低端设备降级模式" },
  { id: "setting:sync", label: "WebDAV 同步" },
  { id: "setting:shortcuts", label: "快捷键设置" },
];

// ---------------- 模糊匹配 ----------------

/** 词首判定：串首或跟在分隔符后（空格 / - _ / \ . , ; : 括号 # @ 等） */
const WORD_SEP = /[\s\-_/\\.,;:()[\]{}#@!?'"]/;

/**
 * 子序列模糊匹配打分（大小写不敏感）：
 *   - 空 query 返回 0；
 *   - query 不是 text 的子序列时返回 0（不匹配）；
 *   - 每命中一字：基础 1 分；承接上一命中（连续）×2；位于词首 ×3；
 *   - query 整串被 text 包含（中文整词/英文整词命中）额外加分 = 串长 × 4，
 *     保证整串命中显著高于散点匹配。
 */
export function fuzzy(query: string, text: string): number {
  const q = query.trim();
  if (!q) return 0;
  const t = text.toLowerCase();
  const ql = q.toLowerCase();

  let score = 0;
  let cursor = 0; // text 中下一个命中位的扫描起点
  let lastHit = -2; // 上一命中字符在 text 中的下标（-2 保证首字符不算"连续"）
  for (let qi = 0; qi < ql.length; qi++) {
    const ch = ql[qi];
    if (ch === " ") continue; // query 中的空格不参与匹配（按整段连续串处理）
    const found = t.indexOf(ch, cursor);
    if (found === -1) return 0; // 子序列断裂 → 不匹配
    const atWordStart = found === 0 || WORD_SEP.test(t[found - 1]);
    const consecutive = found === lastHit + 1;
    if (atWordStart) score += 3;
    else if (consecutive) score += 2;
    else score += 1;
    lastHit = found;
    cursor = found + 1;
  }

  // 整串包含加分：中文按子序列逐字散匹配没有语义，整串命中才是用户意图；
  // 英文整词命中同样受益（如 "open" 命中 "Open File"）。
  if (t.includes(ql)) score += ql.length * 4;
  return score;
}

// ---------------- 排序 / 截断 ----------------

/**
 * 对候选列表按 query 排序并按组截断。
 *
 * - 空 query：只回 command 组（「最近命令」占位，不做持久化），保持传入顺序；
 * - 非空 query：组内按得分降序（同分保持传入顺序，sort 稳定性保证），
 *   组间严格按 command → file → setting → outline 输出，各组上限取 caps；
 * - LM-13：query 以 @ 前缀 = 大纲标题专用模式——剥离 @ 后只在 outline 组内
 *   模糊匹配（跳编辑器对应行），不与命令/文件混排；普通 query 不混入大纲组。
 */
export function rank(items: PalItem[], q: string, caps?: PalCaps): PalItem[] {
  const c: PalCaps = caps ?? DEFAULT_CAPS;
  const raw = q.trim();
  const atMode = raw.startsWith("@");
  const query = atMode ? raw.slice(1).trim() : raw;

  // @ 模式只看大纲组；普通模式把大纲组挡在外面（保持既有三源混排语义）
  const pool = atMode
    ? items.filter((it) => it.group === "outline")
    : items.filter((it) => it.group !== "outline");

  if (!query) {
    if (atMode) return pool.slice(0, c.outline); // 空 @：全量大纲（传入序即文档序）
    return pool.filter((it) => it.group === "command").slice(0, c.command);
  }

  const byGroup: Record<PalItem["group"], PalItem[]> = {
    command: [],
    file: [],
    setting: [],
    outline: [],
  };
  for (const it of pool) {
    const score = fuzzy(query, it.label);
    if (score <= 0) continue; // 不匹配直接淘汰
    byGroup[it.group].push({ ...it, score });
  }

  const out: PalItem[] = [];
  for (const g of GROUP_ORDER) {
    const group = byGroup[g];
    // 同分稳定：保持 buildSources/调用方的传入顺序
    group.sort((a, b) => b.score - a.score);
    out.push(...group.slice(0, c[g]));
  }
  return out;
}

// ---------------- 三类源装配 ----------------

/** 拆分路径取末段（basename），同时兼容 / 与 \ 分隔符 */
function basename(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx === -1 ? path : path.slice(idx + 1);
}

/** 拆分路径取目录段（dirname）；无分隔符时返回空串 */
function dirname(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx === -1 ? "" : path.slice(0, idx);
}

/**
 * 装配四类候选源。
 *
 * @param actions      命令来源（settings.ts ALL_ACTIONS）。仅收录 surfaces 含
 *                     "palette" 或无 surfaces 字段的动作——B2 扩展 ActionDef
 *                     后可用 surfaces 把纯菜单项挡在面板外。
 * @param files        文件来源（fs.ts listMdFiles 的返回）。label 取 basename，
 *                     hint 取 dirname（无目录时 hint 为空）。
 * @param settingLabels 设置来源。为空时回退内置 DEFAULT_SETTING_LABELS。
 * @param outline      大纲来源（LM-13）。label 取标题文本，line 为 0-based 行号
 *                     （OutlinePanel/jumpToLine 同契约）；仅 @ 前缀查询可见。
 */
export function buildSources(
  actions: ActionDef[],
  files: string[],
  settingLabels?: { id: string; label: string }[],
  outline?: { line: number; label: string }[]
): PalItem[] {
  const out: PalItem[] = [];

  for (const a of actions) {
    // ActionDef 正被 B2 并发扩展（新增可选 surfaces 字段）；此处用宽松读取，
    // 无论字段是否已落地都能编译与运行：无 surfaces = 旧版动作，全部进面板。
    const surfaces = (a as { surfaces?: unknown }).surfaces;
    if (Array.isArray(surfaces) && !surfaces.includes("palette")) continue;
    out.push({ id: a.id, label: a.label, group: "command", score: 0 });
  }

  for (const p of files) {
    if (!p) continue;
    const dir = dirname(p);
    out.push({
      id: p,
      label: basename(p),
      hint: dir || undefined,
      group: "file",
      score: 0,
    });
  }

  const settings = settingLabels?.length ? settingLabels : DEFAULT_SETTING_LABELS;
  for (const s of settings) {
    if (!s.id || !s.label) continue;
    out.push({ id: s.id, label: s.label, group: "setting", score: 0 });
  }

  for (const o of outline ?? []) {
    if (!o.label || typeof o.line !== "number") continue;
    out.push({
      id: `outline:${o.line}`,
      label: o.label,
      hint: `第 ${o.line + 1} 行`,
      group: "outline",
      line: o.line,
      score: 0,
    });
  }

  return out;
}
