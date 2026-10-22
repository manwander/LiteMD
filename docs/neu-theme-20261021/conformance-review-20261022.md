# LiteMD × litemd-product-v1 方案符合度审查报告

> 审查日期：2026-10-22
> 依据文档：`docs/neu-theme-20261021/litemd-product-v1.html`（设计方案 v1.0/v1.1）+ `EXECUTION-SPEC.md` v1.1
> 审查方法：方案逐条规格 ↔ 当前源码（src/ 提交 f999fb4）逐项比对，含 grep 实证
> 审查范围：UI 界面 / 互动逻辑 / 功能模块 / 菜单结构 四维度

---

## 0. 总览结论

| 维度 | 符合度 | 一句话结论 |
|---|---|---|
| UI 界面（素塑主题） | ★★★★☆ ~90% | 令牌/暗色补偿/低端降级/CM6 特例/图标主色全部落地；Toast 位置、预览正文卡 L2、空态族有遗留 |
| 互动逻辑 | ★★★★☆ ~82% | 面板/视图切换/四层右键/导出收敛全通；任务点击回写、@ 大纲源、8 个 action 无 handler |
| 功能模块 | ★★★★☆ ~78% | 渲染管线三插件与大纲/导出全通；打印、检查更新、打字机、状态栏扩展缺失 |
| 菜单结构 | ★★★★★ ~92% | 8 组菜单 + 注册表单一数据源 + 四层右键全部成型；仅个别条目有入口无执行体 |

**整体符合度：约 82–85%。** MVP 通道（B1–B4）完成度高（~90%），完整通道（B5–B7）中渲染补强与导出收敛已落地，但**打印 / 检查更新 / 任务列表点击回写 / 新窗口·置顶**四个方案明文能力仍未实现——当前状态是「入口已占位、能力未接线」。

---

## 1. 维度一：UI 界面（卷 2 素塑主题 + 卷 3 原型表面）

### 1.1 已完整实现 ✅

| 方案条目 | 规格 | 实证 |
|---|---|---|
| B1 令牌层（§10/附录A） | 素塑亮/暗全量令牌原值搬移，旧色板退役 | style.css `:root` 含 --bg #F2F4F7 / --sd / --sl / --t1..t3 / --p #6A5FD8 / --pt→--pb / --ps / --ok/--warn/--err / --div / --div-nav / --srf / --tint / --hov 及 --rs/--rs-s/--rs-l/--is/--is-s 五档阴影；暗色块 #262A31 系逐值一致 |
| 语法高亮 8 色（§13） | 按 #F2F4F7 底调校，comment 提亮 | --hl-keyword #A626A4 … --hl-comment #B4B9C6（提亮值与 §1.5 一致） |
| 遮罩两档（LM-18/26，D-2 裁决） | .26 弹窗 / .5 致命 | `--mask: rgba(20,22,28,.26)` / `--mask-heavy: … .5` 已令牌化并集中登记 |
| 暗色补偿四组（§12） | 白辉 / 白描边 / 导航线提亮 / 选中描边 | --srf 白描边用于浮层（style.css 223/762/843/889 等处）、--div-nav #4B5361、--ps 选中描边齐备 |
| 低端降级（LM-27，C-8） | 双选择器阴影降档、染色保留 | `:root[data-lowend], body.low-end` 双选择器落地（B1 裁决形态） |
| CM6 特例（§13，LM-07） | gutter 分栏、选中行 tint+左2px 竖条、暗色导航线 | editor.ts L166-179：`.cm-gutters` bg+borderRight div（暗色 div-nav）、`.cm-activeLine` tint + `inset 2px 0 0 var(--p)` |
| B6 组件换肤 | 白面清零 / 阴影令牌化 / 选中内嵌 / 圆角收口 | d3b094f 提交落地；b6-audit.md 的 57 项问题清单已按批次执行 |
| 品牌字主色（§14，C-1） | .brand 渐变 #7A6EE0→#5B4FD0 | style.css L146 `linear-gradient(135deg, var(--pt), var(--pb))` |
| 应用图标主色（C-1） | 盘内字/光晕改主色渐变 | icon-design.svg L13-14/42 均为 #7A6EE0→#5B4FD0 |
| LM-22 预览编辑块态 | 激活块 is-s + 左竖条、hover 叠色 | cc1d6bf 提交（块级直改契约 + 表面） |
| 旧 .menu-list 裁撤（R3） | B2 内删除而非并存 | style.css 已 grep 不到 .menu-list |
| LM-03 工具栏四段 | 历史｜插入｜格式｜模式 + 右对齐 modeseg | Toolbar.svelte 四段结构 + `.modeseg` 三态分段控件 |

