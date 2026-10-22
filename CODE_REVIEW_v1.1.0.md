# LiteMD 源代码深度体检与优化路线图

> 版本基线：**v1.1.0**（Tauri 2 + Svelte 4 + CodeMirror 6 + Rust 后端）
> 体检范围：`src/**`（TS/Svelte，约 11.2k 行）+ `src-tauri/src/lib.rs`（Rust，1530 行）
> 方法：静态嗅探 + 调用链追踪 + 触发条件推演（先证伪再下结论）

---

## 0. 结论先行

| 指标 | 数值 |
|---|---|
| 发现问题总数 | **17** |
| Blocker（启动即崩） | 0 |
| Critical（高危） | **1** |
| Major（严重） | **4** |
| Minor（一般） | 9 |
| Suggestion（建议） | 3 |
| 预计修复人天 | 约 4–6 人天（分 2 个迭代） |

**总体质量基线判断**：架构成熟度较高——大文档流式载入、预览增量切块、撤销保护、异步重入守卫（`enteringPreview`）、多文件保存基准守卫（`suppressSave`/`lastSaved`/`loadFailed`）都考虑得比较周到，说明经典缺陷已被系统性消除。当前**真正的剩余风险集中在两个方向**：
1. **安全边界**：markdown-it 开启 `html:true` 且未清洗，构成"打开恶意 .md → 本地 RCE"向量（**Critical**）。
2. **数据完整性**：永久删除不可恢复、预览编辑退出时的整篇 HTML 往返改写、文件夹批量替换与打开标签的状态失配（**Major ×3**）。

其余均为边界健壮性 / 类型安全 / 构建环境类问题。

---

## 1. P1 静态审查与嗅探

| 维度 | 判定 | 依据 |
|---|---|---|
| 后端 Rust·安全 | ⚠️ 隐患 | `delete_path`(lib.rs:334) 直接 `remove_dir_all`/`remove_file`，无回收站、不可恢复 |
| 后端 Rust·健壮性 | ✅ 达标 | 大文档流式 `read_file_head`/`stream_file_rest` 按 UTF-8 边界对齐，损坏文件 `from_utf8_lossy` 兜底，不 panic |
| 后端 Rust·防呆 | ✅ 达标 | `guard_not_into_self`(374) 防自拷贝；`move_path` 跨盘回滚(391-408)；`resolve_dest` 同名报错 |
| API·契约 | ✅ 达标 | `fs.ts` 的 invoke 参数名（path/content/root/html）与 `lib.rs` 命令形参逐一对应，有注释约束 |
| 前端·XSS | ⚠️ **严重** | `html:true`(App.svelte:147) + 3 处 `innerHTML`/`{@html}` 注入（见 C-01） |
| 前端·渲染 | ✅ 达标 | 预览走 VirtualPreview 虚拟化 + 增量切块，超阈值降级，内存压力自愈 |
| 前端·状态 | ✅ 达标 | 多标签保存基准守卫完整（`suppressSave`/`lastSaved`/`loadFailed`） |
| 数据·持久化 | ✅ 达标 | `sanitize()`(settings.ts:357) 对每项字段做类型/范围校验 + 快捷键值迁移；settings 与 localStorage 双兜底 |

---

## 2. P2 Web UI/UX 体检（用户视角）

| 项 | 状态 | 说明 |
|---|---|---|
| 大文档预览空白 | ⚠️ 设计取舍 | >8MB 自动收起预览且**禁用手动刷新**(App.svelte:1177 `manualRefreshMax`)，用户完全看不到预览。属明确取舍，但建议在状态栏常驻"预览已禁用（文档过大）"提示 |
| 内存自愈不可逆 | ⚠️ 体验 | `memReliefEnabled`(App.svelte:1295) 触发后"粘性不回退"，低端设备需重开才恢复（注释自述） |
| 预览编辑进入态 | ⚠️ 弱反馈 | `enterPreviewEdit` 异步渲染期间无骨架/加载提示，大文档首次进入可能短暂空白 |
| 空态/断网 | ✅ 达标 | 欢迎页、载入失败页（`loadFailed`）、流式进度条齐备 |
| 危险操作确认 | ⚠️ 部分 | 删除有确认；但关闭窗口仅确认"未保存"，不区分"永久删除风险" |

---

## 3. P3 Bug 预测（高频故障点嗅探）

