<!--
  Toolbar.svelte —— 工具栏（LM-03 四段重组：撤销重做｜插入｜格式｜视图模式）
  集成阶段产物：按钮统一走 dispatch(id)（action-dispatch 注册表）；
  少数无 action id 的既有能力（格式刷/颜色/表格列对齐/主题切换）走回调 props。
  样式复用既有 .tb 体系，段分组用 .tb-seg；本条目不新增 style.css，由集成方补 .tb-seg。
-->
<script lang="ts">
  export let dispatch: (id: string) => void;
  export let accelFn: (id: string) => string;
  export let theme: "light" | "dark";
  export let focusMode: boolean;
  export let painterOn: boolean;
  export let colorMenu: "fg" | "bg" | null;
  export let palette: string[];

  // 视图模式三态（LM-03 模式分段控件）：状态由 App 双标志派生，点击走 dispatch
  export let viewMode: "live" | "source" | "split" = "split";

  // 无 action id 的既有能力回调（保持行为不变，不污染注册表）
  export let onPainter: (fix: boolean) => void;      // 格式刷：单击应用一次 / 双击固定
  export let onColorMenu: (type: "fg" | "bg") => void;
  export let onPickColor: (hex: string) => void;
  export let onCustomColor: (e: Event) => void;
  export let onToggleTheme: () => void;
  export let onAlignCol: (dir: "left" | "center" | "right") => void;
</script>

<div class="tb">
  <!-- 段 1 · 撤销重做 -->
  <div class="tb-seg">
    <button on:click={() => dispatch("edit.undo")} title="撤销 {accelFn("edit.undo")}">↶</button>
    <button on:click={() => dispatch("edit.redo")} title="重做 {accelFn("edit.redo")}">↷</button>
  </div>
  <span class="sep"></span>

  <!-- 段 2 · 插入 -->
  <div class="tb-seg">
    <button on:click={() => dispatch("format.link")} title="插入链接 {accelFn("format.link")}">🔗</button>
    <button on:click={() => dispatch("insert.image")} title="插入图片 {accelFn("insert.image")}">🖼</button>
    <button on:click={() => dispatch("insert.codeBlock")} title="插入代码块 {accelFn("insert.codeBlock")}">{'{ }'}</button>
    <button on:click={() => dispatch("insert.table")} title="插入表格 {accelFn("insert.table")}">▦</button>
  </div>
  <span class="sep"></span>

  <!-- 段 3 · 格式 -->
  <div class="tb-seg">
    <button on:click={() => dispatch("format.bold")} title="加粗 {accelFn("format.bold")}"><b>B</b></button>
    <button on:click={() => dispatch("format.italic")} title="斜体 {accelFn("format.italic")}"><i>I</i></button>
    <button on:click={() => dispatch("format.underline")} title="下划线 {accelFn("format.underline")}"><u>U</u></button>
    <button on:click={() => dispatch("format.strike")} title="删除线 {accelFn("format.strike")}">S</button>
    <button
      on:click={() => onPainter(false)}
      on:dblclick={() => onPainter(true)}
      class:on={painterOn}
      title="格式刷（单击应用一次 / 双击固定，Esc 退出）">🖌</button>
    <span class="color-wrap">
      <button on:click={() => onColorMenu("fg")} class:on={colorMenu === "fg"} title="字体颜色"><span class="fg-a">A</span></button>
      <button on:click={() => onColorMenu("bg")} class:on={colorMenu === "bg"} title="背景颜色">🖍</button>
      {#if colorMenu}
        <div class="color-pop">
          {#each palette as hex}
            <button class="swatch" style="background:{hex}" title={hex} on:click={() => onPickColor(hex)}></button>
          {/each}
          <label class="custom-color" title="自定义颜色">
            <input type="color" value="#ff0000" on:change={onCustomColor} />
            自定义
          </label>
        </div>
      {/if}
    </span>
  </div>
  <span class="sep"></span>

  <!-- 段 3 续 · 段落格式 -->
  <div class="tb-seg">
    <button on:click={() => dispatch("format.h1")} title="标题 {accelFn("format.h1")}">H</button>
    <button on:click={() => dispatch("insert.bullet")} title="无序列表 {accelFn("insert.bullet")}">•</button>
    <button on:click={() => dispatch("insert.orderedList")} title="有序列表 {accelFn("insert.orderedList")}">1.</button>
    <button on:click={() => dispatch("insert.task")} title="任务列表 {accelFn("insert.task")}">☐</button>
    <button on:click={() => dispatch("format.quote")} title="引用 {accelFn("format.quote")}">❝</button>
  </div>
  <span class="sep"></span>

  <!-- 段 3 末 · 表格列对齐（无 action id，走回调） -->
  <div class="tb-seg">
    <button on:click={() => onAlignCol("left")} title="左对齐（表格列）">⬅</button>
    <button on:click={() => onAlignCol("center")} title="居中对齐（表格列）">☰</button>
    <button on:click={() => onAlignCol("right")} title="右对齐（表格列）">➡</button>
  </div>
  <span class="sep"></span>

  <!-- 段 4 · 视图模式：LM-03 模式分段控件（实时/源码/分屏，右对齐）替代隐式预览开关 -->
  <div class="tb-seg seg-end">
    <div class="modeseg" role="radiogroup" aria-label="视图模式">
      <button class:on={viewMode === "live"} on:click={() => dispatch("view.modeRealtime")} title="实时预览（所见即所得） {accelFn("view.modeRealtime")}">实时</button>
      <button class:on={viewMode === "source"} on:click={() => dispatch("view.modeSource")} title="源码模式 {accelFn("view.modeSource")}">源码</button>
      <button class:on={viewMode === "split"} on:click={() => dispatch("view.modeSplit")} title="分屏预览 {accelFn("view.modeSplit")}">分屏</button>
    </div>
    <button on:click={onToggleTheme} title="切换主题">
      {theme === "dark" ? "☀" : "🌙"}
    </button>
    <button on:click={() => dispatch("view.focusMode")} class:on={focusMode} title="专注模式 {accelFn("view.focusMode")}">⛶</button>
    <button on:click={() => dispatch("app.settings")} title="设置">⚙</button>
  </div>
</div>
