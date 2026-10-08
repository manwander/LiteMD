# LiteMD 代码质量与功能可用性审计报告

> 审计对象：LiteMD v2.0.0（Svelte 5 + Tauri 2 + CodeMirror 6 + markdown-it）
> 审计日期：2026-10-08　运行平台目标：Windows / WebView2（Chromium）
> 代码规模：前端 ~18,972 行（.ts/.svelte/.css）、后端 Rust ~5,596 行
> 结论：架构与性能工程属上乘，但存在 **1 个必现的功能性 Critical 缺陷**、多个数据完整性与安全缺陷，尚未达到「功能完整、操作流畅、性能稳定」的可发布状态。

---

## 一、总体结论（Verdict）

| 维度 | 评级 | 说明 |
|---|---|---|
| 架构 / 工程质量 | ★★★★★ | 模块划分清晰，注释记录了历史缺陷根因（C-01 / m-08 / D-7 等），单测覆盖核心纯逻辑 |
| 性能与大数据处理 | ★★★★★ | Fenwick 树虚拟化、段级增量切块、LRU 字节上限、>24Mpx 高度映射，工程扎实 |
| 安全边界（前端渲染） | ★★★★☆ | DOMPurify 统一收口、sanitize 为渲染链最后一步；但后端 IPC 缺根目录约束 |
| 功能正确性 | ★★☆☆☆ | **图片粘贴/拖拽在目标平台上必现失败**；活动标签索引错乱可致静默丢改动 |
| 稳定性 | ★★★☆☆ | 任意 `writeFile`/对话框异常会被升级为全屏「致命错误」页，无兜底 |
| 可维护性 | ★★★☆☆ | App.svelte 3800 行 god-component、lib.rs 2525 行单体；设计令牌不完整 |

**能否发布：暂不建议。** 存在必现的核心功能损坏与数据完整性缺陷，须先修复 §三 的 P0/P1 项。

---

## 二、检查方法与基线

1. **静态门禁（实测全绿）**：`vitest run` → 23 文件 / **225 用例全部通过**；`tsc --noEmit` → **0 错误**；`vite build` → 成功（入口 507.90 kB / gzip 184.76 kB，仅非致命 `INEFFECTIVE_DYNAMIC_IMPORT` 分包提示）。
2. **前端深度审查**：HTML/CSS/JS 结构、渲染引擎（sanitize / block-splitter / highlight / fence-index / windowing / VirtualPreview）、编辑器（editor.ts / preview-edit-keys）、附件与导入导出、App.svelte / FileTree.svelte 组件生命周期。
3. **后端深度审查**：Tauri 命令面、路径校验、权限与 capability、WebDAV 同步引擎、panic/资源风险。
4. **运行时验证探针**：对两条最高价值缺陷做了可复现验证（见 §六）。

> 静态检查全绿恰恰说明问题所在：**类型系统没拦住跨 Worker 边界的协议错配，单测没覆盖「关闭非活动标签后的索引一致性」**。这类缺陷只能靠代码审查 + 功能测试发现。

---

## 三、缺陷清单（按严重度）

### 🔴 P0 — Critical（阻断核心功能 / 数据损坏，必须立即修）

**C-1｜图片粘贴 / 拖拽在 Windows 上必现失败（附件管线整条不可用）**
- 位置：`src/image-worker-client.ts:66` ↔ `src/workers/image-worker.ts:25`，调用方 `src/App.svelte:2836-2864`
- 证据：客户端发送**嵌套**载荷 `w.postMessage({ blob, opts })`；Worker 却**扁平**解构 `const { blob, maxEdge, quality, lossless, format } = e.data;`。于是 `maxEdge=undefined` → `scale=NaN` → `w/h=NaN` → `new OffscreenCanvas(NaN, NaN)` 抛错 → Worker 回 `{error}` → 客户端 reject。
- 影响放大：`App.svelte:2838` 只要 `imageWorkerSupported()` 为真（所有现代 WebView2 均为真）就走 Worker 路径；而原始字节回退分支（`:2852`）只在**不支持** Worker 时进入 —— 恰好与应有兜底相反。`processImageInWorker` 的 reject 落入 `catch`（:2862）→ 状态栏 `图片收编失败` → 图片**不插入**。粘贴/拖拽截图、Web 图片一律失败。
- 修复：`w.postMessage({ blob, ...opts })`（或 Worker 端解 `e.data.opts`）；两文件共享同一 `Req/Res` 类型模块，杜绝手抄接口导致的漏检。

