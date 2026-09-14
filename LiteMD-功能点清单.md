# LiteMD 全功能点清单（测试分析用）

> 生成方式：5 路并行源码穷举（编辑器核心 / 文件操作与树与附件 / 预览与视图 / 搜索设置同步 / 健壮性与平台集成）+ 文档交叉比对。
> 结构：`模块（H1）→ 子功能（H2）→ 功能点（表格行）`。标题层级可直接被 XMind「导入 Markdown」识别为三级分支。
> 优先级定义：**P0**=核心链路/数据安全（挂了软件不可用或丢数据）；**P1**=主要功能（日常高频）；**P2**=体验增强/低频。
> 路径缩写：`App`=src/App.svelte，`lib.rs`=src-tauri/src/lib.rs，`editor`=src/editor.ts，`FT`=src/FileTree.svelte，`SM`=src/SettingsModal.svelte。
> 统计：功能点 **231 项**（P0 62 / P1 118 / P2 51），存疑待确认 **24 项**。

---

# 1. 编辑器编辑（ED）

## 1.1 基础输入与导航

| 编号 | 功能点 | 来源依据 | 优先级 |
|---|---|---|---|
| ED-001 | 文本输入/删除（CodeMirror 6 内核） | editor.ts:340-420 liteSetup | P0 |
| ED-002 | 撤销/重做（history 栈，Ctrl+Z / Ctrl+Y） | editor.ts:44,58；settings.ts:221-222 | P0 |
| ED-003 | 多光标（多选区并行编辑，格式化命令逐范围应用） | editor.ts:48；:593,635,712 | P1 |
| ED-004 | 矩形块选择（Alt 拖选列块） | editor.ts:53 | P2 |
| ED-005 | 行号 gutter | editor.ts:41 | P1 |
| ED-006 | 当前行高亮（内容+gutter） | editor.ts:42,54 | P2 |
| ED-007 | 特殊字符/控制符可视化 | editor.ts:43 | P2 |
| ED-008 | 括号匹配高亮 | editor.ts:51 | P2 |
| ED-009 | 括号/引号自动闭合（CM6 默认集 `( [ { " '`；星号/反引号**不**自动闭合，见存疑 D-8） | editor.ts:52,58 | P1 |
| ED-010 | 输入时自动缩进（语言规则） | editor.ts:49 | P2 |
| ED-011 | Tab 键插入 4 空格缩进（不抢焦点） | editor.ts:372-373 | P1 |
| ED-012 | 代码折叠（围栏块/标题，gutter 箭头+foldKeymap） | editor.ts:45,58 | P2 |
| ED-013 | 选区自绘 + 拖放光标落点 | editor.ts:46-47 | P2 |
| ED-014 | 语法着色（Markdown 树 + 内嵌代码 14 语言按需加载） | editor.ts:50,67-156,374 | P1 |
| ED-015 | 光标行列实时上报状态栏 | editor.ts:410-414；App:1530 | P2 |
| ED-016 | 软换行开关（长行折行/横向滚动） | editor.ts:212,437-441；settings.ts:84 | P1 |
| ED-017 | 超长文档关闭选区匹配高亮（>200k 字符，动态重配） | editor.ts:214-215,377-379 | P1 |
| ED-018 | 跳转行并聚焦（跨文件搜索结果定位用） | editor.ts:1168-1173；App:2697-2701 | P1 |
| ED-019 | 输入法（IME）组合输入 | 依赖 CM6 内建，无专项代码（见存疑 Q-06） | P0 |

## 1.2 智能换行与列表续行

| 编号 | 功能点 | 来源依据 | 优先级 |
|---|---|---|---|
| ED-020 | Shift+Enter 软换行（表格格内插 `<br>`、引用保留 `> ` 前缀） | editor.ts:1058-1074 | P1 |
| ED-021 | Enter 智能跳出（引用/表格/代码块结尾回车跳出到块后空行） | editor.ts:1078-1113 | P1 |
| ED-022 | 普通回车续行让位 markdown 语言（列表自动续 `- `） | editor.ts:363-369 | P1 |
| ED-023 | 有序列表删除行后自动重编号（首项保留原号、后续递增） | editor.ts:983-1032 | P1 |
| ED-024 | 有序列表起始编号 Alt+Shift+1~9（已有全序则 toggle 移除） | editor.ts:918-979；App:3052-3056 | P2 |

## 1.3 代码块围栏索引（性能基建）

| 编号 | 功能点 | 来源依据 | 优先级 |
|---|---|---|---|
| ED-030 | 围栏奇偶检查点索引（512 行/检查点，O(1) 判定） | fence-index.ts:19-51 | P1 |
| ED-031 | 编辑标脏 + 空闲帧重建索引（idle 1500ms） | fence-index.ts:54-74；editor.ts:388-398 | P1 |
| ED-032 | 脏期有界降级判定（≤8192 行上扫，截断保守返回不误插） | fence-index.ts:85-103 | P1 |
| ED-033 | 代码块内判定双通道（Lezer 语法树 O(log n) 优先，索引兜底） | editor.ts:1038-1048 | P2 |

---

# 2. Markdown 格式命令（FMT）

## 2.1 行内格式

| 编号 | 功能点 | 来源依据 | 优先级 |
|---|---|---|---|
| FMT-001 | 加粗 toggle（`**`，含选区内已包裹检测、空选区插占位「文本」）Alt+B | editor.ts:589-630 wrapSelection；App:2520 | P0 |
| FMT-002 | 斜体 toggle（`*`）Ctrl+I | editor.ts:245；App:2521 | P0 |
| FMT-003 | 下划线 toggle（`__`）Ctrl+U | editor.ts:246；App:2522 | P1 |
| FMT-004 | 删除线 toggle（`~~`）Ctrl+Shift+X | editor.ts:247；App:2523 | P1 |
| FMT-005 | 行内代码（反引号包裹，格式刷可识别） | editor.ts:1115-1165 detectMarkers | P1 |
| FMT-006 | 插入链接 `[文字](https://)` 光标落 URL 处 Ctrl+K | editor.ts:728-740；App:2525 附近 | P0 |
| FMT-007 | 文字颜色（插 `<span style="color">`，调色板 12 色+自定义取色） | editor.ts:857-871；App:959-962,2576-2604 | P2 |
| FMT-008 | 格式刷（检测选区/光标两侧标记→单击应用一次/双击锁定连用/Esc 退出） | editor.ts:1115-1165；App:2549-2573,3047-3307 | P2 |
| FMT-009 | 超大选区格式操作短路保护（>256KB 拒绝物化） | editor.ts:26-34 | P1 |

## 2.2 块级格式

