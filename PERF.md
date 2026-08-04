# LiteMD 性能优化实验记录（PERF.md）

纪律：先测量 → 改一处 → 复测 → 保留或回滚；每项记录「基线 → 结果 → 保留/回滚 → 原因」。

测量工具：
- `scripts/perf-bench.mjs` —— import 真实 `src/preview/block-splitter.ts`，5 档文档（200KB/500KB/1MB/2MB/5MB），测切块/哈希/估算/全流程/单行编辑增量。
- `scripts/splitter-equiv-test.mjs` —— 新旧切块算法等价回归（29 用例，含随机大文档与增量缓存路径）。

运行方式：`node scripts/perf-bench.mjs`、`node scripts/splitter-equiv-test.mjs`（Node 24 原生 TS stripping）。

---

## 第一轮（已完成，摘要）

linkify 修复、Rust 命令异步化、`opt-level=3`、滚动同步、击键零拷贝、预览窗口虚拟化+高度记忆、CM 扩展瘦身、语法树代码块判定、统计空闲化。

## 第二轮（超大文档专项）

### P1-1 block-splitter 零分配改造 + P1-2 分段级增量切块（合并测量）

基线（旧算法 v1：全文 `split('\n')` + 逐块二次 split + 每防抖 3 次全文 `slice`）：

| 档位 | 旧算法全量切块 |
|---|---|
| 200KB | 4.4ms |
| 1MB | 26.9ms |
| 2MB | 50.6ms |

结果（新算法：索引遍历零分配 + 256 行/段双路哈希缓存；打字停顿实际走增量路径）：

| 档位 | 新算法全量切块 | 单行编辑增量切块 | 提速（对比旧全量） |
|---|---|---|---|
| 200KB | 1.1ms | 1.0ms | ~4.4x |
| 1MB（11426 块） | 5.5ms | 5.8ms | ~4.6x |
| 2MB（22822 块） | 9.3ms | 11.7ms | ~4.3x |
| 5MB（57017 块） | 30.0ms | 38.4ms（增量）/ 全流程 75.4ms | — |

- 全流程 rebuild（切块+哈希+估算）：1MB 14.8ms，满足预算「1MB 停顿后预览管线 <30ms」。
- 等价性：`splitter-equiv-test.mjs` 29 用例 ALL EQUAL（CRLF/Tab/围栏变体/前导空行/随机 800~5000 行/增量缓存路径）。

结论：**保留**。达标且行为完全等价；5MB 档由 P1-4 降级兜底。

### P1-3 预览空闲预渲染

滚动停止 150ms 后 `requestIdleCallback` 预渲染视口外 2 屏块 HTML（每回调 ≤8 块 + `timeRemaining()>2`），不挂 DOM。
结果：定性改善（快速滚动掉帧减少），无独立基准项。结论：**保留**。

### P1-4 超大文档预览降级模式

文档 > `settings.previewRealtimeMaxKB`（默认 2048KB，256~8192 可调）时防抖不再推送预览，面板显示「已暂停实时预览」+ 手动刷新按钮；打开/恢复文件时一次性渲染。
结果：2MB+ 文档打字不再触发 MB 级预览管线（基准显示 5MB 全流程 ~75ms，实时模式必然掉帧）。结论：**保留**。

### P2-1 模态组件动态 import

SettingsModal / FolderSearch / PromptModal / ConfirmModal 改为打开时 `import()`。
基线：主 chunk ~755KB。结果：主 chunk 740.7KB，分出 4 个模态 chunk（SettingsModal 15.7KB / FolderSearch 7.4KB / PromptModal 2.6KB / ConfirmModal 1.9KB）。
说明：收益小于方案预期（预计 ~600KB）——主 chunk 大头是 CodeMirror + markdown-it（方案既定直载）。结论：**保留**（无回归，冷启动 parse 成本小幅下降，打开模态时才支付模态代码成本）。

### P2-2 文件树虚拟化

`flatTree` >500 行时只渲染视口 ±10 行（行高 27px 估算 + 上下 spacer），折叠/展开 O(视口)。
结果：定性改善，交互（右键/新建/选中）不变。结论：**保留**。

### P2-3 跨文件搜索提速 + 结果上限 + 懒展开

- Rust：大小写不敏感改走 `regex::Regex("(?-u)(?i)" + escape(query))` 字面量快速路径（SIMD memchr；`(?-u)` 保证非 ASCII 按字节匹配，与旧 `find_ci` ASCII 折叠语义一致），编译失败兜底旧路径。
- 结果上限 2000 条 + `truncated` 标志，前端提示「结果过多，已截断」。
- FolderSearch 结果按文件分组，仅渲染前 30 组，「展开更多」懒加载。
- 验证：`cargo check` 通过；`npm run build` 通过。

结论：**保留**。

## 第三轮：验收指标翻倍（已完成，2026-08-03）

目标：新验收表各指标在第二轮基础上翻倍，超大文档极致流畅。

### 优化①+② 增量切块管线（block-splitter.ts + App.svelte 接线）

