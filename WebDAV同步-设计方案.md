# LiteMD WebDAV 同步功能设计方案

版本：v0.1（设计稿）
日期：2026-09-13
范围：为 LiteMD 增加 Joplin 风格的笔记同步能力，第一期仅支持 WebDAV 存储目标。

---

## 1. 背景与目标

Joplin 的同步模型：应用内维护笔记数据库，把每条笔记/资源序列化后推送到同步目标（WebDAV、坚果云、Nextcloud 等），本地与远端通过「同步状态表 + 变更队列」做双向合并，并支持定时同步、连接检查、故障保护、冲突处理等能力（见用户提供的设置界面截图）。

LiteMD 现状与之有本质差异：**LiteMD 没有笔记数据库，笔记就是磁盘上的 `.md` 文件树**（多根工作区 `settings.roots`，附件按文档隔离在 `<文档名>_attachment/` 或共享 `_attachment/`）。因此 LiteMD 的同步不做「数据库 → 受管文件」的导出，而是：

> **把用户选定的本地笔记文件夹与 WebDAV 上的目录做双向文件树同步（three-way merge），本地文件保持原样、可被任何 WebDAV 客户端直接读写。**

目标（对齐截图中的 Joplin 能力清单）：

| Joplin 能力 | LiteMD 对应设计 | 期数 |
|---|---|---|
| 同步目标 = WebDAV（URL/用户名/密码） | 设置页「同步」分区，WebDAV 账户配置 | M1 |
| 检查同步配置 | `sync_check_config` 命令，OPTIONS + PROPFIND 探活 | M1 |
| 同步间隔（5 分钟等） | 定时自动同步 + 手动「立即同步」 | M3（M1 先做手动） |
| 最大并发连接数 | 传输并发度上限（默认 5） | M3 |
| 附件下载行为 | 简化为「附件随文件树一起同步」+ 大文件跳过阈值 | M2 |
| 重新上传本地 / 删除本地重新下载 | 两个强制全量操作按钮 + 二次确认 | M3 |
| 自定义 TLS 证书 / 忽略 TLS 错误 / 代理 | 高级选项透传给 reqwest | M3 |
| 故障保护（远端为空时不删本地） | fail-safe 默认开启 | M2 |
| 冲突处理 | 可配置：双保留冲突副本（默认）/ 较新者胜 | M2 |

明确不在本期范围：端到端加密（Joplin E2EE）、除 WebDAV 外的目标（本地目录/OneDrive/S3/Joplin Server）、多设备实时协作、增量二进制 diff（整文件传输）。

---

## 2. 总体架构

```
┌─ Svelte 前端 ──────────────────────────────────────────┐
│ SettingsModal「同步」分区（配置 UI，写入 settings.json） │
│ App.svelte：调度器（间隔定时器/焦点触发/保存后触发/手动） │
│ StatusBar：同步状态（转圈/上次时间/冲突数/错误）          │
│        │ invoke(config)          ▲ Channel 进度事件      │
└────────┼─────────────────────────┼──────────────────────┘
┌────────▼─────────────────────────┴──────────────────────┐
│ Rust  src-tauri/src/sync/                                │
│  mod.rs      Tauri 命令：check_config / run / status      │
│  engine.rs   三方合并算法（纯逻辑，可单测）                │
│  state.rs    同步快照（上次同步基线）读写                   │
│  local.rs    本地树扫描（mtime/size/hash）                 │
│  webdav.rs   WebDAV 客户端（PROPFIND/GET/PUT/MKCOL/DELETE）│
│  transport.rs Trait 抽象：engine 依赖接口而非真实 HTTP      │
└────────────────────────┬─────────────────────────────────┘
                         │ HTTPS (reqwest, rustls)
                 ┌───────▼────────┐
                 │  WebDAV 服务器  │  例：http://182.61.58.145:8088/
                 └────────────────
```

要点：

