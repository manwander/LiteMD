# LiteMD 修复与验证报告

> 承接《LiteMD 代码审计报告》。本报告逐条登记每个已识别问题的处置状态与验证证据。
> 日期：2026-10-08　平台：Windows / WebView2
> 处置口径：**已修复**=已改代码并通过可跑的验证；**已加固/已澄清**=做了安全或稳健性改进但完整方案需产品决策；**暂缓**=需产品决策 / 新依赖 / 无法在本机验证，附理由。

---

## 一、验证门禁（全部通过）

| 检查 | 命令 | 结果 |
|---|---|---|
| 单元测试 | `vitest run` | **240 passed (24 files)**（基线 225 → +15 新增用例） |
| 类型检查 | `tsc --noEmit` | **0 错误** |
| 生产构建（含 Svelte 编译） | `vite build` | **成功**，无编译错误 |
| Rust 后端 | `cargo check/test` | ⚠️ **本机无 Rust 工具链，未能编译验证**（见 §四） |

新增用例：`tabs.test.ts`（computeActiveIdxAfterClose，4 例）、`image-worker.test.ts`（computeScaledDims NaN 兜底 + Worker 载荷/FIFO 关联契约，7 例）、`editor-format.test.ts`（wrapTags 下划线 toggle，4 例）。

---

## 二、逐条处置台账

### 🔴 P0 Critical

| ID | 问题 | 状态 | 处置 |
|---|---|---|---|
| C-1 | 图片 Worker 载荷形状错配 → 粘贴/拖拽图必现失败 | **已修复** | 新增 `image-worker-protocol.ts` 为两端共享类型单一来源；Worker 改从 `e.data.opts` 取参；`computeScaledDims` 纯函数 + 非有限 `maxEdge` 兜底（杜绝 `OffscreenCanvas(NaN)`）；FIFO 响应队列修正并发关联（H2）；Worker 崩溃时 `workerFailed` + 终止回收（M3）。调用方 `App.assetFromImageFile` 增加**运行期失败 → 原图字节回退**（此前仅在「不支持 Worker」时才回退，方向相反）。 |
| C-2 | 关闭非活动标签致 activeIdx 越界，可静默丢改动 | **已修复** | `tabs.ts` 新增纯函数 `computeActiveIdxAfterClose`，覆盖「关前/关后/关激活」三情形；`doCloseTab` 改用它并统一维护 `activeIdx`。单测固化回归。 |

### 🟠 P1 High

| ID | 问题 | 状态 | 处置 |
|---|---|---|---|
| H-1 | save/导出/对话框异常被升级成全屏致命页 | **已修复** | 新增 `ioFail()`：`save`/`saveAs`/`exportMarkdown`/`exportPdfDoc`/`exportHtmlDoc`/`exportBundledMd` 的写盘/导出 IPC 全部 try/catch → 状态栏 + toast，不再冒泡；`run()` 兜住 handler 的同步与异步 reject；致命页新增「继续编辑」逃生阀 `dismissFatal()`。 |
| H-2 | 「保存并关闭」可被无保存关闭（save 静默早退后仍 doCloseTab） | **已修复** | 重写 `onCloseTabSave`：直接写盘被关闭标签自身的 `content→path`，仅写盘成功后 `doCloseTab`；`loadFailed` 标签不写盘；写盘失败保留标签并提示。`queueSessionSave` 增加 `suppressSave/loadingBigDoc/docStreamTab` 守卫，杜绝流式半载被落盘截断。 |
| H-3 | 后端写/删/替换缺根目录包含性（与注释相悖） | **已加固/已澄清** | 删除命令 `delete_path`/`delete_path_permanent` 已改为先过 `validate_path`（此前完全跳过、`..` 不规范化）；`validate_path` 的**虚假安全承诺注释**改为如实描述威胁模型。**完整授权根集合**暂缓（见 §三：会改变冷启动文件关联/对话框任意选择等入口语义，属产品决策且本会话无法验证不破坏主流程）。 |
| H-4 | assetProtocol 作用域 `["**"]` | **暂缓** | 静态收窄会打断「打开任意文件夹后预览本地图」的主用法；正确做法是运行期 `asset_protocol_scope().allow_directory()` 按打开目录动态放行——需 Rust 改动 + 真机验证，本会话不宜盲改。已在 lib.rs 注释与建议中登记。 |
| H-5 | `open_external` 经 `cmd /c start` 注入面 | **已修复** | Windows 分支改为 `explorer.exe <url>` 无 shell 直投默认浏览器（对齐同文件 `reveal_in_explorer` 的正确做法），消除 cmd 二次解析逃逸。 |
| H-6 | 导出 HTML 图片用 `asset://` → 应用外全断 | **已修复** | 新增 `exportingHtml` 渲染标志：导出 HTML 期间图片规则跳过 `convertFileSrc` 与目录绝对化，保留相对引用（连同 assets 目录分享即可显示）。 |

### 🟡 Medium / 其它已处理

