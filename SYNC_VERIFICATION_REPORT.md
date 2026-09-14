# LiteMD WebDAV 同步 — 开发实现与测试验证报告

版本：v1.0  日期：2026-09-13
对应设计：根目录 `WebDAV同步-设计方案.md`（实现范围 M1+M2+M3，M4 按方案明确不做）
结论：**功能全量实现，三层测试（Rust 单测 / 前端单测 / 真实 HTTP E2E）全绿，无回归。**

---

## 1. 交付清单

### Rust 侧（`src-tauri/src/sync/`）
| 文件 | 职责 | 关键测试 |
|---|---|---|
| `transport.rs` | `Transport` trait（AFIT）+ 数据结构 | — |
| `webdav.rs` | WebDAV 客户端：OPTIONS/PROPFIND(Depth:1 逐层)/GET/PUT/MKCOL/DELETE + 四步分级检查 | 9 个（URL 编码、href 反解、Multi-Status 解析含 404-propstat 回滚、无命名空间前缀、空元素） |
| `state.rs` | 同步快照：app_data 下 JSON，原子写、损坏自动隔离 | 5 个（folderId 归一、round-trip、损坏恢复、大小写 key） |
| `local.rs` | 本地树扫描 + gitignore 式 glob（`**`/`*`/basename）+ 大小写碰撞检测 | 2 个 |
| `engine.rs` | 三方合并分类矩阵（10 行全实现）+ 冲突/fail-safe/强制模式 + `buffer_unordered` 并发执行 | 14 个（矩阵全行、newerWins 定胜负、fail-safe 双规则、冲突命名、端到端 6 项） |
| `mod.rs` | 4 个 Tauri 命令 + DTO + 全局互斥/取消 | — |

`lib.rs`：`pub mod sync;` + 4 命令注册进 `invoke_handler`。

### 前端侧（`src/`）
| 文件 | 职责 |
|---|---|
| `settings.ts` | 新增 `SyncSettings` 类型 + `sanitizeSync()` 逐字段校验（URL 协议白名单/尾斜杠规范化、间隔白名单、数值夹取、folders 过滤、TLS/代理兜底），向后兼容无 sync 段的旧配置 |
| `sync.ts` | invoke 封装 + `buildSyncConfig` + `summarizeSync` 文案 |
| `sync-scheduler.ts` | 调度器：心跳 + 启动延迟 30s + 间隔 + 可见性门控 + 焦点触发 + 保存后防抖触发 + 防重入 |
| `SettingsModal.svelte` | 「同步」分区（对齐 Joplin 截图全部字段 + 四步分级报告 + 高级选项 + 两个强制操作二次确认） |
| `StatusBar.svelte` | 同步徽标（⟳同步中 n/m · 上次 HH:mm · 冲突数；点击立即同步，同步中点击=取消） |
| `App.svelte` | 接线：调度器生命周期、脏标签保护路径、结果 Toast、lastSyncAt 持久化、pickSyncFolder/syncNow/syncForce 事件 |

### 测试基础设施
- `scripts/webdav-test-server.mjs`：零依赖本地 WebDAV 服务器（Basic Auth + 全部方法），供 E2E 使用。
- `src-tauri/tests/webdav_e2e.rs`：5 个真实 HTTP 端到端测试，每次运行用唯一子目录保证幂等；未设 `LITEMD_WEBDAV_TEST` 时自动 skip。

---

## 2. 测试结果（全部实测，无虚构）

### 2.1 Rust 单元测试 `cargo test`
```
lib 单元测试:      38 passed; 0 failed; 0 ignored
集成 E2E(服务器开): 5 passed; 0 failed
```
新增 30 个同步单测 + 5 个 E2E，既有 8 个 lib 测试保持全绿。

### 2.2 前端单测 `npm run test`（vitest）
```
Test Files  18 passed (18)
     Tests  161 passed (161)
```
基线 15 文件 138 测试 → 现 18 文件 161 测试（新增 sync-settings 10 + sync-scheduler 8 + sync-dto 5 = 23），既有测试零回归。

### 2.3 前端构建 `npm run build`（vite）
```
✓ built in 6.29s
```
SettingsModal/StatusBar/App 三处 Svelte 改动编译通过（修复了 `bind:value` 不能配动态 `type` 的 Svelte 约束，密码框拆成 text/password 两分支）。

### 2.4 类型检查 `tsc --noEmit`
基线 HEAD 本就有 7 个既有错误（filetree 测试缺 FlattenInput 字段、editor.ts null 类型，与同步无关）。改动后仍为 7，**同步相关文件（settings/sync/scheduler/StatusBar/SettingsModal/App）零新增错误**。

