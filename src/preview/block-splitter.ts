// 预览块分割：将 markdown 文档按顶层块切分，供 VirtualPreview 按需渲染。
//
// 设计：
// 1. 用空行扫描切分顶层块，同时保持 fenced code (```/~~~) 完整（围栏内空行不切）。
// 2. 每个块记录 (srcBegin, srcEnd, type)，渲染时调用 md.render(slice) 单独渲染。
// 3. 分段级增量缓存：文档按块边界切成 ~256 行的段，段内容哈希不变时整段复用切块结果，
//    打字通常只重切 1 段（O(段) 而非 O(全文)）。
//
// 超大文档零分配原则：
// - 全程不 split('\n')、不 join、不 slice 大字符串；行边界用 indexOf 扫描，
//   哈希/分类/预览摘要均基于 (begin, end) 索引直接遍历 charCodeAt。

import { sanitizeHtml } from "../sanitize";

type MarkdownItLike = {
  parse: (src: string, env: unknown) => Array<{ type: string; map?: [number, number] | null }>;
  render: (src: string) => string;
};

export interface PreviewBlock {
  /** 在源 markdown 字符串中的字符起止范围 [srcBegin, srcEnd) */
  srcBegin: number;
  srcEnd: number;
  /** 块类型（heading_open/fence/paragraph_open/hr/bullet_list_open/blockquote_open…） */
  type: string;
  /** 简短摘要（前 40 字符，用于可访问性标签） */
  preview: string;
  /** 块内容哈希（切块时一并计算，消费方无需再对全文做哈希遍历） */
  hash: string;
  /** 估算高度（切块时一并计算，等价 estimateBlockHeight） */
  estH: number;
}

// ---------------- 分段缓存 ----------------

/** 每段目标行数；段边界始终落在块边界上（不会切断段落/围栏） */
const SEGMENT_LINES = 256;
/** 段缓存上限，超限整体清空（内容哈希键不会误命中） */
const MAX_SEG_CACHE = 4096;

interface SegmentBlock {
  /** 相对段首行起始 offset 的字符偏移 */
  relBegin: number;
  relEnd: number;
  type: string;
  preview: string;
  /** 块内容哈希（只依赖块内容，与绝对位置无关，随段缓存复用） */
  hash: string;
  /** 估算高度（只依赖块内容与类型，随段缓存复用） */
  estH: number;
}

interface SegmentEntry {
  blocks: SegmentBlock[];
}

const segCache = new Map<string, SegmentEntry>();
let segHits = 0;
let segMisses = 0;

// ---- 快速路径：记忆最近一次切分结果 ----
// 调用方若能给出「相对上一次 source 的脏区间」（CodeMirror 变更累计），
// 则脏区前后的段无需重新哈希，直接按位置/结构匹配复用，
// 打字（单点小编辑）时切块成本从 O(全文哈希) 降为 O(行扫描)。
interface PrevSegment {
  begin: number;
  end: number;
  /** 段内首个 raw 在 raws 数组中的下标 */
  i0: number;
  /** 段内 raw 数量 */
  cnt: number;
  /** 绝对偏移的块对象（编辑未波及的段直接按引用复用，零分配） */
  abs: PreviewBlock[];
}

interface LastSplit {
  source: string;
  segments: PrevSegment[];
  raws: RawBlock[];
  lineStarts: number[];
}
let lastSplit: LastSplit | null = null;

/** 相对上一次推送的 source 的脏区间：old [from,to) 被替换为长 insert 的新内容 */
export interface EditRange {
  from: number;
  to: number;
  insert: number;
}

/** 调试/基准用：段缓存命中统计 */
export function getSplitCacheStats(): string {
  return `segments cached=${segCache.size} hits=${segHits} misses=${segMisses}`;
}

/** 调试/基准用：清空段缓存与计数（模拟冷启动首帧） */
export function clearSplitCache(): void {
  segCache.clear();
  segHits = 0;
  segMisses = 0;
  lastSplit = null;
}

