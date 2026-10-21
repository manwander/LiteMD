/**
 * 顶层块增量切块单元测试 —— 对应清单 PV-020、矩阵 PV-020-01/02。
 *
 * block-splitter 的 splitIntoBlocks/hashRange/estimateBlockHeight 为纯函数（不依赖 DOM，
 * md 形参当前未使用），此前零测试（D-DOC-3）。本文件覆盖：空/纯白短路、按空行切块、
 * 围栏内空行不误切、恒等内容 O(1) 短路、区间哈希不变式、估高单调。
 * 每例先 clearSplitCache() 隔离模块级 lastSplit/段缓存。
 */
import { describe, it, expect, beforeEach } from "vitest";
import MarkdownIt from "markdown-it";
import {
  splitIntoBlocks,
  clearSplitCache,
  resetLastSplit,
  hashRange,
  estimateBlockHeight,
  collectRefDefs,
  renderBlock,
} from "../preview/block-splitter";

describe("splitIntoBlocks 结构切分", () => {
  beforeEach(() => clearSplitCache());

  it("空串 → 无块", () => {
    expect(splitIntoBlocks(null, "")).toEqual([]);
  });
  it("纯空白 → 无块", () => {
    expect(splitIntoBlocks(null, "   \n\t \n  ")).toEqual([]);
  });
  it("两个以空行分隔的块 → 2 块，首块从 0 起", () => {
    const src = "# 标题\n\n正文段落";
    const blocks = splitIntoBlocks(null, src);
    expect(blocks.length).toBe(2);
    expect(blocks[0].srcBegin).toBe(0);
    // 块区间按序不重叠、均落在 [0, len] 内
    for (let i = 0; i < blocks.length; i++) {
      expect(blocks[i].srcEnd).toBeGreaterThan(blocks[i].srcBegin);
      if (i > 0) expect(blocks[i].srcBegin).toBeGreaterThanOrEqual(blocks[i - 1].srcEnd);
    }
    expect(blocks[blocks.length - 1].srcEnd).toBeLessThanOrEqual(src.length);
  });
  it("围栏代码块内的空行不得被切成两块（PV-020）", () => {
    const src = "```py\nx = 1\n\ny = 2\n```";
    const blocks = splitIntoBlocks(null, src);
    expect(blocks.length).toBe(1);
    expect(blocks[0].srcBegin).toBe(0);
    expect(blocks[0].srcEnd).toBe(src.length);
  });
  it("恒等内容二次调用走 O(1) 短路，结果块区间一致", () => {
    const src = "段落一\n\n段落二\n\n段落三";
    const b1 = splitIntoBlocks(null, src).map((b) => [b.srcBegin, b.srcEnd, b.hash]);
    resetLastSplit();
    const b2 = splitIntoBlocks(null, src).map((b) => [b.srcBegin, b.srcEnd, b.hash]);
    // 先建立 lastSplit 再恒等调用
    const b3 = splitIntoBlocks(null, src).map((b) => [b.srcBegin, b.srcEnd, b.hash]);
    expect(b3).toEqual(b2);
    expect(b1).toEqual(b2);
  });
  it("estimateBlockHeight 为正且随行数增大不减", () => {
    const one = "只有\n一行";
    const many = Array.from({ length: 40 }, (_, i) => `第${i}行`).join("\n");
    const bOne = splitIntoBlocks(null, one)[0];
    const bMany = splitIntoBlocks(null, many)[0];
    const h1 = estimateBlockHeight(bOne, one);
    const h2 = estimateBlockHeight(bMany, many);
    expect(h1).toBeGreaterThan(0);
    expect(h2).toBeGreaterThan(h1);
  });
});

describe("松散列表 / 引用的容器合并（与整篇渲染语义对齐）", () => {
  beforeEach(() => clearSplitCache());

  it("松散无序列表（项间空行）合并为同一块", () => {
    const src = "- 一\n\n- 二\n\n- 三";
    const blocks = splitIntoBlocks(null, src);
    expect(blocks.length).toBe(1);
    expect(blocks[0].srcBegin).toBe(0);
    expect(blocks[0].srcEnd).toBe(src.length);
  });

  it("松散有序列表同样合并", () => {
    expect(splitIntoBlocks(null, "1. 一\n\n2. 二").length).toBe(1);
  });

  it("列表项续段（空行后缩进 ≥2）并入上一列表块", () => {
    expect(splitIntoBlocks(null, "- 项\n\n  续段说明").length).toBe(1);
  });

  it("不同列表类型不被误合并", () => {
    expect(splitIntoBlocks(null, "1. 有序\n\n- 无序").length).toBe(2);
  });

  it("列表后的普通段落仍独立成块", () => {
    expect(splitIntoBlocks(null, "- 项\n\n普通段落").length).toBe(2);
  });

  it("引用间的空行合并为同一块", () => {
    expect(splitIntoBlocks(null, "> 一\n\n> 二").length).toBe(1);
  });

  it("引用后的普通段落仍独立成块", () => {
    expect(splitIntoBlocks(null, "> 引用\n\n段落").length).toBe(2);
  });
});

