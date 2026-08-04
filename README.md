# LiteMD

超轻量 Markdown 编辑器，专注**大文档流畅编辑**与**低资源占用**。目标平台：**x86 Windows / x86 Linux / ARM Linux**。

> 版本 v0.1.0 · 技术栈：Rust + Tauri 2.x + Svelte 4 + CodeMirror 6

## 特性

**编辑体验**

- 三栏布局：左侧文件树 / 中间源码编辑器 / 右侧实时预览，两侧可折叠
- 多标签编辑：标签内保存各自状态，会话级恢复（未保存内容、光标位置也会恢复）
- 预览编辑模式：直接在渲染后的预览上编辑，改动经 turndown 回写 Markdown
- 智能换行：`Enter` 自动跳出表格 / 代码块 / 引用块；`Shift+Enter` 软换行（表格格内插 `<br>`、引用保留前缀）
- 表格增强：一键插入模板、复制当前行、追加列、列对齐（左/中/右）
- 有序列表自动重编号：删除整行后自动修正后续编号
- 格式刷：检测并套用加粗 / 斜体 / 下划线 / 删除线 / 行内代码的包裹标记
- 行内快捷按钮：光标所在行左侧 ⚡ 弹出格式化菜单
- 颜色标记：字体色 / 背景色（HTML `<span style>`）

**大文档（核心卖点，实测支撑 20MB+）**

- 分片流式载入：>8MB 文件头片先出字，剩余内容经 Rust Channel 分片推送，空闲帧逐片追加，任何一帧不超预算
- 增量切块预览：打字只重切脏区间（1MB 打字增量管线中位数 1.85ms；2MB 击键路径全 O(1)）
- 虚拟化预览 + 高度记忆：只渲染视口附近块，滚动不掉帧
- 超大文档降级：超过阈值（默认 2048KB，可调）自动暂停实时预览，改为手动刷新
- 低端设备检测：自动识别集显 / ≤4GB 内存 / ≤4 核，套用更激进的降级矩阵

**文件与图片**

- 自动保存（默认防抖 800ms，可配 300~3000ms），状态栏提示「已自动保存」
- 导出 HTML / PDF（PDF 由 Rust 侧 pulldown-cmark + printpdf 渲染，A4 自动换行分页、自动匹配系统中文字体）
- 粘贴图片自动收编：Worker 解码 / 降采样 / WebP 编码，主线程零阻塞；内容哈希命名天然去重；JPEG/PNG 可选压缩（压缩后更小才采用）
- 本地图片经 Tauri asset 协议渲染，图片尺寸索引避免加载完成滚动跳变
- 孤儿附件清理：删除未被任何 Markdown 引用的图片（正则精确匹配，宁可漏删不误删）
- 跨文件查找 / 替换：全文件夹扫描（结果上限 2000 条），批量替换带 `.bak` 原子回滚

**文件树**

- 二级文件夹结构 + 虚拟化渲染（3000+ 文件不卡顿）
- 右键管理：新建文件 / 文件夹、删除、移动、复制、隐藏（可管理取消隐藏）

**自定义**

- 快捷键设置面板：30 个动作全可重绑定，冲突检测、Esc 取消、单条 / 全部恢复默认
- 浅色 / 深色主题，字号 11~24px 可调，专注模式（F11 隐藏两侧栏）

## 技术架构

| 层 | 选型 | 说明 |
|----|------|------|
| 应用外壳 | Tauri 2.x | 复用系统 WebView，安装包仅数 MB |
| 前端 | Svelte 4 + Vite 5 | 编译期优化、运行时极小 |
| 编辑器 | CodeMirror 6 | liteSetup + 14 种语言白名单按需加载 |
| 预览 | markdown-it + hljs | 动态 import，启动不加载解析器 |
| 后端 | Rust，28 命令 | 文件 / 图片 / 搜索 / 导出 / 设置 |
| 持久化 | settings.json | 临时文件 + rename 原子写入 |
| 打包 | cargo 交叉编译 | 一条命令出三端安装包 |

