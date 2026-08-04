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
  /** 插入图片快捷键：切回编辑器走既有选择/收编管线 */
  onImage: () => void;
  /** 粘贴图片文件：切回编辑器走既有收编管线 */
  onImageFile: (file: File) => void;
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

/** 给 previewEditEl 挂 keydown / paste 监听，返回卸载函数 */
export function attachPreviewEditKeys(root: HTMLElement, opts: PreviewEditKeyOpts): () => void {
  const byTag = (tag: string) => (el: Element) => el.tagName === tag;

  // ---- Enter：代码块/表格/引用跳出；空列表项退出；Shift+Enter 软换行 ----
  function exitBlockAfter(block: Element) {
    const p = emptyP();
    block.insertAdjacentElement("afterend", p);
    placeCaret(p);
    opts.onInput();
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
    opts.onInput();
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
    opts.onInput();
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
    opts.onInput();
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
      if (parentLi) { placeCaret(parentLi, false); opts.onInput(); return; } // 嵌套子列表清空：回到父项末尾
      const p = emptyP();
      if (refParent) refParent.insertBefore(p, refNext);
      placeCaret(p);
    } else {
      const p = emptyP();
      list.insertAdjacentElement("afterend", p);
      placeCaret(p);
    }
    opts.onInput();
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
      opts.onInput();
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
    opts.onInput();
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

  function toggleBlock(tag: string) {
    const node = getSelNode();
    // 引用还原：光标在 blockquote 内（含嵌套块）优先命中引用
    if (tag === "blockquote") {
      const bq = closestUp(node, root, byTag("BLOCKQUOTE"));
      if (bq) { unwrapToParagraph(bq); opts.onInput(); return; }
    }
    const block = closestBlock(node, root);
    if (block && block.tagName.toLowerCase() === tag) {
      document.execCommand("formatBlock", false, "<p>");
    } else {
      document.execCommand("formatBlock", false, `<${tag}>`);
    }
    opts.onInput();
  }

  // ---- Alt+E：插入表格模板（对齐编辑器 3 列表头 + 1 数据行）----
  function insertTableHtml() {
    const node = getSelNode();
    const table = document.createElement("table");
    table.innerHTML =
      "<thead><tr><th>列1</th><th>列2</th><th>列3</th></tr></thead>" +
      "<tbody><tr><td>内容</td><td>内容</td><td>内容</td></tr></tbody>";
    const p = emptyP();
    const block = closestBlock(node, root);
    const inList = !!closestUp(node, root, byTag("LI"));
    if (block && block !== root && !inList) {
      block.insertAdjacentElement("afterend", table);
    } else {
      root.appendChild(table);
    }
    table.insertAdjacentElement("afterend", p);
    const cell = table.querySelector("td, th");
    if (cell) placeCaret(cell);
    opts.onInput();
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
    opts.onInput();
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
        opts.onInput();
        opts.setStatus("已复制表格行");
      }
      return;
    }

    // Alt+Shift+1~9：有序列表（起始编号）
    if (e.altKey && e.shiftKey && !e.ctrlKey && /^Digit[1-9]$/.test(e.code)) {
      e.preventDefault();
      e.stopPropagation();
      document.execCommand("insertOrderedList");
      const start = parseInt(e.code.slice(5), 10);
      const ol = closestUp(getSelNode(), root, byTag("OL")) as HTMLOListElement | null;
      if (ol) {
        if (start !== 1) ol.setAttribute("start", String(start));
        else ol.removeAttribute("start");
      }
      opts.onInput();
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
        opts.onInput();
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
    if (hit("format.bold")) { act = () => document.execCommand("bold"); msg = "加粗"; }
    else if (hit("format.italic")) { act = () => document.execCommand("italic"); msg = "斜体"; }
    else if (hit("format.underline")) { act = () => document.execCommand("underline"); msg = "下划线"; }
    else if (hit("format.strike")) { act = () => document.execCommand("strikeThrough"); msg = "删除线"; }
    else if (hit("format.h1")) { act = () => toggleBlock("h1"); msg = "一级标题"; }
    else if (hit("format.h2")) { act = () => toggleBlock("h2"); msg = "二级标题"; }
    else if (hit("format.h3")) { act = () => toggleBlock("h3"); msg = "三级标题"; }
    else if (hit("format.h4")) { act = () => toggleBlock("h4"); msg = "四级标题"; }
    else if (hit("format.h5")) { act = () => toggleBlock("h5"); msg = "五级标题"; }
    else if (hit("format.quote")) { act = () => toggleBlock("blockquote"); msg = "引用"; }
    else if (hit("insert.codeBlock")) { act = toPre; msg = "代码块"; }
    else if (hit("insert.table")) { act = insertTableHtml; msg = "已插入表格"; }
    else if (hit("insert.bullet")) { act = () => document.execCommand("insertUnorderedList"); msg = "无序号列表"; }
    else if (hit("format.link")) { act = insertLink; msg = ""; }
    else if (hit("insert.image")) {
      e.preventDefault();
      e.stopPropagation();
      opts.onImage();
      return;
    }
    if (act) {
      e.preventDefault();
      e.stopPropagation();
      act();
      // toggleBlock/toPre/insertTableHtml/insertLink 内部已触发 onInput，execCommand 类在此补触发
      opts.onInput();
      if (msg) opts.setStatus(msg);
    }
  }

  // ---- 粘贴：图片走既有收编管线（切回编辑器），普通文本/富文本浏览器默认 ----
  function onPaste(e: ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        const f = item.getAsFile();
        if (f) {
          e.preventDefault();
          e.stopPropagation();
          opts.onImageFile(f);
          return;
        }
      }
    }
  }

  root.addEventListener("keydown", onKeydown);
  root.addEventListener("paste", onPaste);
  return () => {
    root.removeEventListener("keydown", onKeydown);
    root.removeEventListener("paste", onPaste);
  };
}
