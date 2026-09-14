// settings.ts sync 段 sanitize 测试（设计方案 §3.2：逐字段校验兜底）
import { describe, it, expect, beforeEach } from "vitest";
import { loadSettings, DEFAULT_SETTINGS, DEFAULT_SYNC } from "../settings";

const LS_KEY = "litemd.settings";

async function loadWith(raw: unknown) {
  localStorage.setItem(LS_KEY, JSON.stringify(raw));
  return await loadSettings();
}

beforeEach(() => localStorage.clear());

describe("sync 段 sanitize", () => {
  it("旧配置无 sync 段 → 回退默认（向后兼容）", async () => {
    const s = await loadWith({ theme: "dark", fontSize: 14 });
    expect(s.theme).toBe("dark");
    expect(s.sync).toEqual(DEFAULT_SYNC);
    expect(s.sync.enabled).toBe(false);
    expect(s.sync.failSafe).toBe(true);
    expect(s.sync.conflictPolicy).toBe("keepBoth");
  });

  it("URL 协议白名单 + 尾斜杠规范化", async () => {
    let s = await loadWith({ sync: { account: { url: "https://host/dav", username: "u", password: "p" } } });
    expect(s.sync.account.url).toBe("https://host/dav/");
    s = await loadWith({ sync: { account: { url: "ftp://bad/", username: "", password: "" } } });
    expect(s.sync.account.url).toBe("");
    s = await loadWith({ sync: { account: { url: "  https://ok.com/  " } } });
    expect(s.sync.account.url).toBe("https://ok.com/");
  });

  it("intervalMin 白名单校验：非法回退默认 5，显式 0（仅手动）保留", async () => {
    let s = await loadWith({ sync: { intervalMin: 7 } });
    expect(s.sync.intervalMin).toBe(5);
    s = await loadWith({ sync: { intervalMin: 15 } });
    expect(s.sync.intervalMin).toBe(15);
    s = await loadWith({ sync: { intervalMin: 0 } });
    expect(s.sync.intervalMin).toBe(0);
  });

  it("数值夹取：concurrency 1~16，maxFileSizeMB 1~4096，proxyTimeout 0~600", async () => {
    const s = await loadWith({
      sync: {
        concurrency: 999,
        maxFileSizeMB: -5,
        advanced: { proxyTimeoutSec: 1e9 },
      },
    });
    expect(s.sync.concurrency).toBe(16);
    expect(s.sync.maxFileSizeMB).toBe(1);
    expect(s.sync.advanced.proxyTimeoutSec).toBe(600);
    const t = await loadWith({ sync: { concurrency: 0 } });
    expect(t.sync.concurrency).toBe(1); // 0 夹取到下界 1
  });

  it("folders 过滤非法项 + basePath 补前导斜杠", async () => {
    const s = await loadWith({
      sync: {
        folders: [
          { localRoot: "E:\\notes", basePath: "notes/", enabled: true },
          { localRoot: "  ", basePath: "/" },
          null,
          { basePath: "/x" },
          { localRoot: "D:\\d" },
        ],
      },
    });
    expect(s.sync.folders.length).toBe(2);
    expect(s.sync.folders[0]).toMatchObject({ localRoot: "E:\\notes", basePath: "/notes/", enabled: true });
    expect(s.sync.folders[1]).toMatchObject({ localRoot: "D:\\d", basePath: "/" });
  });

  it("conflictPolicy 枚举 + failSafe 默认开", async () => {
    let s = await loadWith({ sync: { conflictPolicy: "weird", failSafe: false } });
    expect(s.sync.conflictPolicy).toBe("keepBoth");
    expect(s.sync.failSafe).toBe(false);
    s = await loadWith({ sync: { conflictPolicy: "newerWins" } });
    expect(s.sync.conflictPolicy).toBe("newerWins");
    // failSafe 缺省 → true
    s = await loadWith({ sync: {} });
    expect(s.sync.failSafe).toBe(true);
  });

  it("ignorePatterns 非数组回退默认、过滤空串", async () => {
    let s = await loadWith({ sync: { ignorePatterns: "not-array" } });
    expect(s.sync.ignorePatterns).toEqual(DEFAULT_SYNC.ignorePatterns);
    s = await loadWith({ sync: { ignorePatterns: ["a", "", "  ", 1] } });
    expect(s.sync.ignorePatterns).toEqual(["a"]);
  });

  it("损坏 JSON 回退全默认（含 sync）", async () => {
    localStorage.setItem(LS_KEY, "{ broken");
    const s = await loadSettings();
    expect(s.sync).toEqual(DEFAULT_SYNC);
  });

  it("lastSyncAt 数字保留、非法回退 null", async () => {
    let s = await loadWith({ sync: { lastSyncAt: 1757721600000 } });
    expect(s.sync.lastSyncAt).toBe(1757721600000);
    s = await loadWith({ sync: { lastSyncAt: "yesterday" } });
    expect(s.sync.lastSyncAt).toBe(null);
  });

  it("默认值 sync 深拷贝：单例加载互不污染", async () => {
    const a = await loadSettings();
    a.sync.account.url = "https://mutated/";
    a.sync.folders.push({ id: "x", localRoot: "C:\\x", basePath: "/", enabled: true });
    const b = await loadSettings();
    expect(b.sync.account.url).toBe("");
    expect(b.sync.folders.length).toBe(0);
    expect(DEFAULT_SETTINGS.sync.account.url).toBe("");
  });
});

// 顶层字段 sanitize —— D-10：autoSaveDelay 上下界夹取
describe("顶层 autoSaveDelay sanitize（D-10）", () => {
  it("越界上限 → 夹取 3000；合法区间原样；低于下限 → 默认", async () => {
    expect((await loadWith({ autoSaveDelay: 999999 })).autoSaveDelay).toBe(3000);
    expect((await loadWith({ autoSaveDelay: 1e12 })).autoSaveDelay).toBe(3000);
    expect((await loadWith({ autoSaveDelay: 300 })).autoSaveDelay).toBe(300); // 下界保留
    expect((await loadWith({ autoSaveDelay: 1500 })).autoSaveDelay).toBe(1500); // 区间内原样
    expect((await loadWith({ autoSaveDelay: 200 })).autoSaveDelay).toBe(DEFAULT_SETTINGS.autoSaveDelay); // <300 回退默认
    expect((await loadWith({ autoSaveDelay: "fast" })).autoSaveDelay).toBe(DEFAULT_SETTINGS.autoSaveDelay); // 非数字回退
  });
});
