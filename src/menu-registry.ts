// 菜单注册表（单一数据源，设计方案 §05）。
// 菜单栏（MenuBar.svelte）、命令面板（B3）、右键菜单（B5）全部从本模块只读渲染；
// 新增功能只改 settings.ts 的 action 定义 + 本文件的组内结构（SUB_DEFS / SEP_AFTER）。
// 纯数据模块：无 DOM / 无 Tauri 依赖，可在 Node 下安全 import（供单测）。
import {
  ALL_MENU_ACTIONS,
  DEFAULT_SHORTCUTS,
  normalizeAccel,
  type ActionDef,
  type MenuGroupId,
} from "./settings";

export type { MenuGroupId, Surface, CtxId } from "./settings";

/** 菜单树节点：action = 可执行项 · sep = 分隔线 · sub = 分组小标题（children 紧随其后扁平排布） */
export interface MenuNode {
  kind: "action" | "sep" | "sub";
  /** action = ActionDef.id；sub = 语义化 id（如 "recent"/"exports"） */
  id?: string;
  /** 展示名（action 取 ActionDef.label；sub 为组内小标题） */
  label?: string;
  /** sub 专用：该小标题归属的菜单组（便于命令面板/右键按组归类） */
  sub?: MenuGroupId;
  /** action 专用：展示用加速键兜底（真值以 settings.shortcuts 为准，经 accelFn 读取） */
  accel?: string;
}

/** 8 组菜单的中文标签（设计方案 §04） */
export const GROUP_LABELS: Record<MenuGroupId, string> = {
  file: "文件",
  edit: "编辑",
  view: "视图",
  insert: "插入",
  format: "格式",
  tools: "工具",
  window: "窗口",
  help: "帮助",
};

/** 菜单栏根按钮固定顺序 */
export const GROUP_ORDER: MenuGroupId[] = [
  "file",
  "edit",
  "view",
  "insert",
  "format",
  "tools",
  "window",
  "help",
];

/** 组内子菜单（分组小标题）定义；children 为 action id，按各自 order 升序渲染 */
interface SubDef {
  id: string;
  label: string;
  order: number;
  children: string[];
}

const SUB_DEFS: Record<MenuGroupId, SubDef[]> = {
  file: [
    // 「最近打开」：结构上留 sub 标记，运行时由 MenuBar 经 recentFiles prop 注入动态条目，
    // file.clearRecent（清除列表）作为静态子项挂在小标题行下。
    { id: "recent", label: "最近打开", order: 50, children: ["file.clearRecent"] },
    { id: "exports", label: "导出", order: 90, children: ["file.export"] },
  ],
  edit: [],
  view: [
    { id: "modes", label: "编辑模式", order: 10, children: ["view.modeRealtime", "view.modeSource", "view.modeSplit"] },
    { id: "panels", label: "侧栏", order: 20, children: ["view.panelTree", "view.panelOutline", "view.panelSearch"] },
    { id: "appearance", label: "外观", order: 40, children: ["view.themeLight", "view.themeDark", "view.themeAuto"] },
  ],
  insert: [],
  format: [
    { id: "heading", label: "标题", order: 10, children: ["format.h1", "format.h2", "format.h3", "format.h4", "format.h5", "format.h6", "format.paragraph"] },
    { id: "list", label: "列表", order: 70, children: ["insert.bullet", "insert.orderedList"] },
  ],
  tools: [
    { id: "assets", label: "图片附件管理", order: 20, children: ["tools.migrateImages", "tools.migrateFolder", "tools.cleanupAssets"] },
  ],
  window: [],
  help: [],
};

/** 组内分隔线锚点：在该 id（action 或 sub）之后插入 sep */
const SEP_AFTER: Record<MenuGroupId, string[]> = {
  file: ["file.openFolder", "recent", "exports"],
  edit: ["edit.redo", "edit.selectAll", "edit.folderSearch"],
  view: ["panels", "appearance"],
  insert: ["insert.toc"],
  format: ["heading", "list"],
  tools: ["assets"],
  window: ["win.alwaysOnTop"],
  help: ["help.shortcuts"],
};

/**
 * 从全量 action 定义派生菜单树（纯函数，供单测直接断言）。
 * 不变量（违设即抛错，防止注册表配置漂移）：
 *   1. action id 唯一；
 *   2. 子菜单引用的 action 必须存在且不被多个子菜单引用；
 *   3. 所有带 group 的 action 必须被放置进某个组（顶级或子菜单 children）。
 */
