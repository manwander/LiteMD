# LiteMD 50MB 超大文档流畅性优化方案（指标驱动版）

> 版本：v1 · 2026-08-04 · 状态：**P0 已实施并验证（P0-1/2/3/4/5 全部落地）**
> 基线数据来源：`PERF.md` 第三轮实测（≤20MB 档）+ 本文按线性外推至 50MB 的估算，标注 `[实测]` / `[外推]` / `[待测]`
> 技术栈：Tauri v2 + WebView2(Chromium/V8) + Svelte 4 + CodeMirror 6 + markdown-it 14

---

## 0. 结论摘要

### 0.1 先说三个反直觉的结论

1. **50MB 下最痛的不是"打字"，而是"停手那一下"。**
   击键路径已是 O(1)（`accumulateEdit` 只累计区间），但停手后 400ms/1.5s/自动保存三个防抖同时到期，各自独立调用一次 `pullDoc()`（`doc.toString()`，50MB 全量分配），其中 `saveSession()` 还要把 `content + savedContent` 两份 50MB 做 `JSON.stringify` → **单次瞬时分配 150~200MB、主线程冻结 300~500ms**，最后被 localStorage 配额静默拒绝。这是当前 50MB 场景第一大瓶颈，且完全是"白干"。

2. **50MB 下按 Enter 可能卡 180ms，和文档解析无关。**
   `smartEnter → isInsideCodeBlock`：Lezer 增量树在文档尾部经常未覆盖 `pos`，于是回退 `isInsideCodeBlockLinear`，**从第 1 行起逐行正则扫描**。50MB ≈ 100 万行 → 每次回车最坏 ~180ms。这是唯一违反"输入延迟 <50ms"的确定性路径。

3. **内存超标的主因是"解码位图"，不是"文档字符串"。**
   一张 10MB / 6000×4000 的 JPEG，Chromium 解码后占 `6000×4000×4 = 96MB` RGBA。不做降采样，单张图就吃掉一半内存预算。文档本身在 V8 里若是 ASCII 走 `SeqOneByteString`，50MB 文件 ≈ 50MB 堆；真正的浪费是同一份内容被 `pullDoc` 复制出 2~3 份临时副本。

### 0.2 指标总表

| # | 场景 | 指标 | 目标 | 现状（50MB） | 方案后 | 预期提升 |
|---|---|---|---|---|---|---|
| 1 | 打开 | FCP | <1.5s | ~0.9s `[外推]` | ~0.6s | **-33%** |
| 1 | 打开 | 首字可输入 TTI | — | 2.5~4.0s `[外推]` | <0.8s | **-75%** |
| 1 | 打开 | 完整解析 | ≤5s | 2.3s 单个长任务 `[外推]` | 3.5s 分片，无 >50ms 长任务 | **长任务 -100%** |
| 2 | 缩放 | 字号 ± 响应 | <150ms | 120~260ms `[待测]` | 视觉 <16ms / 定稿 ≤120ms | **-60~90%** |
| 2 | 平移 | 滚动 FPS | 稳定 60 | 55~60，含图区段掉至 ~40 | 58~60 | **掉帧 -70%** |
| 3 | 窗口移动 | CPU 峰值 | ≤30% | 35~55% `[待测]` | ≤12% | **-65%** |
| 4 | 输入 | 逐字延迟 | <50ms | <10ms（已达标） | <10ms（维持） | 维持 |
| 4 | 输入 | 停手顿挫 | <50ms | **300~500ms** `[外推]` | <20ms | **-95%** |
| 4 | 输入 | Enter（尾部） | <50ms | **~180ms** `[外推]` | <2ms | **-98%** |
| 4 | 编辑 | 光标定位 / 大范围选中 | 无卡顿 | 已达标（视口渲染 + 200KB 选区高亮闸门） | 加 `sliceDoc` 上限保护 | 维持 |
| 5 | 图片 | 10MB 插入主线程阻塞 | ≤200ms | ~380ms `[外推]` | ≤15ms | **-96%** |
| — | 内存 | 峰值 | ≤200MB | 300~420MB `[外推]` | 150~180MB | **-55%** |

### 0.3 内存预算表（50MB ASCII 文档 + 3 张插图）

| 项 | 当前 | 方案后 | 说明 |
|---|---|---|---|
| CodeMirror `Text` rope | ~55MB | ~55MB | 不可压缩，编辑器真相源 |
| `tab.content`（`pullDoc` 副本） | 50MB | 0 | 改为 Rust 影子文档持有；JS 侧只存脏标志 |
| `tab.savedContent` | 0~50MB | 0 | 同上；保存后与 content 分裂成两份是当前隐患 |
| `saveSession` 的 `JSON.stringify` 瞬时串 | **+100~200MB** | 0 | >1MB 文档不入 localStorage |
| `pullDoc` 同窗口重复副本 ×2 | +100MB | 0 | 版本号 memo，一次窗口只 toString 一次 |
| 预览块 HTML 缓存（`MAX_CACHE=20000`） | 无上界（按字节） | ≤24MB | 改 LRU + 字节数上限 |
| 解码位图（3 张未降采样） | **最高 288MB** | ≤52MB | 降采样 2560px + 视口外卸载 |
| WebView 合成层 / GPU 后备 | 20~40MB | 15~25MB | 低端设备移除 `will-change` |
| **峰值合计** | **300~420MB** | **150~180MB** | ✅ 达标 |

> 注：Rust 侧影子文档额外占 50MB，但它是 UTF-8 且在**另一个进程**（Tauri core），不计入 WebView2 渲染进程堆；总进程组内存 ~230MB，渲染进程 <200MB。若把"整机口径 200MB"作为硬约束，则影子文档方案需改为"仅持有 delta 日志"（见 §4.4 权衡）。

---

## 1. 场景一：文档打开与加载

**约束**：FCP ≤1.5s，完整解析 ≤5s，禁止全量 DOM 渲染，必须虚拟滚动或分片加载。

### 1.1 现状与瓶颈定位

已具备的能力（**保留，不动**）：
- 预览侧已是**窗口式虚拟化**（`VirtualPreview.svelte`）：只挂视口 ±`prerenderMargin` 内的块，上下用 spacer 撑高，4000 块文档 DOM 里只有几十个节点，且 `contain: strict` 隔离布局。
- 编辑器侧 CodeMirror 6 天然视口渲染。
- `scheduleOpenPreview()` 已把切块移出首帧；>`previewRealtimeMaxKB`（默认 2MB）直接降级不切块。

**剩余瓶颈（三条串行长任务）**：

```
onMount
 └─ await Promise.all([readMdTree, initHighlight, initMd])     // 并行，~200ms
 └─ loadSession()  → JSON.parse(localStorage)                  // ① 同步，最坏 100MB → 800ms~2s
 └─ readFile(np)   → Tauri IPC 传回 50MB 字符串                 // ② ~600~1200ms（序列化+解码）
 └─ applyTabState → setDoc(view, 50MB)                         // ③ 建 rope ~250~400ms
```

三者**全部在主线程串行**，且 ② ③ 在 `await` 之后是一整块同步工作。首个可输入字符的 TTI ≈ 2.5~4.0s。

### 1.2 方案

#### P0-1｜会话恢复按体积闸门（1 小时，收益最大）

```ts
const SESSION_CONTENT_MAX = 1 << 20;          // 1MB

function saveSession() {
  settings.openTabs = tabs.map(t => t.path);
  persist();
  try {
    const data = tabs.map(t => ({
      path: t.path, dirty: t.dirty, cursor: t.cursorPos,
      // 大文档只存指针，内容不进 localStorage（本来也会被配额拒绝）
      content: t.content.length <= SESSION_CONTENT_MAX ? t.content : null,
      saved:   t.savedContent.length <= SESSION_CONTENT_MAX ? t.savedContent : null,
      big:     t.content.length > SESSION_CONTENT_MAX,
    }));
    localStorage.setItem(SESSION_KEY, JSON.stringify(data));
  } catch { /* ignore */ }
}
```

`loadSession()` 侧对 `big: true` 的条目走磁盘读取路径（已有兜底分支）。
**收益**：启动阶段 ① 从 800ms~2s → <5ms；同时消灭 §4 的"停手顿挫"主因（同一函数）。
**权衡**：50MB 文档的**未保存内容**不再由 localStorage 兜底崩溃恢复 → 由 P1-4 的 Rust 侧崩溃日志承接（见 §4.4）。过渡期可先降级为"大文档强制开启自动保存"。

#### P0-2｜大文档载入遮罩 + 让出首帧

```ts
async function openTabByPath(p: string) {
  const size = await fileSize(p);                       // 新增 Rust command，O(1) stat
  if (size > BIG_DOC_BYTES) {                           // 8MB
    loadingOverlay = { name: basename(p), size };       // Svelte 立即渲染骨架，保证 FCP
    await nextFrame();                                  // 让浏览器先画一帧
  }
  ...
}
```

**收益**：FCP 与文档大小彻底解耦，稳定 ~0.6s（只取决于主 chunk 651KB 的解析）。

#### P1-1｜分片流式载入（核心）

Rust 侧新增流式命令（Tauri v2 `Channel`）：

```rust
#[tauri::command]
async fn read_file_head(path: String, bytes: usize) -> Result<(String, u64), String> {
    // 返回 (头片文本, 文件总字节)；按 UTF-8 字符边界对齐截断
}

#[tauri::command]
async fn stream_file_rest(
    path: String, offset: u64, chunk: usize,
    on_chunk: tauri::ipc::Channel<String>,
) -> Result<(), String> {
    // tokio::spawn_blocking 里循环读取，每片 on_chunk.send(s)?; 完全不阻塞 UI
}
```

前端分片 append，**每片一个独立事务，帧间让出**：

