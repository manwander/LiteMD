// commands/ — 纯函数命令层
// App.svelte 通过这些模块调用编辑器、文件 I/O、搜索功能。
// 编辑器命令 -> editor.ts（CodeMirror）
// 文件 I/O      -> file-commands.ts
// 搜索          -> search-commands.ts
// 格式化工具栏  -> format-commands.ts
export * from "./format-commands";
export * from "./file-commands";
export * from "./search-commands";
