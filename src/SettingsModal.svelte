<script lang="ts">
  // 设置面板：900 × 640、圆角 14、左侧 180 导航（对齐 MarkLite-快捷键设置-spec.md）
  import { createEventDispatcher, onMount } from "svelte";
  import { getVersion } from "@tauri-apps/api/app";
  import { invoke } from "@tauri-apps/api/core";
  import {
    SHORTCUT_GROUPS,
    DEFAULT_SHORTCUTS,
    DEFAULT_SYNC,
    SYNC_INTERVAL_OPTIONS,
    FONT_SIZE_MIN,
    FONT_SIZE_MAX,
    accelFromEvent,
    actionLabel,
    displayAccel,
    findConflict,
    normalizeAccel,
    type Settings,
  } from "./settings";
  import { syncCheckConfig, buildSyncConfig, type CheckReport } from "./sync";

  export let settings: Settings;
  export let configPath = "";
  export let tab: string = "通用";

  const dispatch = createEventDispatcher<{
    close: void;
    change: void;
    pickFolder: void;
    export: void;
    exportPdf: void;
    pickSyncFolder: void;
    syncNow: void;
    syncForce: { mode: "forceUpload" | "forceDownload" };
  }>();

  const NAV = ["通用", "编辑器", "外观", "快捷键", "同步", "导出", "关于"];

  // ---- 同步页状态 ----
  let syncChecking = false;
  let syncReport: CheckReport | null = null;
  let syncErr = "";
  let showAdvanced = false;
  let showPassword = false;
  let forceChoice: "" | "upload" | "download" = "";

  async function doCheckSync() {
    syncChecking = true;
    syncReport = null;
    syncErr = "";
    try {
      syncReport = await syncCheckConfig(buildSyncConfig(settings, []));
    } catch (e) {
      syncErr = String(e);
    } finally {
      syncChecking = false;
    }
  }

  function removeSyncFolder(i: number) {
    settings.sync.folders = settings.sync.folders.filter((_, j) => j !== i);
    changed();
  }

  const intervalLabel = (m: number) => (m === 0 ? "仅手动" : m < 60 ? `${m} 分钟` : `${m / 60} 小时`);

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
            {#if gi < SHORTCUT_GROUPS.length - 1}<div class="divider"></div>{/if}
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
          <div class="divider"></div>
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
          <div class="divider"></div>
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

        {:else if tab === "同步"}
          <div class="group first">
            <div class="row">
              <span class="row-label">
                启用同步
                <small>把下方同步文件夹与 WebDAV 服务器双向同步（文件原样存储，任何 WebDAV 客户端可读）</small>
              </span>
              <input type="checkbox" bind:checked={settings.sync.enabled} on:change={changed} />
            </div>
            <div class="row">
              <span class="row-label">同步目标</span>
              <select value="webdav" disabled>
                <option value="webdav">WebDAV</option>
              </select>
            </div>
            <div class="row">
              <span class="row-label">
                WebDAV URL
                {#if settings.sync.account.url && !/^https:\/\//i.test(settings.sync.account.url)}
                  <small class="warn-text">⚠ 当前为 http 明文，口令与笔记内容在网络上可被窃听；建议配置 https 地址</small>
                {:else}
                  <small>如 https://your-server/dav/（支持 https 时全程 TLS 加密）</small>
                {/if}
              </span>
              <span class="row-right">
                <input class="text-input wide" type="text" placeholder="https://host:port/dav/"
                  bind:value={settings.sync.account.url} on:change={changed} />
              </span>
            </div>
            <div class="row">
              <span class="row-label">
                WebDAV 用户名
                <small>明文存储于本机配置文件，与 Joplin 桌面版行为一致</small>
              </span>
              <input class="text-input" type="text" bind:value={settings.sync.account.username} on:change={changed} />
            </div>
            <div class="row">
              <span class="row-label">WebDAV 密码</span>
              <span class="row-right">
                {#if showPassword}
                  <input class="text-input" type="text"
                    bind:value={settings.sync.account.password} on:change={changed} />
                {:else}
                  <input class="text-input" type="password"
                    bind:value={settings.sync.account.password} on:change={changed} />
                {/if}
                <button class="mini" title={showPassword ? "隐藏" : "显示"} on:click={() => (showPassword = !showPassword)}>
                  {showPassword ? "🙈" : "👁"}
                </button>
              </span>
            </div>
          </div>

          <div class="divider"></div>
          <div class="group">
            <div class="row">
              <span class="row-label">
                同步文件夹
                <small>本地文件夹 ↔ WebDAV 远端子路径；快照状态存于应用数据目录，不污染笔记目录</small>
              </span>
              <button class="btn" on:click={() => dispatch("pickSyncFolder")}>添加文件夹</button>
            </div>
            {#each settings.sync.folders as f, i}
              <div class="row">
                <span class="row-label">
                  <small class="path">{f.localRoot}</small>
                  <small>远端子路径 {f.basePath}</small>
                </span>
                <span class="row-right">
                  <label><input type="checkbox" bind:checked={f.enabled} on:change={changed} /> 启用</label>
                  <button class="mini" title="移除（不影响磁盘文件）" on:click={() => removeSyncFolder(i)}>✕</button>
                </span>
              </div>
            {/each}
            {#if !settings.sync.folders.length}
              <p class="desc">尚未添加同步文件夹。</p>
            {/if}
            <div class="row">
              <span class="row-label">
                同步间隔
                <small>窗口隐藏时自动暂停，恢复可见时若已过期立即补一轮</small>
              </span>
              <select bind:value={settings.sync.intervalMin} on:change={changed}>
                {#each SYNC_INTERVAL_OPTIONS as m}
                  <option value={m}>{intervalLabel(m)}</option>
                {/each}
              </select>
            </div>
            <div class="row">
              <span class="row-label">
                连接检查
                <small>依次验证：网络可达 → 认证 → 读取 → 写入权限（探针文件即建即删）</small>
              </span>
              <span class="row-right">
                <button class="btn" disabled={syncChecking || !settings.sync.account.url} on:click={doCheckSync}>
                  {syncChecking ? "检查中…" : "检查同步配置"}
                </button>
                <button class="btn primary" disabled={!settings.sync.folders.length} on:click={() => dispatch("syncNow")}>
                  立即同步
                </button>
              </span>
            </div>
            {#if syncErr}
              <p class="desc warn-text">检查失败：{syncErr}</p>
            {/if}
            {#if syncReport}
              <div class="group">
                {#each syncReport.steps as st}
                  <div class="row">
                    <span class="row-label">
                      {st.name === "network" ? "网络可达" : st.name === "auth" ? "认证成功" : st.name === "read" ? "读取正常" : st.name === "write" ? "写入权限" : st.name}
                      <small>{st.message}</small>
                    </span>
                    <span class="tag {st.ok ? 'ok' : st.skipped ? 'skip' : 'bad'}">
                      {st.ok ? "✓ 通过" : st.skipped ? "— 跳过" : "✗ 失败"}
                    </span>
                  </div>
                {/each}
                <p class="desc">{syncReport.allOk ? "成功！同步配置看起来没问题。" : "存在失败项，请根据上方提示修正后重试。"}</p>
              </div>
            {/if}
          </div>

          <div class="divider"></div>
          <button class="btn adv-toggle" on:click={() => (showAdvanced = !showAdvanced)}>
            {showAdvanced ? "▾" : "▸"} 显示高级选项
          </button>
          {#if showAdvanced}
            <div class="group">
              <div class="row">
                <span class="row-label">
                  冲突处理
                  <small>双保留：本地文件不动，远端版本另存「（冲突副本 …）」，永不静默丢数据；较新者胜：可能覆盖本地编辑，慎用</small>
                </span>
                <select bind:value={settings.sync.conflictPolicy} on:change={changed}>
                  <option value="keepBoth">双保留冲突副本（推荐）</option>
                  <option value="newerWins">较新者胜</option>
                </select>
              </div>
              <div class="row">
                <span class="row-label">
                  最大并发连接数
                  <small>同时传输的文件数，1~16</small>
                </span>
                <input class="text-input narrow" type="number" min="1" max="16"
                  bind:value={settings.sync.concurrency} on:change={changed} />
              </div>
              <div class="row">
                <span class="row-label">
                  单文件大小上限(MB)
                  <small>超过该大小的文件跳过同步并在结果中提示</small>
                </span>
                <input class="text-input narrow" type="number" min="1" max="4096"
                  bind:value={settings.sync.maxFileSizeMB} on:change={changed} />
              </div>
              <div class="row">
                <span class="row-label">
                  忽略文件模式
                  <small>逗号分隔，如 .git/**, Thumbs.db, ~$*（不含 / 的模式按文件名匹配）</small>
                </span>
                <input class="text-input wide" type="text"
                  value={settings.sync.ignorePatterns.join(", ")}
                  on:blur={(e) => {
                    settings.sync.ignorePatterns = e.currentTarget.value
                      .split(",").map((x) => x.trim()).filter(Boolean);
                    changed();
                  }} />
              </div>
              <div class="row">
                <span class="row-label">
                  故障保护
                  <small>当同步目标为空（通常是配置错误或 Bug），不要删除本地数据</small>
                </span>
                <input type="checkbox" bind:checked={settings.sync.failSafe} on:change={changed} />
              </div>
              <div class="row">
                <span class="row-label">
                  自定义 TLS 证书
                  <small>逗号分隔的路径列表，可以是包含证书的目录，也可以直接指向单独的 .pem 文件</small>
                </span>
                <input class="text-input wide" type="text" placeholder="/my/cert_dir, /other/custom.pem"
                  bind:value={settings.sync.advanced.customTlsCerts} on:change={changed} />
              </div>
              <div class="row">
                <span class="row-label">
                  忽略 TLS 证书错误
                  <small>危险：将接受无效/自签证书，仅建议在受信内网使用</small>
                </span>
                <input type="checkbox" bind:checked={settings.sync.advanced.ignoreTlsErrors} on:change={changed} />
              </div>
              <div class="row">
                <span class="row-label">启用代理</span>
                <input type="checkbox" bind:checked={settings.sync.advanced.proxyEnabled} on:change={changed} />
              </div>
              {#if settings.sync.advanced.proxyEnabled}
                <div class="row">
                  <span class="row-label">代理 URL<small>例如 http://my.proxy.com:80 或 socks5h://127.0.0.1:1080</small></span>
                  <input class="text-input wide" type="text" bind:value={settings.sync.advanced.proxyUrl} on:change={changed} />
                </div>
                <div class="row">
                  <span class="row-label">代理连接超时(秒)</span>
                  <input class="text-input narrow" type="number" min="0" max="600"
                    bind:value={settings.sync.advanced.proxyTimeoutSec} on:change={changed} />
                </div>
              {/if}
              <div class="row">
                <span class="row-label">
                  获得焦点时同步
                  <small>窗口从后台切回时若开启则补跑一轮（距上轮 ≥30 秒）</small>
                </span>
                <input type="checkbox" bind:checked={settings.sync.advanced.syncOnWindowFocus} on:change={changed} />
              </div>
            </div>

            <div class="divider"></div>
            <div class="group">
              <div class="row">
                <span class="row-label">
                  重新上传本地数据到同步目标
                  <small>同步目标上的数据不正确或为空时，强制把本地数据全量上传（服务器端多余旧文件不会被删除）。需要二次确认。</small>
                </span>
                <button class="btn danger" on:click={() => (forceChoice = forceChoice === "upload" ? "" : "upload")}>
                  {forceChoice === "upload" ? "取消" : "重新上传"}
                </button>
              </div>
              {#if forceChoice === "upload"}
                <div class="row">
                  <span class="desc warn-text">确认忽略快照、把本地全部文件强制上传到 WebDAV？此操作会覆盖服务器上的同名文件。</span>
                  <button class="btn danger" on:click={() => { dispatch("syncForce", { mode: "forceUpload" }); forceChoice = ""; }}>
                    确认执行
                  </button>
                </div>
              {/if}
              <div class="row">
                <span class="row-label">
                  删除本地数据并从同步目标导入
                  <small>本地数据不正确、同步目标上的数据正确时，把本地文件移入回收站后从服务器全量拉取。建议先导出备份。</small>
                </span>
                <button class="btn danger" on:click={() => (forceChoice = forceChoice === "download" ? "" : "download")}>
                  {forceChoice === "download" ? "取消" : "重新导入"}
                </button>
              </div>
              {#if forceChoice === "download"}
                <div class="row">
                  <span class="desc warn-text">确认把本地同步文件夹全部文件移入回收站、再从 WebDAV 下载？</span>
                  <button class="btn danger" on:click={() => { dispatch("syncForce", { mode: "forceDownload" }); forceChoice = ""; }}>
                    确认执行
                  </button>
                </div>
              {/if}
            </div>
          {/if}

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
                <small>Rust 侧排版渲染（A4/中文自动换行分页），当前文档内容</small>
              </span>
              <button class="btn" on:click={() => dispatch("exportPdf")}>立即导出</button>
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

  .text-input.wide {
    width: 280px;
  }

  .text-input.narrow {
    width: 72px;
  }

  .warn-text {
    color: #b26a00;
  }

  .tag.ok {
    color: #1a7f37;
    background: rgba(26, 127, 55, 0.12);
  }

  .tag.skip {
    color: var(--text-2);
  }

  .tag.bad {
    color: #c0392b;
    background: rgba(192, 57, 43, 0.12);
  }

  .btn.danger {
    color: #c0392b;
    border-color: rgba(192, 57, 43, 0.4);
  }

  .btn.danger:hover {
    background: rgba(192, 57, 43, 0.08);
  }

  .adv-toggle {
    margin: 4px 0 10px;
    color: var(--accent);
  }
</style>
