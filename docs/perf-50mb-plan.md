# LiteMD · 50MB 超大文档流畅度优化方案

> 目标：在 50MB Markdown 文档下，覆盖「软件运行 / 打开文件 / 缩小放大（窗口 resize）/ 窗口移动 / 文字输入 / 照片插入」六大场景，保持可交互、无长任务卡顿。
> 依据：当前 `PERF.md` 已把验收做到 20MB；50MB 是其 2.5 倍，且部分路径在 20MB 时已被「降级模式」绕过，50MB 会真实撞上这些路径。

---

## 0. 现状基线（哪些已不需要重做）

LiteMD 是 **Tauri 2 + Svelte 4 + CodeMirror 6 + markdown-it + VirtualPreview（虚拟化预览）**。已有能力直接覆盖 50MB 的一部分：

| 能力 | 位置 | 对 50MB 的意义 |
|---|---|---|
| 预览实时降级（`previewRealtimeMaxKB`，默认 2MB，256–8192 可调） | `App.svelte` `scheduleOpenPreview`/`pushPreview` | 50MB 默认走降级，**打字不触发 MB 级预览管线** ✅ |
| 增量切块 `block-splitter`（零分配 + 分段哈希缓存） | `src/preview/block-splitter.ts` | 打字增量 O(1)，但**全量切块对 50MB 仍是 ~300–500ms 同步阻塞** ⚠️ |
| 预览虚拟化（仅渲染视口 ±800px 块） | `src/preview/VirtualPreview.svelte` | 预览 DOM 不随文档变大 ⚠️ 但切块阶段仍吃全文档 |
| 打字零 O(n)（`accumulateEdit` + 防抖 `pullDoc`） | `App.svelte` `onEditorDocChange` | 击键路径 O(1) ✅，但 `pullDoc()` 在 400ms 防抖到期时对 50MB 仍是一次 ~30–50ms `toString` |
| 选区匹配高亮 >200KB 自动禁用 | `editor.ts` `SEL_MATCH_LIMIT` | 50MB 已禁用 ✅ |
| 编辑器本身 viewport 渲染 | CodeMirror 6 | 50MB 文本只在视口内建 DOM，编辑器交互本就不依赖全文 ⚠️ 但**首帧 `setDoc` 一次性载入全文档** |

**结论**：50MB 下「编辑器文字输入」基本已达标；真正的缺口在 **首帧载入（运行/打开）**、**照片插入的 IPC 成本**、**手动刷新降级文档**、以及 **窗口 resize/move 时的后台任务干扰**。

---

## 1. 50MB 风险地图

| 场景 | 当前行为 | 50MB 风险 |
|---|---|---|
| 软件运行（自动恢复标签） | `onMount` → 读 `openTabs` → `readFile` 全量 → `applyTabState` → `setDoc` | 50MB 同步读 + 同步 `setDoc` 冻结主线程，冷启动卡死数秒；多标签页会倍增 |
| 打开 50MB 文件 | `openFileByPath` → `readFile` → `setDoc` | 同上，单次打开即长任务；无进度反馈 |
| 缩小/放大（窗口 resize / 最大化 / 字体缩放） | 窗口尺寸变化 → CM6 重测视口 + `VirtualPreview` 容器 resize → `ResizeObserver` 批量校高 + `scheduleWindowUpdate` | 拖拽 resize 连续触发重排；若刷新了降级文档会触发全量切块；`appearance` 字体缩放走 Compartment 重配（OK） |
| 窗口移动 | 无 JS 监听 | 多数情况由 OS 合成器处理，几乎无成本 ✅；风险来自**移动期间仍在跑的空闲预渲染/自动保存**抢占帧 |
| 文字输入 | 击键 O(1)，预览降级不推 | 基本达标；`pullDoc` 400ms 防抖对 50MB 有轻微 hiccup |
| 照片插入 | 粘贴：`file.arrayBuffer()` → `uint8ToBase64` → `importAssetBytes(b64)` IPC；拖拽文件：`importAsset(path)` | **base64 字符串经 Tauri IPC 序列化/反序列化 50MB 级图片 = 数百 ms 阻塞 + 内存尖峰**；文档本身因用引用（`![](assets/x)`）不膨胀 ✅ |

