// WebDAV 同步前端封装（设计方案 §8）：DTO 构建 + invoke 包装 + 进度事件。
// 与 fs.ts 同角色：只负责 IPC 边界，调度逻辑在 sync-scheduler.ts。
import { invoke, Channel } from "@tauri-apps/api/core";
import type { Settings, SyncSettings } from "./settings";

// ---------------- 与 Rust 侧 serde 对齐的类型 ----------------

export interface CheckStep {
  name: "network" | "auth" | "read" | "write" | string;
  ok: boolean;
  skipped: boolean;
  message: string;
}

export interface CheckReport {
  steps: CheckStep[];
  allOk: boolean;
}

export interface SyncEvent {
  phase: "scan" | "plan" | "upload" | "download" | "delete" | "conflict" | string;
  done: number;
  total: number;
  path: string;
}

export interface PlanItemDto {
  rel: string;
  action: string;
  copyRel?: string | null;
}

export interface SyncSummary {
  uploaded: number;
  downloaded: number;
  deletedLocal: number;
  deletedRemote: number;
  conflicts: string[];
  skipped: string[];
  errors: string[];
  protectedDeletes: number;
  dryRun: boolean;
  cancelled: boolean;
  plan?: PlanItemDto[] | null;
}

export interface SyncConfigDto {
  account: { url: string; username: string; password: string };
  folders: SyncSettings["folders"];
  concurrency: number;
  conflictPolicy: string;
  failSafe: boolean;
  maxFileSizeMB: number;
  ignorePatterns: string[];
  advanced: SyncSettings["advanced"];
  openDirtyPaths: string[];
}

export type SyncMode = "normal" | "forceUpload" | "forceDownload";

/** 从全局设置构建 Rust 命令参数（每次调用传快照，Rust 不读 settings.json） */
export function buildSyncConfig(s: Settings, openDirtyPaths: string[]): SyncConfigDto {
  const y = s.sync;
  return {
    account: { ...y.account },
    folders: y.folders.map((f) => ({ ...f })),
    concurrency: y.concurrency,
    conflictPolicy: y.conflictPolicy,
    failSafe: y.failSafe,
    maxFileSizeMB: y.maxFileSizeMB,
    ignorePatterns: [...y.ignorePatterns],
    advanced: { ...y.advanced },
    openDirtyPaths,
  };
}

/** 四步分级检查（§7.1） */
export function syncCheckConfig(cfg: SyncConfigDto): Promise<CheckReport> {
  return invoke<CheckReport>("sync_check_config", { config: cfg });
}

/** 执行一轮同步；onEvent 收进度。返回 "已在同步中" 错误时 reject 文案含关键字 */
export function syncRun(
  cfg: SyncConfigDto,
  opts: {
    folderId?: string;
    dryRun?: boolean;
    mode?: SyncMode;
    onEvent?: (ev: SyncEvent) => void;
  } = {}
): Promise<SyncSummary> {
  const channel = new Channel<SyncEvent>();
  if (opts.onEvent) channel.onmessage = opts.onEvent;
  return invoke<SyncSummary>("sync_run", {
    config: cfg,
    folderId: opts.folderId ?? "",
    dryRun: opts.dryRun ?? false,
    mode: opts.mode ?? "normal",
    onEvent: channel,
  });
}

export function syncCancel(): Promise<void> {
  return invoke("sync_cancel");
}

/** 派生 folderId（与 Rust 侧一致，新建同步文件夹条目时调用） */
export async function syncFolderId(localRoot: string): Promise<string> {
  try {
    return await invoke<string>("sync_folder_id", { localRoot });
  } catch {
    // 非 Tauri 环境（浏览器调试/vitest）回退：djb2 哈希前 12 位（仅占位，不参与真实同步）
    let h = 5381;
    for (const c of localRoot.toLowerCase().replace(/\\/g, "/")) h = ((h << 5) + h + c.charCodeAt(0)) >>> 0;
    return h.toString(16).padStart(8, "0").slice(0, 12).padEnd(12, "0");
  }
}

export const isSyncBusyError = (e: unknown) => String(e).includes("已有同步");

/** 汇总文案（状态栏/Toast 用） */
export function summarizeSync(s: SyncSummary): string {
  if (s.dryRun) return `预览：${(s.plan ?? []).length} 项待处理`;
  const parts: string[] = [];
  if (s.uploaded) parts.push(`上传 ${s.uploaded}`);
  if (s.downloaded) parts.push(`下载 ${s.downloaded}`);
  if (s.deletedLocal) parts.push(`本地删除 ${s.deletedLocal}`);
  if (s.deletedRemote) parts.push(`远端删除 ${s.deletedRemote}`);
  if (s.conflicts.length) parts.push(`冲突 ${s.conflicts.length}`);
  if (s.protectedDeletes) parts.push(`故障保护 ${s.protectedDeletes}`);
  if (s.skipped.length) parts.push(`跳过 ${s.skipped.length}`);
  if (s.errors.length) parts.push(`错误 ${s.errors.length}`);
  return parts.length ? parts.join(" · ") : "已是最新";
}
