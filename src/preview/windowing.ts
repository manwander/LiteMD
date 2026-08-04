// 视口窗口计算：用 Fenwick（树状数组）前缀和把 O(n) 总高 + 起止扫描降到 O(log²n)。
//
// 背景：VirtualPreview 每帧（滚动/缩放）都要根据 scrollTop 算出「视口上下各 prerenderMargin
// 像素」对应的块区间 [s, e) 以及上下占位高度。朴素实现是三段 O(n) 遍历（总高、找起点、找终点），
// 在 57 万块的 50MB 文档下每帧 3~6ms，是滚动掉帧的主要来源。
//
// 本模块是纯逻辑（不依赖 DOM），可单元测试；高度数组变化（块被实测校正）时增量 treeAdd。
//
// 约定：heights[i] = 第 i 块的有效高度（realHeights[i] || 估算值）。
//   prefix(k) = Σ_{i<k} heights[i]，k∈[0, n]，prefix(0)=0，prefix(n)=总高。

export class HeightPrefixSum {
  private tree: Float64Array;
  private n: number;

  /** 用高度数组构造并一次性建树，O(n)。 */
  constructor(heights: ArrayLike<number>) {
    this.n = heights.length;
    this.tree = new Float64Array(this.n + 1);
    for (let i = 0; i < this.n; i++) {
      const v = heights[i];
      let idx = i + 1;
      while (idx <= this.n) {
        this.tree[idx] += v;
        idx += idx & -idx;
      }
    }
  }

  /** 第 i 块高度变化 delta 时增量更新，O(log n)。 */
  add(i: number, delta: number): void {
    if (delta === 0 || i < 0 || i >= this.n) return;
    let idx = i + 1;
    while (idx <= this.n) {
      this.tree[idx] += delta;
      idx += idx & -idx;
    }
  }

  /** 前缀和 prefix(k) = Σ_{i<k} heights[i]。 */
  prefix(k: number): number {
    let s = 0;
    while (k > 0) {
      s += this.tree[k];
      k -= k & -k;
    }
    return s;
  }

  /** 总高度 = prefix(n)。 */
  get total(): number {
    return this.prefix(this.n);
  }

  /**
   * 第一个满足 prefix(s+1) > lo 的 s（可视起点上边界），并附带 acc = prefix(s)。
   * 等价于：累计高度（含第 s 块）首次越过 lo 的块索引。
   * 返回 s 可能等于 n（scrollTop 超出底部，理论不会发生）。
   */
  findStart(lo: number): { s: number; acc: number } {
    let a = 0;
    let b = this.n;
    while (a < b) {
      const mid = (a + b) >> 1;
      if (this.prefix(mid + 1) > lo) b = mid;
      else a = mid + 1;
    }
    return { s: a, acc: this.prefix(a) };
  }

  /**
   * 第一个满足 prefix(e) > hi 的 e（可视终点下边界），并附带 accE = prefix(e)。
   * 在 [fromS, n] 区间内二分（prefix 单调不减且 prefix(fromS) <= hi，区间有效）。
   * 返回 e 可能等于 n（可视区越过底部，bottomPad = 0）。
   */
  findEnd(fromS: number, hi: number): { e: number; accE: number } {
    let a = fromS;
    let b = this.n;
    while (a < b) {
      const mid = (a + b) >> 1;
      if (this.prefix(mid) > hi) b = mid;
      else a = mid + 1;
    }
    return { e: a, accE: this.prefix(a) };
  }
}

export interface WindowResult {
  s: number;
  e: number;
  topPad: number;
  bottomPad: number;
}

// ---- 超高文档比例映射（P2-3）----
// Chromium 对单滚动容器/单元素高度有硬上限（实测约 33.5M px），超过后
// scrollHeight 被截断 → 滚动条失真、文档底部不可达。总高 > MAX_TOTAL_PX 时
// 启用线性偏移映射：虚拟空间高度 V 映射到 DOM 高度 D = k·V（k = LIMIT/V_total），
// 窗口计算在虚拟空间进行，占位高度乘 k 写回 DOM；可见块本身保持自然高度，
// 误差仅 O(视口)·(1/k - 1)，滚动单调可达底，代价可忽略。
export const MAX_TOTAL_PX = 24_000_000;

/** 总高 → 映射比例；不超限返回 1（常规文档零开销） */
export function heightScale(total: number): number {
  return total > MAX_TOTAL_PX ? MAX_TOTAL_PX / total : 1;
}

/**
 * 根据 scrollTop 与视口几何算出可视块区间与占位高度。
 * 与 VirtualPreview.updateVisibleWindow 的旧 O(n) 三段遍历逐字节等价（已单测对拍）。
 *
 * @param hps      Fenwick 前缀和实例
 * @param top      container.scrollTop
 * @param loffset  向上预读像素（prerenderMargin）
 * @param viewport 容器可视高度（clientHeight）
 * @param roffset  向下预读像素（prerenderMargin）
 */
export function computeWindow(
  hps: HeightPrefixSum,
  top: number,
  loffset: number,
  viewport: number,
  roffset: number,
): WindowResult {
  const lo = top - loffset;
  const hi = top + viewport + roffset;
  const { s, acc } = hps.findStart(lo);
  const { e, accE } = hps.findEnd(s, hi);
  const total = hps.total;
  return {
    s,
    e,
    topPad: acc,
    bottomPad: Math.max(0, total - accE),
  };
}
