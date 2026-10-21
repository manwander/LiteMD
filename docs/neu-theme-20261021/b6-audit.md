# B6 预审 · style.css 组件区深度归位审计报告

> **性质**：只读审计（read-only audit）。本报告不改任何 src/ 文件，仅产出整改清单。
> **审计人**：software-engineer（寇豆码）
> **回传对象**：team-lead

---

## 0. 审计时点与快照

| 项 | 值 |
|---|---|
| style.css 快照 | b1 提交基线 + 文件末尾 160 行 mb- 追加（E1 我方所写），**共 2087 行** |
| 在飞变更 | team-lead 的 App.svelte 集成已落盘（+473 行，含 `sb-tabs`/`sb-search` 等新类名），但 **sb-/tb- 的 CSS 尚未写回 style.css**——这些类目前无样式，落地时须按本报告 L1/L3 规则执行 |
| 不在审计范围 | E1 mb- 段（L1928-2087，我方自写已合规）；E2 cp-（CommandPalette.svelte，engineer-palette）；E3 ol-（OutlinePanel.svelte，engineer-outline） |
| 触碰范围说明 | `editor.ts` CM6 主题（liteTheme/darkPatch）属 B6 明文触碰对象（§13），列入审计 |

**审计依据**：设计文档卷 2（§10 令牌移植 / §11 L0–L4 阶梯 / §12 暗色补偿四组 / §13 CM6 特例 / §14 图标联动）+ 卷 3 分册参数表（LM-05/06/17/18/19/21/22/26）+ EXECUTION-SPEC v1.1。

