/**
 * needs-math.ts — 文档是否包含数学公式（零依赖，可静态进主 chunk）
 *
 * 从 md-pipeline.ts 拆出：集成方（App.svelte initMd）需要同步判定以决定
 * 是否装载 KaTeX 资源，而 md-pipeline 自身（含 task-lists 等依赖）必须
 * 经动态 import 留在独立 chunk。本模块无任何依赖，静态引入主 chunk 代价 ~1.5KB。
 * md-pipeline.ts 以 re-export 保持既有导入路径（测试契约不变）。
 *
 * 判定与渲染规则（md-pipeline 的 mathBlockRule / mathInlineRule）保持一致：
 * 块级 $$...$$ 或行内 $...$。刻意偏向误报（保守方向）：多加载资源不破坏显示，
 * 漏判才会让公式退化成裸文本。
 */
export function needsMath(doc: string): boolean {
  if (!doc) return false;

  // 块级：行首（允许 ≤3 空格缩进）的 $$ ... $$，可跨行
  if (/(^|\n)[ \t]{0,3}\$\$[\s\S]*?\$\$/.test(doc)) return true;

  // 行内：单次扫描，复刻 mathInlineRule 的判定（避免货币 "$5 $10" 误报）
  for (let i = 0; i < doc.length; i++) {
    if (doc.charCodeAt(i) !== 0x24 /* $ */) continue;
    if (doc.charCodeAt(i + 1) === 0x24) {
      i += 1; // $$ 归块级规则处理
      continue;
    }
    if (doc.charCodeAt(i - 1) === 0x5c /* \ */) continue; // 转义 \$
    const next = doc[i + 1];
    if (next === undefined || /\s/.test(next)) continue; // 开 $ 后禁空白
    let j = i + 1;
    let closed = -1;
    while (j < doc.length) {
      const code = doc.charCodeAt(j);
      if (code === 0x5c) {
        j += 2; // 跳过转义序列
        continue;
      }
      if (code === 0x24) {
        closed = j;
        break;
      }
      if (code === 0x0a) break; // 行内不跨行
      j += 1;
    }
    if (closed < 0) continue;
    if (/\s/.test(doc[closed - 1])) continue; // 闭合 $ 前禁空白
    if (/\d/.test(doc[closed + 1] ?? "")) continue; // 闭合 $ 后禁数字（货币）
    return true;
  }
  return false;
}
