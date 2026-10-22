// outline.ts 单测：ATX / setext / 围栏 / 截断 / 性能（100KB < 2ms，3 倍余量）。
// 行号断言全部为 0-based（与 CodeMirror 一致）。
import { describe, it, expect, beforeEach } from "vitest";
import { tick, mount } from "svelte";
import { extractOutline, type OutlineItem } from "../outline";
import OutlinePanel from "../OutlinePanel.svelte";

describe("extractOutline · ATX 标题", () => {
  it("抽取 1-6 级标题，行号 0-based", () => {
    const doc = ["# H1", "## H2", "### H3", "#### H4", "##### H5", "###### H6"].join("\n");
    expect(extractOutline(doc)).toEqual([
      { level: 1, text: "H1", line: 0 },
      { level: 2, text: "H2", line: 1 },
      { level: 3, text: "H3", line: 2 },
      { level: 4, text: "H4", line: 3 },
      { level: 5, text: "H5", line: 4 },
      { level: 6, text: "H6", line: 5 },
    ]);
  });

  it("容忍行尾闭合 #，且不吞掉正文中的 #", () => {
    const doc = ["## 标题 ##", "# 标题#", "# C# 语言", "### 带 空格 的标题 ###"].join("\n");
    expect(extractOutline(doc)).toEqual([
      { level: 2, text: "标题", line: 0 },
      { level: 1, text: "标题", line: 1 },
      { level: 1, text: "C# 语言", line: 2 },
      { level: 3, text: "带 空格 的标题", line: 3 },
    ]);
  });

  it("# 后无空格不算标题；7 个 # 不算标题", () => {
    const doc = ["#不是标题", "####### 七个井号", "#", "正文"].join("\n");
    expect(extractOutline(doc)).toEqual([]);
  });

  it("与正文、空行混排时只取标题行", () => {
    const doc = ["正文一", "", "## 第二章", "正文二", "#### 第四章", ""].join("\n");
    expect(extractOutline(doc)).toEqual([
      { level: 2, text: "第二章", line: 2 },
      { level: 4, text: "第四章", line: 4 },
    ]);
  });
});

describe("extractOutline · 围栏", () => {
  it("围栏内的 # 标题与 #注释 都不进结果（``` 与 ~~~）", () => {
    const doc = [
      "# 真标题一", // 0
      "```", // 1 开围栏
      "# 假标题A", // 2
      "#无空格注释", // 3
      "```", // 4 闭围栏
      "~~~", // 5 开围栏（异符）
      "# 假标题B", // 6
      "~~~", // 7 闭围栏
      "# 真标题二", // 8
    ].join("\n");
    expect(extractOutline(doc)).toEqual([
      { level: 1, text: "真标题一", line: 0 },
      { level: 1, text: "真标题二", line: 8 },
    ]);
  });

  it("围栏内异符围栏行不闭合当前围栏", () => {
    // ~~~ 围栏里的 ``` 只是内容，不触发闭合
    const doc = ["~~~", "```", "# 假标题", "~~~", "# 真标题"].join("\n");
    expect(extractOutline(doc)).toEqual([{ level: 1, text: "真标题", line: 4 }]);
  });

  it("未闭合围栏持续生效到文档末尾", () => {
    const doc = ["# 真", "```ts", "# 假", "~~~", "# 还是假"].join("\n");
    expect(extractOutline(doc)).toEqual([{ level: 1, text: "真", line: 0 }]);
  });

  it("围栏闭合后恢复抽取，且围栏行的 === 不误判为 setext", () => {
    const doc = ["~~~", "x", "~~~", "==="].join("\n");
    expect(extractOutline(doc)).toEqual([]);
  });
});

describe("extractOutline · setext 标题", () => {
  it("H1（=====）与 H2（-----），行号取文本行", () => {
    const doc = ["一级标题", "=====", "正文", "二级标题", "-----", "正文"].join("\n");
    expect(extractOutline(doc)).toEqual([
      { level: 1, text: "一级标题", line: 0 },
      { level: 2, text: "二级标题", line: 3 },
    ]);
  });

  it("上一行为空 / ATX 标题 / 下划线时不误判", () => {
    expect(extractOutline(["# 标题", "==="].join("\n"))).toEqual([
      { level: 1, text: "标题", line: 0 },
    ]);
    expect(extractOutline(["标题", "=====", "-----"].join("\n"))).toEqual([
      { level: 1, text: "标题", line: 0 },
    ]);
    expect(extractOutline(["", "==="].join("\n"))).toEqual([]);
  });
});

