# LiteMD 全功能点测试执行报告（覆盖 231 项）

> 依据：`LiteMD-功能点清单.md`（231 功能点）+ `LiteMD-测试用例矩阵.md`（~320 用例行，A 单测/E2E/人工）。
> 本轮目标：**对全部功能点逐条判定"是否可用"**，不可用者详细记录并给出修复方案。
> 所有结果均为本机真实执行 / 真实读码所得，无虚构。执行时间 2026-09-13 ~ 2026-09-14（Asia/Shanghai）。

## 0. 先回答"每个功能点是否都测过、都可用了？"

- **逐条判定：已完成**——231 个功能点全部经源码级审计（6 路并行）+ 可自动化项的真实测试运行，逐条给出"可用 / 存疑 / 不可用"结论（见 §3、§4）。
- **但"可用"的证据强度分三档**，必须如实区分，不能一律说"测过没问题"：
  - `运行时验证`：有真实测试跑绿背书（前端 vitest **190** + Rust **41** 单测 + **5** 条真实 HTTP E2E）。
  - `可用-静态`：代码齐全、命令已注册、调用点可达，且**全量编译通过**（vite build ✓ / cargo build ✓），但无自动化用例——主要覆盖 GUI 交互项（约 141 条 M 类），**未经实机点击验证**。
  - `待人工实测`：需要真机/干净虚拟机/双设备/中文 IME/系统回收站组策略等环境，本次无法自动执行。
- **结论**：绝大多数功能点可用；本轮**发现 3 个崩溃/致命级 + 若干功能性缺陷**（详见 §4 缺陷登记），其中 **FMT-011「转正文」与 FMT-012「取消引用」的崩溃由我新增的单测运行时确认**；另有 6 项为"明确未实现"负向项（非缺陷）；同步引擎的多个安全分支仍是"代码在但无测"的回归盲区（§5）。

## 1. 编译与回归基线（真实运行）

| 套件 | 命令 | 结果 | 变化 |
|---|---|---|---|
| 前端单测 | `npx vitest run` | **19 文件 / 190 通过** | 基线 161 → **+29**（新增 `editor-format.test.ts`） |
| Rust 单测 | `cargo test --lib` | **41 通过 / 0 失败** | 基线 38 → **+3**（新增 `guard_deletable` 三例） |
| Rust E2E（本地 WebDAV） | `LITEMD_WEBDAV_TEST=… cargo test --test webdav_e2e` | **5 通过 / 0 失败**（真实 HTTP PUT/PROPFIND/DELETE 往返，服务器根目录实测到落盘对象） | 见旧版 E2E 报告 |
| 离线全量 | `cargo test`（不设变量） | 41 + 5（E2E 自动 skip 返回 ok） | — |
| 前端构建 | `npx vite build` | ✓（全部 Svelte/TS 编译通过 = GUI 层代码存在且可编译） | — |
| 后端构建 | `cargo build` | ✓（48 个 IPC 命令注册编译通过） | — |
| 类型检查 | `npx tsc --noEmit` | **7 错误**，与既有基线完全一致；**本轮新增测试未引入任何新错误** | 7 项均为存量：6× `FlattenInput` 测试夹具缺字段 + 1× `editor.ts:970`（见 D-DOC-1） |

> 说明：`tsc` 的 7 个错误全在测试文件与一处可空传参，`vite build`/`esbuild` 不做类型检查故生产构建照常通过；属测试卫生问题，列为 D-DOC-1。

## 2. 本轮新增的自动化测试（真实跑绿）

1. **`src/__tests__/editor-format.test.ts`（29 例，全绿）**——矩阵 FMT-001~015 + TBL-001~004 的 toggle/边界/短路/非表格让位矩阵，用真实 CodeMirror `EditorView` 固化。**顺带运行时发现 2 个崩溃缺陷**（D-1、D-2，见 §4）。
2. **`src-tauri/src/lib.rs` `guard_deletable`（3 例，全绿）**——P0 删除安全守卫此前**零测试**：现覆盖"不存在/规范化失败路径必拒（ISSUE-002 宁误拒不误删）""真实临时文件放行""盘符根 `C:\` 拒删"。把 TR-020/022 从"静态"升级为"运行时验证"。

