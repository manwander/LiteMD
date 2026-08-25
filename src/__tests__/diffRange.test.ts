/**
 * diffRange 单元测试（对应 M-02 增量同步的核心算法）
 *
 * 目标：验证「整篇重写」被压缩为「最小局部 replace」的正确性，
 * 覆盖前缀/后缀/中段/插入/删除/相等，以及 M-02 实际场景（大文档仅中部块被改）
 * 与代理对（emoji）边界不切断的健壮性。
 */
import { describe, it, expect } from "vitest";
import { diffRange } from "../editor";

/** 应用 diffRange 结果到一个文本，得到「新文本」 */
function applyTo(oldText: string, d: { from: number; to: number; insert: string }): string {
  return oldText.slice(0, d.from) + d.insert + oldText.slice(d.to);
}

describe("diffRange 基本性质", () => {
  it("两段文本完全相同时返回 null", () => {
    expect(diffRange("hello world", "hello world")).toBeNull();
  });

  it("空字符串之间也返回 null", () => {
    expect(diffRange("", "")).toBeNull();
  });
});

describe("diffRange 局部差异", () => {
  it("前缀被改：old=abc new=abx → 仅替换第 3 个字符", () => {
    const d = diffRange("abc", "abx")!;
    expect(d).toEqual({ from: 2, to: 3, insert: "x" });
    expect(applyTo("abc", d)).toBe("abx");
  });

  it("后缀被改：old=abc new=xbc → 仅替换第 1 个字符", () => {
    const d = diffRange("abc", "xbc")!;
    expect(d).toEqual({ from: 0, to: 1, insert: "x" });
    expect(applyTo("abc", d)).toBe("xbc");
  });

  it("中段被改：old=abcde new=abXde → 仅替换中间字符", () => {
    const d = diffRange("abcde", "abXde")!;
    expect(d).toEqual({ from: 2, to: 3, insert: "X" });
    expect(applyTo("abcde", d)).toBe("abXde");
  });

  it("尾部插入：old=ab new=abX → 在末尾插入", () => {
    const d = diffRange("ab", "abX")!;
    expect(d.from).toBe(2);
    expect(d.to).toBe(2);
    expect(d.insert).toBe("X");
    expect(applyTo("ab", d)).toBe("abX");
  });

  it("尾部删除：old=abX new=ab → 删除末尾字符", () => {
    const d = diffRange("abX", "ab")!;
    expect(d.from).toBe(2);
    expect(d.to).toBe(3);
    expect(d.insert).toBe("");
    expect(applyTo("abX", d)).toBe("ab");
  });
});

describe("diffRange 代理对（emoji）边界稳健性", () => {
  it("改动落在 emoji 之后（非代理对内部）时，不产生半个字符替换", () => {
    const oldT = "a😀b";
    const newT = "a😀c";
    const d = diffRange(oldT, newT)!;
    // 公共前缀 "a😀" 为 3 个 UTF-16 单元，边界停在 emoji 之后（from=3），
    // 绝不落在 [1,2]（emoji 的代理对内部）。
    expect(d.from).toBe(3);
    expect(d.from).not.toBe(1);
    expect(d.from).not.toBe(2);
    const result = applyTo(oldT, d);
    expect(result).toBe("a😀c");
    expect([...result]).toContain("😀"); // emoji 保持完整
  });

  it("改动落在 emoji 中段（仅低代理不同）时，边界回退到 emoji 之前", () => {
    const oldT = "a😀b";
    const newT = "a😁b";
    const d = diffRange(oldT, newT)!;
    // 若不在高代理处回退，from 会停在 2（低代理），从而切开代理对；
    // 正确实现应回退到 from=1（emoji 之前）。
    expect(d.from).toBe(1);
    expect(d.to).toBe(3);
    expect(d.insert).toBe("😁");
    const result = applyTo(oldT, d);
    expect(result).toBe("a😁b");
    expect([...result].length).toBe(3); // a / 😁 / b —— emoji 仍为 1 个码点
  });

  it("emoji 夹在中文前后，中段改动不污染前后文", () => {
    const oldT = "前缀😀后缀";
    const newT = "前缀😁后缀";
    const d = diffRange(oldT, newT)!;
    const result = applyTo(oldT, d);
    expect(result).toBe("前缀😁后缀");
    expect([...result].length).toBe(5); // 前 缀 😁 后 缀
  });
});

describe("diffRange 对应 M-02 场景：大文档仅中部块被改", () => {
  it("1000 行文档仅中部一行被编辑，diffRange 收敛到极小区间", () => {
    const head = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n") + "\n";
    const tail = Array.from({ length: 400 }, (_, i) => `line ${i + 600}`).join("\n") + "\n";
    const blockOld = "## 待编辑区块\n旧内容\n";
    const blockNew = "## 待编辑区块\n新内容\n";
    const oldDoc = head + blockOld + tail;
    const newDoc = head + blockNew + tail;

    const d = diffRange(oldDoc, newDoc)!;
    const result = applyTo(oldDoc, d);
    expect(result).toBe(newDoc);

    // 变化区间应远小于全文长度（收敛到「旧」→「新」这一处最小差异，而非整篇）
    const changed = oldDoc.slice(d.from, d.to);
    expect(changed).toContain("旧");
    expect(d.insert).toContain("新");
    // 头部与尾部的绝大部分都不在差异区间内（验证「不整篇重写」）
    expect(d.from).toBeGreaterThan(head.length);
    expect(d.to).toBeLessThan(head.length + blockOld.length);
  });
});