- **同步引擎全部在 Rust 侧**。网络与文件 IO 都是重活，放前端会受 CSP/跨域与 webview 生命周期限制；Rust 侧已有 `spawn_blocking` + 后台线程（`notify` watcher）的成熟模式可复用。
- **engine 只依赖 `Transport` trait**（列目录/下载/上传/删除/mkdir），WebDAV 实现是其中一种。将来加 S3/本地目录目标只换实现，合并逻辑零改动；单测用内存假实现即可覆盖全部分类矩阵。
- 前端只负责：存配置、按调度发起 `sync_run`、渲染进度事件。引擎不持有 UI 状态，关闭窗口不中断同步（与 Joplin 一致），但应用退出即终止（见 §7.6 断点续传）。

---

## 3. 同步单元与配置模型

### 3.1 同步文件夹（Sync Folder）

一个 WebDAV 账户（URL+凭据）下可挂 **N 个同步文件夹**，每个条目把「本地根目录」映射到「WebDAV 基路径」：

```ts
interface SyncFolder {
  id: string;            // sha1(localRoot) 前 12 位，稳定标识
  localRoot: string;     // 绝对路径，通常是 settings.roots 之一
  basePath: string;      // WebDAV 下的目录，默认 `/<本地文件夹名>/`
  enabled: boolean;
}
```

M1 先支持单文件夹（取当前工作区根），数据结构按列表设计，UI 可后置多条目管理。

### 3.2 设置结构（settings.json 新增 `sync` 段）

```ts
interface SyncSettings {
  enabled: boolean;                 // 总开关，false 时调度器不跑
  account: {
    url: string;                    // 如 http://182.61.58.145:8088/
    username: string;
    password: string;               // 明文存 settings.json（已确认，同 Joplin 桌面版）
  };
  folders: SyncFolder[];
  intervalMin: 0 | 1 | 5 | 15 | 30 | 60;  // 0 = 仅手动
  concurrency: number;              // 最大并发传输数，默认 5，范围 1~16
  conflictPolicy: "keepBoth" | "newerWins";  // 默认 keepBoth
  failSafe: boolean;                // 默认 true：远端意外为空时禁止批量删除本地
  maxFileSizeMB: number;            // 超过阈值的文件跳过同步并提示，默认 100
  ignorePatterns: string[];         // 不同步的相对路径 glob，默认 [".git/**", "Thumbs.db", "~$*"]
  advanced: {
    ignoreTlsErrors: boolean;       // 默认 false
    customTlsCerts: string;         // 逗号分隔的证书文件/目录路径
    proxyEnabled: boolean;
    proxyUrl: string;               // 如 http://my.proxy.com:80
    proxyTimeoutSec: number;        // 默认 1（对齐 Joplin）
    syncOnWindowFocus: boolean;     // 获得焦点时补一次同步，默认 false
  };
  lastSyncAt: number | null;        // 上次成功时间戳（展示用）
}
```

- 全部字段进 `settings.ts` 的 `sanitize()`，逐字段校验兜底（沿用现有模式）；`url` 需做规范化（补尾部 `/`、协议白名单 http/https、非法即拒绝保存并提示）。
- 密码明文风险在设置页如实标注一行提示（建议配 https + 专用同步账号）。

---

## 4. 同步快照（state.rs）——三方合并的基线

LiteMD 没有数据库，「上次同步过的状态」必须自己记。快照是**同步正确性的核心**，独立于 settings.json 存放：

```
%APPDATA%\com.litemd.app\sync\<folderId>.json      （tauri app_data_dir 下）
```

```jsonc
{
  "version": 1,
  "folder": { "localRoot": "E:\\notes", "url": "http://.../notes/", "basePath": "/notes/" },
  "files": {
    // key = 相对路径，统一 '/' 分隔、按平台大小写规则归一（Windows 存小写 key + 原样 path）
    "日记/2026-09.md": {
      "hash": "sha256:ab12...",   // 上次同步时双方一致的内容哈希
      "size": 2048,
      "mtime": 1757721600,         // 上次同步时本地 mtime（快速路径用）
      "remoteEtag": "\"abc\"",     // 远端 etag（服务器支持时）
      "remoteMtime": 1757721000,   // 远端 lastmodified（无 etag 时的变更判据）
      "syncedAt": 1757721605
    },
    ...
  }
}
```