**设计要点**

- 前端只负责渲染与交互，文件读写、自动保存、图片处理、设置持久化全部在 Rust 命令内完成，符合 Tauri 安全模型
- 编辑器选型：**CodeMirror 6 优于 Vditor**（独立预览栏架构、keymap 可编程对接快捷键面板、包体约 1/3），对比见 `EDITOR-SELECTION.md`
- 快捷键数据驱动：`settings.ts` 快捷键注册表 → App 层转 CodeMirror keymap（Compartment 热更新），文件/视图键走窗口级事件匹配
- 安全收紧：最小白名单 CSP（`script-src 'self'`），设置字段逐一清洗（附件目录名防路径穿越），快捷键符号键按物理键位归一化
- release profile：`opt-level = 3`（速度优先）+ `lto` + `strip` + `panic = "abort"`

## 快捷键（默认值，可在「设置 → 快捷键」重绑定）

| 动作 | 键位 |
|------|------|
| 新建笔记 | `Ctrl + N` |
| 打开文件 | `Ctrl + O` |
| 打开文件夹 | `Ctrl + Shift + O` |
| 保存 | `Ctrl + S` |
| 另存为 | `Ctrl + Shift + S` |
| 导出 | `Ctrl + E` |

### 编辑

| 动作 | 键位 |
|------|------|
| 撤销 | `Ctrl + Z` |
| 重做 | `Ctrl + Y` |
| 查找 | `Ctrl + F` |
| 替换 | `Ctrl + H` |
| 复制表格行到下方 | `Alt + Enter` |

### 格式

| 动作 | 键位 |
|------|------|
| 加粗 | `Alt + B` |
| 斜体 | `Ctrl + I` |
| 下划线 | `Ctrl + U` |
| 删除线 | `Ctrl + Shift + X` |
| 插入链接 | `Ctrl + K` |
| 一级 ~ 五级标题 | `Alt + 1` ~ `Alt + 5` |
| 引用 | `Alt + >` |

### 插入

| 动作 | 键位 |
|------|------|
| 插入图片 | `Alt + Q` |
| 插入代码块 | `Alt + W` |
| 插入表格 | `Alt + E` |
| 表格添加列 | `Alt + \` |
| 无序号列表 | ``Alt + ` `` |

### 视图

