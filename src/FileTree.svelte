<script lang="ts">
  // 文件树面板：从 App.svelte 抽出，承载目录渲染 + 虚拟滚动 + 右键菜单触发。
  // 所有副作用通过回调发回父组件，便于在测试 / Storybook 里独立挂载。
  import { createEventDispatcher } from "svelte";
  import type { FlatNode } from "./App.svelte"; // App.svelte 里定义的 FlatNode 类型

  export let flatTree: FlatNode[];
  export let sidebarWidth: number;
  export let currentPath: string | null;
  export let norm: (p: string) => string;
  export let lastFolder: string | null;
  export let hiddenPaths: string[];
  export let treeRange: { s: number; e: number; top: number; bottom: number };
  export let treeVirtual: boolean;
  export let treeViewportH: number;
  export let showHiddenManage: boolean;

  const dispatch = createEventDispatcher();

  function basename(p: string): string {
    const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
    return i < 0 ? p : p.slice(i + 1);
  }

  function onScroll(e: Event) {
    dispatch("scroll", e);
  }
</script>

<aside class="sidebar" style="width:{sidebarWidth}px">
  <div class="panel-head">
    <span style="flex:1" />
    <button on:click={() => dispatch("newfile", lastFolder)} title="新建笔记（未打开文件夹时会先让你选文件夹）">📄+</button>
    <button on:click={() => dispatch("newfolder", lastFolder)} title="新建文件夹（未打开文件夹时会先让你选文件夹）">📁+</button>
    <button on:click={() => dispatch("refresh")} title="刷新目录">↻</button>
    <button
      on:click={() => dispatch("toggleHidden")}
      class:on={showHiddenManage || hiddenPaths.length > 0}
      title="隐藏文件/文件夹管理（含取消隐藏）">隐</button>
    <button on:click={() => dispatch("collapse")} title="折叠">‹</button>
  </div>
  {#if flatTree.length}
    <ul bind:clientHeight={treeViewportH} on:scroll={onScroll}>
      {#if treeVirtual && treeRange.top > 0}
        <li class="vsp" style="height:{treeRange.top}px" aria-hidden="true"></li>
      {/if}
      {#each flatTree.slice(treeRange.s, treeRange.e) as node (node.path)}
        {#if node.kind === "folder"}
          <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
          <li
            class="folder"
            style="padding-left:{6 + node.depth * 18}px"
            on:click={() => dispatch("togglefolder", node.path)}
            on:contextmenu={(e) => dispatch("ctx", { e, kind: "folder", path: node.path, name: node.name })}
          >
            <span class="fold">{node.expanded ? "▾" : "▸"}</span>
            <span class="fname">{node.name}</span>
            <span class="factions">
              <button class="mini" title="新建笔记" on:click|stopPropagation={() => dispatch("newfile", node.path)}>📄</button>
              <button class="mini" title="新建文件夹" on:click|stopPropagation={() => dispatch("newfolder", node.path)}>📁</button>
            </span>
          </li>
        {:else}
          <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
          <li
            class="file"
            style="padding-left:{6 + node.depth * 18}px"
            class:active={currentPath === norm(node.path)}
            on:click={() => dispatch("openfile", node.path)}
            on:contextmenu={(e) => dispatch("ctx", { e, kind: "file", path: node.path, name: node.name })}
          >
            <span class="ficon">📄</span>
            <span class="fnm">{node.name}</span>
          </li>
        {/if}
      {/each}
      {#if treeVirtual && treeRange.bottom > 0}
        <li class="vsp" style="height:{treeRange.bottom}px" aria-hidden="true"></li>
      {/if}
    </ul>
  {:else}
    <ul>
      <li class="hint">打开文件夹后显示 .md 列表</li>
    </ul>
  {/if}
</aside>