**C-2｜关闭「非活动且位于活动标签之前」的干净标签 → activeIdx 越界，可静默丢失未保存改动**
- 位置：`src/App.svelte:741-784`（`doCloseTab`）
- 证据：仅在 `wasActive` 分支调整 `activeIdx`，缺少 `idx < activeIdx` 时的 `activeIdx--`。复现：标签 [A,B,C]、C 为活动（activeIdx=2），点 ✕ 关闭干净的 A → 数组长度变 2 但 activeIdx 仍为 2（越界）。此后 `save()` 的 `tabs[activeIdx]`（:2140）为 `undefined`、`queueSessionSave`/`requestClose` 的 `syncTabState` 被跳过 → C 的真实改动对脏检测不可见 → 退出提示不弹、改动被静默丢弃；且无标签呈现「激活」高亮。
- 对比正解：`src/tabs.ts:34-38` 的 `renameTabPathDedup` 正确处理了三种索引位移，`doCloseTab` 应对齐同样逻辑。
- 修复：`else if (idx < activeIdx) activeIdx--;`

### 🟠 P1 — High（功能正确性 / 数据安全 / 安全边界）

**H-1｜普通保存 / 导出 / 打开对话框的任何异常，被升级为全屏「致命错误」页**
- 位置：`App.svelte:3125-3128`（`run()` 丢弃 Promise）、`:2136/2162`（`save`/`saveAs` 无 try/catch）、`:1275-1282`（`unhandledrejection → fatalError`）。
- 问题：`Ctrl+S → run(e, save)` 不 await/catch，磁盘满/文件被占用/权限错误的 `writeFile` reject 命中全局兜底 → 弹「出错了 / 只能重启应用」，把一次可恢复的瞬时失败变成伪崩溃，并在「保存并关闭」路径上让关闭队列卡死（`onCloseTabSave:718` 先 `await save()` 抛错，`resolveCurrent` 不执行）。
- 修复：`save()`/`saveAs()`/各 export 内部 try/catch → 状态栏 + toast；`run()` 捕获异步 fn 的 reject。

**H-2｜「保存并关闭」可关成「未保存」——save() 的前置拦截静默早退后仍执行 doCloseTab**
- 位置：`App.svelte:711-722`（`onCloseTabSave`）配合 `save()` 早退分支 `:2113-2128`。
- 问题：`save()` 在 `suppressSave` / `lastSaved===null` / `loadFailed` 时是 `return`（不抛错），随后直落 `doCloseTab(p)` —— 用户明确点「保存并关闭」却被无保存关闭。且保存目标是活的 `currentPath` 而非队列的 `p`，激活切换存在异步竞态窗口。
- 修复：按 `tab.content → tab.path` 直存队列标签，仅在保存确实成功后才 `doCloseTab(p)`。

**H-3｜后端文件写/删命令缺「根目录包含性」约束（与代码内安全注释相悖）**
- 位置：`src-tauri/src/lib.rs:29-51`（`validate_path` 仅词法去 `..`，绝对路径原样放行）、`write_file:498`、`create_file`、`delete_path:557` / `delete_path_permanent:568`（**完全不经 validate_path**）。
- 问题：一旦 WebView 被 XSS/恶意 .md/供应链 JS 攻破，即可任意绝对路径读写、乃至任意（不可逆）删除（`delete_path_permanent` 走 `fs::remove_*`）。代码多处注释声称「即使前端被 XSS 注入，也无法通过 IPC 读写任意文件」——实为不成立。
- 修复：维护「用户经对话框授权的根集合」，读写删前 `canonicalize().starts_with(root)`。项目内 `cleanup_orphans_with:1229-1243` 已有正确范式可复用。