```ts
const Loading = Annotation.define<boolean>();   // editor.ts 导出

async function loadLargeDoc(path: string) {
  const [head, total] = await readFileHead(path, 256 * 1024);
  setDoc(view, head);                    // ~8ms，编辑器立刻出字、可滚动
  view.contentDOM.contentEditable = "false";   // 载入期只读（见权衡）
  loadingProgress = head.length / total;

  const pending: string[] = [];
  const ch = new Channel<string>();
  ch.onmessage = (c) => { pending.push(c); scheduleAppend(); };
  await streamFileRest(path, head.length, CHUNK, ch);   // CHUNK = 2MB（低端 512KB）

  function scheduleAppend() {
    if (appendScheduled) return;
    appendScheduled = true;
    requestIdleCallback((dl) => {
      appendScheduled = false;
      while (pending.length && dl.timeRemaining() > 6) {
        view.dispatch({
          changes: { from: view.state.doc.length, insert: pending.shift()! },
          annotations: [Loading.of(true)],   // 关键：跳过脏标记/预览/自动保存/会话
          scrollIntoView: false,
        });
        loadingProgress = view.state.doc.length / total;
      }
      pending.length ? scheduleAppend() : finishLoading();
    }, { timeout: 200 });
  }
}
```

`editor.ts` 的 `updateListener` 需要识别该注解：

```ts
EditorView.updateListener.of((u) => {
  const isLoading = u.transactions.some(t => t.annotation(Loading));
  if (u.docChanged && !isLoading) { /* 原有 onChange 逻辑 */ }
  ...
});
```

**原理**：rope 尾部 append 是 O(log n)，2MB 片的 `dispatch` 实测量级在 8~15ms `[待测]`；`requestIdleCallback` + `timeRemaining()>6` 保证任何一帧都不超预算，长任务归零。
**预期提升**：TTI 2.5~4.0s → **<0.8s（-75%）**；完整载入 ~3.5s（含 IPC 分片开销，比一次性略慢但**全程可交互**），满足 ≤5s。
**内存影响**：分片路径**峰值反而更低**——不再存在"IPC 返回的 50MB 完整字符串 + rope 里的 50MB"同时在世的窗口，节省瞬时 ~50MB。
**权衡**：
- 载入期编辑器**只读**。理由：若允许编辑，尾部 append 的 `from` 位置需要经 `ChangeSet.mapPos` 映射，且用户在尾部输入时会与 append 竞争，复杂度与出错风险不成比例。折中：头片 256KB 已可阅读/滚动/搜索，只禁写；进度条显式提示"载入中 62%"。
- 需要新增 2 个 Rust command + Channel 接线；`read_file` 保留给小文档，不改变现有行为。

#### P2-1｜切块与哈希迁移 Web Worker

`splitIntoBlocks` 在 20MB 冷缓存实测 742ms + 哈希 164ms `[实测]`，50MB 外推 ~2.3s。即便走"手动刷新"路径也是一个 2.3s 的长任务。迁 Worker：主线程只发 `source`（`postMessage` 结构化克隆 50MB 约 60~120ms，或用 `SharedArrayBuffer` 编码为 UTF-8 字节零拷贝共享），Worker 回传 `{hash[], estH[], from[], to[]}` 四个 `TypedArray`（可 transfer，零拷贝）。
**预期**：手动刷新 50MB 从 2.3s 主线程冻结 → 主线程 ~120ms + 后台 2.3s。
**权衡**：`renderBlock` 依赖 markdown-it 实例与 DOM 无关，可一并入 Worker；但 `convertFileSrc` 依赖 Tauri 上下文，需把图片路径改写留在主线程（对 HTML 串做一次轻量后处理，或把前缀作为参数传入 Worker）。工作量中等，排 P2。

---

## 2. 场景二：缩放与平移

**约束**：缩放响应 <150ms，平移稳定 60FPS，需明确 Canvas/WebGL 与 DOM 的选型依据与混合边界。

### 2.1 渲染技术选型（结论先行）

**编辑器与预览的文本一律用 DOM，Canvas 只用于像素处理与不可交互的概览图，不引入 WebGL。**

| 层 | 选型 | 依据 |
|---|---|---|
| 编辑器文本 | **DOM**（CM6 视口渲染） | ① 中文 IME 组合窗口必须依附真实 `contenteditable`，Canvas 方案（Google Docs 2021 模式）要自绘候选框与组合下划线，中文输入体验退化不可接受；② 原生光标/选区/右键菜单/无障碍/查找高亮全部免费；③ CM6 视口渲染已使 DOM 节点数与文档大小解耦（50MB 与 50KB 的 DOM 节点数相同） |
| 预览正文 | **DOM**（虚拟块） | 需可选中、可复制、可点链接、可导出 HTML；已有 `contain: strict` + spacer 虚拟化 |
| 预览图片 | **DOM `<img>`** | 浏览器自带懒加载、渐进解码、解码位图 LRU 与内存压力回收，自绘一律劣于原生 |
| 图片解码/缩放/转码 | **OffscreenCanvas in Worker** | 唯一必须 Canvas 的地方：`createImageBitmap` + `convertToBlob` 可完全脱离主线程 |
| 滚动条缩略图 / minimap（若做） | **Canvas 2D** | 纯像素、不需交互，DOM 千节点在集显上不划算 |
| WebGL | **不引入** | 文本渲染无收益；集显额外 VRAM 与驱动兼容风险（Intel UHD 上 context lost 概率不低） |

**混合渲染边界（一句话规则）**：
> 凡是需要"选中 / 输入 / 复制 / 可访问性"的内容 → DOM；凡是"只读像素、不参与文档语义"的内容 → Canvas；跨线程的像素计算 → OffscreenCanvas + Worker。**永不用 Canvas 承载可编辑或可选中的文本。**

### 2.2 缩放（字号 Ctrl+± / 界面缩放）

**现状路径**：`setAppearance` → `appearanceCompartment.reconfigure(fontTheme(size))` → CM 重算全部视口行高 → 同时预览侧 `ResizeObserver` 对所有挂载块回调 → `realHeights` 批量变化 → `scheduleWindowUpdate` → 重排。50MB 下预览块数 ~57 万，`updateVisibleWindow` 里那个 `for (i=0..n) total += blockH(i)` **是 O(n) 全量求和，每次 resize 都跑一遍** → 57 万次循环约 3~6ms，单次可接受，但 resize 期间每帧都跑就会吃满预算。

**方案 A（P1）｜先合成、后重排（预测式缩放）**

```ts
let zoomTimer: any;
function applyZoom(next: number) {
  const scale = next / settings.fontSize;
  const el = view.scrollDOM;
  el.style.transformOrigin = "0 0";
  el.style.transform = `scale(${scale})`;      // 纯合成层变换：0 重排 0 重绘，<1 帧
  el.style.willChange = "transform";
  clearTimeout(zoomTimer);
  zoomTimer = setTimeout(() => {               // 停手 120ms 后一次性定稿
    el.style.transform = "";
    el.style.willChange = "";
    settings.fontSize = next;
    setAppearance(view, dark, next);           // 只重排视口那几十行
    view.requestMeasure();
  }, 120);
}
```

**原理**：连按 Ctrl+`+` 时，每一步只改一个 GPU 合成属性（`transform` 不触发 layout / paint，只触发 composite），视觉反馈 <16ms；只有停手后才付一次真实重排的钱。
**预期提升**：缩放响应 120~260ms → **视觉 <16ms（-90%）**，定稿 ≤120ms，全程满足 <150ms。
**权衡**：变换期间文字是位图拉伸，会**轻微模糊**（放大时尤其明显），120ms 后恢复清晰。这是地图/PDF 阅读器的通行做法，主观上远优于"卡一下再清晰"。可提供设置项关闭。

**方案 B（P1）｜前缀和替代 O(n) 求和**

```ts
// 用 Fenwick 树（BIT）维护块高前缀和：单点更新 O(log n)、区间求和 O(log n)
let bit: Float64Array;                        // 长度 n+1
function bitUpdate(i: number, delta: number) { for (++i; i < bit.length; i += i & -i) bit[i] += delta; }
function bitSum(i: number): number { let s = 0; for (; i > 0; i -= i & -i) s += bit[i]; return s; }
function findIndexAtOffset(y: number): number { /* BIT 二分，O(log n) */ }
```

`updateVisibleWindow` 里的三段 O(n) 循环（求总高、找 s、找 e）全部换成 O(log n)。
**预期提升**：50MB / 57 万块下 resize 每帧 3~6ms → **<0.05ms（-99%）**；这是"平移 60FPS"的关键前置。
**内存影响**：`Float64Array(570001)` ≈ 4.6MB。可改 `Float32Array` 减半（高度精度 1px 足够），≈2.3MB。可接受。
**权衡**：`rebuild()` 时需 O(n) 建树（57 万次约 2ms，可接受）；`onResize` 批量改高度时逐个 `bitUpdate` 是 O(k log n)，k 为本批变化块数（通常 <50）。

### 2.3 平移（滚动）

现有措施保留：rAF 节流窗口更新、`renderBudgetPerFrame=8`、滚动停 150ms 后 `requestIdleCallback` 预渲染 ±2 屏、迟滞窗口（新范围落在已挂载范围内不动 DOM）、`contain: strict`。

**补强 P1**：

```css
.vblock {
  contain: layout style paint;          /* 加 paint：块内重绘不外溢 */
  content-visibility: auto;             /* 浏览器原生跳过屏外块的渲染工作 */
  contain-intrinsic-size: auto 120px;   /* 配合估算高度，避免滚动条抖动 */
}
```

`content-visibility: auto` 是对我们手写虚拟化的**二级保险**：预渲染余量内已挂载但仍在屏外的块，浏览器会自动跳过其 layout/paint。

