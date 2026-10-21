/**
 * outline.ts —— 大纲标题抽取（B4 / K5 骨架）
 *
 * 设计约束：
 * - 单次线性扫描，不建 AST、不依赖 markdown-it（100KB < 2ms 预算的来源）；
 * - 行号 0-based，与 CodeMirror 行号一致，点击跳转可直接 dispatch({ line })；
 * - 围栏代码块（``` 与 ~~~）内的 # 不算标题；
 * - setext 标题（上一行非空文本 + `=+/-+` 行）取上一行作为标题行。
 *
 * 与 K5 骨架的差异仅在健壮性增强：setext 的上一行若自身是
 * 围栏开关行 / 下划线行 / ATX 标题，则不构成段落文本，
 * 避免 `# 标题` 紧跟 `===` 产生重复条目、以及下划线级联误判。
 */

/** 大纲条目：level 为标题级别（1-6），line 为标题所在行（0-based） */
export interface OutlineItem {
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
  line: number;
}

/** 围栏行：``` 或 ~~~（3 个及以上），允许前导空白 */
const FENCE_RE = /^\s*(`{3,}|~{3,})/;
/** ATX 标题：行首 1-6 个 # + 至少一个空白 + 标题文本；容忍行尾闭合 # */
const ATX_RE = /^(#{1,6})\s+(.+?)\s*#*$/;
/** setext 下划线：整行 = 或 - */
const SETEXT_RE = /^(=+|-+)\s*$/;
/** 上一行自身也是下划线行时不构成段落文本（防 `=====` 紧跟 `-----` 级联误判） */
const UNDERLINE_RE = /^ {0,3}(=+|-+)\s*$/;
/** 上一行自身是 ATX 标题时不构成段落文本（CommonMark 中 ATX 优先，后续 === 不构成 setext） */
const ATX_LINE_RE = /^#{1,6}(\s|$)/;

/**
 * 从 markdown 文档中抽取标题大纲。
 *
 * @param doc      完整文档文本（\n 或 \r\n 换行均可）
 * @param maxLines 只扫描前 maxLines 行（默认 2000）
 * @param max      最多返回 max 条标题（默认 500）
 * @returns 按文档顺序排列的标题条目，行号为 0-based
 */
export function extractOutline(doc: string, maxLines = 2000, max = 500): OutlineItem[] {
  const out: OutlineItem[] = [];
  let inFence = false;
  let fenceChar = "";
  // 上一行是否为围栏开关行（开或关）——setext 判定用
  let prevWasFence = false;
  // split 的 limit 参数会在取满后停止扫描，天然只处理前 maxLines 行
  const lines = doc.split("\n", maxLines);
  for (let i = 0; i < lines.length && out.length < max; i++) {
    const ln = lines[i];
    const fence = ln.match(FENCE_RE);
    if (fence) {
      // 围栏开关：未开时按首字符记录围栏类型；已开时仅同字符（≥3 个）才闭合
      if (!inFence) {
        inFence = true;
        fenceChar = fence[1][0];
      } else if (ln.trimStart().startsWith(fenceChar.repeat(3))) {
        inFence = false;
      }
      prevWasFence = true;
      continue;
    }
    if (inFence) {
      prevWasFence = false;
      continue;
    }
    const atx = ln.match(ATX_RE);
    if (atx) {
      out.push({ level: atx[1].length as OutlineItem["level"], text: atx[2], line: i });
      prevWasFence = false;
      continue;
    }
    const setext = ln.match(SETEXT_RE);
    if (setext && i > 0 && isParagraphText(lines[i - 1], prevWasFence)) {
      out.push({
        level: setext[1][0] === "=" ? 1 : 2,
        text: lines[i - 1].trim(),
        line: i - 1,
      });
    }
    prevWasFence = false;
  }
  return out;
}

/**
 * 判断某行能否作为 setext 标题的段落文本：
 * 非空，且不是围栏开关行 / 下划线行 / ATX 标题行。
 */
function isParagraphText(prev: string, prevWasFence: boolean): boolean {
  if (!prev.trim()) return false;
  if (prevWasFence) return false;
  if (UNDERLINE_RE.test(prev)) return false;
  if (ATX_LINE_RE.test(prev)) return false;
  return true;
}