### 1.2 部分实现 / 存在偏差 ⚠️

| 方案条目 | 方案规格 | 实际状态 |
|---|---|---|
| LM-17 Toast | 右下角 right:14 bottom:38 堆叠；四态（成功/警告/错误/信息）；错误常驻 | 位置仍为**顶部居中 top:14px**；类型仅 success/error/info **三态（缺 warn）** |
| LM-11 专注模式 | 补状态栏「再按 F8 退出」提示 + 160ms 过渡 | toggleFocus 本体已有；状态栏提示文案未见，过渡为常规 0.15s |
| LM-10 侧栏「搜索」tab | 文档内查找替换面板**停靠化**（Ctrl+F 仍可浮层） | 第三 tab 实为「文件夹查找替换」入口提示 + 按钮，**非文档内查找停靠** |
| LM-02 菜单键盘交互 | 全键盘导航（←→↑↓ Enter Esc） | MenuBar 具备基础键盘通路，逐项走查（22.1 B2 验收序列）未见归档记录 |

### 1.3 完全缺失 ❌

| 方案条目 | 方案规格 | 状态 |
|---|---|---|
| LM-21 预览正文卡 L2 | 「唯一大面积凸起卡」r14 + rs | 预览仍 L0 直出无卡面（b6-audit D-7 遗留，未做结构改动） |
| LM-25 空态族 | 空目录 / 空大纲 / 空搜索三态 EmptyState 原子 | 仅大纲空态「暂无标题」落地（OutlinePanel ol-empty）；空目录、空搜索未见 |
| settings.newUI 回滚开关 | 每个新界面功能留开关兜底 | 全 src 无 newUI 字段 |

---

## 2. 维度二：互动逻辑（卷 1 §05–§09 + 原型行为）

### 2.1 已完整实现 ✅

