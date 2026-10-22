// 菜单注册表单测（B2/E1）：树结构不变量 + 加速键撞车检测。
// 注册表是菜单栏/命令面板/右键菜单的单一数据源，结构漂移会静默丢入口，故在此设防。
import { describe, it, expect } from "vitest";
import {
  GROUP_LABELS,
  GROUP_ORDER,
  MENU_TREE,
  buildMenuTree,
  detectAccelConflicts,
  displayAccelOf,
  type MenuNode,
} from "../menu-registry";
import { ALL_MENU_ACTIONS, ALL_ACTIONS, MENU_ONLY_ACTIONS } from "../settings";

const groupedIds = ALL_MENU_ACTIONS.filter((a) => a.group).map((a) => a.id);

function actionNodes(): MenuNode[] {
  return Object.values(MENU_TREE)
    .flat()
    .filter((n) => n.kind === "action");
}

describe("menu-registry 树结构", () => {
  it("树中 action 节点数 = 带 group 的 action 数（无丢放、无凭空多放）", () => {
    const nodes = actionNodes();
    expect(nodes.length).toBe(groupedIds.length);
    expect(new Set(nodes.map((n) => n.id))).toEqual(new Set(groupedIds));
  });

  it("每组非空", () => {
    for (const g of GROUP_ORDER) {
      expect(MENU_TREE[g].length).toBeGreaterThan(0);
    }
  });

  it("file.new 在 file 组首位", () => {
    expect(MENU_TREE.file[0]).toMatchObject({ kind: "action", id: "file.new" });
  });

  it("sep 不出现在任何组的首尾", () => {
    for (const g of GROUP_ORDER) {
      const t = MENU_TREE[g];
      expect(t[0].kind).not.toBe("sep");
      expect(t[t.length - 1].kind).not.toBe("sep");
    }
  });

  it("8 组标签齐全且顺序固定", () => {
    expect(GROUP_ORDER).toEqual([
      "file",
      "edit",
      "view",
      "insert",
      "format",
      "tools",
      "window",
      "help",
    ]);
    expect(Object.keys(GROUP_LABELS).sort()).toEqual([...GROUP_ORDER].sort());
  });

  it("「最近打开」为 file 组 sub 标记，且挂载清除列表静态子项", () => {
    const recentIdx = MENU_TREE.file.findIndex((n) => n.kind === "sub" && n.id === "recent");
    expect(recentIdx).toBeGreaterThan(0);
    expect(MENU_TREE.file[recentIdx]).toMatchObject({ kind: "sub", label: "最近打开", sub: "file" });
    // 动态条目运行时注入；静态子项 file.clearRecent 紧随小标题之后
    expect(MENU_TREE.file[recentIdx + 1]).toMatchObject({ kind: "action", id: "file.clearRecent" });
  });

  it("子菜单 children 全部落在树中且顺序按 order 升序", () => {
    const heading = MENU_TREE.format.filter((n) => n.kind === "action" && /^format\.h[1-6]$/.test(n.id ?? ""));
    expect(heading.map((n) => n.id)).toEqual([
      "format.h1",
      "format.h2",
      "format.h3",
      "format.h4",
      "format.h5",
      "format.h6",
    ]);
  });

  it("buildMenuTree 为纯函数：重复调用结果一致", () => {
    expect(buildMenuTree()).toEqual(MENU_TREE);
  });
});

describe("menu-registry 数据源", () => {
  it("MENU_ONLY_ACTIONS 与 SHORTCUT_GROUPS 无 id 交叉（快捷键体系零污染）", () => {
    const base = new Set(ALL_ACTIONS.map((a) => a.id));
    for (const a of MENU_ONLY_ACTIONS) {
      expect(base.has(a.id)).toBe(false);
    }
  });

  it("detectAccelConflicts 为空（默认键位 + 展示 accel 无撞车）", () => {
    expect(detectAccelConflicts()).toEqual([]);
  });

  it("displayAccelOf：DEFAULT_SHORTCUTS 优先，其次 ActionDef.accel", () => {
    expect(displayAccelOf("file.save")).toBe("Ctrl+S");
    expect(displayAccelOf("edit.folderSearch")).toBe("Ctrl+Shift+F");
    expect(displayAccelOf("insert.math")).toBe("");
  });
});
