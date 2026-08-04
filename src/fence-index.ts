// 纯函数：代码块围栏（```）奇偶检查点索引。
// 用于 Enter 智能换行时判断光标是否在代码块内，避免 50MB 文档下逐行扫描百万行。
// 不依赖 CodeMirror，便于单元测试（见 scripts/test-fence.mjs）。

export interface FenceDoc {
  readonly lines: number;
  /** 行对象：from/to 为字符偏移（与 CodeMirror 的 Line 对齐）；text 可选，检测不依赖整行字符串分配 */
  line(n: number): { from: number; to: number; text?: string };
  /** 取 [from, to) 子串（等价于 CodeMirror 的 doc.sliceString，按需分配、不拷贝整行） */
  sliceString(from: number, to: number): string;
}

// 检测第 ln 行是否为代码块起始围栏（``` 起，≥3 个连续反引号）。
// 仅取行首至多 FENCE_SCAN 字符（含前导空白 + 3 反引号）做 charCode 扫描，
// 避免对整行字符串 sliceString 分配——50MB 文档下旧实现逐行分配整行字符串（约百万次），
// 在流式载入末尾同步重建时造成 ~1.3s 冻结。语义与旧 /^\s*```/.test(line) 一致：
// 前导任意空白后接 ≥3 个反引号即视为围栏起始。
const FENCE_SCAN = 32;
export function lineIsFenceOpen(doc: FenceDoc, ln: number): boolean {
  const line = doc.line(ln);
  const to = Math.min(line.to, line.from + FENCE_SCAN);
  const s = doc.sliceString(line.from, to);
  let i = 0;
  const len = s.length;
  if (len === 0) return false;
  while (i < len && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
  let bt = 0;
  while (i < len && s.charCodeAt(i) === 96) { bt++; i++; }
  return bt >= 3;
}

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
  let f = 0;
  for (let ln = 1; ln <= doc.lines; ln++) {
    if (ln > 1 && (ln - 1) % FENCE_STEP === 0) arr[(ln - 1) / FENCE_STEP] = f;
    if (lineIsFenceOpen(doc, ln)) f++;
  }
  ck = arr;
  dirty = false;
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
 * 判断第 posLine 行是否在代码块内（围栏奇偶）。
 * - 索引干净：O(≤511 行) 精确。
 * - 索引脏（刚编辑过围栏，空闲帧重建前）：从光标向上有界扫描（≤FENCE_RESCAN_LIMIT 行）。
 *   仅当扫描覆盖到文档首行（start===1，即整段精确）时返回真实奇偶；
 *   窗口被截断（start>1，无法判定光标前方的围栏奇偶）时**保守返回 false**，
 *   等同「非代码块」分支——smartEnter 不会错误插入内容，至多短暂不跳出代码块，
 *   待空闲帧重建索引后即恢复精确（索引脏为瞬态，仅发生在编辑围栏后的 ≤1.5s 内）。
 */
export function isInsideCodeBlock(doc: FenceDoc, posLine: number): boolean {
  if (dirty) {
    const start = posLine <= FENCE_RESCAN_LIMIT ? 1 : Math.max(1, posLine - FENCE_RESCAN_LIMIT);
    if (start === 1) {
      let f = 0;
      for (let n = 1; n < posLine; n++) {
        if (lineIsFenceOpen(doc, n)) f++;
      }
      return f % 2 === 1;
    }
    return false; // 窗口截断，保守降级
  }
  const k = Math.floor((posLine - 1) / FENCE_STEP);
  let f = k >= 0 && k < ck.length ? ck[k] : 0;
  for (let n = k * FENCE_STEP + 1; n < posLine; n++) {
    if (lineIsFenceOpen(doc, n)) f++;
  }
  return f % 2 === 1;
}
