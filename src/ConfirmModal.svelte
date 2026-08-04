<script lang="ts">
  // 自定义确认对话框：替代 window.confirm，避免标题栏出现 tauri.localhost。
  // Enter 确认 / Esc 取消。
  import { createEventDispatcher, onMount } from "svelte";

  export let title = "";
  export let message = "";
  export let confirmText = "确定";
  export let cancelText = "取消";
  export let thirdText = ""; // 可选第三按钮（如“保存并关闭”），为空则不显示
  export let danger = false;

  const dispatch = createEventDispatcher<{ confirm: void; cancel: void; third: void }>();

  let btn: HTMLButtonElement;
  onMount(() => btn?.focus());

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
      dispatch("confirm");
    }
  }
</script>

<svelte:window on:keydown|capture={onKeydown} />

<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
<div class="cm-mask" on:click={() => dispatch("cancel")}>
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <div class="cm-dialog" on:click|stopPropagation>
    <div class="cm-title">{title}</div>
    <div class="cm-msg">{message}</div>
    <div class="cm-btns">
      {#if thirdText}
        <button class="cm-btn cm-btn-third" on:click={() => dispatch("third")}>{thirdText}</button>
      {/if}
      <button class="cm-btn" on:click={() => dispatch("cancel")}>{cancelText}</button>
      <button class="cm-btn" class:danger bind:this={btn} on:click={() => dispatch("confirm")}
        >{confirmText}</button>
    </div>
  </div>
</div>

<style>
  .cm-mask {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.35);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 130;
  }

  .cm-dialog {
    width: 400px;
    max-width: 90vw;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 12px;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.3);
    padding: 18px 20px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .cm-title {
    font-weight: 600;
    font-size: 15px;
    color: var(--text);
  }

  .cm-msg {
    font-size: 13px;
    color: var(--text-2);
    line-height: 1.6;
    word-break: break-all;
  }

  .cm-btns {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 4px;
  }

  .cm-btn {
    height: 32px;
    padding: 0 16px;
    font-size: 13px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--panel);
    color: var(--text);
    cursor: pointer;
  }

  .cm-btn.danger {
    background: #d32f2f;
    border-color: #d32f2f;
    color: #fff;
  }

  /* 第三按钮（保存并关闭）：主操作强调色 */
  .cm-btn-third {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }

  .cm-btn-third:hover {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
    filter: brightness(1.1);
  }
</style>