**H-4｜assetProtocol 作用域 `["**"]` + CSP 放行 `asset:` → 全量本地文件读取面**
- 位置：`src-tauri/tauri.conf.json`。任何可达 WebView 的代码可用 `<img src="http://asset.localhost/C:/Users/...">` 外传任意本地文件。建议按文档/附件目录收窄作用域。

**H-5｜`open_external` Windows 分支存在 cmd 注入面**
- 位置：`App`→`lib.rs:2236-2264`：虽有 http(s) 前缀闸，但仍把 URL 交给 `cmd /c start "" <url>`；Rust 按 MSVC 规则转义 argv，`cmd.exe` 再解析不同（`\"` 非转义引号），含空格+引号的 URL 可逃逸执行额外命令。建议改用 `ShellExecuteW`/`explorer.exe`（同文件 `reveal_in_explorer:698` 已是无 shell 正确做法）。

**H-6｜导出 HTML 的图片资源在应用外不可用**
- 位置：`App.svelte:187-223`（图片规则把本地 src 改写为 `convertFileSrc`）→ `exportHtmlDoc:2228-2245` 直接内嵌该 HTML。独立 HTML 里是 `http://asset.localhost/...`（Win）/`asset://...`，离开应用后图片全断。导出应改用相对路径或 data-URI（bundled-md 已会内嵌）。

---

## 四、分领域详述

### 4.1 前端 HTML / CSS / JS

**HTML 结构**：`index.html` 极简正确（`lang="zh-CN"`、charset、viewport、单一 `#app` + `type=module` 入口）。无 SSR/语义问题。

**CSS（style.css 1872 行）**
- ✅ 有真实设计令牌层（`--bg/--panel/--text/--accent` + `:root[data-theme="dark"]`），chrome 基本走变量。
- 🔴 **引用了从未定义、且无回退的变量**：`var(--bg-soft)`（:507、:1071，重命名/筛选输入框背景 → 变透明）、`var(--muted)`（:729、:777）。已实测确认全文无定义。
- 🟠 **预览链接无样式**：全文无 `.preview-content a` / `.preview-edit a` / 裸 `a{}`（grep 确认）。导出模板里的 `a{color:#0f6e56}`（App.svelte:2239）属字符串模板、不进组件作用域 → 实时预览里链接回落浏览器默认蓝/紫，深色模式不可读。
- 🟠 **语义色散落硬编码、深色模式对比度不足 AA**：≥6 种红（`#c0392b/#d32f2f/#e0483d/#e57373/#d23/#e81123`）、`--danger` 仅以回退值出现从未定义（:1099）；`#b26a00`/`#1a7f37` 深底约 3.5:1、亮色语法注释 `#a0a1a7` 约 2.4:1。建议引入 `--success/--warning/--danger` 令牌并按主题取值。
- 🟡 次要文字用 `opacity:.5~.85` 叠加已灰文本，逼近 ~2.5:1；`.brand` 渐变末色 `#2324a8` 深底 ~1.6:1 近乎隐形。
- 🟡 Markdown 预览排印在 `.preview-content` 与 `.preview-edit` 两处重复且不一致（`.preview-edit h3` 有、`.preview-content h3` 无；h4–h6/hr/p/inline code 背景缺失）。
- 🟡 键盘可达性：菜单/标签/条目多为 `<div onclick>` + `svelte-ignore a11y-*`，无 `:focus-visible` 环；`.factions` 仅 hover 显现；部分命中区 <24px。
- 🟡 固定宽度侧栏（`.sidebar 240px` + `.preview 440px`、`flex-shrink:0`）无窄窗回退；`.quick-menu` 缺 `z-index` 依赖源序；无 `prefers-reduced-motion`。