| 动作 | 键位 |
|------|------|
| 切换预览 / 分屏 | `Ctrl + \` |
| 专注模式 | `F11` |
| 增大字号 | `Ctrl + =` |
| 减小字号 | `Ctrl + -` |

## 目录结构

```
LiteMD/
├── index.html                  # Vite 入口
├── package.json                # 前端依赖与脚本
├── vite.config.ts / tsconfig.json / svelte.config.js
├── src/                        # 前端（Svelte + TS）
│   ├── App.svelte              # 主界面：布局 / 标签 / 文件树 / 预览管线 / 自动保存
│   ├── editor.ts               # CodeMirror 6 封装：liteSetup、主题字号热切换、格式化命令、数据驱动 keymap、分片流式载入
│   ├── settings.ts             # 设置模型 + 快捷键注册表（纯数据，无 Tauri 依赖）
│   ├── settings-store.ts       # 设置持久化桥接（Tauri invoke / localStorage 回退）
│   ├── SettingsModal.svelte    # 设置面板（通用/编辑器/外观/快捷键/导出/关于，快捷键可重绑定）
│   ├── FolderSearch.svelte     # 跨文件查找 / 替换面板
│   ├── fs.ts                   # Tauri 命令的 invoke 桥接
│   ├── highlight.ts            # highlight.js core + 语言白名单按需加载
│   ├── lowend.ts               # 低端设备检测 + 降级矩阵
│   ├── search-panel.ts         # 中文查找/替换面板（替代 CM6 默认英文面板）
│   ├── image-dims.ts           # 图片尺寸索引（防预览滚动跳变）
│   ├── image-worker-client.ts  # 粘贴图片 Worker 转码客户端
│   ├── fence-index.ts          # 代码块围栏检查点索引（智能换行判定加速）
│   ├── chunk-ranges.ts         # 分片载入区间计算（纯模块可单测）
│   ├── preview-edit-keys.ts    # 预览编辑模式键盘增强
│   ├── commands/               # 工具栏命令：format / file / search
│   ├── preview/                # 预览渲染管线：block-splitter（增量切块）、windowing（虚拟化）、VirtualPreview.svelte
│   └── workers/                # image-worker（OffscreenCanvas 转码）
├── src-tauri/                  # Rust 后端（Tauri）
│   ├── Cargo.toml              # tauri / dialog / image / base64 / regex / pulldown-cmark / printpdf / owned_ttf_parser
│   ├── tauri.conf.json         # 窗口 1280×800、最小白名单 CSP、asset 协议、NSIS 简体中文安装器
│   ├── capabilities/           # 插件权限（dialog:default）
│   └── src/lib.rs              # 28 个 Tauri 命令（文件/树/图片/搜索替换/导出/设置）
├── scripts/                    # 性能基准与回归测试（Node 24 原生 TS 直跑）
│   ├── perf-bench.mjs          # 5 档文档切块/增量管线基准
│   ├── splitter-equiv-test.mjs # 切块算法等价回归（29 用例）
│   ├── splitter-incr-test.mjs  # 增量切块正确性回归（7 类用例）
│   └── test-*.mjs / bench-*.mjs
├── docs/                       # P0 验收清单、50MB 大文档性能方案
├── EDITOR-SELECTION.md         # 编辑器选型：CodeMirror 6 vs Vditor
├── SCAFFOLD.md                 # 脚手架方案与依赖清单
├── PERF.md                     # 性能优化实验记录（三轮，含最终基准数据）
└── MarkLite-快捷键设置-spec.md # 快捷键设置页 UI 设计规格
```

## 开发前置

- Rust 工具链（<https://rustup.rs>）
- Node.js 18+（性能测试脚本需要 Node 24 原生 TS stripping）
- 系统 WebView：Windows 自带 WebView2；Linux 需 `webkit2gtk-4.1-dev` 等依赖

## 运行与构建

```bash
npm install          # 安装前端依赖
npm run tauri dev    # 开发模式（热更新，窗口 1280×800）
npm run tauri build  # 生产构建（当前平台安装包）
```

### 交叉编译到 ARM Linux

```bash
rustup target add aarch64-unknown-linux-gnu
npm run tauri build -- --target aarch64-unknown-linux-gnu
```

Linux 构建机前置依赖（Debian/Ubuntu）：

```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget \
  file pkg-config libssl-dev libayatana-appindicator3-dev librsvg2-dev
sudo apt install gcc-aarch64-linux-gnu   # ARM64 交叉工具链
```

## 性能测试

```bash
node scripts/perf-bench.mjs            # 切块/增量管线基准（200KB ~ 20MB）
node scripts/splitter-equiv-test.mjs   # 切块等价回归（29 用例）
node scripts/splitter-incr-test.mjs    # 增量切块正确性回归
node scripts/test-stream.mjs           # 分片载入区间
```

代表性基准（详见 `PERF.md`）：1MB 文档全流程预览管线 5.3ms、打字增量 1.85ms；2MB 击键路径全 O(1)；5MB 打开即用（切块移出首帧）；冷启动主 chunk 652KB（gzip 229KB），markdown-it 独立 chunk 按需加载。

## 相关文档

- **EDITOR-SELECTION.md** — 编辑器内核选型对比与结论
- **SCAFFOLD.md** — 脚手架方案、依赖清单、Tauri 配置说明
- **PERF.md** — 性能优化实验记录与最终基准
- **docs/P0-验收清单.md** — 真机验收清单（A~G 分组）
- **docs/perf-50mb-plan.md** / **docs/perf-50mb-spec.md** — 50MB 大文档性能目标与方案
- **MarkLite-快捷键设置-spec.md** — 快捷键设置面板 UI 设计规格
