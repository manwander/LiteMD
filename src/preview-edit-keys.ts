// 预览编辑模式键盘增强：把 contenteditable 的快捷键 / 智能 Enter / 缩进等
// 与源码编辑器模式（CodeMirror keymap + smartEnter）对齐。
// 所有格式操作作用于渲染后的 DOM；App 的防抖 flush 会用 turndown
// 把 HTML 转回 markdown 写回 CodeMirror，从而与源码编辑闭环同步。
import { matchAccel, DEFAULT_SHORTCUTS } from "./settings";

export interface PreviewEditKeyOpts {
  /** 用户当前键位设置（与编辑器模式共用 settings.shortcuts） */
  shortcuts: Record<string, string>;
  /** 内容变化（触发 App 的防抖回写） */
  onInput: () => void;
  /** 查找/替换：预览编辑下查找是 markdown 级能力，由 App 回写并切回编辑器打开中文面板 */
  onFind: (replace: boolean) => void;
  /** 选择图片并收编：返回 { url: 显示用 asset URL, ref: markdown 引用 }；取消/失败返回 null */
  onPickImage: () => Promise<{ url: string; ref: string } | null>;
  /** 收编图片文件（粘贴/拖拽）：同上 */
  onImportImageFile: (file: File) => Promise<{ url: string; ref: string } | null>;
  setStatus: (s: string) => void;
}

// 视为块级的标签（用于定位「当前块」）
const BLOCK_TAGS = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "blockquote",
  "li", "ul", "ol", "table", "thead", "tbody", "tr", "div", "figure",
]);

function getSelNode(): Node | null {
  return window.getSelection()?.anchorNode ?? null;
}

const byTag = (tag: string) => (el: Element) => el.tagName === tag;

function selInside(root: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  return root.contains(sel.anchorNode);
}

/** 从 node 向上查找（不含 root）第一个满足条件的元素 */
function closestUp(node: Node | null, root: HTMLElement, pred: (el: Element) => boolean): Element | null {
  let n: Node | null = node;
  while (n && n !== root) {
    if (n.nodeType === 1 && pred(n as Element)) return n as Element;
    n = n.parentNode;
  }
  return null;
}

function closestBlock(node: Node | null, root: HTMLElement): Element | null {
  return closestUp(node, root, (el) => BLOCK_TAGS.has(el.tagName.toLowerCase()));
}

/** 光标放到节点起始/末尾 */
function placeCaret(node: Node, atStart = true) {
  const sel = window.getSelection();
  if (!sel) return;
  const r = document.createRange();
  r.selectNodeContents(node);
  r.collapse(atStart);
  sel.removeAllRanges();
  sel.addRange(r);
}

 /**
 * 让 root 容器跟随当前光标自动滚动。
 *
 * 用法：调用后应保证光标在视口内，且顶部、底部各留 ~2 行高的空白，防止被状态栏/滚动条遮住。
 *
 * 为什么不用原生 Element.scrollIntoView：它只滚到"刚好可见"忽略边距，导致表格/图片底部紧贴状态栏。
 * 本实现手算 scrollTop 并 clamp 到 [0, maxScrollTop]，避免了以前算法中 Math.max(0, 负值) 锚到 0 引起的"视口跳到顶部" bug。
 */
