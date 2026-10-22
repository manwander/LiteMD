<script lang="ts">
  import { tick } from "svelte";
  import {
    GROUP_LABELS,
    GROUP_ORDER,
    MENU_TREE,
    type MenuGroupId,
    type MenuNode,
  } from "./menu-registry";

  /** action 点击统一出口（App 侧组装 handler map 后经 runAction 分发） */
  export let onAction: (id: string) => void;
  /** 展示用加速键读取（App 侧读 settings.shortcuts；缺失应返回 ""） */
  export let accelFn: (id: string) => string = () => "";
  /** 菜单栏显隐（App 持 menubarVisible 状态；Alt 整栏切换在 App 的 onKeydown） */
  export let visible = true;
  /** 「最近打开」动态条目（运行时注入；结构标记见 menu-registry SUB_DEFS 的 recent） */
  export let recentFiles: { path: string; name: string }[] = [];
  export let onOpenRecent: (path: string) => void = () => {};
  /**
   * 菜单树（集成方传入裁剪后的树：未接线 action 已剔除）。
   * 默认取注册表全量树——单独使用/测试时无需传。
   */
  export let tree: Record<MenuGroupId, MenuNode[]> = MENU_TREE;

  let openGroup: MenuGroupId | null = null;
  let barEl: HTMLDivElement | null = null;

  function close(): void {
    openGroup = null;
  }

  function toggleGroup(g: MenuGroupId): void {
    openGroup = openGroup === g ? null : g;
  }

  /** 菜单项加速键：accelFn（活值）优先，回落 ActionDef.accel（展示兜底） */
  function itemAccel(node: MenuNode): string {
    if (!node.id) return "";
    return accelFn(node.id) || node.accel || "";
  }

  /** 聚焦展开面板内第 dir 个可聚焦菜单项（跳过分组标题/空态占位） */
  async function focusItem(dir: 1 | -1 | "first" | "last"): Promise<void> {
    await tick();
    const items = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".mb-drop button.mb-item:not(:disabled)")
    );
    if (!items.length) return;
    const cur = items.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    if (dir === "first") next = 0;
    else if (dir === "last") next = items.length - 1;
    else {
      next =
        cur < 0
          ? dir === 1
            ? 0
            : items.length - 1
          : (cur + dir + items.length) % items.length;
    }
    items[next]?.focus();
  }

  function focusRoot(g: MenuGroupId): void {
    const idx = GROUP_ORDER.indexOf(g);
    barEl?.querySelectorAll<HTMLButtonElement>(".mb-btn")[idx]?.focus();
  }

  /** 根按钮键盘：←→ 在组间移动焦点；↓/Enter/Space 展开并聚焦首项；↑ 聚焦末项；Esc 收起 */
  function onRootKeydown(e: KeyboardEvent, g: MenuGroupId): void {
    const idx = GROUP_ORDER.indexOf(g);
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const dir = e.key === "ArrowRight" ? 1 : -1;
      focusRoot(GROUP_ORDER[(idx + dir + GROUP_ORDER.length) % GROUP_ORDER.length]);
    } else if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openGroup = g;
      void focusItem("first");
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      openGroup = g;
      void focusItem("last");
    } else if (e.key === "Escape") {
      close();
    }
  }

  /** 展开面板键盘：↑↓ 循环移动；Home/End 首末；←→ 切组；Esc 收起并焦点回根按钮；Tab 交还焦点 */
  function onDropKeydown(e: KeyboardEvent): void {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      void focusItem(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      void focusItem(-1);
    } else if (e.key === "Home") {
      e.preventDefault();
      void focusItem("first");
    } else if (e.key === "End") {
      e.preventDefault();
      void focusItem("last");
    } else if (e.key === "Escape") {
      e.preventDefault();
      const g = openGroup;
      close();
      if (g) focusRoot(g);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      if (!openGroup) return;
      const idx = GROUP_ORDER.indexOf(openGroup);
      const dir = e.key === "ArrowRight" ? 1 : -1;
      openGroup = GROUP_ORDER[(idx + dir + GROUP_ORDER.length) % GROUP_ORDER.length];
      void focusItem("first");
    } else if (e.key === "Tab") {
      close();
    }
  }
</script>

{#if visible}
  {#if openGroup}
    <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
    <div class="mb-mask" role="presentation" on:click={close} on:contextmenu|preventDefault={close}></div>
  {/if}
  <div class="menubar" bind:this={barEl} role="menubar" aria-label="主菜单">
    {#each GROUP_ORDER as g}
      <div class="mb-root">
        <button
          class="mb-btn"
          class:open={openGroup === g}
          aria-haspopup="menu"
          aria-expanded={openGroup === g}
          on:click={() => toggleGroup(g)}
          on:mouseenter={() => {
            if (openGroup && openGroup !== g) openGroup = g;
          }}
          on:keydown={(e) => onRootKeydown(e, g)}
        >
          {GROUP_LABELS[g]}<span class="mb-caret">▾</span>
        </button>
        {#if openGroup === g}
          <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
          <div class="mb-drop" role="menu" tabindex="-1" on:keydown={onDropKeydown}>
            {#each tree[g] as node}
              {#if node.kind === "sep"}
                <div class="mb-sep" role="separator"></div>
              {:else if node.kind === "sub"}
                <div class="mb-group">{node.label}</div>
                {#if node.id === "recent"}
                  {#each recentFiles as rf (rf.path)}
                    <button
                      class="mb-item"
                      title={rf.path}
                      on:click={() => {
                        close();
                        onOpenRecent(rf.path);
                      }}
                    >
                      <span class="mb-label">{rf.name}</span>
                    </button>
                  {/each}
                  {#if !recentFiles.length}
                    <div class="mb-empty">（无最近文件）</div>
                  {/if}
                {/if}
              {:else}
                <button
                  class="mb-item"
                  role="menuitem"
                  on:click={() => {
                    close();
                    onAction(node.id ?? "");
                  }}
                >
                  <span class="mb-label">{node.label}</span>
                  {#if itemAccel(node)}<kbd class="kbd">{itemAccel(node)}</kbd>{/if}
                </button>
              {/if}
            {/each}
          </div>
        {/if}
      </div>
    {/each}
  </div>
{/if}
