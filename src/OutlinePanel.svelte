<script lang="ts">
  // 大纲面板（B4 / LM-04）：侧栏「大纲」tab 的内容组件。
  // 只负责渲染 items 与高亮当前标题，不持有文档状态——
  // 标题数据由父级调 extractOutline() 产生，跳转通过 onJump 回调交还父级。
  //
  // 期望的侧栏 tab 类（由集成方在 App.svelte / style.css 实现，本组件不提供 tab 条）：
  //   .sb-tabs   —— tab 条容器（L1 容器 + 底部分隔线）
  //   .sb-tab    —— 单个 tab 按钮（32×28 r9，静息 rs-s 凸起）
  //   .sb-tab.on —— 选中 tab（is 内嵌 + primary）
  import type { OutlineItem } from "./outline";

  /** 标题条目（extractOutline 的产物，按文档顺序，line 非降序） */
  export let items: OutlineItem[] = [];
  /** 当前编辑区行号（0-based）；默认 -1 = 无高亮（外部类型为 activeLine?: number） */
  export let activeLine: number = -1;
  /** 点击条目时回调，参数为标题行号（0-based） */
  export let onJump: (line: number) => void = () => {};

  let listEl: HTMLDivElement;

  /**
   * 当前标题 = 最后一个 line <= activeLine 的条目。
   * items 按文档顺序排列（line 非降序），线性扫描到第一个越界项即止。
   */
  $: activeIndex = (() => {
    if (activeLine === undefined || activeLine === null || activeLine < 0 || !items.length) {
      return -1;
    }
    let idx = -1;
    for (let i = 0; i < items.length; i++) {
      if (items[i].line <= activeLine) idx = i;
      else break;
    }
    return idx;
  })();

  // 当前标题变化时，若已滚出可视区则滚动到可见位置；
  // 仅越界才滚动，不打断用户主动滚动（jsdom 下度量全为 0，天然跳过）。
  $: if (activeIndex >= 0 && listEl) {
    const el = listEl.children[activeIndex] as HTMLElement | undefined;
    if (el && el.offsetHeight > 0) {
      const top = el.offsetTop;
      const bottom = top + el.offsetHeight;
      if (top < listEl.scrollTop || bottom > listEl.scrollTop + listEl.clientHeight) {
        listEl.scrollTop = Math.max(0, top - (listEl.clientHeight - el.offsetHeight) / 2);
      }
    }
  }

  function jump(item: OutlineItem): void {
    onJump(item.line);
  }
</script>

<div class="ol-panel">
  {#if items.length}
    <div class="ol-list" bind:this={listEl}>
      {#each items as item, i (item.line)}
        <div
          class="ol-item"
          class:on={i === activeIndex}
          class:lv1={item.level === 1}
          class:lv2={item.level === 2}
          style="padding-left: {9 + (item.level - 1) * 12}px"
          title={item.text}
          role="button"
          tabindex="0"
          on:click={() => jump(item)}
          on:keydown={(e) => e.key === "Enter" && jump(item)}
        >
          <span class="ol-text">{item.text}</span>
        </div>
      {/each}
    </div>
  {:else}
    <div class="ol-empty">暂无标题</div>
  {/if}
</div>

<style>
  /* 表面色 = 页面色：不换底色，层级只靠光影与 1px 分栏线（铁律 1） */
  .ol-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }

  /* 滚动区独立：flex + min-height:0 + overflow，长文档不撑破侧栏 */
  .ol-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 4px 0 8px;
  }

  /* 大纲行同树行规格（LM-04：margin 1,8 · padding 6,9 · r9 · 12px）；
     缩进由 inline padding-left 提供：9px 基准 + (level-1)×12px */
  .ol-item {
    display: flex;
    align-items: baseline;
    gap: 6px;
    margin: 1px 8px;
    padding: 5px 9px;
    border-radius: 9px;
    font-size: 12px;
    line-height: 1.5;
    color: var(--t1);
    cursor: pointer;
  }

  .ol-item:hover {
    background: var(--hov);
  }

  /* 当前标题高亮：C-3 同款近似 —— tint 12% 染色 + 左 2px 主色竖条（铁律 3）。
     用 inset box-shadow 而非 border-left，避免 2px 描边造成布局位移 */
  .ol-item.on {
    background: var(--tint);
    box-shadow: inset 2px 0 0 var(--p);
  }

  .ol-item.lv1 {
    font-weight: 700;
  }

  .ol-item.lv2 {
    font-weight: 600;
  }

  .ol-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ol-empty {
    padding: 24px 16px;
    text-align: center;
    font-size: 12px;
    color: var(--t3);
  }
</style>
