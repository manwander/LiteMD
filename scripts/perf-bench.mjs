// 性能基准脚本（第二轮：超大文档专项）
// 用法：node --experimental-strip-types scripts/perf-bench.mjs
//
// 直接 import 真实的 src/preview/block-splitter.ts，与应用预览管线同路径。
// 测量项：
//   1. splitIntoBlocks 全量切块（含分类与预览摘要）
//   2. hashRange 全文逐块哈希（VirtualPreview rebuild 同算法）
//   3. estimateBlockHeight 逐块高度估算
//   4. 全流程 rebuild（切块 + 哈希 + 估算）
//   5. 增量模拟：单行编辑后重切，报告段级缓存命中情况（若已启用）
//
// 纪律：每次改动预览管线前后都跑一遍，对比保留或回滚。
import { splitIntoBlocks, getSplitCacheStats, clearSplitCache, resetLastSplit, hashRange, estimateBlockHeight } from "../src/preview/block-splitter.ts";
import { performance } from "node:perf_hooks";

// ---------------- 测试文档生成 ----------------

const PARAGRAPH =
  "这是一段用于性能基准测试的正文文本，包含中文、English 混排、数字 12345 与标点符号，" +
  "用来模拟真实笔记文档的段落结构。The quick brown fox jumps over the lazy dog. ";

const CODE_SAMPLE = [
  "function fib(n) {",
  "  if (n < 2) return n;",
  "  let a = 0, b = 1;",
  "  for (let i = 2; i <= n; i++) { const t = a + b; a = b; b = t; }",
  "  return b;",
  "}",
].join("\n");

const TABLE_SAMPLE = [
  "| 列一 | 列二 | 列三 |",
  "| --- | --- | --- |",
  "| 数据 | 数据 | 数据 |",
  "| 备注 | 备注 | 备注 |",
].join("\n");

/**
 * 生成约 targetBytes 大小的 Markdown 文档。
 * 结构：多级标题 + 段落 + 围栏代码 + 表格 + 链接文本（覆盖各类块分类路径）。
 */
function makeDoc(targetBytes) {
  const parts = ["# 超大文档性能基准", ""];
  let size = parts[0].length + 1;
  let i = 0;
  const blockCycles = [
    () => PARAGRAPH.repeat(2).trim(),
    () => "## 小节标题 " + i,
    () => PARAGRAPH.trim(),
    () => "- 列表项 A\n- 列表项 B\n- 列表项 C",
    () => "> 引用内容：" + PARAGRAPH.slice(0, 40),
    () => "```js\n" + CODE_SAMPLE + "\n```",
    () => PARAGRAPH.trim() + " 参考 https://example.com/docs 与 user@example.com",
    () => TABLE_SAMPLE,
    () => "### 子标题 " + i + "\n\n" + PARAGRAPH.trim(),
  ];
  while (size < targetBytes) {
    const text = blockCycles[i % blockCycles.length]();
    parts.push(text, "");
    size += text.length + 1;
    i++;
  }
  return parts.join("\n");
}

function bench(label, fn, minRuns = 3) {
  // 预热
  fn();
  const times = [];
  for (let r = 0; r < minRuns; r++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const best = times[0].toFixed(1);
  const med = times[Math.floor(times.length / 2)].toFixed(1);
  console.log(`  ${label.padEnd(52)} best ${best}ms / median ${med}ms`);
  return times[0];
}

// 与 VirtualPreview 相同的双路哈希（直接用 block-splitter 的 hashRange）
function hashAllBlocks(src, blocks) {
  const keys = new Array(blocks.length);
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    keys[i] = hashRange(src, b.srcBegin, b.srcEnd);
  }
  return keys;
}

function estimateAll(src, blocks) {
  const hs = new Array(blocks.length);
  for (let i = 0; i < blocks.length; i++) {
    hs[i] = estimateBlockHeight(blocks[i], src);
  }
  return hs;
}

function pipelineOnce(src) {
  resetLastSplit(); // 避免恒等短路，段缓存保持热（真实场景：停顿后推送新 source）
  const blocks = splitIntoBlocks(null, src);
  const keys = hashAllBlocks(src, blocks);
  const hs = estimateAll(src, blocks);
  return { blocks, keys, hs };
}

// 第三轮管线（当前实现）：切块时一并产出 hash/estH，VP rebuild 只 O(1) 读取，
// 免除两次全文遍历。模拟 VP 的读取路径。
function pipelineOnceV3(src) {
  resetLastSplit();
  const blocks = splitIntoBlocks(null, src);
  let acc = 0;
  for (let i = 0; i < blocks.length; i++) acc += blocks[i].estH + blocks[i].hash.length;
  return acc;
}