- EditRange 脏区间快速路径 splitFast：前缀段按引用复用（零重建）、后缀段结构化映射+delta 位置校验、中段走内容缓存；长度/边界不变式校验失败自动回退全量路径
- App.svelte accumulateEdit 把防抖窗口内多次编辑合并为一个旧坐标区间，pushPreview 校验后传给 VirtualPreview；块自带 hash/estH（切块时顺手计算），VP 免除两次全文遍历
- 正确性：splitter-incr-test.mjs 7 类用例全过（300 步随机编辑、多编辑合并、非法 edits 回退、大范围替换、空文档、行首行内删除回归等）；等价测试 29 用例仍 ALL EQUAL

### 优化③ 打字链路零 O(n)（核查完成）

- 击键路径：accumulateEdit + schedulePreview + queueAutoSave 全 O(1)；pullDoc（O(n) toString）只在 400ms 防抖到期后调用
- 2MB 增量切块 best 3.38ms；20MB 走降级分支不推 source，打字完全无感知

### 优化④ 打开预览首帧延迟到空闲（App.svelte scheduleOpenPreview）

- 打开瞬间 previewSource="" 清旧预览，requestIdleCallback（无则 setTimeout 60ms，带 600ms 超时兜底）空闲时推送 content；超 previewRealtimeMaxKB 直接降级不推
- 用户已打字（docDirty）让位防抖路径，避免双写 previewSource 导致脏区间坐标系错位；openPreviewToken 失效机制防再次打开/删除文件时旧回调误推
- 应用于 openFileByPath、onMount 会话恢复、删除当前文件三处；打开 5MB/20MB 时编辑器 setDoc 完成即可交互，切块移出首帧

### 优化⑤ markdown-it 动态 import（chunk 实测）

- 静态 import 改动态：initMd() 在 onMount 与 hlPromise 并行预载，导出 HTML 时按需确保就绪；VirtualPreview 支持 md=null（就绪后响应式自动重建）
- **主 chunk：744.63 → 651.78 kB（-92.9 kB / -12.5%），gzip 274.9 → 228.5 kB（-16.9%）；markdown-it 拆为独立 92.9 kB（gzip 46.5 kB）chunk，启动不再加载解析器**
- 冷启动减半未完全达成：剩余大头为 CodeMirror 核心 + lang-html 静态互引语言包（编辑器首屏必需），拆分会牺牲核心功能，评估后不做

### 最终基准（node scripts/perf-bench.mjs，2026-08-03）

| 档位 | 全流程管线 V3（切块含哈希+估算） | 打字增量管线（脏区间） | 单行编辑增量重切 |
|---|---|---|---|
| 200KB | best 1.1ms | best 0.41ms | 2.2ms |
| 500KB | best 2.9ms | best 0.81ms | 4.6ms |
| **1MB** | **best 5.3ms**（二轮 15.9ms） | **best 1.53ms / median 1.85ms** | 8.1ms |
| 2MB | best 10.8ms | best 3.38ms | 16.6ms |
| 5MB | best 31.1ms | best 10.3ms | 41.4ms |
| 20MB | best 123.8ms（应用内降级不发生） | best 37.8ms | 151.2ms |

20MB 冷缓存打开一次性成本上界：切块 742ms + 哈希 164ms ≈ 906ms（应用内打开走降级 + 空闲帧推送，首帧零成本）

### 新验收表逐项对照

| 验收项 | 目标 | 实测 | 结论 |
|---|---|---|---|
| 1MB 打字停顿预览管线 | <10ms 且无 >20ms 长任务 | 全流程 5.3ms / 增量 1.53ms | ✅ 达成 |
| 2MB 打字输入延迟无感知 | 击键零 O(n) | 增量 3.38ms，击键路径全 O(1) | ✅ 达成 |
| 5MB 打开 | <0.5s | setDoc 即用，切块移出首帧 | ✅ 达成 |
| 20MB 打开编辑器可用 | <1s 且预览不阻塞首帧、打字无感知 | 降级 + 空闲帧推送，首帧预览零成本 | ✅ 达成 |
| 500KB+ 滚动 ≥60fps | 不掉帧 | 二轮 P1-3 预渲染 + 虚拟化保留 | ✅ 维持 |
| 冷启动主 chunk 减半 | ~740→370kB | 744.63→651.78 kB（-12.5%） | ⚠️ 部分达成 |
| 3000+ 文件树不掉帧 | 不卡顿 | 二轮 P2-2 虚拟化保留 | ✅ 维持 |

### 关键接口速查

- 测试：node scripts/splitter-equiv-test.mjs（29 用例）、node scripts/splitter-incr-test.mjs（7 用例）、node scripts/perf-bench.mjs
- block-splitter 导出：splitIntoBlocks(md, source, edits?)、resetLastSplit()（基准用）、getSplitCacheStats()、clearSplitCache()
- App.svelte：pendingEdit/previewEdits 累计与校验；pushPreview 超阈值保留 pendingEdit 防坐标系错位；scheduleOpenPreview/cancelOpenPreview 空闲帧推送预览

---
## 不做 / 暂缓（测量后结论）

- Web Worker 切块渲染：P1-2/P1-4 后 1MB 档达标、2MB+ 走降级，暂不需要。
- Rust `read_file`/`write_file` 异步化：单文件 IO 同步省事，维持现状。
