// WebDAV 同步模块入口（设计方案 §8）：Tauri 命令 + DTO + 全局互斥/取消。
// 配置由前端每次传入（settings.json 单一数据源在前端），Rust 侧不落配置。

pub mod engine;
pub mod local;
pub mod state;
pub mod transport;
pub mod webdav;

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc};

use serde::Deserialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

use engine::{ConflictPolicy, EngineOptions, SyncEvent, SyncMode, SyncSummary};
use state::{folder_id as derive_folder_id, normalize_rel_key, FolderMeta, Snapshot, SnapshotStore};
use transport::{CheckStep, Transport};
use webdav::{WebDav, WebDavConfig};

/// 全局互斥：同一时刻只跑一轮同步（§5.1 步骤 0）
static SYNC_RUNNING: AtomicBool = AtomicBool::new(false);
/// 取消信号：文件间检查点生效（§7.6）
static SYNC_CANCEL: AtomicBool = AtomicBool::new(false);

// ---------------- DTO（camelCase 对齐前端） ----------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountDto {
    pub url: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderDto {
    #[serde(default)]
    pub id: String,
    pub local_root: String,
    #[serde(default)]
    pub base_path: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AdvancedDto {
    #[serde(default)]
    pub ignore_tls_errors: bool,
    #[serde(default)]
    pub custom_tls_certs: String,
    #[serde(default)]
    pub proxy_enabled: bool,
    #[serde(default)]
    pub proxy_url: String,
    #[serde(default)]
    pub proxy_timeout_sec: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConfigDto {
    pub account: AccountDto,
    pub folders: Vec<FolderDto>,
    #[serde(default)]
    pub concurrency: Option<usize>,
    #[serde(default)]
    pub conflict_policy: Option<String>,
    #[serde(default)]
    pub fail_safe: Option<bool>,
    #[serde(default)]
    pub max_file_size_mb: Option<u32>,
    #[serde(default)]
    pub ignore_patterns: Vec<String>,
    #[serde(default)]
    pub advanced: AdvancedDto,
    /// 打开且脏的标签绝对路径（§7.6 下载保护）
    #[serde(default)]
    pub open_dirty_paths: Vec<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckReport {
    pub steps: Vec<CheckStep>,
    pub all_ok: bool,
}

struct RunningGuard;
impl Drop for RunningGuard {
    fn drop(&mut self) {
        SYNC_RUNNING.store(false, Ordering::SeqCst);
    }
}

// ---------------- 公共辅助 ----------------

fn resolve_folder(cfg: &SyncConfigDto, fid: &str) -> Result<FolderDto, String> {
    let fid = fid.trim();
    if !fid.is_empty() {
        if let Some(f) = cfg.folders.iter().find(|f| f.id == fid) {
            return Ok(f.clone());
        }
        return Err(format!("未找到同步文件夹 {}", fid));
    }
    cfg.folders
        .iter()
        .find(|f| f.enabled)
        .cloned()
        .ok_or_else(|| "尚未配置同步文件夹（请在 设置→同步 中添加）".into())
}

fn build_transport(cfg: &SyncConfigDto, folder: &FolderDto) -> Result<WebDav, String> {
    let wcfg = WebDavConfig {
        url: cfg.account.url.clone(),
        username: cfg.account.username.clone(),
        password: cfg.account.password.clone(),
        ignore_tls_errors: cfg.advanced.ignore_tls_errors,
        custom_tls_certs: cfg.advanced.custom_tls_certs.clone(),
        proxy_enabled: cfg.advanced.proxy_enabled,
        proxy_url: cfg.advanced.proxy_url.clone(),
        proxy_timeout_sec: cfg.advanced.proxy_timeout_sec,
    };
    WebDav::new(&wcfg, &folder.base_path)
}

fn build_opts(cfg: &SyncConfigDto, folder: &FolderDto, mode: SyncMode) -> EngineOptions {
    let open_dirty: HashSet<String> = cfg
        .open_dirty_paths
        .iter()
        .filter_map(|p| to_rel_under(&folder.local_root, p))
        .map(|r| normalize_rel_key(&r))
        .collect();
    EngineOptions {
        concurrency: cfg.concurrency.unwrap_or(5).clamp(1, 16),
        fail_safe: cfg.fail_safe.unwrap_or(true),
        policy: match cfg.conflict_policy.as_deref() {
            Some("newerWins") => ConflictPolicy::NewerWins,
            _ => ConflictPolicy::KeepBoth,
        },
        max_file_size: (cfg.max_file_size_mb.unwrap_or(100) as u64) * 1024 * 1024,
        ignore_patterns: cfg.ignore_patterns.clone(),
        open_dirty,
        mode,
    }
}

fn to_rel_under(root: &str, abs: &str) -> Option<String> {
    let r = root.replace('\\', "/").trim_end_matches('/').to_lowercase();
    let a = abs.replace('\\', "/");
    if a.to_lowercase().starts_with(&r) {
        let rel = a[r.len()..].trim_start_matches('/');
        if !rel.is_empty() {
            return Some(rel.to_string());
        }
    }
    None
}

fn sync_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|p| p.join("sync"))
        .map_err(|e| format!("无法定位应用数据目录: {}", e))
}

fn load_snapshot(store: &SnapshotStore, fid: &str, folder: &FolderDto, cfg: &SyncConfigDto) -> Snapshot {
    store.load(fid).unwrap_or_else(|| {
        Snapshot::new(FolderMeta {
            local_root: folder.local_root.clone(),
            url: cfg.account.url.clone(),
            base_path: folder.base_path.clone(),
        })
    })
}

// ---------------- Tauri 命令 ----------------

/// 四步分级检查（§7.1）：network / auth / read / write
#[tauri::command]
pub async fn sync_check_config(config: SyncConfigDto) -> Result<CheckReport, String> {
    let folder = resolve_folder(&config, "")?;
    let transport = build_transport(&config, &folder)?;
    let steps = transport.check().await?;
    let all_ok = steps.iter().all(|s| s.ok || s.skipped);
    Ok(CheckReport { steps, all_ok })
}

/// 执行一轮同步。mode: "normal"|"forceUpload"|"forceDownload"；dryRun 返回计划不执行。
#[tauri::command]
pub async fn sync_run(
    app: AppHandle,
    config: SyncConfigDto,
    folder_id: Option<String>,
    dry_run: Option<bool>,
    mode: Option<String>,
    on_event: Channel<SyncEvent>,
) -> Result<SyncSummary, String> {
    if SYNC_RUNNING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("已有同步在进行中".into());
    }
    let _guard = RunningGuard;
    SYNC_CANCEL.store(false, Ordering::SeqCst);

    let folder = resolve_folder(&config, folder_id.as_deref().unwrap_or(""))?;
    let mode = match mode.as_deref() {
        Some("forceUpload") => SyncMode::ForceUpload,
        Some("forceDownload") => SyncMode::ForceDownload,
        _ => {
            if dry_run.unwrap_or(false) {
                SyncMode::DryRun
            } else {
                SyncMode::Normal
            }
        }
    };
    let transport = build_transport(&config, &folder)?;
    let opts = build_opts(&config, &folder, mode);
    let dir = sync_dir(&app)?;
    let store = SnapshotStore::new(dir);
    let fid = if !folder.id.trim().is_empty() {
        folder.id.trim().to_string()
    } else {
        derive_folder_id(&folder.local_root)
    };
    let snap = load_snapshot(&store, &fid, &folder, &config);
    let local_root = Path::new(&folder.local_root);
    let cancel = Arc::new(AtomicBool::new(false));
    // 全局 sync_cancel 置位时转发到本轮 cancel 标志
    let watcher_cancel = cancel.clone();
    std::thread::spawn(move || {
        while !watcher_cancel.load(Ordering::Relaxed) {
            std::thread::sleep(std::time::Duration::from_millis(300));
            if SYNC_CANCEL.load(Ordering::Relaxed) {
                watcher_cancel.store(true, Ordering::Relaxed);
                return;
            }
            if SYNC_RUNNING.load(Ordering::Relaxed) == false {
                return; // 本轮已结束
            }
        }
    });
    let emit = Arc::new(move |ev: SyncEvent| {
        let _ = on_event.send(ev);
    });
    let report = engine::run_folder_sync(&transport, local_root, snap, &store, &fid, opts, cancel.clone(), emit).await?;
    Ok(report.summary)
}

/// 请求取消当前同步（文件间检查点生效）
#[tauri::command]
pub fn sync_cancel() {
    SYNC_CANCEL.store(true, Ordering::SeqCst);
}

/// 派生 folderId（前端建文件夹条目时调用，保证与 Rust 侧一致）
#[tauri::command]
pub fn sync_folder_id(local_root: String) -> String {
    derive_folder_id(&local_root)
}
