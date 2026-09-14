// SyncScheduler 调度测试（设计方案 §7.5）：心跳/间隔/启动延迟/可见性/防重入/焦点/保存触发
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  SyncScheduler,
  HEARTBEAT_MS,
  STARTUP_DELAY_MS,
  SAVED_MIN_GAP_MS,
} from "../sync-scheduler";
import { DEFAULT_SYNC, type SyncSettings } from "../settings";

function makeSettings(over: Partial<SyncSettings> = {}): SyncSettings {
  return JSON.parse(JSON.stringify({ ...DEFAULT_SYNC, enabled: true, intervalMin: 5, ...over }));
}

interface Harness {
  scheduler: SyncScheduler;
  runs: string[];
  set: (s: SyncSettings) => void;
  hidden: (h: boolean) => void;
  advance: (ms: number) => void;
  now: () => number;
  blockRun: (p: Promise<void> | null) => void;
}

function harness(init = makeSettings()): Harness {
  let settings = init;
  let hidden = false;
  let t = 1_000_000;
  let block: Promise<void> | null = null;
  const runs: string[] = [];
  const timers = new Map<number, () => void>();
  let nextId = 1;
  const scheduler = new SyncScheduler({
    getSettings: () => settings,
    runSync: async (trigger) => {
      runs.push(trigger);
      if (block) await block;
      return true;
    },
    now: () => t,
    isHidden: () => hidden,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, fn);
      void ms;
      return id as unknown as ReturnType<typeof setInterval>;
    },
    clearTimer: (h) => {
      timers.delete(h as unknown as number);
    },
  });
  return {
    scheduler,
    runs,
    set: (s) => { settings = s; },
    hidden: (h) => { hidden = h; },
    advance: (ms) => {
      t += ms;
      // 模拟心跳：手动触发所有注册的 interval 回调
      for (const fn of timers.values()) fn();
    },
    now: () => t,
    blockRun: (p) => { block = p; },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** 冲刷 run() 的 await 链，让 running 标志归位（调度器内部多次 await） */
async function settle() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

describe("SyncScheduler", () => {
  it("未启用/间隔 0 不跑", async () => {
    const h = harness(makeSettings({ enabled: false }));
    h.scheduler.start();
    h.advance(STARTUP_DELAY_MS + 10 * 60_000);
    expect(h.runs.length).toBe(0);
    h.set(makeSettings({ enabled: true, intervalMin: 0 }));
    h.advance(STARTUP_DELAY_MS + 10 * 60_000);
    expect(h.runs.length).toBe(0);
    h.scheduler.stop();
  });

  it("启动延迟 30s + 5 分钟间隔节奏", async () => {
    const h = harness();
    h.scheduler.start();
    h.advance(STARTUP_DELAY_MS - HEARTBEAT_MS); // ~15s < 30s
    await settle();
    expect(h.runs.length).toBe(0);
    h.advance(HEARTBEAT_MS * 2); // 到 45s：首轮
    await settle();
    expect(h.runs.length).toBe(1);
    h.advance(4 * 60_000); // 4 分钟：未到间隔
    await settle();
    expect(h.runs.length).toBe(1);
    h.advance(HEARTBEAT_MS * 8); // 过 5 分钟：第二轮
    await settle();
    expect(h.runs.length).toBe(2);
    h.scheduler.stop();
  });

  it("窗口隐藏跳过，恢复可见补跑", async () => {
    const h = harness();
    h.scheduler.start();
    h.advance(STARTUP_DELAY_MS + HEARTBEAT_MS);
    await settle();
    expect(h.runs.length).toBe(1);
    h.hidden(true);
    h.advance(6 * 60_000); // 隐藏期到期 → 跳过
    await settle();
    expect(h.runs.length).toBe(1);
    h.hidden(false);
    h.scheduler.onVisible(); // 恢复可见立即补
    await vi.waitFor(() => expect(h.runs.length).toBe(2));
    h.scheduler.stop();
  });

  it("防重入：上一轮没跑完不再起新轮", async () => {
    const h = harness();
    let release: () => void = () => {};
    h.blockRun(new Promise<void>((res) => { release = res; }));
    h.scheduler.start();
    h.advance(STARTUP_DELAY_MS + HEARTBEAT_MS);
    expect(h.runs.length).toBe(1);
    h.advance(6 * 60_000); // 第二轮 tick，但第一轮未结束
    expect(h.runs.length).toBe(1);
    release();
    await vi.waitFor(() => expect(h.scheduler.isRunning).toBe(false));
    h.blockRun(null);
    h.advance(6 * 60_000);
    expect(h.runs.length).toBe(2);
    h.scheduler.stop();
  });

  it("runNow 手动绕过间隔与启动延迟", async () => {
    const h = harness();
    h.scheduler.start();
    const ran = await h.scheduler.runNow();
    expect(ran).toBe(true);
    expect(h.runs).toEqual(["manual"]);
    h.scheduler.stop();
  });

  it("焦点触发：需开关开 + 距上轮 ≥30s", async () => {
    const h = harness(makeSettings({ advanced: { ...makeSettings().advanced, syncOnWindowFocus: true } }));
    h.scheduler.start();
    h.advance(STARTUP_DELAY_MS + HEARTBEAT_MS); // 首轮 auto
    await settle();
    const n = h.runs.length;
    h.scheduler.onFocus(); // 刚跑过（<30s）→ 不跑
    expect(h.runs.length).toBe(n);
    h.advance(31_000);
    await settle();
    h.scheduler.onFocus();
    await settle();
    expect(h.runs).toContain("focus");
    // 开关关 → 不跑
    h.set(makeSettings({ advanced: { ...makeSettings().advanced, syncOnWindowFocus: false } }));
    h.advance(61_000);
    await settle();
    const m = h.runs.length;
    h.scheduler.onFocus();
    expect(h.runs.length).toBe(m);
    h.scheduler.stop();
  });

  it("保存触发：距上轮 >60s 才补，5s 防抖合并连续保存", async () => {
    const h = harness();
    h.scheduler.start();
    h.advance(STARTUP_DELAY_MS + HEARTBEAT_MS); // 首轮
    const n = h.runs.length;
    h.scheduler.notifySaved(); // 刚跑过 → 忽略
    expect(h.runs.length).toBe(n);
    h.advance(SAVED_MIN_GAP_MS + 1000);
    h.scheduler.notifySaved();
    h.scheduler.notifySaved(); // 防抖合并
    await vi.advanceTimersByTimeAsync(6000);
    expect(h.runs.filter((r) => r === "saved").length).toBe(1);
    h.scheduler.stop();
  });

  it("stop 后心跳停止", async () => {
    const h = harness();
    h.scheduler.start();
    h.scheduler.stop();
    h.advance(STARTUP_DELAY_MS + 10 * 60_000);
    expect(h.runs.length).toBe(0);
  });
});
