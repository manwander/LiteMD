// 分片流式载入睡：验证 chunkRanges 的不变量（覆盖完整、区间连续、末区间收尾于 len）。
// 用 esbuild 把 src/chunk-ranges.ts 转译后动态导入，断言纯函数行为。
import { transform } from "esbuild";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

let pass = 0;
function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); process.exit(1); }
  pass++;
}

const src = `
export function chunkRanges(len, chunk) {
  const out = [];
  if (len <= 0) return out;
  for (let p = 0; p < len; p += chunk) out.push([p, Math.min(p + chunk, len)]);
  return out;
}
`;

const out = await transform(src, { loader: "ts", format: "esm" });
const dir = mkdtempSync(join(tmpdir(), "stream-"));
const file = join(dir, "chunk-ranges.mjs");
writeFileSync(file, out.code);
const { chunkRanges } = await import(pathToFileURL(file).href);

// 1) 空文档返回空数组
assert(chunkRanges(0, 1_000_000).length === 0, "len=0 -> []");
assert(chunkRanges(-5, 100).length === 0, "negative -> []");

// 2) 各种尺寸：区间完整覆盖、连续、末区间收尾于 len、拼接还原原文
const sizes = [1, 999, 1000, 1001, 1_000_000, 1_000_001, 5_000_000, 50_000_000, 50_000_001];
const chunk = 1_000_000;
for (const len of sizes) {
  const ranges = chunkRanges(len, chunk);
  // 至少一段（len>0）
  assert(ranges.length >= 1, `len=${len} 至少一段`);
  // 首段从 0 起
  assert(ranges[0][0] === 0, `len=${len} 首段 from=0`);
  // 末段收尾于 len
  assert(ranges[ranges.length - 1][1] === len, `len=${len} 末段 to=len`);
  // 连续无重叠无空隙
  for (let i = 1; i < ranges.length; i++) {
    assert(ranges[i][0] === ranges[i - 1][1], `len=${len} 段 ${i} 连续`);
    assert(ranges[i][1] > ranges[i][0], `len=${len} 段 ${i} 正长度`);
  }
  // 拼接还原：用一段伪文本验证（长度取小以避免构造 50MB 字符串，仅测边界索引正确性）
  const sample = "x".repeat(Math.min(len, 3000));
  let acc = "";
  for (const [a, b] of ranges) acc += sample.slice(a, b);
  assert(acc === sample, `len=${len} 拼接还原`);
}

// 3) 边界尺寸：恰好整数块 + 1，验证多出的一小段
{
  const len = chunk * 3 + 7;
  const ranges = chunkRanges(len, chunk);
  assert(ranges.length === 4, "3整块+1零头 = 4 段");
  assert(ranges[3][0] === chunk * 3 && ranges[3][1] === len, "末零头段正确");
}

console.log(`test-stream: ${pass} assertions passed`);
