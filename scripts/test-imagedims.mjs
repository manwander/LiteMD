// 图片尺寸索引单元测试：校验 src/image-dims.ts 的作用域隔离、解码回退与落盘往返。
// 用 esbuild 把 TS 打包（并把 ./fs 替换为内存 mock，避免依赖 Tauri 运行时）。
import { build } from "esbuild";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const mockFsSrc = `
globalThis.__mockFsStore = globalThis.__mockFsStore || new Map();
const __store = globalThis.__mockFsStore;
export async function readFile(p){ return __store.has(p) ? __store.get(p) : Promise.reject(new Error("missing")); }
export async function writeFile(p,c){ __store.set(p,c); }
`;

const plugin = {
  name: "mock-fs",
  setup(b) {
    b.onResolve({ filter: /fs$/ }, (args) => ({ path: args.path, namespace: "mockfs" }));
    b.onLoad({ filter: /.*/, namespace: "mockfs" }, () => ({ contents: mockFsSrc, loader: "js" }));
  },
};

const out = join(mkdtempSync(join(tmpdir(), "imgdims-")), "image-dims.mjs");
await build({
  entryPoints: ["src/image-dims.ts"],
  outfile: out,
  bundle: true,
  format: "esm",
  platform: "node",
  plugins: [plugin],
  logLevel: "silent",
});
const mod = await import(pathToFileURL(out).href);
const { setDims, getDims, loadDims, saveDims } = mod;

let pass = 0,
  fail = 0;
function assert(cond, msg) {
  if (cond) pass++;
  else {
    fail++;
    console.error("  ✗ " + msg);
  }
}

// 1) 基本存取
setDims("C:/notes/A", "assets/a.webp", 2560, 1707);
let d = getDims("C:/notes/A", "assets/a.webp");
assert(d && d.w === 2560 && d.h === 1707, "基本存取应命中 2560x1707");

// 2) 作用域隔离：同名附件不同笔记不串味
setDims("C:/notes/B", "assets/a.webp", 100, 50);
assert(getDims("C:/notes/A", "assets/a.webp").w === 2560, "A 笔记仍为 2560");
assert(getDims("C:/notes/B", "assets/a.webp").w === 100, "B 笔记为 100（隔离）");

// 3) 未知引用返回 undefined
assert(getDims("C:/notes/A", "assets/missing.webp") === undefined, "未知引用应返回 undefined");

// 4) decode 回退：存储用 %20，查询用空格
setDims("C:/notes/A", "assets/b%20x.webp", 10, 20);
let d2 = getDims("C:/notes/A", "assets/b x.webp");
assert(d2 && d2.w === 10 && d2.h === 20, "含空格引用 decode 回退应命中");

// 5) 非法尺寸（w/h<=0）不写入
setDims("C:/notes/A", "assets/bad.webp", 0, 0);
assert(getDims("C:/notes/A", "assets/bad.webp") === undefined, "w/h<=0 不应写入");

// 6) 落盘往返：saveDims 只持久化本笔记作用域条目；JSON 内容正确
await saveDims("C:/notes/A", "assets");
const raw = globalThis.__mockFsStore.get("C:/notes/A/assets/.index.json");
assert(typeof raw === "string", "saveDims 应写入索引文件");
const obj = JSON.parse(raw);
assert(obj["assets/a.webp"] && obj["assets/a.webp"].w === 2560, "索引含 A 的 assets/a.webp");
assert(!("assets/bad.webp" in obj), "索引不应含非法尺寸条目");
assert(
  !Object.keys(obj).some((k) => k.startsWith("assets/a.webp") === false && k.includes("assets/a.webp")),
  "索引不应混入其他笔记条目",
);

// 7) loadDims 不抛（从 mock fs 读回并合并，仍可按原 key 取到）
await loadDims("C:/notes/A", "assets");
assert(getDims("C:/notes/A", "assets/a.webp").w === 2560, "loadDims 后原 key 仍可取");

console.log(`image-dims: ${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