// ---------------- 主流程 ----------------

console.log("=== LiteMD perf-bench（第二轮 · 超大文档专项） ===\n");

const TIERS = [
  ["200KB", 200 * 1024],
  ["500KB", 500 * 1024],
  ["1MB", 1024 * 1024],
  ["2MB", 2 * 1024 * 1024],
  ["5MB", 5 * 1024 * 1024],
  // 极端场景：验收标准「20MB 文档打开：编辑器可用 < 1s，预览不阻塞首帧」。
  // 应用内 20MB > 默认实时预览阈值（2048KB），首帧走 P1-4 降级（预览零成本，手动刷新才付）；
  // 此处仍测全流程作为「手动刷新一次性成本」上界，并额外测一次性开销（对应打开文件首帧）。
  ["20MB", 20 * 1024 * 1024],
];

const results = {};

for (const [name, bytes] of TIERS) {
  const src = makeDoc(bytes);
  console.log(`[${name}] 实际 ${(src.length / 1024).toFixed(0)}KB / ${src.split("\n").length} 行`);
  let blocks;
  bench("splitIntoBlocks 全量切块", () => {
    resetLastSplit(); // 避免恒等短路
    blocks = splitIntoBlocks(null, src);
  }, 5);
  console.log(`    块数: ${blocks.length}，缓存: ${getSplitCacheStats()}`);
  bench("hashRange 逐块哈希", () => hashAllBlocks(src, blocks), 5);
  bench("estimateBlockHeight 逐块估算", () => estimateAll(src, blocks), 5);
  results[name] = bench("全流程 rebuild（切块+哈希+估算）", () => pipelineOnce(src), 5);
  results[name + "_v3"] = bench("全流程 rebuild V3（切块含哈希+估算）", () => pipelineOnceV3(src), 5);

  // 增量模拟：改中间一行后重切
  const mid = Math.floor(src.length / 2);
  const nl = src.indexOf("\n", mid);
  const edited = src.slice(0, nl) + "x" + src.slice(nl);
  // 预热缓存（第一次全切）
  splitIntoBlocks(null, src);
  const t0 = performance.now();
  const b2 = splitIntoBlocks(null, edited);
  const dt = (performance.now() - t0).toFixed(1);
  const same = b2.length === blocks.length;
  console.log(`    单行编辑后增量重切（段缓存路径）: ${dt}ms（块数${same ? "不变" : "变化"}），缓存: ${getSplitCacheStats()}`);

  // 打字停顿真实路径：带脏区间（EditRange）的增量管线，src ↔ edited 乒乓避免恒等短路
  {
    const editFwd = { from: nl, to: nl, insert: 1 };
    const editBack = { from: nl, to: nl + 1, insert: 0 };
    splitIntoBlocks(null, src);
    let fwd = true;
    const RUNS = 21;
    const times = [];
    for (let r = 0; r < RUNS; r++) {
      const t1 = performance.now();
      if (fwd) splitIntoBlocks(null, edited, editFwd);
      else splitIntoBlocks(null, src, editBack);
      times.push(performance.now() - t1);
      fwd = !fwd;
    }
    times.shift(); // 丢弃首次（含可能的缓存预热）
    times.sort((a, b) => a - b);
    console.log(`    打字增量管线（脏区间快速路径）: best ${times[0].toFixed(2)}ms / median ${times[Math.floor(times.length / 2)].toFixed(2)}ms`);
  }

  if (name === "20MB") {
    // 打开文件首帧的一次性开销：全文切块 + 逐块哈希（清空段缓存，真正冷启动）
    clearSplitCache();
    const t1 = performance.now();
    const bOpen = splitIntoBlocks(null, src);
    const tSplit = performance.now() - t1;
    const t2 = performance.now();
    hashAllBlocks(src, bOpen);
    const tHash = performance.now() - t2;
    console.log(`    打开场景（冷缓存一次性）: 切块 ${tSplit.toFixed(1)}ms + 哈希 ${tHash.toFixed(1)}ms = 共 ${(tSplit + tHash).toFixed(1)}ms，块数 ${bOpen.length}`);
    console.log(`    验收参考: 应用内 20MB 走降级模式，首帧预览零成本；上述为手动刷新一次性成本上界（预算: 编辑器可用 < 1s）`);
  }
  console.log();
}

console.log("=== 基准完成 ===");
