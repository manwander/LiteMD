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
</script>

<footer class="statusbar">
  <span class="sb-path" title={currentPath ?? ""}>{currentPath ?? "未保存"}</span>
  <span>{status}</span>
  <span class="spacer" />
  <span>行 {cursorLine} : 列 {cursorCol}</span>
  <span>{words} 字 · {chars} 字符</span>
  <span>{autoSave ? "自动保存开" : "自动保存关"}</span>
  <span>{fontSize}px</span>
</footer>