export function buildMenuTree(): Record<MenuGroupId, MenuNode[]> {
  const actions = new Map<string, ActionDef>();
  for (const a of ALL_MENU_ACTIONS) {
    if (actions.has(a.id)) {
      throw new Error(`menu-registry: action id 重复定义 — ${a.id}`);
    }
    actions.set(a.id, a);
  }

  const placed = new Set<string>();
  const out = {} as Record<MenuGroupId, MenuNode[]>;

  for (const g of GROUP_ORDER) {
    // 子菜单 children 登记：被引用的 action 不再作为顶级条目出现
    const childOf = new Map<string, string>();
    for (const sd of SUB_DEFS[g]) {
      for (const cid of sd.children) {
        if (!actions.has(cid)) {
          throw new Error(`menu-registry: 子菜单 ${sd.id} 引用不存在的 action — ${cid}`);
        }
        if (childOf.has(cid)) {
          throw new Error(`menu-registry: action 被多个子菜单引用 — ${cid}`);
        }
        childOf.set(cid, sd.id);
      }
    }

    interface Item {
      order: number;
      node: MenuNode;
    }
    const items: Item[] = [];

    for (const a of actions.values()) {
      if (a.group !== g || childOf.has(a.id)) continue;
      items.push({
        order: a.order ?? 100,
        node: { kind: "action", id: a.id, label: a.label, accel: a.accel },
      });
      placed.add(a.id);
    }

    for (const sd of SUB_DEFS[g]) {
      const children: ActionDef[] = sd.children
        .map((cid) => actions.get(cid) as ActionDef)
        .sort((x, y) => (x.order ?? 100) - (y.order ?? 100));
      items.push({ order: sd.order, node: { kind: "sub", id: sd.id, label: sd.label, sub: g } });
      // children 紧随 sub 节点之后（扁平结构：sub 即分组小标题）
      children.forEach((a, i) => {
        items.push({
          order: sd.order + (i + 1) / 100,
          node: { kind: "action", id: a.id, label: a.label, accel: a.accel },
        });
        placed.add(a.id);
      });
    }

    items.sort((x, y) => x.order - y.order);

    const nodes: MenuNode[] = [];
    for (let i = 0; i < items.length; i++) {
      nodes.push(items[i].node);
      const anchor = items[i].node.id;
      if (!anchor || !SEP_AFTER[g].includes(anchor)) continue;
      // sub 锚点：分隔线须落在其最后一个子项之后（children 占据 sub.order 之后的分数位），
      // 否则会插在小标题与子项之间，破坏「分组小标题 + 条目」的视觉连续。
      let j = i;
      if (items[i].node.kind === "sub") {
        while (j + 1 < items.length && items[j + 1].order < items[i].order + 1) j++;
      }
      for (let k = i + 1; k <= j; k++) nodes.push(items[k].node);
      nodes.push({ kind: "sep" });
      i = j;
    }
    out[g] = nodes;
  }

  for (const a of actions.values()) {
    if (a.group && !placed.has(a.id)) {
      throw new Error(`menu-registry: 带 group 的 action 未放入菜单树 — ${a.id}`);
    }
  }
  return out;
}

/** 菜单树（模块级单例；集成阶段与 MenuBar 直接消费） */
export const MENU_TREE: Record<MenuGroupId, MenuNode[]> = buildMenuTree();

/**
 * 检测展示层加速键撞车：同一归一化 accel 被多个 action 使用。
 * 取值顺序 = DEFAULT_SHORTCUTS[id] ?? ActionDef.accel（均为静态展示值）。
 * 返回 [accel, [actionId...]] 列表；无冲突返回空数组。
 */
export function detectAccelConflicts(): [string, string[]][] {
  const byAccel = new Map<string, string[]>();
  for (const a of ALL_MENU_ACTIONS) {
    const raw = DEFAULT_SHORTCUTS[a.id] ?? a.accel;
    if (!raw) continue;
    const n = normalizeAccel(raw);
    if (!n) continue;
    const list = byAccel.get(n) ?? [];
    list.push(a.id);
    byAccel.set(n, list);
  }
  const out: [string, string[]][] = [];
  for (const [accel, ids] of byAccel) {
    if (ids.length > 1) out.push([accel, ids]);
  }
  return out.sort((x, y) => x[0].localeCompare(y[0]));
}

/** 取 action 的展示用加速键兜底值（DEFAULT_SHORTCUTS 优先，其次 ActionDef.accel） */
export function displayAccelOf(id: string): string {
  return DEFAULT_SHORTCUTS[id] ?? ALL_MENU_ACTIONS.find((a) => a.id === id)?.accel ?? "";
}