## 3. 功能点覆盖矩阵（分模块判定汇总）

审计口径：`可用-运行` / `可用-静态` / `存疑` / `不可用`。计数含负向"不支持"项。

| 模块 | 点数 | 可用-运行 | 可用-静态 | 存疑 | 不可用/缺失 | 关键结论 |
|---|---|---|---|---|---|---|
| ED 编辑器 | 33 | 3 | 28 | 1 | 1 | ED-009 星号自动闭合不生效(存疑)；ED-019 IME 无专项(缺待人工) |
| FMT 格式 | 17 | 12 | 3 | 2 | 0 | **D-1/D-2 崩溃(新单测证实)**；FMT-013 混合行、FMT-007 调色板口径 |
| TBL 表格 | 5 | 5 | 0 | 0 | 0 | 插入/复制行/加列/对齐均运行验证通过 |
| KL 快捷键 | 13 | 0 | 13 | 0 | 0 | 31 动作/归一/热生效/冲突检测接线完整，需人工点验 |
| FO 文件操作 | 25 | 1 | 24 | 0 | 0 | 三重禁写守卫/脏判定/退出拦截/会话恢复代码逐一在位(静态) |
| TR 文件树 | 44 | 15 | 29 | 0 | 0 | 删除安全链已补测(运行)；监视/排序/过滤/懒加载有存量测试 |
| MG 多标签 | 10 | 1 | 7 | 1 | 1 | **D-7 关闭其他/全部漏确认**；MG-011 拖拽排序未实现(已知) |
| AT 附件 | 13 | 6 | 7 | 0 | 0 | 改名联动/孤儿清理/双模式有测试；删除侧逃逸守卫无测(§5) |
| PV 预览 | 35 | 3 | 28 | 1 | 3 | XSS 净化运行验证(17例)；block-splitter/windowing 核心零测(§5) |
| WZ 预览编辑 | 12 | 3 | 9 | 0 | 0 | diffRange/sanitize 有测；回写/智能 Enter 靠静态 |
| SR 查找替换 | 30 | 0 | 28 | 1 | 1 | **D-4 非法正则→全屏错误页**；核心函数私有难测；SR-012 全词不支持 |
| VS 视图 | 5 | 0 | 5 | 0 | 0 | 三栏/分隔条/F11 接线完整，需人工 |
| TH 主题 | 7 | 0 | 7 | 0 | 0 | 主题/字号/低端降级接线完整，需人工 |
| UI 窗口 | 10 | 0 | 9 | 0 | 1 | UI-010 窗口尺寸记忆无(已知)；错误页/模态接线在 |
| ST 设置 | 39 | 12 | 27 | 0 | 0 | sanitize/持久化/字段夹取有测(scheduler/dto/settings)；**D-10 autoSaveDelay 无上限** |
| SY 同步 | 44 | 30 | 12 | 1 | 1 | 引擎/调度/配置密集成测；SY-080 Range 未实现(已知)；部分 runtime 分支无测(§5) |
| RB 健壮性 | 19 | 3 | 16 | 0 | 0 | validate_path(3测)/原子写有背书；流式载入零测(§5) |
| PL 平台 | 5 | 0 | 4 | 1 | 0 | PL-003 WebView2 无显式 webviewInstallMode(存疑 Q-15) |
| **合计** | **231** | **94** | **127** | **7** | **8** | 8 项不可用中 6 项为"设计负向/未实现"、2 项待人工确认 |

> 数字为 6 路审计逐条归类汇总，`可用-静态` ≠ 已实机跑过，仅表示代码在+接线可达+编译通过。

## 4. 缺陷登记（不可用/异常详录 + 修复方案）

### 崩溃 / 致命级（优先修）

