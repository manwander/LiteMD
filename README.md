# LiteMD

超轻量化 Markdown 编辑器，目标平台：**x86 Windows / x86 Linux / ARM Linux**。

## 技术栈

- **Rust + Tauri 2.x** — 复用系统 WebView，安装包仅几 MB，原生支持三端（含 ARM64 Linux）
- **Svelte 4 + Vite** — 前端框架（轻量、编译期优化）
- **markdown-it + highlight.js** — Markdown 解析与实时预览（代码块高亮）
- **CodeMirror 6** — 编辑器内核（源码式 Markdown 编辑、分屏、命令式快捷键）
  - 选型对比见 `EDITOR-SELECTION.md`，结论：**CodeMirror 6** 优于 Vditor

## 目录结构

```
LiteMD/
├── index.html
├── package.json
├── vite.config.ts
├── tsconfig.json
├── src/                  # 前端（Svelte）
│   ├── main.ts
│   ├── App.svelte        # 三栏布局：文件树 / 编辑器 / 预览（两侧可折叠，浅/深主题）
│   ├── editor.ts         # CodeMirror 6 封装：创建/主题切换/格式化命令
│   └── style.css
├── src-tauri/            # Rust 后端（Tauri）
│   ├── Cargo.toml
│   ├── build.rs
│   ├── tauri.conf.json
│   ├── icons/
│   └── src/{main.rs,lib.rs}
└── MarkLite-快捷键设置-spec.md   # 设计规格（快捷键设置页）
```

## 开发前置

- Rust 工具链（<https://rustup.rs>）
- Node.js 18+
- 系统 WebView：Windows 自带 WebView2；Linux 需 `webkit2gtk-4.1-dev` 等依赖

## 运行

```bash
npm install          # 安装前端依赖
npm run tauri dev    # 启动开发模式（热更新）
```

## 构建安装包

```bash
npm run tauri build  # 产出当前平台安装包
```

### 交叉编译到 ARM Linux

在 x86 Linux 上添加目标后构建：

```bash
rustup target add aarch64-unknown-linux-gnu
npm run tauri build -- --target aarch64-unknown-linux-gnu
```

（Windows / macOS 主机交叉编译 ARM Linux 需配置对应 cross 工具链。）

## 设计稿

完整 UI 设计在 Ardot「MarkLite 编辑器设计」文件中，关键规格见
`MarkLite-快捷键设置-spec.md`。布局为左二级文件夹树 / 中编辑器 / 右实时预览，
两侧可折叠；支持浅 / 深双主题。
