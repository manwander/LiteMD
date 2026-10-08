// 图片转码 Worker 的通信协议（客户端 ⇄ Worker 单一事实来源）。
//
// 背景（C-1 修复）：客户端曾发送嵌套载荷 `{ blob, opts }`，而 Worker 端手抄了一份「扁平」
// 的 `{ blob, maxEdge, quality, lossless, format }` 类型并直接扁平解构，导致 maxEdge=undefined
// → OffscreenCanvas 尺寸为 NaN → Worker 抛错 → 粘贴/拖拽图片在目标平台上 100% 失败。
// 两端类型分处不同编译上下文，tsc 无法跨 Worker 边界发现这个错配。
// 现在两端都从这里 import 同一组类型，任何载荷形状改动都会在两侧同时编译报错。

export type ImageFormat = "webp" | "png";

export interface ImageProcessOptions {
  maxEdge: number;
  quality: number; // 0..1
  lossless: boolean;
  format: ImageFormat;
}

/** 客户端 postMessage 的载荷：{ blob, opts }（opts 嵌套，勿扁平化） */
export interface ImageWorkerRequest {
  blob: Blob;
  opts: ImageProcessOptions;
}

export interface ImageWorkerSuccess {
  bytes: Uint8Array;
  format: ImageFormat;
  width: number;
  height: number;
}

export interface ImageWorkerError {
  error: string;
}

export type ImageWorkerResponse = ImageWorkerSuccess | ImageWorkerError;

/** 纯函数：按最长边等比缩放，返回取整后的目标宽高（>=1）。
 *  对非法/缺省 maxEdge 做防御：非有限数或 <=0 时视为「不缩放」，避免重演 NaN 崩溃。 */
export function computeScaledDims(
  width: number,
  height: number,
  maxEdge: number
): { w: number; h: number } {
  const denom = Math.max(width, height);
  const cap = Number.isFinite(maxEdge) && maxEdge > 0 ? maxEdge : denom;
  const scale = denom > 0 ? Math.min(1, cap / denom) : 1;
  return {
    w: Math.max(1, Math.round(width * scale)),
    h: Math.max(1, Math.round(height * scale)),
  };
}