**D-1 · FMT-011「转正文」对光标在标题正文内时抛错且操作无效**（严重：高，已运行证实）
- 现象：`toParagraph`（editor.ts:711）用 `changeByRange` 返回**未映射的原坐标** selection。剥去 `#### `（5 字符）后新文档仅 2 长，而光标常停在正文（index≥5）→ CodeMirror 判越界抛 `RangeError: Selection points outside of document`，整笔事务被拒、文档不变。即"转正文"在最常见的光标位置下不可用。
- 复现（已在 `editor-format.test.ts` 固化）：doc=`"#### 段落"`，光标置 index 5，调用 `toParagraph` → 抛错，doc 仍 `"#### 段落"`。
- 影响面：命令 `quickParagraph`（App:985）与行内快捷菜单「¶」项。
- 修复方案：`changeByRange` 回调内返回**新坐标** range（如 `EditorSelection.cursor(line.from + stripped.length)` 并按删除映射裁剪），或改为直接 `view.dispatch` 像 `setHeading` 那样显式算 anchor；补一条光标在正文内的单测。

**D-2 · FMT-012/013「取消引用/取消列表」多行选区抛错**（严重：高，已运行证实）
- 现象：`toggleLinePrefix`（editor.ts:634）的 `delta` 只按**单行前缀长度**算，但多行整体剥离的总收缩 = `prefixLen × 行数`。多行移除时返回 `range.to = 旧to - prefixLen` 超过新文档末尾 → `RangeError`，操作失败。单行移除正常。
- 复现：doc=`"> a\n> b\n> c"`，全选后 `toggleLinePrefix("> ")` → 抛错，doc 不变（已固化为测试）。
- 修复方案：按 `changeByRange` 的映射语义，移除时用 `state.changes(...).mapPos` 把旧 selection 映射到新坐标，而非手工 `±prefix.length`。加多行移除单测。

**D-4 · SR-004 查找面板输入半截正则触发全屏错误页**（严重：高，静态确证调用链）
- 现象：`search-panel.ts:349-358` 的 try/catch 包的是 `SearchQuery` 构造器，但 CM6 `SearchQuery` 对非法正则**不抛错**（只置 `valid=false`）。真正的 `new RegExp` 抛错发生在 `updateCount:423` / `matchesOf:97` 的 `getCursor`，异常从 `setTimeout` 回调冒泡 → 命中 App 全局 `error` 钩子（App:1254）设置 `fatalError` → **用户输入 `(` 之类未完成正则即弹全屏致命错误页**。"正则表达式无效"的友好提示分支不可达。
- 修复方案：构造 `SearchQuery` 后判 `q.valid`，false 时显示提示并 `dispatch` 空查询；`updateCount`/`matchesOf` 外再包 try/catch；将致命错误页仅用于真·未预期异常。

### 功能性缺陷（中）

**D-7 · MG-006「关闭其他/全部」多脏标签只弹最后一个确认框**（严重：中，静态推演）
- `closeTabDialog` 为单槽（App:687,703），循环批量关闭时后设者覆盖前者：多脏标签只提示最后一个，其余脏标签既不关也不再询问 → "逐个确认"未串行。
- 修复：把 `closeTabDialog` 改为**路径队列**，`onCloseTab*` 处理完一个后 shift 下一个继续弹。

**D-5 · SR-005 匹配计数无 1000 上限，大文档每次防抖无界全文同步扫描**（严重：中低）
- 1000 上限只约束导航/替换列表；`updateCount`（search-panel.ts:422）计数循环无上限 → 高频短词 + 超大文档时输入卡顿。修复：`matchesOf(view, q, 1000)`，超限显示「≥1000」。

**D-10 · FO-004 `autoSaveDelay` 仅夹下限无上限**（严重：低）
- `settings.ts:536-539` 只保证 ≥300，无 ≤3000；UI 滑杆有界但手改 `settings.json` 可注入超大延迟使自动保存近乎失效。修复：`Math.min(3000, …)`。

### 文案 / 一致性缺陷（低）

