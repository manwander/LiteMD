# LiteMD

**超轻量 Markdown 编辑器** —— 为「大文档流畅编辑」与「低资源占用」而生。

打开 20MB 文档秒级可用，打字永不卡顿，内存占用仅为 Electron 方案的几分之一。
目标平台：**x86 Windows / x86 Linux / ARM Linux**。

> v2.0.0 · Rust + Tauri 2.x + Svelte 5 + CodeMirror 6
>
> 质量门：`tsc` 0 错误 · `svelte-check` 0 错误 0 警告 · `npm audit` 0 漏洞 · **225/225 单测通过**

---

## 为什么是 LiteMD

| 痛点 | LiteMD 的答案 |
|------|--------------|
| 打开大文件白屏转圈 | 分片流式载入：头片先出字，剩余内容经 Rust Channel 空闲帧逐片追加，任何一帧不超预算 |
| 打字越写越卡 | 增量切块预览：打字只重切脏区间，击键路径全 O(1)，不随文档体积增长 |
| 预览滚动掉帧 | 虚拟化预览 + Fenwick 树高度记忆：只渲染视口附近块 |
| Electron 包体数百 MB | Tauri 复用系统 WebView，安装包仅数 MB |
| 低配设备直接躺平 | 低端设备检测（集显 / ≤4GB 内存 / ≤4 核）自动套用更激进的降级矩阵 |

## 功能特性

### 编辑体验
- **三栏布局**：文件树 / 源码编辑器 / 实时预览，两侧均可折叠
- **多标签编辑**：标签内保存各自状态，会话级恢复（未保存内容、光标位置也会恢复）
- **预览编辑模式**：直接在渲染后的预览上编辑，改动经 turndown 回写 Markdown
- **智能换行**：`Enter` 自动跳出表格 / 代码块 / 引用块；`Shift+Enter` 软换行（表格格内插 `<br>`、引用保留前缀）
- **表格增强**：一键插入模板、复制当前行、追加列、列对齐（左/中/右）
- **有序列表自动重编号**：删除整行后自动修正后续编号
- **格式刷 / 颜色标记**：加粗 / 斜体 / 下划线 / 删除线 / 行内代码包裹；字体色 / 背景色
- **行内快捷按钮**：光标所在行左侧 ⚡ 弹出格式化菜单

### 文件与图片
- **自动保存**：防抖 800ms（可配 300~3000ms），状态栏提示
- **导出 HTML / PDF**：PDF 由 Rust 侧 pulldown-cmark + printpdf 渲染，A4 自动分页、自动匹配系统中文字体
- **粘贴图片自动收编**：Worker 解码 / 降采样 / WebP 编码，主线程零阻塞；内容哈希命名天然去重
- **图片尺寸索引**：本地图片经 asset 协议渲染，预载尺寸避免滚动跳变
- **孤儿附件清理**：删除未被引用的图片（正则精确匹配，宁可漏删不误删）
- **跨文件查找 / 替换**：全文件夹扫描（上限 2000 条），批量替换带 `.bak` 原子回滚

### 文件树与自定义
- 二级文件夹结构 + 虚拟化渲染（3000+ 文件不卡顿）；右键新建 / 删除 / 移动 / 复制 / 隐藏
- **快捷键全可重绑定**：30 个动作、冲突检测、单条 / 全部恢复默认
- 浅色 / 深色主题、字号 11~24px、专注模式（F11）
- **WebDAV 同步**：多文件夹同步，冲突策略（保留双方 / 新者胜），空远端保护防误删

## 性能实测

基准环境：Node 24 原生 TS 直跑 `scripts/perf-bench.mjs`（Windows 11）。

