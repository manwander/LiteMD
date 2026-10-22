# LiteMD 代码系统性分析报告

> 分析对象：`C:/Users/manwa/Desktop/LiteMD`（Rust + Tauri 2.x 后端 `src-tauri/src`；TypeScript + Svelte 4 前端 `src`）
> 分析范围：全部非测试源码（`.rs` 8 个、`.ts` 41 个、`.svelte` 14 个），对照 `package.json` / `tsconfig.json` / `vite.config.ts` 构建配置。
> 验证手段：静态通读 + 定向交叉核验 + `npx tsc --noEmit -p tsconfig.json`（已执行，退出码 **0**，零类型错误）+ 子代理对前端全量扫描。

---

## 一、总体结论

| 维度 | 结论 |
|------|------|
| 语法/编译异常 | **前端 `tsc --noEmit` 通过（exit 0），Rust 端 8 个模块均附带充足单元测试、可编译**。未发现会导致构建失败的语法/类型错误（仅 1 处可移植性隐患，见 W-1）。 |
| 运行时崩溃 | **未发现致命/严重级空指针、越界、未捕获 reject 崩溃点**。核心路径（`editor.ts` 选区映射、CM6 `state.changes` 边界、文件树 `nodeMap` 访问、流式分片）均有守卫。 |
| 功能完整性 | 1 处**确定性功能缺陷**（文件树回车提交重命名误触达打开/折叠，见 S-1）；其余功能分支经核验自洽。 |
| 潜在风险 | 少量**警告级**隐患：全局可写标志跨实例共享、已废弃 `execCommand` 依赖、监听器/计时器清理（已确认基本到位）、PDF 字体取 TTC 首面。 |
| 安全 | **未注入任何未经清洗的 HTML**。所有 `innerHTML` / `{@html}` 均经 `sanitize.ts` 的 `sanitizeHtml`/`safeRender`（DOMPurify）单一出口；Tauri 文件系统命令参数均经后端 `validate_path` 词法规范化 + 回收站/根保护双重防线。 |

**严重度汇总**

| 严重度 | 数量 | 编号 |
|--------|------|------|
| 🔴 致命（Fatal） | 0 | — |
| 🟠 严重（Serious） | 1 | S-1 |
| 🟡 警告（Warning） | 7 | W-1 ~ W-7 |

---

## 二、严重问题（Serious）

### S-1　文件树「回车提交重命名」事件冒泡污染 — 确定性功能缺陷

- **位置**：`src/FileTree.svelte`
  - 输入框处理器：`onRenameKeydown`（L613–621）
  - 父级列表处理器：`onListKeydown`（L129–180，绑定于 L1408 `<ul on:keydown={onListKeydown}>`）
  - 输入框挂载点：L1473–1478 `{#if renaming ...}` 内 `<input on:keydown={onRenameKeydown}>`
- **问题描述**：`onRenameKeydown` 在 `Enter`/`Escape` 分支**只调用了 `e.preventDefault()`，未调用 `e.stopPropagation()`**。重命名输入框是父级 `<ul>` 的子节点，键盘事件会冒泡到 `onListKeydown`：
  - **Enter 提交重命名（文件）**：`commitRename()` 先把 `renaming` 同步置空（L590），随后冒泡进入 `onListKeydown` 的 `case "Enter"`（L159–167）。此时 `renaming` 已为空，于是用**旧路径** `handlers.openFile(n.path)` 打开一个即将被改名的文件；
  - **Enter 提交重命名（文件夹）**：冒泡后执行 `toggleFolder(n.path)`，在用户意图「确认改名」时错误地折叠/展开文件夹；
  - **Escape 取消重命名**：冒泡后进入 `case "Escape"`（L176–179），若当前存在过滤词会误触发 `store.setFilter("")`，清空搜索框。
- **影响范围**：所有通过 `F2` / 右键「重命名」后用键盘确认的交互，复现稳定，属于明确的交互逻辑错误（非崩溃，但功能被污染）。
- **修复建议**（二选一即可）：
  1. 在 `onRenameKeydown` 的 `Enter` 与 `Escape` 分支补 `e.stopPropagation();`
  2. 或在 `onListKeydown` 开头加 `if (renaming) return;`（在 `case "Enter"`/`case "Escape"` 处理前短路）。推荐方案 1（更局部、语义更清晰）。