**三铁律判据**（设计文档 §00 原文）：
1. **表面=背景**——卡片/面板/弹窗底色一律 `--bg`(#F2F4F7)，层级只靠光影，禁止给卡片填不同底色；
2. **光源恒定**——双向阴影恒「右下暗 + 左上亮」45°，任何状态不反转；
3. **渐变受限**——紫色渐变仅用于主按钮与徽标；**选中态用内嵌（凹）而非染色**。

> 注：style.css 头注把铁律③展开为「tint 12% + 左 2px `--p` 竖条」，那是 §13 CM6 / LM-22 预览编辑的**原生机制近似**（C-3 方案）；CSS 原生组件的选中语言以设计稿为准 = `box-shadow: var(--is-s)` + primary 字色（暗色加 `--ps` 1px 描边）。两者不矛盾，但**不可混用**——本报告按组件上下文分别判定。

---

## 1. 总览统计

| # | 组件 | 问题数 | 必改 | 待裁决 | 改动量估计（行） | 主要违反 |
|---|---|---|---|---|---|---|
| A | 壳层（titlebar/brand/color-pop/wc-close） | 4 | 3 | 1 | ~7 | 铁律①、令牌纪律 |
| B | 侧栏 / 文件树 | 11 | 11 | 0 | ~30 | 铁律①③、悬停语言 |
| C | 编辑器 CM6 + 搜索面板 | 6 | 5 | 1 | ~14 | 令牌纪律（旧绿残留）、§13 |
| D | 快捷菜单 / 右键菜单 | 6 | 6 | 0 | ~16 | 铁律①②③ |
| E | 预览 / 预览编辑 | 6 | 4 | 2 | ~20 | 铁律①③、LM-21/22 缺位 |
| F | 标签栏 | 8 | 8 | 0 | ~18 | 铁律①③、LM-05 |
| G | 状态栏 | 3 | 3 | 0 | ~5 | 铁律①、令牌纪律 |
| H | 弹窗族（Confirm/Prompt/FolderSearch/Settings/hm/kg/fatal） | 7 | 7 | 0 | ~60 | 圆角、铁律①②、遮罩 |
| I | Toast | 1 | 1 | 0 | ~7 | 位置（LM-17）、铁律①② |
| J | 旧文件菜单 `.menu` | 1 | 1 | 0 | 删除 67 行 | 随 E1 集成裁撤 |
| K | 加载遮罩 `.loading-*` | 1 | 1 | 0 | ~4 | 令牌纪律（fallback） |
| L | 通用 `button` 基线 | 1 | 1 | 0 | ~10 | 铁律①③、圆角 |
| M | 滚动条 / 杂项 | 2 | 1 | 1 | ~6 | 令牌纪律 |
| | **合计** | **57** | **52** | **5** | **~220** | |

---

## 2. 分组件整改清单

### A. 壳层

| 选择器 | 现状（值/档位） | 目标（值/档位） | 违反的铁律 | 改动量 |
|---|---|---|---|---|
| `.titlebar`（L123-136） | `background: var(--sl)`（白面）；`border-bottom: 1px solid var(--div)` | L1 同色：`var(--bg)`；导航线提亮：`var(--div-nav)`（§12③，与 mb- 段 `.menubar` 一致） | 铁律①（白面残留） | 2 行 |
| `.brand`（L138-144） | `linear-gradient(135deg, #6e7bff, #2324a8)` 旧靛蓝 | `linear-gradient(135deg, var(--pt), var(--pb))`（§14 明文 #7A6EE0→#5B4FD0；E4 图标侧已改，CSS 侧归 B6） | 令牌纪律（旧色板硬编码） | 1 行 |
| `.color-pop`（L184-231，tb- 归属） | `border: 1px solid var(--sd)`；`r8`；`box-shadow: 0 8px 24px rgba(0,0,0,.18)`；swatch/input r4 | L4：`var(--rs-l)`；r12（LM-02 菜单族）；亮色去描边、暗色白描边；swatch/input r9 | 铁律②（硬编码单光源阴影） | 5 行 |
| `.wc-close:hover`（L262-270） | `#e81123` / 暗色 `#c01020` | 二选一：保留平台红（Windows 惯例，登记为例外）或换 `var(--err)` | 令牌纪律（硬编码） | 0–2 行（待裁决 D-5） |

### B. 侧栏 / 文件树（FileTree.svelte 无 scoped 样式，全部在 style.css）

| 选择器 | 现状（值/档位） | 目标（值/档位） | 违反的铁律 | 改动量 |
|---|---|---|---|---|
| `.sidebar`（L356-364） | `background: var(--sl)`；`border-right: 1px solid var(--div)` | `var(--bg)`（L1 同色）；`var(--div-nav)` | 铁律① | 2 行 |
| `.sidebar li`（L377-389） | 每行 `border-bottom: 1px solid var(--div)`；r4 | 撤行分隔线（设计 `.trow` 无行线，靠 hov/间距分层）；r9 | 设计偏差（行线噪声） | 2 行 |
| `.sidebar li.folder.root`（L431-442） | `--tint` + 左 2px `--p` 竖条（与铁律③内嵌语义一致，**可作树行选中范本**）；hover 用 `filter: brightness(0.97)` | 保留竖条语言；hover 换 `var(--hov)`；圆角 `0 4px 4px 0` 收尾 | hover 手法不令牌化（轻） | 2 行 |
| `.sidebar li.selected`（L453-455） | 仅 `background: var(--tint)`（纯染色，无内嵌） | `box-shadow: var(--is-s); color: var(--p); font-weight: 600`；暗色补 `border: 1px solid var(--ps)`（§12④） | 铁律③（选中应内嵌非染色） | 3 行 |
| `.sidebar li.file.active`（L511-514） | `background: var(--tint); color: var(--p)` | 同上（is-s + primary + 600 + 暗色 ps 描边） | 铁律③ | 2 行 |
| `.sidebar li.folder:hover` / `.sidebar li.file:hover`（L507-509 / L1167-1169） | `background: var(--tint)`（悬停即染色） | `background: var(--hov)`（设计 `.trow:hover`；悬停≠选中） | 铁律③派生（悬停/选中语言不分） | 2 行 |
| `.rename-input`（L541-551） | `border: 1px solid var(--p)`；r4；`background: var(--tint)` | 输入框规范：`box-shadow: var(--is-s)` 凹底 + 聚焦 1.5px `--p` 描边；r9 | 输入框形态不归位 | 3 行 |
| `.tree-filter input`（L1118-1132） | `border: 1px solid var(--sd)`；r6；`background: var(--tint)`；focus 仅 border-color | `box-shadow: var(--is-s)` + 聚焦 1.5px `--p`；r9-11 | 输入框形态不归位 | 3 行 |
| `.crumb:hover` / `.ts-btn:hover` / `.tree-filter-clear:hover` / `.sort-item:hover` / `.empty-btn:hover`（L631/L677/L1143/L730/L602） | 均 `background: var(--tint)` | 均 `var(--hov)`（悬停叠色与选中区分） | 悬停语言不统一 | 5 行（批量机械化） |
| `.sort-pop`（L706-719，排序菜单浮层） | `background: var(--sl)`；`1px solid var(--sd)`；r8；`box-shadow: 0 4px 16px rgba(0,0,0,.15)` | L4：`var(--bg)` + `var(--rs-l)` + r12；亮色无边、暗色白描边 | 铁律①② | 4 行 |
| `.ts-btn.on` / `.tree-sort-btn:hover,.on`（L680-705） | `border-color: var(--p); color: var(--p)` | 选中改 `is-s` 内嵌 + primary（与侧栏 tab 同语言） | 铁律③ | 4 行 |

### C. 编辑器 CM6（editor.ts）+ 搜索面板（style.css）

| 选择器 | 现状（值/档位） | 目标（值/档位） | 违反的铁律 | 改动量 |
|---|---|---|---|---|
| `.cm-activeLine`（editor.ts L167） | `backgroundColor: "rgba(15,110,86,0.06)"` —— **旧绿色板 #0f6e56 残留，B1 漏网** | §13：`var(--tint)` + 左 2px primary 竖条近似（`box-shadow: inset 2px 0 0 var(--p)`，设计 `.cl.sel` 同款） | 令牌纪律（旧色板）；§13 未落地 | 2 行 |
| `.cm-gutters`（editor.ts L166） | `backgroundColor: "transparent"; border: "none"` | §13：`backgroundColor: var(--bg)` + 右边框 divider；暗色 divider 走 `--div-nav`（§12③，需 dark 侧覆盖） | §13 gutter 分栏缺失 | 3 行 |
| `.cm-cursor` / 选区（editor.ts L171 + liteSetup） | cursor `var(--p)` ✓；选区无显式 theme | §13：选区 primary 12%（=`--tint`）显式声明（可选优化） | 缺口（轻） | 0–1 行 |
| `.cm-search-panel`（L1359-1367） | `background: var(--sl)` | 同色 `var(--bg)` + 1px div 分栏 ✓（border-bottom 已是 div） | 铁律① | 1 行 |
| `.cm-search-input`（L1378-1392）/ `.cm-search-btns button`（L1418-1427） | input `1px var(--sd)` 边 + r4 + `var(--bg)` 底；btn `1px var(--sd)` + r4 + `var(--bg)` 底 | input `is-s` + 聚焦 1.5px p + r9；btn r9-12 + rs-s；主钮（`.cm-search-btn-main`）可上 `--pt→--pb` 渐变（§10 渐变仅主按钮——搜索主钮是否算，见疑点 D-11） | 输入框形态；圆角 | 6 行 |
| `.cm-quick-btn:hover`（L776-780） | `background: var(--sl); color: var(--p)` | `var(--hov)` 或 is-s + p（L3 小控件） | 铁律① | 1 行 |

### D. 快捷菜单 / 右键菜单（L4 浮层）

| 选择器 | 现状（值/档位） | 目标（值/档位） | 违反的铁律 | 改动量 |
|---|---|---|---|---|
| `.quick-menu`（L788-797） | `var(--sl)`；`1px solid var(--sd)`；r8；`box-shadow: 0 6px 24px rgba(0,0,0,.28)` | `var(--bg)` + `var(--rs-l)` + r12（LM-02）；亮色无边、暗色白描边（§12②） | 铁律①② | 4 行 |
| `.quick-item:hover`（L807-810） | `background: var(--p); color: #fff`（整行主色底） | `background: var(--tint); color: var(--p)`（设计 `.menu .mi:hover`） | 铁律③派生（悬停用染色主色） | 2 行 |
| `.ctx-menu`（L834-844） | 同 `.quick-menu`（sl + sd 边 + r8 + 硬编码阴影） | 同 `.quick-menu`（r12 + rs-l + bg） | 铁律①② | 4 行 |
| `.ctx-item:hover`（L868-871） | `background: var(--p); color: #fff` | tint + p | 铁律③派生 | 2 行 |
| `.ctx-item.danger` / `.danger:hover`（L872-878） | `color: #e57373`；hover `#d32f2f` + 白字 | `color: var(--err)`；hover `var(--err)` 底白字（设计 `.mi.dg`） | 令牌纪律（硬编码红） | 2 行 |
| `.quick-sep` / `.ctx-sep`（L822/L879） | `var(--div)` ✓；margin 4,6 | margin 5,6（LM-02，与 mb-sep 统一） | 参数不齐（轻） | 2 行 |

### E. 预览 / 预览编辑（LM-21/22）

| 选择器 | 现状（值/档位） | 目标（值/档位） | 违反的铁律 | 改动量 |
|---|---|---|---|---|
| `.preview-content pre`（L916-922）/ `.preview-edit pre`（L1485-1491） | `background: var(--sl)`；`1px solid var(--div)` 边；r6 | LM-21：`var(--bg)` + `box-shadow: var(--is-s)` + **去描边** + r10 | 铁律①（sl 面）；误用描边表达内嵌 | 4 行 ×2 处 |
| `.preview-content code`（L923-929） | `background: var(--tint)`；r4 | LM-21：`var(--bg)` + `is-s` 凹底 + r6（tint 是选中语言，不是 code 语言） | 铁律③派生 | 3 行 |
| `.preview-edit code`（L1492-1495） | 无背景（继承容器） | 同 LM-21 code：is-s + r6（补齐） | LM-21 缺位 | 3 行 |
| `.preview-content th` / `tbody tr:nth-child(even)`（L949-961） | `th { background: var(--sl) }`；斑马纹 `var(--sl)` | 表头同色 `var(--bg)`（设计 `.pv th`）；斑马纹撤除或改 `--hov` | 铁律① | 3 行 |
| `.preview-edit` 容器（L1443-1459）/ `.vblock`（VirtualPreview.svelte L487-490） | 容器 `var(--bg)` ✓ L0 直出；**块 hover/active 无任何样式** | LM-22：块 hover `var(--hov)`（r8 · padding 2,6 · 外扩 -6）；块激活 `is-s` + 左 2px `--p`。需组件层给块加类（类名契约见疑点 D-8） | LM-22 未落地（新增） | 新增 ~10 行 |
| `.virtual-preview`（VirtualPreview.svelte L473-486） | padding 16,24 · 行高 1.7 · 无卡面 | LM-21：**正文卡 L2**（r14 + `var(--rs)` 同色凸起）——「预览正文卡是唯一大面积 L2 面」。需在容器内包一层卡（结构改动，见疑点 D-7） | L2 缺位（结构） | 10–20 行（待裁决） |

### F. 标签栏（LM-05）

| 选择器 | 现状（值/档位） | 目标（值/档位） | 违反的铁律 | 改动量 |
|---|---|---|---|---|
| `.tabbar`（L1212-1221） | `var(--bg)` ✓；`border-bottom: 1px solid var(--div)` | `var(--div-nav)`（§12③） | §12③ 缺位 | 1 行 |
| `.tab`（L1273-1291） | `background: var(--sl)`；`1px solid var(--sd)` 边；h30；max-w 200 | 无底（设计 tab 透明）；去描边；h27；padding 0,9；max-w 170；r8 上圆 ✓ | 铁律①（sl 面） | 4 行 |
| `.tab:hover`（L1293-1296） | `background: var(--sl)` | `var(--hov)`（LM-05 悬停叠色零位移） | 铁律① | 1 行 |
| `.tab.active`（L1298-1302） | `color: var(--p); background: var(--tint); border-color: var(--p)`（tint 染色 pill） | LM-05：`box-shadow: var(--is-s); color: var(--p); font-weight: 600`；暗色 `border: 1px solid var(--ps)`（§12④） | 铁律③（激活应内嵌） | 3 行 |
| `.tab-dot`（L1311-1315） | `color: var(--p); font-size: 9px`（主色文字点） | LM-05：6px `--warn` 圆点（脏=警示橙，避免与「选中=紫」混淆）。元素形态需与 App 层协调（现为文字圆点还是 span） | LM-05 脏点语义 | 2–3 行 |
| `.tab-close:hover` / `.tab.active .tab-close:hover`（L1332-1340） | `var(--div)` 底 / `var(--p)` 底白字 | LM-05：`var(--err)` 底白字；x 14×14 r5（现 18×18 r4） | LM-05 关闭钮语义 | 3 行 |
| `.tab-act:hover` / `.tab-act.on`（L1259-1267） | hover `var(--sl)`；on `--tint` + p | hover `--hov`；on is-s + p（L3 选中语言） | 铁律①③ | 3 行 |
| `.filename .dirty`（L1177-1181） | `color: var(--p)` | 同 tab-dot：换 `--warn` 语义 | LM-05 脏点语义 | 1 行 |

### G. 状态栏（LM-06）

| 选择器 | 现状（值/档位） | 目标（值/档位） | 违反的铁律 | 改动量 |
|---|---|---|---|---|
| `.statusbar`（L1184-1194） | `background: var(--sl)`；`border-top: 1px solid var(--div)`；h26 ✓ | L1 同色 `var(--bg)`；`var(--div-nav)`；gap 16→13（LM-06，微调） | 铁律① | 2 行 |
| `.sb-warn`（StatusBar.svelte L54-61） | `color: #b26a00; background: rgba(255,176,32,.14)` | `color: var(--warn)`；背景撤除或 tint 化（语义色只上文字） | 令牌纪律（旧橙硬编码） | 2 行 |
| `.sb-sync:hover`（StatusBar.svelte L69-72） | `background: var(--div)` | `var(--hov)` | 悬停语言 | 1 行 |

### H. 弹窗族（LM-18/19/23/26）

| 选择器 | 现状（值/档位） | 目标（值/档位） | 违反的铁律 | 改动量 |
|---|---|---|---|---|
| ConfirmModal `.cm-mask/.cm-dialog/.cm-btn/.cm-btn.danger`（ConfirmModal.svelte L54-119） | mask `rgba(0,0,0,.35)`；dialog r12 + `0 16px 48px rgba(0,0,0,.3)` + `1px var(--sd)` 边；btn h32 **r6** + `1px var(--sd)` + sl 底；danger `#d32f2f` 纯红底 | mask `rgba(20,22,28,.26)`；dialog **r16** + `var(--rs-l)`；btn r16：次 `rs-s` / 主 `--pt→--pb` 渐变 / 危险红渐变 `#E8574F→#D43F3A`（LM-18） | 圆角 8/12→16（C-8）；铁律②；令牌纪律 | 10 行 |
| PromptModal `.pm-mask/.pm-dialog/.pm-input/.pm-browse`（PromptModal.svelte L65-135） | mask .35；dialog r12 + 硬编码阴影 + sd 边；input `1px var(--sd)` + r6 + sl 底 | mask .26；r16 + rs-l；input `is-s` + 聚焦 1.5px p + r9-11（LM-18 新建笔记输入框：is-s · r11 · h34） | 圆角；铁律①②；输入框形态 | 9 行 |
| FolderSearch `.mask/.dialog/.bar input.q`（FolderSearch.svelte L203-280） | mask .35；dialog r14 + `0 16px 48px rgba(0,0,0,.3)` + sd 边；input r6 + sd 边 + sl 底 | mask .26；r16 + rs-l；input is-s + r9-11 | 同上 | 7 行 |
| SettingsModal `.mask/.dialog/nav/.nav-item/.pill/.text-input/.tag.ok/.tag.bad/.btn.danger/.warn-text`（SettingsModal.svelte L733-1083） | mask .35；dialog 900×640 + r14 + `0 20px 60px rgba(0,0,0,.28)`；nav `var(--sl)`；`.nav-item:hover` `var(--div)`；`.nav-item.active` `--tint`+p；`.pill` sl 底 + r6；`.text-input` sl + sd 边 + r6；`.warn-text` `#b26a00`；`.tag.ok` `#1a7f37`；`.tag.bad` `#c0392b`；`.btn.danger` `#c0392b` | mask .26；r16 + rs-l；nav `--bg` + 右 1px div；nav hover `--hov`、active `is-s + p + 600`；pill → LM-19 键帽语言（`rs-s` + 1px div + r6）；text-input is-s + 聚焦 1.5px p；warn-text `--warn`；tag.ok `--ok`；tag.bad `--err`；btn.danger `--err` 系。**尺寸 900×640 建议保持**（六 tab 内容需要，见疑点 D-6）。`.chip.on`（tint + 1px p 描边、无凸起）**已合规** ✓ | 铁律①②③；圆角；令牌纪律（4 处硬编码） | 18 行 |
| `.hm-mask/.hm-pop/.hm-row`（style.css L1523-1613） | mask .35；pop r12 + `0 16px 48px rgba(0,0,0,.3)` + sd 边；row `var(--sl)` + 1px div | mask .26；r16 + rs-l；row 同色 `--bg` + 1px div | 铁律①②；圆角 | 7 行 |
| `.kg-mask/.kg-dialog/kbd/.kg-close:hover`（style.css L1616-1727） | mask **.5**；dialog r14 + `0 20px 60px rgba(0,0,0,.35)` + sd 边；kbd sl 底 + 2px 底边 + r5；close hover `#ef4444` | mask **.26**（.5 是致命面级 LM-26）；r16 + rs-l；kbd → LM-19 键帽（`--bg` + `rs-s` + 1px div + r6）；close hover `--err` | 遮罩值不统一；铁律②；令牌纪律 | 7 行 |
| `.fatal-overlay/.fatal-card/.fatal-stack/.fatal-actions button`（style.css L1857-1926） | mask **.55**；card r12 + `0 12px 40px rgba(0,0,0,.35)` + sd 边；stack `var(--sl)`；btn r8 + sd 边 + sl 底；primary `--p` 平底 | mask **.5**（LM-26 致命遮罩 .5）；r16 + rs-l；stack `--bg` + 1px div；btn r16 + rs-s；primary `--pt→--pb` 渐变 | 遮罩 .55→.5；铁律②；圆角 | 9 行 |

### I. Toast（LM-17）

| 选择器 | 现状（值/档位） | 目标（值/档位） | 违反的铁律 | 改动量 |
|---|---|---|---|---|
| `.toast-wrap/.toast/.toast-success/.toast-error`（Toast.svelte L11-54） | `top:14px; left:50%; translateX(-50%)` 顶部居中；`var(--sl)` 底 + `1px var(--div)` 边 + r8 + `0 6px 20px rgba(0,0,0,.18)`；success `#2e9e5b` / error `#e0483d` 左竖条 | LM-17：右下 `right:14px; bottom:38px`；`var(--bg)` + `var(--rs)` + **r12**、无遮罩；语义色只上图标/文字（`--ok`/`--err`）；撤旧值 fallback（`#ffffff`/`#e2e2e6`）。**位置改动涉及组件布局，见疑点 D-1** | LM-17 位置；铁律①②；令牌纪律 | 7 行 |

### J. 旧文件菜单 `.menu/.menu-list`（style.css L1034-1101）

| 选择器 | 现状（值/档位） | 目标（值/档位） | 违反的铁律 | 改动量 |
|---|---|---|---|---|
| `.menu-list` 全段 | `var(--bg)` ✓ 但 `1px var(--sd)` 边 + r8 + `0 8px 24px rgba(0,0,0,.12)`；item hover tint+p ✓ | E1 菜单栏上线后**整段删除**（team-lead 集成阶段裁撤旧菜单）；暂留则 r12 + rs-l + 亮色去边 | 圆角/阴影（将被删除） | 删除 67 行 / 过渡 4 行 |

### K. 加载遮罩 `.loading-*`（style.css L1791-1830）

| 选择器 | 现状（值/档位） | 目标（值/档位） | 违反的铁律 | 改动量 |
|---|---|---|---|---|
| `.loading-veil/.loading-spinner/.loading-bar` | fallback 旧值：`var(--bg, #fff)`、`var(--p, #0f6e56)`、`var(--div, #e3e5e8)` | fallback 更新为素塑值（`#F2F4F7`/`#6A5FD8`/`#E6E8EB`）或直接撤 fallback | 令牌纪律（旧色板 fallback，轻） | 4 行 |

### L. 通用 `button` 基线（style.css L1015-1032）

| 选择器 | 现状（值/档位） | 目标（值/档位） | 违反的铁律 | 改动量 |
|---|---|---|---|---|
| `button` / `button:hover` / `button.on` | `1px var(--sd)` 边 + `var(--sl)` 底 + **r4**；hover 字/边变 p；`.on` `--tint` + p 边 | §10 L3 控件：`var(--bg)` + `var(--rs-s)` + 无边 + r9-12；hover `--hov` + t1；`.on` → `is-s` + p（选中内嵌）；暗色白描边（§12②）。**影响面最大**（全部未覆盖按钮继承），须与 team-lead tb- 段协调优先级，放最后执行并全量截图（疑点 D-10） | 铁律①③；圆角 | 10 行 |

### M. 滚动条 / 杂项

| 选择器 | 现状（值/档位） | 目标（值/档位） | 违反的铁律 | 改动量 |
|---|---|---|---|---|
| 深色滚动条（L1736-1766） | `#3a3b40`/`#4c4d55` 硬编码；注释「比背景 #1a1b1e 亮一档」已过时（现 `--bg` #262A31） | 令牌化：thumb 用 `--div-nav` 系 / hover `--t3`；更新注释 | 令牌纪律（轻） | 4 行 |
| `.tb .fg-a`（L169-174，tb- 归属） | `border-bottom: 3px solid #e53935` 硬编码红（字体色按钮示意） | 换 `var(--err)` 或登记示意色例外（轻） | 令牌纪律（轻） | 1 行 |

**已核查合规项**（无需改动，列出以备 QA 对照）：`:focus-visible`（2px p 环）、`.splitter:hover`（p）、`.panel-head`/`.tree-status`/`.tree-crumbs`（1px div L1 线）、`.preview`/`.preview-edit`/`.virtual-preview` 容器（L0 直出）、`.cm-cursor`（p）、`.mb-` 全段（E1 自写）、`.chip.on`（tint + 1px p）、`.sidebar li.focused`（p outline，a11y 保留）、`.window-busy`/`body.low-end` 降级规则。

---

## 3. 按改动量排序的执行顺序建议

原则：**先零风险的机械化替换，后影响面大的基线改动；先亮色可验证，后暗色补偿**。每批独立可回滚。

| 批次 | 内容 | 涉及组件 | 量（行） | 风险 |
|---|---|---|---|---|
| **B6-1** | 品牌字标主色化：`.brand` 渐变换 `--pt→--pb` | A | 1 | 零（§14 明文） |
| **B6-2** | 导航线提亮批：titlebar/tabbar/statusbar/sidebar 四处 border `--div→--div-nav` | A/B/F/G | 4 | 零（纯令牌） |
| **B6-3** | 悬停语言批：9 处 `--tint→--hov`（crumb/ts-btn/filter-clear/sort-item/empty-btn/tab/tab-act/sb-sync/nav-item/folder/file hover） | B/F/G/H | ~12 | 低（机械化） |
| **B6-4** | 旧色板硬编码清零：sb-warn/toast 双色/ctx-danger/kg-close/settings 四色/wc-close（D-5 裁决后）/loading fallback/滚动条 | A/C/D/G/H/I/K/M | ~25 | 低（逐值替换） |
| **B6-5** | 弹窗族圆角+阴影+遮罩：Confirm/Prompt/FolderSearch/hm/kg/fatal 六件（r12/14→16、硬编码影→rs-l、mask .35→.26/.5） | H | ~49 | 中（逐组件截图） |
| **B6-6** | 浮层族归位：quick-menu/ctx-menu/sort-pop/color-pop/menu-list（sl→bg、r8→12、影→rs-l、亮色去边暗色白描边） | B/D | ~17 | 中 |
| **B6-7** | 选中态内嵌批：tab.active/tab-act.on/ts-btn.on/tree-sort-btn.on/sidebar selected+file.active/nav-item.active（tint→is-s+p+600，暗色 ps 描边） | B/F/H | ~19 | 中（视觉语义变化大） |
| **B6-8** | 输入框形态批：tree-filter/rename-input/cm-search-input/pm-input/input.q/text-input（is-s + 聚焦 1.5px p + r9-11） | B/C/H | ~24 | 中 |
| **B6-9** | 表面色清零：sidebar/statusbar/titlebar sl→bg；cm-search-panel sl→bg；cm-quick-btn hover sl→hov | A/B/C/G | ~7 | 中 |
| **B6-10** | CM6 特例（editor.ts）：activeLine 旧绿→tint+竖条；gutter bg+divider 右边框 | C | 5 | 中（需编辑区人工回归，无自动化断言） |
| **B6-11** | 预览 LM-21：pre/code/th 收尾 + preview-edit code 补齐 | E | 9 | 低 |
| **B6-12** | 预览编辑 LM-22 块 hover/active（新增，需组件类名契约 D-8） | E | 10 | 中（跨组件协调） |
| **B6-13** | 通用 button 基线（sl→bg+rs-s、r4→r9-12、.on→is-s）——**放最后**，全量截图 | L | 10 | 高（继承面最大，D-10） |
| **B6-14** | 旧 `.menu` 段删除（随 E1 集成裁撤同步） | J | 67 | 低 |
| **B6-15** | Toast 表面 + 位置（D-1 裁决后；位置可拆独立小任务） | I | 7 | 中 |

> 暗色补偿（§12②白描边 / ④ps 选中描边）不单列批次，随各批件的暗色规则一并写入（每批改完必须亮暗双验）。

---

## 4. 需主理人裁决的疑点清单

| # | 疑点 | 影响 | 我的建议 |
|---|---|---|---|
| **D-1** | **Toast 位置**：现顶部居中 vs LM-17 右下 14/38。改位置涉及组件布局与 toast.ts 队列行为（错误常驻等） | Toast 组件 + QA 回归 | B6 先只换表面（色/圆角/阴影/语义色），位置改动拆独立小任务或同批但需 QA 专项回归 |
| **D-2** | **遮罩值无令牌**：.26（弹窗）/ .5（致命）在 7 处硬编码，设计明确两档。EXECUTION-SPEC 禁新增规范外令牌 | 全部弹窗 + 令牌纪律 | 请示破例加 `--mask`/`--mask-heavy` 两个令牌（集中登记）；或维持硬编码但在 style.css 令牌区注释集中登记两档语义 |
| **D-3** | **`.brand` 渐变主色化归属**：§14 明文 style.css 一处 gradient 改主色；E4 图标侧已落盘，CSS 侧是否确属 B6 本批 | 1 行 | 属 B6（§14 落地点明列 style.css），建议随 B6-1 首批执行 |
| **D-4** | **tab 激活态改 is 内嵌的视觉影响**：现 tint+紫边 pill 改 is-s 后，未激活 tab（无底无描边）与 tabbar 的区分度、以及暗色 ps 描边叠加效果需截图确认 | 标签栏交互视觉 | 按 LM-05 执行，但 B6-7 批必须亮暗双截图；若区分度不足可给未激活 tab 补 1px `--div` 底边（次级方案） |
| **D-5** | **`.wc-close:hover` 平台红 #e81123**：Windows 惯例 vs `--err` 令牌化 | 窗口关闭钮 | 建议保留平台红并在报告中登记为例外（平台一致性优先），暗色 #c01020 同理 |
| **D-6** | **SettingsModal 尺寸**：设计 660×450 vs 现 900×640 | 设置弹窗布局 | 建议保持现状（六 tab 真实内容需要），只换表面；贴合设计稿需产品确认信息架构，不作为 B6 阻塞项 |
| **D-7** | **预览正文卡 L2 结构改动**：LM-21「唯一大面积 L2 面」需 VirtualPreview 容器内包一层卡（改组件结构 + 块挂载点），风险高于纯 CSS | 预览整体结构 | 建议 B6 期内先做纯 CSS 项（pre/code/th/块态），正文卡单开任务；若要做需 engineer-render 协调 |
| **D-8** | **LM-22 块类名契约**：预览编辑 hover/active 需 App 层 / preview-edit-keys.ts 给块加类（如 `.pe-block`/`.pe-active`），CSS 与组件类名需一方定契约 | 预览编辑交互 | 请 team-lead 指定类名契约（我方可在 B6-12 按契约写 CSS） |
| **D-9** | **kbd 三种实现合一**：mb- `.kbd`（sl 底+div 边+r4，E1 已落并注「B6 定夺」）vs LM-19 键帽（bg+rs-s+div 边+r6）vs `.kb-rows kbd`（sl+2px 底边+r5） | 菜单/设置/快捷键图三处键帽 | 统一到 LM-19 语言；mb- 的 `.kbd` 是否回改需 team-lead 确认（涉及 E1 已验收产物） |
| **D-10** | **通用 button 基线改动影响面**：sl→bg+rs-s 会波及所有未覆盖按钮（面板头/搜索/树内 mini 等），且 Toolbar.svelte 已抽走（tb- 样式归 team-lead） | 全应用按钮 | 放 B6-13 最后执行；执行前与 team-lead 确认 tb- 段已落盘，避免选择器战争 |
| **D-11** | **搜索面板主钮渐变口径**：§10「渐变仅主按钮与徽标」，`.cm-search-btn-main`（查找/替换主操作）是否适用渐变 | 搜索面板 1 处 | 建议适用（主操作语义），与 LM-18 按钮排语言一致 |

**Top 3（最需尽快裁决）**：**D-2 遮罩令牌**（卡 B6-5 整批）、**D-1 Toast 位置**（卡 B6-15）、**D-8 块类名契约**（卡 B6-12，需组件侧先定名）。

---

## 5. 审计结论

- style.css 组件区与素塑目标态的差距集中在五类：**白面残留**（`--sl` 用作卡片/弹窗/树行底，违反铁律①，~20 处）、**硬编码阴影**（6 处弹窗/浮层用 `0 X px Y px rgba(0,0,0,.28–.35)`，应走 `--rs-l`/`--rs`/`--is-s`，违反铁律②）、**选中态染色**（tab.active/nav-item.active/sidebar selected 等用 tint 而非 is 内嵌，违反铁律③）、**旧色板硬编码**（含 editor.ts `.cm-activeLine` 的旧绿 `rgba(15,110,86,.06)`——B1 漏网，建议优先）、**参数不齐**（圆角 8/12→14/16、遮罩 .35→.26、输入框 is-s 化、LM-22 块态缺失）。
- 全部问题均为**表现层**，无一处需要动逻辑/回调（LM-18/19/21「保持」项均已遵守）。
- E1 mb- 段自写合规，可作本批其他浮层件的光效范本（rs-l + r12 + 暗色白描边 + 悬停 tint+p）。

—— 审计完毕，待 team-lead 集成提交后按第 3 节批次顺序执行。