| 编号 | 功能点 | 来源依据 | 优先级 |
|---|---|---|---|
| FMT-010 | 标题 H1-H5 设置/toggle（剥旧 `#` 再设级，设后续行+滚动跟随）Alt+1~5 | editor.ts:678-707 setHeading | P0 |
| FMT-011 | 转正文（剥离任意级标题前缀） | editor.ts:710-719；App quickParagraph:986 | P1 |
| FMT-012 | 引用 toggle（`> ` 行前缀，多行全选有则移除，光标随偏移平移）Alt+> | editor.ts:633-674 toggleLinePrefix；App:2527 | P0 |
| FMT-013 | 无序列表 toggle（`- `）`` Alt+` `` | editor.ts:633-674；App:2528,3028-3032 | P0 |
| FMT-014 | 任务列表插入（`- [ ] ` 文本前缀） | App:2528,3327 | P1 |
| FMT-015 | 代码块插入/包裹选中文本 `` Alt+W `` | editor.ts:767-786；App:2996-3009 | P0 |
| FMT-016 | 行内快捷菜单（光标行 ⚡ gutter 按钮弹 H1-H5/正文/代码块/加粗） | editor.ts:294-337；App:973-997 | P2 |
| FMT-017 | 插入图片（选择器 8 种格式→收编→`![alt](相对路径)`，绝对路径尖括号包裹）Alt+Q | editor.ts:742-765；App:2758-2768 | P0 |

---

# 3. 表格编辑（TBL）

| 编号 | 功能点 | 来源依据 | 优先级 |
|---|---|---|---|
| TBL-001 | 插入表格模板（3 列表头+分隔行，光标进首个单元格）Alt+E | editor.ts:836-855；App:3011-3021 | P0 |
| TBL-002 | 复制表格行到下方（Alt+Enter，保持同列偏移；非表格行让位默认回车） | editor.ts:788-804 | P1 |
| TBL-003 | 表格添加列（Alt+\ ，定位连续 `|` 行块统一补列） | editor.ts:806-834；App:3023-3026 | P1 |
| TBL-004 | 表格列对齐（左/中/右，改写分隔行 `:---`，按光标前 `|` 计数定列） | editor.ts:873-916；App:2607-2611,3333-3335 | P1 |
| TBL-005 | 格内 Shift+Enter 插 `<br>` | editor.ts:1058-1074 | P2 |

---

# 4. 快捷键体系（KL）

| 编号 | 功能点 | 来源依据 | 优先级 |
|---|---|---|---|
| KL-001 | 动作注册表 5 组 31 项（文件6/编辑5/格式11/插入5/视图4），scope app/editor 二分 | settings.ts:148-207 | P0 |
| KL-002 | 31 条默认键位 | settings.ts:213-249 | P0 |
| KL-003 | 加速键归一化（修饰序 Ctrl→Alt→Shift；符号 Shift 变体归一 `|`→`\` 免 Shift 触发） | settings.ts:299-358 | P1 |
| KL-004 | 物理键位解析（Digit/Key code 兜底 Shift 变形；meta 视同 Ctrl） | settings.ts:360-391 | P1 |
| KL-005 | 设置面板捕获式重绑定（capture 抢窗口层、Esc 取消、要求修饰键或 F 键） | SM:92-149 | P1 |
| KL-006 | 冲突检测提示「X 已被『动作』占用」并拒收 | settings.ts:414-426；SM:139-143 | P1 |
| KL-007 | 单项恢复默认（↺，已是默认禁用）/全部恢复 | SM:97-108,184-211,723-725 | P2 |
| KL-008 | 键位热生效（editor 域 setKeymap Compartment 替换 + app 域窗口派发） | editor.ts:443-447；App:1686-1692,3035-3095 | P0 |
| KL-009 | 旧默认键迁移（Alt+·→Alt+`、Alt+Shift+5→Ctrl+Shift+X、Alt+R→Alt+>，用户自定义不动） | settings.ts:513-527 | P2 |
| KL-010 | 窗口级 Ctrl+F/H 兜底（焦点不在编辑器也能开查找面板，双触发幂等） | App:21-22,3065-3077 | P1 |
| KL-011 | 设置面板打开时快捷键让位；预览编辑模式仅放行 Ctrl+S | App:3035-3044 | P1 |
| KL-012 | 首次启动快捷键示意图（可关，关闭持久化不再弹） | App:778-781,1410-1413,3714-3776 | P2 |
| KL-013 | Ctrl+S 保存、Ctrl+Shift+S 另存、Ctrl+N 新建、Ctrl+O 打开、Ctrl+Shift+O 打开文件夹、Ctrl+E 导出 | settings.ts:214-219；App:3080-3095 | P0 |

---

# 5. 文件操作（FO）

## 5.1 读写与保存

| 编号 | 功能点 | 来源依据 | 优先级 |
|---|---|---|---|
| FO-001 | 打开 .md/.markdown 文件（原生对话框，过滤器） | fs.ts:60；lib.rs:192-200 | P0 |
| FO-002 | 保存（无路径自动转另存为） | App:2095-2137 | P0 |
| FO-003 | 另存为（目标已有标签时合并去重激活） | App:2139-2178 | P1 |
| FO-004 | 自动保存（开关+延迟 300-3000ms 可调，默认 800ms，空闲帧写盘，windowBusy 让路） | App:2256-2289；settings.ts:535-539 | P0 |
| FO-005 | 内容一致 no-op 不写盘 | App:2116-2121 | P1 |
| FO-006 | 保存基准守卫：lastSaved=null / suppressSave / loadFailed 三重禁写防覆盖 | App:2099-2114,2269-2271 | P0 |
| FO-007 | 脏状态双轨判定（docDirty O(1) ∪ 全文比较），标题/标签 ● 标记 | App:1000-1003,1217-1227 | P0 |
| FO-008 | 未保存退出拦截（Alt+F4/关闭按钮统一收口，三按钮：保存全部并退出/直接退出/取消，脏列表前5名） | App:1299-1305,3115-3193 | P0 |
| FO-009 | 会话恢复（openTabs≤30 + 内容/光标 localStorage，>1MB 只存指针回读磁盘；重启预读防闪烁；1.5s 防抖含未保存内容，强杀可恢复） | App:321-437,1462-1620 | P0 |
| FO-010 | 最近打开文件（上限 5，新的在前，菜单直达） | App:556,664-665,3243-3251 | P1 |
| FO-011 | 新建笔记（uniquePath 预填「未命名(1).md」→PromptModal 可改目录→乐观插入→直接打开） | FT:661-699 | P0 |
| FO-012 | 新建文件夹（同上去重预填） | FT:700-735 | P1 |
| FO-013 | 文件名清洗（拒 `/ \ : * ? " < > |` 与 `..`） | filetree/types.ts sanitizeName:154（Q-17 已从 commands/file-commands.ts 迁入） | P0 |
| FO-014 | 打开并发互斥锁（openingLock 串行化防重复标签） | App:1821-1838 | P1 |

## 5.2 导出

| 编号 | 功能点 | 来源依据 | 优先级 |
|---|---|---|---|
| FO-020 | 导出 HTML（内联样式单文件，safeRender 清洗后落盘） | App:2205-2235；lib.rs:1473-1477 | P1 |
| FO-021 | 导出 PDF（pulldown-cmark+printpdf，A4/20mm 边距，CJK 字体候选表+缓存，逐字折行，标题/列表/表格/任务/引用/代码/分隔线样式，图片与 HTML 跳过） | lib.rs:1479-1849 | P1 |
| FO-022 | PDF 无 CJK 字体时明确报错不崩溃 | lib.rs:1631-1633 | P2 |
| FO-023 | 导出自包含 Markdown（行内/引用式/HTML img 图片 base64 内嵌，外链跳过、读败保留原路径，计数进状态栏） | lib.rs:1851-2097；App:2237-2251 | P1 |
| FO-024 | 导出 Markdown 原文副本 | App:2181-2190 | P2 |
| FO-025 | 导出对话框自动补后缀（.pdf）/预填 `原名_bundled.md` | App:2199；lib.rs:2099-2115 | P2 |

## 5.3 平台入口

| 编号 | 功能点 | 来源依据 | 优先级 |
|---|---|---|---|
| FO-030 | 双击 .md 冷启动打开（argv 过滤+去引号/file:// 归一+take_open_files/ack 双通道+600ms emit 兜底+6×80ms 重试） | lib.rs:2230-2241,2300-2374；App:1434-1460 | P0 |
| FO-031 | 单实例热启动（第二实例路径转发主实例并不写缓存；无条件 unminimize+show+focus 修最小化双击无反应） | lib.rs:2189-2221；App:1415-1432 | P0 |
| FO-032 | 文件关联注册（md/markdown，role=Editor） | tauri.conf.json:61-71 | P0 |
| FO-033 | 拖文件进窗口（.md 开标签；图片走收编插图；payload.type/paths 解析） | App:1306-1318 | P1 |
| FO-034 | 冷启动带文件时不恢复会话标签（防混叠） | App:1456-1459 | P2 |

---

# 6. 文件树（TR）

## 6.1 展示与交互