/** 调试/基准用：仅失效恒等短路记忆（保留段缓存），强制下一次走全量路径 */
export function resetLastSplit(): void {
  lastSplit = null;
}

// ---------------- 区间哈希（无 slice 分配） ----------------

/**
 * 双路哈希 + 长度后缀，对 source[begin, end) 计算内容键。
 * 碰撞概率可忽略；即使误命中，预览缓存侧 HTML 与源串一一对应，下次重渲会自纠。
 */
export function hashRange(src: string, begin: number, end: number): string {
  let h1 = 0x811c9dc5 | 0;
  let h2 = (0x01000193 ^ (end - begin)) | 0;
  for (let i = begin; i < end; i++) {
    const c = src.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x85ebca6b);
  }
  return (h1 >>> 0).toString(36) + ":" + (h2 >>> 0).toString(36) + ":" + (end - begin);
}

// ---------------- 行级扫描工具（均不产生子串分配） ----------------

function isBlankLineRange(src: string, b: number, e: number): boolean {
  for (let i = b; i < e; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9 && c !== 13) return false; // 空格/Tab/CR 之外即非空行
  }
  return true;
}

/** 检测行首围栏标记（≤3 个空格/Tab 缩进 + 3 个以上 ` 或 ~，等价旧 /(\s{0,3})(`{3,}|~{3,})/）。返回标记字符码，未命中返回 0 */
function fenceMarkAt(src: string, b: number, e: number): number {
  let i = b;
  let sp = 0;
  while (i < e && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) {
    sp++;
    i++;
  }
  if (sp > 3 || i >= e) return 0;
  const c = src.charCodeAt(i);
  if (c !== 96 && c !== 126) return 0; // ` 或 ~
  let n = 0;
  while (i < e && src.charCodeAt(i) === c) {
    n++;
    i++;
  }
  return n >= 3 ? c : 0;
}

