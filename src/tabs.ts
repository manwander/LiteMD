// 标签路径重命名去重（App.svelte updateTabPath 使用，纯函数可单测）。
// 背景：文件树内移动/重命名文件后，已打开标签的路径需同步更新；
// 但若目标路径已被另一个标签占用（多次移动落同一目标且发生覆盖），直接改名会产生
// 两个同路径标签 → 标签栏 keyed-each (tab.path) 抛 "Cannot have duplicate keys" 并卡死整个应用。
import { normPath } from "./filetree/types";

export interface TabPathLike {
  path: string;
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

/**
 * 关闭标签后应使用的 activeIdx（仅在移除后数组非空时调用）。
 * 背景（C-2 修复）：旧实现只在「关闭的是当前激活标签」时调整 activeIdx，
 * 漏掉了「关闭一个排在激活标签之前的干净标签」的情况——数组缩短 1 但
 * activeIdx 未减，导致越界指向错误的标签对象，进而 save()/脏检测/关闭确认
 * 全部对错标签生效，可静默丢失未保存改动。
 *
 * 三种情形（idx = 被关闭标签在【移除前】数组中的下标）：
 * - idx === activeIdx：激活标签被关，切到相邻（原 Math.min(idx, len-1) 语义）。
 * - idx < activeIdx：关闭激活标签之前的标签，激活位整体前移 1。
 * - idx > activeIdx：关闭激活标签之后的标签，激活位不变。
 */
export function computeActiveIdxAfterClose(
  tabs: TabPathLike[],
  activeIdx: number,
  idx: number
): number {
  const nextLen = tabs.length - 1;
  if (idx === activeIdx) return Math.min(idx, Math.max(0, nextLen - 1));
  if (idx < activeIdx) return activeIdx - 1;
  return activeIdx;
}
