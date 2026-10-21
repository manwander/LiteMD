<script lang="ts">
  // 命令面板（B3）：Ctrl+P 唤出，三类源（命令 / 文件 / 设置）模糊检索。
  // 纯展示 + 键盘导航组件；命令执行、打开文件、关闭均由集成方通过 props 注入，
  // 组件不直接依赖 App.svelte（铁律⑤：新功能抽组件文件）。
  //
  // 键位：↑↓ 选择 / ↵ 执行 / Tab 补全（预留位，见 onKeydown）/ Esc 关闭。
  import { tick } from "svelte";
  import { listMdFiles } from "./fs";
  import { ALL_ACTIONS } from "./settings";
  import {
    buildSources,
    rank,
    GROUP_ORDER,
    GROUP_TITLES,
    DEFAULT_SETTING_LABELS,
    type PalItem,
  } from "./command-palette";

  export let open: boolean;
  /** 关闭面板（Esc / 点遮罩 / 执行后均由组件调用；焦点回编辑器由集成方负责） */
  export let onClose: () => void;
  /** 命令 / 设置执行：command 与 setting 组都走这里 */
  export let dispatch: (id: string) => void;
  /** 文件组执行：打开对应路径 */
  export let onOpenFile: (path: string) => void;
  /** 当前文件夹根；null 时文件源为空 */
  export let mdRoot: string | null;

  let query = "";
  let activeIndex = 0;
  let files: string[] = [];
  /** 已加载完成的根（缓存，避免同一根重复 invoke） */
  let loadedRoot: string | null = null;
  /** 加载中的根（防重入 + 竞态防护） */
  let loadingRoot: string | null = null;

  let inputEl: HTMLInputElement;
  let listEl: HTMLDivElement;

  // 面板打开：重置查询词、选中项回顶、输入框自动聚焦
  $: if (open) resetOnOpen();

  function resetOnOpen(): void {
    query = "";
    activeIndex = 0;
    // {#if open} 刚挂载输入框，退到 DOM 更新后聚焦
    void tick().then(() => inputEl?.focus());
  }

  // 文件源按需加载：mdRoot 变化（或打开时）列举一次，同根走缓存
  $: if (open) loadFilesFor(mdRoot);

  function loadFilesFor(root: string | null): void {
    if (!root) {
      files = [];
      loadedRoot = null;
      loadingRoot = null;
      return;
    }
    if (root === loadedRoot || root === loadingRoot) return;
    void loadFiles(root);
  }

  async function loadFiles(root: string): Promise<void> {
    loadingRoot = root;
    let result: string[] = [];
    try {
      result = await listMdFiles(root);
    } catch {
      result = []; // 列举失败不阻塞命令/设置源
    }
    // 竞态防护：加载期间 mdRoot 已切换则丢弃本次结果
    if (loadingRoot === root) {
      files = result;
      loadedRoot = root;
      loadingRoot = null;
    }
  }

  $: sources = buildSources(ALL_ACTIONS, files, DEFAULT_SETTING_LABELS);
  $: ranked = rank(sources, query);

  // 分组渲染（保持 command → file → setting 组序；空组不渲染标题）
  $: groups = GROUP_ORDER.map((g) => ({
    group: g,
    title: GROUP_TITLES[g],
    items: ranked.filter((it) => it.group === g),
  })).filter((x) => x.items.length > 0);

  // 查询词变化 → 选中项复位到首项、列表回顶
  $: query, onQueryChange();

  function onQueryChange(): void {
    activeIndex = 0;
    void tick().then(() => {
      if (listEl) listEl.scrollTop = 0;
      scrollActiveIntoView();
    });
  }

  function scrollActiveIntoView(): void {
    const el = listEl?.querySelector<HTMLElement>(".cp-item.cp-active");
    // jsdom 无 scrollIntoView，可选调用兜底
    el?.scrollIntoView?.({ block: "nearest" });
  }

  function move(delta: number): void {
    if (!ranked.length) return;
    activeIndex = (activeIndex + delta + ranked.length) % ranked.length;
    void tick().then(scrollActiveIntoView);
  }

  function execute(item: PalItem): void {
    if (item.group === "file") onOpenFile(item.id);
    else dispatch(item.id); // command / setting
    onClose();
  }

  function onItemMouseenter(index: number): void {
    activeIndex = index;
  }

  function onItemClick(index: number, item: PalItem): void {
    activeIndex = index;
    execute(item);
  }

  // 窗口级键盘（捕获阶段，避免与 App 窗口级快捷键打架；仅 open 时接管）
  function onKeydown(e: KeyboardEvent): void {
    if (!open) return;
    // 中文输入法组词期间不拦截（Enter / ↑↓ 都是候选词键位）
    if (e.isComposing) return;
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        onClose();
        break;
      case "ArrowDown":
        e.preventDefault();
        move(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        move(-1);
        break;
      case "Enter": {
        e.preventDefault();
        e.stopPropagation();
        const item = ranked[activeIndex];
        if (item) execute(item);
        break;
      }
      case "Tab":
        // 预留位：未来做查询词补全（如把当前项 label 回填输入框并继续过滤）。
        // 当前版本（含空查询）不做特殊处理，仅阻止 Tab 把焦点跑出面板。
        e.preventDefault();
        break;
      default:
        break;
    }
  }