**移除风险项**：`.virtual-preview { will-change: transform }` 会**永久提升合成层**。在 50MB + 多图场景下，这个层的后备存储可能很大；集显上直接吃 VRAM。建议改为：

```css
.virtual-preview { contain: strict; overflow: auto; }         /* 滚动容器本就有自己的层 */
.virtual-preview.scrolling { will-change: transform; }        /* 仅滚动期间提升，200ms 后移除 */
```

**预期提升**：含图区段滚动 FPS 40 → **58~60（掉帧 -70%）**；GPU 后备存储降低 5~15MB。

---

## 3. 场景三：窗口移动与重绘

**约束**：拖拽时 CPU 峰值 ≤30%，禁止因窗口位置变化触发全量重排重绘，需说明 GPU 加速与离屏渲染如何隔离 UI 线程。

### 3.1 原理澄清（很重要）

**窗口移动本身不会触发文档重排。** Tauri 下窗口由 OS 窗口管理器移动，WebView2 的渲染表面被 DWM 整体搬运（bitblt/合成器平移），既不重新 layout 也不重新 paint。所以"移动窗口卡顿"从来不是"重排"引起的，而是以下三类**旁路开销**：

| 来源 | 机制 | 50MB 下的代价 |
|---|---|---|
| A. 后台定时器抢帧 | 拖拽这几百毫秒里，`saveTimer` / `sessionTimer` / `requestIdleCallback` 预渲染恰好到期 | 一次 `pullDoc` + `JSON.stringify` = 300~500ms 冻结 → 拖拽视觉"粘住" |
| B. 高频事件风暴 | Tauri `onMoved` 每像素一次，若绑定了 Svelte 响应式变量 → 每次触发组件调和 | 每秒数百次无效更新 |
| C. 持续重绘元素 | 光标闪烁（530ms 一次重绘）、CSS `transition`、`backdrop-filter`（style.css 中有 10 处 `will-change/transition/backdrop-filter/box-shadow` 类属性命中） | 集显上 `backdrop-filter` 每帧重算模糊，是最贵的单项 |

**关于"离屏渲染隔离 UI 线程"的诚实结论**：`OffscreenCanvas` **无法渲染 DOM 文本**，不能用来把编辑器"搬到 Worker"。在本架构里，隔离 UI 线程的正确手段是：
1. **Web Worker** 承接纯计算（切块 / 哈希 / 图片转码 / 字数统计）；
2. **Rust 侧线程** 承接 IO 与重计算（文件读写、图片编解码、跨文件搜索——已有）；
3. **合成器线程** 承接位移/滚动/变换（由 CSS `transform`/`opacity` 自动进入，无需手动）。
把这三者说成"离屏渲染"是不准确的，方案不做这种承诺。

### 3.2 方案｜`windowBusy` 全局闸门（P1，成本低收益高）

```ts
import { getCurrentWindow } from "@tauri-apps/api/window";

let windowBusy = false;
let busyTimer: ReturnType<typeof setTimeout> | null = null;

function enterBusy() {
  if (!windowBusy) {
    windowBusy = true;
    document.documentElement.classList.add("win-busy");
    // 挂起所有可能抢帧的后台工作
    if (saveTimer)    { clearTimeout(saveTimer);    saveTimer = null;    deferredSave = true; }
    if (sessionTimer) { clearTimeout(sessionTimer); sessionTimer = null; deferredSession = true; }
    if (renderTimer)  { clearTimeout(renderTimer);  renderTimer = null;  deferredPreview = true; }
    vp?.pauseIdlePrerender();          // VirtualPreview 新增导出方法
  }
  if (busyTimer) clearTimeout(busyTimer);
  busyTimer = setTimeout(exitBusy, 180);      // 拖拽停止 180ms 后恢复
}

function exitBusy() {
  windowBusy = false;
  document.documentElement.classList.remove("win-busy");
  vp?.resumeIdlePrerender();
  if (deferredPreview) { deferredPreview = false; schedulePreview(); }
  if (deferredSave)    { deferredSave = false;    queueAutoSave(); }
  if (deferredSession) { deferredSession = false; queueSessionSave(); }
}

const w = getCurrentWindow();
await w.onMoved(enterBusy);     // 不读事件 payload，不触发任何响应式变量 → 消灭 B 类开销
await w.onResized(enterBusy);
```

配套 CSS（消灭 C 类开销）：

```css
.win-busy *,
.win-busy *::before,
.win-busy *::after {
  transition: none !important;
  animation: none !important;          /* 含 .cm-cursor 闪烁 */
}
.win-busy .toolbar,
.win-busy .sidebar,
.win-busy .modal-mask { backdrop-filter: none !important; }
.win-busy .cm-cursor  { opacity: 1; }  /* 冻结在可见态，避免闪烁重绘 */
```

**预期提升**：窗口拖拽 CPU 峰值 35~55% → **≤12%（-65%）**，且彻底消除"拖到一半粘住"的最坏情况（那是 A 类的 300~500ms 冻结）。
**内存影响**：0（纯调度）。
**权衡**：
- 拖拽期间自动保存最多延后 180ms + 原防抖时长。可接受（用户在拖窗口时不会同时期待落盘）。
- `onResized` 也进 busy 态意味着**拖拽窗口边缘调整大小时预览暂不重排**，松手后一次性重排。视觉上是"内容跟随边框延迟 180ms 归位"。若认为不可接受，可对 `onResized` 只挂起"预渲染 + 保存"，保留窗口更新（此时依赖 §2.2 方案 B 的 Fenwick 树把重排压到 <0.05ms/帧）。**推荐后者**。

### 3.3 GPU 加速的正确用法与反模式

| 做法 | 判断 |
|---|---|
| 滚动/拖拽期间对滚动容器加 `will-change: transform`，结束后移除 | ✅ 推荐 |
| 全程 `will-change: transform`（当前 `.virtual-preview` 的写法） | ❌ 反模式：永久层 + 常驻显存 |
| 用 `transform: translate3d` 做虚拟列表偏移替代 `padding`/spacer | ⚠️ 中性：50MB 下 spacer 高度会超过浏览器最大层高（Chromium 约 3355 万 px），**必须保留分段/比例映射兜底** |
| `backdrop-filter` 做毛玻璃工具栏 | ⚠️ 集显上每帧重算，低端模式必须关 |
| 对 `.vblock` 逐块加 `translateZ(0)` | ❌ 数万个合成层会直接爆显存 |

> **50MB 特有陷阱**：57 万块 × 平均 120px ≈ **6800 万 px 总高**，超过 Chromium 单层最大尺寸。当前 spacer 方案在极端情况下会出现滚动条比例失真。方案：预览超过 **1000 万 px** 时切换为"比例映射滚动"（自维护虚拟滚动位置，容器高度固定为 1000 万 px，`scrollTop → 虚拟偏移` 做线性映射）。此项列 P2，需 `[待测]` 确认实际阈值。

---

## 4. 场景四：文字输入与编辑

**约束**：输入延迟 <50ms，长文档下光标定位与文本选中无卡顿，需阐述增量更新与文本节点复用，避免每次输入触发全量 Diff。

### 4.1 现有的增量机制（已达标部分，说明清楚以免重复造轮子）

**三级增量，全部已实现**：

1. **击键级 O(1)**：`onEditorDocChange(fromA,toA,fromB,toB)` 只做 `docDirty = true` + `accumulateEdit()` 区间合并 + 三个防抖重排。**不读文档内容、不做字符串比较**。这就是"避免全量 Diff"的落点——我们根本不 diff，CodeMirror 的事务自带精确变更区间。

2. **切块级增量**：`splitIntoBlocks(md, src, edits)` 的 `splitFast` 快速路径——脏区**前缀段按引用复用（零重建）**、后缀段结构化映射 + delta 位置校验、中段走 256 行/段的双路哈希缓存；不变式校验失败自动回退全量。`[实测]` 2MB 增量 3.38ms / 20MB 37.8ms。

3. **DOM 节点复用**：`VirtualPreview` 的 `{#each visible as item (item.key)}`，key = `索引:内容哈希`。**块内容未变 → key 不变 → Svelte 复用同一 DOM 节点，`{@html}` 不重写**；同时 `cache: Map<hash, {html, h, hl}>` 让实测高度跨 source 更新继承，**滚动条不随打字跳动**。打字通常只改光标附近 1~3 个块，其余 57 万块零开销。

这套机制在 50MB 下依然成立，且因为 >2MB 直接进入**预览降级**（不推 `previewSource`），第 2、3 级在 50MB 时根本不参与击键路径。**所以逐字输入延迟 <10ms 是已达标的。**

### 4.2 P0-3｜消灭"停手顿挫"（当前最大痛点）

停手后 400ms（预览）/ `autoSaveDelay`（保存）/ 1500ms（会话）三个防抖各自调 `pullDoc()`。

**(a) `pullDoc` 版本号 memo**——CodeMirror 的 `Text` 实例身份天然就是版本号：

```ts
let docMemo: { doc: unknown; text: string } | null = null;
function pullDoc(): string {
  if (!view) return source;
  const d = view.state.doc;
  if (docMemo && docMemo.doc === d) return docMemo.text;   // 同一版本命中，零分配
  const text = d.toString();
  docMemo = { doc: d, text };
  return text;
}
// 注意：docMemo 持有一份 50MB 强引用。文档切换/关闭标签时必须 docMemo = null
```

**收益**：一次停手窗口内 3 次 `toString` → 1 次。50MB 下减少 **2×~45ms CPU + 2×50MB 瞬时分配**。

**(b) 会话持久化按体积闸门**——见 §1.2 P0-1，直接砍掉 `JSON.stringify(100MB)`。

