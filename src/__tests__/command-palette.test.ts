/**
 * 命令面板核心逻辑单元测试 —— 对应 B3 规格：
 *   fuzzy  子序列匹配（命中 1/字、连续 ×2、词首 ×3、中文整串包含加分；空 query 返回 0）
 *   rank   空 query 只回 command 组；组内按分降序；组序 command→file→setting；上限 6/5/4
 *   buildSources 三类源装配（命令 surfaces 过滤 / 文件 basename+dirname / 设置回退默认列表）
 */
import { describe, it, expect } from "vitest";
import { fuzzy, rank, buildSources, DEFAULT_SETTING_LABELS } from "../command-palette";
import type { PalItem } from "../command-palette";
import type { ActionDef } from "../settings";

// ---------------- fuzzy ----------------

describe("fuzzy 子序列匹配", () => {
  it("空 query 返回 0", () => {
    expect(fuzzy("", "打开文件夹")).toBe(0);
    expect(fuzzy("   ", "open file")).toBe(0);
  });

  it("英文大小写不敏感", () => {
    expect(fuzzy("OPEN", "open file")).toBe(fuzzy("open", "Open File"));
    expect(fuzzy("OPEN", "open file")).toBeGreaterThan(0);
  });

  it("子序列断裂（不匹配）返回 0", () => {
    expect(fuzzy("zzz", "open file")).toBe(0);
    expect(fuzzy("abc", "a b")).toBe(0);
  });

  it("中文整串包含得分高于子序列散匹配", () => {
    const text = "打开文件夹";
    // 整串命中：子序列连续得分 + 整串包含加分
    const whole = fuzzy("文件夹", text);
    // 散匹配：仅两处孤立命中，无整串包含加分
    const scattered1 = fuzzy("文夹", text);
    const scattered2 = fuzzy("开夹", text);
    expect(whole).toBeGreaterThan(0);
    expect(scattered1).toBeGreaterThan(0);
    expect(scattered2).toBeGreaterThan(0);
    expect(whole).toBeGreaterThan(scattered1);
    expect(whole).toBeGreaterThan(scattered2);
  });

  it("词首命中权重高于串中命中", () => {
    // "b" 在 "a b" 中位于词首（×3）；在 "ab" 中为孤立命中（×1）。
    // 两侧都含单字整串包含加分（+4），分差完全来自词首权重。
    expect(fuzzy("b", "a b")).toBeGreaterThan(fuzzy("b", "ab"));
  });
});

// ---------------- rank ----------------

function cmd(id: string, label: string): PalItem {
  return { id, label, group: "command", score: 0 };
}
function file(id: string, label: string, hint?: string): PalItem {
  return { id, label, hint, group: "file", score: 0 };
}
function setting(id: string, label: string): PalItem {
  return { id, label, group: "setting", score: 0 };
}

describe("rank 排序与截断", () => {
  it("空 query 只回 command 组（最近命令占位，不做持久化）", () => {
    const items: PalItem[] = [
      cmd("file.save", "保存"),
      file("/docs/a.md", "a.md", "/docs"),
      setting("setting:theme", "主题"),
      cmd("file.new", "新建笔记"),
    ];
    const r = rank(items, "");
    expect(r.map((x) => x.id)).toEqual(["file.save", "file.new"]);
    expect(r.every((x) => x.group === "command")).toBe(true);
  });

  it("超上限截断：10 条命令只回 6（默认 command 上限）", () => {
    const items: PalItem[] = Array.from({ length: 10 }, (_, i) =>
      cmd(`c${i}`, `命令${i}`)
    );
    const r = rank(items, "命令");
    expect(r.length).toBe(6);
    // 同分保持传入顺序（sort 稳定性），截断保留前 6 条
    expect(r.map((x) => x.id)).toEqual(["c0", "c1", "c2", "c3", "c4", "c5"]);
  });

  it("组序正确：command → file → setting", () => {
    const items: PalItem[] = [
      setting("setting:theme", "主题"),
      file("/notes/主语.md", "主语.md", "/notes"),
      cmd("view.theme", "主题切换"),
      cmd("nav.home", "回到主页"),
    ];
    const r = rank(items, "主");
    // 组间严格 command → file → setting；组内按得分降序（主题切换 13 > 回到主页 1）
    expect(r.map((x) => x.group)).toEqual(["command", "command", "file", "setting"]);
    expect(r.map((x) => x.id)).toEqual(["view.theme", "nav.home", "/notes/主语.md", "setting:theme"]);
  });

  it("自定义 caps 生效（file 上限收紧为 2）", () => {
    const items: PalItem[] = [
      file("/a/笔记1.md", "笔记1.md", "/a"),
      file("/a/笔记2.md", "笔记2.md", "/a"),
      file("/a/笔记3.md", "笔记3.md", "/a"),
      cmd("file.new", "新建笔记"),
    ];
    const r = rank(items, "笔记", { command: 6, file: 2, setting: 4, outline: 6 });
    expect(r.filter((x) => x.group === "file").length).toBe(2);
    expect(r.filter((x) => x.group === "command").length).toBe(1);
  });

  it("不匹配项被淘汰；命中项 score 为重算后的匹配分", () => {
    const items: PalItem[] = [cmd("a", "保存文件"), cmd("b", "导出 PDF")];
    const r = rank(items, "保存");
    expect(r.length).toBe(1);
    expect(r[0].id).toBe("a");
    expect(r[0].score).toBe(fuzzy("保存", "保存文件"));
    expect(r[0].score).toBeGreaterThan(0);
  });
});

