// 证据基准：量化 50MB 文档下 splitIntoBlocks 与 stats 扫描的真实耗时，
// 以确认「降级模式已跳过切块」的分析，并定位仍运行在 50MB 上的唯一 O(n) 路径。
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "bench-"));
const out = join(dir, "bs.mjs");

// 用 esbuild 把纯模块 block-splitter.ts 转成 ESM（无 Tauri 依赖）
await build({
  entryPoints: ["src/preview/block-splitter.ts"],
  bundle: true,
  format: "esm",
  outfile: out,
  logLevel: "silent",
});
const { splitIntoBlocks } = await import(pathToFileURL(out).href);

// ---- 生成 50MB 代表性 markdown ----
function makeDoc(bytes) {
  const lines = [];
  let acc = 0;
  let i = 0;
  while (acc < bytes) {
    const k = i % 13;
    let line;
    if (k === 0) line = `## 第 ${i} 节 标题候选与说明文字填充示例文本`;
    else if (k === 3) line = "- 列表项内容说明文字填充示例文本 " + i;
    else if (k === 7) line = "> 引用块内容说明文字填充示例文本 " + i;
    else if (k === 11) {
      line = "```js\nconst x = " + i + ";\nconsole.log(x);\n```";
    } else {
      line = "这是第 " + i + " 行普通段落内容，用于模拟较长的中文正文文本块以便估算渲染高度与字数统计开销。";
    }
    lines.push(line);
    acc += line.length + 1;
    i++;
  }
  return lines.join("\n");
}

const doc = makeDoc(50 * 1024 * 1024);
const mb = (doc.length / 1024 / 1024).toFixed(1);
console.log(`生成文档: ${mb} MB, ${doc.length} 字符, 约 ${(doc.length / 50).toFixed(0)} 字符/行`);

// ---- 计时：splitIntoBlocks 全量路径 ----
function time(label, fn) {
  const t0 = performance.now();
  const r = fn();
  const t1 = performance.now();
  console.log(`${label}: ${(t1 - t0).toFixed(1)} ms`);
  return r;
}

time(`splitIntoBlocks(${mb}MB 全量)`, () => splitIntoBlocks(null, doc));
// 二次调用应命中 lastSplit 内容记忆 (O(1))
time(`splitIntoBlocks(${mb}MB 内容未变)`, () => splitIntoBlocks(null, doc));

// ---- 计时：computeStats 等价扫描（当前每日打开仅此一项 50MB O(n) 仍运行，且处于 idle）----
function computeStats(text) {
  let cjk = 0, latinWords = 0, chars = 0, inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c !== 10) chars++;
    if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf)) { cjk++; inWord = false; continue; }
    const isLatin = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
    if (isLatin) { if (!inWord) { latinWords++; inWord = true; } } else inWord = false;
  }
  return { words: cjk + latinWords, chars };
}
const st = time(`computeStats(${mb}MB 单遍扫描)`, () => computeStats(doc));
console.log(`  -> 字数结果: ${st.words} 词, ${st.chars} 字符`);

// ---- 增量快路径验证：1 处小编辑应走 splitFast（无全文哈希）----
const edit = { from: 100, to: 100, insert: 5 };
time(`splitIntoBlocks(小编辑增量快路径)`, () => splitIntoBlocks(null, doc, edit));
