// 标签路径重命名去重（App.svelte updateTabPath 使用，纯函数可单测）。
// 背景：文件树内移动/重命名文件后，已打开标签的路径需同步更新；
// 但若目标路径已被另一个标签占用（多次移动落同一目标且发生覆盖），直接改名会产生
// 两个同路径标签 → 标签栏 keyed-each (tab.path) 抛 "Cannot have duplicate keys" 并卡死整个应用。
import { normPath } from "./filetree/types";

export interface TabPathLike {
  path: string;
  [k: string]: unknown;
}

/**
 * 计算移动/重命名后去重的标签数组与新的 activeIdx。
 * - 若目标路径 np 已被另一个标签占用，保留本次被改名的标签、移除已存在的重复标签。
 * - 同步修正 activeIdx（被移除的标签若 <= activeIdx 则前移；若被移除的恰为激活标签，则切换到被改名标签）。
 */
export function renameTabPathDedup<T extends TabPathLike>(
  tabs: T[],
  oldPath: string,
  newPath: string,
  activeIdx: number
): { tabs: T[]; activeIdx: number } {
  const np = normPath(newPath);
  const oldN = normPath(oldPath);
  const tabIdx = tabs.findIndex((t) => t.path === oldN);
  if (tabIdx < 0) return { tabs, activeIdx };

  const dupIdx = tabs.findIndex((t, i) => i !== tabIdx && t.path === np);
  let arr = tabs;
  if (dupIdx >= 0) arr = arr.filter((_, i) => i !== dupIdx);
  const renamedIdx = dupIdx >= 0 && dupIdx < tabIdx ? tabIdx - 1 : tabIdx;
  arr = arr.map((t, i) => (i === renamedIdx ? ({ ...t, path: np } as T) : t));

  let newActive = activeIdx;
  if (dupIdx >= 0) {
    if (dupIdx < activeIdx) newActive -= 1;
    if (dupIdx === activeIdx) newActive = renamedIdx;
  }
  return { tabs: arr, activeIdx: newActive };
}
