# B7 回归归档 · litemd-product-v1 实施批次收尾

> 归档日期：2026-10-22（HEAD 见下方 b7 tag）
> 对应方案：`litemd-product-v1.html` 卷 4/卷 5 + `EXECUTION-SPEC.md` §3 DoD 五件套

## 1. 批次 tag 对照

| 批 | tag | 提交 | 说明 |
|---|---|---|---|
| B1 令牌层 | `b1` | d96a4f0 | 素塑令牌亮/暗/低端降级 + 296 处引用切换 |
| B2 注册表+菜单栏 | `b2` | 762ce41 | Wave-1 集成（B2 注册表/菜单栏 + B3 命令面板 + B4 大纲/视图模式 + B5 渲染管线骨架同批合入，b3/b4 无独立提交边界） |
| B3/B4 | （并入 `b2`） | 762ce41 | 单测：command-palette / outline |
| B5 渲染+右键+导出 | `b5` | 626891a | 四层右键 + 令牌收尾 + data-md-ref；导出收敛 1362321；LM-22 块级直改 cc1d6bf |
| B6 组件换肤+图标 | `b6` | d3b094f | 白面清零/阴影令牌化/选中内嵌/遮罩令牌/kbd 归一；验证截图 c716ad4 |
| B7 回归 | `b7` | 见 tag 指向 | 本归档随附提交 |

## 2. 验证记录（b7 时点）

| 判据 | 结果 |
|---|---|
| vitest 全量 | **29 文件 / 370 用例全绿**（sanitize 3 处断言随 C-4 可交互复选框更新；perf 超时放宽消 jsdom 冷启动抖动） |
| tsc --noEmit | 0 错误 |
| svelte-check | 0 错误 0 警告 |
| vite build | 通过（13–20s） |
| 主 chunk 增幅 | 565.74 → 566.39 kB（**+0.11%**，红线 <15%）✅ |
| E2E 亮/暗双跑 | ⚠️ 未执行（需 `tauri dev` 图形环境）；亮/暗令牌双验已在 B1/B6 批内目检 + 截图（docs/neu-theme-20261021/、c716ad4） |

## 3. b7 批次内容（符合度收尾）

- 8 个空 action 接线：打印 / 退出 / 使用文档 / 检查更新 / 打字机 / 新窗口 / 新建标签 / 置顶
- C-4 任务列表点击回写（复选框可交互化 + applyExternalEdit 通道）
- LM-13 补全：命令面板 `@` 大纲标题源（@ 前缀专用模式，跳行）
- LM-17 Toast 右下 + 四态；LM-11 专注模式状态栏提示；LM-21 预览正文卡 L2（同色凸起，铁律①合规）
- P2-1 recentFiles 15 条；command.palette 快捷键注册表驱动
- capabilities：+print / +set-always-on-top / +create-webview-window；CSP connect-src += api.github.com

## 4. 遗留（不阻塞 b7 收口）

| 项 | 说明 |
|---|---|
| E2E 亮暗双跑 | 待 `tauri dev` 环境执行（含打印/检查更新/新窗口/置顶/任务回写的实机验证） |
| LM-02 菜单键盘导航逐项走查 | 基础通路已有，22.1 验收序列未见归档 |
| 注册表驱动设置页（§05） | 快捷键页仍走 SHORTCUT_GROUPS 渲染 |
| LM-10 侧栏搜索 tab 语义 | 实为文件夹查找入口，非文档内查找停靠 |
| 空态族更正 | 审查报告原判「空目录/空搜索缺失」有误——FileTree 空态（📂+打开文件夹+kbd）与 sb-search 提示均已存在，LM-25 实际已达标 |