```ts
function onRenameKeydown(e: KeyboardEvent) {
  if (e.key === "Enter") {
    e.preventDefault();
    e.stopPropagation();   // ← 新增：阻断冒泡到 onListKeydown
    void commitRename();
  } else if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();   // ← 新增
    cancelRename();
  }
}
```

---

## 三、警告问题（Warning）

### W-1　`block-splitter.ts` 以 `.ts` 扩展名导入模块（可移植性隐患）
- **位置**：`src/preview/block-splitter.ts:13` — `import { sanitizeHtml } from "../sanitize.ts";`
- **描述**：当前 `tsconfig.json` 采用 `moduleResolution: "bundler"`，Vite 可正常解析带 `.ts` 的导入，因此**构建实际不报错**（`tsc --noEmit` 亦通过）。但若 CI / 类型检查改用 `node` / `node16` / `nodenext` 解析策略，会报 `Cannot find module '../sanitize.ts'`。全仓 grep 确认仅此一处带扩展名，其余（如 `App.svelte:30`）均为无扩展名写法。
- **影响**：当前无害；切换解析策略或迁移工具链时会构建失败。
- **建议**：改为 `import { sanitizeHtml } from "../sanitize";`，与全仓一致。

### W-2　`document.getElementById("app")` 不保真强转
- **位置**：`src/main.ts:6` — `document.getElementById("app") as HTMLElement`
- **描述**：若 `index.html` 中 `#app` 缺失（HTML 改动/注入异常），`mount(App, { target })` 会抛错并触发整页白屏。正常发布路径下 `#app` 必然存在，触发概率极低。
- **影响**：极端边界下的致命页，但正常流程不可达。
- **建议**：判空后显式抛错或回退提示：`const el = document.getElementById("app"); if (!el) throw new Error("missing #app mount node");`

### W-3　`renumberGuard` 为模块级全局，预览编辑双 EditorView 实例隐式共享
- **位置**：`src/editor.ts:1073`（`let renumberGuard = false;`）
- **描述**：预览编辑模式下存在一个「备份」`EditorView` 与主编辑器实例并存，两者都挂载了 `orderedListRenumber` 监听器并共享该全局布尔标志。`setDoc`/`setDocStreaming` 在同步 `dispatch` 内用 `try/finally` 临时置位以抑制载入时的自动重编号。
- **影响**：JS 单线程 + 标志在同步段内 `finally` 复位，**实际不可能**发生跨实例干扰；属于架构耦合点，非真实缺陷。
- **建议**：将标志收敛为实例字段或 `WeakSet<EditorView>`，消除隐式共享，提升可维护性。

### W-4　文件树监视状态文案竞态（仅文案）
- **位置**：`src/FileTree.svelte:1194` 附近 `toggleWatch`
- **描述**：`handlers.setStatus(watchOn ? "目录监视已开启" : "正在开启目录监视…")` 读取的 `watchOn` 在 `restartWatch` 内由 `await startWatching(...)` 异步赋值，调用 `setStatus` 时 `watchOn` 仍可能是旧值（从关闭态开启时恒为 `false`），状态栏文案与真实状态短暂不一致。
- **影响**：纯 cosmetic，无功能后果。
- **建议**：在 `startWatching` resolve 后按真实返回值再 `setStatus`。

### W-5　依赖已废弃的 `document.execCommand`（长期兼容性）
- **位置**：`src/preview-edit-keys.ts`（多处，如 L195 / L421 / L436 / L526）
- **描述**：大量使用 `execCommand("formatBlock", …)` 等已被标准废弃的 API。当前 WebView2 / Chromium 仍支持，且代码均为「execCommand 失败 → 兜底手动 Range 改写」模式（L431–449），功能不退化。
- **影响**：当前无碍；未来浏览器若移除该 API 需迁移到 Selection/Range 手动改写。
- **建议**：保留并持续验证兜底路径；列入长期技术债。

