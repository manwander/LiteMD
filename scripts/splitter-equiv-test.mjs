// block-splitter 等价性回归测试：旧算法（v1 全量切分）vs 新算法（零分配 + 分段缓存）
// 用法：node --experimental-strip-types scripts/splitter-equiv-test.mjs
// 对比项：每块的 srcBegin / srcEnd / type / preview，以及 estimateBlockHeight。
import { splitIntoBlocks, estimateBlockHeight, getSplitCacheStats } from "../src/preview/block-splitter.ts";

// ================= 旧算法（v1，原样保留作对照） =================

function splitIntoBlocksOld(source) {
  if (!source) return [];
  const rawBlocks = splitByBlankLinesOld(source);
  const blocks = [];
  for (const rb of rawBlocks) {
    if (!rb.text.trim()) continue;
    const type = classifyBlockOld(rb.text);
    if (!type) continue;
    blocks.push({
      srcBegin: rb.begin,
      srcEnd: rb.end,
      type,
      preview: rb.text.replace(/\s+/g, ' ').slice(0, 40),
    });
  }
  return blocks;
}

function splitByBlankLinesOld(source) {
  const result = [];
  const lines = source.split('\n');
  const lineOffsets = [];
  let off = 0;
  for (const ln of lines) {
    lineOffsets.push(off);
    off += ln.length + 1;
  }
  let curStartLine = 0;
  let curLines = [];
  let inFence = false;
  let fenceMarker = '';
  const flush = (endLine) => {
    if (curLines.length) {
      const text = curLines.join('\n');
      const begin = lineOffsets[curStartLine];
      const end = endLine < lineOffsets.length ? lineOffsets[endLine] : source.length;
      result.push({ begin, end, text });
    }
    curLines = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = line.match(/^(\s{0,3})(`{3,}|~{3,})/);
    if (fenceMatch) {
      if (!inFence) {
        if (curLines.length) flush(i);
        inFence = true;
        fenceMarker = fenceMatch[2][0];
        curStartLine = i;
        curLines = [line];
      } else if (line.trimStart().startsWith(fenceMarker.repeat(3))) {
        curLines.push(line);
        flush(i + 1);
        inFence = false;
        fenceMarker = '';
        curStartLine = i + 1;
        continue;
      } else {
        curLines.push(line);
      }
    } else if (inFence) {
      curLines.push(line);
    } else if (line.trim() === '' && curLines.length) {
      flush(i);
      curStartLine = i + 1;
    } else {
      if (!curLines.length) curStartLine = i;
      curLines.push(line);
    }
  }
  if (curLines.length) flush(lines.length);
  return result;
}

function classifyBlockOld(text) {
  const lines = text.split('\n');
  const first = lines[0].trim();
  if (/^#{1,6}\s/.test(first)) return 'heading_open';
  if (/^(`{3,}|~{3,})/.test(first)) return 'fence';
  if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(first)) return 'hr';
  for (const line of lines) {
    const t = line.trimStart();
    if (/^[-*+]\s/.test(t) || /^\d+\.\s/.test(t)) return 'bullet_list_open';
    if (/^>\s/.test(t)) return 'blockquote_open';
  }
  return 'paragraph_open';
}

