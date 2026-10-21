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
let nextId = 1;

type Pending = { resolve: (r: ImageProcessResult) => void; reject: (e: Error) => void };
// H2/S9 修复：旧实现假设「回复顺序 === 请求顺序」，但 Worker 内是 async 处理且图片大小各异，
// 并发时后发的小图可能先回；FIFO 队首会拿错响应。改为请求 id → pending 映射，按 id 精确关联；
// 响应可能乱序，绝不能用 shift() 取队首。
const pending = new Map<number, Pending>();

function failPendingAll(err: Error): void {
  for (const job of pending.values()) job.reject(err);
  pending.clear();
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
    // 监听器只挂一次，随 Worker 生命周期存在；响应按请求 id 分发给对应请求。
    w.addEventListener("message", (e: MessageEvent<ImageWorkerResponse>) => {
      const d = e.data as ImageWorkerResponse;
      if (!d || typeof d.id !== "number") return;
      const job = pending.get(d.id);
      if (!job) return; // 已被 messageerror/超时清理的迟到响应
      pending.delete(d.id);
      if ("error" in d && typeof d.error === "string") {
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
      // 无法反序列化的消息：无法判断属于哪个请求，终止 Worker 并让全部请求回退，避免悬挂。
      failPendingAll(new Error("worker-messageerror"));
      terminateWorker();
      workerFailed = true;
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
    const id = nextId++;
    pending.set(id, { resolve, reject });
    const req: ImageWorkerRequest = { id, blob, opts };
    try {
      w.postMessage(req);
    } catch (err) {
      // Blob 结构化克隆失败等：清理登记，避免该 Promise 永久悬挂。
      pending.delete(id);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
