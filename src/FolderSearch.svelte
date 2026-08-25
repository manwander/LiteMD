<script lang="ts">
  // 跨文件查找替换：在当前文件夹（默认目录）下所有 .md 中查找、批量替换。
  // 结果按文件分组，点击单条结果跳转到对应文件对应行。
  import { createEventDispatcher } from "svelte";
  import { searchInFolder, replaceInFolder, type FolderMatch } from "./fs";
  import ConfirmModal from "./ConfirmModal.svelte";

  export let folder: string;
  /**
   * 由父级注入：返回 folder 内「有未保存修改」的文件名列表。
   * M-03 防线①——脏标签存在时禁止批量替换，否则替换后无论刷新与否都会丢数据。
   */
  export let dirtyFilesIn: (folder: string) => string[] = () => [];

  const dispatch = createEventDispatcher<{
    close: void;
    open: { path: string; line: number };
    /** 批量替换成功，通知父级重新同步已打开标签（M-03 防线②） */
    replaced: { folder: string };
  }>();

  let query = "";
  let replacement = "";
  let caseSensitive = false;
  let results: FolderMatch[] = [];
  let busy = false;
  let searched = false;
  let message = "";
  let truncated = false;

  // 结果按文件分组后仅渲染前 N 组，其余懒展开，避免上万节点一次性挂载
  const GROUP_BATCH = 30;
  let visibleGroups = GROUP_BATCH;

  const norm = (s: string) => s.replace(/\\/g, "/");

  async function doSearch() {
    if (!query) {
      message = "请输入查找内容";
      return;
    }
    busy = true;
    message = "";
    try {
      const res = await searchInFolder(folder, query, caseSensitive);
      results = res.matches;
      truncated = res.truncated;
      visibleGroups = GROUP_BATCH;
      searched = true;
      message = results.length
        ? `找到 ${results.length} 处匹配${truncated ? "（结果过多，已截断）" : ""}`
        : "未找到匹配";
    } catch (e) {
      message = "查找失败：" + String(e);
    } finally {
      busy = false;
    }
  }

  let confirmReplace = false;

  async function doReplaceAll() {
    if (!query) {
      message = "请输入查找内容";
      return;
    }
    // M-03 防线①：folder 内有未保存的标签时禁止替换。
    // 替换会直接改磁盘，而内存里的脏内容既不能被覆盖（丢用户编辑）
    // 也不能覆盖磁盘（吞掉替换结果），唯一安全解是让用户先保存。
    const dirty = dirtyFilesIn(folder);
    if (dirty.length) {
      const shown = dirty.slice(0, 5).join("、");
      message = `有 ${dirty.length} 个已打开文件未保存（${shown}${
        dirty.length > 5 ? " 等" : ""
      }），请先保存（Ctrl+S）后再批量替换`;
      return;
    }
    confirmReplace = true;
  }

  async function onReplaceConfirm() {
    confirmReplace = false;
    busy = true;
    message = "";
    try {
      const res = await replaceInFolder(folder, query, replacement, caseSensitive);
      message = `已替换 ${res.count} 处（${res.filesChanged} 个文件）`;
      // M-03 防线②：磁盘已变，通知父级重新拉取已打开标签的内容
      if (res.filesChanged > 0) dispatch("replaced", { folder });
      await doSearch(); // 替换后刷新结果
    } catch (e) {
      message = "替换失败：" + String(e);
    } finally {
      busy = false;
    }
  }

  // 显示相对路径（去掉文件夹前缀），更易读
  function rel(p: string): string {
    const f = norm(folder);
    const pp = norm(p);
    return pp.startsWith(f) ? pp.slice(f.length).replace(/^\//, "") : pp;
  }

  // 按文件分组结果
  $: grouped = (() => {
    const map = new Map<string, FolderMatch[]>();
    for (const r of results) {
      if (!map.has(r.path)) map.set(r.path, []);
      map.get(r.path)!.push(r);
    }
    return [...map.entries()];
  })();

  // 捕获阶段拦截 Esc（关闭）与输入框回车（查找），避免与 App 窗口级快捷键打架
  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      dispatch("close");
      return;
    }
    if (e.key === "Enter" && (e.target as HTMLElement)?.tagName === "INPUT") {
      e.preventDefault();
      void doSearch();
    }
  }

  function openResult(r: FolderMatch) {
    dispatch("open", { path: r.path, line: r.line });
    dispatch("close");
  }
</script>