export function scrollCaretIntoView(root: HTMLElement): void {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  const r = sel.getRangeAt(0);
  // 仅在 selection 在 root 内时才执行滚动，防止 selection 跳出 contenteditable 后错误滚到 root 顶部
  if (!root.contains(r.startContainer)) return;
  try {
    let rect: DOMRect | null = r.getClientRects().length
      ? r.getClientRects()[0]
      : null;
    if (!rect) {
      // collapsed 光标在空元素/单元格末尾时 getClientRects() 常为空，
      // 用「root 开头 → 光标」的 range 取其最后一个 rect（即光标所在行）。
      // 之前误取 [0]（文档顶部），导致插入表格/图片后 target 算成顶部 → 跳顶。
      const tmp = document.createRange();
      tmp.selectNodeContents(root);
      tmp.setEnd(r.endContainer, r.endOffset);
      const tmpRects = tmp.getClientRects();
      if (tmpRects.length) rect = tmpRects[tmpRects.length - 1];
    }
    if (!rect) return;
    const rootRect = root.getBoundingClientRect();
    // 底部留 1 行空白：光标保持在「倒数第二行」，最后一行留白。
    // 顶部不留白（光标在视口顶部时紧贴）。lineHeight 兜底 24px。
    const lineHeight = parseFloat(getComputedStyle(root).lineHeight) || 24;
    const margin = lineHeight;
    const top = rect.top - rootRect.top + root.scrollTop;
    const bottom = rect.bottom - rootRect.top + root.scrollTop;
    const viewportTop = root.scrollTop;
    const viewportBottom = viewportTop + root.clientHeight;
    // 光标已在视口内且下方有 ≥1 行留白：不滚动
    if (bottom <= viewportBottom - margin && top >= viewportTop) return;
    let target: number;
    if (bottom > viewportBottom - margin) {
      target = bottom + margin - root.clientHeight;
    } else {
      target = top;
    }
    const maxScroll = Math.max(0, root.scrollHeight - root.clientHeight);
    target = Math.max(0, Math.min(target, maxScroll));
    // clamp 到合法区间后赋值；只有变化量 > 1px 才真正设置（避免反复触发 reflow）
    if (Math.abs(target - root.scrollTop) > 1) {
      root.scrollTop = target;
    }
  } catch {
    /* 失败时静默：不滚动总比错误滚动好 */
  }
}

function emptyP(): HTMLParagraphElement {
  const p = document.createElement("p");
  p.appendChild(document.createElement("br"));
  return p;
}

function insertNodeAtCaret(n: Node) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  const r = sel.getRangeAt(0);
  r.deleteContents();
  r.insertNode(n);
  r.setStartAfter(n);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
}

/** 光标是否位于 el 内最后一个文本节点末尾（用于「块末尾回车」判定） */
function caretAtEndOf(el: Element): boolean {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return false;
  const r = sel.getRangeAt(0);
  const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let last: Text | null = null;
  let n: Node | null;
  while ((n = tw.nextNode())) last = n as Text;
  if (!last) return true; // 空块视为末尾
  return r.endContainer === last && r.endOffset === last.length;
}

/** 收编完成后把图片插入 root 内当前光标：src 用显示 URL，data-md-src 保留 markdown 引用供 turndown 还原；
 * 导出供 App 工具栏「插入图片」在预览编辑模式下复用（不退出模式）。 */
export async function insertImageAtCaret(
  root: HTMLElement,
  get: () => Promise<{ url: string; ref: string } | null>,
  onInput: () => void
) {
  const r = await get();
  if (!r) return;
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !root.contains(sel.anchorNode)) {
    placeCaret(root, false); // 光标不在可编辑区内：插到末尾
  }
  const img = document.createElement("img");
  img.src = r.url;
  img.setAttribute("data-md-src", r.ref);
  const alt = r.ref.split("/").pop() || "";
  img.setAttribute("alt", alt);
  img.style.maxWidth = "100%";
  insertNodeAtCaret(img);
  // 图片高度大时常超出视口：插入后自动跟随到图片处，避免用户切回顶部看不到
  // 图片尺寸在加载完成后才确定,因此立即滚一次 + 图片 onload 后再滚一次
  scrollCaretIntoView(root);
  if (img.complete) scrollCaretIntoView(root);
  else img.addEventListener("load", () => scrollCaretIntoView(root), { once: true });
  onInput();
}

/** 预览编辑内插入表格模板（3 列表头 + 1 数据行）：在光标所在块后插入表格并紧跟一个空段落，
 * 光标落在第一个数据单元格「内容」之后（与编辑器 insertTable 一致，可直接输入）；
 * 导出供 App 工具栏「插入表格」在预览编辑模式下复用（不退出模式，对齐快捷键 Alt+E 行为）。 */