| 故障场景 | 是否存在 | 兜底 |
|---|---|---|
| 打开损坏/非 UTF-8 的 .md | 存在但已兜底 | `utf8_boundary` + `from_utf8_lossy` 不 panic，预览可能乱码但安全 |
| 自动保存与标签切换竞态 | 已防护 | `suppressSave` 在 `applyTabState` 全程置位，autosave 双重检查 |
| 预览编辑重入（快速双击切换） | 已防护 | `enteringPreview` 守卫 + `exitPreviewEdit` 幂等 |
| **打开恶意 .md（含原始 HTML）** | **存在，无兜底** | `html:true` 直接渲染，无任何清洗 → **C-01** |
| **文件夹批量替换命中已打开文件** | **存在，无兜底** | 磁盘已改、编辑器 `source/lastSaved` 陈旧 → **M-03** |
| 预览编辑退出时内容重写 | 存在 | 整篇 `setDoc` 往返改写 → **M-02** |
| 关窗口时未保存 | 已防护 | `onCloseRequested` → 阻止默认 → 脏标签确认对话框 |

---

## 4. P4 问题清单汇总（按等级排序）

> 等级：Blocker > Critical > Major > Minor > Suggestion

| 编号 | 摘要 | 等级 | 阶段 | 模块 | 具体位置 | 触发条件 | 影响范围 | 状态 |
|---|---|---|---|---|---|---|---|---|
| **C-01** | markdown-it `html:true` 未清洗，打开恶意 .md 可注入脚本，经 Tauri IPC 读写任意文件 | **Critical** | P1/P3 | 前端·安全 | 配置 `App.svelte:147`；注入点 `App.svelte:475`、`:1726`、`VirtualPreview.svelte:434`、`App.svelte:2031`(导出) | 打开/预览任何含 `<script>`/`<img onerror>`/`<iframe>` 的 .md（含网络下载笔记） | WebView 以应用权限执行脚本，可 `invoke` 读写用户任意文件、外传数据（本地 RCE 级） | 待修 |
| **M-01** | `delete_path` 永久删除不可恢复 | Major | P1 | 后端·安全 | `lib.rs:334` `remove_dir_all`/`remove_file` | 文件树删除（UI 有确认，但 Rust 层不可逆） | 误删/路径边界错误 → 数据永久丢失 | 待修 |
| **M-02** | 退出预览编辑时整篇 markdown 经 HTML→turndown 往返重写 | Major | P1/P3 | 前端·数据 | `App.svelte:1792 flushPreviewEdit` → `:450 setDoc` | 每次进入并退出预览编辑模式 | ①污染撤销历史（一次巨型 undo，丢失细粒度撤销）②光标位置丢失 ③HTML 块/代码围栏/原始 HTML 经往返被改写或丢失，造成"保存后文档被悄悄改写" | 待修 |
| **M-03** | 文件夹批量替换命中已打开文件，编辑器状态失配 | Major | P1/P3 | 前后端·一致性 | `lib.rs:770 replace_in_folder`；`App.svelte:2591` | 当前打开的 .md 正处于被替换的文件夹内 | 磁盘已改、编辑器 `source/lastSaved` 陈旧；自动保存或保存会用内存旧内容覆盖磁盘新内容 | 待修 |
| **M-04** | contenteditable 预览编辑可持久化任意 HTML，放大 C-01 威胁 | Major | P1 | 前端·安全 | `previewEditEl.innerHTML`(475/1726) → `initTurndown().turndown`(1798) | 在预览编辑模式粘贴/编辑原始 HTML 并保存 | 原始 HTML 落盘为 markdown，下次渲染再次执行 | 待修（随 C-01 一并修） |
| m-01 | `setOrderedList`/`renumberBlock` 对混合/嵌套有序列表边界行为不稳 | Minor | P1 | 编辑器 | `editor.ts:851`、`:887` | 跨多个不连续列表块、空行夹杂时重编号 | 可能产生非预期编号或多余改动 | 待修（补测试） |
| m-02 | `accumulateEdit` 脏区间合并在跨脏区前后同时编辑的罕见序列下可能计算出界 | Minor | P1 | 前端·预览 | `App.svelte:1066`（兜底 `:1155` 长度不变量） | 极罕见编辑序列 | 静默降级为全量重渲染（性能，非正确性） | 已兜底 |
| m-03 | `uint8ToBase64` 用 `fromCharCode(...arr)` 展开 | Suggestion | P1 | 前端 | `App.svelte:2444` | 超大图（已按 0x8000 分块，未超栈上限） | 当前安全，仅稳健性建议 | 观察 |
| m-04 | 渲染规则多处 `any` 类型，类型安全弱 | Minor | P1 | 前端·质量 | `App.svelte:157-197` | — | 降低可维护性，漏掉潜在字段错误 | 待改 |
| m-05 | `window.addEventListener("paste")` 在 onMount 添加、onDestroy 移除，热重载可能重复 | Suggestion | P1 | 前端·质量 | `App.svelte:1286`（移除 `:1481`） | 异常/重复挂载 | 潜在重复监听 | 观察 |
| m-06 | `bump-version.js` 每次 `tauri:build` minor+1；沙箱内 `fs.rmSync` 被安全删除 shim 劫持致 vite 清空 dist 失败 | Minor | 构建 | 工程 | `scripts/bump-version.js`；构建需 `NODE_OPTIONS=""` | 在 WorkBuddy 沙箱构建 | 非运行时 bug；但易误触版本跳号 / 构建中断 | 已知（见记忆） |
| m-07 | `export_pdf`（pulldown-cmark+printpdf）对复杂/原始 HTML markdown 渲染弱，大文档可能长耗时 | Minor | P2 | 后端·导出 | `lib.rs:1154` | 含 HTML 块/多图/大文档的 PDF 导出 | 渲染缺失或卡顿/OOM | 待优化 |
| m-08 | `resolveImageRef`/`assetFromImageFile` 强依赖 `currentPath` 非空，切换时序临时为空时回退绝对路径 | Minor | P3 | 前端·图片 | `App.svelte:2462`、`:2473` | 在 `applyTabState` 瞬时空窗插入图片 | 引用变成绝对路径，预览/同步异常 | 待加固 |
| m-09 | 预览编辑模式下 CodeMirror 隐藏但 keymap 仍在，焦点边界可能误触发组合键 | Minor | P2 | 前端·交互 | `App.svelte:2697-2701` 仅放行 Ctrl+S | 特定焦点时序 | 偶发视图命令误触发 | 待观察 |
| m-10 | 大文档流式只读期（`contenteditable=false`）与预览编辑模式交互的边界 | Suggestion | P3 | 前端 | `App.svelte:565` vs `:1792` | 极小概率跨 tab 时序 | 影响有限 | 观察 |
| UX-1 | >8MB 文档预览被禁且不能手动刷新，用户无可见提示 | Minor | P2 | 前端·UX | `App.svelte:1177` | 打开 >`manualRefreshMax` 文档 | 用户困惑"预览空白" | 待优化 |
| UX-2 | 内存自愈（清缓存/暂停预渲染）触发后不可逆 | Minor | P2 | 前端·UX | `App.svelte:1295` `memReliefEnabled` | 堆超阈值 | 低端设备需重开恢复 | 待优化 |

