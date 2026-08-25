// 标签路径重命名去重（updateTabPath 崩溃修复 M-04）：
// 多次移动落到同一目标 + 覆盖时，不能产生两个同路径标签，否则标签栏 keyed-each 抛重复 key 卡死。
import { describe, it, expect } from "vitest";
import { renameTabPathDedup, type TabPathLike } from "../tabs";

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
