<script lang="ts">
  // 自定义输入对话框：替代 window.prompt，避免标题栏出现 tauri.localhost。
  // 保存路径可编辑（也可点 📁 调系统文件夹选择器），Enter 确认 / Esc 取消。
  import { createEventDispatcher, onMount } from "svelte";

  export let title = "";
  export let label = "";
  export let value = "";
  export let path = "";
  export let confirmText = "确定";

  const dispatch = createEventDispatcher<{
    confirm: { name: string; path: string };
    cancel: void;
    browse: void;
  }>();

  let input: HTMLInputElement;
  onMount(() => {
    input?.focus();
    input?.select();
  });

  function confirm() {
    dispatch("confirm", { name: value, path });
  }

  // 捕获阶段拦截 Enter / Esc，避免与 App 窗口级快捷键打架
  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      dispatch("cancel");
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      confirm();
    }
  }
</script>

<svelte:window on:keydown|capture={onKeydown} />

<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
<div class="pm-mask" on:click={() => dispatch("cancel")}>
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <div class="pm-dialog" on:click|stopPropagation>
    <div class="pm-title">{title}</div>
    <label class="pm-label" for="pm-path">保存到</label>
    <div class="pm-pathrow">
      <input id="pm-path" class="pm-input path" bind:value={path} placeholder="输入或选择本地路径" title={path} />
      <button class="pm-browse" on:click={() => dispatch("browse")} title="浏览文件夹…">📁</button>
    </div>
    <label class="pm-label" for="pm-input">{label}</label>
    <input id="pm-input" class="pm-input" bind:value bind:this={input} />
    <div class="pm-btns">
      <button class="pm-btn" on:click={() => dispatch("cancel")}>取消</button>
      <button class="pm-btn primary" on:click={confirm}>{confirmText}</button>
    </div>
  </div>
</div>

<style>
  .pm-mask {
    position: fixed;
    inset: 0;
    background: var(--mask);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 120;
  }

  .pm-dialog {
    width: 420px;
    max-width: 90vw;
    background: var(--bg);
    border: 1px solid var(--srf);
    border-radius: 16px;
    box-shadow: var(--rs-l);
    padding: 18px 20px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .pm-title {
    font-weight: 600;
    font-size: 15px;
    color: var(--t1);
  }

  .pm-pathrow {
    display: flex;
    gap: 6px;
    align-items: stretch;
  }

  .pm-input.path {
    flex: 1;
    min-width: 0;
    font-size: 13px;
  }

  .pm-browse {
    flex-shrink: 0;
    width: 38px;
    border: none;
    border-radius: 9px;
    background: var(--bg);
    box-shadow: var(--rs-s);
    color: var(--t1);
    cursor: pointer;
    font-size: 15px;
  }

  .pm-browse:hover {
    background: var(--hov);
  }

  .pm-label {
    font-size: 13px;
    color: var(--t2);
  }

  .pm-input {
    height: 34px;
    padding: 0 10px;
    border: none;
    border-radius: 9px;
    background: var(--bg);
    box-shadow: var(--is-s);
    color: var(--t1);
    font-size: 14px;
  }

  .pm-input:focus {
    outline: none;
    border: 1.5px solid var(--p);
    box-shadow: var(--is-s);
  }

  .pm-btns {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 4px;
  }

  .pm-btn {
    height: 32px;
    padding: 0 16px;
    font-size: 13px;
    border-radius: 16px;
    border: none;
    background: var(--bg);
    box-shadow: var(--rs-s);
    color: var(--t1);
    cursor: pointer;
  }

  .pm-btn.primary {
    background: linear-gradient(135deg, var(--pt) 0%, var(--pb) 100%);
    color: #fff;
  }
</style>