---

## 2. 分场景优化方案

### 2.1 软件运行（冷启动自动恢复 50MB 标签）— P0
- **懒加载标签内容**：恢复 `openTabs` 时，仅重建标签元数据（路径/名称/大小），**不立即把 50MB 内容 `setDoc` 进编辑器**；内容延迟到该标签被 `activateTab` 激活时再读。
  - 改 `applyTabState`：当 `tab.content.length > LAZY_THRESHOLD`（建议 8MB）时，标记 `deferred`，编辑器先显示占位/空，激活后再 `readFile` + `setDoc`。
- **首屏不阻塞**：即使激活 50MB 标签，也先 `previewSource = ""` 让编辑器首帧空出，再在下一帧/空闲 `requestIdleCallback` 内 `setDoc`，期间显示「正在载入大文档…」遮罩。
- **自动恢复前确认**：若 `openTabs` 中存在 >20MB 文档，启动后提示「发现超大文档，是否载入？」，避免无谓占用内存。

### 2.2 打开 50MB 文件（选择器 / 拖拽）— P0
- 复用 2.1 的懒加载 + 遮罩逻辑；`openFileByPath` 对大文件走同一 `deferred` 路径。
- **读文件改为不卡 UI 的两段式**：先显示 spinner（在阻塞读之前就渲染出来），再 `await readFile`，最后 `setDoc`。保证用户看到反馈。
- （可选 P2）Rust `read_file` 改为分块流式读，前端按块 `dispatch` 增量插入，避免一次性大字符串与一次性大解析；CM6 增量插入可摊薄到多帧。

### 2.3 缩小/放大（窗口 resize / 最大化 / 字体缩放）— P1
- **resize 重排 rAF 节流**：`VirtualPreview` 的 `scheduleWindowUpdate` 已基于视口 + 估算高度，**确认其不在 resize 时强制同步布局读**；若 `ResizeObserver` 回调里读取 `clientHeight` 引发 reflow，改为在 `requestAnimationFrame` 内批量读取一次，避免「resize 事件风暴」下的布局抖动。
- **最大化/恢复为离散事件**：仅重排新视口块，复用估算高度，不重切块。
- **字体缩放**：已走 `appearanceCompartment.reconfigure` + 字号主题 LRU 缓存，属轻量操作，无需改；仅确认超大文档下不触发全文重高亮。

### 2.4 窗口移动 — P1
- **引入 `isWindowBusy` 标志**：监听 Tauri `onMoved` / `onResized`（窗口移动/缩放期间置 true，结束后 rAF 复位）。在 `true` 期间：
  - 暂停 `VirtualPreview` 的空闲预渲染（`stopIdlePrerender`）；
  - 推迟自动保存与 `pullDoc` 统计；
  - 不发起任何 `block-split` / 预览推送。
- 这样窗口移动只付出 OS 合成器成本，后台任务不抢帧，移动始终顺滑。

### 2.5 文字输入 — P1（基本达标，做加固）
- **`pullDoc` 移到空闲**：`>LAZY_THRESHOLD` 文档的 400ms 防抖 `pullDoc` 改为 `requestIdleCallback`，消除每次防抖到期的 ~30–50ms `toString` 卡顿。
- 其余（增量切块、降级不推预览）保持不变，确认 50MB 打字无感知。

### 2.6 照片插入 — P0
- **消除 base64 IPC**：粘贴路径改为 **直接传 `Uint8Array`（Tauri v2 对二进制参数走高效 ArrayBuffer 序列化，非 base64 字符串）**，或先把剪贴板图片写入临时文件、再调 `importAsset(path)`（与拖拽路径一致）。
  - 改 `importAssetBytes` 入参由 `dataB64: string` 改为 `data: Uint8Array`；`insertPastedImage` 不再调用 `uint8ToBase64`。
