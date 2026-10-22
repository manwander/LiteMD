# LiteMD 产品化执行规范（EXECUTION SPEC v1.1）

> 本文档是 `litemd-product-v1.html`（设计方案 v1.1）的执行层宪法。**所有实施 agent 必须以此为准，不得擅自变更令牌值、批次边界、命名与验收判据。** 与设计文档冲突时，以设计文档为准并上报主理人。

## 0. 项目上下文

| 项 | 值 |
|---|---|
| 工程路径 | `E:/project/LiteMD` |
| 技术栈 | Tauri 2 + Svelte 5 + Vite 5 + CodeMirror 6（Rust 后端在 `src-tauri/`） |
| 前端源码 | `src/`（App.svelte 4389 行 · style.css 1924 行 · settings.ts 626 行） |
| 测试 | `src/__tests__/` 24 个文件，`NODE_OPTIONS="" npx vitest run` |
| 构建 | `NODE_OPTIONS="" npm run build` |
| 执行 shell | Git Bash（sed/awk 可用）；PowerShell 跑 java 类任务 |
| 包管理 | npm，Node 22.22.2（managed） |

## 1. 素塑令牌表（唯一事实源，禁止新增/改名/改值）

### 1.1 亮色（`:root` / `:root[data-theme="light"]`）

```css
--bg: #F2F4F7;  --sd: #D3D4D7;  --sl: #FFFFFF;
--t1: #3A3F4D;  --t2: #8A8F9E;  --t3: #B4B9C6;
--p: #6A5FD8;  --pt: #7A6EE0;  --pb: #5B4FD0;  --ps: rgba(91,79,208,.42);
--ok: #00B884;  --warn: #F5A623;  --err: #E24B4A;
--div: #E6E8EB;  --div-nav: #D3D4D7;  --srf: transparent;  --tint: rgba(106,95,216,.12);
--hov: rgba(58,63,77,.06);
--rs: 5px 5px 10px var(--sd), -5px -5px 10px var(--sl);
--rs-s: 3px 3px 6px var(--sd), -3px -3px 6px var(--sl);
--rs-l: 6px 6px 14px var(--sd), -6px -6px 14px var(--sl);
--is: inset 4px 4px 8px var(--sd), inset -4px -4px 8px var(--sl);
--is-s: inset 3px 3px 6px var(--sd), inset -3px -3px 6px var(--sl);
```

### 1.2 暗色（`:root[data-theme="dark"]`）

```css
--bg: #262A31;  --sd: #16191F;  --sl: #383F4B;
--t1: #E8EAED;  --t2: #9AA0A6;  --t3: #5C626D;
--p: #8B80E8;  --pt: #948AEA;  --pb: #6C61C4;  --ps: rgba(140,128,232,.38);
--ok: #2FD3A5;  --warn: #FFC65C;  --err: #F09595;
--div: #2A2E35;  --div-nav: #4B5361;  --srf: rgba(255,255,255,.09);  --tint: rgba(139,128,232,.16);
--hov: rgba(232,234,237,.07);
```

### 1.3 暗色补偿四组（随暗色令牌一起落地）

- 白辉：`--sl` 已含（#383F4B 即白辉面）；浮层标题/分隔处可用 `rgba(255,255,255,.06)` 微光
- 白描边：浮层 L4 描边 `1px solid rgba(255,255,255,.10)`
- 导航线提亮：`--div-nav: #4B5361`（侧栏/标签栏分区）
- 选中描边：主色 38%（`--ps`）

### 1.4 低端降级（`:root[data-lowend]` + `body.low-end` 双选择器）

- `--rs` / `--rs-l` → 单侧柔影 `0 1px 3px var(--sd)` + `1px solid var(--div)`（CSS 内以 `0 0 0 1px var(--div)` 环影等价实现，box-shadow 无法承载 border）
- `--is` / `--is-s` → `inset 0 0 0 1px var(--div)`（**保留 tint 染色，阴影可去、染色不可去**）
- **选择器形态（B1 裁决）**：现状机制是 `document.body.classList.toggle("low-end", lowEndMode)`（App.svelte），body 类向全部后代继承自定义属性、应用 UI 全在 body 内，故降级块用 `:root[data-lowend], body.low-end` 双选择器；不改 App.svelte

### 1.5 语法高亮 8 色（`--hl-*`，按 #F2F4F7 底）

| 令牌 | 亮 | 暗 |
|---|---|---|
| `--hl-keyword` | #A626A4 | #C678DD |
| `--hl-string` | #50A14F | #98C379 |
| `--hl-number` | #986801 | #D19A66 |
| `--hl-comment` | #B4B9C6（由 #A0A1A7 提亮，白底对比度达标） | #7F848E |
| `--hl-func` | #4078F2 | #61AFEF |
| `--hl-type` | #C18401 | #E5C07B |

## 2. 旧令牌 → 新令牌映射表（B1 切换用）

