// 目录监视前端侧（FEAT-2）：启动/停止 Rust watcher，订阅 "fs-change" 事件，
// 防抖合并后回调外部做精准刷新。非 Tauri 环境（浏览器/vitest）静默降级。
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { watchDirs, watchStop } from "../fs";

export interface FsChange {
  path: string;
  kind: string;
}

let unlisten: UnlistenFn | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let pending: FsChange[] = [];
let paused = false;
let onChangesRef: ((changes: FsChange[]) => void) | null = null;

/**
 * 启动监视 roots。返回是否成功。
 * 事件 300ms 防抖合并后一次性回调 onChanges（外部据此刷新受影响的已加载目录）。
 */
export async function startWatching(
  roots: string[],
  onChanges: (changes: FsChange[]) => void
): Promise<boolean> {
  onChangesRef = onChanges;
  try {
    await watchDirs(roots);
    if (unlisten) {
      try {
        unlisten();
      } catch {
        /* ignore */
      }
      unlisten = null;
    }
    unlisten = await listen<FsChange>("fs-change", (e) => {
      pending.push(e.payload);
      // 拖拽/移动进行中暂停刷新，避免与乐观更新竞态；恢复时统一 flush 一次
      if (paused) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const batch = pending;
        pending = [];
        if (batch.length) onChanges(batch);
      }, 300);
    });
    return true;
  } catch {
    return false;
  }
}

/** 拖拽/移动期间暂停文件监视刷新（防止监视事件与乐观 UI 更新叠加造成闪烁/竞态） */
export function pauseWatcher(): void {
  paused = true;
}

/** 恢复文件监视刷新；若有拖拽期间累积的变更，立即统一回调一次 */
export function resumeWatcher(): void {
  if (!paused) return;
  paused = false;
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (pending.length) {
    const batch = pending;
    pending = [];
    onChangesRef?.(batch);
  }
}

/** 停止监视（应用卸载 / 根列表变化时） */
export function stopWatching(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  pending = [];
  // watchStop 是异步命令；非 Tauri 环境（浏览器调试/测试）会 reject，必须显式吞掉
  void watchStop().catch(() => {});
  if (unlisten) {
    try {
      unlisten();
    } catch {
      /* ignore */
    }
    unlisten = null;
  }
}
