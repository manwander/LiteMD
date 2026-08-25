<script lang="ts">
  import { toasts } from "./toast";
</script>

<div class="toast-wrap" aria-live="polite">
  {#each $toasts as t (t.id)}
    <div class="toast toast-{t.kind}">{t.msg}</div>
  {/each}
</div>

<style>
  .toast-wrap {
    position: fixed;
    top: 14px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 99999;
    display: flex;
    flex-direction: column;
    gap: 8px;
    pointer-events: none;
  }
  .toast {
    pointer-events: auto;
    max-width: 70vw;
    padding: 9px 16px;
    border-radius: 8px;
    font-size: 13px;
    line-height: 1.4;
    color: var(--text);
    background: var(--toast-bg, #ffffff);
    border: 1px solid var(--border, #e2e2e6);
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
    animation: toast-in 160ms ease-out;
  }
  .toast-success {
    border-left: 3px solid #2e9e5b;
  }
  .toast-error {
    border-left: 3px solid #e0483d;
  }
  .toast-info {
    border-left: 3px solid var(--accent, #3b82f6);
  }
  @keyframes toast-in {
    from {
      opacity: 0;
      transform: translateY(-8px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
</style>