- **D-3 / FMT-013-D**：`toggleLinePrefix` 为 all-or-nothing（非所有行有前缀就给所有行加），矩阵称"混合行按各自状态处理"不符 → 混合选区 `- x` 变 `- - x`。要么改文档，要么实现逐行判定。
- **D-8 / ED-009**：CM6 `closeBrackets` 默认集不含 `*`/反引号，"星号自动闭合"实际不生效；清单措辞需收窄或补语言 `closeBrackets` 数据。
- **D-9 / FMT-007**：调色板实际 10 色（App:958-961），非清单"12 色"。
- **D-6 / SR-028**：跨文件替换回滚路径（lib.rs:1140）遗留 `.bak` 不清理；注释写 "rename" 实为 `fs::copy`。
- **D-11 / PL-003（Q-15）**：`tauri.conf.json` 无 `webviewInstallMode` 键，离线装机依赖 Tauri 默认 bootstrapper（联网）→ 建议显式 `"offlineInstaller"` 或实测离线降级。

### 文档 / 测试卫生缺陷

- **D-DOC-1**：`tsc` 7 错误 = 3 个测试文件夹具缺 `FlattenInput` 新字段（TR-005 引入的 `hideAttachments/attachmentMode/attachmentTemplate`）+ `editor.ts:970` 可空传参。生产构建不受影响。修复：补测试夹具字段、`?? undefined`。
- **D-DOC-2**：`功能点清单.md` 大量行号/路径在第一、二批修复后漂移（如 FO-013 `commands/file-commands.ts` 已删→迁 `filetree/types.ts`；多处 ±10~120 漂移），建议刷新引用便于抽查。
- **D-DOC-3**：`windowing.ts:110` 注释称 block-splitter/windowing"已单测对拍"，实际**零测试**（PV-020/022）——虚假声明。
- **D-DOC-4**：`checkPathExists` 未声明进 `TreeHandlers` 接口（运行时经 `?.` 可用，但 svelte-check 会报、且漏接线的宿主会静默跳过覆盖确认）。
- **D-DOC-5**：PV-005"LRU 60"实为超限整体 `clear()`（非驱逐）；RB-018 对替换的"tmp+rename"口径实为 `.bak` 语义。

## 5. "代码在但无回归测试"盲区（P0/P1，建议补测，非当前失败）

按数据安全/性能优先级排序（多为需真实文件/E2E/导出断言）：

1. **SY 引擎 runtime 安全分支**：SY-065 newerWins 败方入回收站再覆盖、SY-066 脏标签下载降级、SY-046 取消后断点续传、SY-061 每 20 项 flush 节奏、SY-045 Rust `SYNC_RUNNING` 互斥 + busy 回退 `lastRunAt`——均"计划期有测、执行期无测"。SY-067/069（冒烟点名）在 Rust 有内存单测，但**无真实 HTTP E2E**。
2. **RB-001/002 大文件流式载入 + `utf8_boundary`/尾部 lossy 兜底**：零单测（仅 `scripts/test-stream.mjs` 手动）。`utf8_boundary` 极易补 Rust 单测。
3. **PV-020/021/022/024 block-splitter / windowing 增量与 Fenwick 核心**：775 行增量算法零测，`splitIntoBlocks/renderBlock/estimateBlockHeight/hashRange` 已导出且无 DOM 依赖，是最易补测的一档。
4. **AT-011 删除侧 `../` 逃逸守卫**：仅"预览侧不删"有测，删除侧越界项跳过无测。
5. **SR 面板 SR-005~010 行为**：核心 `matchesOf/replace*/unquoteText/selectMatch` 全模块私有未导出 → 无法单测；建议导出纯函数（注入 `EditorState`）后补测。
6. **E2E 冒烟脚本化**：现仅 5 条；SY-067/069/072/077/079（只读/断连/并发/海量列举/自签 TLS）需给 `webdav-test-server.mjs` 加可控开关后纳入。

## 6. 明确未实现 / 设计负向项（不计缺陷，测试应排除或转需求）

PV-009 Mermaid、PV-010 LaTeX、PV-011 脚注、PV-012 TOC、MG-011 标签拖拽排序、SY-080 Range 断点续传/并行列举、SR-012 全词匹配、UI-010 窗口尺寸记忆。以及存疑清单中开放项 Q-01~Q-11、Q-19(H6)、Q-15、Q-24。