export function insertTableAtCaret(root: HTMLElement, onInput?: () => void): void {
  // 光标不在可编辑区内时先落位到 root 末尾（与 insertImageAtCaret 一致），
  // 避免 closestBlock 向上走出 root，把表格插进外层 DOM（如隐藏的 CodeMirror 容器）
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !root.contains(sel.anchorNode)) {
    placeCaret(root, false);
  }
  const node = getSelNode();
  const table = document.createElement("table");
  table.innerHTML =
    "<thead><tr><th>列1</th><th>列2</th><th>列3</th></tr></thead>" +
    "<tbody><tr><td>内容</td><td>内容</td><td>内容</td></tr></tbody>";
  const p = emptyP();
  const block = closestBlock(node, root);
  const inTable = !!closestUp(node, root, byTag("TABLE"));
  const inList = !!closestUp(node, root, byTag("LI"));
  // 定位插入锚点：普通块→其后；表格内→当前表格之后（避免 table 嵌套进 tbody）；
  // 列表内→列表之后（避免 table 嵌套进 ul/ol）；兜底→root 末尾
  let anchor: Element = root;
  if (inTable) anchor = closestUp(node, root, byTag("TABLE")) || root;
  else if (inList) anchor = closestUp(node, root, byTag("UL")) || closestUp(node, root, byTag("OL")) || root;
  else if (block && block !== root) anchor = block;
  if (anchor === root) root.appendChild(table);
  else anchor.insertAdjacentElement("afterend", table);
  table.insertAdjacentElement("afterend", p);
  // 光标进第一个数据单元格「内容」之后（表格内，可直接输入）
  const cell = table.querySelector("tbody td");
  if (cell) placeCaret(cell, false);
  // 插入内容可能超出当前视口：把光标滚入视口底部，避免「插入后看到一片空白」。
  // 用 rAF 延迟一帧,确保 DOM 已 layout,getClientRects() 返回真实坐标
  requestAnimationFrame(() => scrollCaretIntoView(root));
  onInput?.();
}

