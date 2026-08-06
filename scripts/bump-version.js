// 自动 bump 版本号：每次构建 +0.1。
// 三处需同步:package.json / src-tauri/Cargo.toml / src-tauri/tauri.conf.json。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const rules = [
  { file: "package.json", re: /("version"\s*:\s*")(\d+\.\d+(?:\.\d+)?)(")/ },
  { file: "src-tauri/Cargo.toml", re: /(^\s*version\s*=\s*")(\d+\.\d+(?:\.\d+)?)(")/m },
  { file: "src-tauri/tauri.conf.json", re: /("version"\s*:\s*")(\d+\.\d+(?:\.\d+)?)(")/ },
];

const backups = [];
try {
  const refPath = path.join(root, "src-tauri/tauri.conf.json");
  const refOrig = fs.readFileSync(refPath, "utf8");
  const refMatch = refOrig.match(rules[2].re);
  if (!refMatch) throw new Error("基准版本号读取失败");
  const oldVer = refMatch[2];
  const parts = oldVer.split(".").map((n) => parseInt(n, 10));
  parts[1] += 1; // +0.1: 小版本号 +1
  parts[2] = 0;
  const newVer = parts.join(".");

  for (const rule of rules) {
    const p = path.join(root, rule.file);
    const orig = fs.readFileSync(p, "utf8");
    backups.push({ p, orig });
    const m = orig.match(rule.re);
    if (!m) {
      console.error(`[bump] ${rule.file}: 未匹配到 version 字段`);
      process.exit(1);
    }
    const updated = orig.replace(rule.re, (_, p1, _v, p3) => `${p1}${newVer}${p3}`);
    fs.writeFileSync(p, updated);
    console.log(`[bump] ${rule.file}: ${oldVer} -> ${newVer}`);
  }
  console.log(`[bump] OK: ${newVer}`);
} catch (e) {
  console.error("[bump] 失败,回滚:", e.message);
  for (const b of backups) fs.writeFileSync(b.p, b.orig);
  process.exit(1);
}