// P1-7 低端模式降级矩阵单测：纯逻辑（buildDegrade / resolveLowEnd），不依赖 DOM。
// esbuild 转译 src/lowend.ts → 临时 mjs → 动态 import。
import { build, stop } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const src = "C:/Users/manwa/Desktop/LiteMD/src/lowend.ts";
const out = join(mkdtempSync(join(tmpdir(), "lowend-")), "lowend.mjs");

await build({
  entryPoints: [src],
  bundle: true,
  format: "esm",
  platform: "neutral",
  outfile: out,
  logLevel: "silent",
});

const mod = await import(pathToFileURL(out).href);
const { buildDegrade, resolveLowEnd, LOW_END_PREVIEW_MAX_KB } = mod;

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; } else { fail++; console.error("  ✗ " + msg); }
}

// resolveLowEnd 的 on/off 短路（不触碰 detectLowEnd / DOM）
assert(resolveLowEnd("on") === true, "resolveLowEnd('on') === true");
assert(resolveLowEnd("off") === false, "resolveLowEnd('off') === false");

// 标准矩阵
const s = buildDegrade(false);
assert(s.previewRealtimeMaxKB === 2048, "standard previewRealtimeMaxKB=2048");
assert(s.manualRefreshMax === 8 << 20, "standard manualRefreshMax=8MB");
assert(s.prerenderMargin === 800, "standard prerenderMargin=800");
assert(s.renderBudgetPerFrame === 8, "standard renderBudgetPerFrame=8");
assert(s.idlePrerenderScreens === 2, "standard idlePrerenderScreens=2");
assert(s.maxCacheEntries === 20000, "standard maxCacheEntries=20000");
assert(s.imageMaxEdge === 2560, "standard imageMaxEdge=2560");
assert(s.webpQuality === 0.82, "standard webpQuality=0.82");
assert(s.useWillChange === true, "standard useWillChange=true");
assert(s.useBackdrop === true, "standard useBackdrop=true");

// 低端矩阵
const l = buildDegrade(true);
assert(l.previewRealtimeMaxKB === 512, "low-end previewRealtimeMaxKB=512");
assert(l.manualRefreshMax === 2 << 20, "low-end manualRefreshMax=2MB");
assert(l.prerenderMargin === 300, "low-end prerenderMargin=300");
assert(l.renderBudgetPerFrame === 3, "low-end renderBudgetPerFrame=3");
assert(l.idlePrerenderScreens === 0, "low-end idlePrerenderScreens=0");
assert(l.maxCacheEntries === 3000, "low-end maxCacheEntries=3000");
assert(l.imageMaxEdge === 1600, "low-end imageMaxEdge=1600");
assert(l.webpQuality === 0.72, "low-end webpQuality=0.72");
assert(l.useWillChange === false, "low-end useWillChange=false");
assert(l.useBackdrop === false, "low-end useBackdrop=false");

// 两矩阵确实不同（降级生效）
assert(JSON.stringify(s) !== JSON.stringify(l), "standard ≠ low-end matrix");

// 不可变性：返回的是拷贝，互不影响
const s2 = buildDegrade(false);
s2.maxCacheEntries = -1;
assert(buildDegrade(false).maxCacheEntries === 20000, "buildDegrade 返回独立拷贝（不可变）");

// 低端预览封顶常量与矩阵一致
assert(LOW_END_PREVIEW_MAX_KB === 512, "LOW_END_PREVIEW_MAX_KB=512");

console.log(`\nlowend 矩阵单测：${pass} 通过 / ${fail} 失败`);
await stop?.();
if (fail > 0) process.exit(1);