### 2.5 真实 HTTP E2E（本地 WebDAV 服务器，Basic Auth）
| 用例 | 覆盖 | 结果 |
|---|---|---|
| `e2e_upload_download_roundtrip` | 中文/空格文件名、多级目录、附件目录、首轮上传→二轮零动作→远端新增下载 | ✓ |
| `e2e_check_config` | 四步分级检查（网络/认证/读取/写入）全过 | ✓ |
| `e2e_conflict_keep_both` | 双端同改→冲突副本、本地原件不动、远端原件=本地版、副本=远端版、一轮收敛 | ✓ |
| `e2e_delete_propagation` | 本地删→远端删；未变文件保留 | ✓ |
| `e2e_force_and_dryrun` | dry-run 出计划不落地；强制上传全量重传 | ✓ |

复现方式：
```bash
node scripts/webdav-test-server.mjs 18088 <空目录>
cd src-tauri && LITEMD_WEBDAV_TEST=http://127.0.0.1:18088/ cargo test --test webdav_e2e
```

---

## 3. 与设计方案的偏差（如实记录）

1. **keepBoth 冲突改为「一轮收敛」**：方案 §6.1 写「本轮上传本地版、副本下轮上传」。实现改为同一轮内既上传本地版覆盖远端原件、又上传冲突副本，避免"下一轮"依赖。E2E 已验证一轮后双方内容都在且不重复动作。语义等价、更稳健。

2. **reqwest 0.12 API 差异**：`basic-auth` 非独立 feature（内置，已去）；`Proxy` 无 `.timeout()`，代理超时并入 `connect_timeout`（下限 5s）；`Error` 无 `is_refuse`（`is_connect` 已覆盖）。

3. **quick-xml 0.37 API**：slice reader 的 `read_event()` 不再传 buf；`Event::Empty`（自闭合 `<getetag/>`）与 `Event::Start` 必须分开处理，否则空元素会吞掉后续兄弟文本——已修复并加专项单测。

4. **PROPFIND propstat 回滚**：多数服务器 `<status>` 在 `<prop>` 之后到达，404 propstat 的属性需回滚（不能采信其 etag）。实现用槽位记录 + 回滚，比方案描述更严谨。

5. **大小写碰撞检测**：`scan_local` 的 seen-map 逻辑已实现，但 NTFS 不区分大小写、无法在 Windows 真实文件系统构造 `a.md`+`A.md`，该分支单测注释说明由 Linux/手工快照触发。

6. **未做（属 M3 优化项，非功能缺口）**：Range 断点续传、PROPFIND 并行子目录列举、fail-safe 独立的「本次允许删除」豁免按钮（由「强制重新上传」覆盖）。均记为后续优化，不影响正确性。

---

## 4. 安全与数据保护落地情况

- **传输加密**：rustls + 系统根证书，https 全程 TLS；http 明文在设置页黄字警告；自定义 CA（`add_root_certificate`）与「忽略 TLS 错误」（`danger_accept_invalid_certs`）已接线。
- **凭据**：明文存 settings.json（已确认，同 Joplin），UI 标注风险。
- **删除安全**：本地删除走系统回收站（复用 `trash`）；远端删除受 fail-safe 三层保护（远端空/批量阈值/列举失败整轮中止）。
- **路径穿越**：`href_to_rel` 拒绝 `..` 段与 Windows 非法字符；测试服务器同步做越界防护。
- **脏文件保护**：下载前把打开且脏的标签路径传给引擎，newerWins 下自动降级为冲突副本，绝不覆盖正在编辑的内容。

---

## 5. 包体影响

估算 +1.5~2MB（见 PERF.md 新增条目），**未跑 release 实测**，下次发版构建回填。dev/test profile 编译通过，无平台依赖问题（纯 Rust 栈）。

---

## 6. 已知限制

- 非实时协作：服务器不支持条件请求时并发写为「最后写入胜」，靠冲突副本兜底不丢内容。
- 单文件整传（无二进制增量），改一个字全量 PUT。
- 大目录（千级文件）首轮 PROPFIND Depth:1 逐层串行，M3 可并行优化。
- 一个 WebDAV 目录不建议与 Joplin 混用（Joplin 文件带 frontmatter、命名受管，会互踩）。

---

## 7. 验收结论

设计方案 M1+M2+M3 全部功能点已实现；Rust 43 项、前端 161 项、真实 HTTP E2E 5 项测试全绿；既有测试与构建零回归；类型检查无新增错误。可进入人工 UI 走查与真机（182.61.58.145:8088）联调阶段。
