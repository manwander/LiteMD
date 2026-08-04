// 低端设备检测与降级矩阵（P1-7）。
// 检测只作「默认值」：用户可在设置里用 lowEndMode = auto/on/off 强制覆盖。
// 纯模块：所有 DOM 访问都在函数内部，顶层无副作用，可在 Node 下安全 import（仅类型与常量）。

export type LowEndMode = "auto" | "on" | "off";

export interface DegradeConfig {
  /** 实时预览阈值上限（KB）：低端更激进降级 */
  previewRealtimeMaxKB: number;
  /** 手动刷新硬上限（字节） */
  manualRefreshMax: number;
  /** 预览上下预读像素 */
  prerenderMargin: number;
  /** 每帧真实渲染块数预算 */
  renderBudgetPerFrame: number;
  /** 空闲预渲染屏数（0 = 关闭） */
  idlePrerenderScreens: number;
  /** 预览块 HTML 缓存条数上限 */
  maxCacheEntries: number;
  /** 图片降采样最大边（px） */
  imageMaxEdge: number;
  /** WebP 有损质量（0..1） */
  webpQuality: number;
  /** 预览容器是否用 will-change 合成层（集显上吃 VRAM） */
  useWillChange: boolean;
  /** 是否允许 backdrop-filter（集显上最贵的单项） */
  useBackdrop: boolean;
  /** 预览块 HTML 缓存字节上限（LRU 在此之上驱逐，防止大文档缓存无限膨胀） */
  maxCacheBytes: number;
  /** 视口外的 <img> 是否剥离 src 触发解码位图回收（内存压力下启用，省常驻显存） */
  imgReclaim: boolean;
}

const STANDARD: DegradeConfig = {
  previewRealtimeMaxKB: 2048,
  manualRefreshMax: 8 << 20,
  prerenderMargin: 800,
  renderBudgetPerFrame: 8,
  idlePrerenderScreens: 2,
  maxCacheEntries: 20000,
  imageMaxEdge: 2560,
  webpQuality: 0.82,
  useWillChange: true,
  useBackdrop: true,
  maxCacheBytes: 24 << 20,
  imgReclaim: false,
};

const LOW_END: DegradeConfig = {
  previewRealtimeMaxKB: 512,
  manualRefreshMax: 2 << 20,
  prerenderMargin: 300,
  renderBudgetPerFrame: 3,
  idlePrerenderScreens: 0,
  maxCacheEntries: 3000,
  imageMaxEdge: 1600,
  webpQuality: 0.72,
  useWillChange: false,
  useBackdrop: false,
  maxCacheBytes: 12 << 20,
  imgReclaim: true,
};

/** 读取 WebGL 渲染器字符串（集显 / 软渲染识别用）。异常时返回空串。 */
export function getGpuRenderer(): string {
  try {
    const c = document.createElement("canvas");
    const gl = (c.getContext("webgl") ||
      c.getContext("experimental-webgl")) as WebGLRenderingContext | null;
    if (!gl) return "";
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    if (!ext) return "";
    return String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
  } catch {
    return "";
  }
}

/** 4GB 内存 / 4 核 / 集显软渲染 → 判定为低端设备 */
export function detectLowEnd(): boolean {
  const nav = navigator as any;
  if (typeof nav.deviceMemory === "number" && nav.deviceMemory <= 4) return true;
  if (typeof nav.hardwareConcurrency === "number" && nav.hardwareConcurrency <= 4) return true;
  if (/Intel.*(UHD|HD Graphics)|Microsoft Basic Render/i.test(getGpuRenderer())) return true;
  return false;
}

/** 把 tri-state 设置解析为布尔 */
export function resolveLowEnd(mode: LowEndMode): boolean {
  if (mode === "on") return true;
  if (mode === "off") return false;
  return detectLowEnd();
}

/** 按低端与否返回降级矩阵（拷贝，避免外部改动污染常量） */
export function buildDegrade(lowEnd: boolean): DegradeConfig {
  return lowEnd ? { ...LOW_END } : { ...STANDARD };
}

export const LOW_END_PREVIEW_MAX_KB = 512;
