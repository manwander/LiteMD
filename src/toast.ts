import { writable } from "svelte/store";

export type ToastKind = "success" | "error" | "info";

export interface ToastItem {
  id: number;
  msg: string;
  kind: ToastKind;
}

export const toasts = writable<ToastItem[]>([]);

let seq = 0;

/** 轻量操作反馈：成功/失败/提示，自动消失（不替代状态栏，仅作醒目提示） */
export function showToast(msg: string, kind: ToastKind = "info", ms = 2600): void {
  const id = ++seq;
  toasts.update((t) => [...t, { id, msg, kind }]);
  setTimeout(() => {
    toasts.update((t) => t.filter((x) => x.id !== id));
  }, ms);
}
