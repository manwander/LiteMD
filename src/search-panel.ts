// 中文查找/替换面板：替代 @codemirror/search 默认英文面板。
// Ctrl+F 打开查找，Ctrl+H 打开替换；面板文本全部中文化。
// 查询状态存于 StateField，由面板 DOM 交互驱动。
// 注意：@codemirror/search 导出的 selectNextOccurrence/selectMatches/replaceNext/replaceAll
// 都是 searchCommand 包装的命令——依赖内部 searchState 的 query（忽略传入参数），
// searchState 不存在时还会自动打开官方英文面板；故跳转/全选/替换全部自研（基于 SearchQuery.getCursor 迭代）。
import { EditorView, Panel, showPanel, keymap } from "@codemirror/view";
import { EditorSelection, StateEffect, StateField } from "@codemirror/state";
import { SearchQuery } from "@codemirror/search";

// ---- 面板 / 查询状态 ----
const openPanelEffect = StateEffect.define<boolean>(); // true = 展开替换行
const closePanelEffect = StateEffect.define<null>();
const setQueryEffect = StateEffect.define<SearchQuery | null>();

/** 当前查询（面板输入框实时更新）；面板关闭时清空 */
const queryField = StateField.define<SearchQuery | null>({
  create: () => null,
  update: (q, tr) => {
    for (const e of tr.effects) {
      if (e.is(setQueryEffect)) q = e.value;
      else if (e.is(closePanelEffect)) q = null;
    }
    return q;
  },
});

/** 面板创建器（稳定函数引用）：showPanel.from 的 get 只收面板状态值，
 *  返回“接收 view 创建面板”的 spec，与官方 @codemirror/search 的 createPanel 模式一致；
 *  保持稳定引用，避免每次重算新闭包导致面板反复重建（输入框状态丢失） */
function createChinesePanel(view: EditorView): ChineseSearchPanel {
  const st = view.state.field(panelField);
  return new ChineseSearchPanel(st?.replace ?? false, view);
}

/** 面板是否打开及是否展开替换行 */
const panelField = StateField.define<{ replace: boolean } | null>({
  create: () => null,
  update: (s, tr) => {
    for (const e of tr.effects) {
      if (e.is(openPanelEffect)) s = { replace: e.value };
      else if (e.is(closePanelEffect)) s = null;
    }
    return s;
  },
  provide: (f) => showPanel.from(f, (s) => (s ? createChinesePanel : null)),
});

/** 打开面板：replace=true 时直接展开替换行；有选区时用选区文本初始化查找词 */
export const openSearchPanel = (replace: boolean) => (view: EditorView): boolean => {
  view.dispatch({ effects: openPanelEffect.of(replace) });
  const sel = view.state.selection.main;
  const q = view.state.field(queryField);
  if (!q && sel.from !== sel.to) {
    const text = view.state.sliceDoc(sel.from, sel.to);
    if (text.length <= 200) {
      view.dispatch({
        effects: setQueryEffect.of(
          new SearchQuery({ search: text, caseSensitive: false, regexp: false })
        ),
      });
    }
  }
  view.focus();
  return true;
};

/** 关闭面板（若开着） */
export const closeSearchPanel = (view: EditorView): boolean => {
  if (!view.state.field(panelField, false)) return false;
  view.dispatch({ effects: closePanelEffect.of(null) });
  view.focus();
  return true;
};

/** Mod-g / Mod-Shift-g：有查询时跳转下一个/上一个匹配 */
const findNextMatch = (view: EditorView, dir: 1 | -1): boolean => {
  const q = view.state.field(queryField);
  if (!q) return false;
  selectMatch(view, q, dir);
  return true;
};

// ---- 自研匹配工具（不依赖官方 searchState） ----

/** 替换文本转义（\n \r \t \\），与 SearchQuery.unquote 一致（类型定义未导出，自实现） */
function unquoteText(text: string): string {
  return text.replace(/\\([nrt\\])/g, (_, ch) =>
    ch === "n" ? "\n" : ch === "r" ? "\r" : ch === "t" ? "\t" : "\\"
  );
}

