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
 * 文件夹移动/重命名后，批量重映射其下所有已打开标签（P0-3）。
 * 仅按「精确路径」匹配会让 A/b.md 在 A 被移动后继续写旧路径，保存时把文件
 * 复活到已不存在的位置；这里按路径前缀（含分隔符边界）同步重映射。
 * 目标路径已被其它标签占用时，保留被移动的标签、移除重复标签，与单文件逻辑一致。
 */
export function renameTabsUnderPath<T extends TabPathLike>(
  tabs: T[],
  oldPath: string,
  newPath: string,
  activeIdx: number
): { tabs: T[]; activeIdx: number } {
  const oldN = normPath(oldPath);
  const newN = normPath(newPath);
  const under = (p: string) => p === oldN || p.startsWith(oldN + "/");
  const remap = new Map<string, string>();
  for (const t of tabs) {
    if (under(t.path)) remap.set(t.path, newN + t.path.slice(oldN.length));
  }
  if (remap.size === 0) return { tabs, activeIdx };

  const targets = new Set(remap.values());
  const activeTab = tabs[activeIdx];
  const activePath = activeTab?.path;
  const keptFrom: number[] = [];
  const arr: T[] = [];
  tabs.forEach((t, i) => {
    // 目标路径上的旧标签由被移动的标签取代，避免 keyed each 出现重复 key
    if (!remap.has(t.path) && targets.has(t.path)) return;
    keptFrom.push(i);
    const p = remap.get(t.path);
    arr.push(p && p !== t.path ? ({ ...t, path: p } as T) : t);
  });

  let newActive = keptFrom.indexOf(activeIdx);
  if (newActive < 0 && activePath) {
    // 激活标签恰好是被替换的重复标签：定位到接管该路径的新标签
    newActive = arr.findIndex((t) => t.path === (remap.get(activePath) ?? activePath));
  }
  if (newActive < 0) newActive = Math.max(0, Math.min(activeIdx, arr.length - 1));
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