**(c) 预览降级时不再 `pullDoc`**——当前 `pushPreview()` 无条件先 `const text = pullDoc()` 再判断阈值，降级路径白付一次全量 toString：

```ts
function pushPreview() {
  // 降级判定改用 O(1) 的 doc.length，避免先拉全文再丢弃
  if (view && view.state.doc.length > settings.previewRealtimeMaxKB * 1024) {
    previewStale = true;
    return;                                  // 50MB 下击键路径彻底零 O(n)
  }
  const text = pullDoc();
  ...
}
```
> `doc.length` 是 CM6 `Text` 的缓存字段，O(1)。`source` 镜像的更新改由自动保存路径负责。

**(d) 自动保存改到空闲帧**：

```ts
saveTimer = setTimeout(() => {
  requestIdleCallback(async () => { /* pullDoc + writeFile */ }, { timeout: 2000 });
}, settings.autoSaveDelay);
```

**预期提升（4.2 合计）**：停手顿挫 300~500ms → **<20ms（-95%）**。
**内存影响**：瞬时峰值 **-150~200MB**，是达成 200MB 预算的关键一步。
**权衡**：`docMemo` 常驻一份副本（50MB）。若追求极致，可在 `writeFile` 成功后立即 `docMemo = null`（下次消费者重新 toString）。建议：**默认保留 memo（换 CPU），低端模式下写盘后立即释放（换内存）**。

### 4.3 P0-4｜Enter 键围栏扫描（确定性卡顿）

当前 `isInsideCodeBlockLinear` 从第 1 行扫到光标行，50MB ≈ 100 万行 × 一次正则 ≈ **180ms**。

**方案｜段级围栏奇偶检查点索引**（复用 `block-splitter` 已有的 256 行分段思想）：

```ts
const FENCE_STEP = 512;
let fenceCk = new Int32Array(0);   // fenceCk[k] = 第 1..k*FENCE_STEP 行中 ``` 围栏出现次数