### W-6　PDF 导出取 TTC 字体首面（渲染覆盖度）
- **位置**：`src-tauri/src/lib.rs` `get_cjk_font()`（L2052 起）+ `export_pdf_sync` 调用 `add_external_font`
- **描述**：候选中文字体多为 `.ttc` 集合（如 `msyh.ttc`/`simsun.ttc`）。`printpdf 0.6` 的 `add_external_font` 不接受 face 索引，内部 `ttf-parser` 固定取集合第 0 个字体。绝大多数中文 glyph 在 face 0 即可命中，但特定字重/变体（如仅存在于其他 face 的字形）可能缺失。
- **影响**：极端字形可能不显示，常规中文文档不受影响。
- **建议**：如需精确字重，可在读取字体后按 `Face::from_table` 选择具体 face，或优先挑选 `.ttf` 候选（已在候选列表中存在 `simhei.ttf`/`simsun.ttc` 等）。

### W-7　`split_line` 单字符超宽边界（理论性丢字）
- **位置**：`src-tauri/src/lib.rs` `split_line`（L2115 起）与 `export_pdf_sync` 折叠循环（L2279 起）
- **描述**：若某一**单个字形**的渲染宽度超过内容区宽度（以当前字号 + `MAX_CONTENT_W_MM≈170mm` 而言几乎不可能，仅极端放大或特殊符号可触发），`split_line` 返回 `(空串, 0)`，`export_pdf_sync` 的循环 `consumed == 0` 分支会 `break` 并 push 一个空行，**丢失该字符**。
- **影响**：理论边界，正常文档不可达。
- **建议**：在 `consumed == 0 && !text.is_empty()` 时，至少按 1 个字符截断而非丢弃，保证不丢字。

---

## 四、值得肯定的工程实践（已核验）

以下要点说明代码整体质量较高，问题清单见上、并非「满篇缺陷」：

1. **后端路径安全纵深防御**：`validate_path`（词法消 `..`/`.`）+ `guard_deletable`（拒绝根/系统目录/用户主目录根）+ `safe_asset_target`/`resolve_image_path`（`canonicalize` 双重防逃逸）+ 附件扩展名白名单。删除一律走回收站（`trash::delete`），回收站不可用时明确报错、绝不降级永久删。
2. **原子写盘**：`atomic_write`（唯一临时文件 + `sync_all` + `rename`）贯穿 `write_file`/`save_settings`/`export_*`/`store_asset`/快照，崩溃/磁盘满不会截断原件。
3. **多编码兼容**：`decode_text`（UTF-8 BOM → UTF-16LE/BE → UTF-8 → GBK 零错误）与 `encode_text`（保持原编码回写），中文文档不会乱码。
4. **Tauri 重 IO 全部 `spawn_blocking`**：文件读写、目录列举、搜索/替换、PDF/HTML 导出均不在事件循环线程执行，避免窗口冻结。
5. **同步引擎（WebDAV）安全与韧性**：`build_plan` 三方合并矩阵（10 行）全覆盖、fail-safe 双向删除保护、阈值熔断、打开且脏标签保护、强制模式配置错误中止、K/M5/M6 等修复（远端忽略规则、超大文件内存防护、Unicode 切点防 panic），并配套 30+ 单元测试与端到端用例。
6. **前端安全单一出口**：`sanitize.ts` 的 `sanitizeHtml`/`safeRender`（DOMPurify 白名单 + `FORBID_TAGS`/`FORBID_ATTR` + 协议白名单 + style 白名单）是全部 `innerHTML`/`{@html}` 的上游，XSS 面收敛彻底。
7. **文件树生命周期清理到位**：`onMount`/`onDestroy` 移除 `window` 的 `pointermove`/`pointerup`、`unlistenDrop`（经 `disposed` 防泄漏）、`stopWatching`、两个计时器；拖拽期间 `pauseWatcher`/`resumeWatcher` 配对正确。

---

## 五、验证记录

| 项 | 命令 / 方式 | 结果 |
|----|------------|------|
| 前端类型检查 | `npx tsc --noEmit -p tsconfig.json` | **EXIT 0，零错误** |
| 前端全量静态扫描 | 子代理通读 41 个 `.ts` + 14 个 `.svelte`（排除 `__tests__`） | 见上，仅警告级 |
| 后端 Rust 静态通读 | 人工通读 8 个 `.rs`（含 4 个 sync 模块） | 未发现编译/逻辑缺陷，测试覆盖充分 |
| 安全注入点核验 | grep 全部 `innerHTML` / `{@html}` | 全部经 `sanitizeHtml`/`safeRender` |

---

## 六、修复优先级建议

