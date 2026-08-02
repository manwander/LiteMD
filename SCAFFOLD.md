# LiteMD 项目脚手架方案

> 超轻量 Markdown 编辑器 · 目标平台：**x86 Windows / x86 Linux / ARM Linux**
> 技术栈：**Rust + Tauri 2.x** + **Svelte 4 + Vite** + **CodeMirror 6**（编辑器内核）+ **markdown-it**（预览）
> 编辑器选型结论见 `EDITOR-SELECTION.md` —— 最终采用 **CodeMirror 6**。

---

## 1. 技术栈总览

| 层 | 选型 | 作用 |
|----|------|------|
| 应用外壳 | Tauri 2.x (Rust) | 复用系统 WebView，不打包 Chromium，安装包仅数 MB |
| 前端框架 | Svelte 4 + Vite | 编译期优化、运行时极小、启动快 |
| 编辑器内核 | **CodeMirror 6** | 源码式 Markdown 编辑、分屏、命令式快捷键 |
| 预览解析 | markdown-it + highlight.js | 轻量、插件化、代码块高亮 |
| 本地存储 | Tauri `fs` + JSON/TOML | 笔记目录、设置项、自动保存落盘 |
| 打包分发 | `tauri-build` + `cargo` 交叉编译 | 一条命令出三端安装包 |

---

## 2. 目录结构

```
LiteMD/
├── index.html                  # Vite 入口 HTML，挂载 #app
├── package.json                # 前端依赖与脚本（dev/build/tauri）
├── vite.config.ts              # Vite + Svelte 配置（端口 1420，忽略 src-tauri 热更）
├── tsconfig.json               # TypeScript 配置
├── README.md                   # 项目说明与运行指引
├── SCAFFOLD.md                 # 本文件：脚手架方案
├── EDITOR-SELECTION.md         # 编辑器选型对比与结论
├── MarkLite-快捷键设置-spec.md # UI 设计规格（快捷键设置页）
│
├── src/                        # 前端（Svelte + TS）
│   ├── main.ts                 # 应用入口，挂载 App
│   ├── App.svelte              # 三栏布局：文件树 / 编辑器 / 预览（两侧可折叠）+ 全局快捷键
│   ├── editor.ts               # CodeMirror 6 封装：创建/外观(主题+字号)热切换/格式化命令/数据驱动 keymap
│   ├── settings.ts             # 设置模型 + 快捷键注册表（纯数据，无 Tauri 依赖）
│   ├── settings-store.ts       # 设置持久化桥接（Tauri invoke；浏览器调试回退 localStorage）
│   ├── SettingsModal.svelte    # 设置面板（900×640：通用/编辑器/外观/快捷键/导出/关于，快捷键可重绑定）
│   ├── highlight.ts            # 预览代码高亮：highlight.js core + 语言白名单（全部按需加载）
│   ├── fs.ts                   # 文件 IO / 对话框 / 文件树 / 设置的 invoke 桥接
│   ├── vite-env.d.ts           # Svelte / Vite 类型声明
│   └── style.css               # 全局样式与浅/深双主题变量
│
└── src-tauri/                  # Rust 后端（Tauri）
    ├── Cargo.toml              # Rust 依赖（tauri/serde），release 体积优化
    ├── build.rs                # Tauri 构建脚本（生成上下文）
    ├── tauri.conf.json         # Tauri 配置（窗口/打包/图标/CSP）
    ├── icons/                  # 应用图标（32/128/128@2x/icon PNG）
    ├── .gitignore
    └── src/
        ├── main.rs             # 二进制入口，调用 run()
        └── lib.rs              # Tauri Builder：后续扩展文件 IO / 自动保存 / 设置命令
```

设计要点：前端只负责「渲染与交互」，所有文件读写、自动保存、设置持久化都放在 `src-tauri/src/lib.rs` 的 Rust 命令里，符合 Tauri 安全模型。

---

## 3. Tauri 配置（src-tauri/tauri.conf.json）

关键字段说明：

| 字段 | 值 | 说明 |
|------|----|------|
| `productName` / `version` | `LiteMD` / `0.1.0` | 产品名与版本，决定安装包名 |
| `identifier` | `com.litemd.app` | 应用唯一标识（macOS/Linux 包名） |
| `build.devUrl` | `http://localhost:1420` | 开发时 Vite 服务地址 |
| `build.beforeDevCommand` | `npm run dev` | 启动前端开发服务器 |
| `build.frontendDist` | `../dist` | 生产构建产物目录 |
| `app.windows[0]` | 1280×800, min 800×600, label `main` | 主窗口尺寸，匹配设计稿；label 需匹配 capabilities |
| `app.security.csp` | 最小白名单（见下方） | 生产与开发均启用；开发期放行 localhost 供 HMR |
| `bundle.targets` | `all` | 按平台产出 msi / deb / AppImage 等 |
| `bundle.icon` | 4 个 PNG | 各分辨率图标 |

> ✅ 已启用最小白名单 CSP：
> `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost ws://localhost:1420 http://localhost:1420`
> 说明：脚本仅放行应用自身（`'self'`）；样式允许内联（Svelte 注入 + CodeMirror）；`connect-src` 放行 Tauri IPC 与开发期 HMR。

### 三端目标与交叉编译矩阵

| 目标平台 | Rust target | 系统 WebView 依赖 | 构建命令 |
|----------|-------------|-------------------|----------|
| x86 Windows | `x86_64-pc-windows-msvc` | WebView2（系统自带） | `npm run tauri build` |
| x86 Linux | `x86_64-unknown-linux-gnu` | webkit2gtk-4.1-dev | `npm run tauri build` |
| ARM Linux | `aarch64-unknown-linux-gnu` | webkit2gtk-4.1-dev (arm64) | `npm run tauri build -- --target aarch64-unknown-linux-gnu` |

