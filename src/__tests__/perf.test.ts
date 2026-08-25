// 性能回归：验证修复引入的热路径开销在可接受预算内。
// - sanitizeHtml 在每个 VirtualPreview 区块渲染时被调用（C-01 收口点）
// - diffRange 在 flushPreviewEdit 增量回写时被调用（M-02 替代整篇 setDoc）
import { describe, it, expect } from "vitest";
import { sanitizeHtml } from "../sanitize";
import { diffRange } from "../editor";

// 模拟一个典型 markdown 区块的渲染产物（含标题/段落/列表/代码/链接/图片/引用/表格）
const BLOCK_HTML = `
<h2>二级标题 <em>强调</em></h2>
<p>这是一段包含<a href="https://example.com" target="_blank" rel="noopener">外链</a>
与本地相对链接 <a href="notes/local.md">local</a> 的正文，外加一张图：</p>
<img src="asset://localhost/C:/x/a.png" alt="图">
<ul><li>项一</li><li>项二</li></ul>
<blockquote><p>引用内容</p></blockquote>
<pre><code class="language-js">const a = 1;</code></pre>
<table><tr><td>单元格</td></tr></table>
<script>alert('xss')</script>
<img src="x" onerror="alert(1)">
`;

const N_BLOCK = 2000;

function time(fn: () => void): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

describe("性能回归：sanitizeHtml 区块清洗", () => {
  it(`单次清洗应在预算内 (<=8ms/块，无 DOM 异常)`, () => {
    // 预热（JIT + DOMPurify 初始化）
    for (let i = 0; i < 50; i++) sanitizeHtml(BLOCK_HTML);
    const total = time(() => {
      for (let i = 0; i < N_BLOCK; i++) sanitizeHtml(BLOCK_HTML);
    });
    const per = total / N_BLOCK;
    // 2000 次清洗应满足平均单次 < 8ms（DOMPurify 典型亚毫秒级，留足余量）
    expect(per).toBeLessThan(8);
    console.log(`[perf] sanitizeHtml 平均 ${per.toFixed(4)} ms/块 (${N_BLOCK} 次)`);
  });

  it("清洗后仍彻底剔除 script 与 on* 事件属性", () => {
    const out = sanitizeHtml(BLOCK_HTML);
    expect(out).not.toContain("<script");
    expect(out).not.toContain("onerror");
    expect(out).toContain('target="_blank"'); // 外链保留
  });
});

// 构造大文档用于 diffRange 基准
function bigDoc(lines: number): string {
  const arr: string[] = [];
  for (let i = 0; i < lines; i++) {
    arr.push(`# 章节 ${i}\n这是第 ${i} 段的示例正文，包含一些常见中文字符与标点，用于模拟真实笔记内容。\n`);
  }
  return arr.join("\n");
}

describe("性能回归：diffRange 增量计算", () => {
  it("大文档单点改动应在预算内 (<=6ms)", () => {
    const oldDoc = bigDoc(800); // ~40KB
    const lines = oldDoc.split("\n");
    const targetLine = 400;
    lines[targetLine] = lines[targetLine].replace("示例正文", "已修改正文");
    const newDoc = lines.join("\n");

    for (let i = 0; i < 10; i++) diffRange(oldDoc, newDoc); // 预热
    const total = time(() => {
      for (let i = 0; i < 500; i++) diffRange(oldDoc, newDoc);
    });
    const per = total / 500;
    expect(per).toBeLessThan(6);
    const d = diffRange(oldDoc, newDoc)!;
    // 差异区间必须极小（仅覆盖改动行附近，而非整篇）
    const changedLen = d.to - d.from + d.insert.length;
    expect(changedLen).toBeLessThan(oldDoc.length / 50);
    console.log(`[perf] diffRange 平均 ${per.toFixed(4)} ms/次；差异区间 ${changedLen} 字节 / 全文 ${oldDoc.length} 字节`);
  });
});