**JS（App.svelte / FileTree.svelte）**
- 🔴/🟠 见 C-2、H-1、H-2。
- 🟠 **监听器/定时器泄漏**：`window error` / `unhandledrejection`（:1270/1275）匿名注册、从不移除；`matchMedia` change 未随卸载移除；异步 `listen()/onDragDropEvent().then(fn=>unlistenX=fn)` 无 `disposed` 守卫，FileTree 在聚焦模式下反复 `{#if}` 挂/卸 → 重挂叠加监听。`saveTimer/renderTimer/sessionTimer/previewEditTimer` 不在卸载/关标签时清理，陈旧自动保存会对「新活动标签」误触发。
- 🟡 Svelte 5 **实际零 runes**，全量 legacy（`let`+`$:`+store）：通过别名改 `tab.dirty=false` 不触发失效，脏点圆点会残留，需 `tabs=[...tabs]` 手动踢（部分路径已做、部分遗漏）。
- 🟡 导出 HTML `<title>${title}</title>`（:2233）未转义文件名（`</title>` 可注入）。
- 🟡 遗留 `document.execCommand` / `window.prompt`；多处 `catch(e){throw e;}`、`"manual"?"normal":"normal"` 恒等、定义未调用的 `safeTop()/activeTab()` 等死代码。

### 4.2 业务逻辑（解析引擎 / 编辑 / 导入导出 / 格式转换）

- **解析引擎**：markdown-it（`html:true`）+ 虚拟化切块（block-splitter）+ DOMPurify 收口。架构成熟：`renderBlock` 严格 `sanitizeHtml(postProcessHtml(md.render(slice)))`，sanitize 为最后一步，杜绝渲染链绕过。
  - ⚠️ **虚拟化保真度局限（实测复现）**：切块按「空行」切，而 CommonMark 把「空行分隔的列表项」视为**同一个**松散列表块。实测：`- a\n\n- b` 整篇渲染为**单个** `<ul>` 含两个 `<li><p>`；虚拟化路径产出**两个单条紧凑 `<ul>`**。因 `VirtualPreview` 无条件使用（App.svelte:3499），**凡松散列表 / 跨空行的块**（含多段列表项、跨空行 HTML 块）实时预览的结构与间距都与标准渲染有偏差（有序列表编号靠 `start` 属性尚存，但被拆成多组 `<ol>`）。建议对松散列表等场景补测并校正切块边界。
  - ✅ `highlight.ts` 语言按需异步注册 + LRU（键含全文校验防误命中）；`fence-index.ts` 奇偶检查点 + 脏区有界回退，50MB 文档 O(1) 判定。
- **编辑器（editor.ts 1169 行）**：undo 纪律优秀（每命令单事务、`changeByRange/mapPos` 避免历史越界）。
  - 🟠 **「下划线」命令产出加粗**：`format.underline = wrapCmd("__")`（:267），CommonMark 下 `__x__`→`<strong>`；turndown 镜像同错（App:1941）。应改 `<u>x</u>`（html:true 支持）。
  - 🟠 `isInsideCodeBlock`（:1034）只看最内层语法节点，代码块内回车「跳出闭合围栏」路径误判（应像 lang-markdown 那样向上遍历 `node.parent`）。
  - 🟡 行级命令把「选到行尾（anchor 落在下一行首）」的下一行一并处理；`setHeading` 只动首行忽略多选；`wrapSelection` 仅查选区自身边缘，选中 `**bold**` 内部再按 Ctrl+B 会叠成 `****`；链接/图片 alt 文本未转义 `] )`。
