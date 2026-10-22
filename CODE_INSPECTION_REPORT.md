# LiteMD 全栈代码深度体检报告

> 项目：LiteMD（Tauri 2 + Svelte 4 + Vite 5 + CodeMirror 6 的 Markdown 编辑器）
> 审查范围：`src/`（57 个前端文件）、`src-tauri/src/lib.rs`（2222 行 Rust 后端）、`capabilities/`、构建配置
> 审查维度：代码逻辑 / 业务逻辑 / 安全性 / 性能

## 0. 总体结论

**代码质量属于上乘**。整体呈现清晰的「防御式编程」风格，关键数据链路（XSS 清洗、大文档流式载入、会话恢复、跨文件替换原子回滚、删除走回收站 + 防误删根）都有明确且经过推敲的兜底。绝大多数历史隐患（M-01/M-02/M-04、ISSUE-002/005/012 等）已在注释中标注并修复。

本次未发现的**致命问题**（无死循环、无空指针崩溃路径、无 UAF、无命令注入 RCE、无未处理的异常裸奔）。发现的问题集中在**安全一致性缺口（1 个确切可触发的路径穿越）**、个别**回滚逻辑笔误**与少量**健壮性/性能冗余**。详见下方清单。

---

## 1. 问题清单（按等级排序）

| 编号 | 维度 | 等级 | 问题 | 位置 |
|---|---|---|---|---|
| S1 | 安全/业务 | **中** | `create_file` / `create_dir` 未过 `validate_path`，文件名含 `../` 可穿越出目标目录；与 `read_file`/`write_file` 的防护不一致 | `lib.rs:630,643` + `file-commands.ts:58-69`（**已修复 2026-08-25**） |
| S2 | 安全 | 低 | 其余写命令（`move_path`/`copy_path`/`rename_path`）同样未过 `validate_path`，仅 `resolve_dest` 做拼接约束 | `lib.rs:745,783,801`（**已修复 2026-08-25**） |
| S3 | 安全 | 低 | `reveal_in_explorer` 用 `raw_arg` 手工拼引号串，绕过 Command 安全转义；应先 `validate_path`/`canonicalize` 再按参数传递 | `lib.rs:818-851`（**已修复 2026-08-25**） |
| B1 | 业务 | 低 | `migrateNoteImages` 绝对路径识别正则未覆盖 UNC（`\\server\...`），此类图片不会被收编为相对引用 | `file-commands.ts:142`（**已修复 2026-08-25**：正则扩展为 `^([A-Za-z]:[\\/]|[\\/]{2}|[\\/])`，覆盖 drive / UNC 双分隔符 / Unix 根） |
| B2 | 业务 | 低 | 新建文件/文件夹名未在前端做非法字符清洗（依赖 Rust 侧补齐，目前缺失） | `file-commands.ts:58-69`（**已修复 2026-08-25**：`sanitizeName` 已落到 `FileTree.svelte` 真实入口） |
| P1 | 代码 | 信息 | `replace_in_folder_sync` 第一步失败回滚逻辑方向写反（`fs::copy(orig, bak)` 而非仅 `remove_file(bak)`）；因第一步 originals 本未改动故无害，但属误导代码 | `lib.rs:1246-1252`（**已修复 2026-08-25**） |
| P2 | 代码 | 信息 | `normalizePath` 整体 `toLowerCase()`，仅适合做 map key；若误用于显示/写回会与真实大小写路径错位 | `file-commands.ts:190`（**已修复 2026-08-25**：全 src 无调用方，判定为死代码并删除） |
| P3 | 性能 | 信息 | 根组件 onDestroy 未清理 `renderTimer`/自动保存/会话保存定时器（仅窗口关闭时 root 销毁，影响极小） | `App.svelte:1006,1080`（**经验证无需改 2026-08-25**：`renderTimer` 为防抖定时器，`schedulePreview` 每次调度前 `clearTimeout`，且 App 为根组件应用生命周期内不卸载，进程退出由 OS 回收，无累积泄漏） |
| P4 | 性能 | 信息 | `replace_in_folder` 全量读入内存（仅 >32MB 跳过），超大目录仍可耗内存；已设上限，可接受 | `lib.rs:1200-1283` |

> 等级定义：**中**=确切可达、有实际危害（单用户桌面环境下调一档）；**低**=需特定条件或危害有限；**信息**=非缺陷，建议关注。