前置（Linux 构建机）：
```bash
# Debian/Ubuntu
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget \
  file pkg-config libssl-dev libayatana-appindicator3-dev librsvg2-dev
# ARM64 交叉工具链
rustup target add aarch64-unknown-linux-gnu
sudo apt install gcc-aarch64-linux-gnu
```

---

## 4. 依赖清单

### 4.1 前端（package.json）

| 依赖 | 版本 | 用途 |
|------|------|------|
| `@tauri-apps/api` | ^2.0.0 | 调用 Tauri 命令、窗口/对话框 API |
| `markdown-it` | ^14.1.0 | Markdown → HTML 实时预览 |
| `highlight.js` | ^11.9.0 | 预览区代码块高亮（core + 白名单按需加载） |
| `@codemirror/view` / `state` | ^6.x | 编辑器视图、keymap、状态/Compartment |
| `@codemirror/commands` | ^6.5.0 | 历史/缩进/基础命令 |
| `@codemirror/autocomplete` | ^6.16.0 | 自动补全（自组 setup 必需） |
| `@codemirror/search` | ^6.5.0 | 查找/替换（Ctrl+F / Ctrl+H） |
| `@codemirror/language` | ^6.10.0 | 语言支持基础（LanguageDescription） |
| `@codemirror/lang-markdown` | ^6.2.0 | Markdown 语法高亮 |
| `@codemirror/lang-{javascript,json,html,css,python,rust,go,java,cpp,sql,xml,yaml}` | ^6.x | 代码块语言白名单（动态 import 按需加载） |
| `@codemirror/legacy-modes` | ^6.4.0 | Shell 等 legacy 模式 |
| `@codemirror/theme-one-dark` | ^6.1.0 | 深色主题 |

> 说明：不再引入 `@codemirror/language-data` 全量（60+ 语言 → 60+ 异步 chunk），
> 改为 `src/editor.ts` 内手写白名单（14 种常用语言），体积与启动均更优。

| devDependencies | 版本 | 用途 |
|-----------------|------|------|
| `@sveltejs/vite-plugin-svelte` | ^3.1.0 | Svelte + Vite 集成 |
| `@tauri-apps/cli` | ^2.0.0 | Tauri 命令行（dev/build） |
| `svelte` | ^4.2.0 | 前端框架 |
| `typescript` | ^5.6.0 | 类型检查 |
| `vite` | ^5.4.0 | 前端构建/开发服务器 |

### 4.2 Rust 后端（Cargo.toml）

| 依赖 | 版本 | 用途 |
|------|------|------|
| `tauri` | 2 | 应用框架（窗口/命令/事件） |
| `tauri-plugin-dialog` | 2 | 原生文件/文件夹打开与保存选择器 |
| `serde` | 1 (derive) | 命令参数/返回值序列化 |
| `serde_json` | 1 | JSON 解析（设置读写） |
| `tauri-build` | 2 (build) | 构建期代码生成 |

> ⚠️ 自定义 `#[tauri::command]` 默认对所有窗口开放，**无需**逐个加权限；
> 但 `tauri-plugin-dialog` 需在 `src-tauri/capabilities/*.json` 中授予 `dialog:default`
> （见 `src-tauri/capabilities/default.json`）。

`[profile.release]` 已开启 `opt-level = "s"` / `lto = true` / `strip = true` / `panic = "abort"`，最大化压缩安装包体积，契合「超轻量」定位。

---

## 5. 构建与运行

```bash
# 1) 安装前端依赖
npm install

# 2) 开发模式（热更新，窗口 1280×800）
npm run tauri dev

# 3) 当前平台生产构建
npm run tauri build

# 4) 交叉编译到 ARM Linux
rustup target add aarch64-unknown-linux-gnu
npm run tauri build -- --target aarch64-unknown-linux-gnu
```

---

## 6. 后端能力落地进度

- [x] `lib.rs` Tauri 命令：打开文件/文件夹、保存、另存为、导出（HTML）—— 见 `src-tauri/src/lib.rs`
- [x] 自动保存（防抖写盘 + 状态栏「已自动保存」，延迟可配 300~3000ms）—— `src/App.svelte` `queueAutoSave`
- [x] 真实文件树（读取本地 `.md` 目录，一级文件夹 → 其内 `.md` 二级结构）—— `read_md_tree` + 前端 `tree` 渲染
- [x] 设置持久化：`load_settings` / `save_settings` / `settings_file_path` 落盘到 `app_config_dir/settings.json`
      （临时文件 + rename 原子写入）；前端 `src/settings.ts` 统一模型，App 启动自动恢复主题/字号/目录/文件
- [x] 快捷键设置面板 UI（与 `MarkLite-快捷键设置-spec.md` 对齐）：900×640、左侧导航、分组药丸、
      点击重绑定（冲突检测 / Esc 取消）、单条与全部「恢复默认」—— `src/SettingsModal.svelte`
- [x] 快捷键数据驱动：`src/editor.ts` keymap 按 `shortcuts` 动态构建（Compartment 热更新），
      文件/视图键走窗口级事件匹配，编辑/格式键走 CodeMirror keymap
- [x] 体积优化：`@codemirror/language-data` → 手写语言白名单（动态 import）；
      `highlight.js/lib/common` → core + 白名单（全部异步）；自组 liteSetup 去掉 lint；
      产物主包 914KB → 724KB（gzip 325KB → 267KB），语言/高亮块按需加载
- [x] 安全收紧：`tauri.conf.json` 的 `csp: null` → 最小白名单
      （`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:` + 开发期 localhost）
- [ ] 导出 PDF（当前仅 HTML；PDF 需额外打印/转换方案）
