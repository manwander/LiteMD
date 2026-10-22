import { describe, it, expect, beforeEach } from "vitest";
import { rebuildFenceIndex, isInsideCodeBlock, parseFenceLine, findFenceCloseLine, type FenceDoc } from "../fence-index";

/** 把整篇文本包成最小 FenceDoc（行 1 起始、from/to 为字符偏移，含换行归属上一行）。 */
function docOf(text: string): FenceDoc {
  const lines: { from: number; to: number }[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      lines.push({ from: start, to: i });
      start = i + 1;
    }
  }
  lines.push({ from: start, to: text.length });
  return {
    get lines() { return lines.length; },
    line(n) { return lines[n - 1]; },
    sliceString(from, to) { return text.slice(from, to); },
  };
}

describe("fence-index · CommonMark 长度感知状态机", () => {
  beforeEach(() => {
    // 干净索引用例：显式重建
  });

  it("``` 简单块：内容行判块内，块前/块后判块外", () => {
    const d = docOf("a\n```\nc\n```\nb"); // 行: 1 a / 2 ``` / 3 c / 4 ``` / 5 b
    rebuildFenceIndex(d);
    expect(isInsideCodeBlock(d, 1)).toBe(false); // 块前
    expect(isInsideCodeBlock(d, 2)).toBe(false); // 开栏行本身
    expect(isInsideCodeBlock(d, 3)).toBe(true); // 内容
    expect(isInsideCodeBlock(d, 4)).toBe(true); // 闭栏行：进入时仍在块内
    expect(isInsideCodeBlock(d, 5)).toBe(false); // 块后
  });

  it("块内含 ``` 示例（奇偶法会翻错）不再破坏判定", () => {
    // 外层用 4 反引号包裹一个内含 3 反引号的示例
    const d = docOf("````\n```\nexample\n```\n````\ntail");
    rebuildFenceIndex(d);
    // 行2-4 都在外层 ```` 块内
    expect(isInsideCodeBlock(d, 2)).toBe(true);
    expect(isInsideCodeBlock(d, 3)).toBe(true);
    expect(isInsideCodeBlock(d, 4)).toBe(true);
    expect(isInsideCodeBlock(d, 6)).toBe(false); // tail 在块后
  });

  it("识别 ~~~ 围栏（旧奇偶法只认反引号）", () => {
    const d = docOf("~~~\ncode\n~~~\nafter");
    rebuildFenceIndex(d);
    expect(isInsideCodeBlock(d, 2)).toBe(true);
    expect(isInsideCodeBlock(d, 4)).toBe(false);
  });

  it("缩进 ≥4 空格或制表符的行不视为围栏（属缩进代码内容）", () => {
    expect(parseFenceLine(docOf("    ```"), 1)).toBeNull();
    expect(parseFenceLine(docOf("\t```"), 1)).toBeNull();
    expect(parseFenceLine(docOf("   ```"), 1)).not.toBeNull(); // 3 空格仍合法
  });

  it("闭栏长度须 ≥ 开栏：短于开栏的标记不算闭栏", () => {
    const d = docOf("````\nx\n```\ny\n````\nend");
    rebuildFenceIndex(d);
    expect(isInsideCodeBlock(d, 4)).toBe(true); // ``` 短于 ```` → 仍是块内内容
    expect(isInsideCodeBlock(d, 6)).toBe(false); // ```` 才闭合
  });

  it("findFenceCloseLine 定位真正的闭合行（跳过块内示例）", () => {
    const d = docOf("````\n```\nex\n```\n````\nafter");
    rebuildFenceIndex(d);
    expect(findFenceCloseLine(d, 2)).toBe(5); // 闭合在第 5 行，而非块内第 4 行的 ```
  });
});
