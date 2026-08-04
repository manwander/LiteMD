<script lang="ts">
  // 预览按视口增量渲染（窗口式虚拟化）
  //
  // 原理：
  // 1. 把 markdown 文档按顶层块切分（block-splitter.ts）
  // 2. 只把「视口上下各 prerenderMargin 像素」内的块挂进 DOM，其余块用上下两个
  //    占位 spacer 撑高度 —— 4000 块的文档 DOM 中也只有几十个节点
  // 3. 块高度先用估算值（estimateBlockHeight），渲染后由 ResizeObserver 批量实测校正
  // 4. source 变化时按「块内容哈希」复用上一轮的渲染 HTML 与实测高度：
  //    打字通常只改光标附近 1~3 个块，其余块零开销，滚动条位置不再随打字跳动
  // 5. 滚动事件 + rAF 节流控制可视窗口更新
  import { onMount, onDestroy } from "svelte";
  import { splitIntoBlocks, renderBlock, type PreviewBlock, type EditRange } from "./block-splitter";
  import { HeightPrefixSum, computeWindow, heightScale, type WindowResult } from "./windowing";
  import type MarkdownIt from "markdown-it";

  export let md: MarkdownIt | null = null; // markdown-it 动态加载中为 null，就绪后触发重建
  export let source: string = "";
  /** 高亮语言包版本号：变化后旧渲染 HTML（无高亮）失效需重渲，实测高度仍复用 */
  export let hlVersion = 0;
  /** 相对上一次 source 的脏区间（编辑器变更累计）；undefined 时走全量切块 */
  export let edits: EditRange | undefined = undefined;
  /** 视口上下预读多少像素 */
  export let prerenderMargin: number = 800;
  /** 每帧最多真实渲染多少个新块（防止滚动时阻塞主线程） */
  export let renderBudgetPerFrame: number = 8;
  /** 空闲预渲染屏数（2=上下各 2 屏；0=关闭，省 CPU/内存） */
  export let idlePrerenderScreens: number = 2;
  /** 预览容器是否启用 will-change 合成层（低端设备关，省 VRAM） */
  export let useWillChange: boolean = true;
  /** 预览块 HTML 缓存条数上限（LRU 超出后驱逐最久未用，而非整体清空） */
  export let maxCacheEntries: number = 20000;
  /** 预览块 HTML 缓存字节上限（与条数上限并行约束，防止大文档缓存无限膨胀） */
  export let maxCacheBytes: number = 24 << 20;
  /** 视口外 <img> 是否剥离 src 触发解码位图回收（内存压力下启用，低端常开） */
  export let imgReclaim: boolean = false;

  // ---- 块内容缓存（跨 source 更新保留，打字时未变块零开销）----
  // LRU：Map 保留插入顺序，首项即最久未用；容量/字节超上限时驱逐首项，而非整体 clear
  // （旧逻辑 cache.clear() 会一次性丢弃全部实测高度与渲染 HTML → 滚动条跳变，且大文档
  //  缓存越界时反复 clear 反而更费）。onResize/renderOne 命中会置为 MRU，冷条目优先淘汰。
  type Cached = { html: string; h: number; hl: number };
  let cache = new Map<string, Cached>();
  let cacheBytes = 0;

  function cachePeek(key: string): Cached | undefined {
    return cache.get(key);
  }
  function cachePut(key: string, html: string, h: number, hl: number): void {
    const existing = cache.get(key);
    if (existing) {
      cacheBytes -= existing.html.length;
      cache.delete(key); // 重插到 MRU 端
    }
    cache.set(key, { html, h, hl });
    cacheBytes += html.length;
    enforceCacheCap();
  }
  function enforceCacheCap(): void {
    while ((cache.size > maxCacheEntries || cacheBytes > maxCacheBytes) && cache.size > 1) {
      const oldest = cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      const v = cache.get(oldest)!;
      cacheBytes -= v.html.length;
      cache.delete(oldest);
    }
  }

  // ---- 状态 ----
  let blocks: PreviewBlock[] = [];
  let keys: string[] = [];          // 每块内容哈希键
  let heights: number[] = [];       // 估算高度（未实测时的占位）
  let realHeights: number[] = [];   // 实测高度（0 = 未实测）
  let htmls: string[] = [];         // 渲染 HTML（"" = 未渲染）
  let renderedFlags: boolean[] = [];

  // ---- 视口窗口 ----
  let container: HTMLDivElement;
  let rangeStart = -1;
  let rangeEnd = -1;
  let visible: { i: number; key: string; type: string }[] = [];
  let topPad = 0;
  let bottomPad = 0;
  let pendingQueue: number[] = [];
  let rafId = 0;
  let windowRafId = 0;
  // Fenwick 前缀和：把 updateVisibleWindow 的 O(n) 总高 + 起止扫描降到 O(log²n)，
  // 高度被实测校正时增量 treeAdd，避免 57 万块文档每帧 3~6ms 的遍历开销。
  let htree: HeightPrefixSum | null = null;

  // ---- 空闲预渲染：滚动停止 150ms 后，用 requestIdleCallback 按预算预渲染
  //      视口外 1~2 屏的块（只生成 HTML 入缓存，不挂 DOM），快速滚动时掉帧更少 ----
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let idleCbId: any = 0;
  let idleQueue: number[] = [];

  // ---- 批量测高：一个 ResizeObserver 观察所有挂载块，回调里统一处理，
  //      避免逐块 getBoundingClientRect 造成 layout thrashing ----
  const nodeIndex = new Map<Element, number>();
  let ro: ResizeObserver | null = null;

  function blockH(i: number): number {
    return realHeights[i] || heights[i];
  }

  // 块内容哈希用 block-splitter 的 hashRange（基于区间遍历，无 slice 分配）；
  // 双路哈希 + 长度 → 碰撞概率可忽略（错误命中的 HTML 会在下次实测/重渲时纠正）

  // ---- source / hlVersion 变化：重新切分并从缓存继承 ----
  $: rebuild(md, source, hlVersion, edits);

  function rebuild(_md: MarkdownIt | null, src: string, hl: number, ed: EditRange | undefined) {
    if (!_md) return; // 解析器未就绪：切块/渲染全部延后，md 就绪时响应式再次触发
    const newBlocks = splitIntoBlocks(_md, src, ed);
    const n = newBlocks.length;
    const newKeys: string[] = new Array(n);
    const newHeights: number[] = new Array(n);
    const newReal: number[] = new Array(n);
    const newHtml: string[] = new Array(n);
    const newFlags: boolean[] = new Array(n);

    for (let i = 0; i < n; i++) {
      const b = newBlocks[i];
      // hash / estH 由切块时一并算好（随段缓存复用），此处 O(1) 读取，
      // 免除每次 rebuild 两次全文遍历（1MB 档实测节省 ~10ms）
      const key = b.hash;
      newKeys[i] = key;
      newHeights[i] = b.estH;
      const cached = cachePeek(key);
      if (cached) {
        // 实测高度无条件继承（与高亮无关）→ 滚动条位置稳定
        newReal[i] = cached.h;
        // HTML 仅在当前高亮版本下有效时继承
        if (cached.html && cached.hl >= hl) {
          newHtml[i] = cached.html;
          newFlags[i] = true;
        } else {
          newHtml[i] = "";
          newFlags[i] = false;
        }
      } else {
        newReal[i] = 0;
        newHtml[i] = "";
        newFlags[i] = false;
      }
    }

    blocks = newBlocks;
    keys = newKeys;
    heights = newHeights;
    realHeights = newReal;
    htmls = newHtml;
    renderedFlags = newFlags;
    pendingQueue = [];
    // 用当前有效高度（realHeights[i] || heights[i]）重建 Fenwick 前缀和
    const hs = new Array<number>(n);
    for (let i = 0; i < n; i++) hs[i] = blockH(i);
    htree = new HeightPrefixSum(hs);
    stopIdlePrerender();
    // 强制下一次窗口计算重建 visible（内容可能全变）
    rangeStart = -1;
    rangeEnd = -1;
    scheduleWindowUpdate();
  }

  // ---- 可视窗口计算 ----
  function scheduleWindowUpdate() {
    if (windowRafId) return;
    windowRafId = requestAnimationFrame(() => {
      windowRafId = 0;
      updateVisibleWindow();
    });
  }

  function updateVisibleWindow() {
    if (!container || !htree) return;
    const n = blocks.length;
    if (!n) {
      visible = [];
      topPad = 0;
      bottomPad = 0;
      rangeStart = -1;
      rangeEnd = -1;
      return;
    }

    // 超高文档比例映射（P2-3）：总高超 Chromium 元素高度硬限时，scrollTop/预读
    // 边距按 1/k 换算到虚拟空间算窗口，占位高度乘 k 写回 DOM；k=1 时数学恒等，
    // 常规文档零行为变化。
    const k = heightScale(htree.total);

    // Fenwick 前缀和二分：O(log²n)，替代原 O(n) 总高 + 起止三段扫描
    const win: WindowResult = computeWindow(
      htree,
      container.scrollTop / k,
      prerenderMargin / k,
      container.clientHeight / k,
      prerenderMargin / k,
    );
    const s = win.s;
    const e = win.e;

    // 占位高度始终更新（高度校正后滚动条平滑）；映射后 DOM 总高 ≤ LIMIT + O(视口)
    topPad = win.topPad * k;
    bottomPad = win.bottomPad * k;

    // 迟滞：新范围仍在已挂载范围内 → 不动 DOM（减少滚动时 each 调和）
    if (visible.length && s >= rangeStart && e <= rangeEnd) return;

    rangeStart = s;
    rangeEnd = e;
    const next: { i: number; key: string; type: string }[] = [];
    for (let i = s; i < e; i++) {
      next.push({ i, key: i + ":" + keys[i], type: blocks[i].type });
    }
    visible = next;
    queueUnrendered(s, e);
  }

  function queueUnrendered(s: number, e: number) {
    let queued = false;
    for (let i = s; i < e; i++) {
      if (!renderedFlags[i] && !pendingQueue.includes(i)) {
        pendingQueue.push(i);
        queued = true;
      }
    }
    if (queued) scheduleRender();
  }

  // ---- 节流渲染队列 ----
  function scheduleRender() {
    if (rafId) return;
    rafId = requestAnimationFrame(flushQueue);
  }

  function flushQueue() {
    rafId = 0;
    if (!pendingQueue.length) return;

    const budget = Math.min(renderBudgetPerFrame, pendingQueue.length);
    for (let k = 0; k < budget; k++) {
      const idx = pendingQueue.shift();
      if (idx === undefined) break;
      renderOne(idx);
    }
    // 触发响应式更新（只重算已挂载的 visible 块，成本 O(视口)）
    htmls = htmls;
    renderedFlags = renderedFlags;

    if (pendingQueue.length) scheduleRender();
  }

  function renderOne(idx: number) {
    const block = blocks[idx];
    if (!block || !md) return; // md 未就绪时无渲染任务（rebuild 已延后）
    try {
      const html = renderBlock(md, source, block);
      htmls[idx] = html;
      renderedFlags[idx] = true;
      // 写入缓存，供下次 source 更新直接复用（LRU + 字节上限，绝不整体清空）
      const key = keys[idx];
      const cached = cachePeek(key);
      const h = cached ? cached.h : realHeights[idx];
      cachePut(key, html, h, hlVersion);
    } catch {
      htmls[idx] = "";
    }
  }

  function onScroll() {
    scheduleWindowUpdate();
    // 滚动中取消空闲预渲染，停顿 150ms 后重新排队
    stopIdlePrerender();
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      buildIdleQueue();
    }, 150);
  }

  function buildIdleQueue() {
    if (!container || !blocks.length || rangeStart < 0) return;
    const n = blocks.length;
    const ext = container.clientHeight * idlePrerenderScreens; // 上下各预渲染 N 屏（低端为 0=关闭）
    let s = rangeStart;
    let acc = 0;
    while (s > 0 && acc < ext) { s--; acc += blockH(s); }
    let e = rangeEnd;
    acc = 0;
    while (e < n && acc < ext) { acc += blockH(e); e++; }
    idleQueue = [];
    for (let i = s; i < e; i++) {
      if (!renderedFlags[i]) idleQueue.push(i);
    }
    if (idleQueue.length) scheduleIdleRender();
  }

  function scheduleIdleRender() {
    if (idleCbId) return;
    if (typeof requestIdleCallback === "function") {
      idleCbId = requestIdleCallback(idleRenderStep as any, { timeout: 1000 });
    } else {
      idleCbId = setTimeout(idleRenderStep, 50);
    }
  }

  function idleRenderStep(deadline?: { timeRemaining(): number }) {
    idleCbId = 0;
    if (!idleQueue.length) return;
    const hasTime = () => !deadline || deadline.timeRemaining() > 2;
    let k = 0;
    while (idleQueue.length && k < 8 && hasTime()) {
      const idx = idleQueue.shift()!;
      if (!renderedFlags[idx]) renderOne(idx);
      k++;
    }
    // 只触发已挂载 visible 块的响应式更新
    htmls = htmls;
    renderedFlags = renderedFlags;
    if (idleQueue.length) scheduleIdleRender();
  }

  function stopIdlePrerender() {
    if (idleCbId) {
      if (typeof cancelIdleCallback === "function") cancelIdleCallback(idleCbId);
      else clearTimeout(idleCbId);
      idleCbId = 0;
    }
    idleQueue = [];
  }

  // 对外：窗口拖拽/缩放期间挂起空闲预渲染（P1-1）。窗口恢复后下一次滚动会重新排队，无需手动恢复。
  export function pauseIdlePrerender() {
    stopIdlePrerender();
  }

  // 内存压力自愈（P0）：外部检测到堆超限时清空块 HTML 缓存；已挂载块的实测高度
  // （realHeights）不受影响，滚动条不跳变；后续渲染按需重建并入 LRU。
  export function clearCache() {
    cache.clear();
    cacheBytes = 0;
  }

  // 块挂载 → 交给 ResizeObserver 统一批量测高（不在挂载时强制同步布局）
  function measureBlock(node: HTMLElement, idx: number) {
    nodeIndex.set(node, idx);
    ro?.observe(node);
    return {
      update(nextIdx: number) {
        nodeIndex.set(node, nextIdx);
      },
      destroy() {
        nodeIndex.delete(node);
        ro?.unobserve(node);
        // 内存压力下（低端/超阈值）剥离视口外 <img> 的 src，让浏览器回收解码位图
        // （HTML 源串仍由 htmls[idx] 持有，块重新进入视口时 {@html} 会重新渲染，无内容丢失）
        if (imgReclaim) {
          node.querySelectorAll("img").forEach((im) => {
            const el = im as HTMLImageElement;
            el.removeAttribute("src");
            el.removeAttribute("srcset");
          });
        }
      },
    };
  }

  function onResize(entries: ResizeObserverEntry[]) {
    let changed = false;
    for (const en of entries) {
      const idx = nodeIndex.get(en.target);
      if (idx === undefined || idx >= realHeights.length) continue;
      const h = en.borderBoxSize?.[0]?.blockSize ?? en.contentRect.height;
      if (h > 0 && Math.abs(h - realHeights[idx]) > 1) {
        const oldEffective = realHeights[idx] || heights[idx];
        realHeights[idx] = h;
        // 高度变化增量维护 Fenwick 树（O(log n)），保持可视窗口计算 O(log²n)
        htree?.add(idx, h - oldEffective);
        // 实测高度写回缓存（跨 source 更新继承，滚动条稳定）
        const key = keys[idx];
        const cached = cachePeek(key);
        if (cached) cached.h = h;
        changed = true;
      }
    }
    if (changed) scheduleWindowUpdate();
  }

  // ---- 对外接口：编辑器滚动同步（按总高度比例）----
  export function scrollToRatio(ratio: number) {
    if (!container) return;
    const max = container.scrollHeight - container.clientHeight;
    if (max <= 0) return;
    container.scrollTop = ratio * max;
  }

  // 窗口缩放/最大化：容器可视高度变化，需重算可视窗口。
  // 直接调 scheduleWindowUpdate（其内部已 rAF 节流），避免在 resize 事件洪流里重复计算（P1-3）。
  function onWindowResize() {
    scheduleWindowUpdate();
  }

  onMount(() => {
    ro = new ResizeObserver(onResize);
    for (const node of nodeIndex.keys()) ro.observe(node);
    window.addEventListener("resize", onWindowResize);
    updateVisibleWindow();
  });

  onDestroy(() => {
    ro?.disconnect();
    ro = null;
    window.removeEventListener("resize", onWindowResize);
    if (rafId) cancelAnimationFrame(rafId);
    if (windowRafId) cancelAnimationFrame(windowRafId);
    if (idleTimer) clearTimeout(idleTimer);
    stopIdlePrerender();
  });
</script>

<div class="virtual-preview" class:no-will-change={!useWillChange} bind:this={container} on:scroll={onScroll}>
  {#if topPad > 0}
    <div class="vspacer" style="height:{topPad}px"></div>
  {/if}
  {#each visible as item (item.key)}
    <div class="vblock vblock-{item.type}" use:measureBlock={item.i}>
      {#if renderedFlags[item.i]}
        {@html htmls[item.i]}
      {/if}
    </div>
  {/each}
  {#if bottomPad > 0}
    <div class="vspacer" style="height:{bottomPad}px"></div>
  {/if}
</div>

<style>
  .virtual-preview {
    height: 100%;
    overflow: auto;
    padding: 16px 24px;
    line-height: 1.7;
    /* 优化滚动性能：独立合成层 */
    will-change: transform;
    contain: strict;
  }
  /* 低端模式关掉常驻合成层，省集显 VRAM（P1-7） */
  .virtual-preview.no-will-change {
    will-change: auto;
  }
  .vblock {
    contain: layout style;
    box-sizing: border-box;
  }
  .vspacer {
    contain: strict;
  }
</style>
