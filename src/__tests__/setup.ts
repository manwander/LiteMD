/**
 * Vitest 全局 setup（jsdom 环境补充）
 *
 * CodeMirror 的 EditorView 在每次 dispatch 后会异步触发一次布局测量
 * （measure），调用 Range / Element 的 getClientRects / getBoundingClientRect。
 * jsdom 未实现这些 API，会抛 TypeError 导致编辑器命令测试整文件失败。
 * 这里兜底返回「空矩形」，让测量流程安静跳过（不影响文档内容断言）。
 */
const EMPTY_RECT: DOMRect = {
  x: 0, y: 0, width: 0, height: 0,
  top: 0, left: 0, right: 0, bottom: 0,
  toJSON: () => ({}),
} as unknown as DOMRect;

const EMPTY_LIST: DOMRectList = {
  length: 0,
  item: () => null,
  [Symbol.iterator]: function* () {},
} as unknown as DOMRectList;

if (typeof Range !== "undefined") {
  if (!Range.prototype.getClientRects) {
    Range.prototype.getClientRects = () => EMPTY_LIST;
  }
  if (!Range.prototype.getBoundingClientRect) {
    Range.prototype.getBoundingClientRect = () => EMPTY_RECT;
  }
}

if (typeof Element !== "undefined") {
  if (!Element.prototype.getClientRects) {
    Element.prototype.getClientRects = () => EMPTY_LIST;
  }
  if (!Element.prototype.getBoundingClientRect) {
    Element.prototype.getBoundingClientRect = () => EMPTY_RECT;
  }
}

// jsdom 下 requestIdleCallback 通常不存在，fence-index 已做回退；
// 这里显式兜底，确保 scheduleFenceRebuild 的立即重建路径稳定。
if (typeof (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback !== "function") {
  (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback = (cb: (t: number) => void) => {
    return setTimeout(() => cb(Date.now()), 0) as unknown as number;
  };
}

// Svelte 4 在 jsdom 下依赖 requestAnimationFrame 触发 flush / 生命周期钩子
if (typeof (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame !== "function") {
  (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (cb: FrameRequestCallback) => {
    return setTimeout(cb, 0) as unknown as number;
  };
}
if (typeof (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame !== "function") {
  (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame = (id: number) => {
    clearTimeout(id);
  };
}