/** 迭代查询的所有匹配（最多 limit 个），按文档顺序返回 */
function matchesOf(view: EditorView, q: SearchQuery, limit = 1e9): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  // getCursor 的类型声明是标准 Iterator，但运行时是 SearchCursor（value/done 是属性）
  const cur = q.getCursor(view.state) as unknown as {
    next(): unknown;
    done: boolean;
    value: { from: number; to: number };
  };
  for (cur.next(); !cur.done; cur.next()) {
    out.push(cur.value);
    if (out.length >= limit) break;
  }
  return out;
}

/** 选中并滚动到匹配，焦点回到编辑器 */
function selectMatchAt(view: EditorView, m: { from: number; to: number }) {
  view.dispatch({
    selection: EditorSelection.single(m.from, m.to),
    effects: EditorView.scrollIntoView(m.to),
    userEvent: "select.search",
  });
  view.focus();
}

/** 按方向跳转匹配（dir=1 下一个，dir=-1 上一个），含文档回绕 */
function selectMatch(view: EditorView, q: SearchQuery, dir: 1 | -1): boolean {
  const all = matchesOf(view, q, 1000);
  if (!all.length) return false;
  const { from, to } = view.state.selection.main;
  const head = to;
  // 排除与当前选区完全重合的匹配，避免“上一个/下一个”选中自己
  const isCurrent = (m: { from: number; to: number }) => m.from === from && m.to === to;
  let idx = -1;
  if (dir > 0) {
    idx = all.findIndex((m) => m.to > head && !isCurrent(m));
    if (idx === -1) idx = 0; // 回绕到开头
  } else {
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i].to <= head && !isCurrent(all[i])) {
        idx = i;
        break;
      }
    }
    if (idx === -1) idx = all.length - 1; // 回绕到末尾
  }
  selectMatchAt(view, all[idx]);
  return true;
}

/** 全选所有匹配，返回匹配数 */
function selectAllMatches(view: EditorView, q: SearchQuery): number {
  const all = matchesOf(view, q, 1000);
  if (!all.length) return 0;
  view.dispatch({
    selection: EditorSelection.create(all.map((m) => EditorSelection.range(m.from, m.to))),
    userEvent: "select.search.matches",
  });
  view.focus();
  return all.length;
}

/** 替换：当前选区正好是匹配则替换并跳下一个；否则仅选中下一个匹配 */
function replaceCurrent(view: EditorView, q: SearchQuery): boolean {
  const { state } = view;
  if (state.readOnly) return false;
  const all = matchesOf(view, q, 1000);
  if (!all.length) return false;
  const { from, to } = state.selection.main;
  let idx = all.findIndex((m) => m.from === from && m.to === to);
  if (idx === -1) {
    // 未命中当前选区：仅跳转到下一个匹配（与官方 replaceNext 语义一致）
    idx = all.findIndex((m) => m.to > from);
    if (idx === -1) idx = 0;
    selectMatchAt(view, all[idx]);
    return true;
  }
  const insert = state.toText(unquoteText(q.replace));
  const changeSet = state.changes({ from, to, insert });
  const next = all[idx + 1] ?? all[0];
  const selection = EditorSelection.single(next.from, next.to).map(changeSet);
  view.dispatch({ changes: changeSet, selection, userEvent: "input.replace" });
  view.focus();
  return true;
}

/** 全部替换，返回替换数 */
function replaceAllMatches(view: EditorView, q: SearchQuery): number {
  const { state } = view;
  if (state.readOnly) return 0;
  const all = matchesOf(view, q, 1000);
  if (!all.length) return 0;
  const insert = unquoteText(q.replace);
  view.dispatch({
    changes: all.map((m) => ({ from: m.from, to: m.to, insert })),
    userEvent: "input.replace.all",
  });
  view.focus();
  return all.length;
}

/** 面板注册的编辑器键位（Mod-f/Mod-h 由用户快捷键表驱动，走 buildKeymap） */
export const searchPanelKeymap = () =>
  keymap.of([
    { key: "Mod-g", run: (v) => findNextMatch(v, 1) },
    { key: "Mod-Shift-g", run: (v) => findNextMatch(v, -1) },
    { key: "Escape", run: closeSearchPanel },
  ]);