</script>

<svelte:window on:keydown|capture={onKeydown} />

{#if open}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="cp-mask" on:click={onClose}>
    <!-- svelte-ignore a11y-click-events-have-key-events -->
    <div
      class="cp-panel"
      role="dialog"
      aria-label="命令面板"
      tabindex="-1"
      on:click|stopPropagation
    >
      <div class="cp-input-wrap">
        <input
          bind:this={inputEl}
          bind:value={query}
          class="cp-input"
          type="text"
          placeholder="搜索命令、文件、设置…"
          aria-label="搜索命令、文件、设置"
          spellcheck="false"
          autocomplete="off"
        />
      </div>

      <div class="cp-list" bind:this={listEl} role="listbox" aria-label="候选列表">
        {#if groups.length}
          {#each groups as g (g.group)}
            <div class="cp-group">
              <div class="cp-group-title">{g.title}</div>
              {#each g.items as item (g.group + ":" + item.id)}
                {@const index = ranked.indexOf(item)}
                <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
                <div
                  class="cp-item"
                  class:cp-active={index === activeIndex}
                  role="option"
                  aria-selected={index === activeIndex}
                  tabindex="-1"
                  on:click={() => onItemClick(index, item)}
                  on:mouseenter={() => onItemMouseenter(index)}
                >
                  <span class="cp-item-label">{item.label}</span>
                  {#if item.hint}
                    <span class="cp-item-hint">{item.hint}</span>
                  {/if}
                </div>
              {/each}
            </div>
          {/each}
        {:else}
          <div class="cp-empty">{query ? "无匹配结果" : "暂无可用命令"}</div>
        {/if}
      </div>

      <div class="cp-footer">
        <span class="cp-kbd-hint"><kbd>↑</kbd><kbd>↓</kbd>选择</span>
        <span class="cp-kbd-hint"><kbd>↵</kbd>执行</span>
        <span class="cp-kbd-hint"><kbd>Tab</kbd>补全</span>
        <span class="cp-kbd-hint"><kbd>Esc</kbd>关闭</span>
      </div>
    </div>
  </div>
{/if}

<style>
  .cp-mask {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.26);
    z-index: 140;
  }

  .cp-panel {
    position: fixed;
    top: 12vh;
    left: 50%;
    transform: translateX(-50%);
    width: 560px;
    max-width: calc(100vw - 32px);
    max-height: 66vh;
    display: flex;
    flex-direction: column;
    /* 铁律①：表面色 = 页面色，层级只靠光影表达 */
    background: var(--bg);
    border-radius: 14px;
    box-shadow: var(--rs-l);
    z-index: 141;
    overflow: hidden;
  }

  /* 暗色补偿四组之一：浮层 L4 白描边 */
  :root[data-theme="dark"] .cp-panel {
    border: 1px solid rgba(255, 255, 255, 0.1);
  }

  .cp-input-wrap {
    padding: 12px 14px;
    border-bottom: 1px solid var(--div);
  }

  .cp-input {
    width: 100%;
    box-sizing: border-box;
    height: 38px;
    padding: 0 12px;
    font-size: 14px;
    color: var(--t1);
    background: var(--bg);
    border: none;
    border-radius: 8px;
    /* 输入框内嵌底 */
    box-shadow: var(--is-s);
    outline: none;
  }

  .cp-input::placeholder {
    color: var(--t3);
  }

  .cp-input:focus {
    /* 选中描边：主色 38%（--ps），不新增阴影方向 */
    box-shadow: var(--is-s), 0 0 0 1px var(--ps);
  }

  .cp-list {
    flex: 1;
    overflow-y: auto;
    padding: 6px;
  }

  .cp-group + .cp-group {
    margin-top: 4px;
  }

  .cp-group-title {
    font-size: 12px;
    color: var(--t2);
    padding: 6px 10px 4px;
  }

  .cp-item {
    position: relative;
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 8px 10px;
    border-radius: 6px;
    font-size: 14px;
    color: var(--t1);
    cursor: pointer;
  }

  .cp-item:hover {
    background: var(--hov);
  }

  /* 选中态 = 内嵌语义：tint 12% 染色 + 左 2px --p 竖条（C-3 同款） */
  .cp-item.cp-active {
    background: var(--tint);
  }

  .cp-item.cp-active::before {
    content: "";
    position: absolute;
    left: 0;
    top: 6px;
    bottom: 6px;
    width: 2px;
    border-radius: 1px;
    background: var(--p);
  }

  .cp-item-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .cp-item-hint {
    flex-shrink: 0;
    max-width: 45%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
    color: var(--t2);
  }

  .cp-empty {
    padding: 24px 0;
    text-align: center;
    font-size: 13px;
    color: var(--t2);
  }

  .cp-footer {
    display: flex;
    gap: 16px;
    padding: 8px 14px;
    border-top: 1px solid var(--div);
    font-size: 12px;
    color: var(--t2);
  }

  .cp-kbd-hint {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  .cp-footer kbd {
    font-family: inherit;
    font-size: 11px;
    line-height: 1;
    padding: 3px 5px;
    border-radius: 4px;
    background: var(--sl);
    color: var(--t2);
    box-shadow: var(--rs-s);
  }
</style>
