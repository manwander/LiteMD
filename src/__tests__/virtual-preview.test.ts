// VirtualPreview 组件冒烟测试：验证预览内 http(s) 链接转交系统浏览器，
// 而不是让 WebView 自身导航（Tauri 下 target=_blank 会被拦截，点击无反应）。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, tick } from "svelte";
import MarkdownIt from "markdown-it";
import VirtualPreview from "../preview/VirtualPreview.svelte";
import { openExternal } from "../fs";

vi.mock("../fs", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../fs")>();
  return { ...orig, openExternal: vi.fn(async () => {}) };
});

async function settle() {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 20));
    await tick();
  }
}

describe("VirtualPreview 外链点击", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.mocked(openExternal).mockClear();
  });

  it("http(s) 链接阻止 WebView 内导航并交给系统浏览器；站内链接不拦截", async () => {
    const target = document.createElement("div");
    document.body.appendChild(target);
    mount(VirtualPreview, {
      target,
      props: {
        md: new MarkdownIt(),
        source: "[外部](https://example.com)\n\n[站内](local.md)",
      },
    });
    await settle();

    const links = [...target.querySelectorAll("a")];
    const ext = links.find((a) => a.getAttribute("href") === "https://example.com");
    const loc = links.find((a) => a.getAttribute("href") === "local.md");
    expect(ext).toBeTruthy();
    expect(loc).toBeTruthy();
    expect(ext!.getAttribute("target")).toBe("_blank");

    const extEvt = new MouseEvent("click", { bubbles: true, cancelable: true });
    ext!.dispatchEvent(extEvt);
    expect(extEvt.defaultPrevented).toBe(true);
    expect(openExternal).toHaveBeenCalledWith("https://example.com");

    // 站内链接：阻止 jsdom 的导航噪音，同时验证处理器不把它转交系统浏览器
    loc!.addEventListener("click", (e) => e.preventDefault());
    loc!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(openExternal).toHaveBeenCalledTimes(1);
  });
});
