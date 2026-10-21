<script lang="ts">
  // LM-23 统一导出对话框（薄壳）：调现有 exportMarkdown/exportPdfDoc/exportHtmlDoc/exportBundledMd。
  // 格式四选一（默认 Markdown），目标目录可经「更改位置」挑选，确认后把计算出的完整路径
  // 回传 App，由底层导出函数写出（Rust 侧命令不动）。
  import { createEventDispatcher, onMount } from "svelte";
  import { pickOpenFolder } from "./fs";

  export let notePath = "";
  export let defaultFormat: "md" | "pdf" | "html" | "bundled" = "md";

  const dispatch = createEventDispatcher<{
    close: void;
    export: { format: "md" | "pdf" | "html" | "bundled"; targetPath: string };
  }>();

  interface Fmt {
    id: "md" | "pdf" | "html" | "bundled";
    label: string;
    ext: string;
    suffix: string;
    hint: string;
  }
  // 顺序即「你更可能要哪个」：Markdown 默认选中，PDF/HTML/自包含按使用频度排（设计 LM-23）
  const FORMATS: Fmt[] = [
    { id: "md", label: "Markdown（.md）", ext: ".md", suffix: "", hint: "纯文本" },
    { id: "pdf", label: "PDF（.pdf）", ext: ".pdf", suffix: "", hint: "Rust 排版 · A4" },
    { id: "html", label: "HTML（.html）", ext: ".html", suffix: "", hint: "内联样式单文件" },
    { id: "bundled", label: "自包含 MD", ext: ".md", suffix: "_bundled", hint: "图片内嵌" },
  ];

  let selected: Fmt["id"] = defaultFormat;
  let targetDir = dirOf(notePath);

  function dirOf(p: string): string {
    return p.replace(/[\\/][^\\/]*$/, "") || p;
  }
  function baseOf(p: string): string {
    const name = p.replace(/^.*[\\/]/, "");
    return name.replace(/\.[^.]+$/, "");
  }
  function extOf(p: string): string {
    const m = p.match(/\.[^.]+$/);
    return m ? m[0] : "";
  }
  function fileNameOf(fmt: Fmt): string {
    return baseOf(notePath) + fmt.suffix + fmt.ext;
  }
  function targetPathOf(fmt: Fmt): string {
    const d = targetDir.replace(/[\\/]+$/, "");
    const sep = /\\/.test(d) ? "\\" : "/";
    return d + sep + fileNameOf(fmt);
  }

  function chooseFormat(id: Fmt["id"]) {
    selected = id;
  }

  async function changeLocation() {
    const d = await pickOpenFolder();
    if (d) targetDir = d;
  }

  function doExport() {
    const fmt = FORMATS.find((f) => f.id === selected);
    if (!fmt) return;
    dispatch("export", { format: fmt.id, targetPath: targetPathOf(fmt) });
  }

  function cancel() {
    dispatch("close");
  }

  // 捕获阶段拦截 Enter / Esc，避免与 App 窗口级快捷键打架
  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancel();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      doExport();
    }
  }

  onMount(() => {
    selected = defaultFormat;
    targetDir = dirOf(notePath);
  });
</script>

<svelte:window on:keydown|capture={onKeydown} />

<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
<div class="ex-mask" on:click={cancel}>
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <div class="ex-dialog" on:click|stopPropagation role="dialog" aria-label="导出" tabindex="-1">
    <div class="ex-title">导出 · {baseOf(notePath)}{extOf(notePath)}</div>

    <div class="ex-formats">
      {#each FORMATS as f (f.id)}
        <!-- svelte-ignore a11y-click-events-have-key-events -->
        <button
          class="ex-row"
          class:sel={selected === f.id}
          on:click={() => chooseFormat(f.id)}
        >
          <svg class="ex-ic" viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M4 1.5h5L13 5v9.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-12a1 1 0 0 1 1-1Z"
              fill="none"
              stroke="currentColor"
              stroke-width="1.2"
            />
            <path d="M9 1.5V5h4" fill="none" stroke="currentColor" stroke-width="1.2" />
          </svg>
          <span class="ex-name">{f.label}</span>
          <span class="ex-hint">{f.hint}</span>
        </button>
      {/each}
    </div>

    <div class="ex-path">
      <span class="ex-path-label">保存到</span>
      <span class="ex-path-val" title={targetPathOf(FORMATS.find((f) => f.id === selected)!)}>
        {targetPathOf(FORMATS.find((f) => f.id === selected)!)}
      </span>
    </div>

    <div class="ex-btns">
      <button class="ex-btn ex-secondary" on:click={changeLocation}>更改位置</button>
      <button class="ex-btn ex-primary" on:click={doExport}>导出</button>
    </div>
  </div>
</div>

<style>
  .ex-mask {
    position: fixed;
    inset: 0;
    background: var(--mask);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 120;
  }

  .ex-dialog {
    width: 440px;
    max-width: 92vw;
    background: var(--bg);
    border: 1px solid var(--srf);
    border-radius: 16px;
    box-shadow: var(--rs-l);
    padding: 18px 20px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .ex-title {
    font-weight: 600;
    font-size: 15px;
    color: var(--t1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ex-formats {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .ex-row {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 6px 9px;
    border: none;
    border-radius: 9px;
    background: transparent;
    color: var(--t1);
    font-size: 12px;
    cursor: pointer;
    text-align: left;
  }

  .ex-row:hover {
    background: var(--hov);
  }

  .ex-row.sel {
    background: var(--bg);
    box-shadow: var(--is-s);
    color: var(--p);
    font-weight: 600;
  }

  .ex-ic {
    width: 14px;
    height: 14px;
    flex-shrink: 0;
  }

  .ex-name {
    flex: 1;
    min-width: 0;
  }

  .ex-hint {
    font-size: 10.5px;
    color: var(--t3);
  }

  .ex-path {
    display: flex;
    align-items: baseline;
    gap: 6px;
    font-size: 11px;
    color: var(--t2);
  }

  .ex-path-val {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ex-btns {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 2px;
  }

  .ex-btn {
    height: 32px;
    padding: 0 16px;
    font-size: 13px;
    border: none;
    border-radius: 16px;
    cursor: pointer;
  }

  .ex-secondary {
    background: var(--bg);
    box-shadow: var(--rs-s);
    color: var(--t1);
  }

  .ex-secondary:hover {
    background: var(--hov);
  }

  .ex-primary {
    background: linear-gradient(135deg, var(--pt) 0%, var(--pb) 100%);
    color: #fff;
  }
</style>
