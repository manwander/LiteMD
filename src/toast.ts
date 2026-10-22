import { writable } from "svelte/store";

/** LM-17 四态：成功 / 警告 / 错误 / 信息 */
export type ToastKind = "success" | "warn" | "error" | "info";

export interface ToastItem {
  id: number;
  msg: string;
  kind: ToastKind;
}

export const toasts = writable<ToastItem[]>([]);

let seq = 0;

/** 轻量操作反馈：成功/警告/失败/提示，自动消失（不替代状态栏，仅作醒目提示） */
export function showToast(msg: string, kind: ToastKind = "info", ms = 2600): void {
  const id = ++seq;
  toasts.update((t) => [...t, { id, msg, kind }]);
  setTimeout(() => {
    toasts.update((t) => t.filter((x) => x.id !== id));
  }, ms);
}