- **导入 / 导出 / 格式转换**：
  - ✅ turndown（HTML→MD）配 gfm 插件，表格/任务/删除线/代码可用；仅服务预览编辑回写环，无「导入 HTML 文件」功能；throw 路径有兜底。
  - 🟠 见 H-6（导出 HTML 图片失效）、M7（bundled-md 无体积上限、PDF 静默丢全部图片）。
  - 🟠 附件相对引用未做 `<>` 包裹（editor.ts:746 仅包绝对路径），目录名含空格/括号/CJK 时 `![](my note (x)_attachment/…)` 破坏 GFM 解析；预览编辑回写丢有序列表 `start`（preview-edit-keys:544 设了 start，turndown 无对应规则）。

### 4.3 功能可用性（对应「逐项功能是否正常」）

| 功能 | 状态 | 说明 |
|---|---|---|
| 文本编辑 | ✅ | CodeMirror 6，编辑/撤销/查找替换正常 |
| 格式排版（粗体/标题/引用/列表） | ⚠️ | 基本可用；「下划线=加粗」错误、多选行边界瑕疵 |
| 实时预览 | ⚠️ | 常规文档正确；**松散列表保真度偏差**；链接无样式 |
| 图片插入 | ❌ | **粘贴/拖拽必现失败（C-1）**；未保存笔记时正常提示「先保存」 |
| 表格创建 | ✅ | 模板为合法 GFM，光标落位正确；addColumn 丢对齐标记 |
| 代码块高亮 | ✅ | 语言白名单按需加载 + LRU 缓存，设计良好 |
| 文件保存 | ⚠️ | 正常可保存；**异常时升级致命错误页（H-1）**；关标签索引错乱可丢改动（C-2） |
| 文件加载 | ✅ | 大文件分块/流式载入有 loadFailed/suppressSave 护栏 |
| 导出 HTML / PDF / 打包MD | ⚠️ | 可用但图片资源处理有缺陷（H-6 / M7） |
| WebDAV 双向同步 | ✅（逻辑）/ ⚠️（安全） | 冲突/失败保护设计扎实，无陈旧远端删本地；凭据明文/可关 TLS 校验需整改 |

### 4.4 性能与稳定性

- ✅ **性能是本项目最强项**：Fenwick 前缀和把每帧窗口计算降到 O(log²n)；段级增量切块（脏区快速路径 + 结构化长度校验防误复用）；VirtualPreview LRU 块缓存带字节上限、驱逐而非清空、实测高度跨 source 继承；>24Mpx 高度比例映射规避 Chromium 元素高度硬限；图片转码卸载到 Worker + transferable 零拷贝；低端设备降级矩阵（关 will-change/backdrop/预渲染、剥离视口外 `<img>` 回收位图）。
- ⚠️ **稳定性隐患**：
  - 后端 `Cargo.toml panic="abort"` 使任一 panic（含 WebDAV `to_rel_under:160` 的 Unicode 大小写长度切片 panic）直接崩溃整个应用而非仅终止任务。
  - 前端「任何未捕获 reject → 全屏 fatalError 页」的兜底策略过于激进（H-1），可恢复错误也变成伪崩溃。
  - 内存/监听器泄漏点见 §4.1（FileTree 反复挂卸叠加监听；`log_frontend`/启动日志无轮转）。
  - WebDAV 下载未套用 `max_file_size`（engine.rs:628 / webdav.rs:348），恶意/超大远端对象按并发（≤16）整体入内存，有耗尽风险。

### 4.5 安全（后端 / 权限 / 同步）补充

- 🟠 凭据明文存于 `settings.json`、无系统钥匙串（sync/mod.rs + lib.rs load/save_settings）；`normalize_base` 允许 `http://` 明文传 Basic auth；`danger_accept_invalid_certs`（webdav.rs:91）一键关闭全部证书校验 → MITM。
- ✅ **正面对照**：WebDAV 同步引擎数据安全设计扎实——空远端 + 非空本地时丢弃全部 `DeleteLocal`、删除量超 `max(20,30%)` 快照即中止、列目录失败先于任何变更 `?` 早退、`KeepBoth` 双侧保留、脏开标签不被下载覆盖、大小写冲突检测。审查未发现 Normal 模式下「陈旧远端态静默删/覆盖本地」路径。
- 🟡 `lib.rs` 2525 行单体、`validate_path` 名不副实（只规范不含校验）、生产路径 `eprintln!` 逐次打日志、release 仍带 devtools。