- **命令面板（§07/LM-13）**：Ctrl+P 开合（App.svelte 4328-4331）；command-palette.ts 三类源（命令/文件/设置）+ fuzzy + 分组上限 6/5/4 + 组序 command→file→setting；Esc 关闭焦点回编辑器（onClose → view.focus()）
- **视图模式单一状态机（K6/LM-08）**：viewMode live/source/split 派生（App.svelte 2693-2697）；Ctrl+1/2/3（4333-4337）；工具栏 modeseg 联动
- **Alt 菜单栏显隐**（4323-4327）+ 命令面板兜底，P0-4 双控制源问题已消除
- **四层右键（§06）**：文件树（注册表化）/ 编辑器 openEditorCtx（4735）/ 标签 ctx（4676，关闭/关闭其他/关闭全部/复制路径/在侧栏定位）/ 预览 openPreviewCtx（4764）——B5 提交 626891a 落地
- **统一动作分发（§05）**：action-dispatch.ts runAction 查表 + 未注册 console.warn；菜单栏/工具栏/命令面板/右键四个消费方同源
- **大纲（§08/LM-09）**：outline.ts 纯函数 + 单测；OutlinePanel 当前章节高亮（activeLine）+ 点击跳行 jumpToLine；随光标刷新
- **导出收敛（LM-23，P0-5）**：ExportDialog 四格式单一入口（1362321）；设置-导出 tab 折叠为「打开导出对话框」（8617ecf）；file.export/exportPdf 均 openExportDialog
- **Mermaid 占位（C-6）**：```mermaid 围栏 → data-src（URI 编码防 mXSS）灰现占位
- **KaTeX 懒加载（C-5）**：needsMath 按需动态 import，独立 chunk 不进主包
- **旧工具动作归位（P0-5）**：迁移图片/批量迁移/清理附件已入「工具」组（settings.ts 286-289 + handler 2807-2809）

### 2.2 部分实现 / 存在偏差 ⚠️

| 条目 | 方案规格 | 实际状态 |
|---|---|---|
| Ctrl+P 快捷键归属 | 经注册表 accel（可改键） | **硬编码**在全局 keymap（`e.code === "KeyP"`），未走 settings.shortcuts，不可改键 |
| 命令面板三类源 | 命令 / 文件 / 设置 + **@ 跳大纲标题** | 三类源齐备；`@` 大纲标题源未实现 |
| 注册表驱动设置页（§05） | 设置-快捷键页改注册表驱动、改键即四处生效 | 快捷键页仍走既有 SHORTCUT_GROUPS 渲染，未完全切到 MENU_TREE 同源 |

### 2.3 完全缺失 ❌

| 条目 | 方案规格 | 状态 |
|---|---|---|
| C-4 任务列表点击回写 | 预览复选框点击回写 [ ]↔[x]（走 applyExternalEdit） | checkbox 输出为 `disabled` 纯渲染（md-pipeline/block-splitter），**无点击回写通道** |
| 有菜单项无 handler 的 8 个 action | 点下去必须有反应（§20-B2 验收「无 TODO 桩」） | `file.print`（打印）、`file.exit`（退出）、`help.docs`（F1 使用文档）、`help.checkUpdate`（检查更新）、`view.typewriter`（F9 打字机）、`win.newWindow`（新窗口）、`win.newTab`（新建标签）、`win.alwaysOnTop`（置顶）——**入口已渲染，点击仅 console.warn** |

---

## 3. 维度三：功能模块

### 3.1 已完整实现 ✅

| 模块 | 实证 |
|---|---|
| 全部保存 saveAll（P0 文件菜单项） | handler 2728 |
| 最近打开 + 清除列表 | file.clearRecent handler 2734（菜单内清除入口有） |
| 插入组扩充（公式/任务列表/目录/日期时间/水平线） | insert.math/datetime/hr/toc/task handler 2783-2787 |
| 窗口组部分能力 | win.closeTab/closeOthers/closeAllTabs/minimize/toggleMax/close 全有 handler（2818-2826） |
| 渲染管线三插件（LM-12） | md-pipeline.ts：task-lists + KaTeX + Mermaid 占位，全动态 import |
| sanitize 白名单放行（R6） | input[type=checkbox][disabled] 受控放行，XSS 用例保留 |
| 单测扩容（B7） | __tests__ 24 → **29 个文件**，新增 menu-registry / command-palette / outline 单测 |
| 统一导出对话框 | ExportDialog.svelte + 路径原生分隔符修复 |

### 3.2 部分实现 / 存在偏差 ⚠️

| 条目 | 方案规格 | 实际状态 |
|---|---|---|
| P2-1 最近文件条数 | 5 → 15 条 | settings.ts:680 仍 `slice(0, 5)` |
| LM-20 关于与检查更新 | 帮助菜单直达独立关于弹窗 + checkUpdate（GitHub Releases API）+ 失败态 | help.about 仅打开设置弹窗（非独立弹窗）；checkUpdate 前后端均未实现 |
| B7 回归验收 | E2E 亮/暗双跑 + bundle 增量核对归档 | 测试扩容已做；E2E 双主题跑与 bundle 增量报告未见归档（docs/neu-theme-20261021/shots/ 无产物） |

### 3.3 完全缺失 ❌

| 条目 | 优先级 | 状态 |
|---|---|---|
| 打印双入口（LM-24，C-7） | P1-4 | webview.print 与「打印为 PDF」均未实现，fs.ts 无 print |
| 检查更新（P1-5） | P1 | 前后端均无 |
| 打字机模式（P2-3） | P1/P2 | 注册未实现 |
| 新窗口 / 置顶（P1-5 窗口管理） | P1 | 无 handler，Tauri WebviewWindow / set_always_on_top 未接 |
| 退出菜单项 | P0 表内条目 | 无 handler |
| 状态栏段落/阅读时长（P2-2） | P2 | StatusBar 仅「N 字 · N 字符」 |
| 拼写检查 / 中西文混排（P2-4） | P2 | 未做（符合 P2 排期预期） |
| 自定义主题 CSS（P2-5） | P2 | 未做（符合 P2 排期预期） |
| Word/Epub/LaTeX 导出 | P2（本期不做） | 未做（**符合方案范围**，不计缺陷） |

---

## 4. 维度四：菜单结构（卷 1 §04–§06）

### 4.1 已完整实现 ✅

| 方案条目 | 实证 |
|---|---|
| 菜单栏 8 组全量（file/edit/view/insert/format/tools/window/help） | settings.ts SHORTCUT_GROUPS 扩展出 8 组 action 定义；menu-registry.ts 派生 MENU_TREE |
| 单一数据源（§05，P0-5 根治） | ActionDef 扩展 group/order/accel/icon/surfaces/ctx 六字段（K2 骨架按方案落地）；菜单栏/工具栏/命令面板/右键四消费方只读注册表 |
| MenuBar.svelte（K3） | 8 根菜单 + 悬停/点击展开 + 键盘导航 + Alt 整栏隐藏 |
| 快捷键冲突检测（R4） | menu-registry.test.ts 断言冲突列表为空 |
| 四层右键 ctx 字段过滤（§06） | ActionDef.ctx: editor/tree/tab/preview 四套上下文集，条目与 §06 表一致 |
| 旧 .menu（仅文件组）删除（R3） | 已删，无双菜单并存 |
| 文件组条目 | 新建笔记/文件夹、打开文件/文件夹、保存/另存为/全部保存、导出→对话框、退出（入口） |
| 工具组归位 | 字数统计/迁移图片/批量迁移/清理附件/设置/快捷键 |
| 帮助组条目 | 使用文档/快捷键速查/检查更新/关于（入口齐，部分无 handler） |

### 4.2 部分实现 / 存在偏差 ⚠️

| 条目 | 方案规格 | 实际状态 |
|---|---|---|
| 窗口组 | 新窗口/新建标签/置顶三项核心条目可用 | 条目已渲染，**三项均无 handler**；仅关闭/最小化/最大化五项可用 |
| 外观子菜单 | 素塑亮/暗/跟随系统三选 | theme light/dark/auto 设置已有（原能力保持），菜单入口形态待 UI 确认 |

### 4.3 完全缺失 ❌

- 无结构性缺失——8 组骨架、注册表、四层右键、菜单栏显隐均已成型。缺失集中在「条目 → 执行体」的最后一公里（同 §2.3 的 8 个 action）。

---

## 5. 批次符合度（对照卷 5 B1–B7）

| 批次 | 方案验收判据 | 实际状态 | 符合度 |
|---|---|---|---|
| B1 令牌层 | 旧令牌 grep=0；vitest 绿；亮暗目检 | 已完成（d96a4f0），296 处引用切换，含遮罩令牌与低端降级 | ✅ 100% |
| B2 注册表+菜单栏 | 八组全条目可点；App.svelte 净减 ≥150；无 TODO 桩 | 762ce41 落地；**8 个 action 无 handler**（违反「无 TODO 桩」判据）；App.svelte 行数减幅未核 | ⚠️ ~90% |
| B3 命令面板 | Ctrl+P 三源；单测覆盖 | 已完成；@ 大纲源缺、Ctrl+P 未注册表化 | ⚠️ ~90% |
| B4 大纲+视图模式 | 100KB <2ms；跳行 ≤1；三态切换不丢内容 | 已完成，outline 单测含性能用例 | ✅ ~95% |
| B5 渲染+右键+导出 | 回写正确；公式渲染；四入口同一对话框 | 公式/占位/右键/导出收敛✅；**打印✗ 检查更新✗ 任务回写✗** | ⚠️ ~75% |
| B6 换肤+图标 | LM-18…27 逐帧比对；图标全套主色 | d3b094f + c716ad4（含验证截图）；Toast 位置、正文卡 L2、空态族遗留 | ⚠️ ~90% |
| B7 回归 | 全绿 + E2E 亮暗双跑 + bundle 核对 | 29 测试文件；E2E/bundle 归档未见；newUI 开关缺 | ⚠️ ~70% |

> 注：git tag 仅 v1.0.0…v2.0.0，方案的 b1…b7 批次 tag 未打，回滚粒度靠 commit 边界（与方案 22.2 有偏差，但不影响功能）。

---

## 6. 总体结论

1. **整体符合度约 82–85%**。方案的两大主线中：素塑主题（卷 2/卷 3 表面）已基本完全体；功能菜单体系（卷 1）骨架 100% 成型，但存在「最后一公里」缺口。
2. **最大的系统性偏差是 8 个「有菜单项无执行体」的 action**（打印/退出/使用文档/检查更新/打字机/新窗口/新建标签/置顶）——这正是方案 §20-B2 验收判据「无 TODO 桩」明令禁止的状态，也是当前距离「可发布产品形态」最近的一批缺口。
3. **P1 级功能缺口 4 项**：打印双入口（LM-24）、检查更新（LM-20）、窗口管理（新窗口/置顶）、任务列表点击回写（C-4）。
4. **UI 遗留 4 项**：Toast 右下角位置与四态、预览正文卡 L2、空态族（空目录/空搜索）、专注模式状态栏提示与 160ms 过渡。
5. **P2 项未做属方案排期预期**（拼写检查/自定义 CSS/Word 导出等），不计入缺陷。
6. 建议下一步：优先接线 8 个 handler（其中 5 个是纯前端即可完成的：退出/打字机/新建标签等），随后补打印与检查更新（需 Rust 侧配合），最后补 UI 遗留四项并归档 B7 E2E 亮暗双跑证据。

---

*审查证据均来自 src/ 当前工作区（HEAD f999fb4），关键行号已在正文标注，可复核。*
