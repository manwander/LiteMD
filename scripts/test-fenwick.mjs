// Fenwick 前缀和视口窗口单元测试：校验 src/preview/windowing.ts 的 computeWindow
// 与 VirtualPreview 原 O(n) 三段遍历（朴素参考）逐字节等价；并校验增量 add 后一致性。
// 用 esbuild 把 TS 转译成 ESM 后动态导入（无需 DOM）。
import { build } from "esbuild";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const out = join(mkdtempSync(join(tmpdir(), "fenw-")), "windowing.mjs");
await build({
  entryPoints: ["src/preview/windowing.ts"],
  outfile: out,
  bundle: false,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const { HeightPrefixSum, computeWindow, heightScale, MAX_TOTAL_PX } = await import(pathToFileURL(out).href);

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) passed++;
  else {
    failed++;
    if (failed <= 10) console.error("FAIL:", msg);
  }
}

// 朴素参考：严格复刻原 updateVisibleWindow 的三段遍历
function brute(heights, top, margin, vh) {
  const n = heights.length;
  let total = 0;
  for (let i = 0; i < n; i++) total += heights[i];
  const lo = top - margin;
  const hi = top + vh + margin;
  let acc = 0,
    s = 0;
  for (; s < n; s++) {
    const h = heights[s];
    if (acc + h > lo) break;
    acc += h;
  }
  let e = s,
    accE = acc;
  for (; e < n; e++) {
    if (accE > hi) break;
    accE += heights[e];
  }
  return { s, e, topPad: acc, bottomPad: Math.max(0, total - accE) };
}

function randHeights(n, min, max) {
  const a = new Array(n);
  for (let i = 0; i < n; i++) a[i] = min + Math.floor(Math.random() * (max - min + 1));
  return a;
}

function checkCase(heights, top, margin, vh, label) {
  const got = computeWindow(new HeightPrefixSum(heights), top, margin, vh, margin);
  const exp = brute(heights, top, margin, vh);
  assert(
    got.s === exp.s && got.e === exp.e && got.topPad === exp.topPad && got.bottomPad === exp.bottomPad,
    `${label}: got s=${got.s} e=${got.e} top=${got.topPad} bot=${got.bottomPad} | exp s=${exp.s} e=${exp.e} top=${exp.topPad} bot=${exp.bottomPad}`,
  );
}

// 1) 小文档
for (let t = 0; t < 5000; t++) {
  const n = 1 + Math.floor(Math.random() * 200);
  const h = randHeights(n, 10, 400);
  const vh = 300 + Math.floor(Math.random() * 1200);
  const margin = Math.floor(Math.random() * 1500);
  const top = Math.floor(Math.random() * (h.reduce((a, b) => a + b, 0) + 1));
  checkCase(h, top, margin, vh, `small t=${t}`);
}

// 2) 50MB 量级：大量小高度块（如 57 万块，每块 20~40px，模拟纯文本）
const BIG = 570000;
const bigH = randHeights(BIG, 20, 40);
const bigTotal = bigH.reduce((a, b) => a + b, 0);
for (let t = 0; t < 30; t++) {
  const top = Math.floor(Math.random() * (bigTotal + 1));
  checkCase(bigH, top, 800, 900, `big t=${t}`);
}

// 3) 增量 add 后一致性：构造树 → 随机修改若干块高度 → 增量 add → 与重建树+brute 对拍
{
  const n = 50000;
  let h = randHeights(n, 15, 500);
  const tree = new HeightPrefixSum(h);
  for (let k = 0; k < 3000; k++) {
    const i = Math.floor(Math.random() * n);
    const old = h[i];
    const nv = 15 + Math.floor(Math.random() * 500);
    h[i] = nv;
    tree.add(i, nv - old);
  }
  for (let t = 0; t < 100; t++) {
    const top = Math.floor(Math.random() * (h.reduce((a, b) => a + b, 0) + 1));
    checkCase(h, top, 800, 900, `incremental t=${t}`);
  }
}

// 4) 极端：全 0 高度（避免除零/死循环）
{
  const z = new Array(1000).fill(0);
  checkCase(z, 0, 800, 900, "all-zero");
  checkCase(z, 5000, 800, 900, "all-zero-scrolled");
}

// 5) 单块
checkCase([123], 0, 800, 900, "single");
checkCase([123], 9999, 800, 900, "single-scrolled");

// 6) 超高文档比例映射 heightScale（P2-3）
{
  assert(heightScale(0) === 1, "scale(0)=1");
  assert(heightScale(1000) === 1, "scale 小文档=1");
  assert(heightScale(MAX_TOTAL_PX) === 1, "scale 临界值=1");
  const over = MAX_TOTAL_PX + 1;
  assert(Math.abs(heightScale(over) - MAX_TOTAL_PX / over) < 1e-12, "scale 超限=LIMIT/total");
  assert(Math.abs(heightScale(2 * MAX_TOTAL_PX) - 0.5) < 1e-12, "scale 2x=0.5");

  // 映射后 DOM 总高不超限：随机超高文档，任意 scrollTop 下
  // k*(topPad+bottomPad) + 可见块自然高 ≤ LIMIT + O(视口)
  const n = 60000;
  const h = new Array(n);
  for (let i = 0; i < n; i++) h[i] = 900 + Math.floor(Math.random() * 400); // 总高 ≈ 66M > LIMIT
  const tree = new HeightPrefixSum(h);
  const total = tree.total;
  assert(total > MAX_TOTAL_PX, "fixture 总高需超限");
  const k = heightScale(total);
  const margin = 800;
  const vh = 900;
  for (let t = 0; t < 200; t++) {
    const V = Math.random() * total; // 虚拟偏移
    const scrollTop = V * k;         // DOM 偏移
    const win = computeWindow(tree, scrollTop / k, margin / k, vh / k, margin / k);
    assert(win.s >= 0 && win.e <= n && win.s <= win.e, `mapped window 合法 t=${t}`);
    const visibleNat = h.slice(win.s, win.e).reduce((a, b) => a + b, 0);
    const domTotal = k * (win.topPad + win.bottomPad) + visibleNat;
    assert(domTotal <= MAX_TOTAL_PX + visibleNat + 2, `mapped DOM 总高封顶 t=${t}`);
    // 窗口覆盖虚拟视口：prefix(s) ≤ V+margin/k 且 prefix(e) ≥ V+vh/k（除非到底）
    const ps = tree.prefix(win.s);
    assert(ps <= V + margin / k + 1e-6, `mapped 起点覆盖 t=${t}`);
    const pe = tree.prefix(win.e);
    assert(win.e === n || pe >= V + vh / k, `mapped 终点覆盖 t=${t}`);
  }
}

console.log(`Fenwick windowing: passed=${passed} failed=${failed}`);
if (failed > 0) process.exit(1);