| ID | 问题 | 状态 | 处置 |
|---|---|---|---|
| M1 | 「下划线」产出加粗（`__x__`→strong） | **已修复** | 新增 `editor.wrapTags` 成对标签命令，`format.underline` 与工具栏改产 `<u>x</u>`（html:true + sanitize 保留 `<u>`）；turndown `<u>` 规则改为保留 `<u>` 而非 `__`；4 条 wrapTags 单测。 |
| M6(前端) | 导出 HTML `<title>` 未转义 | **已修复** | 新增 `escapeHtmlText()`，标题走转义。 |
| CSS #2 | 引用了未定义变量 `--bg-soft`/`--muted` | **已修复** | 深/浅主题各补齐 `--bg-soft/--muted/--text-3` 及语义色 `--danger/--success/--warning`。 |
| CSS #1 | 预览链接无样式（深色不可读） | **已修复** | `.preview-content a / .preview-edit a` 走 `--accent` + 下划线；inline code 补背景。 |
| CSS #9 | 缺 `:focus-visible` 与 `prefers-reduced-motion` | **已修复（部分）** | 新增全局 `:focus-visible` 焦点环 + `prefers-reduced-motion` 降级块。**div 型控件的可键盘操作（role/tabindex）**暂缓（改动面大、需逐处交互验证）。 |
| 内存/监听器泄漏 | 全局 error/rejection/matchMedia 从不 remove；异步 unlisten 竞态；定时器不清 | **已修复** | error/rejection 改命名 handler 并在卸载 remove；matchMedia 句柄 `schemeMq` 保存并 remove；4 处窗口 API + `listen("open-files")` + FileTree `onDragDropEvent` 全部加 `disposed` 守卫（销毁即回收）；`doCloseTab` 清 saveTimer/renderTimer，卸载清 save/render/session/previewEdit 四个定时器。 |
| Rust M6 | WebDAV `to_rel_under` Unicode 切片 panic（panic=abort 崩全程序） | **已修复** | 改字符边界安全的切点回退；纯 ASCII 行为不变。 |
| Rust M5 | 远端下载未套 `max_file_size` | **已修复** | `run_folder_sync` 在计划后用 PROPFIND 的 size 过滤超限下载项并入 skipped（不删本地、不影响上传）。 |

---

## 三、暂缓项与理由（需产品决策 / 依赖 / 真机验证）

1. **后端授权根集合（H-3 完整方案）**：编辑器的合法用法就是打开/保存用户经系统对话框选择的任意路径文件；命令层无法区分「用户意图」与「被 XSS 注入的 IPC」。强行做包含性会破坏冷启动文件关联、导出另存到任意目录等主流程。本会话已落地的安全增量是「删除路径规范化 + 纠正虚假注释」；完整方案建议在能真机回归的环境下实施，并明确以 CSP 为主防线。
2. **assetProtocol 收窄（H-4）**：静态收窄必然打断任意目录预览；需运行期动态 scope，属独立特性 + 真机测试。
3. **WebDAV 凭据入系统钥匙串 / 默认禁明文 http / `ignore_tls_errors` 显式确认（M4）**：引入 `keyring` 新依赖 + 迁移既有 settings.json，超出一轮修复范围；当前已确认密码未被写日志。
4. **`panic="abort"` 重估、lib.rs(2.5k 行) 与 App.svelte(3.8k 行 god-component) 拆分**：架构级重构，风险高、收益是长期可维护性，宜单列专项。
5. **松散列表虚拟化保真度（渲染 fidelity）**：block-splitter 按空行切块，与 CommonMark「空行分隔的松散列表属同一块」不一致（实测：`- a\n\n- b` 被拆成两个单条 `<ul>`）。修正需让切块边界尊重列表跨空行延续，属渲染引擎逻辑改动 + 需要保真度对照测试，建议专项处理。
6. **div 控件键盘可达性、PDF 导出丢图、turndown 有序列表 `start` 回写、相对附件 `<>` 包裹**等 Medium/Low：已登记，未在本轮逐一修复（避免在不可全量回归的情况下引入连锁改动）。

---

## 四、Rust 验证说明（重要）

本机 `cargo`/`rustc` **不可用**，因此 §二中标注的三处后端改动（delete 走 validate_path、open_external 去 shell、to_rel_under 边界安全、WebDAV 下载 size 过滤）**未经编译器验证**。改动均按保守、类型自洽的原则书写，但合并前**必须在装有 Rust 工具链的机器上执行**：

```
cd src-tauri
cargo check
cargo test            # 含既有 engine.rs 单测 + webdav_e2e.rs（默认 max_file_size=100MB，size:1 测试项不受过滤影响）
```

---

## 五、改动归属（务必区分，未做任何提交）

- **本会话新增（未跟踪）**：`src/image-worker-protocol.ts`、`src/__tests__/image-worker.test.ts`、以及本两份报告 md。
- **本会话编辑（对应上表）**：`App.svelte`、`FileTree.svelte`、`editor.ts`、`image-worker-client.ts`、`workers/image-worker.ts`、`style.css`、`tabs.ts`、`__tests__/tabs.test.ts`、`__tests__/editor-format.test.ts`；`src-tauri/src/lib.rs`、`sync/engine.rs`、`sync/mod.rs`。
- **本会话未触碰、但在你会话前就存在的未提交改动**（请勿误认为本次所为）：`main.ts`（Svelte4→5 `mount()`）、`preview/block-splitter.ts`（import 加 `.ts` 扩展）、`FolderSearch.svelte`/`SettingsModal.svelte`/`StatusBar.svelte`、`vite-env.d.ts`、`__tests__/setup.ts`、`__tests__/filetree-component.test.ts`、`vitest.config.ts`、`package.json`/`package-lock.json`，以及多份历史 .md 文档的删除。

> 建议：提交前用 `git add -p` 或按上面清单分批暂存，把「审计修复」与「既有的 Svelte 5 迁移/文档清理」分开成不同 commit，便于回溯。我没有替你执行任何 `git add`/`commit`。