## 7. 待人工实测清单（M 类，约 141 点，静态"可用-静态"但无实机背书）

集中于：ED（多光标/IME/软换行观感/语法着色）、KL（31 键位逐条触发/捕获重绑/热生效）、FO（对话框/自动保存体感/退出弹窗/最近列表）、TR（拖拽/虚拟滚动/面包屑/资源管理器定位）、PV/WZ（分屏/滚动同步/所见即所得编辑手感）、SR（面板交互/跨文件替换确认）、VS/TH/UI（主题/字号/窗口缩放/状态栏）、ST/PL（设置页控件遍历/装包）。
建议：这些点交付一份"可执行手工点验清单"（前置·操作·预期·勾选），由用户在桌面 App 内实机跑；本轮不谎称已实机验证。其中 IME(D-待人工)、WebView2 离线装(D-11)、真机 WebDAV 双设备冲突需真实环境。

## 8. 结论与后续

- **覆盖率**：231 功能点 100% 逐条判定；运行时验证 94 点（含本轮新增 32 例真实测试），静态可用 127 点（全量编译通过背书），存疑 7、不可用/未实现 8（多为设计负向）。
- **必须修**：D-1、D-2（转正文/取消引用崩溃，已可复现）+ D-4（非法正则致命错误页）——建议进下一修复批次，可按 §4 方案提交并补回归单测。
- **建议补测**：§5 六组盲区，优先 SY runtime 安全分支与 RB 流式载入（数据安全相关）。

## 9. 修复执行记录（第三批：全部处理，2026-09-14）

按 §4 三批方案逐项修复，每项经真实编译/单测/回归验证。最终门禁全绿：**vitest 21 文件 / 206 用例、cargo 44 单测 + 5 E2E、vite build ✓、cargo build（既有）、tsc 0 错误（较基线 7→0）**。

### 已改代码

| 编号 | 处置 | 改动 | 验证 |
|---|---|---|---|
| D-1 | 已修 | `editor.ts toParagraph` 改为汇总各行 ChangeSet、`view.dispatch({changes})` 交 CM 自动映射选区，消除越界抛错 | editor-format.test.ts 转绿（光标在正文内 → "段落"） |
| D-2 | 已修 | `editor.ts toggleLinePrefix` 逐行判定 + ChangeSet，移除手工 `±delta` 与二次空 dispatch | 多行移除前缀不再抛错、结果 `a\nb\nc` |
| D-3 | 已修（行为修正） | 同上实现改为逐行 toggle，符合矩阵 FMT-013「混合行按各自状态处理」 | 混合 `普通/- 列表` → `- 普通/列表` |
| D-4 | 已修 | `search-panel.ts doSearch` 判 `q.valid`（CM6 对非法正则不抛错），下发空查询 + 提示；`updateCount` 加 `!q.valid` 早退与 try/catch 双保险 | 非法正则不再冒泡到全局致命错误页 |
| D-5 | 已修 | `search-panel.ts updateCount` 计数上限 1000，超限显示「共 1000+ 处」，杜绝无界全文同步扫描 | 逻辑审阅 + 面板回归 |
| D-7 | 已修 | `App.svelte` 关闭标签 `closeTabDialog` 单槽 → 脏标签队列 `closeTabQueue` + `pumpCloseTabDialog`，逐个确认；取消即中止整批 | 静态审阅（GUI 项，建议实机批量关闭复验） |
| D-9 | 已修 | `App.svelte PALETTE` 补 2 色至 12（与 FMT-007 文档一致） | vite build ✓ |
| D-10 | 已修 | `settings.ts` `autoSaveDelay` 补 `Math.min(3000, …)` 上限夹取 | settings sanitize 回归 |
| D-6 | 已修 | `lib.rs replace_in_folder_sync` 写失败回滚后一并 `remove_file(bak)`，杜绝 `.bak` 残留；注释 rename→copy 订正 | cargo test 44 绿 |

### 已补测试（把 §5 盲区转为运行时验证）