| 编号 | 功能点 | 来源依据 | 优先级 |
|---|---|---|---|
| TR-001 | 懒加载目录树（list_dir 单层，展开才拉取，loaded 标记） | fs.ts:74-76；lib.rs:382-453 | P0 |
| TR-002 | 排序 name/mtime/size/type（文件夹恒在前，mtime/size 降序，type 按扩展名） | FT:1083-1093；flatten.ts:82-96,148-174 | P1 |
| TR-003 | 过滤（400ms 防抖；未加载层递归远程匹配 searchFilenames 每根 200 条，去重+上限 50+truncated 提示；远程行先 ensureVisible 再开） | FT:951-1002 | P1 |
| TR-004 | 隐藏路径（右键隐藏入 hiddenPaths 持久化；「隐」弹层管理取消隐藏） | FT:863-875,1453-1477 | P1 |
| TR-005 | 附件文件夹显隐（hideAttachments 按模式模板精确比对不误伤；「资源」按钮切 showNonMd 显示非 md） | FT:46-53,1384-1388；flatten.ts:34-40 | P1 |
| TR-006 | 多根工作区（添加/移除根、force 重载清陈旧 error、多根嵌套子树归属去重） | FT:907-930；store.ts:86-104 | P1 |
| TR-007 | 展开/折叠状态持久化（300ms 防抖，上限 500，值未变不写防循环） | FT:1065-1076；settings.ts:554-556 | P2 |
| TR-008 | 右键菜单四类（file/folder/root/multi：新建/重命名/打开/资源管理器/刷新/复制到/移动到/隐藏/删除/添加移除根） | FT:533-645,1398-1451 | P0 |
| TR-009 | 行内重命名（双击/F2/右键，md 自动补后缀，改名联动已开标签） | FT:488-531；App:859-873 | P1 |
| TR-010 | 键盘导航（↑↓/←→折叠展开/Enter 打开/F2/Delete/Esc） | FT:113-177 | P2 |
| TR-011 | 虚拟滚动（>500 项 27px 行高窗口化+rAF 节流） | FT:78-111,1267-1349 | P1 |
| TR-012 | 面包屑（祖先链推导+点击跳转定位） | FT:1004-1037 | P2 |
| TR-013 | 定位当前文件 ⌖（ensureVisible 逐层加载轮询 2s+滚动聚焦） | FT:931-949；locate.ts:11-40 | P2 |
| TR-014 | 多选（Ctrl/Shift 点选，右键作用于选区） | FT:179-254 | P1 |
| TR-015 | 空文件夹/无法访问/加载中提示行+重试按钮 | FT:1271-1279；flatten.ts:137-146 | P2 |

## 6.2 文件管理命令

| 编号 | 功能点 | 来源依据 | 优先级 |
|---|---|---|---|
| TR-020 | 删除→系统回收站（可恢复） | lib.rs:684-700 | P0 |
| TR-021 | 回收站不可用→TRASH_UNAVAILABLE 二次确认→永久删除 | fs.ts:109-120；FT:808-841 | P0 |
| TR-022 | 删除守卫（拒删盘符根/层级过浅目录；canonicalize 失败宁误拒不误删；根节点只移除工作区不删盘） | lib.rs:658-682；FT:789-807 | P0 |
| TR-023 | 移动（同盘 rename/跨盘复制+删源；删源失败回滚 dest；目标同名 xxx(1) 去重；防移入自身子目录） | lib.rs:750-788,732-748 | P0 |
| TR-024 | 复制（递归目录，同名自动去重） | lib.rs:790-806,718-730 | P1 |
| TR-025 | 树内拖拽移动/Ctrl+复制（自研 Pointer Events：5px 阈值、预览镜像、700ms 悬停展开、拖拽期暂停 watcher、乐观移动+失败回滚、覆盖确认） | FT:256-486；dnd.ts:12-18 | P1 |
| TR-026 | OS 文件拖入树导入（非破坏性 copy、按落点坐标解析目标目录、失败回退根、toast） | FT:1123-1179；drop-target.ts:10-20；lib.rs:1325-1347 | P1 |
| TR-027 | 重命名冲突硬报错「目标名称已存在」 | lib.rs:818-820 | P1 |
| TR-028 | 资源管理器定位（explorer /select 经 .arg() OS 转义防注入；mac/linux 打开父目录） | lib.rs:828-863 | P2 |
| TR-029 | 批量移动/复制后仅刷新涉及目录+标签路径联动 | FT:747-783 | P2 |

## 6.3 目录监视

| 编号 | 功能点 | 来源依据 | 优先级 |
|---|---|---|---|
| TR-040 | notify 递归监视，fs-change 事件（create/remove/rename/modify）增量应用仅受影响已加载目录 | lib.rs:545-613；ops.ts:287-367 | P1 |
| TR-041 | 监视开关（treeWatch 👁/；根列表变化自动 restartWatch；重复调用幂等停旧） | FT:1039-1063；settings.ts:108 | P2 |
| TR-042 | 事件 300ms 防抖合批；拖拽期 pause/resume 竞态防护 | watcher.ts:21-71 | P1 |
| TR-043 | 乐观节点合并防 Windows 通知延迟覆盖刚建项 | ops.ts:18-75,219-249 | P1 |
| TR-044 | 父目录被删显示「无法访问」不崩溃；reload 失败保留旧节点 | ops.ts:127-133；reveal.test.ts:115 | P2 |

---

# 7. 多标签（MG）

| 编号 | 功能点 | 来源依据 | 优先级 |
|---|---|---|---|
| MG-001 | 多标签打开（已存在即激活；路径 norm 防分隔符重复开） | App:527-560,303 | P0 |
| MG-002 | 标签切换（syncTabState/applyTabState 全量状态交换：内容/光标/预览/统计） | App:440-526 | P0 |
| MG-003 | 重复激活不 sync（防欢迎页覆盖当前文档 P0 修复） | App:515-519 | P0 |
| MG-004 | 关闭标签（脏→三按钮确认保存并关/不保存/取消；非激活先切过去） | App:687-723 | P0 |
| MG-005 | 中键关闭标签 | App:725-732 | P2 |
| MG-006 | 右键：关闭/关闭其他/关闭全部（批量逐个确认） | App:916-933,3143-3162 | P1 |
| MG-007 | 关闭最后标签清状态（退出预览编辑防残留回写） | App:742-767 | P1 |
| MG-008 | 树内改名→标签路径同步去重（防 keyed-each 双 key 卡死） | tabs.ts:17-40；App:859-873 | P1 |
| MG-009 | >8MB 大文档 deferred 延迟标签（激活才流式读盘） | App:345,534-540,579-685 | P1 |
| MG-010 | 载入失败标签 loadFailed 只读态（禁一切写盘） | App:295,478,589,681 | P0 |
| MG-011 | 标签拖拽排序 | **未实现**（见存疑 Q-01） | — |

---

# 8. 附件管理（AT）