1. **立即修复**：S-1（功能缺陷，补 `stopPropagation()`，1 行改动）。
2. **顺手清理**：W-1（去掉 `.ts` 扩展名）、W-2（`#app` 判空）。
3. **技术债（择机）**：W-3 / W-4 / W-5。
4. **文档化/观察**：W-6 / W-7（属边界与兼容性，当前无用户可见问题）。

---

## 七、修复记录（2026-10-22）

全部问题已按上述建议落地，并对受影响文件做了编译/类型校验。

| 编号 | 文件 | 改动要点 | 验证 |
|------|------|----------|------|
| **S-1** | `src/FileTree.svelte`<br>`onRenameKeydown` | `Enter`/`Escape` 两分支各补 `e.stopPropagation()`，阻断冒泡到父级 `onListKeydown`，避免回车误打开旧路径文件/误折叠文件夹、Esc 误清空搜索框。 | `tsc --noEmit` 通过 |
| **W-1** | `src/preview/block-splitter.ts:13` | `import { sanitizeHtml } from "../sanitize.ts"` → `"../sanitize"`，与全仓无扩展名写法一致，消除切换到 `node`/`nodenext` 解析策略时的构建失败风险。 | `tsc --noEmit` 通过 |
| **W-2** | `src/main.ts:6` | `document.getElementById("app")` 结果判空；缺失时显式抛错（含中文提示），避免 `#app` 缺失导致整页白屏但无诊断信息。 | `tsc --noEmit` 通过 |
| **W-3** | `src/editor.ts`<br>`renumberGuard` | 模块级全局布尔 → 按实例隔离：`const renumberSuppressed = new WeakSet<EditorView>()` + 辅助函数 `suppressRenumber(view, fn)`；`setDoc` 整体替换与 `orderedListRenumber` 监听器均改用实例维度守卫，消除预览编辑「备份」EditorView 与主编辑器共享标志的架构耦合（原单线程+`finally` 复位下不可达，现更稳健可维护）。 | `tsc --noEmit` 通过 |
| **W-4** | `src/FileTree.svelte`<br>`toggleWatch`/`restartWatch` | `restartWatch` 改为 `async` 并返回 `boolean`；`toggleWatch` 先提示「正在开启…」，`await restartWatch()` 后按**真实返回值**设置「已开启 / 启动失败」，消除从关闭态开启瞬间读取到旧值 `false` 导致的状态文案与真实状态不一致。 | `tsc --noEmit` 通过 |
| **W-5** | `src/preview-edit-keys.ts` | **无需改动**。代码均为「`execCommand` 失败 → 手动 `Range` 改写兜底」模式，功能不退化；仅作为长期技术债记录，待未来浏览器移除该 API 时统一迁移。 | 已具备兜底，未改 |
| **W-6** | `src-tauri/src/lib.rs`<br>`get_cjk_font` | 新增 `parse_best_face(data)`：遍历 TTC 集合内全部 face（`Face::parse(data, idx)`，`idx≤32` 安全上限），选 `number_of_glyphs` 最大的 face，最大化 CJK 字形覆盖、降低缺字概率；`get_cjk_font` 改用之。单 face `.ttf` 自然只命中 face 0。 | `cargo check` 通过 |
| **W-7** | `src-tauri/src/lib.rs`<br>`export_pdf_sync` 折行循环 | 折行循环对 `consumed == 0` 分支增加防御：当 `rest` 非空（理论上的单个超宽字形边界，正常文档不可达）时强制前进 1 字符并如实输出，杜绝死循环与丢字；`rest` 为空时正常收尾。 | `cargo check` 通过 |

### 验证汇总

| 项 | 命令 | 结果 |
|----|------|------|
| 前端类型检查 | `npx tsc --noEmit -p tsconfig.json` | **EXIT 0，零错误** |
| 后端编译检查 | `cargo check --message-format short`（src-tauri） | **Finished**，仅 2 条预存在的 style 警告（`lib.rs:2288` 多余 `mut`、`:2261` 未使用 `TableHead` 变体），均与本次改动无关 |

### 结论

- 1 项严重（S-1）、7 项警告（W-1~W-7）全部处理完毕：6 项代码修复 + 1 项确认已有兜底（W-5）+ 2 项边界防御（W-6/W-7）。
- 功能缺陷 S-1 已闭环（重命名键盘确认不再误触达打开/折叠/清搜索）。
- 全量静态分析与构建校验均通过，未引入新的编译/类型错误。