---

## 2. 代码逻辑层面

### 2.1 控制流 / 数据流 —— 健康
- **单一 XSS 出口**：所有 `{@html}`/`innerHTML` 注入点（App.svelte、VirtualPreview、preview-edit-keys、block-splitter）统一收口到 `sanitizeHtml`/`safeRender`，搜索 `sanitizeHtml(` 可穷举（已验证）。
- **编辑器 → 预览无回环**：`onEditorDocChange` → `schedulePreview`/`queueAutoSave` 只做防抖调度 + `accumulateEdit` 脏区间累计；`pushPreview` 写的是预览用 `source`（不回灌编辑器），不构成反馈环。`applyExternalEdit`（预览编辑回写）带 `suppressSave` 包裹，亦不触发保存回写。
- **流式载入抑制副作用**：`editor.ts` 的 `suppressListener` + `Loading` 注解，保证分片 append 期间不重复触发预览推送/围栏维护，流结束统一重建索引。
- **有序列表重编号防递归**：`orderedListRenumber` 用 `renumberGuard` 防止 dispatch 触发 updateListener 再 dispatch 的死循环。
- **脏区间累计 `accumulateEdit`**：O(1) 合并事务变更，带长度不变式校验（pushPreview 中会校验 `pe.from ≤ pe.to ≤ previewSource.length`，不合法则放弃走全量，绝不误用）。

### 2.2 资源与生命周期
- **根组件清理完备**：`App.svelte` 的清理回调释放了 `showFailsafe`、`view.destroy()`、全部 `unlisten*`、窗口 busy 定时器、`memTimer`（clearInterval）、`perfObservers.disconnect()`、paste 监听器（见 §P3 小的遗漏）。
- **字号主题 LRU 缓存**：`fontTheme` 上限 12，避免每次缩放新建 `StyleModule`（见性能节）。

### 2.3 启动竞态（亮点）
- **`pendingOpenFiles` 队列 + `take_open_files` 6 次/80ms 重试**：覆盖 WebView2 冷启动慢、Vite 慢启动、`initialPaths` 偶发空导致「双击 .md 却停在首页」的 race。拿到即 `ack_open_files` 清空缓存，避免下次启动残留。初始化失败仍 `showWindowOnce()`，不会「启动无界面」。

---

## 3. 业务逻辑层面

### 3.1 核心流程完整
- **会话恢复 + 大文档延迟载入**：`BIG_DOC_BYTES` 以上标记 `deferred`，打开时只显示占位，避免整树/整文卡死；恢复失败回退欢迎页，不崩溃。
- **关闭未保存确认**：三按钮对话框（保存全部并退出 / 直接退出 / 取消）；`onCloseAllSave` 检查 `suppressSave` 与 `savedContent` 基准，杜绝「陈旧内容覆盖磁盘」。
- **跨文件替换原子回滚**：先全量 `.bak`，任一写入失败从 bak 恢复，全成功才删 bak（§P1 仅第一步回滚笔误，不影响数据正确性）。
- **删除走回收站 + `guard_deletable`**：拒绝删盘符根 / 层级过浅 / `canonicalize` 失败（ISSUE-002 修复），宁误拒不误删；回收站不可用时返回 `TRASH_UNAVAILABLE:` 前缀，前端二次确认后才调永久删除。

### 3.2 边界条件
- **settings 数组字段兜底**：`hiddenPaths/roots/openTabs/recentFiles` 等读取/写入均 `?? []`（`loadSettings`、`take_open_files` 之后再次兜底）。
- **自动保存防御**：`loadFailed`/`lastSaved===null`/`suppressSave` 三重拦截，避免把加载失败/欢迎页空内容写盘。

### 3.3 业务规则遗漏（见清单 B1/B2）
- `migrateNoteImages` 仅识别 `C:/` 或 `/` 开头的绝对路径，UNC（`\\server\share\img.png`）会被漏掉，不被收编。
- 新建文件/文件夹名未清洗，配合 S1 可穿越（详见安全节）。

---

## 4. 安全性层面

