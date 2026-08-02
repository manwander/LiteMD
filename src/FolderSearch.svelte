<script lang="ts">
  // 跨文件查找替换：在当前文件夹（默认目录）下所有 .md 中查找、批量替换。
  // 结果按文件分组，点击单条结果跳转到对应文件对应行。
  import { createEventDispatcher } from "svelte";
  import { searchInFolder, replaceInFolder, type FolderMatch } from "./fs";

  export let folder: string;

  const dispatch = createEventDispatcher<{
    close: void;
    open: { path: string; line: number };
  }>();

  let query = "";
  let replacement = "";
  let caseSensitive = false;
  let results: FolderMatch[] = [];
  let busy = false;
  let searched = false;
  let message = "";

  const norm = (s: string) => s.replace(/\\/g, "/");

  async function doSearch() {
    if (!query) {
      message = "请输入查找内容";
      return;
    }
    busy = true;
    message = "";
    try {
      results = await searchInFolder(folder, query, caseSensitive);
      searched = true;
      message = results.length ? `找到 ${results.length} 处匹配` : "未找到匹配";
    } catch (e) {
      message = "查找失败：" + String(e);
    } finally {
      busy = false;
    }
  }

  async function doReplaceAll() {
    if (!query) {
      message = "请输入查找内容";
      return;
    }
    const ok = window.confirm(
      `将在文件夹下所有 .md 中把「${query}」替换为「${replacement}」。\n此操作不可撤销，确定继续？`
    );
    if (!ok) return;
    busy = true;
    message = "";
    try {
      const res = await replaceInFolder(folder, query, replacement, caseSensitive);
      message = `已替换 ${res.count} 处（${res.filesChanged} 个文件）`;
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
        {#each grouped as [path, matches]}
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
      {:else if searched}
        <div class="empty">无匹配结果</div>
      {:else}
        <div class="empty">输入关键词后点「查找」，结果按文件分组；点结果跳转到对应行。</div>
      {/if}
    </div>
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

  .empty {
    padding: 24px 16px;
    text-align: center;
    font-size: 13px;
    color: var(--text-2);
  }
</style>