---

## 5. P5 代表性修复方案与代码

### C-01（Critical）：清洗 markdown 渲染，阻断脚本注入

**根因**：`new MarkdownItCtor({ html: true })` 让原始 HTML 透传，而预览/导出全部以 `innerHTML`/`{@html}` 注入具有 Tauri IPC 权限的 WebView。

**方案 A（推荐，最稳）**：默认 `html: false`（markdown-it 原生转义 `<script>` 等），仅当用户确实需要内嵌 HTML 时，对 `html:true` 的输出用 **DOMPurify** 白名单清洗后再注入。

```ts
// App.svelte initMd()
import DOMPurify from "dompurify";
const instance = new MarkdownItCtor({
  html: true,            // 保留用户需要的 HTML 块能力
  linkify: true,
  highlight: (code, lang) => highlightCode(code, lang),
});
instance.linkify.set({ fuzzyLink: false, fuzzyEmail: false });
// 注入前统一清洗（预览 & 导出共用）
export function safeRender(md: MarkdownIt, src: string): string {
  return DOMPurify.sanitize(md.render(src), {
    ADD_ATTR: ["target"], FORBID_TAGS: ["style", "iframe"],
    FORBID_ATTR: ["onerror", "onload", "onclick"],
  });
}
// App.svelte:475 / :1726 改为 safeRender(m, tab.content)
// VirtualPreview.svelte:434 改为 {@html safeRender(md, block.html)}
```

**备选方案 B**：直接 `html: false`。彻底消除脚本向量，但用户文档里的原始 HTML 块会被当成纯文本显示（功能回退，需与用户确认是否接受）。

**影响**：方案 A 不影响现有合法 markdown；仅拦截 `<script>`/事件属性/iframe。
**回滚**：DOMPurify 作为可选依赖，移除即退回现状。

### M-02（Major）：预览编辑退出改为增量同步，避免整篇重写

**根因**：`flushPreviewEdit` 调 `setDoc(view, text)` 用 `from:0,to:len` 整体替换，触发一次巨型事务。

**方案**：改为"记录预览编辑期间的脏文本范围，仅 replace 该范围"；光标用 `EditorSelection.main` 保留；turndown 配置对齐 markdown-it（保留围栏语言、链接格式）。

