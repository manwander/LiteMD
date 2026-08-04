// 图片尺寸索引（P1-5·尺寸内联）。
//
// 粘贴/插入图片时记录其宽高，供 markdown-it 图片渲染规则在 <img> 上注入
// width/height，让浏览器用 aspect-ratio 预留空间，避免图片加载完成导致预览滚动跳变。
//
// 设计要点：
// - 内存为主：Map 按 noteDir + 相对引用 作用域，避免不同笔记同名附件互相串味。
// - best-effort 落盘到 <noteDir>/<assetsDir>/.index.json，失败静默忽略（索引只是优化，
//   缺失仅损失"预留空间"，不影响图片渲染正确性）。
// - 纯模块：顶层无副作用，可在 Node 下安全 import。

import { readFile, writeFile } from "./fs";

interface Dims {
  w: number;
  h: number;
}

const map = new Map<string, Dims>();

function normRef(ref: string): string {
  // markdown-it 可能把空格/中文做 percent-encoding，存储与查询两端统一解码，
  // 保证 assets/b%20x.webp 与 assets/b x.webp 指向同一索引项。
  try {
    return decodeURIComponent(ref);
  } catch {
    return ref;
  }
}

function key(noteDir: string, ref: string): string {
  return noteDir.replace(/\\/g, "/") + "|" + normRef(ref);
}

export function setDims(noteDir: string, ref: string, w: number, h: number): void {
  if (w > 0 && h > 0) map.set(key(noteDir, ref), { w, h });
}

export function getDims(noteDir: string, ref: string): Dims | undefined {
  return (
    map.get(key(noteDir, ref)) ?? map.get(key(noteDir, decodeURIComponent(ref)))
  );
}

// 索引文件：<noteDir>/<assetsDir>/.index.json
function indexFile(noteDir: string, assetsDir: string): string {
  return `${noteDir.replace(/\\/g, "/")}/${assetsDir}/.index.json`;
}

export async function loadDims(noteDir: string, assetsDir: string): Promise<void> {
  try {
    const raw = await readFile(indexFile(noteDir, assetsDir));
    const obj = JSON.parse(raw) as Record<string, Dims>;
    for (const k in obj) {
      const d = obj[k];
      if (d && d.w > 0 && d.h > 0) map.set(key(noteDir, k), { w: d.w, h: d.h });
    }
  } catch {
    /* 文件不存在或解析失败：视为空索引，不阻断主流程 */
  }
}

export async function saveDims(noteDir: string, assetsDir: string): Promise<void> {
  try {
    const obj: Record<string, Dims> = {};
    for (const [k, v] of map) {
      // 只持久化本笔记作用域下的条目
      if (k.startsWith(noteDir.replace(/\\/g, "/") + "|")) {
        obj[k.slice(k.indexOf("|") + 1)] = v;
      }
    }
    await writeFile(indexFile(noteDir, assetsDir), JSON.stringify(obj));
  } catch {
    /* 落盘失败静默忽略 */
  }
}
