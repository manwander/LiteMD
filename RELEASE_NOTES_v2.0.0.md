# LiteMD v2.0.0

> 附件系统重构 · 2026-08-25

超轻量 Markdown 编辑器，专注**大文档流畅编辑**与**低资源占用**。基于 Rust + Tauri 2 + Svelte 4 + CodeMirror 6，安装包仅 ~3MB。

* * *

## 🎉 本版本核心：按文档隔离的附件系统

v2.0.0 重做了附件管理模型，默认采用**「每篇文档独立附件目录」**方案：

- 编辑 `测试.md` 时，所有图片自动收编进同级的 **`测试_attachment/`** 目录；
- `A.md` 的图片只进 `A_attachment`、`B.md` 的图片只进 `B_attachment`，**同目录多文档互不串门**；
- 附件目录名由模板 `{filename}_attachment` 自动生成，可在设置中自定义。

### 文件管理器联动

- **移动联动**：在文件管理器里移动 `测试.md`，其 `测试_attachment/` 会一起搬走，相对引用始终保持有效；
- **重命名联动**：重命名 `测试.md` → `B.md` 时，`测试_attachment/` 自动重命名为 `B_attachment/`，并**精确改写文档内所有图片引用**（打开中的文档实时同步，不会出现裂图）；
- **隔离不串门**：多文档并存时，图片严格落在各自文档的附件目录内，不会误存到其它文档目录。

### 两种组织方式可切换

设置面板新增「附件组织方式」：

- **每篇文档独立**（默认）：`文件名_attachment/` 与文档同级；
- **统一目录**：所有文档共用一个附件目录（兼容 v1.x 习惯）。

文件管理器中，附件目录会根据当前模式**自动隐藏**，保持目录整洁。

* * *

## ✨ 其它新增与优化

### 关于页 & 仓库链接

- 关于页版本号改为**动态读取**（来自 `tauri.conf.json`，不再硬编码）；
- 新增 **GitHub / Gitee** 仓库链接，点击即用系统默认浏览器打开：
  - https://github.com/manwander/LiteMD
  - https://gitee.com/manwander/LiteMD

### 导出内嵌图片的自包含 Markdown

- 新增「文件 → 导出 → 自包含 Markdown（图片内嵌）」：把当前文档连同其引用的本地图片打包成**单个 `.md` 文件**，图片以 base64 `data:` URI 内嵌；
- 导出的文件用任意桌面 Markdown 软件（Typora / VS Code / Obsidian 等）打开即显示图片，**无需附带附件文件夹**，方便分享与归档；
- 外链图片（`http://`、已内嵌的 `data:` 等）原样保留，读取失败的本地图片保留原路径并提示。

### 安全加固（来自全栈代码深度体检）

### 安全加固（来自全栈代码深度体检）

- 文件新建 / 移动 / 复制 / 重命名命令补充 `validate_path` 校验，杜绝 `../` 路径穿越；
- 前端新建文件 / 文件夹名称增加非法字符清洗（过滤 `/ \ : * ? " < > |` 及 `..`）；
- `reveal_in_explorer` 改用 `.arg()` 写法，消除特殊路径下的参数注入风险；
- 网络盘（UNC `\\server\share`）图片可被正常收编为相对引用。

### 界面与安装包

- 品牌标题改为**靛蓝渐变文字**，与应用图标风格统一；
- NSIS 安装向导支持**中文**；
- `setup.exe` 自带应用图标。

* * *

## 🐛 本版本修复

问题 | 状态
--- | ---
设置面板点击崩溃（`filename is not defined`，无法打开设置） | ✅ 已修复
Shift+Alt+1 创建有序列表后光标跳到行首之前 | ✅ 已修复
旧版「迁移附件文件夹」因概念冲突导致的命名不一致（`assets` vs `_attachment`） | ✅ 已重构为按文档隔离模型

* * *

## 📦 安装

**Windows x64** 用户，下载下方任一安装包：

文件 | 说明 | 大小
--- | --- | ---
`LiteMD_2.0.0_x64-setup.exe` | NSIS 安装程序（推荐） | 3.0 MB
`LiteMD_2.0.0_x64_en-US.msi` | MSI 安装包 | 4.0 MB

系统要求：Windows 10/11 x64（系统自带 WebView2）

* * *

## 🔧 技术栈

Rust · Tauri 2.x · Svelte 4 · Vite 5 · CodeMirror 6 · markdown-it · highlight.js

安装包仅数 MB —— 复用系统 WebView，无 Electron 臃肿依赖。

* * *

## 🔗 仓库与文档

- GitHub：https://github.com/manwander/LiteMD
- Gitee：https://gitee.com/manwander/LiteMD
- 详细文档见仓库：`README.md` · `PERF.md` · `EDITOR-SELECTION.md`
