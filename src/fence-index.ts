// 纯函数：代码块围栏检查点索引（CommonMark 长度感知状态机）。
// 用于 Enter 智能换行时判断光标是否在代码块内，避免 50MB 文档下逐行扫描百万行。
// 不依赖 CodeMirror，便于单元测试（见 scripts/test-fence.mjs）。

export interface FenceDoc {
  readonly lines: number;
  /** 行对象：from/to 为字符偏移（与 CodeMirror 的 Line 对齐）；text 可选，检测不依赖整行字符串分配 */
  line(n: number): { from: number; to: number; text?: string };
  /** 取 [from, to) 子串（等价于 CodeMirror 的 doc.sliceString，按需分配、不拷贝整行） */
  sliceString(from: number, to: number): string;
}

const BT = 96; // `
const TLD = 126; // ~
// 解析围栏行最多查看的字符数（前导空白 + 标记串 + 判定其后是否仅空白）
const FENCE_SCAN = 64;

/** 围栏行描述：标记字符码与连续长度。 */
export interface FenceMark {
  ch: number;
  len: number;
}

/**
 * 解析第 ln 行的围栏标记（开栏或闭栏的候选），返回 {ch,len} 或 null。
 * 对齐 CommonMark：仅允许 ≤3 空格缩进（制表符/≥4 空格视为缩进代码内容，非围栏）；
 * 标记须 ≥3 个连续 ` 或 ~。旧实现只认反引号、允许任意缩进、按奇偶计数，
 * 无法处理「代码块内含 ``` 示例」等嵌套/异长场景，会把块内误判为块外并破坏源码。
 */
export function parseFenceLine(doc: FenceDoc, ln: number): FenceMark | null {
  const line = doc.line(ln);
  const to = Math.min(line.to, line.from + FENCE_SCAN);
  const s = doc.sliceString(line.from, to);
  const len = s.length;
  if (len === 0) return null;
  let i = 0;
  let spaces = 0;
  while (i < len && s.charCodeAt(i) === 32) {
    spaces++;
    i++;
  }
  if (spaces > 3 || (i < len && s.charCodeAt(i) === 9)) return null; // 制表符缩进 → 非围栏
  const c = s.charCodeAt(i);
  if (c !== BT && c !== TLD) return null;
  let n = 0;
  while (i < len && s.charCodeAt(i) === c) {
    n++;
    i++;
  }
  if (n < 3) return null;
  return { ch: c, len: n };
}

/** 是否为开栏：标记之后允许 info string（仅 ` 围栏可带语言），`~` 围栏闭栏不得有内容。 */
function markerTailIsBlank(doc: FenceDoc, ln: number, mark: FenceMark): boolean {
  const line = doc.line(ln);
  // 跳过前导空白 + 标记串，检查其余是否全为空白
  const end = Math.min(line.to, line.from + FENCE_SCAN * 4);
  const s = doc.sliceString(line.from, end);
  let i = 0;
  while (i < s.length && s.charCodeAt(i) === 32) i++;
  let c = 0;
  while (i < s.length && s.charCodeAt(i) === mark.ch) {
    c++;
    i++;
  }
  for (; i < s.length; i++) {
    const k = s.charCodeAt(i);
    if (k !== 32 && k !== 9) return false;
  }
  return true;
}

// 状态机核心：从「进入某检查点时的开栏状态」逐行推进。open 为 null 表示块外。
// 编码进 Int32Array 检查点：0=块外；否则 (len<<1)|(ch===~?1:0)。
const FENCE_STEP = 512;
// 索引脏时的有界上扫窗口：该窗口内精确；超过窗口则保守返回 false（等同非代码块分支，不会错误插入内容）
const FENCE_RESCAN_LIMIT = 8192;

let ck: Int32Array = new Int32Array(0);
let dirty = false;
let rebuildScheduled = false;

/** 重建检查点索引（O(n)，建议在文档整体载入或空闲帧调用一次） */
export function rebuildFenceIndex(doc: FenceDoc): void {
  const n = Math.ceil(doc.lines / FENCE_STEP) + 1;
  const arr = new Int32Array(n);
  let open: FenceMark | null = null;
  for (let ln = 1; ln <= doc.lines; ln++) {
    if (ln > 1 && (ln - 1) % FENCE_STEP === 0) arr[(ln - 1) / FENCE_STEP] = encodeOpen(open);
    open = advance(doc, ln, open);
  }
  ck = arr;
  dirty = false;
}

function encodeOpen(open: FenceMark | null): number {
  return open ? ((open.len << 1) | (open.ch === TLD ? 1 : 0)) : 0;
}
function decodeOpen(v: number): FenceMark | null {
  return v === 0 ? null : { ch: v & 1 ? TLD : BT, len: v >> 1 };
}

