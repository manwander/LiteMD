// 粘贴图片转码 Worker：在主线程之外完成解码 / 降采样 / WebP 编码，
// 避免 10MB 图片在主线程同步解码+转码导致 ~380ms 卡顿（P0-4）。
// 仅使用浏览器标准 API（createImageBitmap / OffscreenCanvas / convertToBlob），无需任何依赖。

interface Req {
  blob: Blob;
  maxEdge: number;
  quality: number; // 0..1
  lossless: boolean;
  format: "webp" | "png";
}
interface Res {
  bytes: Uint8Array;
  format: "webp" | "png";
  width: number;
  height: number;
}
interface ErrRes {
  error: string;
}

const ctx: any = self;

ctx.onmessage = async (e: MessageEvent<Req>) => {
  const { blob, maxEdge, quality, lossless, format } = e.data;
  try {
    const bmp = await createImageBitmap(blob);
    const denom = Math.max(bmp.width, bmp.height);
    const scale = denom > 0 ? Math.min(1, maxEdge / denom) : 1;
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));

    const cv = new OffscreenCanvas(w, h);
    const c2d = cv.getContext("2d", { alpha: format === "png" && lossless }) as any;
    c2d.imageSmoothingQuality = "high";
    c2d.drawImage(bmp, 0, 0, w, h);
    bmp.close(); // 立即释放最大的那块解码位图

    const type = format === "png" ? "image/png" : "image/webp";
    const out = await cv.convertToBlob({ type, quality: lossless ? 1 : quality });
    const buf = new Uint8Array(await out.arrayBuffer());
    cv.width = 0;
    cv.height = 0; // 释放 canvas 后备存储

    const msg: Res = { bytes: buf, format, width: w, height: h };
    ctx.postMessage(msg, [buf.buffer]); // transferable，零拷贝回传
  } catch (err: any) {
    const msg: ErrRes = { error: String(err?.message ?? err) };
    ctx.postMessage(msg);
  }
};