| 文档体积 | 打字增量管线 | 全量切块 | 说明 |
|---------:|-------------:|---------:|------|
| 1MB | **1.4ms** | 3.5ms | 全流程预览管线 5.3ms |
| 2MB | **2.5ms** | 7.6ms | 击键路径全 O(1) |
| 5MB | **6.4ms** | 21.5ms | 打开即用，切块移出首帧 |
| 20MB | 27.6ms* | 冷打开 541ms | *应用内自动走降级模式 |

- 冷启动主 chunk **508KB（gzip 185KB）**，markdown-it 独立 chunk 按需加载，启动不加载解析器
- 性能预算有回归测试看护：sanitizeHtml 2.4ms/块（预算 8ms）、diffRange 0.12ms（预算 6ms）

## 快速开始

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

## 技术架构

| 层 | 选型 | 说明 |
|----|------|------|
| 应用外壳 | Tauri 2.x | 复用系统 WebView，安装包仅数 MB |
| 前端 | Svelte 5 + Vite 8 | 编译期优化、运行时极小 |
| 编辑器 | CodeMirror 6 | liteSetup + 14 种语言白名单按需加载 |
| 预览 | markdown-it + hljs | 动态 import，启动不加载解析器 |
| 后端 | Rust，48 命令 | 文件 / 图片 / 搜索替换 / 导出 / 设置 / WebDAV 同步 |
| 持久化 | settings.json | 临时文件 + rename 原子写入 |
| 打包 | cargo 交叉编译 | 一条命令出三端安装包 |

**设计要点**

- **前后端分工**：前端只负责渲染与交互，文件读写、自动保存、图片处理、设置持久化全部在 Rust 命令内完成，符合 Tauri 安全模型
- **编辑器选型**：CodeMirror 6 优于 Vditor（独立预览栏架构、keymap 可编程对接快捷键面板、包体约 1/3），对比见 `EDITOR-SELECTION.md`
- **快捷键数据驱动**：`settings.ts` 注册表 → App 层转 CodeMirror keymap（Compartment 热更新），文件/视图键走窗口级事件匹配
- **安全收紧**：最小白名单 CSP（`script-src 'self'`）、DOMPurify 白名单收窄、设置字段逐一清洗（附件目录名防路径穿越）、快捷键符号键按物理键位归一化
- **release profile**：`opt-level = 3`（速度优先）+ `lto` + `strip` + `panic = "abort"`

## 快捷键（默认值，可在「设置 → 快捷键」重绑定）

### 文件

| 动作 | 键位 | 动作 | 键位 |
|------|------|------|------|
| 新建笔记 | `Ctrl + N` | 保存 | `Ctrl + S` |
| 打开文件 | `Ctrl + O` | 另存为 | `Ctrl + Shift + S` |
| 打开文件夹 | `Ctrl + Shift + O` | 导出 | `Ctrl + E` |

### 编辑与格式

| 动作 | 键位 | 动作 | 键位 |
|------|------|------|------|
| 撤销 / 重做 | `Ctrl + Z` / `Ctrl + Y` | 加粗 | `Alt + B` |
| 查找 / 替换 | `Ctrl + F` / `Ctrl + H` | 斜体 | `Ctrl + I` |
| 复制表格行到下方 | `Alt + Enter` | 下划线 | `Ctrl + U` |
| 一级 ~ 五级标题 | `Alt + 1` ~ `Alt + 5` | 删除线 | `Ctrl + Shift + X` |
| 引用 | `Alt + >` | 插入链接 | `Ctrl + K` |

### 插入与视图

| 动作 | 键位 | 动作 | 键位 |
|------|------|------|------|
| 插入图片 | `Alt + Q` | 切换预览 / 分屏 | `Ctrl + \` |
| 插入代码块 | `Alt + W` | 专注模式 | `F11` |
| 插入表格 | `Alt + E` | 增大 / 减小字号 | `Ctrl + =` / `Ctrl + -` |
| 表格添加列 | `Alt + \` | 无序号列表 | `` Alt + ` `` |

## 项目结构

