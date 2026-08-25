// 拖拽目标合法性校验（纯函数，可单测）。
import { normPath, isUnder } from "./types";

/**
 * 判断 src 能否拖拽到 targetDir。
 * - 不能拖到自身
 * - 不能把目录拖进它自己的子孙（目标在源之下） → 向上移动（子→父/祖先）始终允许
 *
 * 旧实现写成 isUnder(s, d) 会错误拒绝「子项拖到父目录」的向上移动，
 * 表现为无法从次级别拖回 1 级/上级目录。
 */
export function dragTargetValid(src: string, targetDir: string): boolean {
  const s = normPath(src);
  const d = normPath(targetDir);
  if (s === d) return false;
  if (isUnder(d, s)) return false;
  return true;
}
