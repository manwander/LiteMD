// 证据基准：量化 50MB 下 rebuildFenceIndex 的真实耗时（旧实现逐行 .text 分配 + 正则）。
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "benchf-"));
const out = join(dir, "fence.mjs");

await build({
  entryPoints: ["src/fence-index.ts"],
  bundle: true,
  format: "esm",
  outfile: out,
  logLevel: "silent",
});
const mod = await import(pathToFileURL(out).href);

// ---- 生成 50MB 文档 + 模拟 CM6 的 FenceDoc（line(n).text 走 sliceString 分配，等同真实行为）----
function makeDoc(bytes) {
  const lines = [];
  let acc = 0, i = 0;
  while (acc < bytes) {
    const k = i % 17;
    let line;
    if (k === 0) line = "```js";
    else if (k === 8) line = "```";
    else if (k === 3) line = "## 第 " + i + " 节 标题候选与说明文字填充示例文本";
    else if (k === 11) line = "    ```python"; // 前导缩进 + 围栏
    else line = "这是第 " + i + " 行普通段落内容，用于模拟较长的中文正文文本块。";
    lines.push(line);
    acc += line.length + 1;
    i++;
  }
  return lines.join("\n");
}
const text = makeDoc(50 * 1024 * 1024);
const lineStarts = [0];
for (let p = text.indexOf("\n"); p !== -1; p = text.indexOf("\n", p + 1)) lineStarts.push(p + 1);
const doc = {
  lines: lineStarts.length,
  line(n) {
    const from = lineStarts[n - 1];
    const to = n < lineStarts.length ? lineStarts[n] - 1 : text.length;
    return { from, to, get text() { return text.slice(from, to); } };
  },
  sliceString(f, t) { return text.slice(f, t); },
};
console.log(`文档: ${(text.length/1024/1024).toFixed(1)} MB, ${doc.lines} 行`);

function time(label, fn) {
  // 强制一次 GC（若可用），更贴近稳态
  if (global.gc) global.gc();
  const t0 = performance.now();
  fn();
  const t1 = performance.now();
  console.log(`${label}: ${(t1 - t0).toFixed(1)} ms`);
}

// 旧实现（复制当前源码逻辑，逐行 .text + 正则）
function rebuildOld(d) {
  const n = Math.ceil(d.lines / 512) + 1;
  const arr = new Int32Array(n);
  let f = 0;
  for (let ln = 1; ln <= d.lines; ln++) {
    if (ln > 1 && (ln - 1) % 512 === 0) arr[(ln - 1) / 512] = f;
    if (/^\s*```/.test(d.line(ln).text)) f++;
  }
  return arr;
}
time("rebuildFenceIndex 旧实现(逐行.text+正则)", () => rebuildOld(doc));

// 新实现（仅取前 4 字符做 charCode 检测，避免整行分配）
function lineIsFenceOpen(d, ln) {
  const line = d.line(ln);
  const to = Math.min(line.to, line.from + 4);
  const s = d.sliceString(line.from, to);
  let i = 0; const len = s.length;
  if (len === 0) return false;
  while (i < len && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
  if (i > 3) return false;
  let bt = 0;
  while (i < len && s.charCodeAt(i) === 96) { bt++; i++; }
  return bt >= 3;
}
function rebuildNew(d) {
  const n = Math.ceil(d.lines / 512) + 1;
  const arr = new Int32Array(n);
  let f = 0;
  for (let ln = 1; ln <= d.lines; ln++) {
    if (ln > 1 && (ln - 1) % 512 === 0) arr[(ln - 1) / 512] = f;
    if (lineIsFenceOpen(d, ln)) f++;
  }
  return arr;
}
time("rebuildFenceIndex 新实现(4字符检测,无整行分配)", () => rebuildNew(doc));

// 正确性对拍：两种实现结果应一致
const a = rebuildOld(doc), b = rebuildNew(doc);
let same = a.length === b.length;
for (let i = 0; same && i < a.length; i++) if (a[i] !== b[i]) same = false;
console.log(`结果一致性: ${same ? "通过" : "失败"}`);

// 边界用例：短行/长前导空白/非 ``` 围栏（~）应正确区分
const cases = [
  ["```", true], ["   ```", true], ["\t```", true], ["    ```", false],
  ["``", false], ["`", false], ["~~~", false], [" code", false], ["```js", true],
  ["   ~~~", false], // 仅支持反引号围栏（与旧实现一致：/^\s*```/ 只匹配反引号）
];
let ok = true;
for (const [ln, exp] of cases) {
  const ld = {
    lines: 1,
    line() { return { from: 0, to: ln.length, get text() { return ln; } }; },
    sliceString(f, t) { return ln.slice(f, t); },
  };
  const got = lineIsFenceOpen(ld, 1);
  if (got !== exp) { ok = false; console.log(`  边界不符: '${ln}' 期望=${exp} 实际=${got}`); }
}
console.log(`边界用例: ${ok ? "通过" : "失败"}`);

// 验证模块导出可用
console.log(`模块导出: rebuildFenceIndex=${typeof mod.rebuildFenceIndex}, isInsideCodeBlock=${typeof mod.isInsideCodeBlock}`);