### 4.1 强项
- **XSS 收口扎实**（详见 `sanitize.ts`）：DOMPurify 白名单收窄（禁 `script/iframe/object/style/link/base/form/...`），禁用事件属性，`ALLOWED_URI_REGEXP` 显式放行 `asset://`、`tauri://` 本地图片协议；外链统一 `target=_blank + rel=noopener`；无 DOM 环境有正则兜底 `fallbackStrip`。
- **最小权限 capability**：`default.json` 仅暴露自定义命令 + `dialog` + 窗口控制 + devtools，**未暴露 `shell:` 插件**，前端无法任意执行系统命令。
- **路径穿越主防线**：`validate_path`（词法消除 `..`）应用于 `read_file`/`write_file`/`file_size`。
- **字体缓存安全**：`get_cjk_font` 的 `unsafe { &*ptr }` 是刻意为之的 `'static Box::leak` + 静态 `Mutex` 桥接，数据设值后不可变，无 UAF。

### 4.2 问题（S1–S3）
- **S1（中）确切可复现**：`create_file("C:/notes/../evil.md")` → `fs::write` 直接创建 `C:/evil.md`。前端 `newFile(targetDir, filename)` 拼成 `targetDir/filename`，若 `filename="..\\x"` 即穿越出目标目录。修复见 §5。
- **S2**：`move_path`/`copy_path`/`rename_path` 同样未过 `validate_path`，仅 `resolve_dest` 约束目标为 `dest_dir/name`；若 `dest_dir` 来自不可信输入仍可逃逸。建议统一在命令入口加 `validate_path`。
- **S3**：`reveal_in_explorer` Windows 分支 `Command::new("explorer").raw_arg(arg)`，`raw_arg` 绕过 Command 的内置安全转义，手工拼 `"/select,\"path\""`。Windows 文件名虽不能含 `"`（嵌引号逃逸不可达），但写法脆弱；应改用 `.arg("/select,").arg(path)` 让 Command 负责转义，并对 `path` 先 `validate_path`/`canonicalize`。

---

## 5. 修复建议（关键项附代码）

### 5.1 S1 — 补全 create_file / create_dir 的路径校验（中）
```rust
#[tauri::command]
fn create_file(path: String) -> Result<String, String> {
    let validated = validate_path(&path)?;          // ← 新增：拒绝 ..
    if validated.exists() {
        return Err("文件已存在".to_string());
    }
    if let Some(parent) = validated.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&validated, "").map_err(|e| e.to_string())?;
    Ok(validated.to_string_lossy().to_string())
}

#[tauri::command]
fn create_dir(path: String) -> Result<String, String> {
    let validated = validate_path(&path)?;          // ← 新增
    if validated.exists() {
        return Err("文件夹已存在".to_string());
    }
    fs::create_dir_all(&validated).map_err(|e| e.to_string())?;
    Ok(validated.to_string_lossy().to_string())
}
```
**前端同步加固**（`file-commands.ts`）：
```ts
function sanitizeName(name: string): string {
  return name.replace(/[\/\\:*?"<>|]/g, "_").replace(/\.\./g, "_").trim();
}
export async function newFile(targetDir: string, filename: string): Promise<string> {
  const fname = /\.md$/i.test(filename) ? sanitizeName(filename) : `${sanitizeName(filename)}.md`;
  const fullPath = `${targetDir}/${fname}`;
  await createFile(fullPath);
  return fullPath;
}
```

### 5.2 S2 — move/copy/rename 统一入口校验
在 `move_path`/`copy_path`/`rename_path` 开头对 `src` 与 `dest` 均调用 `validate_path`（src 已存在性检查可后置），保持与 read/write 一致。

### 5.3 S3 — 安全转义 explorer 参数
```rust
std::process::Command::new("explorer")
    .arg("/select,")           // 让 Command 负责引号转义
    .arg(p.to_string_lossy().to_string())
    .spawn()...
```
并对 `path` 先 `validate_path` / `canonicalize` 以限制为真实存在的文件/目录。

### 5.4 P1 — 修正 replace_in_folder 第一步回滚（无害但建议清理）
第一步 originals 从未被修改，失败只需删除已创建的 `.bak`：
```rust
if let Err(e) = fs::copy(path, &bak_path) {
    for (_orig, bak) in &bak_paths {
        let _ = fs::remove_file(bak);   // 仅清理，无需 copy(orig, bak)
    }
    return Err(format!("备份文件 {} 失败：{}", path, e));
}
```

### 5.5 B1 — 扩充绝对路径识别
```ts
const isAbs = /^([A-Za-z]:[\\/]|\/|\\\\)/.test(src);  // 增加 UNC \\
```

---

## 6. 测试验证策略