| 编号 | 功能点 | 来源依据 | 优先级 |
|---|---|---|---|
| AT-001 | 附件组织模式 perDocument（每文档 `<名>_attachment/`，模板可自定义 {filename}） | attachment.ts:1-65；settings.ts:104-107 | P0 |
| AT-002 | 附件组织模式 shared（统一 assetsDir，默认 _attachment，sanitize 防路径穿越） | settings.ts:441-447 | P1 |
| AT-003 | 图片收编三通道：文件选择器 import_asset / 剪贴板 base64 import_asset_bytes / 零拷贝 raw body import_asset_raw（失败自动回退 base64） | fs.ts:130-167；lib.rs:936-1036 | P0 |
| AT-004 | 内容哈希命名去重（img-{hash16}.ext，同内容已存在跳过写入） | lib.rs:901-932 | P1 |
| AT-005 | 收编压缩（仅 JPEG 按质量重编码/PNG 无损保 alpha；压完更小才采用；SVG/GIF/WebP 原样） | lib.rs:865-899 | P1 |
| AT-006 | 粘贴图片（窗口级 paste 拦截仅 image/*；文本粘贴交还 CM） | App:2859-2874 | P0 |
| AT-007 | 粘贴图后台 WebP 转码（Worker 降采样主线程零解码；小 PNG 无损 WebP；Worker 不可用回退原图直传） | workers/image-worker.ts:24-51；App:2804-2849 | P1 |
| AT-008 | 重命名 .md 附件目录联动迁移+文档内引用精确改写（仅目录名变化触发；外部/协议引用不误伤；纯移动不改写） | attachment.ts:114-154；App:871-914 | P1 |
| AT-009 | 单篇迁移（绝对路径图片→收编相对化） | App:2877-2927 | P2 |
| AT-010 | 整文件夹批量迁移（list_md_files 递归，活动标签同步刷新） | App:2955-2992 | P2 |
| AT-011 | 孤儿附件两步清理（先预览列表→确认→按清单删除；canonicalize 防 `../` 逃逸；宁可漏删不误删） | fs.ts:207-226；lib.rs:1320-1471；App:2929-2953 | P1 |
| AT-012 | 图片尺寸索引（宽高落盘 .index.json，预览 aspect-ratio 预留防滚动跳变） | image-dims.ts:35-76；App:211-219 | P2 |
| AT-013 | 未保存笔记（无路径）拒绝收编图片 | App:2804 附近守卫 | P2 |

---

# 9. 预览渲染（PV）

## 9.1 渲染能力

| 编号 | 功能点 | 来源依据 | 优先级 |
|---|---|---|---|
| PV-001 | markdown-it 渲染（html:true、linkify:true 收窄 fuzzyLink/Email=false；typographer/breaks 关） | App:171-179 | P0 |
| PV-002 | GFM 表格渲染 | markdown-it 默认 preset；style.css:889 | P0 |
| PV-003 | 删除线渲染 | 同上 | P1 |
| PV-004 | 任务列表渲染（`<li class=task><input checkbox disabled>` 预览内不可勾选） | block-splitter.ts:718-722；sanitize.ts:101-108 | P1 |
| PV-005 | 代码块 highlight.js 高亮（16 语言白名单异步注册+别名表+就绪回调重渲+语言表 60 条容量·超限整体清空，非 LRU 逐出，见 D-DOC-5） | highlight.ts；App:177,1070-1071 | P1 |
| PV-006 | 本地图片 asset URL 转换（相对路径按笔记目录拼接、盘符/Unix 绝对路径 convertFileSrc、decodeURIComponent） | App:181-222 | P0 |
| PV-007 | 图片懒加载（loading=lazy + decoding=async） | App:208-210 | P1 |
| PV-008 | DOMPurify XSS 清洗（FORBID 白名单收窄、asset:/tauri: 放行、外链 rel=noopener、无 DOM 正则兜底） | sanitize.ts 全文件 | P0 |
| PV-009 | Mermaid 图 | **不支持**（依赖与全文检索零命中） | — |
| PV-010 | LaTeX 数学公式 | **不支持** | — |
| PV-011 | 脚注 | **不支持**（无 markdown-it-footnote） | — |
| PV-012 | 目录大纲/TOC 面板 | **不支持** | — |

## 9.2 增量与虚拟化（性能）

| 编号 | 功能点 | 来源依据 | 优先级 |
|---|---|---|---|
| PV-020 | 顶层块增量切块（围栏内不切；脏区间快速路径+256 行/段哈希缓存+恒等短路 O(1)） | block-splitter.ts:438-692 | P0 |
| PV-021 | 虚拟滚动（视口±800px 预读、每帧 8 块预算、rAF 节流、迟滞防抖） | VirtualPreview.svelte:175-252 | P0 |
| PV-022 | Fenwick 前缀和窗口计算 O(log²n) | windowing.ts:12-136 | P1 |
| PV-023 | 块高估算+ResizeObserver 实测校正+跨 source 继承 | VirtualPreview.svelte:72-73,353-395；block-splitter.ts:729-775 | P1 |
| PV-024 | 块 HTML LRU 缓存（内容哈希键，条数+字节双驱逐 20000/24MB，打字未变块零渲染） | VirtualPreview.svelte:38-67 | P1 |
| PV-025 | 空闲预渲染（滚动停 150ms 预渲上下 2 屏，低端 0 屏，拖窗挂起） | VirtualPreview.svelte:91-96,282-343 | P2 |
| PV-026 | 超高文档比例映射（>24M px 占位高缩放，滚动可达底） | windowing.ts:95-106 | P2 |
| PV-027 | 击键 O(1) 变更区间累计→增量切块（400ms 防抖，不变式校验回退全量） | App:1027-1145 | P1 |

## 9.3 预览行为控制

| 编号 | 功能点 | 来源依据 | 优先级 |
|---|---|---|---|
| PV-030 | 实时预览阈值（previewRealtimeMaxKB 256-8192 可调，默认 2048；超限暂停实时） | App:333-336,1115-1141 | P1 |
| PV-031 | 两级降级+常驻提示徽标（>阈值可手动刷新 ↻；>8MB(低端2MB) 手动也禁，⚠ 悬停解释） | App:1146-1173,3473-3480；StatusBar:29-33 | P1 |
| PV-032 | 编辑器→预览单向比例滚动同步（rAF，防反馈循环） | App:1541-1554 | P1 |
| PV-033 | >8MB 自动收起预览（用户手动展开后 paneUserOverride 不再自动折） | App:1096-1101,258 | P2 |
| PV-034 | 分屏开关 Ctrl+\（工具栏眼睛按钮） | App:259-262；settings.ts:245 | P0 |
| PV-035 | 内存压力下剥离视口外 img src 回收位图（回视口重渲无损） | VirtualPreview.svelte:362-372 | P1 |

---

# 10. 预览编辑模式 / 所见即所得（WZ）

| 编号 | 功能点 | 来源依据 | 优先级 |
|---|---|---|---|
| WZ-001 | 进入/退出预览编辑（编辑器仅 display:none 保挂载；contenteditable 注入清洗后 HTML；异步守卫防重入、失败回滚） | App:1885-2043,3441-3456 | P1 |
| WZ-002 | HTML→Markdown 回写（Turndown+gfm；atx/fenced/-/*；img data-md-src、asset 前缀还原、`<u>`→`__`、`<br>`→两空格、锚点 decode） | App:1893-1962,2053-2093 | P1 |
| WZ-003 | 最小差异写回（diffRange 公共前后缀+代理对回退，不丢选区；畸形 DOM 抛错保原文；失败退整篇 setDoc） | editor.ts:478-526；App:2053-2077 | P1 |
| WZ-004 | 回写 800ms 防抖；退出/保存/切标签强制 flush | App:2044-2051,514,744,2096 | P1 |
| WZ-005 | 模式内快捷键对齐源码模式（加粗/斜体/标题/引用/列表/代码块/表格/链接/图片/Alt+Shift+1-9 全套） | preview-edit-keys.ts:221-679 | P1 |
| WZ-006 | 智能 Enter（块后跳空段/引用截断/空 li 退出/heading 强制新段/Shift+Enter 软换行） | preview-edit-keys.ts:231-611 | P2 |
| WZ-007 | Tab/Shift+Tab 列表嵌套缩进（纯 DOM 移节点防 blockquote 污染） | preview-edit-keys.ts:281-309 | P2 |
| WZ-008 | 光标跟焦滚动（手算 scrollTop+rAF 纠正） | preview-edit-keys.ts:72-122,709-716 | P2 |
| WZ-009 | 模式内粘贴/拖入图片收编、表格插入锚定 | preview-edit-keys.ts:157-218,676-704 | P2 |
| WZ-010 | 工具栏命令双路转发（选区在预览内走 execCommand/DOM，否则回退 CM 命令） | App:2292-2529 | P2 |
| WZ-011 | 查找替换在模式内自动退出回编辑器开面板 | preview-edit-keys.ts:488-494；App:1995-2001 | P2 |
| WZ-012 | 回写前先 sanitize（M-04 防注入回源） | App:2063 | P1 |

---

# 11. 查找替换（SR）

## 11.1 编辑器内（中文面板）

| 编号 | 功能点 | 来源依据 | 优先级 |
|---|---|---|---|
| SR-001 | Ctrl+F 查找 / Ctrl+H 替换面板（自研中文面板替代官方英文） | search-panel.ts:204-307 | P0 |
| SR-002 | 选区初始化查找词（≤200 字符） | search-panel.ts:52-63 | P2 |
| SR-003 | 大小写敏感开关 | search-panel.ts:254,350 | P1 |
| SR-004 | 正则开关（非法正则提示「正则表达式无效」） | search-panel.ts:255,356 | P1 |
| SR-005 | 匹配计数「共 N 处/无匹配」（上限 1000） | search-panel.ts:415-426 | P1 |
| SR-006 | 上一个/下一个（回绕、排除当前选区重合匹配） | search-panel.ts:120-142 | P1 |
| SR-007 | Enter/Shift+Enter 导航；Mod-g/Mod-Shift-g；Esc 三处关闭 | search-panel.ts:196-201,428-436 | P1 |
| SR-008 | 全部选择匹配（多光标批量改） | search-panel.ts:145-154 | P1 |
| SR-009 | 替换当前（选中则替换并跳下）/全部替换+「已替换 N 处」反馈；readOnly 拒绝 | search-panel.ts:157-193 | P0 |
| SR-010 | 替换文本 \n \r \t \\ 转义 | search-panel.ts:86-91 | P2 |
| SR-011 | 输入 220ms 防抖；选项变更立即重查；替换行展开/收起 | search-panel.ts:336-339,239-249 | P2 |
| SR-012 | 全词匹配 | **不支持**（SearchQuery 有能力但面板未暴露，见存疑 Q-07） | — |

## 11.2 跨文件（当前文件夹）

| 编号 | 功能点 | 来源依据 | 优先级 |
|---|---|---|---|
| SR-020 | Ctrl+Shift+F / 菜单打开跨文件搜索（未开文件夹提示） | App:3057-3060,3297 | P1 |
| SR-021 | 递归搜全部 .md 字面子串+可选大小写（不敏感走 SIMD regex 快速路径；不支持正则） | lib.rs:1163-1193 | P1 |
| SR-022 | 结果按文件分组（相对路径+组计数徽标+行号+行文本，空行显示「（空行）」） | FolderSearch.svelte:99-176 | P1 |
| SR-023 | 上限 2000 截断提示；>32MB 文件跳过防 OOM | lib.rs:1087,1177-1181 | P1 |
| SR-024 | 分组懒渲染（每批 30 组+展开更多） | FolderSearch.svelte:32-33,178-181 | P2 |
| SR-025 | 点击结果开标签+行定位 | FolderSearch.svelte:129-132；App:2697-2701 | P1 |
| SR-026 | 全部替换二次确认（含查询/替换词、「不可撤销」警示） | FolderSearch.svelte:60-79 | P0 |
| SR-027 | 脏标签拦截（文件夹内有未保存标签禁止替换并列出前 5 个） | FolderSearch.svelte:67-77；App:2632-2650 | P0 |
| SR-028 | .bak 全量备份→替换→失败整体回滚→成功删 bak | lib.rs:1241-1294 | P0 |
| SR-029 | 替换后重同步已开标签（磁盘重拉+活动标签重载+计数反馈「N 处（M 文件）」） | App:2653-2686 | P1 |
| SR-030 | Esc capture 关闭/回车触发/遮罩点击关闭 | FolderSearch.svelte:115-138 | P2 |

---

# 12. 视图与布局（VS）

| 编号 | 功能点 | 来源依据 | 优先级 |
|---|---|---|---|
| VS-001 | 三栏布局（树/编辑/预览）各自开关 | App:3356-3500,253-254 | P0 |
| VS-002 | 分隔条拖拽调宽（侧栏 150-640px、预览 240-900px；不持久化见存疑 Q-03） | App:934-958 | P1 |
| VS-003 | 专注模式 F11（双栏收起、退出恢复前态） | App:1799-1812 | P1 |
| VS-004 | 启动恢复 showTree/showPreview 运行时状态 | settings.ts:540-541 | P1 |
| VS-005 | 侧栏折叠按钮 | FT:1204-1224 | P2 |

# 13. 外观与主题（TH）

| 编号 | 功能点 | 来源依据 | 优先级 |
|---|---|---|---|
| TH-001 | 主题 light/dark/auto 三态（auto=matchMedia 跟随系统实时响应） | settings.ts:5,530；App:1229-1279 | P0 |
| TH-002 | 标题栏 ☀/ 快速切换 | App:3337-3339,1793-1797 | P2 |
| TH-003 | 编辑器主题（浅色自绘/oneDark+补丁） | editor.ts:159-207 | P0 |
| TH-004 | CSS 变量全局主题（--bg/--text/--accent 驱动全部 UI 含 Toast） | style.css:2-39 | P1 |
| TH-005 | 字号 11-24px（Ctrl+=/Ctrl+- 缩放，预测式 transform 即时反馈+rAF 提交，主题按 px LRU） | App:1761-1791；editor.ts:180-202 | P1 |
| TH-006 | 固定字体栈（UI Inter/中文 PingFang；代码 JetBrains Mono；无字体族设置项） | style.css:66,884 | P2 |
| TH-007 | 低端外观降级（关 will-change/backdrop、开 imgReclaim、body.low-end） | lowend.ts:34-62；App:337 | P2 |

# 14. 界面组件与窗口（UI）

| 编号 | 功能点 | 来源依据 | 优先级 |
|---|---|---|---|
| UI-001 | 自定义标题栏（decorations:false+拖拽区） | tauri.conf.json:21；App:3229 | P1 |
| UI-002 | 最小化/最大化/关闭按钮；关闭走未保存确认；destroy 绕二次拦截 | App:3197-3213 | P0 |
| UI-003 | 8 向边缘缩放手柄（startResizeDragging） | App:3211-3213,3541-3548 | P1 |
| UI-004 | 状态栏（路径/状态文案/行列/字数·字符 CJK 按字拉丁按词/自动保存态/字号/预览⚠徽标/同步徽标） | StatusBar.svelte 全文件；App:1175-1184 | P1 |
| UI-005 | Toast 队列（success/error/info 三色、2.6s 自动消失、aria-live） | toast.ts；Toast.svelte | P2 |
| UI-006 | ConfirmModal/PromptModal（Promise 化封装、模态组件按需动态 import 分 chunk） | App:8-20,792-845 | P1 |
| UI-007 | 启动防闪烁（前端主动 show、4s 硬超时兜底、无标签才填欢迎页） | App:1282-1294,1609-1617 | P1 |
| UI-008 | 全局 fatalError 错误页（消息+stack 可复制；error/unhandledrejection 捕获） | App:277-282,1253-1267 | P0 |
| UI-009 | 大文档载入进度遮罩（spinner+进度条） | App:3457-3462 | P2 |
| UI-010 | 窗口尺寸/位置记忆 | **无**（每次固定 1280×800 居中，见存疑 Q-04） | — |

---

# 15. 设置项（ST）

## 15.1 持久化机制

| 编号 | 功能点 | 来源依据 | 优先级 |
|---|---|---|---|
| ST-001 | settings.json 持久化（app_config_dir；tmp+rename 原子写，Windows REPLACE_EXISTING） | settings-store.ts；lib.rs:2128-2154 | P0 |
| ST-002 | 浏览器调试回退 localStorage（key=litemd.settings） | settings.ts:589-618 | P2 |
| ST-003 | 300ms 写盘防抖+快照浅拷贝 | settings.ts:620-626 | P1 |
| ST-004 | 全字段逐条 sanitize 兜底（损坏 JSON/缺字段/类型错→默认值） | settings.ts:504-587 | P0 |
| ST-005 | 配置路径展示（设置「关于/通用」可见实际文件位置） | fs.ts:252-258；SM:281-286 | P2 |

## 15.2 全部设置字段（28 项）

| 编号 | 设置项 | 默认值 / 约束 | 来源依据 | 优先级 |
|---|---|---|---|---|
| ST-101 | theme | light；light/dark/auto | settings.ts:75,252,530 | P0 |
| ST-102 | fontSize | 14；[11,24] | :77,528-533 | P1 |
| ST-103 | wrap | true | :79,534 | P1 |
| ST-104 | autoSave | true | :81,535 | P0 |
| ST-105 | autoSaveDelay | 800ms；≥300 | :83,536-539 | P1 |
| ST-106 | showTree | true | :85,540 | P1 |
| ST-107 | showPreview | true | :87,541 | P1 |
| ST-108 | lastFolder | null | :89,542 | P1 |
| ST-109 | roots（多根列表） | [] | :91,560-562 | P1 |
| ST-110 | lastFile | null | :93,543 | P1 |
| ST-111 | openTabs | []；≤30 | :95,544-546 | P1 |
| ST-112 | hiddenPaths | [] | :97,547-549 | P1 |
| ST-113 | treeSort | name；四枚举 | :99,550-553 | P1 |
| ST-114 | treeCollapsed | []；≤500 | :101,554-556 | P2 |
| ST-115 | showNonMd | false | :103,557 | P2 |
| ST-116 | hideAttachments | true | :105,558 | P1 |
| ST-117 | attachmentMode | perDocument | :107,567 | P1 |
| ST-118 | attachmentTemplate | {filename}_attachment | :109,568-571 | P2 |
| ST-119 | treeWatch | true | :111,559 | P2 |
| ST-120 | recentFiles | []；≤5 | :113,563-565 | P1 |
| ST-121 | assetsDir | _attachment；非法字符清洗防穿越 | :115,441-447,566 | P1 |
| ST-122 | compressImages | true | :117,572 | P1 |
| ST-123 | jpegQuality | 80；[50,95] | :119,573-576 | P2 |
| ST-124 | previewRealtimeMaxKB | 2048；[256,8192] | :121,577-580 | P1 |
| ST-125 | lowEndMode | auto；auto/on/off | :123,581-582 | P1 |
| ST-126 | shortcuts | 31 动作映射表+归一+3 条旧键迁移 | :125,506-527 | P0 |
| ST-127 | shortcutGuideShown | false | :127,584 | P2 |
| ST-128 | sync | 见 §16 SyncSettings | :129,451-502 | P0 |

## 15.3 设置面板操作项（按标签页）

| 编号 | 功能点 | 来源依据 | 优先级 |
|---|---|---|---|
| ST-201 | 通用页 12 项（自动保存/延迟滑杆/预览阈值滑杆/低端下拉/默认目录选择清除/配置路径/附件模式 radio/模板/统一目录名/压缩开关/隐藏附件开关/JPEG 质量滑杆带禁用联动） | SM:213-362 | P1 |
| ST-202 | 编辑器页 4 项（字号±/自动换行/启动展开目录/启动展开预览） | SM:363-397 | P1 |
| ST-203 | 外观页（主题三 chip） | SM:399-433 | P1 |
| ST-204 | 快捷键页（31 药丸重绑/冲突提示/单项↺/全部恢复） | SM:181-211 | P1 |
| ST-205 | 导出页（HTML 立即导出；PDF 标「未实现」tag 与真实能力矛盾，见存疑 Q-13） | SM:688-704 | P2 |
| ST-206 | 关于页（版本 getVersion/技术栈/配置路径/GitHub+Gitee 外链 open_external） | SM:706-717 | P2 |

---

# 16. WebDAV 同步（SY）

## 16.1 配置（SyncSettings 17 字段）

| 编号 | 设置项 | 默认/约束 | 来源依据 | 优先级 |
|---|---|---|---|---|
| SY-001 | sync.enabled | false | settings.ts:477 | P0 |
| SY-002 | account.url | 协议白名单 http(s)+尾斜杠规范化 | :454-456 | P0 |
| SY-003 | account.username / password | 明文存储+UI 声明+👁可见性切换 | :480-481；SM:464-485 | P0 |
| SY-004 | folders[]（id/localRoot/basePath/enabled） | ≤20 条；basePath 补前导 /；id=sha256(localRoot)前12位 | :457-470；sync/state.rs:79-85 | P0 |
| SY-005 | intervalMin | 5；枚举 0/1/5/15/30/60（0=仅手动） | :48,484 | P1 |
| SY-006 | concurrency | 5；[1,16] | :485 | P2 |
| SY-007 | conflictPolicy | keepBoth/newerWins | :486 | P0 |
| SY-008 | failSafe | true | :487 | P0 |
| SY-009 | maxFileSizeMB | 100；[1,4096] | :488 | P1 |
| SY-010 | ignorePatterns | .git/**、Thumbs.db、~$*；≤50 | :489-491 | P1 |
| SY-011 | advanced.ignoreTlsErrors | false（危险开关带警示） | :493；SM:618-624 | P1 |
| SY-012 | advanced.customTlsCerts | 逗号分隔 .pem/.crt/.cer 文件/目录 | :494；webdav.rs:429-458 | P2 |
| SY-013 | advanced.proxyEnabled/proxyUrl/proxyTimeoutSec | 关/""/1s [0,600] | :495-497 | P2 |
| SY-014 | advanced.syncOnWindowFocus | false | :498 | P2 |
| SY-015 | lastSyncAt | null（状态栏展示） | :500 | P2 |

## 16.2 同步 UI

| 编号 | 功能点 | 来源依据 | 优先级 |
|---|---|---|---|
| SY-020 | 设置「同步」页全字段表单+http 明文黄字警示 | SM:435-686 | P1 |
| SY-021 | 添加同步文件夹（目录选择器+查重+id 派生+目录名缺省 basePath） | App:3580-3595 | P0 |
| SY-022 | 文件夹启用/移除（移除不动磁盘） | SM:489-511 | P1 |
| SY-023 | 检查同步配置四步分级报告（网络→认证→读取→写入探针，✓/—/✗+总结语；URL 空禁用） | webdav.rs:216-289；SM:523-555 | P0 |
| SY-024 | 立即同步按钮（无启用文件夹禁用） | SM:532-534 | P0 |
| SY-025 | 状态栏同步徽标三态（同步中 n/m ⟳、上次 HH:MM、未同步；冲突计数；点击=立即同步、同步中点击=请求取消） | App:1700-1745；StatusBar:35-45 | P1 |
| SY-026 | 结果 Toast 分级（errors→error+logWarn；冲突→info；成功→success）+跳过/故障保护计数 | App:1733-1738；sync.ts:122-134 | P1 |
| SY-027 | 强制重新上传（忽略快照全量 PUT；两步内联确认） | SM:650-667；engine.rs:174-187 | P1 |
| SY-028 | 强制重新导入（本地全进回收站→远端全量拉取；两步确认+备份建议） | SM:668-684；engine.rs:188-201,407-420 | P1 |

## 16.3 调度

| 编号 | 功能点 | 来源依据 | 优先级 |
|---|---|---|---|
| SY-040 | 15s 心跳+间隔到期判定（每次读最新设置，改间隔免重启） | sync-scheduler.ts:19,58-62 | P0 |
| SY-041 | 启动延迟 30s 首轮 | :21,61；App:1622-1625 | P2 |
| SY-042 | 可见性门控（隐藏暂停，恢复过期补跑） | :63,72-75 | P1 |
| SY-043 | 焦点触发（开关控制，距上轮≥30s 限频） | :77-84 | P2 |
| SY-044 | 保存后触发（距上轮>60s、5s 防抖合并连续保存） | :86-97；App:2136,2281 | P2 |
| SY-045 | 防重入（running 互斥+Rust 全局 SYNC_RUNNING 双保险，忙错误静默吞） | :59,106-115；mod.rs:211-217 | P0 |
| SY-046 | 取消机制（AtomicBool 文件间检查点；已完成部分入快照下轮续传） | mod.rs:266-269；engine.rs:437-439,488-491 | P1 |

## 16.4 同步引擎（三方合并）

| 编号 | 功能点 | 来源依据 | 优先级 |
|---|---|---|---|
| SY-060 | 快照基线（app_data/sync/<folderId>.json，hash 为准 mtime/etag 缓存，key 归一小写） | state.rs 全文件 | P0 |
| SY-061 | 快照原子写（tmp+rename）+每 20 项 flush 断点续传 | state.rs:117-125；engine.rs:471-479 | P0 |
| SY-062 | 快照损坏→改名 .corrupt-<ts> 隔离退化为空基线（不丢数据只多冲突副本） | state.rs:100-114 | P1 |
| SY-063 | 分类矩阵 #1-#10 全行（本地/远端新增、同名新增哈希认领、未变跳过、单向变上传/下载、双变冲突、双向删除传播、双删清快照） | engine.rs:160-313 | P0 |
| SY-064 | keepBoth 冲突：本地原件不动+远端版落「{名}（冲突副本 日期 时间，远端）.ext」重名 (2) 递增，一轮收敛 | engine.rs:142-152,707-748,841-854 | P0 |
| SY-065 | newerWins 冲突：mtime 定胜负，本地败方先进回收站再覆盖 | engine.rs:239-242,749-792 | P1 |
| SY-066 | 脏标签保护：打开且未保存的文件下载前强制降级冲突副本，绝不覆盖编辑中内容 | engine.rs:512-519；mod.rs:139-158 | P0 |
| SY-067 | fail-safe ①远端空+有快照→跳过全部本地删除 | engine.rs:290-295 | P0 |
| SY-068 | fail-safe ②拟删本地>max(20,30%)→全跳+提示 | engine.rs:296-305 | P0 |
| SY-069 | fail-safe ③双端皆空有快照/列举网络错误→整轮中止 | engine.rs:345-346,364-375 | P0 |
| SY-070 | 本地删除一律走回收站 | engine.rs:579,755 | P0 |
| SY-071 | dry-run 计划预览（返回动作清单不执行） | engine.rs:384-393 | P2 |
| SY-072 | 并发传输 buffer_unordered(1-16) | engine.rs:405,469 | P1 |
| SY-073 | 大文件跳过+skipped 清单；ignorePatterns glob（**/*/?/basename/大小写不敏感） | local.rs:55-58,94-158 | P1 |
| SY-074 | 大小写碰撞检测报错拒同步（防 WebDAV 互踩）；目录数>20000 护栏 | local.rs:31-34,59-82 | P1 |
| SY-075 | WebDAV 兼容：中文/空格逐段百分号编码、href 反解（绝对URL/query/双重编码/大小写不敏感前缀）、无 etag 降级、200 非 207 降级、MKCOL 405 容错 | webdav.rs:118-168,291-332 | P0 |
| SY-076 | 远端路径穿越/非法字符拒绝（`..`、`<>:"|?*`） | webdav.rs:164-166 | P0 |
| SY-077 | 列举护栏（5000 次 PROPFIND/50000 条目中止） | webdav.rs:20-21,296-321 | P1 |
| SY-078 | 错误中文友好文案（连接/超时/DNS 分类） | webdav.rs:419-427 | P2 |
| SY-079 | TLS：rustls+系统根证书、https 全程加密、自定义 CA、忽略证书错误开关 | webdav.rs:86-105 | P1 |
| SY-080 | Range 断点续传 / 并行子目录列举：**未实现**（设计文档声明项，见存疑 Q-10） | 设计方案.md:233,261 | — |