设计说明：

- **变更判定以内容哈希为准，mtime/size 只是缓存加速**：本地文件 `mtime+size` 与快照一致 → 视为未变，不重算哈希；不一致 → 算哈希与快照 `hash` 比对。这样多设备时钟偏移不会误判（Joplin 靠 updated_time 也有此坑）。
- 远端变更判定优先 `etag`，无 etag 用 `lastmodified+size`；两者都缺 → 保守视为已变（下载后按哈希去重）。
- 快照**逐文件更新、随进度落盘**（每完成一个传输就写内存表，每 20 个或每个阶段结束 flush 一次），中断后可自然续传。
- 快照损坏/丢失的后果：退化为「双方都视为新文件」，同内容自动归并，不同内容按冲突处理——不丢数据，只多几份冲突副本。文件头记录 `version` 以便将来迁移。

---

## 5. 同步算法（engine.rs）

### 5.1 单次同步流程

```
0. 全局互斥：static SYNC_RUNNING；运行中再次触发直接返回「已在同步中」
1. 本地扫描：walk(localRoot) → 应用 ignorePatterns / maxFileSize → LocalTree{relPath → size,mtime}
2. 远端列举：PROPFIND 递归（Depth:1 逐层）→ RemoteTree{relPath → size,etag,lastModified}
3. 加载快照 S，对三个集合做 join，生成动作计划 Plan（§5.2 分类表）
4. fail-safe 检查（§5.3）
5. 执行计划：先 MKCOL 建目录 → 并发传输（GET/PUT，并发度=concurrency）→ DELETE → 逐个更新快照
6. 汇总 {uploaded, downloaded, deletedLocal, deletedRemote, conflicts, skipped, errors} 发给前端
```

计划阶段与执行阶段分离：`dryRun` 参数返回完整计划不执行（UI 预览、单测、故障保护判断都靠它）。

### 5.2 分类矩阵（Local × Remote × Snapshot）

| # | 本地 | 远端 | 快照 | 判定 | 动作 |
|---|---|---|---|---|---|
| 1 | 有 | 无 | 无 | 本地新增 | 上传 |
| 2 | 无 | 有 | 无 | 远端新增 | 下载 |
| 3 | 有 | 有 | 无 | 双方各自新增同名 | 哈希相同→认领入快照；不同→冲突（§6） |
| 4 | 有 | 有 | 有 | 均未变 | 跳过 |
| 5 | 有 | 有 | 有 | 仅本地变 | 上传 |
| 6 | 有 | 有 | 有 | 仅远端变 | 下载 |
| 7 | 有 | 有 | 有 | 双方都变 | 冲突（§6） |
| 8 | 无 | 有 | 有 | 本地删除 | 远端未变→删远端；远端已变→按冲突（删改冲突：保留远端内容落盘为冲突副本，同时删除远端原件，等价「双保留」） |
| 9 | 有 | 无 | 有 | 远端删除 | 本地未变→删本地（进回收站，复用 `trash`）；本地已变→保留本地并在下轮以「本地新增」重新上传 |
| 10 | 无 | 无 | 有 | 双方删除 | 清快照条目 |

「变」的定义见 §4。「目录」不是独立对象：目录随文件隐式存在，上传前对路径前缀递归 MKCOL（部分服务器对已存在 MKCOL 返回 405，视为成功）。

### 5.3 故障保护（failSafe，默认开）

执行前检查，命中则中止本轮并提示，绝不静默批量删除：

- 快照非空，但 RemoteTree 为空 → 视为「远端被清空/配错地址」，跳过所有「删除远端」动作；若本地也为空则整轮中止。
- 单轮计划中「删除本地」条数 > `max(20, 快照总数 × 30%)` → 中止删除类动作，只跑传输，并 Toast 要求用户确认（提供「本次允许删除」的一次性豁免入口，M3 随强制操作一起做）。
- 网络错误率 > 50%（列举/探测阶段）→ 整轮中止，防止把「连不上」误判成「对方全删了」。