- `src/__tests__/editor-format.test.ts` 崩溃项由 `toThrow` 记录翻为正向断言（+29→计 29 例，全绿）。
- `src/__tests__/block-splitter.test.ts`（10 例）+ `src/__tests__/windowing.test.ts`（6 例，含 **100 组随机 vs 朴素 O(n) 逐字节对拍**，坐实 `windowing.ts:110` 此前虚假的"已单测"声明=D-DOC-3）。
- `lib.rs` 新增 `utf8_boundary`（2 例，含"任意截断点必产出合法 UTF-8 前缀"不变式）+ `cleanup_orphans_with` 删除侧 `../`/越界名逃逸守卫（1 例）+ `guard_deletable`（上批 3 例）。Rust 单测 38→**44**。

### 文档订正

- `功能点清单.md`：FO-013 路径 `commands/file-commands.ts`→`filetree/types.ts`；ED-009 收窄为"星号/反引号不自动闭合"；PV-005 "LRU"→"60 条容量·超限整体清空"；RB-018 补注替换为 `.bak` 语义；RB-019 测试计数刷新为 vitest 206 / Rust 44。
- `tsc` 基线 7 错清零（D-DOC-1：3 个测试夹具补 `FlattenInput` 新字段 + `editor.ts` 选区可空参 `?? undefined`）。
- D-DOC-4：`checkPathExists?` 补进 `TreeHandlers` 接口。

### 记录为"设计取舍"未改码（附理由）

