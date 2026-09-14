// 同步调度器（设计方案 §7.5）：心跳定时器 + 防重入 + 可见性门控 + 焦点/保存触发。
// 纯 TS 可单测：时间源与副作用全部注入。
import type { SyncSettings } from "./settings";

export interface SchedulerDeps {
  /** 返回当前同步设置（每次心跳读取，改设置无需重启定时器） */
  getSettings: () => SyncSettings;
  /** 真正执行一轮同步；返回是否实际跑了（"已在同步中" 应返回 false） */
  runSync: (trigger: SyncTrigger) => Promise<boolean>;
  now: () => number;
  isHidden: () => boolean;
  setTimer: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearTimer: (h: ReturnType<typeof setInterval>) => void;
}

export type SyncTrigger = "auto" | "manual" | "startup" | "focus" | "saved";

/** 心跳间隔：到期判定精度 ±15s，对分钟级同步足够 */
export const HEARTBEAT_MS = 15_000;
/** 启动后延迟首轮（避开启动热路径，§7.5） */
export const STARTUP_DELAY_MS = 30_000;
/** 保存后触发：距上轮 >60s 才补跑，5s 防抖合并连续保存 */
export const SAVED_MIN_GAP_MS = 60_000;
export const SAVED_DEBOUNCE_MS = 5_000;

export class SyncScheduler {
  private deps: SchedulerDeps;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastRunAt = 0;
  private startedAt = 0;
  private savedTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
  }

  start(): void {
    if (this.timer) return;
    this.startedAt = this.deps.now();
    this.lastRunAt = 0; // 0 = 从未同步：启动延迟过后首轮即跑（§7.5「启动完成后 30s 触发首轮」）
    this.timer = this.deps.setTimer(() => {
      void this.tick("auto");
    }, HEARTBEAT_MS);
  }

  stop(): void {
    if (this.timer) {
      this.deps.clearTimer(this.timer);
      this.timer = null;
    }
    this.cancelSavedTrigger();
  }

  /** 心跳：enabled + 间隔到期 + 启动延迟 + 非隐藏 + 非运行中 */
  async tick(trigger: SyncTrigger): Promise<boolean> {
    const s = this.deps.getSettings();
    if (!s.enabled || s.intervalMin <= 0) return false;
    if (this.running) return false;
    const now = this.deps.now();
    if (now - this.startedAt < STARTUP_DELAY_MS) return false;
    if (this.lastRunAt !== 0 && now - this.lastRunAt < s.intervalMin * 60_000) return false;
    if (this.deps.isHidden()) return false; // 隐藏暂停，恢复可见时过期即补（§7.5）
    return this.run(trigger);
  }

  /** 手动/立即同步：绕过间隔与启动延迟，但尊重 running 互斥 */
  async runNow(): Promise<boolean> {
    return this.run("manual");
  }

  /** 窗口恢复可见：过期即补一轮 */
  onVisible(): void {
    if (!this.deps.isHidden()) void this.tick("auto");
  }

  /** 窗口获得焦点且开启 syncOnWindowFocus：无视间隔补一轮（限频 30s） */
  onFocus(): void {
    const s = this.deps.getSettings();
    if (!s.enabled || !s.advanced.syncOnWindowFocus) return;
    const now = this.deps.now();
    if (now - this.lastRunAt < 30_000) return;
    void this.run("focus");
  }

  /** 编辑器保存成功：距上轮 >60s 则 5s 防抖后补一轮（让改动尽快上云） */
  notifySaved(): void {
    const s = this.deps.getSettings();
    if (!s.enabled || s.intervalMin <= 0) return;
    if (this.savedTimer) return; // 5s 窗口内连续保存合并
    const now = this.deps.now();
    if (now - this.lastRunAt < SAVED_MIN_GAP_MS) return;
    this.savedTimer = setTimeout(() => {
      this.savedTimer = null;
      if (!this.running) void this.run("saved");
    }, SAVED_DEBOUNCE_MS) as unknown as ReturnType<typeof setInterval>;
  }

  private cancelSavedTrigger(): void {
    if (this.savedTimer) {
      clearTimeout(this.savedTimer as unknown as ReturnType<typeof setTimeout>);
      this.savedTimer = null;
    }
  }

  private async run(trigger: SyncTrigger): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    const prevLastRun = this.lastRunAt;
    this.lastRunAt = this.deps.now();
    try {
      const ran = await this.deps.runSync(trigger);
      // 未实际执行（如 Rust 侧忙拒绝）→ 回退时间戳，下个心跳可重试
      if (!ran) this.lastRunAt = prevLastRun;
      return ran;
    } finally {
      this.running = false;
    }
  }

  /** 测试/状态栏用 */
  get isRunning(): boolean {
    return this.running;
  }
}