### 5.4 删除与不可逆性

- 本地删除一律走系统回收站（复用现有 `delete_path` 的 `trash` 逻辑），可恢复。
- **远端删除不可逆**，服务器若无版本控制就是真没了——这是整个方案最大的数据风险点，靠 §5.3 的 fail-safe + 计划预览 + 快照判据（仅「快照里有且本地确实没了」才删远端）三层兜底。文档与 UI 提示中如实写明。

---

## 6. 冲突处理（conflictPolicy 可配置）

### 6.1 keepBoth（默认，双保留）

本地版本**原路径不动**（用户正在编辑的文件绝不被覆盖），远端版本另存冲突副本：

```
原文件：  笔记.md            （本地版本保持）
副本：    笔记（冲突副本 2026-09-13 1422，远端）.md
```

- 命名：`{stem}（冲突副本 {date} {HHmm}，远端）.{ext}`，重名再递增；附件冲突同理。
- 快照处理：本轮结束后，原路径条目按**本地版本**哈希更新（下轮会把本地版上传覆盖远端）；冲突副本作为新文件上传。远端旧版内容永久保留在副本中，不丢数据。
- 冲突数计入状态栏徽标，Toast 列出冲突文件清单（点击可在文件树定位）。

### 6.2 newerWins（较新者胜）

以快照为基线，比较本地 mtime 与远端 lastModified，新者直接覆盖旧者（被覆盖的本地文件先写回收站副本再覆盖，保留最后逃生通道）。UI 标注「可能丢失编辑，慎用」。

两种策略对「删改冲突」（#8/#9）行为一致：都按双保留处理，不做静默取舍。

---

## 7. WebDAV 客户端（webdav.rs）

### 7.1 请求集

| 操作 | 方法 | 说明 |
|---|---|---|
| 连接检查（四步分级） | `OPTIONS` → `PROPFIND Depth:0` → `PUT .litemd-probe` → `DELETE .litemd-probe` | ① 网络可达 + `DAV` 响应头含 1；② 认证通过（区分 401/403 与网络错误）；③ basePath 存在且可读（不存在时报「远端路径未创建，同步时将自动建立」）；④ **写入权限探测**：向 basePath PUT 一个几字节探针文件再 DELETE——能读不能写的服务器（Nginx dav 配错、只读分享链）在检查阶段就暴露，不等同步跑一半失败。四项独立报告，探针删除失败仅提示不判失败 |
| 列举 | `PROPFIND Depth:1` 逐层递归 | 解析 XML 中 `getcontentlength / getetag / getlastmodified / resourcetype`。不用 `Depth:infinity`：大量服务器（含 IIS、部分坚果云类网关）不支持或超时 |
| 下载 | `GET` | 带 `Range` 续传能力后置 M3，M1 整文件 |
| 上传 | `PUT` | `Content-Type: application/octet-stream`；目标含新目录时先递归 MKCOL |
| 建目录 | `MKCOL` | 405/403-with-existing 视为已存在 |
| 删除 | `DELETE` | 目录删除仅在「强制重传」等整树操作出现，常规同步只删文件 |

### 7.2 兼容性与坑（写进实现 checklist）

- **URL 百分号编码**：中文/空格文件名逐段编码（保留 `/` 分隔符），这是 LiteMD 中文笔记场景的第一大坑，单测必须覆盖。
- 响应 XML 命名空间前缀不可信（`D:response` / `response` / 多服务器混合），用 `quick-xml` 按 local-name 匹配。
- `href` 回显路径可能是全 URL，需反解为相对 basePath 的相对路径再解码。
- 部分服务器无 `getetag` 或对目录返回 200 而非 207（PROPFIND 非标准）：列举阶段做响应形态探测并降级。
- Basic Auth over http 明文——设置页对 `http://` URL 显示黄色警告（Joplin 同款提示语义）。
- 超时：连接 10s，单请求 60s（可被代理超时覆盖）；429/5xx 指数退避重试 2 次，412（If-Match 失败）不重试、下轮重算。
- 条件请求：上传带 `If-Match: <快照 remoteEtag>`（服务器支持时）防覆盖竞态；不支持则接受最后写入胜（冲突副本机制兜底数据）。