<svelte:window on:keydown|capture={onKeydown} />

<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
<div class="mask" on:click={() => dispatch("close")}>
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <div class="dialog" on:click|stopPropagation>
    <div class="head">
      <span class="title">文件夹内查找替换</span>
      <span class="folder" title={folder}>{folder}</span>
      <span style="flex:1" />
      <button class="x" on:click={() => dispatch("close")} title="关闭">✕</button>
    </div>

    <div class="bar">
      <input class="q" bind:value={query} placeholder="查找…" />
      <input class="q" bind:value={replacement} placeholder="替换为…" />
      <label class="case">
        <input type="checkbox" bind:checked={caseSensitive} />
        区分大小写
      </label>
      <button on:click={doSearch} disabled={busy}>{busy ? "处理中…" : "查找"}</button>
      <button on:click={doReplaceAll} disabled={busy || !query}>全部替换</button>
    </div>

    <div class="msg">{message}</div>

    <div class="results">
      {#if grouped.length}
        {#each grouped.slice(0, visibleGroups) as [path, matches]}
          <div class="file-group">
            <div class="file-name" title={path}>
              {rel(path)}
              <span class="cnt">{matches.length}</span>
            </div>
            {#each matches as m}
              <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
              <div class="fs-item" on:click={() => openResult(m)}>
                <span class="ln">{m.line}</span>
                <span class="txt">{m.text || "（空行）"}</span>
              </div>
            {/each}
          </div>
        {/each}
        {#if grouped.length > visibleGroups}
          <button class="more" on:click={() => (visibleGroups += GROUP_BATCH)}>
            展开更多（还有 {grouped.length - visibleGroups} 个文件）
          </button>
        {/if}
      {:else if searched}
        <div class="empty">无匹配结果</div>
      {:else}
        <div class="empty">输入关键词后点「查找」，结果按文件分组；点结果跳转到对应行。</div>
      {/if}
    </div>
  </div>
</div>

{#if confirmReplace}
  <ConfirmModal
    title="批量替换确认"
    message={`将在文件夹下所有 .md 中把「${query}」替换为「${replacement}」。\n此操作不可撤销，确定继续？`}
    confirmText="全部替换"
    danger={true}
    on:confirm={onReplaceConfirm}
    on:cancel={() => (confirmReplace = false)}
  />
{/if}

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
    width: 720px;
    max-width: 92vw;
    height: 560px;
    max-height: 86vh;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 14px;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.3);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .head {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
  }

  .title {
    font-weight: 600;
    color: var(--text);
  }

  .folder {
    font-size: 12px;
    color: var(--text-2);
    max-width: 380px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .x {
    width: 28px;
    height: 28px;
    border: none;
    background: transparent;
  }

  .bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 16px;
    flex-wrap: wrap;
  }

  .bar input.q {
    flex: 1;
    min-width: 140px;
    height: 30px;
    padding: 0 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--panel);
    color: var(--text);
    font-size: 13px;
  }

  .bar input.q:focus {
    outline: none;
    border-color: var(--accent);
  }

  .case {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 13px;
    color: var(--text-2);
    cursor: pointer;
    white-space: nowrap;
  }

  .bar button {
    height: 30px;
    padding: 0 14px;
    font-size: 13px;
  }

  .msg {
    padding: 0 16px 8px;
    font-size: 12px;
    color: var(--accent);
    min-height: 20px;
  }

  .results {
    flex: 1;
    overflow: auto;
    padding: 4px 8px 12px;
  }

  .file-group {
    margin-bottom: 8px;
  }

  .file-name {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    font-size: 12px;
    font-weight: 600;
    color: var(--text-2);
  }

  .file-name .cnt {
    font-size: 11px;
    font-weight: 400;
    color: var(--accent);
    background: var(--accent-soft);
    border-radius: 8px;
    padding: 0 6px;
  }

  .fs-item {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 3px 8px 3px 20px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 13px;
  }

  .fs-item:hover {
    background: var(--accent-soft);
  }

  .fs-item .ln {
    flex-shrink: 0;
    width: 34px;
    text-align: right;
    font-size: 11px;
    color: var(--text-2);
  }

  .fs-item .txt {
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .more {
    display: block;
    margin: 8px auto 4px;
    padding: 4px 14px;
    font-size: 12px;
  }

  .empty {
    padding: 24px 16px;
    text-align: center;
    font-size: 13px;
    color: var(--text-2);
  }
</style>
