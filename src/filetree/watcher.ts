// 目录监视前端侧（FEAT-2）：启动/停止 Rust watcher，订阅 "fs-change" 事件，
// 防抖合并后回调外部做精准刷新。非 Tauri 环境（浏览器/vitest）静默降级。
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { watchDirs, watchStop } from "../fs";

export interface FsChange {
  path: string;
  /** 同一事件携带的全部路径（rename 等事件含旧/新两个路径）；缺省时回退 path */
  paths?: string[];
  kind: string;
}

let unlisten: UnlistenFn | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let pending: FsChange[] = [];
let paused = false;
let onChangesRef: ((changes: FsChange[]) => void) | null = null;
// 持有者计数：App 常驻持有 1 份，文件树挂载时再持有 1 份。Rust 侧监视器是全局单例，
// 只有归零才真正 stopWatching，避免收起侧栏/专注模式卸载文件树时误停 App 依赖的外部变更检测（报告 1-C）。
let holders = 0;

/** App 在挂载期常驻持有一份，使文件树的卸载不会停掉全局监视器。 */
export function retainFsWatcher(): void {
  holders++;
}
/** 释放一份持有；归零才真正停止 Rust 监视器与前端事件订阅。 */
export function releaseFsWatcher(): void {
  if (holders > 0) holders--;
  if (holders > 0) return;
  hardStop();
}

/**
 * （重新）启动对 roots 的监视并订阅 fs-change。幂等：可在根列表变化时反复调用，
 * 内部会退订旧监听、以新 roots 重新 arm Rust 监视器。不改动持有者计数。
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

/** 停止监视（释放一份持有；仍有持有者时保持全局监视器运行）。 */
export function stopWatching(): void {
  releaseFsWatcher();
}

/** 真正停止：清防抖、停 Rust 监视器、退订前端事件。仅在持有者归零时调用。 */
function hardStop(): void {
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