### 7.3 依赖

```toml
reqwest = { version = "0.12", default-features = false, features = ["rustls-tls", "basic-auth", "stream", "socks"] }
quick-xml = "0.36"        # PROPFIND 解析
sha2 = "0.10"             # 内容哈希（纯 Rust，无平台依赖）
urlencoding = "2"
```

`rustls` 而非 native-tls：免 OpenSSL 运行时、体积可控、`danger_accept_invalid_certs` 与自定义 CA（`add_root_certificate`）都有现成 API，正好覆盖 Joplin 的「忽略 TLS 证书错误 / 自定义 TLS 证书」两项。代理用 `reqwest::Proxy::all()`。预计包体 +1.5~2MB，对 LiteMD「超轻量」定位的影响在 PERF.md 记录。

### 7.4 并发与节流

- `tokio::Semaphore(concurrency)` 限制并发 GET/PUT；列举阶段串行逐层（Depth:1 递归本身可并行子目录，M3 优化）。
- 单文件 ≤ maxFileSizeMB 才同步；跳过的文件在结果汇总里列清单（对应 Joplin「附件下载行为」的简化替代）。
- 大文件哈希在 `spawn_blocking` 里流式读（8KB buf），避免整读进内存。

### 7.5 调度（前端）

- `intervalMin > 0`：`setInterval` + 防重入（`sync_run` 返回 running 则跳过）；**复用 `useVisibilityGatedInterval` 的可见性门控思路**——窗口隐藏时暂停定时器，恢复可见时若已过期立即补一轮。
- 手动：状态栏「同步」按钮 / 设置页「立即同步」。
- 保存后触发（可选增强）：编辑器保存成功且距上轮同步 > 60s 时，`requestIdleCallback` 里延迟触发一轮，让改动尽快上云。M3 再开。
- 应用启动完成后 30s 触发首轮（避开启动热路径）。

### 7.6 生命周期

- 同步中禁止关闭应用？——不禁止。退出时给引擎发 cancel 信号（`AtomicBool`，文件间检查点生效），快照已落盘部分不丢，下次开机续传。
- 同步下载导致文件树外部变化 → 现有 `notify` watcher 会触发文件树刷新，已打开标签的「磁盘 mtime 变化提示重载」逻辑天然覆盖，无需新增。若用户正在编辑某文件时被远端更新下载覆盖（keepBoth 下即冲突副本，不覆盖原路径），newerWins 下写入前检测该文件是否为当前活动标签且脏，是则强制走冲突副本。

---

## 8. Tauri 命令接口

```rust
// 参数中的 config 均为前端传入的 SyncSettings 快照（Rust 侧不读 settings.json，保持单一数据源在前端）
#[tauri::command] async fn sync_check_config(config: SyncConfigDto) -> Result<CheckResult, String>;
// CheckResult { steps: [ { name: "network"|"auth"|"read"|"write", ok, skipped, message } ],
//              server_type, all_ok }   // 四步分级报告，与 §7.1 对应

#[tauri::command] async fn sync_run(config: SyncConfigDto, folder_id: String,
    dry_run: bool, on_event: Channel<SyncEvent>) -> Result<SyncSummary, String>;
// SyncEvent: { phase: "scan"|"plan"|"upload"|"download"|"delete", done, total, path }
// SyncSummary: { uploaded, downloaded, deleted_local, deleted_remote,
//               conflicts: Vec<String>, skipped: Vec<String>, errors: Vec<String>, plan_only: bool }

#[tauri::command] async fn sync_cancel(folder_id: String);
```

