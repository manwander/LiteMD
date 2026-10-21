// C-1 回归：图片 Worker 通信协议 + 降采样数学。
// 旧缺陷：客户端发 { blob, opts }，Worker 端扁平解构 { blob, maxEdge, ... } → maxEdge=undefined
// → OffscreenCanvas(NaN,NaN) 抛错 → 所有粘贴/拖拽图片失败。这些测试锁死协议两端一致，
// 并覆盖 computeScaledDims 对非法 maxEdge 的 NaN 兜底。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { computeScaledDims } from "../image-worker-protocol";

describe("computeScaledDims（等比缩放 + NaN 兜底）", () => {
  it("超上限按最长边等比缩小", () => {
    const { w, h } = computeScaledDims(4000, 2000, 1000);
    expect(w).toBe(1000);
    expect(h).toBe(500);
  });
  it("未超上限不放大", () => {
    const { w, h } = computeScaledDims(800, 600, 1600);
    expect(w).toBe(800);
    expect(h).toBe(600);
  });
  it("maxEdge 为 undefined/NaN/0 时不缩放（不返回 NaN，防 OffscreenCanvas 抛错）", () => {
    for (const bad of [undefined, NaN, 0, -5] as unknown as number[]) {
      const { w, h } = computeScaledDims(3000, 2000, bad);
      expect(Number.isFinite(w) && Number.isFinite(h)).toBe(true);
      expect(w).toBeGreaterThanOrEqual(1);
      expect(h).toBeGreaterThanOrEqual(1);
    }
  });
  it("极小图缩到 <=1 仍取整为 >=1", () => {
    const { w, h } = computeScaledDims(2, 1, 1);
    expect(w).toBeGreaterThanOrEqual(1);
    expect(h).toBeGreaterThanOrEqual(1);
  });
});

describe("图片 Worker 请求/响应契约（C-1 / H2 FIFO 关联）", () => {
  class FakeWorker {
    static last: FakeWorker | null = null;
    listeners = new Map<string, ((ev: any) => void)[]>();
    posted: any[] = [];
    terminated = false;
    constructor(_url: any, _opts: any) { FakeWorker.last = this; }
    addEventListener(type: string, cb: (ev: any) => void) {
      const arr = this.listeners.get(type) || [];
      arr.push(cb);
      this.listeners.set(type, arr);
    }
    removeEventListener() { /* noop */ }
    postMessage(msg: any) { this.posted.push(msg); }
    terminate() { this.terminated = true; }
    emit(type: string, ev: any) { (this.listeners.get(type) || []).forEach((cb) => cb(ev)); }
  }

  const realWorker = (globalThis as any).Worker;
  // 每个用例用全新模块实例，重置客户端里模块级 worker/pending 单例状态。
  async function freshClient() {
    (globalThis as any).Worker = FakeWorker as any;
    vi.resetModules();
    const mod = await import("../image-worker-client");
    FakeWorker.last = null;
    return mod;
  }

  afterEach(() => { (globalThis as any).Worker = realWorker; });

  it("客户端 post 的载荷把参数放在 opts 下，且 opts.maxEdge 为有限数", async () => {
    const { processImageInWorker } = await freshClient();
    const blob = { size: 1 } as unknown as Blob;
    const opts = { maxEdge: 1600, quality: 0.82, lossless: false, format: "webp" as const };
    const p = processImageInWorker(blob, opts);
    const w = FakeWorker.last!;
    expect(w.posted[0]).toMatchObject({ blob });
    expect(w.posted[0].opts).toBeDefined();
    expect(typeof w.posted[0].id).toBe("number");
    // 关键断言：Worker 端读 e.data.opts.maxEdge —— 必须拿得到有限值（C-1 回归）
    expect(Number.isFinite(w.posted[0].opts.maxEdge)).toBe(true);
    expect(w.posted[0].opts.maxEdge).toBe(1600);
    w.emit("message", {
      data: { id: w.posted[0].id, bytes: new Uint8Array([1, 2, 3]), format: "png", width: 10, height: 20 },
    });
    const res = await p;
    expect(res.width).toBe(10);
  });

  it("并发请求乱序回信时按 id 各拿回自己的字节（S9 关联修复）", async () => {
    const { processImageInWorker } = await freshClient();
    const a = processImageInWorker({ size: 1 } as unknown as Blob, { maxEdge: 100, quality: 1, lossless: true, format: "png" });
    const b = processImageInWorker({ size: 2 } as unknown as Blob, { maxEdge: 200, quality: 1, lossless: true, format: "png" });
    const fw = FakeWorker.last!;
    expect(fw.posted.length).toBe(2);
    const idA = fw.posted[0].id;
    const idB = fw.posted[1].id;
    expect(idA).not.toBe(idB);
    // 故意逆序回信：后发的 b 先完成（Worker 内异步处理，顺序无保证）
    fw.emit("message", { data: { id: idB, bytes: new Uint8Array([9]), format: "png", width: 1, height: 1 } });
    fw.emit("message", { data: { id: idA, bytes: new Uint8Array([7]), format: "png", width: 1, height: 1 } });
    const [ra, rb] = await Promise.all([a, b]);
    expect(Array.from(ra.bytes)).toEqual([7]);
    expect(Array.from(rb.bytes)).toEqual([9]);
  });

  it("Worker 回 { error } 时对应请求被 reject（供上层回退原图）", async () => {
    const { processImageInWorker } = await freshClient();
    const p = processImageInWorker({ size: 1 } as unknown as Blob, { maxEdge: 1000, quality: 1, lossless: true, format: "png" });
    const w = FakeWorker.last!;
    w.emit("message", { data: { id: w.posted[0].id, error: "boom" } });
    await expect(p).rejects.toThrow("boom");
  });

  it("未知 id 的迟到响应被忽略，不影响在途请求", async () => {
    const { processImageInWorker } = await freshClient();
    const p = processImageInWorker({ size: 1 } as unknown as Blob, { maxEdge: 1000, quality: 1, lossless: true, format: "png" });
    const w = FakeWorker.last!;
    w.emit("message", { data: { id: 999999, bytes: new Uint8Array([5]), format: "png", width: 1, height: 1 } });
    w.emit("message", { data: { id: w.posted[0].id, bytes: new Uint8Array([6]), format: "png", width: 1, height: 1 } });
    const res = await p;
    expect(Array.from(res.bytes)).toEqual([6]);
  });
});