// ---- 面板 UI ----
class ChineseSearchPanel implements Panel {
  dom: HTMLElement;
  top = true;

  private queryInput: HTMLInputElement;
  private replaceInput: HTMLInputElement;
  private caseCheck: HTMLLabelElement;
  private regexCheck: HTMLLabelElement;
  private countEl: HTMLSpanElement;
  private replaceRow: HTMLDivElement;
  private debounce = 0;

  constructor(
    private replace: boolean,
    private view: EditorView
  ) {
    const root = document.createElement("div");
    root.className = "cm-search-panel";

    // 查找行
    const row1 = document.createElement("div");
    row1.className = "cm-search-row";
    const qLabel = document.createElement("label");
    qLabel.className = "cm-search-label";
    qLabel.textContent = "查找";
    this.queryInput = document.createElement("input");
    this.queryInput.className = "cm-search-input";
    this.queryInput.placeholder = "输入查找内容…";
    this.queryInput.spellcheck = false;
    const q = this.view.state.field(queryField);
    if (q) this.queryInput.value = q.search;
    row1.appendChild(qLabel);
    row1.appendChild(this.queryInput);

    // 替换行
    this.replaceRow = document.createElement("div");
    this.replaceRow.className = "cm-search-row cm-replace-row";
    const rLabel = document.createElement("label");
    rLabel.className = "cm-search-label";
    rLabel.textContent = "替换";
    this.replaceInput = document.createElement("input");
    this.replaceInput.className = "cm-search-input";
    this.replaceInput.placeholder = "替换为…";
    this.replaceInput.spellcheck = false;
    this.replaceRow.appendChild(rLabel);
    this.replaceRow.appendChild(this.replaceInput);

    // 选项行
    const row2 = document.createElement("div");
    row2.className = "cm-search-opts";
    this.caseCheck = this.checkbox("区分大小写");
    this.regexCheck = this.checkbox("正则");
    this.countEl = document.createElement("span");
    this.countEl.className = "cm-search-count";
    row2.append(this.caseCheck, this.regexCheck, this.countEl);

    // 按钮行
    const row3 = document.createElement("div");
    row3.className = "cm-search-btns";
    const prev = this.button("↑ 上一个");
    const next = this.button("↓ 下一个");
    const all = this.button("全部");
    const replaceBtn = this.button("替换", "cm-search-btn-main");
    const replaceAllBtn = this.button("全部替换", "cm-search-btn-main");
    const toggleReplace = this.button(replace ? "收起替换" : "替换", "cm-search-btn-main");
    const closeBtn = this.button("✕");
    closeBtn.title = "关闭 (Esc)";
    row3.append(prev, next, all, replaceBtn, replaceAllBtn, toggleReplace, closeBtn);

    root.append(row1, this.replaceRow, row2, row3);

    // ---- 事件 ----
    this.queryInput.addEventListener("input", () => this.scheduleSearch());
    this.queryInput.addEventListener("keydown", (e) => this.onQueryKey(e));
    this.replaceInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        this.doReplace();
      }
    });
    this.caseCheck.addEventListener("change", () => this.scheduleSearch(0));
    this.regexCheck.addEventListener("change", () => this.scheduleSearch(0));
    prev.addEventListener("mousedown", (e) => { e.preventDefault(); this.find(-1); });
    next.addEventListener("mousedown", (e) => { e.preventDefault(); this.find(1); });
    all.addEventListener("mousedown", (e) => { e.preventDefault(); this.selectAll(); });
    replaceBtn.addEventListener("mousedown", (e) => { e.preventDefault(); this.doReplace(); });
    replaceAllBtn.addEventListener("mousedown", (e) => { e.preventDefault(); this.doReplaceAll(); });
    toggleReplace.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.replace = !this.replace;
      this.replaceRow.style.display = this.replace ? "flex" : "none";
      toggleReplace.textContent = this.replace ? "收起替换" : "替换";
      if (this.replace) this.replaceInput.focus();
    });
    closeBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      closeSearchPanel(this.view);
    });

    this.dom = root;
    if (!this.replace) this.replaceRow.style.display = "none";
    this.updateCount();
  }

    private checkbox(label: string): HTMLLabelElement {
    const l = document.createElement("label");
    l.className = "cm-search-check";
    const c = document.createElement("input");
    c.type = "checkbox";
    l.appendChild(c);
    l.appendChild(document.createTextNode(label));
    (l as unknown as { inp?: HTMLInputElement }).inp = c;
    return l;
  }

  private button(text: string, cls = ""): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    if (cls) b.className = cls;
    return b;
  }

    private get caseSensitive() {
    return (this.caseCheck.querySelector("input") as HTMLInputElement).checked;
  }
  private get regexp() {
    return (this.regexCheck.querySelector("input") as HTMLInputElement).checked;
  }

  /** 输入防抖后执行查找；delay=0 立即（选项变化时） */
  private scheduleSearch(delay = 220) {
    clearTimeout(this.debounce);
    this.debounce = window.setTimeout(() => this.doSearch(), delay);
  }

  private doSearch() {
    const text = this.queryInput.value;
    if (!text) {
      this.view.dispatch({ effects: setQueryEffect.of(null) });
      this.updateCount();
      return;
    }
    let q: SearchQuery;
    try {
      q = new SearchQuery({
        search: text,
        caseSensitive: this.caseSensitive,
        regexp: this.regexp,
      });
    } catch {
      this.countEl.textContent = "正则表达式无效";
      return;
    }
    this.view.dispatch({ effects: setQueryEffect.of(q) });
    this.updateCount();
  }

  private currentQuery(): SearchQuery | null {
    const q = this.view.state.field(queryField);
    if (!q || q.search !== this.queryInput.value) return null;
    return q;
  }

  private find(dir: 1 | -1) {
    const q = this.currentQuery();
    if (!q) {
      this.doSearch();
      return;
    }
    selectMatch(this.view, q, dir);
  }

  private selectAll() {
    const q = this.currentQuery();
    if (!q) return;
    const n = selectAllMatches(this.view, q);
    if (n === 0) this.countEl.textContent = "无匹配";
    else this.updateCount();
  }

  /** 替换时用输入框的替换文本构造新 query（replaceNext 依赖 query.replace） */
  private replaceQuery(): SearchQuery | null {
    const q = this.currentQuery();
    if (!q) return null;
    return new SearchQuery({
      search: q.search,
      replace: this.replaceInput.value,
      caseSensitive: q.caseSensitive,
      regexp: q.regexp,
    });
  }

  private doReplace() {
    const q = this.replaceQuery();
    if (!q) {
      this.doSearch();
      return;
    }
    replaceCurrent(this.view, q);
    this.updateCount();
  }

  private doReplaceAll() {
    const q = this.replaceQuery();
    if (!q) return;
    const n = replaceAllMatches(this.view, q);
    this.countEl.textContent = n === 0 ? "无匹配" : `已替换 ${n} 处`;
  }

  private updateCount() {
    const q = this.view.state.field(queryField);
    if (!q || !q.search) {
      this.countEl.textContent = "";
      return;
    }
    // SearchQuery 无 findAll，用 getCursor 迭代计数
    let n = 0;
    const cur = q.getCursor(this.view.state);
    for (; !cur.next().done; ) n++;
    this.countEl.textContent = n ? `共 ${n} 处` : "无匹配";
  }

  private onQueryKey(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      this.find(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeSearchPanel(this.view);
    }
  }

  update() {
    // 面板状态由 StateField 管理；查询变化时刷新计数
    if (!this.view.state.field(panelField, false)) return;
    if (this.view.state.field(queryField)?.search !== this.queryInput.value) {
      this.updateCount();
    }
  }

  destroy() {
    clearTimeout(this.debounce);
  }
}

/** 中文搜索面板扩展（加入 editor extensions：状态 + 键位） */
export const chineseSearchPanel = () => [queryField, panelField, searchPanelKeymap()];
