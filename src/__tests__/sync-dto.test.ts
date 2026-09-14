// sync.ts 纯函数测试：DTO 构建与汇总文案
import { describe, it, expect } from "vitest";
import { buildSyncConfig, summarizeSync, type SyncSummary } from "../sync";
import { DEFAULT_SETTINGS, type Settings } from "../settings";

function settingsWith(over: Partial<Settings["sync"]> = {}): Settings {
  const s = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as Settings;
  s.sync = { ...s.sync, ...over };
  return s;
}

describe("buildSyncConfig", () => {
  it("字段完整映射 + 脏标签透传", () => {
    const s = settingsWith({
      account: { url: "https://h/dav/", username: "u", password: "p" },
      concurrency: 7,
      conflictPolicy: "newerWins",
      maxFileSizeMB: 50,
      ignorePatterns: ["*.tmp"],
    });
    const dto = buildSyncConfig(s, ["E:\\notes\\a.md"]);
    expect(dto.account).toEqual({ url: "https://h/dav/", username: "u", password: "p" });
    expect(dto.concurrency).toBe(7);
    expect(dto.conflictPolicy).toBe("newerWins");
    expect(dto.failSafe).toBe(true);
    expect(dto.maxFileSizeMB).toBe(50);
    expect(dto.ignorePatterns).toEqual(["*.tmp"]);
    expect(dto.openDirtyPaths).toEqual(["E:\\notes\\a.md"]);
    expect(dto.advanced.proxyTimeoutSec).toBe(1);
  });

  it("返回深拷贝，改 DTO 不污染 settings", () => {
    const s = settingsWith();
    const dto = buildSyncConfig(s, []);
    dto.account.password = "leak";
    dto.ignorePatterns.push("x");
    expect(s.sync.account.password).toBe("");
    expect(s.sync.ignorePatterns).not.toContain("x");
  });
});

describe("summarizeSync", () => {
  const base: SyncSummary = {
    uploaded: 0, downloaded: 0, deletedLocal: 0, deletedRemote: 0,
    conflicts: [], skipped: [], errors: [], protectedDeletes: 0,
    dryRun: false, cancelled: false, plan: null,
  };
  it("空结果 → 已是最新", () => {
    expect(summarizeSync(base)).toBe("已是最新");
  });
  it("组合文案", () => {
    expect(
      summarizeSync({ ...base, uploaded: 2, downloaded: 1, conflicts: ["a.md", "b.md"], protectedDeletes: 3 })
    ).toBe("上传 2 · 下载 1 · 冲突 2 · 故障保护 3");
  });
  it("dryRun 显示计划数", () => {
    expect(
      summarizeSync({ ...base, dryRun: true, plan: [{ rel: "x", action: "upload" }, { rel: "y", action: "download" }] })
    ).toBe("预览：2 项待处理");
  });
});