注册进 `invoke_handler!`，新建 `src-tauri/src/sync/` 模块目录。前端 `src/sync.ts` 封装 invoke 与事件（对应 `fs.ts` 的角色），调度器逻辑放 `src/sync-scheduler.ts`（纯 TS 可单测）。

---

## 9. UI 设计（SettingsModal 新增「同步」分区）

对齐 Joplin 截图的分组与文案习惯：

```
同步
├─ 启用同步 [checkbox]
├─ 同步目标   [WebDAV ▾]（第一期仅此一项，置灰预留）
├─ WebDAV URL [________________]      ← http:// 时下方黄字提示明文风险
├─ WebDAV 用户名 [________]
├─ WebDAV 密码  [________]（可见性小眼睛）
├─ 同步文件夹（本地 ↔ 远端路径映射列表，M1 单条）
│    本地文件夹 [E:\notes]   远端子路径 [/notes/]
├─ 同步间隔 [仅手动|1|5|15|30|60 分钟 ▾]
├─ [检查同步配置]  → 四步分级报告：✓ 网络可达  ✓ 认证成功  ✓ 读取正常  ✗ 写入失败（403，服务器可能只读）
│                     全过 → 「成功！同步配置看起来没问题。」失败项给具体原因与修复建议
├─ ▾ 显示高级选项
│    ├─ 冲突处理 [双保留冲突副本|较新者胜 ▾] + 说明文字
│    ├─ 最大并发连接数 [5]
│    ├─ 单文件大小上限(MB) [100]
│    ├─ 忽略文件模式 [".git/**, ~$*"]
│    ├─ 故障保护 [x] 当远端为空（疑似配置错误）时，不删除本地数据
│    ├─ 自定义 TLS 证书 [____]（逗号分隔路径）
│    ├─ 忽略 TLS 证书错误 [ ]
│    ├─ 启用代理 [ ] 代理 URL [____] 代理超时(秒) [1]
│    ├─ [重新上传本地数据到同步目标]（全量强制 PUT，二次确认）
│    └─ [删除本地数据并从同步目标导入]（先导出提醒→回收站→全量拉取，双重确认）
StatusBar
└─ ⟳ 同步中 3/17 · 上次 14:22 · 冲突 1（点击→立即同步 / 查看结果 Toast 详情）
```

两个强制操作按钮语义与 Joplin 一致：前者忽略快照把本地全量 PUT 上云（用于远端数据损坏）；后者把本地树移入回收站后从远端全量拉取（用于本地数据损坏），均要求输入确认词。

---

## 10. 加密与数据安全

分四层说明加密取舍（前三层在本期落地，第四层明确延后）：

**① 传输加密（本期，默认启用）**：WebDAV 客户端用 reqwest + rustls，`https://` 下全程 TLS 1.2/1.3，与浏览器访问加密网站同级。`http://` 明文（含 Basic Auth 口令裸奔）不禁止但设置页黄色警告，建议配 https 或反代。自定义 CA 证书（内网自签场景）与「忽略 TLS 证书错误」作为高级选项对齐 Joplin——后者是危险开关，勾选时 UI 二次确认。

**② 远端静态存储**：WebDAV 是透明文件协议，**LiteMD 上传的就是原始 .md/附件内容**，服务器上是否加密落盘完全由服务器决定（Nextcloud 可开服务端加密，IIS 可开 BitLocker）。这是本方案与 Joplin 的一个刻意差异：LiteMD 同步的文件保持人类可读、可被任何 WebDAV 客户端直接打开，代价是远端明文。若笔记涉敏，应选支持服务端加密的 WebDAV 服务，或等 ④。

**③ 凭据存储（已确认）**：WebDAV 用户名/密码明文存于 settings.json，与 Joplin 桌面版行为一致；风险边界=本机登录用户可读。升级路径预留：把 `account.password` 的读写收敛到 `credential.rs` 单点，将来切 Windows 凭据管理器/DPAPI 只改存取两点，不动同步引擎。