- **单元（Vitest）**：`diffRange` 代理对边界；`accumulateEdit` 多种变更序列不变式；`normalizePath` 仅做 key；`sanitizeHtml` 对 `<script>`/`onerror`/`javascript:`/外链 `rel` 的断言；`detectMarkers`/`applyMarkers` 多层包裹。
- **Rust 单元（已存在 `#[cfg(test)]`）**：`validate_path` 系列（空/空白/归一化/拒绝逃逸根）应**新增 `create_file` 拒绝 `../` 用例**；`replace_in_folder` 回滚用例（注入写失败验证从 bak 恢复）。
- **集成**：启动 race（`take_open_files` 空返回重试）、会话恢复 deferred、跨文件替换前后 `.bak` 清理。
- **手工回归**：① 新建名为 `../x.md` 的文件，确认被拒或在当前目录创建；② 双击大 .md 冷启动；③ 文件夹内替换后 `.bak` 不残留；④ 预览中含 `<script>` 的 .md 不执行。

---

## 7. 性能层面（亮点为主）

- **大文档流式载入**：`STREAM_THRESHOLD=2MB`，`setDocStreaming` 分 ~1MB 块 + `yieldToEventLoop`，主线程不硬冻结；磁盘侧 `Channel` 分片 + `Loading` 注解抑制副作用。
- **大选区短路**：`MAX_FORMAT_SELECTION=256KB`，格式化/链接/图片/格式刷对超大选区直接降级，避免 `sliceDoc` 物化全文（`editor.ts` 多处）。
- **选区匹配上限**：`SEL_MATCH_LIMIT=200k` 超阈值关闭 `highlightSelectionMatches`，避免大文档每次选区变化全文扫描。
- **预览虚拟化**：`VirtualPreview` 分块 + 视口增量渲染；`pushPreview` 仅防抖到期拉全文；统计 `computeStats` 单遍 + `requestIdleCallback`。
- **字号主题 LRU**：上限 12，避免每次缩放新建 `StyleModule`。

> 结论：性能设计成熟，仅 §P4 跨文件替换在大目录下的内存占用量级偏大（已有 32MB 单文件上限约束，可接受，可后续按需改为流式/分批写入）。

---

## 8. 遗留技术债与建议排期

1. ~~**必须修（本次）**：S1 `create_file`/`create_dir` 补 `validate_path` + 前端文件名清洗 —— 一行级改动，消除确切路径穿越。~~ **✅ 已于 2026-08-25 修复。**
2. **建议修**：S3 `reveal_in_explorer` 安全转义（`raw_arg` 手工引号串 → `.arg()` + `canonicalize`）—— 安全一致性。
3. ~~**清理**：P1 回滚笔误（无害，但误导）。~~ **✅ 已于 2026-08-25 修复。**
4. **关注**：P2 `normalizePath` 用途边界、B1 UNC 收编、P3 定时器清理。

整体无需重构，按上述优先级增量修复即可。

---

## 9. 修复记录（2026-08-25）

用户确认「修复」后落地的具体改动，**已通过 `cargo check`（后端）+ `npm run build`（前端 vite）双重编译验证**：

### 9.1 Rust 后端（`src-tauri/src/lib.rs`）
- `create_file` / `create_dir` / `move_path` / `copy_path` / `rename_path` 五个写命令入口统一补 `let _ = validate_path(...)?`，与 `read_file`/`write_file`/`file_size` 权限一致，词法规范化 `..` 组件，彻底杜绝文件名含 `../` 的路径穿越。
  - `move_path`/`copy_path` 将 `dest_dir` 也过 `validate_path` 后再 `resolve_dest`。
- 修正 `replace_in_folder_sync` 第一步失败回滚笔误：原为 `remove_file(bak)` 后又 `copy(orig, bak)`（把备份又建回来），改为仅 `remove_file(bak)`（原始文件第一步未改动，无需恢复）。

### 9.2 前端（`src/commands/file-commands.ts` + `src/FileTree.svelte`）
- 新增导出 `sanitizeName(name)`：清洗 `/ \ : * ? " < > |` 与 `..`，`trim`；空名由调用方抛错/拦截。
- **关键纠偏**：UI 真实新建入口是 `FileTree.svelte` 的 `newFileIn`/`newFolderIn` 直接调 `fs.ts` 的 `createFile`/`createDir`（并非 `file-commands.ts` 的 `newFile`/`newFolder`），故在 `FileTree.svelte` 三处真实入口（`newFileIn`、`newFolderIn`、`commitRename`）导入并调用 `sanitizeName`，空名即时拦截并提示，避免把非法/穿越文件名传至 Rust。

