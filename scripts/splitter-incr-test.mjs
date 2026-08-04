// block-splitter 增量切块（splitFast / EditRange）正确性测试
// 用法：node scripts/splitter-incr-test.mjs
// 原理：增量路径结果 vs「清缓存后全量切分」结果逐块对比（全量路径与旧算法的
//       等价性已由 splitter-equiv-test.mjs 29 用例保证，故此处可组合传递）。
// 另校验：块自带 hash/estH 与 hashRange/estimateBlockHeight 一致；
//        非法 edits（长度不变式被破坏）必须安全回退到全量。
import {
  splitIntoBlocks, clearSplitCache, hashRange, estimateBlockHeight,
} from "../src/preview/block-splitter.ts";

let seed = 20260803;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }

function randomDoc(lines) {
  const out = [];
  let inFence = false;
  for (let i = 0; i < lines; i++) {
    const r = rnd();
    if (inFence) {
      if (r < 0.08) { out.push("```"); inFence = false; }
      else if (r < 0.15) out.push("");
      else out.push("code line " + i + " = " + Math.floor(r * 1000));
    } else if (r < 0.06) { out.push("```js"); inFence = true; }
    else if (r < 0.16) out.push("");
    else if (r < 0.24) out.push("#".repeat(1 + Math.floor(rnd() * 6)) + " heading " + i);
    else if (r < 0.32) out.push("- item " + i);
    else if (r < 0.36) out.push("> quote " + i);
    else if (r < 0.4) out.push("---");
    else if (r < 0.46) out.push("1. num " + i);
    else out.push("paragraph text " + i + " lorem ipsum dolor sit amet, 中文混排 test.");
  }
  if (inFence) out.push("```");
  return out.join(rnd() < 0.3 ? "\r\n" : "\n");
}

/** 随机小编辑：插入/删除/替换，内容可能跨行 */
function randomEdit(src) {
  const from = Math.floor(rnd() * (src.length + 1));
  const del = Math.min(src.length - from, Math.floor(rnd() * 40));
  const kinds = ["x", "hello world", "line1\nline2\n", "中文字符", "# h\n\n- a\n", ""];
  const ins = kinds[Math.floor(rnd() * kinds.length)];
  return { from, to: from + del, insert: ins };
}

function applyEdit(src, e) {
  return src.slice(0, e.from) + e.insert + src.slice(e.to);
}

/** 与 App.svelte accumulateEdit 完全一致的合并算法（防抖窗口内多事务合并） */
function accumulate(pe, fromA, toA, insertLen) {
  if (!pe) return { from: fromA, to: toA, insert: insertLen };
  const delta = pe.insert - (pe.to - pe.from);
  const newEnd = pe.from + pe.insert;
  if (fromA >= newEnd) {
    const gap = fromA - delta - pe.to;
    pe.to = toA - delta;
    pe.insert += gap + insertLen;
  } else if (toA <= pe.from) {
    const gap = pe.from - toA;
    pe.from = fromA;
    pe.insert += insertLen + gap;
  } else {
    const overlapNew = Math.max(0, Math.min(toA, newEnd) - Math.max(fromA, pe.from));
    const oldFrom = fromA <= pe.from ? fromA : (fromA >= newEnd ? fromA - delta : pe.from);
    const oldTo = toA <= pe.from ? toA : (toA >= newEnd ? toA - delta : pe.to);
    pe.from = Math.min(pe.from, oldFrom);
    pe.to = Math.max(pe.to, oldTo);
    pe.insert += insertLen - overlapNew;
  }
  return pe;
}

function compareBlocks(got, ref, src, tag) {
  if (got.length !== ref.length) return `块数不同 got=${got.length} ref=${ref.length}`;
  for (let i = 0; i < got.length; i++) {
    const a = got[i], b = ref[i];
    if (a.srcBegin !== b.srcBegin || a.srcEnd !== b.srcEnd || a.type !== b.type || a.preview !== b.preview)
      return `${tag} 块#${i} 不同 got=${JSON.stringify({ b: a.srcBegin, e: a.srcEnd, t: a.type })} ref=${JSON.stringify({ b: b.srcBegin, e: b.srcEnd, t: b.type })}`;
    if (a.hash !== b.hash) return `${tag} 块#${i} hash 不同`;
    if (a.estH !== b.estH) return `${tag} 块#${i} estH 不同 got=${a.estH} ref=${b.estH}`;
    // hash/estH 与独立函数结果一致（消费方 VP 依赖此等价）
    if (a.hash !== hashRange(src, a.srcBegin, a.srcEnd)) return `${tag} 块#${i} hash 与 hashRange 不一致`;
    if (a.estH !== estimateBlockHeight(a, src)) return `${tag} 块#${i} estH 与 estimateBlockHeight 不一致`;
  }
  return "";
}

function fullRef(src) {
  clearSplitCache();
  return splitIntoBlocks(null, src);
}

let failed = 0;
function check(name, err) {
  if (err) { failed++; console.log(`[FAIL] ${name}: ${err}`); }
  else console.log(`[OK]   ${name}`);
}

