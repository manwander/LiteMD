<script lang="ts">
  // 状态栏：纯展示组件，把 App.svelte 里散落的 7 个 span 收敛进来。
  // 数据通过 props 传入，不持有内部状态，HMR / 测试都更稳定。
  export let currentPath: string | null;
  export let status: string;
  export let cursorLine: number;
  export let cursorCol: number;
  export let words: number;
  export let chars: number;
  export let autoSave: boolean;
  export let fontSize: number;
  /**
   * UX-1：文档超过手动刷新上限时，预览被静默禁用，用户只看到「预览空白」而无任何解释。
   * 这里给一个常驻徽标说明原因，避免被当成 bug。空串表示不显示。
   */
  export let previewNotice: string = "";
</script>

<footer class="statusbar">
  <span class="sb-path" title={currentPath ?? ""}>{currentPath ?? "未保存"}</span>
  <span>{status}</span>
  {#if previewNotice}
    <span class="sb-warn" title="超大文档下全量渲染预览会造成数百毫秒卡顿，因此自动禁用。编辑与保存不受影响。">
      ⚠ {previewNotice}
    </span>
  {/if}
  <span class="spacer" />
  <span>行 {cursorLine} : 列 {cursorCol}</span>
  <span>{words} 字 · {chars} 字符</span>
  <span>{autoSave ? "自动保存开" : "自动保存关"}</span>
  <span>{fontSize}px</span>
</footer>

<style>
  .sb-warn {
    color: #b26a00;
    background: rgba(255, 176, 32, 0.14);
    border-radius: 4px;
    padding: 0 6px;
    white-space: nowrap;
    cursor: help;
  }
</style>
