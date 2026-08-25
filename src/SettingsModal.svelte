<script lang="ts">
  // 设置面板：900 × 640、圆角 14、左侧 180 导航（对齐 MarkLite-快捷键设置-spec.md）
  import { createEventDispatcher, onMount } from "svelte";
  import { getVersion } from "@tauri-apps/api/app";
  import { invoke } from "@tauri-apps/api/core";
  import {
    SHORTCUT_GROUPS,
    DEFAULT_SHORTCUTS,
    FONT_SIZE_MIN,
    FONT_SIZE_MAX,
    accelFromEvent,
    actionLabel,
    displayAccel,
    findConflict,
    normalizeAccel,
    type Settings,
  } from "./settings";

  export let settings: Settings;
  export let configPath = "";
  export let tab: string = "通用";

  const dispatch = createEventDispatcher<{
    close: void;
    change: void;
    pickFolder: void;
    export: void;
  }>();

  const NAV = ["通用", "编辑器", "外观", "快捷键", "导出", "关于"];

  let capturing: string | null = null;
  let message = "";
  let appVersion = "";

  function changed() {
    settings = settings;
    dispatch("change");
  }

  function close() {
    capturing = null;
    dispatch("close");
  }

  onMount(async () => {
    try {
      appVersion = await getVersion();
    } catch {
      appVersion = "";
    }
  });

  function openLink(url: string) {
    invoke("open_external", { url }).catch(() => {});
  }

  function startCapture(id: string) {
    capturing = capturing === id ? null : id;
    message = capturing ? "按下新的组合键，Esc 取消" : "";
  }

  function resetOne(id: string) {
    settings.shortcuts[id] = DEFAULT_SHORTCUTS[id];
    message = `「${actionLabel(id)}」已恢复默认`;
    changed();
  }

  function resetAll() {
    settings.shortcuts = { ...DEFAULT_SHORTCUTS };
    capturing = null;
    message = "所有快捷键已恢复默认";
    changed();
  }

  // 捕获阶段拦截，避免与 App 的窗口级快捷键打架
  function onKeydownCapture(e: KeyboardEvent) {
    if (!capturing) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
      return;
    }
    e.preventDefault();
    e.stopPropagation();

    if (e.key === "Escape") {
      capturing = null;
      message = "已取消";
      return;
    }

    const accel = accelFromEvent(e);
    if (!accel) return; // 只按了修饰键，继续等

    const isFn = /^F\d{1,2}$/.test(accel);
    const hasMod = /^(Ctrl|Alt|Shift)\+/.test(accel);
    if (!isFn && !hasMod) {
      message = "请使用 Ctrl / Alt / Shift 组合键或 F1~F12";
      return;
    }

    const conflict = findConflict(settings.shortcuts, accel, capturing);
    if (conflict) {
      message = `${displayAccel(accel)} 已被「${actionLabel(conflict)}」占用`;
      return;
    }

    settings.shortcuts[capturing] = normalizeAccel(accel);
    message = `「${actionLabel(capturing)}」已设为 ${displayAccel(accel)}`;
    capturing = null;
    changed();
  }

  function bumpFont(delta: number) {
    const next = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, settings.fontSize + delta));
    if (next !== settings.fontSize) {
      settings.fontSize = next;
      changed();
    }
  }
</script>

<svelte:window on:keydown|capture={onKeydownCapture} />

