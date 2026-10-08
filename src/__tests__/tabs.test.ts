// 标签路径重命名去重（updateTabPath 崩溃修复 M-04）：
// 多次移动落到同一目标 + 覆盖时，不能产生两个同路径标签，否则标签栏 keyed-each 抛重复 key 卡死。
import { describe, it, expect } from "vitest";
import { renameTabPathDedup, computeActiveIdxAfterClose, type TabPathLike } from "../tabs";

function uniquePaths(tabs: TabPathLike[]): boolean {
  const s = new Set(tabs.map((t) => t.path));
  return s.size === tabs.length;
}

describe("renameTabPathDedup 去重", () => {
  it("单次改名不产生重复（目标未被占用）", () => {
    const tabs = [
      { path: "C:/1/2/12.md" },
      { path: "C:/1/2/3/12.md" },
    ];
    const { tabs: next } = renameTabPathDedup(tabs, "C:/1/2/12.md", "C:/1/2/3/4/12.md", 1);
    expect(next.map((t) => t.path)).toEqual(["C:/1/2/3/4/12.md", "C:/1/2/3/12.md"]);
    expect(uniquePaths(next)).toBe(true);
  });

  it("两次移动落到同一目标 + 覆盖：最终仅保留一个标签，无重复 key", () => {
    // 复现用户日志：1/2/12.md → 1/2/3/4/12.md，随后 1/2/3/12.md → 1/2/3/4/12.md
    let tabs: TabPathLike[] = [
      { path: "C:/1/2/12.md" },
      { path: "C:/1/2/3/12.md" },
    ];
    let active = 1;
    ({ tabs, activeIdx: active } = renameTabPathDedup(tabs, "C:/1/2/12.md", "C:/1/2/3/4/12.md", active));
    ({ tabs, activeIdx: active } = renameTabPathDedup(tabs, "C:/1/2/3/12.md", "C:/1/2/3/4/12.md", active));
    expect(uniquePaths(tabs)).toBe(true); // 不抛重复 key
    expect(tabs.length).toBe(1);
    expect(tabs[0].path).toBe("C:/1/2/3/4/12.md");
    expect(active).toBe(0);
  });

  it("被移除的重复标签恰为激活标签时，切换到被改名标签", () => {
    // 激活的是先落目标那个标签（被覆盖），改名后它应让位给后改名的标签
    const tabs = [
      { path: "C:/1/2/3/4/12.md" }, // idx0 先落目标，且是激活
      { path: "C:/1/2/3/12.md" }, // idx1 后移动过来
    ];
    const { tabs: next, activeIdx } = renameTabPathDedup(tabs, "C:/1/2/3/12.md", "C:/1/2/3/4/12.md", 0);
    expect(uniquePaths(next)).toBe(true);
    expect(next.length).toBe(1);
    expect(activeIdx).toBe(0); // 激活切到唯一剩下的（被改名的）标签
  });
});

describe("computeActiveIdxAfterClose（C-2：关闭非活动/活动标签的索引维护）", () => {
  const mk = (n: number): TabPathLike[] => Array.from({ length: n }, (_, i) => ({ path: `/${i}.md` }));

  it("关闭排在激活标签之前的干净标签 → 激活索引前移 1（核心回归）", () => {
    const tabs = mk(3); // [0,1,2]，激活 idx2
    expect(computeActiveIdxAfterClose(tabs, 2, 0)).toBe(1);
    // 数组缩短为 2，激活位 1 仍在合法区间内指向原第 3 个标签
    const next = tabs.filter((_, i) => i !== 0);
    expect(1).toBeLessThanOrEqual(next.length - 1);
  });

  it("关闭排在激活标签之后的标签 → 激活索引不变", () => {
    const tabs = mk(3); // 激活 idx0
    expect(computeActiveIdxAfterClose(tabs, 0, 2)).toBe(0);
  });

  it("关闭当前激活标签 → 切到相邻且不越界", () => {
    const tabs = mk(3); // 激活 idx2（最后一个）
    let next = tabs.filter((_, i) => i !== 2);
    let a = computeActiveIdxAfterClose(tabs, 2, 2);
    expect(a).toBe(1);
    expect(next[a]).toBeDefined();
    // 激活在中间的标签被关
    next = tabs.filter((_, i) => i !== 1);
    a = computeActiveIdxAfterClose(tabs, 1, 1);
    expect(a).toBe(1); // Math.min(1, len-1=1)
    expect(next[a]).toBeDefined();
  });

  it("回归旧缺陷：模拟 [A,B,C] 关 C 活动、关干净 A 后 activeIdx 仍指向有效标签", () => {
    const tabs = mk(3);
    let active = 2;
    const idx = 0; // 关闭 A（干净、位于激活之前）
    const next = tabs.filter((_, i) => i !== idx);
    active = computeActiveIdxAfterClose(tabs, active, idx);
    expect(active).toBe(1); // 旧实现会错误地保持 2（越界）
    expect(next[active]).toBeDefined();
  });
});