---

# 17. 健壮性与性能（RB）

| 编号 | 功能点 | 来源依据 | 优先级 |
|---|---|---|---|
| RB-001 | 大文件分片流式载入（>8MB：file_size O(1) 探测→头片 256KB UTF-8 边界对齐先出字→Channel 逐片 2MB/低端 512KB→空闲帧 timeRemaining>6ms 预算 append→载入期只读） | lib.rs:102-189；App:563-685；editor.ts:531-575 | P0 |
| RB-002 | 跨片 UTF-8 残留拼接+文件尾非法字节 lossy 兜底不 panic | lib.rs:112-124,145-189 | P1 |
| RB-003 | 流式载入可中止（docStreamToken 令牌，切/关/重开标签作废旧流防污染） | App:565-577 | P0 |
| RB-004 | 流式期副作用抑制（跳过围栏/onChange/预览推送，末尾统一重建） | editor.ts:227,382-385,543-557 | P1 |
| RB-005 | 低端设备检测（deviceMemory≤4GB∨核数≤4∨集显/基本渲染器 WebGL 匹配）+auto/on/off 覆盖 | lowend.ts:64-93 | P1 |
| RB-006 | 12 项降级参数矩阵（预览阈值/刷新上限/预读边距/帧预算/缓存/图片边距与质量等） | lowend.ts:7-62 | P1 |
| RB-007 | 内存压力自愈（5s 采样 performance.memory，>180/120MB 清缓存+暂停预渲染，<70% 连续 3 次迟滞恢复） | App:1332-1364 | P1 |
| RB-008 | 窗口拖拽/缩放挂起后台任务（onMoved/onResized 置忙 150ms，自动保存/统计/预渲染让路） | App:348-371 | P1 |
| RB-009 | 路径穿越防护 validate_path（词法消解 `..`/`.`，越根即拒；覆盖读写创删移拷导出全链路） | lib.rs:41-66；单测 2496-2511 | P0 |
| RB-010 | CSP 白名单（script 'self' 无 unsafe-eval；asset 协议受控） | tauri.conf.json:27 | P0 |
| RB-011 | capability 最小权限（无 shell 插件） | capabilities/default.json | P1 |
| RB-012 | open_external 仅 http/https 白名单 | lib.rs:2376-2381 | P1 |
| RB-013 | 前端崩溃日志落盘 %TEMP%\litemd-frontend.log（仅未捕获异常）+启动诊断 litemd-startup.log | lib.rs:69-76,2175-2188 | P1 |
| RB-014 | 操作日志 logOp/logInfo/logWarn/logError 纯控制台（不落盘，明示设计） | logger.ts:1-22 | P2 |
| RB-015 | base64 分块编码防 WebView2 栈溢出 | App:2772 | P2 |
| RB-016 | 非 Tauri 环境全链路静默降级（localStorage 设置/无 watcher/无 worker 回退） | settings.ts:589-618；watcher.ts；image-worker-client.ts | P2 |
| RB-017 | release 构建硬化（lto/opt3/strip/panic=abort） | Cargo.toml:52-59 | P2 |
| RB-018 | 设置/快照原子写（tmp+rename）；替换用 .bak 全备→写→回滚（等价方案，非 tmp+rename；见 D-DOC-5、D-6） | lib.rs:2140-2154；state.rs:117-125；lib.rs:1241-1294 | P0 |
| RB-019 | 测试基建：vitest 21 文件 206 用例、Rust 单测 44、真实 HTTP E2E 5、性能基准脚本 10+（50MB 量化） | src/__tests__/；scripts/ | P1 |