<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
<div class="mask" on:click|self={close}>
  <div class="dialog">
    <nav>
      <div class="nav-title">设置</div>
      {#each NAV as item}
        <button class="nav-item" class:active={tab === item} on:click={() => (tab = item)}>
          {item}
        </button>
      {/each}
    </nav>

    <section class="content">
      <header>
        <h2>{tab}</h2>
        <button class="close" on:click={close} title="关闭 (Esc)">✕</button>
      </header>

      <div class="scroll">
        {#if tab === "快捷键"}
          <p class="desc">点击右侧键位后按下新的组合键即可重绑定；Esc 取消，↺ 恢复该项默认。</p>

          {#each SHORTCUT_GROUPS as group, gi}
            <div class="group" class:first={gi === 0}>
              <div class="group-title">{group.title}</div>
              {#each group.actions as action}
                <div class="row">
                  <span class="row-label">{action.label}</span>
                  <span class="row-right">
                    <button
                      class="pill"
                      class:capturing={capturing === action.id}
                      on:click={() => startCapture(action.id)}
                    >
                      {capturing === action.id
                        ? "按下组合键…"
                        : displayAccel(settings.shortcuts[action.id] ?? "")}
                    </button>
                    <button
                      class="mini"
                      title="恢复默认"
                      disabled={settings.shortcuts[action.id] === DEFAULT_SHORTCUTS[action.id]}
                      on:click={() => resetOne(action.id)}>↺</button
                    >
                  </span>
                </div>
              {/each}
            </div>
            {#if gi < SHORTCUT_GROUPS.length - 1}<div class="divider" />{/if}
          {/each}

        {:else if tab === "通用"}
          <div class="group first">
            <div class="row">
              <span class="row-label">
                自动保存
                <small>编辑停止后自动写回当前文件</small>
              </span>
              <input type="checkbox" bind:checked={settings.autoSave} on:change={changed} />
            </div>
            <div class="row">
              <span class="row-label">
                自动保存延迟
                <small>{settings.autoSaveDelay} ms</small>
              </span>
              <input
                type="range"
                min="300"
                max="3000"
                step="100"
                bind:value={settings.autoSaveDelay}
                on:change={changed}
              />
            </div>
            <div class="row">
              <span class="row-label">
                预览实时阈值
                <small>文档超过 {settings.previewRealtimeMaxKB} KB 后预览改为手动刷新，保障超大文档打字流畅</small>
              </span>
              <input
                type="range"
                min="256"
                max="8192"
                step="256"
                bind:value={settings.previewRealtimeMaxKB}
                on:change={changed}
              />
            </div>
            <div class="row">
              <span class="row-label">
                低端设备降级
                <small>自动按硬件检测；低端模式更激进降级预览/预读/图片转码，保流畅</small>
              </span>
              <select bind:value={settings.lowEndMode} on:change={changed}>
                <option value="auto">自动检测</option>
                <option value="on">强制开启</option>
                <option value="off">强制关闭</option>
              </select>
            </div>
          </div>
          <div class="divider" />
          <div class="group">
            <div class="row">
              <span class="row-label">
                默认目录
                <small class="path">{settings.lastFolder ?? "未设置，启动时不加载目录树"}</small>
              </span>
              <span class="row-right">
                <button class="btn" on:click={() => dispatch("pickFolder")}>选择目录</button>
                <button
                  class="btn"
                  disabled={!settings.lastFolder}
                  on:click={() => {
                    settings.lastFolder = null;
                    changed();
                  }}>清除</button
                >
              </span>
            </div>
            <div class="row">
              <span class="row-label">
                配置文件
                <small class="path">{configPath || "浏览器调试模式：localStorage"}</small>
              </span>
            </div>
          </div>
          <div class="divider" />
          <div class="group">
            <div class="row">
              <span class="row-label">
                附件组织方式
                <small>每篇文档独立：测试.md 的图片存于「测试_attachment/」；统一目录：所有图片进同一个文件夹</small>
              </span>
              <span class="row-right radio-group">
                <label><input type="radio" bind:group={settings.attachmentMode} value="perDocument" on:change={changed} /> 每篇文档独立</label>
                <label><input type="radio" bind:group={settings.attachmentMode} value="shared" on:change={changed} /> 统一目录</label>
              </span>
            </div>
            {#if settings.attachmentMode === "perDocument"}
              <div class="row">
                <span class="row-label">
                  附件目录模板
                  <small>可用 {"{filename}"} 占位文档名（去扩展名），默认 {"{filename}_attachment"}</small>
                </span>
                <span class="row-right">
                  <input
                    class="text-input"
                    type="text"
                    placeholder={`{filename}_attachment`}
                    bind:value={settings.attachmentTemplate}
                    on:change={changed}
                  />
                </span>
              </div>
            {:else}
              <div class="row">
                <span class="row-label">
                  统一附件文件夹名
                  <small>插图时自动复制到笔记目录下的该文件夹，使用相对引用</small>
                </span>
                <span class="row-right">
                  <input
                    class="text-input"
                    type="text"
                    placeholder="_attachment"
                    bind:value={settings.assetsDir}
                    on:change={changed}
                  />
                </span>
              </div>
            {/if}
            <div class="row">
              <span class="row-label">
                收编时压缩图片
                <small>仅 JPEG/PNG；压缩后比原图更小才采用</small>
              </span>
              <input type="checkbox" bind:checked={settings.compressImages} on:change={changed} />
            </div>
            <div class="row">
              <span class="row-label">
                文件树隐藏附件文件夹
                <small>对应附件目录在文件管理器中隐藏（磁盘仍保留）；关闭即显示</small>
              </span>
              <input type="checkbox" bind:checked={settings.hideAttachments} on:change={changed} />
            </div>
            <div class="row">
              <span class="row-label">
                JPEG 压缩质量
                <small>{settings.jpegQuality}（越低体积越小）</small>
              </span>
              <input
                type="range"
                min="50"
                max="95"
                step="5"
                disabled={!settings.compressImages}
                bind:value={settings.jpegQuality}
                on:change={changed}
              />
            </div>
          </div>
        {:else if tab === "编辑器"}
          <div class="group first">
            <div class="row">
              <span class="row-label">
                字号
                <small>{settings.fontSize} px</small>
              </span>
              <span class="row-right">
                <button class="mini" on:click={() => bumpFont(-1)}>−</button>
                <span class="pill">{settings.fontSize}</span>
                <button class="mini" on:click={() => bumpFont(1)}>＋</button>
              </span>
            </div>
            <div class="row">
              <span class="row-label">
                自动换行
                <small>长行自动软折行，不改变文档内容</small>
              </span>
              <input type="checkbox" bind:checked={settings.wrap} on:change={changed} />
            </div>
            <div class="row">
              <span class="row-label">
                启动时展开目录
                <small>下次启动沿用当前布局</small>
              </span>
              <input type="checkbox" bind:checked={settings.showTree} on:change={changed} />
            </div>
            <div class="row">
              <span class="row-label">
                启动时展开预览
                <small>关闭后进入纯写作视图</small>
              </span>
              <input type="checkbox" bind:checked={settings.showPreview} on:change={changed} />
            </div>
          </div>

        {:else if tab === "外观"}
          <div class="group first">
            <div class="row">
              <span class="row-label">
                主题
                <small>影响编辑器与预览区</small>
              </span>
              <span class="row-right">
                <button
                  class="chip"
                  class:on={settings.theme === "light"}
                  on:click={() => {
                    settings.theme = "light";
                    changed();
                  }}>浅色</button
                >
                <button
                  class="chip"
                  class:on={settings.theme === "dark"}
                  on:click={() => {
                    settings.theme = "dark";
                    changed();
                  }}>深色</button
                >
                <button
                  class="chip"
                  class:on={settings.theme === "auto"}
                  on:click={() => {
                    settings.theme = "auto";
                    changed();
                  }}>自动</button
                >
              </span>
            </div>
          </div>

        {:else if tab === "导出"}
          <div class="group first">
            <div class="row">
              <span class="row-label">
                导出 HTML
                <small>内联样式的单文件，可直接分享</small>
              </span>
              <button class="btn" on:click={() => dispatch("export")}>立即导出</button>
            </div>
            <div class="row">
              <span class="row-label">
                导出 PDF
                <small>规划中，将复用系统打印管线</small>
              </span>
              <span class="tag">未实现</span>
            </div>
          </div>

        {:else}
          <div class="group first about">
            <p><b>LiteMD</b> {appVersion || "0.1.0"}</p>
            <p>超轻量 Markdown 编辑器 · Rust + Tauri 2 + Svelte 4 + CodeMirror 6</p>
            <p class="path">配置文件：{configPath || "localStorage（浏览器调试）"}</p>
            <p class="links">
              <button class="link" on:click={() => openLink("https://github.com/manwander/LiteMD")}>https://github.com/manwander/LiteMD</button>
            </p>
            <p class="links">
              <button class="link" on:click={() => openLink("https://gitee.com/manwander/LiteMD")}>https://gitee.com/manwander/LiteMD</button>
            </p>
          </div>
        {/if}
      </div>

      <footer>
        <span class="msg">{message}</span>
        {#if tab === "快捷键"}
          <button class="btn" on:click={resetAll}>恢复默认</button>
        {/if}
        <button class="btn primary" on:click={close}>完成</button>
      </footer>
    </section>
  </div>
</div>

<style>
  .mask {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.35);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }

  .dialog {
    width: 900px;
    height: 640px;
    max-width: calc(100vw - 40px);
    max-height: calc(100vh - 40px);
    display: flex;
    background: var(--bg);
    border-radius: 14px;
    overflow: hidden;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.28);
  }

  /* 左侧导航 180w */
  nav {
    width: 180px;
    flex-shrink: 0;
    background: var(--panel);
    border-right: 1px solid var(--border);
    padding: 12px 8px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .nav-title {
    font-size: 12px;
    color: var(--text-2);
    padding: 4px 10px 10px;
  }

  .nav-item {
    text-align: left;
    padding: 8px 10px;
    border: none;
    background: transparent;
    border-radius: 6px;
    font-size: 14px;
    color: var(--text);
    cursor: pointer;
  }

  .nav-item:hover {
    background: var(--border);
    color: var(--text);
  }

  .nav-item.active {
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 500;
  }

  /* 右侧内容 */
  .content {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 18px 24px 8px;
  }

  h2 {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
  }

  .close {
    border: none;
    background: transparent;
    font-size: 14px;
    padding: 4px 8px;
  }

  .scroll {
    flex: 1;
    overflow: auto;
    padding: 0 24px 16px;
  }

  .desc {
    margin: 0 0 16px;
    font-size: 13px;
    color: var(--text-2);
  }

  .group {
    display: flex;
    flex-direction: column;
    gap: 8px; /* 组内行间距 8 */
  }

  .group-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
    margin-bottom: 2px;
  }

  .divider {
    height: 1px;
    background: var(--border);
    margin: 16px 0; /* 组间分隔 16 */
  }

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    min-height: 28px;
  }

  .row-label {
    font-size: 14px;
    color: var(--text);
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .row-label small {
    font-size: 12px;
    color: var(--text-2);
  }

  .path {
    font-family: "JetBrains Mono", Consolas, monospace;
    font-size: 11px;
    word-break: break-all;
  }

  .row-right {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }

  /* 键位药丸：JetBrains Mono 12 / #F2F3F5 / 圆角 6 / 左右 8 */
  .pill {
    font-family: "JetBrains Mono", "SF Mono", Consolas, monospace;
    font-size: 12px;
    color: var(--text-2);
    background: var(--pill);
    border: 1px solid transparent;
    border-radius: 6px;
    padding: 4px 8px;
    min-width: 96px;
    text-align: center;
    cursor: pointer;
  }

  .pill:hover {
    border-color: var(--accent);
    color: var(--accent);
  }

  .pill.capturing {
    border-color: var(--accent);
    background: var(--accent-soft);
    color: var(--accent);
  }

  .mini {
    width: 24px;
    height: 24px;
    font-size: 12px;
    line-height: 1;
    padding: 0;
  }

  .mini:disabled {
    opacity: 0.35;
    cursor: default;
  }

  .btn {
    padding: 6px 12px;
    font-size: 13px;
    border-radius: 6px;
  }

  .btn:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .btn.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }

  .chip {
    padding: 5px 14px;
    font-size: 13px;
    border-radius: 6px;
  }

  .chip.on {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent);
  }

  .tag {
    font-size: 12px;
    color: var(--text-2);
    background: var(--pill);
    border-radius: 6px;
    padding: 3px 8px;
  }

  footer {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 24px;
    border-top: 1px solid var(--border);
  }

  .msg {
    flex: 1;
    font-size: 12px;
    color: var(--text-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .about p {
    margin: 0 0 8px;
    font-size: 14px;
    color: var(--text-2);
  }

  .about .links {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 12px;
  }

  .about .link {
    background: none;
    border: none;
    padding: 0;
    font-size: 14px;
    color: var(--accent);
    text-decoration: underline;
    cursor: pointer;
  }

  .about .link:hover {
    opacity: 0.8;
  }

  .about .links + .links {
    margin-top: 4px;
  }

  input[type="checkbox"] {
    width: 16px;
    height: 16px;
    accent-color: var(--accent);
  }

  input[type="range"] {
    width: 180px;
    accent-color: var(--accent);
  }

  input[type="range"]:disabled {
    opacity: 0.4;
  }

  .text-input {
    width: 140px;
    padding: 5px 8px;
    font-size: 13px;
    font-family: "JetBrains Mono", Consolas, monospace;
    color: var(--text);
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 6px;
  }

  .text-input:focus {
    outline: none;
    border-color: var(--accent);
  }
</style>
