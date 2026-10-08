// 粘贴图片转码客户端：把解码 / 降采样 / WebP 编码卸载到 Worker，
// 主线程只接收数百 KB 的结果字节并走轻量 IPC（P0-4）。
// Worker 不可用（旧 WebView / 异常）时回退到同步路径，绝不因此引入新 bug。
//
// 载荷类型统一从 image-worker-protocol.ts 导入（C-1 修复：与 Worker 端共享单一事实来源）。
import {
  type ImageProcessOptions,
  type ImageWorkerSuccess as ImageProcessResult,
  type ImageWorkerRequest,
  type ImageWorkerResponse,
} from "./image-worker-protocol";

export type { ImageProcessOptions, ImageWorkerSuccess as ImageProcessResult } from "./image-worker-protocol";

let worker: Worker | null = null;
let workerFailed = false;

type Pending = { resolve: (r: ImageProcessResult) => void; reject: (e: Error) => void };
// H2 修复：Worker 按消息顺序处理并按序回信，用 FIFO 队列把每个响应正确关联回它自己的
// 请求，取代旧「每调用各挂一个 message 监听」写法——多张图并发收编时旧实现会让首个响应
// 同时触发所有监听器，导致 B 拿到 A 的字节。
const pending: Pending[] = [];

function failPendingAll(err: Error): void {
  while (pending.length) pending.shift()!.reject(err);
}

function terminateWorker(): void {
  if (worker) {
    try { worker.terminate(); } catch { /* ignore */ }
    worker = null;
  }
}

function getWorker(): Worker | null {
  if (workerFailed) return null;
  if (worker) return worker;
  try {
    const w = new Worker(new URL("./workers/image-worker.ts", import.meta.url), { type: "module" });
    // 监听器只挂一次，随 Worker 生命周期存在；响应按 FIFO 分发给对应请求。
    w.addEventListener("message", (e: MessageEvent<ImageWorkerResponse>) => {
      const job = pending.shift();
      if (!job) return;
      const d = e.data as ImageWorkerResponse;
      if (d && "error" in d && typeof d.error === "string") {
        job.reject(new Error(d.error));
      } else {
        job.resolve(d as ImageProcessResult);
      }
    });
    w.addEventListener("error", () => {
      // M3 修复：Worker 崩溃时标记失败、终止并回收句柄，令后续调用回退到非 Worker 路径。
      failPendingAll(new Error("worker-error"));
      terminateWorker();
      workerFailed = true;
    });
    w.addEventListener("messageerror", () => {
      pending.shift()?.reject(new Error("worker-messageerror"));
    });
    worker = w;
    return worker;
  } catch {
    workerFailed = true;
    return null;
  }
}

/** 当前运行环境是否支持 Worker 转码路径（不支持则调用方回退旧逻辑） */
export function imageWorkerSupported(): boolean {
  if (workerFailed) return false; // Worker 已崩溃 → 报告不支持，令调用方走 raw-bytes 回退
  return (
    typeof Worker !== "undefined" &&
    typeof OffscreenCanvas !== "undefined" &&
    typeof createImageBitmap === "function"
  );
}

export function processImageInWorker(
  blob: Blob,
  opts: ImageProcessOptions
): Promise<ImageProcessResult> {
  return new Promise((resolve, reject) => {
    const w = getWorker();
    if (!w) {
      reject(new Error("worker-unavailable"));
      return;
    }
    pending.push({ resolve, reject });
    const req: ImageWorkerRequest = { blob, opts };
    w.postMessage(req);
  });
}
