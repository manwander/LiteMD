// 围栏检查点索引单元测试：校验 src/fence-index.ts 的 isInsideCodeBlock 与朴素逐行扫描一致。
// 用 esbuild 把 TS 转译成 ESM 后动态导入（无需 CodeMirror / DOM）。
import { build } from "esbuild";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const out = join(mkdtempSync(join(tmpdir(), "fence-")), "fence-index.mjs");
await build({
  entryPoints: ["src/fence-index.ts"],
  outfile: out,
  bundle: false,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const mod = await import(pathToFileURL(out).href);
const { rebuildFenceIndex, markFenceDirty, scheduleFenceRebuild, isInsideCodeBlock, lineIsFenceOpen } = mod;

// 朴素参照：逐行扫描 1..posLine
function naive(lines, posLine) {
  let f = 0;
  for (let n = 1; n < posLine; n++) if (/^\s*```/.test(lines[n - 1])) f++;
  return f % 2 === 1;
}
function makeDoc(linesArr) {
  const offsets = [0];
  for (let i = 0; i < linesArr.length; i++) offsets.push(offsets[i] + linesArr[i].length + 1);
  const full = linesArr.join("\n");
  return {
    lines: linesArr.length,
    line(n) {
      const from = offsets[n - 1];
      const to = offsets[n] - 1; // 排除行尾 \n
      return { from, to, text: linesArr[n - 1] };
    },
    sliceString(f, t) { return full.slice(f, t); },
  };
}

let pass = 0;
let fail = 0;
function assert(cond, msg) {
  if (cond) pass++;
  else {
    fail++;
    console.error("  ✗ " + msg);
  }
}

// 1) 小文档（≤窗口）：clean 与 dirty 路径都必须与朴素一致（抽样位置，控制朴素 O(p) 成本）
function randomDoc(n) {
  const lines = [];
  for (let i = 0; i < n; i++) {
    const r = Math.random();
    if (r < 0.05) lines.push("```js");
    else if (r < 0.07) lines.push("```");
    else if (r < 0.1) lines.push("> 引用");
    else lines.push("正文行 " + i + " 一些文本 text 中文混合 " + Math.random());
  }
  return lines;
}

for (let t = 0; t < 100; t++) {
  const lines = randomDoc(50 + Math.floor(Math.random() * 4000));
  const doc = makeDoc(lines);
  rebuildFenceIndex(doc);
  for (let i = 0; i < 200; i++) {
    const p = 1 + Math.floor(Math.random() * lines.length);
    assert(isInsideCodeBlock(doc, p) === naive(lines, p), `clean t=${t} p=${p}`);
  }
  // dirty 路径（有界上扫）：小文档整段精确（start===1）
  markFenceDirty();
  for (let i = 0; i < 200; i++) {
    const p = 1 + Math.floor(Math.random() * lines.length);
    assert(isInsideCodeBlock(doc, p) === naive(lines, p), `dirty t=${t} p=${p}`);
  }
}

// 2) 大文档（远 > 窗口）：clean 全量精确；dirty 仅末段窗口精确
const FENCE_RESCAN_LIMIT = 8192;
for (let t = 0; t < 5; t++) {
  const lines = randomDoc(40000);
  const doc = makeDoc(lines);
  rebuildFenceIndex(doc);
  // 抽样若干行（含代码块内/外）对照
  for (let i = 0; i < 100; i++) {
    const p = 1 + Math.floor(Math.random() * lines.length);
    assert(isInsideCodeBlock(doc, p) === naive(lines, p), `big-clean t=${t} p=${p}`);
  }
  // dirty 路径：仅当扫描覆盖到文档首行（posLine <= LIMIT，即整段精确）时与朴素一致；
  // 窗口被截断时按契约保守返回 false（安全降级，不要求与朴素相等）。
  markFenceDirty();
  for (let p = 1; p <= Math.min(lines.length, FENCE_RESCAN_LIMIT); p++) {
    assert(isInsideCodeBlock(doc, p) === naive(lines, p), `big-dirty-top t=${t} p=${p}`);
  }
  // 截断窗口：必须返回 false（保守降级），绝不返回 true 而实际不在代码块
  let truncatedWrong = 0;
  for (let i = 0; i < 200; i++) {
    const p = FENCE_RESCAN_LIMIT + 1 + Math.floor(Math.random() * (lines.length - FENCE_RESCAN_LIMIT - 1));
    const v = isInsideCodeBlock(doc, p);
    assert(typeof v === "boolean", `big-dirty-mid boolean t=${t} p=${p}`);
    // 截断窗口绝不允许误报「在代码块内」而实际不在：安全边界
    if (v === true && naive(lines, p) === false) truncatedWrong++;
  }
  assert(truncatedWrong === 0, `big-dirty: 截断窗口未误报代码块 t=${t}`);
}

// 3) scheduleFenceRebuild 在 Node（无 requestIdleCallback）应立即重建并清除 dirty
{
  const lines = randomDoc(3000);
  const doc = makeDoc(lines);
  rebuildFenceIndex(doc);
  markFenceDirty();
  assert(mod.isFenceIndexDirty() === true, "dirty flag set");
  scheduleFenceRebuild(() => doc);
  assert(mod.isFenceIndexDirty() === false, "scheduleFenceRebuild 立即重建并清除 dirty");
  for (let p = 1; p <= lines.length; p++) {
    assert(isInsideCodeBlock(doc, p) === naive(lines, p), `post-rebuild p=${p}`);
  }
}

// 4) 确定性案例：经典「尾部 Enter」——末尾连续非代码正文，前面有未闭合围栏
{
  const lines = ["```js", "code", "```", ...Array.from({ length: 1000 }, (_, i) => "para " + i)];
  const doc = makeDoc(lines);
  rebuildFenceIndex(doc);
  // 末尾行不在代码块内
  assert(isInsideCodeBlock(doc, lines.length) === false, "尾部不在代码块");
  assert(isInsideCodeBlock(doc, 2) === true, "围栏内为 true");
  assert(isInsideCodeBlock(doc, 1) === false, "首行不在代码块");
}

// 5) lineIsFenceOpen 边界：与旧 /^\s*```/ 语义一致（前导任意空白 + ≥3 反引号）
{
  const cases = [
    ["```", true], ["```js", true], ["   ```", true], ["\t```", true],
    ["    ```python", true],          // 4 空格仍匹配旧正则
    ["         ```", true],           // 9 空格仍在 FENCE_SCAN(32) 内
    ["``", false], ["`", false], ["~~~", false], [" code", false],
    ["a```", false], ["  ~~~", false], ["x```y", false],
  ];
  for (const [ln, exp] of cases) {
    const ld = {
      lines: 1,
      line() { return { from: 0, to: ln.length, text: ln }; },
      sliceString(f, t) { return ln.slice(f, t); },
    };
    assert(lineIsFenceOpen(ld, 1) === exp, `lineIsFenceOpen '${ln}' 期望=${exp}`);
  }
}

console.log(`\nfence-index 测试：${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
