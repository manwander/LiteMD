/**
 * 顶层块增量切块单元测试 —— 对应清单 PV-020、矩阵 PV-020-01/02。
 *
 * block-splitter 的 splitIntoBlocks/hashRange/estimateBlockHeight 为纯函数（不依赖 DOM，
 * md 形参当前未使用），此前零测试（D-DOC-3）。本文件覆盖：空/纯白短路、按空行切块、
 * 围栏内空行不误切、恒等内容 O(1) 短路、区间哈希不变式、估高单调。
 * 每例先 clearSplitCache() 隔离模块级 lastSplit/段缓存。
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  splitIntoBlocks,
  clearSplitCache,
  resetLastSplit,
  hashRange,
  estimateBlockHeight,
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
