/**
 * 窗口计算（Fenwick 前缀和）单元测试 —— 对应清单 PV-022、矩阵 PV-022-01。
 *
 * windowing.ts:110 原注释「与旧 O(n) 三段遍历逐字节等价（已单测对拍）」此前并无实现，
 * 本文件即为该「对拍」：用朴素 O(n) 前缀和扫描作为参考实现，随机用例逐一对齐
 * HeightPrefixSum / computeWindow 的输出，坐实该声明（D-DOC-3）。
 */
import { describe, it, expect } from "vitest";
import {
  HeightPrefixSum,
  computeWindow,
  heightScale,
  MAX_TOTAL_PX,
} from "../preview/windowing";

/** 朴素参考：完整前缀和 + 线性扫描，语义与 findStart/findEnd 一致 */
function naiveWindow(
  heights: number[],
  top: number,
  lo: number,
  vp: number,
  ro: number,
) {
  const n = heights.length;
  const pref = [0];
  for (const h of heights) pref.push(pref[pref.length - 1] + h);
  const total = pref[n];
  const loPix = top - lo;
  const hiPix = top + vp + ro;
  let s = 0;
  while (s < n && !(pref[s + 1] > loPix)) s++;
  let e = s;
  while (e < n && !(pref[e] > hiPix)) e++;
  return { s, e, topPad: pref[s], bottomPad: Math.max(0, total - pref[e]) };
}

describe("HeightPrefixSum 前缀和 / 增量", () => {
  it("prefix 与 total 正确", () => {
    const h = new HeightPrefixSum([10, 20, 30]);
    expect(h.prefix(0)).toBe(0);
    expect(h.prefix(1)).toBe(10);
    expect(h.prefix(2)).toBe(30);
    expect(h.prefix(3)).toBe(60);
    expect(h.total).toBe(60);
  });
  it("add 增量更新反映到后续 prefix / total", () => {
    const h = new HeightPrefixSum([10, 20, 30]);
    h.add(1, 5); // 第 2 块 20→25
    expect(h.prefix(2)).toBe(35);
    expect(h.total).toBe(65);
    h.add(0, -10);
    expect(h.prefix(1)).toBe(0);
  });
  it("findStart / findEnd 单调语义", () => {
    const h = new HeightPrefixSum([100, 100, 100, 100, 100]);
    // 累计首次 >25 落在第 1 块(index0，其末 100>25)，acc=prefix(0)=0
    expect(h.findStart(25)).toEqual({ s: 0, acc: 0 });
    // 累计首次 >150 落在第 2 块(index1，其末 200>150)，acc=prefix(1)=100
    expect(h.findStart(150)).toEqual({ s: 1, acc: 100 });
    expect(h.findEnd(1, 250)).toEqual({ e: 3, accE: 300 }); // prefix(e)首次>250
  });
});

describe("computeWindow 与朴素实现在随机数据上逐字节对拍", () => {
  it("100 组随机用例结果一致", () => {
    let seed = 123456789;
    const rnd = (m: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % m;
    };
    for (let t = 0; t < 100; t++) {
      const n = 1 + rnd(50);
      const heights = Array.from({ length: n }, () => 1 + rnd(400));
      const top = rnd(heights.reduce((a, b) => a + b, 0));
      const lo = rnd(200);
      const vp = 100 + rnd(900);
      const ro = rnd(200);
      const hps = new HeightPrefixSum(heights);
      const got = computeWindow(hps, top, lo, vp, ro);
      const exp = naiveWindow(heights, top, lo, vp, ro);
      expect(got).toEqual(exp);
    }
  });
});

describe("heightScale 超高文档比例映射", () => {
  it("不超限返回 1", () => {
    expect(heightScale(MAX_TOTAL_PX)).toBe(1);
    expect(heightScale(MAX_TOTAL_PX - 1)).toBe(1);
  });
  it("超限按比例压缩（48M → 0.5）", () => {
    expect(heightScale(MAX_TOTAL_PX * 2)).toBeCloseTo(0.5, 10);
    expect(heightScale(MAX_TOTAL_PX * 2) * MAX_TOTAL_PX * 2).toBeLessThanOrEqual(MAX_TOTAL_PX + 1e-6);
  });
});