// ---------------- buildSources ----------------

/** B2 扩展 ActionDef 新增 surfaces 前的过渡构造：宽松字面量后断言类型 */
function action(id: string, label: string, surfaces?: string[]): ActionDef {
  return { id, label, scope: "app", surfaces } as unknown as ActionDef;
}

describe("buildSources 三类源装配", () => {
  it("三类源各自入组", () => {
    const actions: ActionDef[] = [
      action("file.save", "保存"),
      action("file.new", "新建笔记"),
    ];
    const files = ["/docs/readme.md", "/notes/日记.md"];
    const settings = [{ id: "setting:theme", label: "主题" }];
    const items = buildSources(actions, files, settings);

    const commands = items.filter((x) => x.group === "command");
    const fileItems = items.filter((x) => x.group === "file");
    const settingItems = items.filter((x) => x.group === "setting");
    expect(commands.map((x) => x.id)).toEqual(["file.save", "file.new"]);
    expect(commands.map((x) => x.label)).toEqual(["保存", "新建笔记"]);
    expect(fileItems.length).toBe(2);
    expect(settingItems.map((x) => x.id)).toEqual(["setting:theme"]);
    expect(items.every((x) => x.score === 0)).toBe(true);
  });

  it("文件 label 为 basename、hint 为 dirname（兼容 / 与 \\）", () => {
    const items = buildSources([], ["docs/readme.md", "notes\\sub\\日记.md", "根目录.md"], []);
    const fileItems = items.filter((x) => x.group === "file");
    expect(fileItems.map((x) => x.label)).toEqual(["readme.md", "日记.md", "根目录.md"]);
    expect(fileItems.map((x) => x.hint)).toEqual(["docs", "notes\\sub", undefined]);
    expect(fileItems.map((x) => x.id)).toEqual([
      "docs/readme.md",
      "notes\\sub\\日记.md",
      "根目录.md",
    ]);
  });

  it("命令源 surfaces 过滤：含 palette 或无 surfaces 的进面板，仅 menu 的被挡掉", () => {
    const actions: ActionDef[] = [
      action("file.save", "保存"), // 无 surfaces（旧版 ActionDef）→ 收录
      action("view.palette", "命令面板项", ["palette", "menu"]), // 含 palette → 收录
      action("edit.menuOnly", "仅菜单项", ["menu"]), // 不含 palette → 排除
      action("edit.toolbar", "仅工具项", ["toolbar"]), // 不含 palette → 排除
    ];
    const items = buildSources(actions, [], []);
    expect(items.filter((x) => x.group === "command").map((x) => x.id)).toEqual([
      "file.save",
      "view.palette",
    ]);
  });

  it("settingLabels 为空时回退内置默认设置列表", () => {
    const items = buildSources([], []);
    const settingItems = items.filter((x) => x.group === "setting");
    expect(settingItems.length).toBe(DEFAULT_SETTING_LABELS.length);
    expect(settingItems[0].id).toBe(DEFAULT_SETTING_LABELS[0].id);
  });

  it("大纲源装配：label 取标题、hint 为 1-based 行号提示、line 随条目携带（LM-13）", () => {
    const items = buildSources([], [], [], [
      { line: 0, label: "第一章" },
      { line: 4, label: "第二章" },
    ]);
    const outline = items.filter((x) => x.group === "outline");
    expect(outline.map((x) => x.label)).toEqual(["第一章", "第二章"]);
    expect(outline.map((x) => x.line)).toEqual([0, 4]);
    expect(outline.map((x) => x.hint)).toEqual(["第 1 行", "第 5 行"]);
    expect(outline.map((x) => x.id)).toEqual(["outline:0", "outline:4"]);
  });
});

// ---------------- rank @ 大纲模式（LM-13） ----------------

function heading(line: number, label: string): PalItem {
  return { id: `outline:${line}`, label, group: "outline", line, score: 0 };
}

describe("rank @ 前缀大纲模式", () => {
  const items: PalItem[] = [
    cmd("file.save", "保存"),
    file("/docs/a.md", "a.md", "/docs"),
    heading(0, "安装指南"),
    heading(3, "快速开始"),
    heading(9, "常见问题"),
  ];

  it("普通 query 不混入大纲组（保持既有三源混排语义）", () => {
    const r = rank(items, "开始");
    expect(r.some((x) => x.group === "outline")).toBe(false);
  });

  it("@ 前缀只在大纲组内模糊匹配，命中项携带行号", () => {
    const r = rank(items, "@开始");
    expect(r.length).toBe(1);
    expect(r[0].group).toBe("outline");
    expect(r[0].line).toBe(3);
    expect(r[0].label).toBe("快速开始");
  });

  it("空 @（仅前缀）回全量大纲，传入序即文档序", () => {
    const r = rank(items, "@");
    expect(r.map((x) => x.group)).toEqual(["outline", "outline", "outline"]);
    expect(r.map((x) => x.line)).toEqual([0, 3, 9]);
  });

  it("@ 无匹配返回空列表", () => {
    expect(rank(items, "@不存在").length).toBe(0);
  });
});