/**
 * 状态机单步：给定进入第 ln 行前的开栏状态 open，返回离开该行后的开栏状态。
 * 块外 → 见围栏即开栏；块内 → 仅当为「同字符、长度 ≥ 开栏、其后全空白」的闭栏才闭合，
 * 否则该行视为块内内容（正确容纳块内出现的 ``` / ~~~ 示例）。
 */
function advance(doc: FenceDoc, ln: number, open: FenceMark | null): FenceMark | null {
  const f = parseFenceLine(doc, ln);
  if (!open) {
    return f; // 块外的围栏行视为开栏（无论是否有 info）
  }
  if (f && f.ch === open.ch && f.len >= open.len && markerTailIsBlank(doc, ln, f)) {
    return null; // 合法闭栏，块结束
  }
  return open; // 块内内容，状态不变
}

/** 标记索引落后（刚编辑过围栏相关文本时调用） */
export function markFenceDirty(): void {
  dirty = true;
}

export function isFenceIndexDirty(): boolean {
  return dirty;
}

/** 安排空闲时重建（避免每次编辑都全量扫描；无 requestIdleCallback 时立即重建） */
export function scheduleFenceRebuild(getDoc: () => FenceDoc): void {
  if (!dirty || rebuildScheduled) return;
  if (typeof requestIdleCallback !== "function") {
    rebuildFenceIndex(getDoc());
    return;
  }
  rebuildScheduled = true;
  requestIdleCallback(() => {
    rebuildScheduled = false;
    rebuildFenceIndex(getDoc());
  }, { timeout: 1500 });
}

/**
 * 判断第 posLine 行是否位于代码块「内容区」（开栏与闭栏之间，含闭栏行前）。
 * - 索引干净：取 posLine 所属检查点的开栏状态，向前推进至 posLine（O(≤511 行)）。
 * - 索引脏（刚编辑过围栏，空闲帧重建前）：从光标向上有界扫描（≤FENCE_RESCAN_LIMIT 行）；
 *   仅当覆盖到文档首行时按状态机精确判定；窗口被截断时保守返回 false（不会错误插入内容）。
 */
export function isInsideCodeBlock(doc: FenceDoc, posLine: number): boolean {
  if (posLine <= 1) return false;
  if (dirty) {
    const start = posLine <= FENCE_RESCAN_LIMIT ? 1 : Math.max(1, posLine - FENCE_RESCAN_LIMIT);
    if (start !== 1) return false; // 窗口截断，保守降级
    let open: FenceMark | null = null;
    for (let n = 1; n < posLine; n++) open = advance(doc, n, open);
    return open !== null;
  }
  const k = Math.floor((posLine - 1) / FENCE_STEP);
  let open = decodeOpen(k >= 0 && k < ck.length ? ck[k] : 0);
  for (let n = k * FENCE_STEP + 1; n < posLine; n++) open = advance(doc, n, open);
  return open !== null;
}

/** 兼容旧命名：第 ln 行是否为围栏标记行（开栏或闭栏候选）。 */
export function lineIsFenceOpen(doc: FenceDoc, ln: number): boolean {
  return parseFenceLine(doc, ln) !== null;
}

/** 计算「进入 posLine 行之前」的开栏状态（块内则返回其开栏描述，块外返回 null），复用检查点/有界上扫。 */
function stateEnteringLine(doc: FenceDoc, posLine: number): FenceMark | null {
  if (posLine <= 1) return null;
  if (dirty) {
    const start = posLine <= FENCE_RESCAN_LIMIT ? 1 : Math.max(1, posLine - FENCE_RESCAN_LIMIT);
    if (start !== 1) return null; // 窗口截断，保守视为块外（调用方据此安全降级）
    let open: FenceMark | null = null;
    for (let n = 1; n < posLine; n++) open = advance(doc, n, open);
    return open;
  }
  const k = Math.floor((posLine - 1) / FENCE_STEP);
  let open = decodeOpen(k >= 0 && k < ck.length ? ck[k] : 0);
  for (let n = k * FENCE_STEP + 1; n < posLine; n++) open = advance(doc, n, open);
  return open;
}

/**
 * 已知第 insideLine 行处于某代码块内，向后查找该块的闭合围栏行号；未找到返回 -1。
 * 用长度/字符感知判定，避免停在块内出现的 ``` 示例或把 ~~~ 与 ``` 错配。
 */
export function findFenceCloseLine(doc: FenceDoc, insideLine: number): number {
  const open = stateEnteringLine(doc, insideLine);
  if (!open) return -1;
  for (let n = insideLine; n <= doc.lines; n++) {
    const f = parseFenceLine(doc, n);
    if (f && f.ch === open.ch && f.len >= open.len && markerTailIsBlank(doc, n, f)) return n;
  }
  return -1;
}