/** 行首（跳过空白）是否为 fenceMark 的 3 连（用于围栏闭合判定，等价旧 trimStart().startsWith） */
function lineStartsWith3(src: string, b: number, e: number, fenceMark: number): boolean {
  let i = b;
  while (i < e && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
  for (let k = 0; k < 3; k++) {
    if (i + k >= e || src.charCodeAt(i + k) !== fenceMark) return false;
  }
  return true;
}

function isHeadingStart(src: string, b: number, e: number): boolean {
  let i = b;
  while (i < e && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++; // 与旧 .trim() 对齐
  if (i >= e || src.charCodeAt(i) !== 35) return false; // #
  let n = 0;
  while (i < e && src.charCodeAt(i) === 35) {
    n++;
    i++;
  }
  if (n < 1 || n > 6) return false;
  if (i >= e) return false;
  const c = src.charCodeAt(i);
  return c === 32 || c === 9; // # 后跟空白
}

function isFenceStart(src: string, b: number, e: number): boolean {
  let i = b;
  while (i < e && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
  if (i >= e) return false;
  const c = src.charCodeAt(i);
  if (c !== 96 && c !== 126) return false;
  let n = 0;
  while (i < e && src.charCodeAt(i) === c) {
    n++;
    i++;
  }
  return n >= 3;
}

function isHrLine(src: string, b: number, e: number): boolean {
  let i = b;
  while (i < e && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
  if (i >= e) return false;
  const c = src.charCodeAt(i);
  if (c !== 45 && c !== 42 && c !== 95) return false; // - * _
  let n = 0;
  while (i < e) {
    const d = src.charCodeAt(i);
    if (d === c) n++;
    else if (d !== 32 && d !== 9) return false;
    i++;
  }
  return n >= 3;
}

/** 行首（跳空白）以 短横线/星号/加号 或 数字. 开头并跟空白 → 列表项；以 > 跟空白开头 → 引用 */
function containerKindAt(src: string, b: number, e: number): "bullet_list_open" | "blockquote_open" | null {
  let i = b;
  while (i < e && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
  if (i >= e) return null;
  const c = src.charCodeAt(i);
  if (c === 45 || c === 42 || c === 43) {
    // - * + 后需跟空白（行尾不算）
    if (i + 1 < e && (src.charCodeAt(i + 1) === 32 || src.charCodeAt(i + 1) === 9)) return "bullet_list_open";
    return null;
  }
  if (c >= 48 && c <= 57) {
    let j = i;
    while (j < e && src.charCodeAt(j) >= 48 && src.charCodeAt(j) <= 57) j++;
    if (j < e && src.charCodeAt(j) === 46 && j + 1 < e &&
        (src.charCodeAt(j + 1) === 32 || src.charCodeAt(j + 1) === 9)) {
      return "bullet_list_open";
    }
    return null;
  }
  if (c === 62) {
    // > 后跟空白（等价旧 /^>\s/；行尾不满足）
    if (i + 1 < e) {
      const d = src.charCodeAt(i + 1);
      if (d === 32 || d === 9 || d === 10 || d === 11 || d === 12 || d === 13) return "blockquote_open";
    }
    return null;
  }
  return null;
}

/** 预览摘要：折叠空白后取前 40 字符（等价旧 text.replace(/\s+/g,' ').slice(0,40)，
 *  含前导/尾部空白折叠成的单空格） */
function buildPreview(src: string, b: number, e: number): string {
  const isWs = (c: number) => c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12;
  const prefix = b < e && isWs(src.charCodeAt(b)) ? " " : "";
  const suffix = e > b && isWs(src.charCodeAt(e - 1)) ? " " : "";
  const words: string[] = [];
  let len = prefix.length;
  let ws = b;
  for (let i = b; i <= e; i++) {
    const c = i < e ? src.charCodeAt(i) : 32; // 末尾强制收尾
    if (isWs(c)) {
      if (i > ws) {
        const w = src.slice(ws, i); // 单词级小切片，总量受 40 字符预算约束
        words.push(w);
        len += w.length + 1;
        if (len >= 42) break;
      }
      ws = i + 1;
    }
  }
  return (prefix + words.join(" ") + suffix).slice(0, 40);
}

// ---------------- 空行切分（零分配） ----------------

interface RawBlock {
  /** 块首行行号（行边界扫描的产物，供分段缓存定位） */
  startLine: number;
  begin: number;
  end: number;
}

/**
 * 按空行切分 markdown，但保持 fenced code 完整。
 * 行边界用 indexOf 扫描（不 split 全文），块只记录区间与行号，不产生块文本分配。
 */
function splitByBlankLines(src: string, lineStarts: number[]): RawBlock[] {
  const result: RawBlock[] = [];
  const n = lineStarts.length;

  let curStartLine = -1;
  let curBegin = 0;
  let curLen = 0;
  let inFence = false;
  let fenceMark = 0;

  const flush = (endLine: number) => {
    if (curLen > 0) {
      const end = endLine < n ? lineStarts[endLine] : src.length;
      result.push({ startLine: curStartLine, begin: curBegin, end });
    }
    curLen = 0;
  };

  for (let i = 0; i < n; i++) {
    const lb = lineStarts[i];
    let le = i + 1 < n ? lineStarts[i + 1] - 1 : src.length; // 排除行尾 \n
    if (le > lb && src.charCodeAt(le - 1) === 13) le--; // CRLF：排除行尾 \r
    const mark = fenceMarkAt(src, lb, le);
    if (mark) {
      if (!inFence) {
        if (curLen > 0) flush(i);
        inFence = true;
        fenceMark = mark;
        curStartLine = i;
        curBegin = lb;
        curLen = 1;
      } else if (lineStartsWith3(src, lb, le, fenceMark)) {
        curLen++;
        flush(i + 1);
        inFence = false;
        fenceMark = 0;
        curStartLine = i + 1;
        continue;
      } else {
        curLen++;
      }
    } else if (inFence) {
      curLen++;
    } else if (isBlankLineRange(src, lb, le) && curLen > 0) {
      flush(i);
      curStartLine = i + 1;
    } else {
      // 非空行，或块首前的空行（旧算法：curLines 为空时空行也被吸收，
      // 形成前导空行块，后续由空白块过滤丢弃）
      if (curLen === 0) {
        curStartLine = i;
        curBegin = lb;
      }
      curLen++;
    }
  }
  if (curLen > 0) flush(n);
  return result;
}

// ---------------- 块分类（区间扫描，复用行边界） ----------------

/** 预览扫描终点：含块尾行内 \r（旧 text 含 \r 会被折叠成空格），但不含块尾 \n */
function previewEnd(src: string, b: number, e: number): number {
  return e > b && src.charCodeAt(e - 1) === 10 ? e - 1 : e;
}

function classifyRange(src: string, b: number, e: number): string {
  // 定位块首行范围（begin 总在行首；le 兼容 CRLF）
  let lb = b;
  while (lb > 0 && src.charCodeAt(lb - 1) !== 10) lb--;
  const le0 = src.indexOf("\n", lb);
  let firstEnd = le0 === -1 || le0 > e ? e : le0;
  if (firstEnd > lb && src.charCodeAt(firstEnd - 1) === 13) firstEnd--;

  if (isHeadingStart(src, lb, firstEnd)) return "heading_open";
  if (isFenceStart(src, lb, firstEnd)) return "fence";
  if (isHrLine(src, lb, firstEnd)) return "hr";

  // 整段任一行匹配则视为容器（等价旧逐行扫描）
  let p = lb;
  while (p < e) {
    let q = src.indexOf("\n", p);
    if (q === -1 || q >= e) q = e;
    else if (q > p && src.charCodeAt(q - 1) === 13) q--; // CRLF
    const kind = containerKindAt(src, p, q);
    if (kind) return kind;
    p = q + 1;
  }
  return "paragraph_open";
}

/** 旧算法会丢弃纯空白块（!rb.text.trim()）：前导空行被吸收进首块时触发 */
function isAllWs(source: string, b: number, e: number): boolean {
  for (let i = b; i < e; i++) {
    const c = source.charCodeAt(i);
    if (c !== 32 && c !== 9 && c !== 10 && c !== 13 && c !== 11 && c !== 12) return false;
  }
  return true;
}

/** 由 raw 块构造 PreviewBlock（分类/摘要/哈希/估算高度一次性完成） */
function makeBlock(source: string, rb: RawBlock): PreviewBlock {
  const type = classifyRange(source, rb.begin, rb.end);
  const block: PreviewBlock = {
    srcBegin: rb.begin,
    srcEnd: rb.end,
    type,
    preview: buildPreview(source, rb.begin, previewEnd(source, rb.begin, rb.end)),
    hash: hashRange(source, rb.begin, rb.end),
    estH: 0,
  };
  block.estH = estimateBlockHeight(block, source);
  return block;
}

/** 从段内 raw 块构造相对偏移的缓存条目（跳过纯空白块，复刻旧算法） */
function buildRelBlocks(source: string, raws: RawBlock[], i: number, j: number, segBegin: number): SegmentBlock[] {
  const rel: SegmentBlock[] = [];
  for (let k = i; k < j; k++) {
    const rb = raws[k];
    if (isAllWs(source, rb.begin, rb.end)) continue;
    const type = classifyRange(source, rb.begin, rb.end);
    const preview = buildPreview(source, rb.begin, previewEnd(source, rb.begin, rb.end));
    const hash = hashRange(source, rb.begin, rb.end);
    const tmp: PreviewBlock = { srcBegin: rb.begin, srcEnd: rb.end, type, preview, hash, estH: 0 };
    tmp.estH = estimateBlockHeight(tmp, source);
    rel.push({ relBegin: rb.begin - segBegin, relEnd: rb.end - segBegin, type, preview, hash, estH: tmp.estH });
  }
  return rel;
}

/** 把相对偏移块映射为绝对偏移的 PreviewBlock */
function absFromRel(rel: SegmentBlock[], segBegin: number): PreviewBlock[] {
  const out: PreviewBlock[] = [];
  for (const sb of rel) {
    out.push({
      srcBegin: segBegin + sb.relBegin,
      srcEnd: segBegin + sb.relEnd,
      type: sb.type,
      preview: sb.preview,
      hash: sb.hash,
      estH: sb.estH,
    });
  }
  return out;
}

/**
 * 把 markdown 文本切成"块"数组，每个块对应一个独立的渲染单元。
 *
 * 三层增量：
 * 1. edits（脏区间）快速路径：编辑区前后的段按位置直接复用（不哈希），
 *    仅对跨越编辑区的段重新切分 —— 打字时切块成本 O(行扫描)，无全文哈希。
 * 2. 分段内容哈希缓存：未命中快速路径的段若内容未变仍整段复用。
 * 3. 块自带 hash/estH：消费方（VirtualPreview）无需再对全文做哈希与估算遍历。
 *
 * edits 必须相对上一次传入的 source（即 lastSplit.source）精确描述全部变更，
 * 不满足时传 undefined 走全量路径（内部仍享内容缓存）。
 */
export function splitIntoBlocks(_md: MarkdownItLike | null, source: string, edits?: EditRange): PreviewBlock[] {
  if (!source) {
    lastSplit = null;
    return [];
  }

  // 内容未变（如高亮版本变化触发的 rebuild）：直接返回上次结果，O(1)
  if (lastSplit && lastSplit.source === source) {
    const blocks: PreviewBlock[] = [];
    for (const s of lastSplit.segments) blocks.push(...s.abs);
    return blocks;
  }

  if (edits && lastSplit) {
    const fast = splitFast(source, edits);
    if (fast) return fast;
  }

  // ---- 全量路径（含内容缓存）----
  const lineStarts: number[] = [0];
  let p = source.indexOf("\n");
  while (p !== -1) {
    lineStarts.push(p + 1);
    p = source.indexOf("\n", p + 1);
  }

  const raws = splitByBlankLines(source, lineStarts);
  if (raws.length === 0) {
    lastSplit = null;
    return [];
  }

  const blocks: PreviewBlock[] = [];
  const segments: PrevSegment[] = [];

  if (raws.length === 1) {
    // 单块文档无需分段缓存
    const rb = raws[0];
    if (isAllWs(source, rb.begin, rb.end)) {
      lastSplit = null;
      return [];
    }
    const b = makeBlock(source, rb);
    lastSplit = { source, segments: [{ begin: rb.begin, end: rb.end, i0: 0, cnt: 1, abs: [b] }], raws, lineStarts };
    return [b];
  }

  let i = 0;
  while (i < raws.length) {
    // 从 i 起累积到 SEGMENT_LINES 行形成一段（段边界永远落在块边界上，
    // 围栏块是单个 raw 块，不会被段边界切断）
    const segBaseLine = raws[i].startLine;
    let j = i;
    while (j < raws.length) {
      const endLine = j + 1 < raws.length ? raws[j + 1].startLine : lineStarts.length;
      if (j > i && endLine - segBaseLine >= SEGMENT_LINES) break;
      j++;
    }

    const segBegin = raws[i].begin;
    const segEnd = raws[j - 1].end;
    const key = hashRange(source, segBegin, segEnd);
    const cached = segCache.get(key);
    let abs: PreviewBlock[];
    if (cached) {
      segHits++;
      abs = absFromRel(cached.blocks, segBegin);
      blocks.push(...abs);
    } else {
      segMisses++;
      const rel = buildRelBlocks(source, raws, i, j, segBegin);
      if (segCache.size >= MAX_SEG_CACHE) segCache.clear();
      segCache.set(key, { blocks: rel });
      abs = absFromRel(rel, segBegin);
      blocks.push(...abs);
    }
    segments.push({ begin: segBegin, end: segEnd, i0: i, cnt: j - i, abs });
    i = j;
  }
  lastSplit = { source, segments, raws, lineStarts };
  return blocks;
}

/**
 * 脏区间快速路径：edits 精确描述了 lastSplit.source → source 的全部变更时，
 * 编辑区前后的段按位置/长度匹配直接复用（零哈希），仅重切跨编辑区的段。
 * 任何前置条件不满足返回 null，由调用方回退全量路径。
 */
function splitFast(source: string, edit: EditRange): PreviewBlock[] | null {
  const prev = lastSplit!;
  const delta = edit.insert - (edit.to - edit.from);
  // 长度校验：防止 edits 与真实 diff 不一致导致错误复用
  if (source.length !== prev.source.length + delta) return null;
  if (edit.from < 0 || edit.to > prev.source.length || edit.from > edit.to || edit.insert < 0) return null;

  const prevRaws = prev.raws;

  // 行边界：复用旧 lineStarts，仅重扫插入区（O(变化)而非 O(全文)）。
  // 旧 [0, from) 的行首不变；旧 [to, oldLen) 的行首整体 +delta；插入区重新 indexOf。
  const prevLS = prev.lineStarts;
  const lineStarts: number[] = [];
  let pi = 0;
  while (pi < prevLS.length && prevLS[pi] <= edit.from) {
    lineStarts.push(prevLS[pi]);
    pi++;
  }
  // 编辑点所在行的行首（可能 < from，需回溯到最后一个 ≤ from 的行首，上面循环已保证；
  // 行首恰等于 edit.from 的行在编辑后仍存在，必须保留，否则该行与下一行被错误合并）
  let p = source.indexOf("\n", lineStarts.length ? Math.max(lineStarts[lineStarts.length - 1], edit.from) : edit.from);
  const insertEnd = edit.from + edit.insert;
  while (p !== -1 && p < insertEnd) {
    lineStarts.push(p + 1);
    p = source.indexOf("\n", p + 1);
  }
  // 旧 [to, ...) 的行首平移 delta；跳过落在被替换区 [from, to) 内的旧行首；
  // 衔接处去重（插入内容以换行结尾时可能与平移后的旧行首重合）
  while (pi < prevLS.length && prevLS[pi] < edit.to) pi++;
  for (; pi < prevLS.length; pi++) {
    const v = prevLS[pi] + delta;
    if (lineStarts.length === 0 || lineStarts[lineStarts.length - 1] !== v) lineStarts.push(v);
  }
  if (lineStarts.length === 0 || lineStarts[0] !== 0) lineStarts.unshift(0);

  const raws = splitByBlankLines(source, lineStarts);
  if (raws.length === 0) {
    lastSplit = null;
    return [];
  }

  // 扩展脏区到完整 raw 块：旧坐标下与 [from,to) 相交（含边界合并情形）的 raw 都需重切。
  // 空行删除导致相邻块合并时，被合并的块必然与编辑区相邻，会被此规则覆盖。
  let z0 = -1; // 旧 raws 下标区间 [z0, z1)
  let z1 = prevRaws.length;
  for (let k = 0; k < prevRaws.length; k++) {
    const rb = prevRaws[k];
    if (rb.end > edit.from && rb.begin < edit.to) {
      if (z0 < 0) z0 = k;
      z1 = k + 1;
    }
  }
  if (z0 < 0) {
    // 编辑落在块间空白间隙：前后相邻块可能与插入内容合并，一并纳入重切
    let a = 0;
    while (a < prevRaws.length && prevRaws[a].end <= edit.from) a++;
    z0 = Math.max(0, a - 1);
    z1 = Math.min(prevRaws.length, a + 1);
  }

  const zoneNewBegin = z0 < prevRaws.length ? prevRaws[z0].begin : source.length;
  const zoneOldEnd = z1 > 0 ? prevRaws[z1 - 1].end : 0;
  const zoneNewEnd = zoneOldEnd + delta;

  // 新 raws 中脏区对应的下标区间 [nz0, nz1)
  let nz0 = raws.length;
  for (let k = 0; k < raws.length; k++) {
    if (raws[k].end > zoneNewBegin) {
      nz0 = k;
      break;
    }
  }
  let nz1 = nz0;
  while (nz1 < raws.length && raws[nz1].begin < zoneNewEnd) nz1++;

  const prevSegs = prev.segments;
  const nseg = prevSegs.length;

  // 前缀段：旧段全部 raw 位于脏区之前（下标 < z0）→ 位置与内容都未变，按引用复用（零分配零哈希）
  let ps = 0;
  const prefix: PreviewBlock[] = [];
  const newSegments: PrevSegment[] = [];
  while (ps < nseg && prevSegs[ps].i0 + prevSegs[ps].cnt <= z0) {
    const s = prevSegs[ps];
    prefix.push(...s.abs);
    newSegments.push({ begin: s.begin, end: s.end, i0: s.i0, cnt: s.cnt, abs: s.abs });
    ps++;
  }

  // 后缀段：raw 全部位于脏区之后（旧下标 >= z1）的旧段，内容未变、整体偏移 +delta。
  // 结构化映射：新 raw 下标 = nz1 + (旧 raw 下标 - z1)，逐段校验首尾 raw 位置；
  // 校验失败即放弃剩余后缀（中段重切并享内容缓存）。不用长度匹配，避免碰撞误复用。
  const suffixAbs: PreviewBlock[][] = [];
  const suffixMeta: PrevSegment[] = [];
  let nk = raws.length;
  {
    let pe = nseg;
    while (pe - 1 >= ps && prevSegs[pe - 1].i0 >= z1) pe--;
    for (let s = pe; s < nseg; s++) {
      const oldS = prevSegs[s];
      const k2 = nz1 + (oldS.i0 - z1);
      const kEnd = k2 + oldS.cnt;
      if (kEnd > raws.length) break;
      if (raws[k2].begin !== oldS.begin + delta || raws[kEnd - 1].end !== oldS.end + delta) break;
      const abs: PreviewBlock[] = [];
      for (const ob of oldS.abs) {
        abs.push({
          srcBegin: ob.srcBegin + delta,
          srcEnd: ob.srcEnd + delta,
          type: ob.type,
          preview: ob.preview,
          hash: ob.hash,
          estH: ob.estH,
        });
      }
      if (suffixAbs.length === 0) nk = k2; // 中段终点 = 首个（最靠前）后缀段起点

      suffixAbs.push(abs);

      suffixMeta.push({ begin: oldS.begin + delta, end: oldS.end + delta, i0: k2, cnt: oldS.cnt, abs });
    }
  }

  // 中段（脏区及其两侧残余）：按常规分段 + 内容缓存（分段仅影响缓存粒度，不影响块正确性）。
  // 起点 = 前缀段消费完的 raw 下标：与脏区同段但位于脏区前的 raw 不能丢；
  // 脏区前的 raw 未偏移，新旧下标一致（残余恰为脏区本身时改用新侧下标 nz0）。
  const midBlocks: PreviewBlock[] = [];
  const midSegments: PrevSegment[] = [];
  let mi = ps > 0 ? prevSegs[ps - 1].i0 + prevSegs[ps - 1].cnt : 0;
  if (mi === z0) mi = nz0;
  while (mi < nk) {
    const segBaseLine = raws[mi].startLine;
    let j = mi;
    while (j < nk) {
      const endLine = j + 1 < nk ? raws[j + 1].startLine : lineStarts.length;
      if (j > mi && endLine - segBaseLine >= SEGMENT_LINES) break;
      j++;
    }
    const segBegin = raws[mi].begin;
    const segEnd = raws[j - 1].end;
    const key = hashRange(source, segBegin, segEnd);
    const cached = segCache.get(key);
    let abs: PreviewBlock[];
    if (cached) {
      segHits++;
      abs = absFromRel(cached.blocks, segBegin);
    } else {
      segMisses++;
      const rel = buildRelBlocks(source, raws, mi, j, segBegin);
      if (segCache.size >= MAX_SEG_CACHE) segCache.clear();
      segCache.set(key, { blocks: rel });
      abs = absFromRel(rel, segBegin);
    }
    midBlocks.push(...abs);
    midSegments.push({ begin: segBegin, end: segEnd, i0: mi, cnt: j - mi, abs });
    mi = j;
  }

  const blocks = prefix.concat(midBlocks);
  const segs = newSegments.concat(midSegments);
  for (let s = 0; s < suffixAbs.length; s++) {
    blocks.push(...suffixAbs[s]);
    segs.push(suffixMeta[s]);
  }
  lastSplit = { source, segments: segs, raws, lineStarts };
  return blocks;
}

/**
 * 单独渲染一个块：从 source 中取出块对应的源串，调用 md.render 单独渲染。
 * 返回该块的 HTML 字符串。
 */
export function renderBlock(md: MarkdownItLike, source: string, block: PreviewBlock): string {
  // 跳过尾部空行（避免产生空 paragraph），同时去掉 leading 空行（与 markdown-it 解析一致）
  let begin = block.srcBegin;
  let end = block.srcEnd;
  while (begin < end && source.charCodeAt(begin) === 10) begin++;
  while (end > begin) {
    const c = source.charCodeAt(end - 1);
    if (c !== 10 && c !== 32 && c !== 9) break;
    end--;
  }
  if (begin >= end) return "";
  const slice = source.slice(begin, end); // 渲染必须有子串，仅此处分配（只针对视口内块）
  // C-01：预览是 {@html} 注入点，清洗必须是渲染链路的最后一步。
  // 顺序 render → postProcess（生成任务列表 checkbox）→ sanitize（统一白名单收口）。
  return sanitizeHtml(postProcessHtml(md.render(slice)));
}

/**
 * 后处理 HTML：把任务列表 - [ ] / - [x] 渲染为带复选框的 li。
 */
function postProcessHtml(html: string): string {
  return html
    .replace(/<li>\[ \] /g, '<li class="task"><input type="checkbox" disabled> ')
    .replace(/<li>\[[xX]\] /g, '<li class="task"><input type="checkbox" checked disabled> ');
}

/**
 * 估算块的渲染高度（像素），用于未渲染时的占位。
 * 基于 (srcBegin, srcEnd) 区间扫描行数，不产生 slice 分配。
 * 渲染后会用 ResizeObserver 实测校正。
 */
export function estimateBlockHeight(block: PreviewBlock, source: string, lineHeight = 1.7): number {
  const b = block.srcBegin;
  const e = block.srcEnd;
  let lines = 1;
  for (let i = b; i < e; i++) {
    if (source.charCodeAt(i) === 10) lines++;
  }

  switch (block.type) {
    case "heading_open": {
      // 与旧 slice.match(/^(#+)/) 对齐：不跳前导空格，从块首直接数 #
      let level = 0;
      let i = b;
      while (i < e && source.charCodeAt(i) === 35) {
        level++;
        i++;
      }
      if (level === 0) level = 1;
      // H1 2em / H2 1.6em / H3 1.4em / ...
      const fontSize = 2.0 - (level - 1) * 0.15;
      return Math.ceil(fontSize * 16 * 1.4) + Math.ceil(lineHeight * 16 * 0.5);
    }
    case "fence":
    case "code_block":
      // 每行代码 ~1.4em + padding
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
      return Math.ceil(((e - b) / 80) * lineHeight * 14) + 16;
    case "paragraph_open":
    default: {
      // 段落：按可见字符估算行数
      const visibleChars = e - b;
      const charsPerLine = 60;
      const textLines = Math.ceil(visibleChars / charsPerLine);
      return Math.ceil(textLines * lineHeight * 14) + 16;
    }
  }
}