function estimateBlockHeightOld(block, source, lineHeight = 1.7) {
  const slice = source.slice(block.srcBegin, block.srcEnd);
  const lines = (slice.match(/\n/g) || []).length + 1;
  switch (block.type) {
    case "heading_open": {
      const m = slice.match(/^(#+)/);
      const level = m ? m[1].length : 1;
      const fontSize = 2.0 - (level - 1) * 0.15;
      return Math.ceil(fontSize * 16 * 1.4) + Math.ceil(lineHeight * 16 * 0.5);
    }
    case "fence":
    case "code_block":
      return Math.ceil(lines * 1.4 * 14) + 24;
    case "hr":
      return Math.ceil(1.5 * 14);
    case "blockquote_open":
      return Math.ceil(lines * lineHeight * 14) + 16;
    case "bullet_list_open":
    case "ordered_list_open":
      return Math.ceil(lines * lineHeight * 14) + 16;
    case "table_open":
      return Math.ceil(lines * lineHeight * 14) + 24;
    case "html_block":
      return Math.ceil(slice.length / 80 * lineHeight * 14) + 16;
    case "paragraph_open":
    default: {
      const visibleChars = slice.length;
      const charsPerLine = 60;
      const textLines = Math.ceil(visibleChars / charsPerLine);
      return Math.ceil(textLines * lineHeight * 14) + 16;
    }
  }
}

// ================= 测试用例 =================

const CASES = [];
function case_(name, text) { CASES.push([name, text]); }

case_("empty", "");
case_("single line", "hello world");
case_("paragraph", "para one\nstill same para\n\npara two");
case_("heading levels", "# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6\n####### not heading");
case_("fence basic", "before\n\n```js\nconst a = 1;\n// blank inside\n\nstill code\n```\n\nafter");
case_("fence tilde", "~~~py\nprint(1)\n~~~");
case_("unclosed fence", "```js\ncode line\n\nmore code no close");
case_("fence with blank and closing longer", "````\nx\n```````\ntext");
case_("hr variants", "---\n\n***\n\n___\n\n----\n\n-- not hr");
case_("list unordered", "- a\n- b\n  - nested\n\nnew para");
case_("list ordered", "1. one\n2. two\n10. ten");
case_("blockquote", "> quote line\n> more\n\npara");
case_("mixed containers", "> - quoted list\n> item");
case_("crlf", "# Title\r\n\r\npara one\r\n\r\n```js\r\ncode\r\n```\r\n\r\nend");
case_("tabs", "\t# heading with tab\r\n\r\n\t\tindented para\n\n---\t");
case_("trailing spaces", "para   \n\n---   \n\n# H1   ");
case_("leading blank lines", "\n\n\nfirst para");
case_("blank only", "\n\n\n");
case_("weird fences", "```\n``\n````\n``\n```");
case_("number-ish", "1. list\n\n123. also list\n\n1234.notlist no space");
case_("long preview", "word ".repeat(50) + "\n\nshort");
case_("indented fence 3sp", "   ```\n   code\n   ```");
case_("indented fence 4sp", "    ```\nnot fence (4sp indent)");
case_("blockquote no space", ">no space after");
case_("list marker eol", "-\n+\n*");

// 大文档随机用例（覆盖分段边界）
function randomDoc(lines, seed) {
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
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
  return out.join(rnd() < 0.5 ? "\n" : "\r\n");
}
case_("random 800 lines (LF)", randomDoc(800, 42));
case_("random 2000 lines (CRLF)", randomDoc(2000, 7));
case_("random 5000 lines", randomDoc(5000, 1234));

// ================= 比对 =================

let failed = 0;
for (const [name, text] of CASES) {
  const oldBlocks = splitIntoBlocksOld(text);
  const newBlocks = splitIntoBlocks(null, text);
  let err = "";
  if (oldBlocks.length !== newBlocks.length) {
    err = `块数不同 old=${oldBlocks.length} new=${newBlocks.length}`;
  } else {
    for (let i = 0; i < oldBlocks.length; i++) {
      const a = oldBlocks[i], b = newBlocks[i];
      if (a.srcBegin !== b.srcBegin || a.srcEnd !== b.srcEnd || a.type !== b.type || a.preview !== b.preview) {
        err = `块#${i} 不同 old=${JSON.stringify(a)} new=${JSON.stringify(b)}`;
        break;
      }
      const ha = estimateBlockHeightOld(a, text);
      const hb = estimateBlockHeight(b, text);
      if (ha !== hb) {
        err = `块#${i} 高度不同 old=${ha} new=${hb} type=${a.type}`;
        break;
      }
    }
  }
  if (err) {
    failed++;
    console.log(`[FAIL] ${name}: ${err}`);
  } else {
    console.log(`[OK]   ${name} (${newBlocks.length} 块)`);
  }
}

// 增量路径二次验证：改一行后重切，结果仍与旧算法一致（验证段缓存命中路径正确）
{
  const text = randomDoc(3000, 99);
  splitIntoBlocks(null, text); // 预热缓存
  const lines = text.split("\n");
  const mid = Math.floor(lines.length / 2);
  lines[mid] = lines[mid] + " edited";
  const edited = lines.join("\n");
  const oldBlocks = splitIntoBlocksOld(edited);
  const newBlocks = splitIntoBlocks(null, edited); // 大部分段走缓存
  let err = oldBlocks.length !== newBlocks.length ? `块数不同 ${oldBlocks.length} vs ${newBlocks.length}` : "";
  if (!err) {
    for (let i = 0; i < oldBlocks.length; i++) {
      const a = oldBlocks[i], b = newBlocks[i];
      if (a.srcBegin !== b.srcBegin || a.srcEnd !== b.srcEnd || a.type !== b.type || a.preview !== b.preview) {
        err = `增量路径 块#${i} 不同 old=${JSON.stringify(a)} new=${JSON.stringify(b)}`;
        break;
      }
    }
  }
  if (err) { failed++; console.log("[FAIL] incremental-cache:", err); }
  else console.log(`[OK]   incremental-cache (${newBlocks.length} 块, ${getSplitCacheStats()})`);
}

console.log(failed === 0 ? "\nALL EQUAL ✓" : `\n${failed} 个用例不一致 ✗`);
process.exit(failed === 0 ? 0 : 1);