```
LiteMD/
├── index.html                  # Vite 入口
├── package.json                # 前端依赖与脚本
├── vite.config.ts / vitest.config.ts / tsconfig.json / svelte.config.js
├── src/                        # 前端（Svelte 5 + TS）
│   ├── App.svelte              # 主界面：布局 / 标签 / 文件树 / 预览管线 / 自动保存
│   ├── editor.ts               # CodeMirror 6 封装：liteSetup、主题字号热切换、格式化命令、keymap、分片流式载入
│   ├── preview/                # 预览渲染管线
│   │   ├── block-splitter.ts   #   增量切块（脏区间重切、分段缓存、零分配行扫描）
│   │   ├── windowing.ts        #   虚拟化（Fenwick 树高度前缀和 + 视口窗口计算）
│   │   └── VirtualPreview.svelte
│   ├── settings.ts             # 设置模型 + 快捷键注册表（纯数据，无 Tauri 依赖）
│   ├── settings-store.ts       # 设置持久化桥接（Tauri invoke / localStorage 回退）
│   ├── fs.ts                   # 48 个 Tauri 命令的 invoke 桥接
│   ├── sanitize.ts             # DOMPurify 白名单收窄（预览/导出唯一安全边界）
│   ├── highlight.ts            # highlight.js core + 语言白名单按需加载
│   ├── lowend.ts               # 低端设备检测 + 降级矩阵
│   ├── tabs.ts / search-panel.ts / fence-index.ts / chunk-ranges.ts
│   ├── attachment.ts / image-dims.ts / image-worker-client.ts / preview-edit-keys.ts
│   ├── workers/                # image-worker（OffscreenCanvas 转码）
│   └── __tests__/              # vitest：23 个文件，225 个用例（含性能预算回归）
├── src-tauri/                  # Rust 后端（Tauri 2）
│   ├── src/lib.rs              # 48 个命令（文件/树/图片/搜索替换/导出/设置/同步）
│   ├── src/sync/               # WebDAV 同步引擎（冲突策略、快照、空远端保护）
│   ├── tauri.conf.json         # 窗口 1280×800、最小白名单 CSP、NSIS 简体中文安装器
│   └── tests/webdav_e2e.rs     # WebDAV 端到端测试
└── scripts/                    # 性能基准与回归（Node 24 原生 TS 直跑）
    ├── perf-bench.mjs          # 5 档文档（200KB~20MB）切块/增量管线基准
    ├── splitter-equiv-test.mjs # 切块算法等价回归（29 用例）
    ├── splitter-incr-test.mjs  # 增量切块正确性回归（7 类用例）
    └── test-*.mjs / bench-*.mjs
```

## 测试与质量

```bash
npm test                                # vitest：225 用例（单元 + 性能预算回归）
npx svelte-check                        # Svelte/TS 诊断（0 错误 0 警告）
npx tsc --noEmit                        # TypeScript 类型检查
npm audit                               # 依赖漏洞扫描（0 漏洞）
npm run build                           # 生产构建验证
```

脚本层回归（Node 24 原生 TS 直跑，无需构建）：

```bash
node scripts/perf-bench.mjs            # 切块/增量管线基准（200KB ~ 20MB）
node scripts/splitter-equiv-test.mjs   # 切块等价回归（29 用例，ALL EQUAL）
node scripts/splitter-incr-test.mjs    # 增量切块正确性回归
node scripts/test-stream.mjs           # 分片载入区间
node scripts/test-fenwick.mjs          # Fenwick 树（5940 断言）
node scripts/test-fence.mjs            # 围栏索引（8 万+ 断言）
```

## 相关文档

- **EDITOR-SELECTION.md** — 编辑器内核选型对比与结论
- **SCAFFOLD.md** — 脚手架方案、依赖清单、Tauri 配置说明
- **PERF.md** — 性能优化实验记录与最终基准
- **MarkLite-快捷键设置-spec.md** — 快捷键设置面板 UI 设计规格