- **D-8 ED-009 星号自动闭合**：未强行给 markdown 语言注入 `*`/`` ` `` 的 closeBrackets——会与列表/斜体输入相互干扰、影响正文打字体验；改为文档如实标注，是否补属产品决策。
- **D-11 / Q-15 WebView2 离线装**：未加 `webviewInstallMode:offlineInstaller`——那会把整份运行时打进安装包、直接违背 v1.1.0「去内置、回归轻量体积」的刻意决策（见 git log）。保持默认 bootstrapper，标为需离线真机实测项。
- **PV-005/RB-018**：实现行为本身可接受（缓存整体清空 / `.bak` 等价原子），仅措辞与实现对齐，未动逻辑。

### 仍未覆盖（透明披露）

- D-7 属 GUI 交互路径，已逻辑修复但**未实机点击验证**（关闭其他/全部多脏标签的队列逐个弹确认需实机复验）。
- §5 其余 E2E 盲区（SY-065/066/046 runtime、SY-072/077/079、并发/海量列举）未在本批补脚本，需给测试服务器加可控开关后另做。

## 10. 修复执行记录（第四批：search-panel 补测，2026-09-14）

承接 D-4/D-5：把 `search-panel.ts` 核心逻辑（`unquoteText`/`matchesOf`/`selectMatch`/`selectAllMatches`/`replaceCurrent`/`replaceAllMatches`）由模块私有改为**导出**，抽出 `buildQuery` 作为 D-4「非法正则不抛异常、仅 `valid=false`」契约的单一入口，`doSearch` 改用它。

- 新增 `src/__tests__/search-panel.test.ts`（**12 例全绿**）：SR-003 大小写、SR-004 合法/非法正则 + `valid` 契约（`"("`/`"[a-"`→valid=false，字面量模式 `"("`→valid=true）、SR-005 limit 上限、SR-006 上/下回绕与跳过当前、SR-008 全部选择、SR-009 替换当前/全部替换/readOnly 拒绝、SR-010 `\n\t\\` 转义。
- D-4/D-5 由此从「审阅+编译背书」升级为**运行时验证**（§9「仍未覆盖」相应更正；D-7 仍待实机）。
- 测试视图需显式开 `allowMultipleSelections`（裸 `EditorState` 默认关，真实编辑器经 ED-003 开）——非产品缺陷，仅夹具配置。

**门禁复跑**：vitest 218 用例 / 22 文件全绿、`tsc` 0 错误、`vite build` ✓；Rust 未改动，仍 44 单测 + 5 E2E 绿。

- **人工兜底**：§7 清单交实机点验，避免 GUI 项"以为测了其实没测"。

> 可继续推进：①按 §4 修复 D-1/D-2/D-4 并让新增单测由"记录失败"转为"验证通过"；②把 §5 的 SY-067/069、RB utf8_boundary、block-splitter 补成真实测试；③生成 §7 的人工点验清单文档。

## 11. 修复执行记录（第五批：SY 引擎真实 HTTP E2E 补测，2026-09-14）

收 §5 剩下的同步引擎盲区：SY-067（远端被清空 → 故障保护跳过本地删除）与 SY-069（列举/网络失败 → 整轮中止）此前**仅有 engine.rs 内存 mock 单测**，本轮补为真实 HTTP E2E（`webdav_e2e.rs`，5→**7** 条）：

- `e2e_fail_safe_remote_wiped`：首轮上传 2 文件建基线 → 逐个 `DELETE` 清空远端（真实服务器）→ 再同步断言 `deleted_local==0`、`protected_deletes==2`、`errors` 含「远端为空」提示，且本地 `a.md/b.md` 内容原样保留。
- `e2e_listing_network_abort`：WebDAV 指向必然拒连的死端口 → `list_all` 失败 → 断言 `run_folder_sync` 返回 `Err`（整轮中止）且本地文件零改动。

**门禁复跑**：`LITEMD_WEBDAV_TEST` 起本地服务器实跑，`cargo test` = **44 单测 + 7 E2E = 51 全绿**；`e2e_listing_network_abort` 仍受环境变量门控，离线 CI 自动 skip。收尾已终止服务器进程、删除临时 WebDAV 根、`git status` 无测试残留。本轮**只增测试、未改产品代码**。

### §5 盲区收口状态（更新）

- 已补真实测试：AT-011 删除侧逃逸（Rust）、RB utf8_boundary（Rust）、PV-020/022 block-splitter/windowing（vitest 含 100 组对拍）、SR-003~010（vitest）、SY-067/069（E2E）。
- 仍开放（需给测试服务器加可控开关/双端环境，性价比低或依赖真机）：SY-065/066 runtime 执行分支、SY-046 取消续传、SY-072 并发吞吐、SY-077 海量列举上限、SY-079 自签 TLS；以及全部 M 类 GUI 实机项。

## 12. 修复执行记录（第六批：SY 引擎取消续传 / newerWins 真实 E2E，2026-09-14）

再收 §5 两项执行分支（`webdav_e2e.rs`，7→**9** 条），无需改测试服务器：

- `e2e_cancel_and_resume`（SY-046）：本地 40 文件首轮同步，用 `emit` 回调在第 10 个完成后置 `cancel` → 断言 `cancelled==true`、`1 ≤ uploaded < 40`（部分完成）、远端恰等于已传数、`errors` 含「续传」提示；再以首轮返回快照续传 → `uploaded==40-u1`（只补剩余、不重复）、远端满 40；第三轮幂等零动作。
- `e2e_newer_wins_overwrite`（SY-065）：首轮建基线 → 远端 `upload` 改 + 本地改内容并把 mtime 压到 2000 年制造「远端更新」→ `NewerWins` 同步断言 `conflicts` 为空（**newerWins 在 plan 期定胜负**，engine.rs:239-242，产纯 `Download` 不留冲突项/副本）、`downloaded==1`、本地被覆盖为远端内容、远端仅 1 对象；后续常规同步幂等。

调试留痕：`e2e_newer_wins_overwrite` 首版误断「应记为冲突」失败——查证后确认这是**测试预期写错**而非产品 bug（newerWins 语义即 plan 期解决、不产冲突项），已改正并通过。

**门禁复跑**：起本地服务器实跑 `cargo test` = **44 单测 + 9 E2E = 53 全绿**；两新例仍受 `LITEMD_WEBDAV_TEST` 门控、离线自动 skip。收尾终止服务器进程、删临时根、工作树无残留。本轮**只增测试、未改产品代码**。

### §5 盲区收口状态（最终）

- 已补真实测试：AT-011 删除侧逃逸、RB utf8_boundary、PV-020/022 block-splitter/windowing（含 100 组对拍）、SR-003~010、SY-067/069（E2E）、SY-046/065（E2E）。
- 仍开放（性价比低/依赖真机或专用脚手架）：SY-066 脏标签下载降级、SY-072 并发吞吐、SY-077 海量列举上限、SY-079 自签 TLS（需 HTTPS 测试服务）；全部 M 类 GUI 实机项。

## 13. 修复完成性验证 + D-6/D-10 补测（2026-09-14）

对 §4/§9 全部修复项做了统一验证：跑全量门禁 + 逐条源码取证。为消除"源码确认而非运行时"两档，补测：

- **D-10**（autoSaveDelay 上限）：`sync-settings.test.ts` 新增边界例（999999/1e12→3000、300 下界保留、1500 区间内、200 非数→默认）。运行时验证 ✅。
- **D-6**（替换不留 .bak）：`lib.rs` 新增 `replace_in_folder_sync_success_leaves_no_bak`——跨文件替换 happy path 断言 `files_changed==2 / count==3`、内容正确、目录内**无 `.bak` 残留**。运行时验证 ✅。失败回滚分支因需 Windows 只读文件制造写失败（易碎脚手架），维持源码确认 + 人工清单 C8 复验。

**统一验证结果（本轮真实运行）**：vitest **219 / 22 文件**、cargo **45 单测 + 9 E2E = 54**、`tsc` **0**、`vite build` ✓。逐条 grep 取证：D-1/2/3/4/5/6/7/9/10 + D-DOC-1/3/4 源码均在位；D-7（批量关闭队列）为 GUI 路径，源码+编译确认、仍需实机 C6 复验。

### 最终每档修复的验证强度（D-7 升级后）

| 档 | 项 | 状态 |
|---|---|---|
| 运行时绿测背书 | D-1 D-2 D-3 D-4 D-5 D-6(成功路径) **D-7(队列状态机)** D-9 D-10 D-DOC-1 D-DOC-3 + SY-046/065/067/069 + AT-011 + RB-utf8 | ✅ 已验证 |
| 源码+编译确认（受工具链/环境限制无法零依赖自动化） | D-6 写失败回滚分支（`set_readonly` 是 unstable `windows_permissions_ext`，稳定版无法强制写失败→人工 C8）、D-DOC-4 接口声明 | ◼ 源码到位，建议实机复验 |
| 设计取舍（未改码，理由记录） | D-8 星号自动闭合、D-11 WebView2 离线装、PV-005/RB-018 措辞已订正 | ⊘ 有意保留 |

### D-7 重构（把「源码确认」升级为「运行时」）

- 抽出纯状态机 `src/tab-close-queue.ts`（`enqueue`/`advance`/`requestClose`/`resolveCurrent`/`abortAll`），App.svelte 的 `closeQ` 委托它、`closeTabDialog` 由 `current` 派生供模板渲染，副作用（`doCloseTab`/`save`/`activateTab`）留在组件。
- 新增 `src/__tests__/tab-close-queue.test.ts`（6 例）：逐个弹出、批量三脏标签不互相覆盖、依次 resolve 到 null、取消清空整批、去重、advance 幂等。运行时验证 ✅。
- 过程中触发 Svelte `requestClose` 与既有窗口关闭函数同名冲突（build 报 ParseError）→ 导入处 `as queueRequestClose` 别名化解决；`vite build` 复绿。

**复跑**：vitest **225 / 23 文件**、cargo **45 单测 + 9 E2E**、`tsc` **0**、`vite build` ✓。D-6 回滚分支测试因 `PermissionsExt::set_readonly` 在稳定工具链仍是 unstable（`windows_permissions_ext`）而撤回，未强塞 flaky 测试——维持源码确认 + 人工 C8。

**结论**：§4 登记的全部缺陷均已闭环——或运行时绿测证明、或源码修复+全量回归未破并经人工清单指定实机复验项覆盖；无"改了但没验证"或"声称修了实则未修"的项。改动仍在工作树、未提交。

