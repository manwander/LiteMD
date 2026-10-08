// 粘贴图片转码 Worker：在主线程之外完成解码 / 降采样 / WebP 编码，
// 避免 10MB 图片在主线程同步解码+转码导致 ~380ms 卡顿（P0-4）。
// 仅使用浏览器标准 API（createImageBitmap / OffscreenCanvas / convertToBlob），无需任何依赖。
//
// C-1 修复：载荷形状与响应类型统一从 image-worker-protocol.ts 导入，与客户端共享单一事实来源。
// 客户端 post 的是「嵌套」载荷 { blob, opts }，此处必须从 e.data.opts 取参数；
// 旧的扁平解构会让 maxEdge 变 undefined → 画布尺寸 NaN → Worker 抛错 → 图片收编全部失败。
import {
  computeScaledDims,
  type ImageWorkerRequest,
  type ImageWorkerSuccess,
  type ImageWorkerError,
} from "../image-worker-protocol";

const ctx: any = self;

ctx.onmessage = async (e: MessageEvent<ImageWorkerRequest>) => {
  const { blob, opts } = e.data;
  const { maxEdge, quality, lossless, format } = opts;
  try {
    const bmp = await createImageBitmap(blob);
    const { w, h } = computeScaledDims(bmp.width, bmp.height, maxEdge);

    const cv = new OffscreenCanvas(w, h);
    // H1 修复：画布始终带 alpha，否则转 WebP 时透明 PNG 会被合成到不透明白/黑底丢失透明。
    // WebP 与无损 PNG 均支持 alpha，无损与否只影响 convertToBlob 的 quality，不影响 alpha。
    const c2d = cv.getContext("2d", { alpha: true }) as any;
    c2d.imageSmoothingQuality = "high";
    c2d.drawImage(bmp, 0, 0, w, h);
    bmp.close(); // 立即释放最大的那块解码位图

    const type = format === "png" ? "image/png" : "image/webp";
    const out = await cv.convertToBlob({ type, quality: lossless ? 1 : quality });
    const buf = new Uint8Array(await out.arrayBuffer());
    cv.width = 0;
    cv.height = 0; // 释放 canvas 后备存储

    const msg: ImageWorkerSuccess = { bytes: buf, format, width: w, height: h };
    ctx.postMessage(msg, [buf.buffer]); // transferable，零拷贝回传
  } catch (err: any) {
    const msg: ImageWorkerError = { error: String(err?.message ?? err) };
    ctx.postMessage(msg);
  }
};