// ---- 用例 1：单步随机编辑序列（每步 edits 相对上一步 source）----
{
  let src = randomDoc(1500);
  clearSplitCache();
  splitIntoBlocks(null, src); // 建立 lastSplit
  let err = "";
  for (let k = 0; k < 300 && !err; k++) {
    const e = randomEdit(src);
    const next = applyEdit(src, e);
    const got = splitIntoBlocks(null, next, { from: e.from, to: e.to, insert: e.insert.length });
    const ref = fullRef(next); // 注意：fullRef 会重置 lastSplit
    err = compareBlocks(got, ref, next, `step${k}`);
    if (err) break;
    // 重新以 next 为基准继续（fullRef 已把 lastSplit 设为 next）
    src = next;
  }
  check("单步随机编辑 x300", err);
}

// ---- 用例 2：防抖窗口内多次编辑合并（App accumulateEdit 同算法）----
{
  let src = randomDoc(1200);
  let err = "";
  for (let round = 0; round < 60 && !err; round++) {
    clearSplitCache();
    splitIntoBlocks(null, src); // lastSplit = 推送基准
    let cur = src;
    let pe = null;
    const nEdits = 1 + Math.floor(rnd() * 5);
    for (let k = 0; k < nEdits; k++) {
      const e = randomEdit(cur);
      pe = accumulate(pe, e.from, e.to, e.insert.length);
      cur = applyEdit(cur, e);
    }
    const got = splitIntoBlocks(null, cur, pe);
    const ref = fullRef(cur);
    err = compareBlocks(got, ref, cur, `round${round}(${nEdits}编辑)`);
    src = randomDoc(800 + Math.floor(rnd() * 1200));
  }
  check("窗口内多编辑合并 x60", err);
}

// ---- 用例 3：同 source 重复推送（hlVersion 场景，恒等短路）----
{
  const src = randomDoc(600);
  clearSplitCache();
  const a = splitIntoBlocks(null, src);
  const b = splitIntoBlocks(null, src, { from: 999999, to: 999999, insert: 0 }); // 脏区间应被恒等短路忽略
  check("同 source 恒等短路", compareBlocks(b, a, src, "identity"));
}

// ---- 用例 4：非法 edits（长度不变式被破坏）必须安全回退全量 ----
{
  const src = randomDoc(700);
  clearSplitCache();
  splitIntoBlocks(null, src);
  const next = src.slice(0, 100) + "INSERTED TEXT\n" + src.slice(100);
  // 故意给错 insert 长度（少算 5）→ splitFast 长度校验失败应回退
  const got = splitIntoBlocks(null, next, { from: 100, to: 100, insert: 9 });
  const ref = fullRef(next);
  check("非法 edits 回退全量", compareBlocks(got, ref, next, "fallback"));
}

// ---- 用例 5：超大编辑（整段替换 / 全选删除）----
{
  const src = randomDoc(900);
  clearSplitCache();
  splitIntoBlocks(null, src);
  const mid = Math.floor(src.length / 2);
  const next = src.slice(0, 10) + "replacement\n\nnew doc body\n".repeat(200) + src.slice(src.length - 10);
  // insert = 新内容长度 = 总长度变化 + 被删旧内容长度
  const insLen = next.length - src.length + (mid + 100 - 10);
  const got2 = splitIntoBlocks(null, next, { from: 10, to: mid + 100, insert: insLen });
  const ref = fullRef(next);
  check("大范围替换", compareBlocks(got2, ref, next, "big-replace"));
}

// ---- 用例 6：删除到空文档 / 从空文档插入 ----
{
  clearSplitCache();
  const src = "hello\n\nworld";
  splitIntoBlocks(null, src);
  const empty = splitIntoBlocks(null, "", { from: 0, to: src.length, insert: 0 });
  let err = empty.length === 0 ? "" : `空文档应 0 块 got=${empty.length}`;
  if (!err) {
    const back = "new\n\ndoc";
    const got = splitIntoBlocks(null, back, { from: 0, to: 0, insert: back.length });
    const ref = fullRef(back);
    err = compareBlocks(got, ref, back, "empty->doc");
  }
  check("空文档边界", err);
}

// ---- 用例 7：回归用例——行首开始的行内删除（行首恰等于 edit.from 必须保留）----
{
  const src = "para one\n\nparagraph text here to edit\n```js\ncode\n```\n\nend";
  const from = src.indexOf("paragraph"); // 行首
  const to = from + 10; // 行内删除，不含行尾换行
  const next = src.slice(0, from) + src.slice(to);
  clearSplitCache();
  splitIntoBlocks(null, src);
  const got = splitIntoBlocks(null, next, { from, to, insert: 0 });
  const ref = fullRef(next);
  check("行首行内删除回归", compareBlocks(got, ref, next, "line-start-del"));
}

console.log(failed === 0 ? "\nALL INCREMENTAL EQUAL ✓" : `\n${failed} 个用例失败 ✗`);
process.exit(failed === 0 ? 0 : 1);