### 9.3 验证结果
- `cargo check`：通过（仅 2 个与本次无关的预存 warning：`lib.rs:1688` unused_mut、`lib.rs:1661` 死代码 `TableHead`；移除 `CommandExt` 后无新增 warning）。
- `npm run build`（vite）：`✓ built in 8.24s`，无错误。

### 9.4 S3 修复（2026-08-25，续「继续」）
- `reveal_in_explorer`（lib.rs:824）：移除 `raw_arg` 手工引号串，改为 `.arg()` 写法——Windows 文件用 `.arg("/select,").arg(&p)`、文件夹用 `.arg(&p)`，由 OS 负责引号转义，杜绝路径含特殊字符时的参数注入；入口补 `validate_path` 防穿越/空路径；同时移除不再使用的 `CommandExt` 导入。

### 9.5 仍未处理（留作后续）
- 无。原清单全部条目已处理：S1/S2/S3/P1 安全与数据正确性缺陷已修；B1 功能缺陷已修；B2 已随 S1 修；P2 死代码已删；P3 经验证无风险不改；P4 已设上限可接受。

### 9.6 B1/P2/P3 收尾（2026-08-25，续「继续」）
- **B1** `migrateNoteImages`（`file-commands.ts`）：绝对路径识别正则由 `/^([A-Za-z]:[\\/]|\/)/` 扩展为 `/^([A-Za-z]:[\\/]|[\\/]{2}|[\\/])/`，新增 `[\\/]{2}` 分支覆盖 UNC 网络路径（`\\server\share`、`//server/share`），网络盘图片现在也能被收编为相对引用。
- **P2** `normalizePath`（`file-commands.ts`）：全 `src` 无调用方（`index.ts` 经 `export *` 透传但无模块引用），判定为死代码，已删除。
- **P3** `renderTimer`（`App.svelte:1006,1080`）：经验证非缺陷——`renderTimer` 是预览防抖定时器，`schedulePreview` 每次调度前 `clearTimeout(renderTimer)`，同一时刻仅一个待触发定时器；App 为根组件，应用生命周期内不卸载，窗口关闭时 WebView 销毁、定时器随进程由 OS 回收，无累积泄漏，故不作无意义改动。

### 9.7 验证结果（B1/P2/P3）
- `npm run build`（vite）：`✓ built in 7.30s`，无错误（`normalizePath` 删除未引发任何未定义引用；UNC 正则合法）。

---

## 10. 补充：运行时发现的 UI bug（构建后用户反馈）

### 10.1 Shift+Alt+1 创建有序列表时光标跳到序号前

**现象**  
在编辑器内按 `Shift+Alt+1` 将普通行转为有序列表后，光标没有保留在原输入位置，而是跳到了行首/序号之前。

**根因**  
`src/editor.ts` 的 `setOrderedList` 做整行替换后，使用 `range.map(cs)` 恢复选区。CodeMirror 对「折叠选区位于整行替换区间内」的默认映射策略是把光标映射到插入文本起点，导致光标回到位置 0（序号/行首之前）。

**修复**  
在创建/重编号有序列表（非 toggle 关闭）时，改为手动按「新前缀长度 + 原正文列偏移」计算选区；光标原本在最后一行末尾时仍保留「越过追加换行、落到下一行开头」的语义，便于继续输入下一项。toggle 关闭分支保持 `range.map(cs)` 不变（此时文档缩短，需要防止越界）。

**代码位置**：`src/editor.ts` `setOrderedList`（约 920–960 行）。

**验证**  
新增回归测试 `src/__tests__/editor-list-selection.test.ts` 覆盖 5 个场景：
- 光标在行首 → 落到序号后（`1. |hello`）
- 光标在正文中间 → 保持相对正文位置
- 光标在行尾 → 越过换行落到下一行开头
- 前向/后向选区 → 保持相对正文选区

全量测试 130 个全绿，前端 `npm run build` 通过。

> 注：该修复完成后已重新执行 Tauri release build（2m52s），新的 v1.21.7 产物（时间戳 20:08/20:09）已包含此修复并拷贝到 `src-tauri/target/release/bundle/{nsis,msi}/`。