---

## 五、做得好的地方（应保留）

1. 渲染安全单一收口 `sanitize.ts`（DOMPurify 收窄白名单 + 外链 noopener + input 降级 + 无 DOM 兜底），且 sanitize 恒为渲染链最后一步。
2. 大数据性能工程（Fenwick / 段缓存 / LRU 字节上限 / 高度比例映射 / Worker 卸载 / 低端降级）在同类编辑器中属第一梯队。
3. P0 数据护栏思路到位：`loadFailed`/`deferred` 关闭短路、`suppressSave`、`lastSaved===null` 禁写、流式令牌失效。
4. `tab-close-queue.ts` 是可测的 FIFO 状态机，修掉了旧「单槽关其他丢提示」问题；`tabs.ts` 索引位移处理正确（可作为 C-2 修复参考）。
5. 纯函数逻辑（hashRange / chunk-ranges / fence-index / windowing）配套单测，可测性好。

---

## 六、修复优先级路线图

**P0（发布前必改）**
1. 修 C-1 Worker 消息协议（共享类型模块），并加一条 Worker 路径的功能/集成测试防回归。
2. 修 C-2 `doCloseTab` 的 `idx < activeIdx` 索引递减 + 补对应单测。

**P1（近期）**
3. save/export/open 全面 try/catch → toast，`run()` 捕获异步 reject（H-1）。
4. `onCloseTabSave` 改为按队列标签直存、成功再关（H-2）。
5. 后端 `write/create/delete/replace/list` 统一「授权根包含性」校验（H-3）+ 收窄 assetProtocol 作用域（H-4）+ `open_external` 去 shell（H-5）。
6. CSS 补齐 `--bg-soft/--muted` 定义与预览 `a{}`；语义色令牌化（含深色 AA 对比）。
7. 导出 HTML 图片相对/data-URI 化（H-6）；监听器/定时器 teardown 补全与 `disposed` 守卫。

**P2（改进）**
8. 修「下划线=加粗」、代码块内回车跳出、松散列表保真度、有序列表 `start` 回写、相对附件引用 `<>` 包裹。
9. WebDAV 凭据入系统钥匙串、默认禁明文 http、`ignore_tls_errors` 需显式确认、下载套 `max_file_size`。
10. 重估 `panic="abort"`、拆分 lib.rs 与 App.svelte、去遗留 `execCommand`、移除生产日志/devtools。

---

## 附录：验证证据

- 基线：`vitest run` 225/225 通过；`tsc --noEmit` 0 错；`vite build` 成功。
- C-1：`image-worker-client.ts:66` 发送 `{blob, opts}`；`image-worker.ts:25` 扁平解构 `{blob, maxEdge,…}` → `maxEdge` 未定义 → `OffscreenCanvas(NaN,NaN)` 抛错；`App.svelte:2838/2852` 回退分支在「不支持 Worker」时才走，方向相反。
- C-2：`App.svelte:741-784` 缺 `idx<activeIdx` 分支；对照正确实现 `tabs.ts:34-38`。
- CSS 变量：grep `--bg-soft`/`--muted` 仅出现在 `var()` 使用处（:507/:1071、:729/:777），无 `:root` 定义。
- 预览链接：grep 无 `.preview-content a`/`.preview-edit a`/裸 `a{` 规则。
- 松散列表保真度：markdown-it 实测
  - 整篇：`<ul><li><p>item one</p></li><li><p>item two</p></li></ul>`
  - 分块（空行切）：`<ul><li>item one</li></ul>` + `<ul><li>item two</li></ul>`（有序列表被拆为 `<ol>` 与 `<ol start="2">`）。