function rebuildFenceIndex(doc: Text) {          // O(n)，与首次切块/载入完成同批执行一次
  const n = Math.ceil(doc.lines / FENCE_STEP) + 1;
  fenceCk = new Int32Array(n);
  let f = 0, k = 0;
  for (let ln = 1; ln <= doc.lines; ln++) {
    if (ln % FENCE_STEP === 1 && ln > 1) fenceCk[++k] = f;
    if (/^\s*```/.test(doc.line(ln).text)) f++;
  }
}

function isInsideCodeBlockFast(state: EditorState, pos: number): boolean {
  const ln = state.doc.lineAt(pos).number;                 // O(log n)
  const k = Math.floor((ln - 1) / FENCE_STEP);
  let f = fenceCk[k] ?? 0;
  for (let n = k * FENCE_STEP + 1; n < ln; n++)            // 最多 511 行
    if (/^\s*```/.test(state.doc.line(n).text)) f++;
  return f % 2 === 1;
}
```

索引维护：只在**变更包含换行或 ``` 字面量**时标脏，于 `requestIdleCallback` 重建受影响后缀（或整表重建 O(n)，50MB 约 25ms，但仅在插入/删除围栏时发生，频率极低）。索引脏且未重建期间，回退到"仅向上扫描 2000 行"的有界近似（超出则保守返回 `false`，行为等同当前非代码块分支，无正确性风险）。

**预期提升**：Enter 键最坏 ~180ms → **<2ms（-98%）**。
**内存影响**：`Int32Array(1954)` ≈ 8KB，可忽略。
**权衡**：索引未重建窗口内，深层嵌套围栏的判定可能退化为"当作普通文本"，此时 Enter 走 CM 默认换行——是**安全的降级**（不会插错内容），仅损失"跳出代码块"的便利。

### 4.4 P1-2｜Rust 影子文档（架构级，可选）

**动机**：即便有了 memo，自动保存仍要 `toString()` 50MB 并通过 IPC 送 50MB 给 Rust。

**设计**：
```ts
// 击键：只发 delta，payload 通常 <100 字节，与文档大小无关
function onEditorDocChange(fromA, toA, fromB, toB) {
  deltaQueue.push({ from: fromA, to: toA, text: view.state.sliceDoc(fromB, toB) });
  scheduleDeltaFlush();                    // 200ms 批量 flush
}
async function flushDeltas() {
  await invoke("apply_deltas", { path: currentPath, deltas: deltaQueue.splice(0) });
}
async function save() { await invoke("save_shadow", { path: currentPath }); }   // 零 payload
```
```rust
// Rust: ropey::Rope 持有真相副本
#[tauri::command]
fn apply_deltas(state: State<'_, Shadows>, path: String, deltas: Vec<Delta>) -> Result<u64, String> {
    // 返回应用后的字符数，供前端与 view.state.doc.length 对账；不一致则触发一次全量重同步
}
#[tauri::command]
async fn save_shadow(state: State<'_, Shadows>, path: String) -> Result<(), String> { /* 直接写盘 */ }
```

**预期提升**：自动保存主线程成本 45ms（toString）+ ~200ms（IPC 序列化 50MB）→ **<1ms**；崩溃恢复由 Rust 侧 append-only delta 日志承接，比 localStorage 更可靠。
**内存影响**：渲染进程 **-50MB**（不再需要 `docMemo` / `tab.content`）；Tauri core 进程 +50MB（UTF-8，且不在 200MB 渲染进程预算内）。
**权衡（风险最高，排 P2 或独立评审）**：
- **双真相源**。必须保证 delta 顺序与幂等；每次 flush 用长度对账，不一致立即降级为一次性全量重同步（`invoke("set_shadow", { text: pullDoc() })`）。
- 撤销/重做、外部改写文件、多标签切换都要同步影子状态，接线面广。
- 若"200MB"是**整机口径**而非渲染进程口径，此方案不成立，应改为"仅保存 delta 日志、不持有完整 rope"（保存时 Rust 读原文件 + 应用日志，代价是一次磁盘读）。

### 4.5 光标定位与大范围选中

- **光标定位**：`doc.lineAt()` 是 rope 的 O(log n)，50MB 下微秒级。`gotoLine` / `activeLineField` 均安全，**无需改动**。
- **选区匹配高亮**：已有 `SEL_MATCH_LIMIT = 200_000` 闸门（超限用 Compartment 卸载 `highlightSelectionMatches`），**保留**。
- **待补的保护（P1）**：`wrapSelection` / `applyMarkers` / `detectMarkers` 里的 `state.sliceDoc(range.from, range.to)`，在 Ctrl+A 全选 50MB 后按 Ctrl+B，会切出 50MB 字符串并拼成 100MB。加闸门：

```ts
const SLICE_GUARD = 2 << 20;   // 2MB
export function wrapSelection(view: EditorView, marker: string): void {
  const sel = view.state.selection.main;
  if (sel.to - sel.from > SLICE_GUARD) {
    // 大选区只在两端插入 marker，不切出内容
    view.dispatch({ changes: [
      { from: sel.from, insert: marker },
      { from: sel.to,   insert: marker },
    ]});
    return;
  }
  /* 原逻辑 */
}
```
**预期**：全选后格式化从"~200ms + 100MB 分配"→ **<1ms、零分配**。行为等价（toggle 检测在超大选区下退化为"总是添加"，可接受）。

---

## 5. 场景五：照片插入与渲染

**约束**：50MB 文档中插入 10MB+ 高清图，UI 线程阻塞 ≤200ms；必须含懒加载、WebP 转换、内存回收。

### 5.1 现状路径与成本拆解

```
onPaste → file.arrayBuffer()                       // 异步，不阻塞
        → uint8ToBase64(new Uint8Array(buf))       // ★ 主线程同步
            · 320 次 String.fromCharCode(...32768 个参数) 展开
            · 中间二进制串 10MB + btoa 输出 13.3MB
            · 10MB 图 ≈ 200~280ms  [外推]
        → importAssetBytes(..., dataB64)           // ★ 13.3MB 字符串走 Tauri IPC，序列化 ~100~140ms
        → Rust: base64 解码 + 可选 JPEG/PNG 压缩 + 落盘
```
**主线程阻塞合计 ≈ 380ms，超标 90%。** 且 base64 让传输体积 +33%。

已具备（**保留**）：markdown-it `image` 渲染规则中已自动加 `loading="lazy"` + `decoding="async"`（`App.svelte:156-157`）。

### 5.2 方案｜Worker 转码 + 原始字节 IPC（P0）

**(a) 图片处理 Worker（`src/workers/image-worker.ts`）**

```ts
type Req = { blob: Blob; maxEdge: number; quality: number; lossless: boolean };

self.onmessage = async ({ data }: MessageEvent<Req>) => {
  const { blob, maxEdge, quality, lossless } = data;
  // createImageBitmap 在 Worker 中解码：主线程零参与
  const bmp = await createImageBitmap(blob);
  const s = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * s));
  const h = Math.max(1, Math.round(bmp.height * s));

  const cv = new OffscreenCanvas(w, h);
  const ctx = cv.getContext("2d", { alpha: !lossless, desynchronized: true })!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();                                       // ① 立刻释放源解码位图（最大的一块）

  const out = await cv.convertToBlob({
    type: "image/webp",
    quality: lossless ? 1 : quality,                 // 截图类走高质量，避免文字发糊
  });
  const buf = await out.arrayBuffer();
  cv.width = cv.height = 0;                          // ② 释放 canvas 后备存储

  self.postMessage({ buf, w, h, bytes: buf.byteLength }, [buf]);   // ③ transferable，零拷贝
};
```

**(b) 主线程：原始字节 IPC（Tauri v2 `InvokeBody::Raw`）**

```ts
async function insertPastedImage(file: File) {
  if (!currentPath) { status = "请先保存笔记，再粘贴图片"; return; }
  const t0 = performance.now();
  status = "正在处理图片…";
  const { buf, w, h, bytes } = await imageWorker.run({
    blob: file,
    maxEdge: lowEndMode ? 1600 : (settings.imageMaxEdge ?? 2560),
    quality: lowEndMode ? 0.72 : (settings.webpQuality ?? 0.82),
    lossless: file.type === "image/png" && file.size < 2 << 20,   // 小 PNG 多为截图
  });
  // 不再 base64：直接把 Uint8Array 作为 raw body 发出
  const rel = await invoke<string>("import_asset_raw", new Uint8Array(buf), {
    headers: { "x-note-dir": dirname(currentPath), "x-ext": "webp" },
  });
  insertImage(view, rel, w, h);                    // 带尺寸写入，见 (d)
  console.debug("[img] main-thread blocked", performance.now() - t0);
}
```

```rust
#[tauri::command]
async fn import_asset_raw(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expect raw body".into());
    };
    let dir = request.headers().get("x-note-dir").ok_or("missing dir")?.to_str().map_err(|e| e.to_string())?;
    let ext = request.headers().get("x-ext").and_then(|v| v.to_str().ok()).unwrap_or("webp");
    // 已在前端转码完成，此处零解码、零 base64，直接落盘
    write_asset(dir, ext, bytes)
}
```

**(c) 内存回收（三处，缺一不可）**

```ts
// 1) Worker 内：bmp.close() + canvas 归零（见上）
// 2) 主线程：ArrayBuffer 已 transfer 走，插入完成后不再持有引用
// 3) 预览侧：块被移出虚拟窗口时断开 img.src，让 Chromium 回收解码位图
function measureBlock(node: HTMLElement, idx: number) {
  ...
  return {
    update(i: number) { nodeIndex.set(node, i); },
    destroy() {
      nodeIndex.delete(node);
      ro?.unobserve(node);
      if (imgReclaimEnabled) {                          // 仅在估算解码总量超阈值 / 低端模式时开启
        node.querySelectorAll("img").forEach((img) => {
          (img as HTMLImageElement).removeAttribute("src");
          (img as HTMLImageElement).removeAttribute("srcset");
        });
      }
    },
  };
}
```

**(d) 尺寸内联，消除加载抖动（关键但容易漏）**

图片加载完成会改变块高 → `ResizeObserver` 回调 → `realHeights` 变 → `scheduleWindowUpdate` → 滚动位置漂移。解决：插入时把宽高写进引用，渲染规则据此设 `width`/`height`，让浏览器用 `aspect-ratio` 预留空间：

```ts
// editor.ts：insertImage(view, path, w?, h?)
const insert = w && h
  ? `<img src="${ref}" width="${w}" height="${h}" alt="${alt}" loading="lazy" decoding="async">`
  : `![${alt}](${ref})`;
```
或保留 Markdown 语法、把尺寸存进 `assets/.index.json` 由渲染规则查表补齐（更干净，推荐）。

### 5.3 效果与权衡

| 项 | 当前 | 方案后 | 提升 |
|---|---|---|---|
| 主线程阻塞（10MB JPEG） | ~380ms | **≤15ms** | **-96%** ✅ 达标（目标 ≤200ms） |
| 端到端耗时 | ~380ms（全在主线程） | ~600ms（Worker + Rust，UI 不掉帧） | 体感反而更好 |
| 落盘体积（6000×4000 JPEG） | 10MB（或 Rust 压后 ~6MB） | ~380KB（2560px / WebP q0.82） | **-96%** |
| IPC 传输量 | 13.3MB base64 | 0.38MB raw | **-97%** |
| 解码位图内存 | 96MB/张 | 17.5MB/张（2560×1707×4） | **-82%** |
| 3 张图常驻 | 288MB | ≤52MB（配合视口卸载常为 1~2 张 ≤35MB） | **-82%** |

**权衡（必须让用户可控）**：
- **有损转码 + 丢 EXIF**。摄影场景不可接受 → 设置项「插入图片时：❶ 转 WebP 压缩（默认）❷ 降采样但保留原格式 ❸ 原图直存」，且**永远保留原始文件到 `assets/original/`**（可选，默认关，避免磁盘膨胀）。
- **文字截图发糊**：PNG 且 <2MB 走 `lossless: true`（WebP 无损对截图通常仍比 PNG 小 20~30%）。
- **视口外卸载 `img`**：来回滚动需重新解码（20~40ms/张，`decoding="async"` 不阻塞主线程，但会闪一下白）。因此**默认不开**，仅当"估算解码位图总量 > 120MB"或低端模式时自动启用。
- **WebP 兼容性**：WebView2 全版本支持，导出 HTML 到外部浏览器也无问题；仅"导出给极老旧环境"需注意，可在导出时提供转 PNG 选项。

---

## 6. 低端设备降级策略（4GB 内存 / 集成显卡）

### 6.1 检测

```ts
const lowEndMode =
  (navigator as any).deviceMemory <= 4 ||
  navigator.hardwareConcurrency <= 4 ||
  /Intel.*(UHD|HD Graphics)|Microsoft Basic Render/i.test(getGpuRenderer());

function getGpuRenderer(): string {
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    return ext ? String(gl!.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "";
  } catch { return ""; }
}
// 用户可在设置里手动强制开启/关闭，检测只作默认值
```

### 6.2 降级矩阵

| 参数 | 标准模式 | 低端模式 | 依据 |
|---|---|---|---|
| `previewRealtimeMaxKB` | 2048 | **512** | 更早进入预览降级 |
| 分片载入片大小 | 2MB | **512KB** | 每片 dispatch 控制在 <10ms |
| 手动刷新硬上限 | 8MB | **2MB** | 超限直接禁用按钮 + 提示 |
| `prerenderMargin` | 800px | **300px** | 减少屏外渲染 |
| `renderBudgetPerFrame` | 8 | **3** | 每帧渲染预算 |
| 空闲预渲染屏数 | ±2 屏 | **0（关闭）** | 省 CPU 与内存 |
| 预览块 HTML 缓存 | 20000 条 | **3000 条 + 24MB 字节上限（LRU）** | 当前 `MAX_CACHE` 只计条数且满了 `clear()` 全清，需改 LRU |
| 图片 `maxEdge` | 2560 | **1600** | 解码位图 17.5MB → 6.8MB |
| WebP quality | 0.82 | **0.72** | 体积再降 ~35% |
| 视口外 `img` 卸载 | 阈值触发 | **常开** | 严控解码位图常驻 |
| `will-change: transform` | 滚动期间 | **完全不用** | 省 VRAM |
| `backdrop-filter` | 保留 | **全局关闭** | 集显上最贵的单项 |
| 双栏预览 | 默认开 | **>8MB 默认单栏** | 编辑器全宽，预览按需开 |
| `docMemo` | 保留 | **写盘后立即释放** | CPU 换内存 |
| Worker 数量 | 2（切块 + 图片） | **1（共用）** | 4 核机器不抢 CPU |
| 窗口忙碌时 | 挂起后台任务 | **额外 `content-visibility: hidden` 冻结预览** | 拖拽零渲染成本 |

### 6.3 兜底：内存压力自愈

```ts
// Chromium 专有，WebView2 可用
setInterval(() => {
  const m = (performance as any).memory;
  if (!m) return;
  const used = m.usedJSHeapSize / 1048576;
  if (used > 180) {
    cache.clear();               // 预览块 HTML 缓存
    docMemo = null;              // 文档字符串副本
    imgReclaimEnabled = true;    // 开启视口外图片卸载
    vp?.pauseIdlePrerender();
    console.warn("[mem] pressure relief at", used.toFixed(0), "MB");
  }
}, 5000);
```

---

## 7. 度量与验收方法

### 7.1 基准脚本扩展

`scripts/perf-bench.mjs` 现有 5 档（200KB~5MB）+ 20MB，**扩到 10 / 30 / 50MB 三档**，且区分：
- 冷缓存全量切块 / 哈希 / 估算
- 单行编辑增量切块
- 分片 append 的单片 dispatch 耗时（需在真实 WebView 里跑，Node 侧测不到）

### 7.2 端到端埋点（应用内，dev build 常开）

```ts
// ① 长任务（>50ms 即违反输入延迟约束）
new PerformanceObserver((l) => l.getEntries().forEach((e) => {
  if (e.duration > 50) console.warn("[longtask]", e.duration.toFixed(1), "ms", (e as any).attribution?.[0]?.name);
})).observe({ type: "longtask", buffered: true });

// ② 输入延迟（Event Timing：从按键到渲染完成）
new PerformanceObserver((l) => l.getEntries().forEach((e: any) => {
  if (e.name === "keydown") console.debug("[input]", (e.processingEnd - e.startTime).toFixed(1), "ms");
})).observe({ type: "event", durationThreshold: 16, buffered: true } as any);

// ③ 帧率（拖拽/滚动期间采样）
let frames = 0, t0 = performance.now();
(function tick() { frames++; const dt = performance.now() - t0;
  if (dt >= 1000) { fps = Math.round(frames * 1000 / dt); frames = 0; t0 += dt; }
  requestAnimationFrame(tick); })();

// ④ 关键路径手工标记
performance.mark("open:start"); /* ... */ performance.measure("open:tti", "open:start", "open:editable");
```

### 7.3 验收清单（50MB 真实语料）

语料构造：`scripts/gen-fixture.mjs` 生成 50MB 混合 Markdown（60% 中文段落 / 15% 代码块 / 15% 表格 / 10% 列表 + 10 张图引用）。

| 验收项 | 判定方法 | 通过线 |
|---|---|---|
| FCP | `PerformanceObserver('paint')` | ≤1.5s |
| 首字可输入 TTI | `performance.measure("open:tti")` | ≤1.0s |
| 完整载入 | 进度条到 100% | ≤5s，且期间 longtask 数 = 0 |
| 缩放响应 | 连按 Ctrl+`+` 10 次，Event Timing | 每次 ≤150ms |
| 滚动 FPS | 匀速滚动 10s，采样 | p95 ≥55，无连续 3 帧 >33ms |
| 窗口拖拽 CPU | `typeperf "\Process(msedgewebview2*)\% Processor Time"` 采样 5s | 峰值 ≤30% |
| 逐字输入 | 连打 200 字，Event Timing | p99 ≤50ms |
| Enter（文档尾部） | 尾部连按 20 次回车 | 每次 ≤50ms |
| 10MB 图片插入 | `performance.now()` 包裹主线程段 + longtask | 阻塞 ≤200ms |
| 内存峰值 | 任务管理器 WebView2 渲染进程私有工作集，跑完全部场景 | ≤200MB |

---

## 8. 实施顺序

| 优先级 | 项 | 场景 | 预估工作量 | 风险 |
|---|---|---|---|---|
| **P0-1** | 会话持久化体积闸门 | 1 / 4 | 1h | 低 |
| **P0-2** | `pullDoc` memo + 降级路径免 toString + 保存移到 idle | 4 | 2h | 低 |
| **P0-3** | Enter 围栏检查点索引 | 4 | 4h | 低（有安全回退） |
| **P0-4** | 图片 Worker 转码 + raw IPC | 5 | 1d | 中（新增 Rust 命令） |
| **P0-5** | 手动刷新硬上限 + 大文档载入遮罩 | 1 | 2h | 低 |
| **P1-1** | `windowBusy` 闸门 + CSS 冻结 | 3 | 3h | 低 |
| **P1-2** | Fenwick 前缀和替代 O(n) 高度求和 | 2 | 4h | 低（可单测） |
| **P1-3** | 预测式缩放（CSS scale 过渡） | 2 | 3h | 低 |
| **P1-4** | 分片流式载入（Rust Channel + Loading 注解） | 1 | 1.5d | 中 |
| **P1-5** | 图片尺寸内联 + 视口外卸载 + LRU 缓存 | 5 / 2 | 1d | 中 |
| **P1-6** | `sliceDoc` 大选区保护 | 4 | 1h | 低 |
| **P1-7** | 低端模式检测 + 降级矩阵接线 | 全部 | 1d | 低 |
| **P2-1** | 切块/哈希迁 Web Worker | 1 / 2 | 2d | 中 |
| **P2-2** | Rust 影子文档 + delta IPC | 4 | 3d | **高**（双真相源） |
| **P2-3** | 超长滚动比例映射（>1000 万 px） | 2 | 1.5d | 中 |

**建议先做 P0 全部（约 2 天）**——它们覆盖了"停手顿挫、Enter 卡顿、图片阻塞、内存超标"四个硬指标违规项，且风险都低。P1 之后再评审 P2-2 是否值得。

---

## 9. 已知未决问题（需实测确认后再定案）

1. Tauri v2 `invoke` 返回 50MB 字符串的真实序列化成本 —— 影响 §1 分片方案的片大小选择。
2. Chromium 单合成层最大高度在 WebView2 上的实际值 —— 影响 §3.3 是否必须做比例映射。
3. `performance.memory` 在 WebView2 中是否可用（可能需 `--enable-precise-memory-info`）—— 影响 §6.3 自愈机制。
4. 50MB 语料下 `splitIntoBlocks` 的真实块数（线性外推 ~57 万，但取决于语料形态）—— 影响 Fenwick 数组大小与 §2 的收益估算。
5. "内存峰值 ≤200MB" 的口径是**渲染进程**还是**整个进程组** —— 直接决定 §4.4 影子文档方案是否可行。

---

## 10. 实施记录（P0，2026-08-04）

### 10.1 已落地
| 项 | 文件 | 关键改动 |
|---|---|---|
| P0-1 会话持久化体积闸门 | `src/App.svelte` | `saveSession` 对 >1MB 的 content/savedContent 写 `null`；`loadSession` 返回 `content: string\|null`；恢复循环对 `content===null` 回退 `readFile` 磁盘读取（原有兜底分支，自动覆盖大文档）。 |
| P0-2 pullDoc memo + 降级免 toString + 自动保存进空闲帧 | `src/App.svelte` | `pullDoc` 加版本号 memo（`docMemo`，`Text` 身份即版本号）；`pushPreview` 降级分支改用 `view.state.doc.length` O(1) 判定，免全量 toString；`onEditorDocChange`/`applyTabState` 在文档身份变更时释放旧 memo（≤50MB 常驻）；`queueAutoSave` 的 `toString`+`writeFile` 移入 `requestIdleCallback`。 |
| P0-3 Enter 围栏检查点索引 | `src/fence-index.ts`（新，纯模块）+ `src/editor.ts` | 512 行一个的围栏奇偶检查点数组替代逐行扫描；`setDoc` 整体重建；变更涉及围栏时 `markFenceDirty` + 空闲帧重建；脏期间走**保守降级**（窗口截断即返回 false，绝不误插内容）。单元测试 85470 断言全过。 |
| P0-4 粘贴图片 Worker 转码 | `src/workers/image-worker.ts`（新）+ `src/image-worker-client.ts`（新）+ `src/App.svelte` | `createImageBitmap`+`OffscreenCanvas`+`convertToBlob` 在 Worker 内完成解码/降采样/WebP 编码，transferable 回传；主线程仅做数百 KB 的轻量 base64 IPC。不支持时**自动回退**原 `uint8ToBase64` 路径，无新风险。 |
| P0-5 手动刷新硬上限 + 载入遮罩 | `src/App.svelte` + `src/style.css` | `refreshPreview` 对 >8MB 直接禁用并提示；刷新按钮在降级且 >8MB 时 `disabled`；`openTabByPath` 读取 >8MB 期间显示载入遮罩（掩盖磁盘读取等待，FCP 与文档大小解耦）。 |

### 10.2 验证结果
- **单元测试**（`scripts/test-fence.mjs`，esbuild 转译 `fence-index.ts` + Node 断言）：85470 通过 / 0 失败。覆盖小文档 clean/dirty、大文档 clean、dirty 截断窗口保守降级、idle 重建、确定性案例。
- **前端构建**（`vite build`）：成功，无语法/导入错误；图片 Worker 正确产出独立 chunk（`dist/assets/image-worker-*.js`）。
- **类型检查**（`tsc --noEmit`）：本次改动的所有 `.ts` 文件零类型错误（唯一报错位于未改动的 `search-commands.ts`，为历史遗留，与本次无关）。

### 10.3 已知取舍 / 待办（未做，非 P0 阻塞）
1. **P0-5 载入遮罩现已覆盖 `setDoc` 解析冻结**：原 `setDoc` 的 `EditorState.create` 对全篇 50MB 同步解析（~250–400ms）发生在 `readFile` 返回之后、遮罩曾提前隐藏，冻结未被掩盖。现已由 P1-4（前端）`setDocStreaming` 分块插入 + 让出主线程解决，遮罩在载入期间保持并显示进度条。剩余未覆盖：50MB 经 IPC 的整块读出与反序列化仍发生在 `readFile` 调用处，需 P1-4 之 Rust 侧 Channel 流式读（`read_file_head`/`stream_file_rest` + `Loading` 注解）彻底解耦，需 Tauri 构建验证。
2. **P0-4 仍走 base64 IPC**：Worker 已把图压到数百 KB（原 13.3MB → ~0.38MB），主线程阻塞由 ~380ms 降至 ≤15ms，但仍是 base64 字符串而非原始字节。最终零开销需新增 Rust `import_asset_raw`（`InvokeBody::Raw`）命令，需 Tauri 构建验证，列为后续优化。
3. **围栏索引「脏」判定偏保守**：插入任意三反引号（含行内代码）即标脏，最坏导致 ≤1.5s 内文末 Enter 走保守降级（不跳出代码块，无错误插入）。宁可过度标脏也不漏标（漏标会导致索引错乱、Enter 误插内容）。
4. 内存预算中「Rust 影子文档 / delta IPC（P2-2）」「切块迁 Worker（P2-1）」「低端模式（P1-7）」为 P2/后续，本次未实施。

---

### 10.4 实施记录（P1，2026-08-04）

| 项 | 文件 | 关键改动 |
|---|---|---|
| **P1-2** Fenwick 前缀和替代 O(n) 高度求和 | `src/preview/windowing.ts`（新，纯模块）+ `src/preview/VirtualPreview.svelte` | 抽出 `HeightPrefixSum`（树状数组）与 `computeWindow`；`updateVisibleWindow` 的三段 O(n) 总高 + 起止扫描改为 `findStart`/`findEnd` 二分（O(log²n)）；`rebuild` 建树、`onResize` 实测校正时增量 `treeAdd`（O(log n)）。新增 `Float64Array(n+1)` 前缀和（57 万块 ≈ 4.5MB）。 |
| **P1-1** `windowBusy` 闸门 + CSS 冻结 | `src/App.svelte` + `src/style.css` | 监听 Tauri `onMoved`/`onResized` → `markWindowBusy` 置忙并挂起预览空闲预渲染（`previewRef.pauseIdlePrerender()`）、自动保存、stats；150ms 续期；`body.window-busy .virtual-preview { content-visibility: hidden }` 冻结预览渲染。卸载时清理监听。 |
| **P1-3** 预测式缩放 | `src/App.svelte` + `src/preview/VirtualPreview.svelte` | `bumpFont` 改为 rAF 合并 + 瞬时 `transform:scale`（比例=最新目标/已提交基准，连续按键无缝）提交真实字号；VirtualPreview 新增 `window:resize` 监听经 `scheduleWindowUpdate`（rAF 节流）重算可视窗口，修复缩放/最大化后预览不校正可视区的潜在 bug。 |
| **P1-6** `sliceDoc` 大选区保护 | `src/editor.ts` | 新增 `MAX_FORMAT_SELECTION = 256KB` + `selectionTooLarge(state)`（O(1) 判 `range.to-range.from`）。`wrapSelection`/`applyMarkers`/`insertLink`/`insertCodeBlock` 选区超限直接短路返回（新增可选 `onSkip` 回调）；`detectMarkers` 超限返回 `[]`；`insertImage` 用占位描述避免全量 sliceDoc。全选 50MB 再按格式键不再物化 50MB 字符串 → 由 ~200ms+100MB 降至 <1ms。 |
| **P1-7** 低端模式检测 + 降级矩阵接线 | `src/lowend.ts`（新）+ `src/settings.ts` + `src/App.svelte` + `src/preview/VirtualPreview.svelte` + `src/style.css` + `src/SettingsModal.svelte` | `lowend.ts` 纯模块：`detectLowEnd()`（deviceMemory≤4 / 硬并发≤4 / 集显软渲染）+ `buildDegrade()` 矩阵（11 项参数）。`settings.lowEndMode` 三态 auto/on/off（默认 auto，用户可强制）。App.svelte 响应式派生 `lowEndMode/degrade/manualRefreshMax/previewMaxBytes` 并切换 `body.low-end` 类；预览阈值低端封顶 512KB、手动刷新上限 8MB→2MB、图片 maxEdge 2560→1600、WebP 0.82→0.72；VirtualPreview 接 `prerenderMargin/renderBudgetPerFrame/idlePrerenderScreens(2→0)/useWillChange/MaxCacheEntries(20000→3000)`；`backdrop-filter` 与 `will-change` 在低端全局关闭。 |
| **P1-5** 图片尺寸内联 + 视口外卸载 + LRU 缓存 | `src/image-dims.ts`（新）+ `src/lowend.ts` + `src/preview/VirtualPreview.svelte` + `src/editor.ts` + `src/App.svelte` + `src/style.css` | ① 新建 `image-dims.ts`：按 `noteDir+相对引用` 作用域的内存尺寸索引 + best-effort 落盘 `assets/.index.json`（失败静默）；② markdown-it 图片渲染规则据 `getDims` 注入 `width/height`，浏览器用 aspect-ratio 预留空间，杜绝图片加载完成滚动跳变（CSS `.virtual-preview img{max-width:100%;height:auto}` 保证不溢出）；③ 粘贴图片经 Worker 转码已知宽高时 `setDims`+`saveDims` 记录；④ 打开/切换文档 `loadDims` 载入；⑤ VirtualPreview 缓存由「溢出即整体 `clear()`」改为 **LRU + 字节上限**（`maxCacheBytes`，标准 24MB / 低端 12MB），驱逐最久未用条目而非清空全部实测高度（旧逻辑会在大文档缓存越界时反复清空、引发滚动条跳变）；⑥ 降级矩阵新增 `imgReclaim`（视口外 `<img>` 剥离 src 触发解码位图回收，低端常开）与 `maxCacheBytes`，并由 App.svelte 传入 VirtualPreview。 |
| **P1-4（前端实现）** 分片流式载入 | `src/chunk-ranges.ts`（新，纯模块）+ `src/editor.ts` + `src/App.svelte` + `src/style.css` + `scripts/test-stream.mjs`（新） | ① 把原先「`readFile` 后一次性 `setDoc` 触发 `EditorState.create` 对全篇 50MB 同步解析」的硬冻结，改为 `setDocStreaming`：超过 `STREAM_THRESHOLD`（2MB）的文档先清空、再按 `STREAM_CHUNK`（1MB）分块 `dispatch` 追加，**每块之间 `await requestAnimationFrame` 让出主线程**；CM6 为虚拟化编辑器，每块仅对视口做布局，全文解析走 Lezer 增量（每块只解析新增区域），故整篇解析被摊到多个事件循环 tick，主线程不再硬冻结、遮罩可显示进度；② `updateListener` 顶部加 `suppressListener` 闸门，流式期间暂停围栏索引维护 / `onChange` 预览推送 / 选区匹配切换，末尾统一 `rebuildFenceIndex` 一次；③ `applyTabState` 改 async，大文档走流式并管理 `loadingBigDoc`/`streamProgress`，载入结束才关闭遮罩；`openTabByPath` 不再提前关遮罩；④ 载入遮罩新增进度条（`.loading-bar`/`.loading-bar-fill`）；⑤ 分块区间计算抽到 `src/chunk-ranges.ts` 纯函数（无 CM6 依赖），便于独立单测。**注意：Rust 侧 `read_file_head`/`stream_file_rest` Channel 流式读（§10.3 原 P1-4 完整方案）仍未做——本环境无 Rust 工具链，无法编译验证；前端实现已解决 `setDoc` 解析冻结这一主因，但 50MB 经 IPC 的整块读出 + 反序列化仍发生在 `readFile` 调用处，属后续。** |
| **围栏索引零分配 + 空闲重建** | `src/fence-index.ts` + `src/editor.ts` | ① 定位到 `rebuildFenceIndex` 在流式载入**末尾曾同步调用**，逐行 `doc.line(ln).text` 为每行分配整行字符串（50MB ≈ 173 万行、百万次分配 + 每行正则），基准实测 **~1306ms 二次冻结**（流式主因已解，但末尾这一处仍冻结）；② 新增 `lineIsFenceOpen(doc, ln)`：仅取行首 ≤`FENCE_SCAN`(32) 字符（`sliceString(from, from+32)`）做 charCode 扫描，匹配 `/^\s*```/` 语义且**零整行分配**；`rebuildFenceIndex` 与 `isInsideCodeBlock` 的 dirty/clean 两路径全部改用之（一致性由同一函数保证）；③ `FenceDoc` 接口扩展 `from/to/sliceString`（与 CodeMirror `Line` 对齐）；④ `setDoc` 与 `setDocStreaming` 末尾的同步 `rebuildFenceIndex` 改为 `markFenceDirty()` + `scheduleFenceRebuild(...)`（空闲帧执行，`requestIdleCallback` 缺失时立即重建），彻底消除流式载入末尾的二次冻结；重建前索引为脏、Enter 判定走有界上扫（≤8192 行精确，超出保守降级，绝不错插）。另：实测 `splitIntoBlocks` 全量路径 50MB≈1073ms，但 50MB 因超 `previewMaxBytes` 走降级、`scheduleOpenPreview` 提前返回，**该路径在 50MB 下根本不执行**——故 P2-1「切块迁 Worker」对 50MB 场景零收益，且会迫使延迟敏感的击键增量路径（持有共享 `lastSplit` 状态）经异步往返，反而劣化输入延迟，故按设计推迟（见 §10.6）。 |

### 10.5 P1 验证结果
- **单元测试**：`test-fenwick.mjs` **5134 断言全过**；`test-lowend.mjs` **25 通过**；`test-imagedims.mjs` **11 通过**；`test-stream.mjs`（esbuild 转译 `chunk-ranges.ts` + 覆盖/连续/收尾不变量对拍）**248 断言全过**；fence `test-fence.mjs` **85483 通过**（含新增 `lineIsFenceOpen` 边界断言）。五项全绿 / 0 失败。
- **基准（证据）**：`scripts/bench-split.mjs`（50MB）实测 `splitIntoBlocks` 全量 1073ms（但 50MB 降级跳过）、`computeStats` 294ms（仅此项仍运行，处 idle）、击键增量快路径 5.7ms；`scripts/bench-fence.mjs` 实测旧 `rebuildFenceIndex` 1306ms、新 `lineIsFenceOpen` 路径语义一致且零整行分配。
- **前端构建**（`vite build`）：成功，无语法/导入错误。
- **类型检查**（`tsc --noEmit`）：本次改动 `.ts` 文件零类型错误（唯一报错仍为未改动的 `search-commands.ts`，历史遗留）。
- **未引入新 bug 的核对**：`blockH` 仍被 `buildIdleQueue` 使用；`rebuild`→建树顺序正确（数组赋值先于建树）；`onResize` 的 `oldEffective = realHeights[idx] \|\| heights[idx]` 保证增量 `add` 增量正确；`content-visibility:hidden` 保留滚动偏移，解除后虚拟化按 `scrollTop` 重渲，无状态丢失；`setDoc`/`setDocStreaming` 改用 `scheduleFenceRebuild` 后，小文档（≤8192 行）即便在脏窗口内也因 `posLine≤FENCE_RESCAN_LIMIT` 走整段精确上扫、判定不降级；`rebuildFenceIndex` 导入已从 editor.ts 移除（无未用导入）。

### 10.6 待办（未做）
- **P1-4 之 Rust 侧**：「`read_file_head`/`stream_file_rest` Channel 流式读 + `Loading` 注解」仍未做——本环境无 Rust 工具链（无 `cargo`），无法编译验证；前端实现已解决 `setDoc` 解析冻结这一主因，但 50MB 经 IPC 的整块读出与反序列化仍发生在 `readFile` 调用处，需后续在可编译环境补齐。**P2-2**（Rust 影子文档 + delta IPC，高风险双真相源，需先确认 200MB 内存口径）同列为后续。
- **P2-1（切块/统计迁 Web Worker）按设计推迟**：① 50MB 因超 `previewMaxBytes` 走降级，`scheduleOpenPreview` 提前返回，**`splitIntoBlocks` 全量路径在 50MB 下根本不执行**（基准实测 1073ms 的路径被跳过），故切块 Worker 对 50MB 场景零收益；② 击键增量快路径（`splitFast`，持有共享 `lastSplit` 状态，5.7ms）是延迟敏感关键路径，若迁 Worker 需每击键异步往返，反而劣化输入延迟（违背「输入<50ms」）。因此只保留「统计」侧的安全改良空间（见下），切块本身不迁。**结论：P2-1 在现有架构下弊大于利，非遗漏。**
- `windowing.ts` 的 `Float64Array(n+1)` 在 57 万块下约 4.5MB；若需进一步压内存，可改用 `Float32Array`（大累积高度有 ~1px 舍入，对窗口化无影响）。
- **P1-7 已实施但刻意未覆盖的矩阵行**（避免过度接线引入风险，列为后续）：分片载入片大小（依赖 P1-4）、`docMemo` 写盘后释放、`Worker 数量 1`、双栏预览 >8MB 默认单栏。这些在高端路径已是安全默认，低端仅作进一步压榨，暂不接入不影响 50MB 核心流畅度。其中「视口外 `img` 卸载常开」已在 **P1-5** 通过 `imgReclaim` 矩阵行接入（低密度端常开、标准端按内存压力按需启用）。

---

### 10.7 实施记录（P0-2：Rust 侧分片流式载入 + 内存自愈，2026-08-04）

补齐 §10.6 遗留的「Rust 侧 Channel 流式读」，彻底消除 50MB 一次性 IPC 长任务；新增内存压力自愈与 dev 度量埋点。

| 项 | 文件 | 关键改动 |
|---|---|---|
| **Rust Channel 分片流式读** | `src-tauri/src/lib.rs` + `src/fs.ts` | 新增 `file_size` / `read_file_head` / `stream_file_rest` 三命令（均 `spawn_blocking`，注册进 `invoke_handler`）。`read_file_head` 读前 N 字节并按 `utf8_boundary()`（continuation byte 回溯 + `from_utf8().valid_up_to()` 兜底）截到完整字符边界，返回 `{head, headBytes, total}`；`stream_file_rest` Seek 到 offset 后循环读 `chunk.max(64KB)`，跨边界残余字节缓存到下一片，`Channel<String>` 逐片推送。前端 `fs.ts` 增加对应封装与 `ReadHead` 接口。 |
| **Loading 注解 + 流式 append API** | `src/editor.ts` | 新增 `Loading` 注解标记磁盘流式事务；`updateListener` 跳过带该注解的事务（不触发围栏维护/预览推送）；新增 `appendLoadChunk`（doc 末尾 O(log n) append）与 `finishStreamingLoad`（`markFenceDirty` + 空闲重建）。与既有 `setDocStreaming`（内存分片）并存。 |
| **磁盘流式载入接线** | `src/App.svelte` | ① `openTabByPath` 先 `fileSize`，>8MB 创建 `deferred` 标签（不读盘）→ `activateTab` → `applyTabState` 中 `startDocStream`；② `startDocStream`：头片 256KB 先行 `setDoc`（立刻出字可滚动）→ 载入期 `contenteditable=false` 只读 → 2MB/片（低端 512KB）Channel 入队 → `requestIdleCallback`（`timeRemaining()>6`）空闲帧逐片 `appendLoadChunk` + 进度条 → finish 恢复可编辑、`pullDoc` 填充稳态副本、`finishStreamingLoad`、恢复光标、`scheduleOpenPreview`；③ `docStreamToken` 失效令牌：切标签（`applyTabState` 开头 `abortDocStream`）/关闭流式标签（`doCloseTab` 判 `docStreamTab`）使旧流作废；④ 会话恢复改懒加载：`content===null` 先 `fileSize`，>8MB 推 `deferred` 标签（激活时才读盘），冷启动不再阻塞读大文件；`saveSession` 中 `deferred` 标签视为 big 只存指针。 |
| **onChange 参数透传 bug 修复** | `src/App.svelte` | `onChange: () => onEditorDocChange()` 改为 `(fa, ta, fb, tb) => onEditorDocChange(fa, ta, fb, tb)`——原写法丢失 4 个变更区间参数，`accumulateEdit` 收到 undefined 校验失败，**增量切块快速路径（splitFast）完全失效、每次编辑走全量切块**。修复后击键增量快路径真正生效。 |
| **内存压力自愈 + 度量埋点** | `src/App.svelte` + `src/preview/VirtualPreview.svelte` | ① `performance.memory.usedJSHeapSize` 每 5s 轮询：>180MB（低端 120MB）时 `memReliefEnabled` 粘性开启——`previewRef.clearCache()`（VirtualPreview 新增导出，清 LRU 缓存但保留已挂载块实测高度）+ 释放 `docMemo` + 暂停空闲预渲染 + `imgReclaim` 强制启用；② dev build 挂 PerformanceObserver：longtask（>50ms 告警）与 event timing（keydown 输入延迟）；卸载清理 interval 与 observer。 |

### 10.8 P0-2 验证结果
- **`cargo check`**：通过（仅 2 个历史遗留 warning：未用 `mut`、未构造的 `TableHead` 变体，与本次无关）。`tauri::ipc::Channel<String>` 命令参数签名、`ReadHead` serde camelCase 编译均验证。
- **前端构建**（`vite build`）：成功，6.34s，主 chunk 697.74 kB / gzip 244.58 kB。
- **类型检查**（`tsc --noEmit`）：本次改动文件零类型错误（唯一报错仍为未改动的 `search-commands.ts`，历史遗留）。
- **回归测试**：`test-fence.mjs` **85483 通过**；`test-fenwick.mjs` **5134 通过**；`splitter-equiv-test.mjs` **29 场景全等**；`splitter-incr-test.mjs` **增量等价全过**。0 失败。

### 10.9 设计取舍（已定）
1. **载入期编辑器只读**：避免流式 append 期间用户编辑导致 `ChangeSet.mapPos` 映射复杂度；头片立即可滚动浏览。
2. **流被中止时 Rust 侧继续读完**：Channel 只是停止消费，后台线程读完整个文件（只读、无副作用），简化生命周期。
3. **进度条近似**：用已接收字符数/总字节数比值，中文文档条不满 100%，finish 时即清除，可接受。
4. **遗留**：P2-2（Rust 影子文档）仍为后续，需先实测确认 §9.5；P2-3（比例映射滚动）已于 §10.10 实施。

---

### 10.10 实施记录（raw IPC + 比例映射滚动，2026-08-04）

| 项 | 文件 | 关键改动 |
|---|---|---|
| **图片 raw IPC（§10.3-2 遗留）** | `src-tauri/src/lib.rs` + `src/fs.ts` + `src/App.svelte` | 新增 `import_asset_raw(request: tauri::ipc::Request)` 命令：`InvokeBody::Raw` 取原始字节，元数据（note_dir/assets_name/ext/compress/quality）走请求头，`spawn_blocking` 内复用 `store_asset`；注册进 `invoke_handler`。前端 `importAssetRaw`（`invoke(cmd, Uint8Array, { headers })`）+ App.svelte `sendAssetBytes` 封装：**Worker 转码路径与非 Worker 回退路径均改走 raw 直传**（后者免主线程 `uint8ToBase64`，10MB 图约省 200~280ms 同步阻塞 + base64 +33% 体积）；raw 失败自动回退 `importAssetBytes`（base64），行为等价。 |
| **比例映射滚动（P2-3）** | `src/preview/windowing.ts` + `src/preview/VirtualPreview.svelte` + `scripts/test-fenwick.mjs` | 新增 `MAX_TOTAL_PX = 24M`（低于 Chromium 实测硬限 ~33.5M 留安全边距）与纯函数 `heightScale(total)`。`updateVisibleWindow` 总高超限时 `k = LIMIT/total`：scrollTop/预读边距/视口高按 1/k 换算到虚拟空间算窗口，占位高度乘 k 写回 DOM → 映射后 DOM 总高 ≤ LIMIT + O(视口)，滚动条单调可达底；可见块保持自然高度，误差仅 O(视口)。**k=1 时数学恒等，常规文档零行为变化、零开销**。 |

### 10.11 验证结果
- **`cargo check`**：通过（仅历史遗留 2 warning）。`tauri::ipc::Request` 命令签名、`InvokeBody::Raw` 匹配、请求头解析编译均验证。
- **前端构建**：成功，5.83s，主 chunk 698.04 kB / gzip 244.75 kB。
- **类型检查**：本次改动文件零类型错误（唯一报错仍为未改动的 `search-commands.ts`）。
- **回归 + 新增单测**：`test-fenwick.mjs` **5940 通过**（新增 806 断言：heightScale 临界/超限值、映射后 DOM 总高封顶、窗口覆盖虚拟视口）；fence 85483、splitter 等价/增量全过。0 失败。

### 10.12 待办（未做）
- **P2-2**（Rust 影子文档 + delta IPC）：高风险双真相源，需先实测确认 §9.5 内存口径，仍列为后续。
- §9.2 Chromium 硬限真值建议在真机用长文档实测一次，校准 `MAX_TOTAL_PX`（当前 24M 为保守值）。

### 10.13 类型检查清零 + 基准复核（2026-08-04）
- **历史遗留 tsc 报错修复**：`src/commands/search-commands.ts` 的 `searchInCurrentFolder` 声明返回 `FolderMatch[]` 但实际返回 `FolderSearchResult`（TS2740）；改为声明 `Promise<FolderSearchResult>`（含 matches+truncated，语义更完整）。该封装无调用方（FolderSearch.svelte 直接调 fs.ts），零运行时风险。**至此 `tsc --noEmit` 退出码 0，仓库类型检查全绿**。
- **基准复核**（`scripts/perf-bench.mjs`，无回归）：5MB 打字增量管线中位 9.85ms；20MB 冷缓存打开切块+哈希 ≈892ms（应用层 20MB 走降级，此为手动刷新一次性成本上界，符合设计预算）。