---

# 18. 平台集成（PL）

| 编号 | 功能点 | 来源依据 | 优先级 |
|---|---|---|---|
| PL-001 | NSIS 中文安装器（SimpChinese 单语言） | tauri.conf.json:50-59 | P2 |
| PL-002 | 桌面快捷方式+卸载清理（custom.nsh） | custom.nsh:4-10 | P2 |
| PL-003 | WebView2 运行时（v1.1.0 起去内置、依赖安装器默认 bootstrapper，见存疑 Q-15） | RELEASE_NOTES_v1.1.0.md:62-64 | P1 |
| PL-004 | 三端目标（Win/mac/Linux 交叉编译说明；reveal/open_external 有 mac/linux 分支） | README:177-190；lib.rs:828-863 | P2 |
| PL-005 | 开机内存/任务管理器无关（无自启动、无托盘常驻） | 全仓无痕迹（负向确认） | P2 |

---

# 19. 存疑清单（需产品/开发确认，共 24 项）

> 分三类：A=行为/一致性存疑；B=疑似死代码或口径不一；C=文档与代码不符。

| 编号 | 类别 | 存疑内容 | 证据 | 建议确认点 |
|---|---|---|---|---|
| Q-01 | A | 标签不支持拖拽排序，顺序仅打开序 | App:3393-3413 无 drag 逻辑 | 是设计取舍还是待开发？ |
| Q-02 | A | 分栏宽度（侧栏/预览）不持久化，重启回默认 | App:935-936 局部变量 | 是否需要持久化？ |
| Q-03 | A | 窗口尺寸/位置不记忆，每次固定 1280×800 居中 | lib.rs:2223-2229 | 与 tauri-plugin-window-state 取舍？ |
| Q-04 | A | tauri.conf.json `visible:true` 与代码注释「visible:false 靠前端 show」矛盾 | conf:21 vs lib.rs:2204 注释 | 当前配置下防闪烁逻辑是否失效？ |
| Q-05 | A | 新建时用户在 PromptModal 手输重名→硬报错，而默认名预填走自动改名，行为不一致 | FT:668-674 vs lib.rs:637 | 统一为自动 (1) 去重？ |
| Q-06 | A | IME 组合输入无专项处理；预览编辑模式（execCommand）与中文输入法兼容性未见验证 | 全仓无 isComposing 处理 | 需真机中文 IME 用例覆盖 |
| Q-07 | A | 查找面板无「全词匹配」入口（SearchQuery 具备能力未暴露） | search-panel.ts:254-258 | 是否补 UI？ |
| Q-08 | A | 任务列表复选框预览/预览编辑均不可点击勾选（强制 disabled） | sanitize.ts:101-108 | 交互预期确认：只读展示 or 可勾选回写？ |
| Q-09 | A | 流式载入中途关标签：已输入未保存内容丢失且无提示（deferred 直关禁存是刻意设计） | App:693-698 | 是否需要提示？ |
| Q-10 | B | 同步 Range 续传、并行子目录列举未实现（设计文档 §7.1/§7.4 声明后置 M3） | 设计方案.md:233,261 | 排期确认 |
| Q-11 | B | 多同步文件夹「可配置多条、单轮只跑第一个启用项」；runNow/folderId/dryRun 参数无 UI 调用点 | mod.rs:118-123；SM 无逐条触发 | 多文件夹逐个触发是否本期需求？ |
| Q-12 | B | scheduler.runSync 包装恒返回 true，busy 时 lastRunAt 仍被刷新（注释语义不符） | App:1751-1754；sync-scheduler.ts:9 | 修正返回值语义？ → ✅ 已修：doSyncRun 如实返回 boolean，调度器 busy 拒绝时回退 lastRunAt 下轮重试 |
| Q-13 | B | 设置「导出」页 PDF 标注「未实现」，实际 export_pdf 已实现（v2.0） | SM:699-702 vs lib.rs:1479 | UI 文案过期 → ✅ 已修：设置页 PDF 改「立即导出」按钮，接 exportPdfDoc（App 挂 on:exportPdf） |
| Q-14 | B | export_html、path_exists 两命令未过 validate_path，与其余写命令安全口径不一致 | lib.rs:1475-1477,629-631 | 补校验或书面豁免 → ✅ 已修：export_html/export_pdf/path_exists 三命令统一补 validate_path |
| Q-15 | B | WebView2「自动联网静默安装」未见显式 webviewInstallMode 配置，依赖 Tauri 默认 | conf 无该键 vs RELEASE_NOTES_v1.1.0:62 | 离线安装场景实测？ |
| Q-16 | B | assetProtocol scope 首项 `"**"` 架空 C~F 盘符列表，实际不限制 | tauri.conf.json:30-36 | 是有意放开还是配置错误？ → ✅ 已修：scope 收敛为 ["**"] 单条，去除误导性盘符列表（行为不变，放开为有意设计） |
| Q-17 | B | 疑似死代码：src/commands/format-commands.ts、search-commands.ts（makeToolbarCommands 无引用）；read_md_tree/cleanupOrphans 旧接口无调用；file-commands.ts 内第二份 migrate 实现（含 UNC）未接入 | App:86 import 未用等 | 删除或接入？ → ✅ 已修：删 src/commands 整目录（sanitizeName 迁 filetree/types.ts）；read_md_tree/cleanup_orphans 前后端链移除；注册命令 48 个 |
| Q-18 | B | editor.ts EDITOR_COMMANDS 含 table.addColumn 但 scope=app，编辑器域该键不生效（仅窗口层生效） | editor.ts:280 vs settings.ts:192 | 行为确认（双触发风险已排除？） → ✅ 已修：EDITOR_COMMANDS 移除 table.addColumn 死字典项并注释说明单通道语义 |
| Q-19 | B | H6 标题无快捷键/命令（仅 H1-H5）；工具栏「H」按钮走 toggleLinePrefix 与 setHeading 行为不一致（不续行/不剥多级） | settings.ts:172-184；App:3324 | 补 H6？统一两条实现路径？ → ✅ 已修（H1 部分）：工具栏 H 改走 setHeading，与 Alt+1/快捷菜单同实现；H6 支持仍待产品决策 |
| Q-20 | C | 快捷键示意图文案与实际不符：写「Ctrl+E 导出 PDF」实为导出 HTML；缺删除线/Alt+Enter/Alt+\/Alt+` 条目 | App:3731 vs settings.ts:219 | 更新示意图 → ✅ 已修：示意图 Ctrl+E 改「导出 HTML」，补删除线/复制表格行/表格加列三条 |
| Q-21 | C | README 称「Rust 后端 28 命令」，实际注册 46 项；引用 docs/P0-验收清单.md 等但 docs/ 目录不存在 | README:56,156,208 | 文档刷新 → ✅ 已修：README 命令数改 48、删 docs/ 三处失效引用 |
| Q-22 | C | MarkLite-快捷键设置-spec.md 键位表为旧版（Ctrl+B 加粗等），与实现（Alt+B、Ctrl+Shift+X）不一致；SCAFFOLD §6「PDF 未实现」过期 | spec:33-59；SCAFFOLD:186 | 归档或更新 → ✅ 已修：SCAFFOLD PDF 项勾选并注明 v2.0 实现；spec 顶部加键位勘误说明 |
| Q-23 | C | Cargo.toml 注释称 watcher 失败回退「窗口激活时刷新」，未见该回退实现（focus 监听仅接同步） | Cargo.toml:34 vs App:1661 | 补实现或删注释 → ✅ 已修：Cargo.toml 注释改为与实际行为一致（失败仅记日志，手动/操作后刷新） |
| Q-24 | C | 同步包体 +1.5~2MB 为估算未实测；PERF.md 已标注待回填 | PERF.md:132-134 | 下次发版实测 |

---

# 附 0：存疑清单修复记录（2026-09-13 第二批）

B/C 类确定性问题 11 项已修复（Q-12/13/14/16/17/18/19(H1)/20/21/22/23），回归全绿：cargo 38+5、vitest 161、vite build ✓、tsc 基线 7 无新增。
仍开放（需产品决策/实测）：Q-01~Q-11（交互与行为取舍）、Q-15（WebView2 离线安装实测）、Q-19 之 H6 支持、Q-24（发版实测包体）。

---

# 附：统计与 XMind 导入说明

- 功能点合计 **231**（ED 33 / FMT 17 / TBL 5 / KL 13 / FO 25 / TR 44 / MG 10 / AT 13 / PV 35 / WZ 12 / SR 30 / VS 5 / TH 7 / UI 10 / ST 39 / SY 44 / RB 19 / PL 5，含负向确认项）。
- 明确「不支持/未实现」负向项 6 个（Mermaid、LaTeX、脚注、TOC、标签拖拽排序、Range 续传）——测试范围应排除或转为需求提案。
- XMind：新建图 → 「文件 → 导入 → Markdown」，本文件 H1=中心主题分支、H2=子分支、表格行=叶子（表格内容会作为备注/文本节点导入，若需纯层级可把表格行改为 `- 编号 功能点` 列表再导入）。
