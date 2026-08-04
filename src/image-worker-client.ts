// 粘贴图片转码客户端：把解码 / 降采样 / WebP 编码卸载到 Worker，
// 主线程只接收数百 KB 的结果字节并走轻量 IPC（P0-4）。
// Worker 不可用（旧 WebView / 异常）时回退到同步 base64 路径，绝不因此引入新 bug。

export interface ImageProcessOptions {
  maxEdge: number;
  quality: number; // 0..1
  lossless: boolean;
  format: "webp" | "png";
}

export interface ImageProcessResult {
  bytes: Uint8Array;
  format: "webp" | "png";
  width: number;
  height: number;
}

let worker: Worker | null = null;
let workerFailed = false;

function getWorker(): Worker | null {
  if (worker || workerFailed) return worker;
  try {
    worker = new Worker(new URL("./workers/image-worker.ts", import.meta.url), { type: "module" });
    return worker;
  } catch {
    workerFailed = true;
    return null;
  }
}

/** 当前运行环境是否支持 Worker 转码路径（不支持则调用方回退旧逻辑） */
export function imageWorkerSupported(): boolean {
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
    const onMsg = (e: MessageEvent) => {
      w.removeEventListener("message", onMsg);
      w.removeEventListener("error", onErr);
      const d = e.data;
      if (d && d.error) reject(new Error(d.error));
      else resolve(d as ImageProcessResult);
    };
    const onErr = () => {
      w.removeEventListener("message", onMsg);
      w.removeEventListener("error", onErr);
      reject(new Error("worker-error"));
    };
    w.addEventListener("message", onMsg);
    w.addEventListener("error", onErr);
    w.postMessage({ blob, opts });
  });
}