describe("collectRefDefs 引用定义收集", () => {
  it("收集常见形式的引用定义", () => {
    const src = '[a]: https://a.example\n[b]: <https://b.example> "标题"\n[c]: /rel (t)';
    expect(collectRefDefs(src)).toEqual([
      "[a]: https://a.example",
      '[b]: <https://b.example> "标题"',
      "[c]: /rel (t)",
    ]);
  });

  it("围栏代码块内形似定义的文本不收集", () => {
    const src = "```\n[a]: https://evil.example\n```\n\n[a]: https://good.example";
    expect(collectRefDefs(src)).toEqual(["[a]: https://good.example"]);
  });

  it("普通文本与非法定义不收集", () => {
    const src = "这不是定义\n[key]: \n[]: https://x\n[ok]: https://ok.example";
    expect(collectRefDefs(src)).toEqual(["[ok]: https://ok.example"]);
  });

  it("无 ]: 的文档快速返回空数组", () => {
    expect(collectRefDefs("# 标题\n\n正文")).toEqual([]);
  });
});

describe("renderBlock 引用定义上下文补齐", () => {
  // 与应用内配置一致：html:true 时原始 HTML 会透传，最终必须由 sanitize 收口
  const md = new MarkdownIt({ html: true });

  it("定义与引用不在同一块时，补 defs 后链接可正确解析", () => {
    clearSplitCache();
    const src = "见 [链接][ref]。\n\n其它段落。\n\n[ref]: https://example.com";
    const blocks = splitIntoBlocks(md, src);
    const defs = collectRefDefs(src).join("\n");
    expect(defs).toContain("[ref]: https://example.com");

    const withDefs = renderBlock(md, src, blocks[0], defs);
    expect(withDefs).toContain('href="https://example.com"');

    // 不补 defs 时引用退化为纯文本（证明补齐是必要的）
    const withoutDefs = renderBlock(md, src, blocks[0]);
    expect(withoutDefs).not.toContain('href="https://example.com"');
  });

  it("块内脚本经 renderBlock 渲染后仍被清洗（C-01 最后一步）", () => {
    clearSplitCache();
    const src = '<img src="x" onerror="alert(1)">';
    const blocks = splitIntoBlocks(md, src);
    const html = renderBlock(md, src, blocks[0]);
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("alert(1)");
  });
});

describe("增量快速路径 splitFast 行边界（W6 回归）", () => {
  beforeEach(() => clearSplitCache());

  /** 建立 lastSplit 后，用 edits 走快速路径；再冷启动走全量路径，二者必须等价 */
  function expectFastEqualsFull(oldSrc: string, newSrc: string, edit: { from: number; to: number; insert: number }) {
    clearSplitCache();
    splitIntoBlocks(null, oldSrc);
    const fast = splitIntoBlocks(null, newSrc, edit);
    clearSplitCache();
    const full = splitIntoBlocks(null, newSrc);
    const norm = (bs: ReturnType<typeof splitIntoBlocks>) =>
      bs.map((b) => [b.srcBegin, b.srcEnd, b.type, b.preview]);
    expect(norm(fast)).toEqual(norm(full));
    return fast;
  }

  it("删除换行合并两行：块不得从半行开始（旧实现会丢掉行首字符）", () => {
    // "a\n b\nc" 删掉第一个换行 → "a b\nc"
    const fast = expectFastEqualsFull("a\n b\nc", "a b\nc", { from: 1, to: 2, insert: 0 });
    expect(fast[0].srcBegin).toBe(0);
    for (const b of fast) {
      expect(b.srcBegin === 0 || "a b\nc".charCodeAt(b.srcBegin - 1) === 10).toBe(true);
    }
  });

  it("换行替换为普通字符（跨行内容被合并）", () => {
    const fast = expectFastEqualsFull("a\nb\nc", "axb\nc", { from: 1, to: 2, insert: 1 });
    expect(fast[0].srcBegin).toBe(0);
  });

  it("跨多行删除后接尾行", () => {
    expectFastEqualsFull("a\nb\nc", "ac", { from: 1, to: 4, insert: 0 });
    expectFastEqualsFull("a\nb\nc", "aX\nY\nZb\nc", { from: 1, to: 2, insert: 5 });
  });

  it("行首插入多行内容", () => {
    expectFastEqualsFull("a\nb", "x\ny\na\nb", { from: 0, to: 0, insert: 4 });
  });
});

describe("hashRange 内容键不变式", () => {
  it("同一区间多次哈希稳定", () => {
    const s = "abcdefgh";
    expect(hashRange(s, 0, 8)).toBe(hashRange(s, 0, 8));
  });
  it("内容不同 → 哈希不同", () => {
    const a = hashRange("hello world", 0, 11);
    const b = hashRange("hello worlD", 0, 11);
    expect(a).not.toBe(b);
  });
  it("长度不同 → 哈希不同（长度后缀参与）", () => {
    const s = "aaaa";
    expect(hashRange(s, 0, 3)).not.toBe(hashRange(s, 0, 4));
  });
  it("等值切片 → 等值哈希（内容键与绝对位置无关）", () => {
    const s = "xyzabc xyzabc "; // 长度 14：前 7 与后 7 均为 "xyzabc "
    expect(s.length).toBe(14);
    expect(hashRange(s, 0, 7)).toBe(hashRange(s, 7, 14));
  });
});