/** 给 previewEditEl 挂 keydown / paste 监听，返回卸载函数 */
export function attachPreviewEditKeys(root: HTMLElement, opts: PreviewEditKeyOpts): () => void {

  // 本地 notify：触发回写 + 自动把光标滚入视口（contenteditable 不会自动跟随，
  // 插入表格/代码块/图片后用户常看到一片空白——这是"优化最后一行显示"的核心修复）。
  // 外部 opts.onInput 仍按原样被调用，状态/防抖/持久化逻辑不变。
  const notify = () => {
    opts.onInput();
    scrollCaretIntoView(root);
  };

  // ---- Enter：代码块/表格/引用跳出；空列表项退出；列表/标题末尾自动续行；Shift+Enter 软换行 ----
  function exitBlockAfter(block: Element) {
    const p = emptyP();
    block.insertAdjacentElement("afterend", p);
    placeCaret(p);
    notify();
  }

  // 引用内 Enter（对齐编辑器 r04 行为）：光标处把引用「截断」，
  // 光标之后（文档流顺序）的内容移出引用成为新段落（跳出引用直接写正文）
  function exitQuote(bq: Element) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    // 按文档流找引用内最后一个文本/元素节点（而非 DOM 树序的末尾，
    // 避免 setEndAfter 位置在文档流中早于光标导致提取落空）
    const walker = document.createTreeWalker(bq, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let last: Node | null = null;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType === 3) { last = n; continue; }
      if (n.nodeName === "BR") last = n;
    }
    const r = sel.getRangeAt(0).cloneRange();
    r.collapse(false);
    if (last) {
      if (last.nodeType === 3) r.setEnd(last, last.textContent?.length ?? 0);
      else r.setEndAfter(last);
    } else {
      r.setEnd(bq, bq.childNodes.length);
    }
    const frag = r.extractContents();
    const p = document.createElement("p");
    if (frag.textContent && frag.textContent.trim()) p.appendChild(frag);
    else p.appendChild(document.createElement("br"));
    bq.insertAdjacentElement("afterend", p);
    // 引用被抽空则移除残留空引用
    if (!bq.textContent || !bq.textContent.trim()) bq.remove();
    placeCaret(p);
    notify();
  }

  function isEmptyLi(li: Element): boolean {
    // 有实质内容（文字/图片/表格/代码等）则非空
    if (li.textContent?.trim()) return false;
    if (li.querySelector("img, input, table, svg")) return false;
    // Chrome 空 li 结构：<li><br></li> / <li><div><br></div></li> / <li><p><br></p></li>
    return ![...li.querySelectorAll("*")].some((el) => !/^(BR|DIV|P)$/.test(el.tagName));
  }

  // ---- Tab / Shift+Tab：列表嵌套/提升（不用 execCommand('indent')——
  //      Chrome 对 li 内段落会生成内联样式 blockquote，turndown 回写语义错误）----
  function indentLi(li: HTMLElement) {
    let prev = li.previousElementSibling as HTMLElement | null;
    while (prev && prev.tagName !== "LI") prev = prev.previousElementSibling as HTMLElement | null;
    if (!prev) return; // 首项无法缩进
    let sub = prev.querySelector(":scope > ul, :scope > ol") as HTMLElement | null;
    if (!sub) {
      sub = document.createElement(prev.parentElement?.tagName === "OL" ? "ol" : "ul");
      prev.appendChild(sub);
    }
    sub.appendChild(li);
    placeCaret(li, true);
    notify();
  }

  function outdentLi(li: HTMLElement) {
    const subList = li.parentElement; // 嵌套的 ul/ol
    if (!subList || subList === root) return;
    const parentLi = subList.parentElement;
    if (!parentLi || parentLi.tagName !== "LI") return; // 已是顶层列表
    const outerList = parentLi.parentElement;
    if (!outerList) return;
    // 把 li 及其后续兄弟（同层后续项保持层级）提到父项之后
    const moving: Element[] = [];
    for (let n: Element | null = li; n; n = n.nextElementSibling) moving.push(n);
    for (const m of moving) outerList.insertBefore(m, parentLi.nextElementSibling);
    if (subList.children.length === 0) subList.remove();
    placeCaret(li, true);
    notify();
  }

  // 空列表项 Enter（对齐编辑器「空项回车移除标记」）：删除空项并跳出列表
  function exitEmptyLi(li: Element) {
    const list = li.parentElement;
    li.remove();
    if (!list) return;
    if (list.children.length === 0) {
      const parentLi = list.parentElement?.closest("li") ?? null;
      const refParent = list.parentElement;
      const refNext = list.nextSibling;
      list.remove();
      if (parentLi) { placeCaret(parentLi, false); notify(); return; } // 嵌套子列表清空：回到父项末尾
      const p = emptyP();
      if (refParent) refParent.insertBefore(p, refNext);
      placeCaret(p);
    } else {
      const p = emptyP();
      list.insertAdjacentElement("afterend", p);
      placeCaret(p);
    }
    notify();
  }

  // ---- Alt+W：当前块转代码块（pre>code，保证 turndown 围栏式往返）----
  function toPre() {
    const node = getSelNode();
    if (closestUp(node, root, byTag("PRE"))) return; // 已在代码块内
    const block = closestBlock(node, root);
    const wrap = (target: Element, keepBlock: boolean) => {
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      while (target.firstChild) code.appendChild(target.firstChild);
      if (!code.childNodes.length) code.appendChild(document.createTextNode(""));
      pre.appendChild(code);
      if (keepBlock) target.appendChild(pre); // 列表项内：保留 li 结构
      else target.replaceWith(pre);
      placeCaret(code, false);
      notify();
    };
    if (block && block !== root) {
      wrap(block, block.tagName === "LI");
      return;
    }
    // 兜底：formatBlock 后再补 code 包裹
    document.execCommand("formatBlock", false, "<pre>");
    const pre = closestUp(getSelNode(), root, byTag("PRE"));
    if (pre && !pre.querySelector("code")) {
      const code = document.createElement("code");
      while (pre.firstChild) code.appendChild(pre.firstChild);
      pre.appendChild(code);
      placeCaret(code, false);
    }
    notify();
  }

  // ---- Alt+1~5 / Alt+.（引用，即 > 键位）：块级标签切换（已是该标签则还原为段落）----
  // 还原不用 formatBlock（对 blockquote>pre 等嵌套结构无效）：手动把子块内容提升为段落
  function unwrapToParagraph(bq: Element) {
    const frag = document.createDocumentFragment();
    for (const child of Array.from(bq.children)) {
      const p = document.createElement("p");
      while (child.firstChild) p.appendChild(child.firstChild);
      frag.appendChild(p);
    }
    if (!bq.textContent?.trim()) frag.appendChild(emptyP());
    bq.replaceWith(frag);
  }

  /** 在当前块后自动插入「新的一行」并让光标跳过去（对齐源码编辑器 setOrderedList 行为：
   * 设置列表/标题后自动续行，用户无需再按 Enter 直接输入下一项/下一段）。
   * 标题→新空段落；列表项→新空 li。返回是否已插入。 */
  function appendContinuationLine(block: Element): boolean {
    if (block.tagName === "LI") {
      const next = document.createElement("li");
      next.appendChild(document.createElement("br"));
      block.insertAdjacentElement("afterend", next);
      placeCaret(next);
      return true;
    }
    if (/^H[1-6]$/.test(block.tagName)) {
      const next = emptyP();
      block.insertAdjacentElement("afterend", next);
      placeCaret(next);
      return true;
    }
    return false;
  }

  /** 列表命令（insertUnorderedList / insertOrderedList）的统一封装：
   * 仅当「从非列表块新建列表项」时自动追加新空 li 并跳光标到下一项；
   * 若原本已在列表内（toggle 退出/切序号），保持 execCommand 原生行为不续行。 */
  function insertListAndContinue(cmd: string) {
    const wasInList = !!closestUp(getSelNode(), root, byTag("LI"));
    document.execCommand(cmd);
    if (!wasInList) {
      const li = closestUp(getSelNode(), root, byTag("LI"));
      if (li) appendContinuationLine(li);
    }
    notify();
  }

  function toggleBlock(tag: string) {
    const node = getSelNode();
    // 引用还原：光标在 blockquote 内（含嵌套块）优先命中引用
    if (tag === "blockquote") {
      const bq = closestUp(node, root, byTag("BLOCKQUOTE"));
      if (bq) { unwrapToParagraph(bq); notify(); return; }
    }
    const block = closestBlock(node, root);
    const already = block && block.tagName.toLowerCase() === tag;
    if (already) {
      document.execCommand("formatBlock", false, "<p>");
    } else {
      document.execCommand("formatBlock", false, `<${tag}>`);
      // 从普通块转标题：自动在标题后插入新段落，光标跳到下一行（q15 根因：execCommand 已被
      // 弃用，Chrome/WebView2 在空块 / 跨块选区 / 列表项内部等场景偶尔不产生新 h1，或把光标移到新
      // 块外，导致 closestUp 找不到标题、appendContinuationLine 不触发。兜底：找不到新标题时手动包装原块内容，
      // 并把光标放回标题末尾再续行，用户无需再按 Enter）
      let h: Element | null = /^H[1-6]$/.test(tag)
        ? closestUp(getSelNode(), root, (el) => /^H[1-6]$/.test(el.tagName))
        : null;
      if (/^H[1-6]$/.test(tag) && !h && block && block.parentNode &&
          block.tagName.toLowerCase() !== tag) {
        h = document.createElement(tag);
        while (block.firstChild) h.appendChild(block.firstChild);
        if (!h.childNodes.length) h.appendChild(document.createTextNode(""));
        block.replaceWith(h);
        const sel = window.getSelection();
        if (sel) {
          const r = document.createRange();
          r.selectNodeContents(h);
          r.collapse(false);
          sel.removeAllRanges();
          sel.addRange(r);
        }
      }
      if (/^H[1-6]$/.test(tag) && h) appendContinuationLine(h);
    }
    notify();
  }

  // ---- Alt+E：插入表格模板（对齐编辑器 3 列表头 + 1 数据行）----
  function insertTableHtml() {
    insertTableAtCaret(root, opts.onInput);
  }

  // ---- Ctrl+K：链接（选中文字作为链接文字；无选区插入占位）----
  function insertLink() {
    const sel = window.getSelection();
    const hasSel = !!sel && !sel.isCollapsed && selInside(root);
    const url = window.prompt("链接地址（URL）：", "https://");
    if (!url) return;
    if (hasSel) {
      document.execCommand("createLink", false, url);
    } else {
      const a = document.createElement("a");
      a.href = url;
      a.textContent = "链接文字";
      insertNodeAtCaret(a);
      const r = document.createRange();
      r.selectNodeContents(a);
      sel!.removeAllRanges();
      sel!.addRange(r);
    }
    notify();
  }

  function onKeydown(e: KeyboardEvent) {
    // 选区不在可编辑区内（如焦点在别处）：不拦截，交还 window 层（Ctrl+S 等）
    if (!selInside(root)) return;

    const s = opts.shortcuts;
    const hit = (id: string) => matchAccel(e, s[id] ?? DEFAULT_SHORTCUTS[id]);

    // 查找 / 替换：回写 markdown 后切回编辑器打开中文查找替换面板
    if (hit("edit.find") || hit("edit.replace")) {
      e.preventDefault();
      e.stopPropagation();
      opts.onFind(hit("edit.replace"));
      return;
    }

    // Alt+Enter：复制表格行（对齐编辑器 table.duplicateRow）
    if (hit("table.duplicateRow")) {
      const tr = closestUp(getSelNode(), root, byTag("TR")) as HTMLElement | null;
      if (tr) {
        e.preventDefault();
        e.stopPropagation();
        const clone = tr.cloneNode(true) as HTMLElement;
        tr.insertAdjacentElement("afterend", clone);
        const cell = clone.querySelector("td, th");
        if (cell) placeCaret(cell);
        notify();
        opts.setStatus("已复制表格行");
      }
      return;
    }

    // Alt+\（表格添加列，对齐编辑器 table.addColumn）：光标列右侧为每行补一列
    if (hit("table.addColumn")) {
      const cell = (closestUp(getSelNode(), root, byTag("TD")) ||
        closestUp(getSelNode(), root, byTag("TH"))) as HTMLElement | null;
      if (cell) {
        e.preventDefault();
        e.stopPropagation();
        const tr = cell.parentElement as HTMLElement | null;
        if (tr) {
          const col = Array.prototype.indexOf.call(tr.children, cell);
          for (const row of Array.from(root.querySelectorAll("tr"))) {
            const src = row.children[col] as HTMLElement | undefined;
            const tag = row.closest("thead") ? "th" : "td";
            const el = document.createElement(tag);
            el.innerHTML = "<br>";
            if (src) src.insertAdjacentElement("afterend", el);
            else row.appendChild(el);
          }
          const next = tr.children[col + 1] as HTMLElement | undefined;
          if (next) placeCaret(next);
          notify();
          opts.setStatus("已添加列");
        }
      }
      return;
    }

    // Alt+Shift+1~9：有序列表（起始编号）
    if (e.altKey && e.shiftKey && !e.ctrlKey && /^Digit[1-9]$/.test(e.code)) {
      e.preventDefault();
      e.stopPropagation();
      // 对齐 insertListAndContinue：从非列表块新建有序列表项时自动追加新空 li 并跳光标
      const wasInList = !!closestUp(getSelNode(), root, byTag("LI"));
      document.execCommand("insertOrderedList");
      const start = parseInt(e.code.slice(5), 10);
      const ol = closestUp(getSelNode(), root, byTag("OL")) as HTMLOListElement | null;
      if (ol) {
        if (start !== 1) ol.setAttribute("start", String(start));
        else ol.removeAttribute("start");
      }
      if (!wasInList) {
        const li = closestUp(getSelNode(), root, byTag("LI"));
        if (li) appendContinuationLine(li);
      }
      notify();
      opts.setStatus(`有序列表（起始编号 ${start}）`);
      return;
    }

    // ---- Enter 系列 ----
    if (e.key === "Enter") {
      // Shift+Enter：软换行（同段内 <br>，代码块内加一行代码）
      if (e.shiftKey && !e.altKey && !e.ctrlKey) {
        e.preventDefault();
        e.stopPropagation();
        if (!document.execCommand("insertLineBreak")) {
          document.execCommand("insertHTML", false, "<br>");
        }
        notify();
        return;
      }
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const node = getSelNode();
      const pre = closestUp(node, root, byTag("PRE"));
      if (pre) { e.preventDefault(); e.stopPropagation(); exitBlockAfter(pre); return; }
      const table = closestUp(node, root, byTag("TABLE"));
      if (table) { e.preventDefault(); e.stopPropagation(); exitBlockAfter(table); return; }
      const bq = closestUp(node, root, byTag("BLOCKQUOTE"));
      if (bq) { e.preventDefault(); e.stopPropagation(); exitQuote(bq); return; }
      const li = closestUp(node, root, byTag("LI"));
      if (li && isEmptyLi(li)) { e.preventDefault(); e.stopPropagation(); exitEmptyLi(li); return; }
      // 列表项末尾回车：手动插入新列表项（不依赖浏览器原生，tight/loose 都覆盖）。
      // markdown-it 单行项为 <li>text</li>（无 p）、多行项为 <li><p>…</p></li>；
      // Chrome 对 tight li 的原生回车行为不稳定（受 defaultParagraphSeparator 与
      // execCommand 生成的 li 结构影响），统一手动处理保证「回车自动跳到下一行（新列表项）」
      if (li && caretAtEndOf(li)) {
        e.preventDefault();
        e.stopPropagation();
        const newLi = document.createElement("li");
        const loose = !!li.querySelector(":scope > p");
        newLi.appendChild(loose ? emptyP() : document.createElement("br"));
        li.insertAdjacentElement("afterend", newLi);
        placeCaret(newLi);
        notify();
        return;
      }
      // 标题：回车强制生成新段落（contenteditable 中 h1~h6 末尾原生行为偶发失效）
      const heading = closestUp(node, root, (el) => /^H[1-6]$/.test(el.tagName));
      if (heading) {
        e.preventDefault();
        e.stopPropagation();
        if (!document.execCommand("insertParagraph")) {
          const p = emptyP();
          heading.insertAdjacentElement("afterend", p);
          placeCaret(p);
        }
        notify();
        return;
      }
      return; // 普通段落：浏览器原生拆分（自动续行列表项由 contenteditable 完成）
    }

    // ---- Tab / Shift+Tab：列表缩进 / 反缩进 ----
    if (e.key === "Tab") {
      const li = closestUp(getSelNode(), root, byTag("LI")) as HTMLElement | null;
      if (li) {
        e.preventDefault();
        if (e.shiftKey) outdentLi(li);
        else indentLi(li);
      }
      return;
    }

    // ---- 格式快捷键（跟随用户自定义键位，与编辑器模式一致）----
    let act: (() => void) | null = null;
    let msg = "";
    let hitKey: string | null = null;
    const setAct = (k: string, fn: () => void, m: string): void => {
      hitKey = k;
      act = fn;
      msg = m;
    };
    // 用临时变量避免 TS 类型窄化（hitKey 在 if 链里被多次赋值会让 TS 把它推为 never）
    let blockCmdKey: string | null = null;
    const setBlockAct = (k: string, fn: () => void, m: string): void => {
      blockCmdKey = k;
      setAct(k, fn, m);
    };
    if (hit("format.bold")) setAct("format.bold", () => document.execCommand("bold"), "加粗");
    else if (hit("format.italic")) setAct("format.italic", () => document.execCommand("italic"), "斜体");
    else if (hit("format.underline")) setAct("format.underline", () => document.execCommand("underline"), "下划线");
    else if (hit("format.strike")) setAct("format.strike", () => document.execCommand("strikeThrough"), "删除线");
    else if (hit("format.h1")) setBlockAct("format.h1", () => toggleBlock("h1"), "一级标题");
    else if (hit("format.h2")) setBlockAct("format.h2", () => toggleBlock("h2"), "二级标题");
    else if (hit("format.h3")) setBlockAct("format.h3", () => toggleBlock("h3"), "三级标题");
    else if (hit("format.h4")) setBlockAct("format.h4", () => toggleBlock("h4"), "四级标题");
    else if (hit("format.h5")) setBlockAct("format.h5", () => toggleBlock("h5"), "五级标题");
    else if (hit("format.quote")) setBlockAct("format.quote", () => toggleBlock("blockquote"), "引用");
    else if (hit("insert.codeBlock")) setBlockAct("insert.codeBlock", toPre, "代码块");
    else if (hit("insert.table")) setAct("insert.table", insertTableHtml, "已插入表格");
    // 无序列表：走 insertListAndContinue——从非列表块新建列表项时自动追加新空 li 并跳光标
    else if (hit("insert.bullet")) setBlockAct("insert.bullet", () => insertListAndContinue("insertUnorderedList"), "无序号列表");
    else if (hit("format.link")) setAct("format.link", insertLink, "");
    else if (hit("insert.image")) {
      e.preventDefault();
      e.stopPropagation();
      // 在预览编辑内直接插入当前光标处（不退出模式）；收编与回写闭环见 insertImageAtCaret
      void insertImageAtCaret(root, opts.onPickImage, opts.onInput);
      return;
    }
    if (act) {
      e.preventDefault();
      e.stopPropagation();
      const fn: () => void = act;
      fn();
      // 标题/列表的「自动跳到新的一行」已封装在 toggleBlock / insertListAndContinue 内部
      // （q14 根因：仅 placeCaret 到块末尾不能满足需求，用户仍需按 Enter；现直接插入新块）。
      // 引用 / 代码块保持原生行为（无续行语义），bold 等 inline 命令不破坏光标。
      notify();
      if (msg) opts.setStatus(msg);
    }
  }

  // ---- 粘贴：图片走收编管线并插入当前光标（不退出预览编辑），普通文本/富文本浏览器默认 ----
  function onPaste(e: ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        e.stopPropagation();
        const f = item.getAsFile();
        if (f) void insertImageAtCaret(root, () => opts.onImportImageFile(f), opts.onInput);
        return;
      }
    }
  }

  // ---- 拖拽：图片文件收编并插入当前光标（不退出预览编辑）----
  function onDragOver(e: DragEvent) {
    e.preventDefault(); // 允许 drop（否则浏览器默认禁止）
  }
  function onDrop(e: DragEvent) {
    e.preventDefault();
    const files = e.dataTransfer?.files;
    if (!files) return;
    for (const f of Array.from(files)) {
      if (f.type.startsWith("image/")) {
        void insertImageAtCaret(root, () => opts.onImportImageFile(f), opts.onInput);
        return;
      }
    }
  }

  // 光标定位（点击 / 方向键等）后也把光标纠正到「倒数第二行」，
  // 避免光标先停在最后一行、输入时再跳到倒数第二行的「跳」感。
  // rAF 等一帧让浏览器更新 selection 后再测量。
  function onCursorMove() {
    requestAnimationFrame(() => scrollCaretIntoView(root));
  }
  root.addEventListener("click", onCursorMove);
  root.addEventListener("keyup", onCursorMove);
  root.addEventListener("keydown", onKeydown);
  root.addEventListener("paste", onPaste);
  root.addEventListener("dragover", onDragOver);
  root.addEventListener("drop", onDrop);
  return () => {
    root.removeEventListener("click", onCursorMove);
    root.removeEventListener("keyup", onCursorMove);
    root.removeEventListener("keydown", onKeydown);
    root.removeEventListener("paste", onPaste);
    root.removeEventListener("dragover", onDragOver);
    root.removeEventListener("drop", onDrop);
  };
}