| 旧令牌 | 新令牌（亮） | 说明 |
|---|---|---|
| `--bg` | `--bg` | 同名换值 |
| `--panel` | `--sl` | 侧栏/面板面 |
| `--border` | `--div` | 分栏线；控件描边场景二阶段改 `--sd` |
| `--text` | `--t1` | 主文字 |
| `--text-2` | `--t2` | 次要文字 |
| `--text-3` | `--t3` | 三级文字 |
| `--muted` | `--t2` | 次要图标/提示 |
| `--accent` | `--p` | 主色 |
| `--accent-soft` | `--tint` | **必须先于 --accent 替换** |
| `--pill` | `--sl` | chip 浅灰面 → 白面 + rs-s |
| `--bg-soft` | `--tint` | 输入框内嵌底（换色同时补 `--is-s` 类） |
| `--danger` | `--err` | 语义色 |
| `--success` | `--ok` | 语义色 |
| `--warning` | `--warn` | 语义色 |
| `--tree-guide` | `--div-nav` | 树引导线 |
| `--toast-bg` | `--sl` | Toast 面 |
| `--safe-top/left/right` | **保留不动** | env 令牌与主题无关 |
| `--hl-*` | 见 §1.5 | 重调值 |

## 3. 批次边界与 Definition of Done

统一 DoD 五件套：**代码合入 · vitest 绿 · build 过 · 截图/目检确认 · commit + tag（b1…b7）**。

| 批 | 内容 | 触碰文件（除此之外不许动） | 专项判据 |
|---|---|---|---|
| B1 | 令牌层 | `style.css` | 旧令牌定义名+引用名 grep = 0；`--safe-*` 保留；vitest 24 文件全绿 |
| B2 | 菜单注册表+菜单栏 | `settings.ts` · 新 `menu-registry.ts`/`action-dispatch.ts`/`MenuBar.svelte` · `App.svelte` · `style.css` | `ActionDef` 既有 4 字段与 `DEFAULT_SHORTCUTS` **零改动**；App.svelte 行数不增（目标净减 ≥150）；八组菜单全条目可点；重复 accel 检测为空 |
| B3 | 命令面板 | 新 `command-palette.ts`/`CommandPalette.svelte` · `App.svelte` · `fs.ts` | Ctrl+P/Ctrl+Shift+P；三源分组上限 6/5/4；Esc 后焦点回编辑器 |
| B4 | 大纲+视图模式 | 新 `outline.ts`/`OutlinePanel.svelte` · `App.svelte` · `SettingsModal.svelte` | 100KB 抽取 <2ms；跳行误差 ≤1；三态切换内容/滚动不丢 |
| B5 | 渲染补强+右键+导出 | `App.svelte`(initMd) · `sanitize.ts` · 新 `ExportDialog.svelte` · `fs.ts` | 任务列表点击回写 `[ ]↔[x]`；XSS 用例仍全拦；导出两处入口收敛为一个对话框 |
| B6 | 组件换肤+图标 | `style.css` 组件区 · `editor.ts` · `scripts/icon-design/icon-design.svg` · `src-tauri/icons/` | 深度归位 L0–L4 无第 6 种表面；圆角 14/16；图标/brand 主色 `#7A6EE0→#5B4FD0`；先备份 icons.bak |
| B7 | 回归 | `__tests__/` · E2E 脚本 | 全绿；E2E 亮/暗双跑；主 chunk 增幅 <15% |

## 4. 一致性铁律（违反即打回）

1. **表面色 = 页面色**：禁卡片换底色；层级只靠光影（`--rs`/`--is`）与 1px 分栏线表达
2. **光源恒左上 45°**：凸=右下投影+左上白辉；内嵌=反向。禁止反转
3. **选中态 = 内嵌语义**：tint 12% 染色 + 左 2px `--p` 竖条（CM6 同款近似）
4. **令牌即唯一**：新代码禁止硬编码色值/阴影/圆角，一律 `var(--*)`；禁止新增未在 §1 定义的令牌
5. **App.svelte 纪律**：新功能必须抽组件文件；App.svelte 只留挂载与分发
6. **类名前纪律**：新组件类加语义前缀（`mb-` 菜单栏 · `cp-` 命令面板 · `ol-` 大纲 · `sb-` 侧栏 · `ed-` 编辑器 · `ex-` 导出），复用既有类优先
7. **零方案偏离**：任何与设计文档/本文档不符的实现，先上报主理人，不许自行变通

## 5. 标准验证序列（每批必跑）

```bash
cd E:/project/LiteMD
NODE_OPTIONS="" npx vitest run          # 全量测试
NODE_OPTIONS="" npm run build           # 生产构建
# B1 附加：旧令牌名归零校验
grep -rn 'var(--\(accent\|panel\|border\|text\|text-2\|text-3\|muted\|pill\|bg-soft\|danger\|success\|warning\|tree-guide\|toast-bg\)\b' src --include='*.css' --include='*.svelte' || echo CLEAN
```

## 6. 沟通规则

- 每个 agent 完成后回传：改动文件清单 + 验证输出摘要 + 已知问题
- 发现方案问题（如技术不可行）→ 停止该点，上报主理人，不许自行改方案
- 跨批依赖（如 B5 依赖 B2 注册表）→ 在回传中明确标注接口假设