- **大图预压缩/降采样**：粘贴 >10MB 图片时，先在 Rust（image crate）或前端 canvas 降采样到合理分辨率再写入 `assets/`，避免把 50MB 照片塞进 50MB 文档的附件目录（文档本身仍只存引用，不变大 ✅）。
- **始终引用、绝不内联**：确认所有插入/迁移路径写入 `assets/` 相对引用；`migrateNoteContent` 已如此，保持。

---

## 3. 跨场景通用保障

1. **手动刷新硬上限（保护 运行/打开/照片插入）**：`refreshPreview()`（App.svelte:814）当前对降级文档仍 `pullDoc()` 全量 + 推 `previewSource`，对 50MB 触发 ~300–500ms 同步切块长任务。改为：**文档 > 硬上限（建议 8MB）时禁用「手动刷新」，提示「文档过大，预览已禁用」**；或在刷新时只先切视口块、剩余切块摊到 `requestIdleCallback`。
2. **统计/切块 Worker 化（P2）**：`computeStats` 单遍扫描 50MB ~20–40ms；`block-splitter` 全量切块可迁到 Web Worker（已记录在 PERF.md「暂缓」项，50MB 重新评估为值得做），主线程只收块边界，彻底消除长任务。
3. **内存纪律**：去掉 base64 尖峰后，50MB 文档峰值内存 ≈ 编辑器文本树(50MB) + 预览视口(小) + 附件(独立文件)，可控。

---

## 4. 验证与测量

- **扩展 `scripts/perf-bench.mjs`**：在 200KB/500KB/1MB/2MB/5MB/20MB 基础上加 **10MB / 30MB / 50MB** 三档，输出全量切块、增量切块、打字增量耗时。
- **交互基准（Playwright + PerformanceObserver）**：
  - 打开 50MB → 测 TTI、首帧 `setDoc` 长任务时长；
  - 连续击键 10s → 用 Long Tasks API 统计 >50ms 任务数；
  - 拖拽 resize 2s → 统计掉帧（frame delta > 20ms）；
  - 粘贴 15MB 图片 → 测从粘贴到插入引用完成的总时长与峰值内存。
- **回归**：`splitter-equiv-test.mjs` / `splitter-incr-test.mjs` 仍需全绿。

## 5. 优先级与实施顺序

| 优先级 | 项 | 覆盖场景 |
|---|---|---|
| **P0** | 标签内容懒加载 + 载入遮罩 | 运行、打开 |
| **P0** | 粘贴图片 base64 → 二进制/临时文件 + 大图降采样 | 照片插入 |
| **P0** | 手动刷新硬上限（>8MB 禁用或摊薄） | 运行、打开、照片插入 |
| **P1** | `isWindowBusy` 暂停后台任务 | 窗口移动、缩小放大 |
| **P1** | resize 重排 rAF 节流 + 避免同步 reflow | 缩小放大 |
| **P1** | `pullDoc` 移到空闲 | 文字输入 |
| **P2** | 切块/统计 Web Worker 化 | 全部（根除长任务） |
| **P2** | Rust 分块流式读 + 增量插入 | 运行、打开 |

## 6. 建议验收指标（50MB 档）

| 指标 | 目标 |
|---|---|
| 启动/打开 50MB 到可交互 | <1.5s（含懒加载激活），首帧 `setDoc` 不阻塞 UI 反馈 |
| 50MB 打字输入延迟 | 无 >20ms 长任务（击键 O(1) + 预览降级） |
| 拖拽 resize / 窗口移动 | 不掉帧（后台任务挂起） |
| 粘贴 15MB 图片 | <300ms 完成引用插入，无内存尖峰 |
| 手动刷新 50MB | 不触发同步长任务（禁用或摊薄） |