describe("extractOutline · 边界与截断", () => {
  it("空文档返回空数组", () => {
    expect(extractOutline("")).toEqual([]);
    expect(extractOutline("\n\n\n")).toEqual([]);
    expect(extractOutline("   \n\t\n")).toEqual([]);
  });

  it("maxLines 截断：只扫描前 N 行", () => {
    const doc = ["# 第一", "正文", "# 第二", "# 第三"].join("\n");
    // 前 2 行只含「第一」；第 3 行（index 2）起才出现「第二」
    expect(extractOutline(doc, 2)).toEqual([{ level: 1, text: "第一", line: 0 }]);
    expect(extractOutline(doc, 3)).toEqual([
      { level: 1, text: "第一", line: 0 },
      { level: 1, text: "第二", line: 2 },
    ]);
  });

  it("max 截断：达到上限即停止", () => {
    const doc = Array.from({ length: 10 }, (_, i) => `## 标题${i}`).join("\n");
    const items = extractOutline(doc, 2000, 3);
    expect(items).toHaveLength(3);
    expect(items[2]).toEqual({ level: 2, text: "标题2", line: 2 });
  });

  it("默认参数 maxLines=2000 / max=500", () => {
    const doc = Array.from({ length: 600 }, (_, i) => `# 标题${i}`).join("\n");
    const items = extractOutline(doc);
    expect(items).toHaveLength(500);
    expect(items[0]).toEqual({ level: 1, text: "标题0", line: 0 });
    expect(items[499]).toEqual({ level: 1, text: "标题499", line: 499 });
  });

  it("CRLF 换行兼容", () => {
    const doc = "# 标题一\r\n正文\r\n## 标题二\r\n";
    expect(extractOutline(doc)).toEqual([
      { level: 1, text: "标题一", line: 0 },
      { level: 2, text: "标题二", line: 2 },
    ]);
  });
});

describe("extractOutline · 性能（100KB < 2ms）", () => {
  /** 用重复标题块构造 100KB 文档（约 1200 个标题 / 2400 行） */
  function bigDoc(targetKB: number): string {
    const block =
      "## 章节标题 100KB 性能回归用的重复标题块\n这是用于填充的正文内容，包含常见中文字符与标点符号，模拟真实笔记篇幅。\n";
    return block.repeat(Math.ceil((targetKB * 1024) / block.length));
  }

  it("100KB 文档全量抽取 < 2ms（3 倍余量防 CI 抖动）", () => {
    const doc = bigDoc(100);
    expect(doc.length).toBeGreaterThan(100 * 1024);
    // 预热 JIT；显式放大 maxLines/max，确保扫描覆盖整篇而非提前收尾
    for (let i = 0; i < 20; i++) extractOutline(doc, 1_000_000, 1_000_000);
    const t0 = performance.now();
    const items = extractOutline(doc, 1_000_000, 1_000_000);
    const elapsed = performance.now() - t0;
    expect(items.length).toBeGreaterThan(1000);
    expect(elapsed).toBeLessThan(6);
    console.log(
      `[outline] 100KB（${doc.length}B / ${items.length} 条标题）全量抽取 ${elapsed.toFixed(4)}ms`,
    );
  });
});

describe("OutlinePanel.svelte · 冒烟", () => {
  const items: OutlineItem[] = [
    { level: 1, text: "一级标题", line: 0 },
    { level: 2, text: "二级标题", line: 4 },
  ];

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("渲染条目、缩进、当前标题高亮，点击回调 onJump(line)", async () => {
    const jumps: number[] = [];
    const target = document.createElement("div");
    document.body.appendChild(target);
    mount(OutlinePanel, {
      target,
      props: { items, activeLine: 4, onJump: (l: number) => jumps.push(l) },
    });
    await tick();
    const rows = target.querySelectorAll<HTMLElement>(".ol-item");
    expect(rows).toHaveLength(2);
    // 缩进：level 1 → 9px，level 2 → 9+12=21px
    expect(rows[0].style.paddingLeft).toBe("9px");
    expect(rows[1].style.paddingLeft).toBe("21px");
    // activeLine=4 时第二行为当前标题（高亮类 on）
    expect(rows[0].classList.contains("on")).toBe(false);
    expect(rows[1].classList.contains("on")).toBe(true);
    rows[1].click();
    expect(jumps).toEqual([4]);
  });

  it("无 items 时显示空态「暂无标题」", async () => {
    const target = document.createElement("div");
    document.body.appendChild(target);
    mount(OutlinePanel, {
      target,
      props: { items: [], activeLine: -1, onJump: () => {} },
    });
    await tick();
    expect(target.querySelectorAll(".ol-item")).toHaveLength(0);
    expect(target.querySelector<HTMLElement>(".ol-empty")?.textContent).toBe("暂无标题");
  });
});
