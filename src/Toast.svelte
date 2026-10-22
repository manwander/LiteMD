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
    /* LM-17：右下角堆叠（bottom 38 让出状态栏），右对齐、自下而上生长 */
    position: fixed;
    right: 14px;
    bottom: 38px;
    z-index: 99999;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 8px;
    pointer-events: none;
  }
  .toast {
    pointer-events: auto;
    max-width: 70vw;
    padding: 9px 16px;
    border-radius: 12px;
    font-size: 13px;
    line-height: 1.4;
    color: var(--t1);
    background: var(--bg);
    border: 1px solid var(--srf);
    box-shadow: var(--rs);
    animation: toast-in 160ms ease-out;
  }
  .toast-success {
    border-left: 3px solid var(--ok);
  }
  .toast-warn {
    border-left: 3px solid var(--warn);
  }
  .toast-error {
    border-left: 3px solid var(--err);
  }
  .toast-info {
    border-left: 3px solid var(--p);
  }
  @keyframes toast-in {
    from {
      opacity: 0;
      /* 右下角入场：自下而上浮现 */
      transform: translateY(8px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
</style>