```ts
function flushPreviewEdit() {
  if (!previewEditEl || !view) return;
  const text = initTurndown().turndown(previewEditEl.innerHTML);
  // 仅当与 source 不同时才替换，且用原光标位置做最小替换
  if (text === source) return;          // 无变化直接跳过，避免污染 undo
  suppressSave = true;
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text },
                  selection: { anchor: view.state.selection.main.head } });
  suppressSave = false;
  // ...（保留 docDirty/queueAutoSave 等）
}
```

**备注**：更彻底的做法是 diff `source` 与 `text` 只替换变化块（复用现成 `EditRange` 脏区机制），但最小可行修复是先消除"无变化也重写"和"光标丢失"。

### M-03（Major）：文件夹批量替换后刷新打开标签

**根因**：`replace_in_folder` 改磁盘，但前端不感知已打开文件的内容变化。

**方案**：替换完成后，对 `tabs` 中路径命中且 `currentPath` 匹配的标签，重新读取磁盘内容并 `applyTabState`；替换前若标签 dirty 则先提示保存，避免覆盖未保存编辑。

### M-01（Major）：删除改为进回收站 / 二次确认 + 备份

**方案**：`delete_path` 增加 `trash` 优先（Tauri 有 `tauri-plugin-trash` 或 `std::process` 调系统回收站）；至少对文件夹删除在 Rust 层强制二次确认参数。或前端删除前生成 `.bak` 备份到临时目录。

---

## 6. P6 测试验证策略

- **单元测试（Vitest）**
  - `accumulateEdit` 脏区合并：构造跨脏区前/后/重叠三类编辑序列，断言 `(from,to,insert)` 不变量（对应 m-02）。
  - `setOrderedList`/`renumberBlock`：混合列表、嵌套列表、空行夹杂用例（对应 m-01）。
  - `normalizeAccel`/`matchAccel`：符号键归一（`Alt+\` 无需 Shift）边界（settings.ts 已有基础，补符号键）。
- **安全验证（手动/半自动）**
  - 构造含 `<script>alert(1)</script>`、`<img src=x onerror=alert(1)>`、`<iframe src="javascript:...">` 的 .md，打开后断言**脚本不执行**（C-01 验收）。
  - 在预览编辑模式粘贴上述 HTML 并保存，重新打开断言不执行（M-04）。
- **数据一致性回归**
  - 打开文件 A → 文件夹批量替换含 A → 断言编辑器内容与磁盘一致、未丢失未保存编辑（M-03）。
  - 进入/退出预览编辑 N 次 → 断言 markdown 内容与进入前逐字节一致（M-02）。
  - 删除含子文件的文件夹 → 断言可恢复（M-01）。
- **手工回归用例 TC-001..N**
  - TC-001 双击 .md 直接打开（不弹首页）
  - TC-002 底部插入表格/图片后光标与滚动跟随
  - TC-003 预览编辑模式全选不跳出
  - TC-004 编辑/预览编辑/预览开关切换稳定
  - TC-005 关闭窗口含未保存 → 确认对话框
- **验收标准 DoD**：C-01/M-01/M-02/M-03 全部修复并通过对应回归用例；`tsc --noEmit` 与 `vite build` 通过；构建仍可用 `NODE_OPTIONS="" npm run tauri:build`。

---

## 7. P7 总结与回顾

### 优化前后对比

| 维度 | 优化前 | 优化后目标 |
|---|---|---|
| 安全 | 打开恶意 .md 可 RCE | 脚本注入被 DOMPurify 拦截 |
| 删除安全 | 永久不可恢复 | 可恢复（回收站/备份） |
| 预览编辑保真 | 每次退出重写整篇 | 增量/无变化跳过，光标保留 |
| 批量替换一致性 | 可能覆盖打开标签 | 命中标签自动刷新 |

### 遗留问题 / 技术债
- 预览编辑的 HTML↔markdown 往返本质是"有损格式转换"，长期应改用结构化中间表示而非 DOM 往返（M-02 根治方向）。
- `html:true` 能力若保留，需建立"允许 HTML 子集"白名单并纳入测试（C-01/M-04 长期维护）。
- 类型安全：`any` 集中在 markdown-it 渲染规则，建议补 `@types/markdown-it` 严格模式。

### 工作量与排期
- **迭代 1（安全+数据，约 3 人天）**：C-01、M-01、M-02、M-03、M-04。
- **迭代 2（稳健性+UX，约 2–3 人天）**：m-01/m-02 补测试、m-04 类型、m-07/m-08 加固、UX-1/UX-2 提示优化。

---

> 注：本报告基于 v1.1.0 源码静态分析，未执行运行时模糊测试；触发条件均依据代码路径推演，建议以 P6 测试用例落地验证。