**④ 端到端加密（E2EE，M4 评估，本期不做）**：Joplin 的 E2EE 是「每条笔记用账号主密钥派生的密钥单独 AES-256 加密后上传」，同步目标上只见密文。LiteMD 若做，方案是信封加密（随机数据密钥加密文件内容，数据密钥用主口令派生的 KEK 包裹，manifest 记录映射）。代价如实列出：同步文件对任何第三方 WebDAV 客户端不再可读（丧失 ②的透明性卖点）、口令丢失=全库不可恢复、改一个字整文件重传（哈希变化即全量 PUT）、密钥轮换需全库重加密。因此放到 M4 单独评估，不进前三期范围。

## 11. 里程碑拆分

**M1 — 最小可用（手动同步单文件夹）**
WebDAV 客户端（OPTIONS/PROPFIND/GET/PUT/MKCOL/DELETE）、快照读写、分类矩阵 #1~#7、keepBoth 冲突、设置页基础区 + 检查配置、`sync_run` 手动触发 + 进度事件、状态栏上次同步时间。
验收：与真实服务器（如 182.61.58.145:8088）完成 中文路径/多级目录/附件文件夹 的双向首轮与增量同步。

**M2 — 安全完备（可日常开）**
删除传播（#8~#10）+ 回收站、fail-safe、newerWins 策略、冲突清单 UI、ignorePatterns、maxFileSize、dry-run 预览。

**M3 — 体验对齐 Joplin**
定时/焦点/启动调度、并发传输、强制重传/强制重下、代理与自定义 TLS、Range 续传、多同步文件夹管理、保存后触发。

**M4 — 远期**
第二同步目标（本地目录/坚果云特化）、E2E 加密评估、（可选）同步历史可视化。

---

## 12. 测试计划

- **engine 单测（重点）**：`Transport` 内存假实现 + `tempfile` 本地树，覆盖分类矩阵全 10 行 × 变更/未变组合、冲突命名、fail-safe 触发、快照损坏恢复、dry-run 计划正确性。目标：合并逻辑行覆盖 > 90%。
- **webdav 单测**：URL 编码（中文/空格/`#`/`%`）、PROPFIND XML 多形态解析（带/不带命名空间前缀、缺 etag、目录 200）、href 反解。
- **state 单测**：序列化 round-trip、并发 flush 不损坏（临时文件 + rename 原子写）。
- **前端**：sanitize 对新 sync 段的兜底、调度器防重入/可见性门控（vitest，jsdom）。
- **E2E 手工清单**：双实例（或 Joplin/资源管理器映射盘）交叉编辑制造冲突、拔网线中断续传、远端清空触发 fail-safe、回收站恢复删除。
- 全量回归：`npm run test`（vitest）+ `cargo test`（src-tauri），改动前后对比，遵循既有基线纪律。

## 13. 风险与未决问题

| 风险/问题 | 应对 |
|---|---|
| 远端删除不可逆（服务器无版本控制时） | fail-safe + 计划预览 + 快照判据三层兜底；UI 明示 |
| 明文密码 | 已确认接受（同 Joplin）；设置页提示；将来可平滑升级 DPAPI，仅改存取两点 |
| PROPFIND Depth:1 大目录列举慢（千级文件） | M3 并行子目录 + 列举缓存；必要时按服务器支持探测升级 infinity |
| 服务器不支持条件请求 → 并发写竞态最后写入胜 | 冲突副本机制保证不丢内容；文档如实说明「非实时协作」 |
| Windows 非法字符文件名上传 WebDAV 失败 | 上传前校验 `<>:"\|?*`，列入 skipped 清单提示改名 |
| 大小写不敏感文件系统的双端路径碰撞（`A.md` vs `a.md`） | 快照 key 归一 + 检测碰撞即跳过并报错提示 |
| 未决：多根工作区是否默认全部纳入同步？ | 建议默认逐个显式添加（防误同步大目录），M3 定稿 |
| 未决：`basePath` 是否允许指向 Joplin 已建的同步目录混用？ | 不建议——Joplin 文件带 frontmatter 且命名受管，与 LiteMD 原样文件互踩；文档明确「一个目录只归一个应用同步」 |
