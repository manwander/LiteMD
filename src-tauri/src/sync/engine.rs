// 三方合并同步引擎（设计方案 §5/§6）。
// 纯逻辑 build_plan() 可单测；run_folder_sync() 泛型于 Transport trait，生产=WebDav、测试=内存 Mock。

use futures::StreamExt;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use crate::sync::local::{scan_local, LocalEntry};
use crate::sync::state::{
    canon_rel, normalize_rel_key, sha256_bytes, unix_now, FileState, Snapshot, SnapshotStore,
};
use crate::sync::transport::{RemoteEntry, Transport};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConflictPolicy {
    KeepBoth,
    NewerWins,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncMode {
    Normal,
    DryRun,
    ForceUpload,
    ForceDownload,
}

#[derive(Debug, Clone)]
pub struct EngineOptions {
    pub concurrency: usize,
    pub fail_safe: bool,
    pub policy: ConflictPolicy,
    pub max_file_size: u64,
    pub ignore_patterns: Vec<String>,
    /// 打开且脏的标签（归一 rel 小写）：下载覆盖前强制转冲突副本（§7.6）
    pub open_dirty: HashSet<String>,
    pub mode: SyncMode,
}

impl Default for EngineOptions {
    fn default() -> Self {
        Self {
            concurrency: 5,
            fail_safe: true,
            policy: ConflictPolicy::KeepBoth,
            max_file_size: 100 * 1024 * 1024,
            ignore_patterns: vec![],
            open_dirty: HashSet::new(),
            mode: SyncMode::Normal,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ActionKind {
    Upload,
    Download,
    NewSameName,
    Conflict,
    DeleteRemote,
    DeleteRemoteKeepCopy,
    DeleteLocal,
    ReUpload,
    SnapPurge,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanItem {
    pub rel: String,
    pub kind: ActionKind,
    /// 冲突/删改副本的目标相对路径（plan 期生成，runtime 保证唯一）
    pub copy_rel: Option<String>,
    /// 远端当前元数据（plan 期快照，供 runtime 更新快照条目，免下轮重复传输）
    pub remote_etag: Option<String>,
    pub remote_mtime: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanItemDto {
    pub rel: String,
    pub action: ActionKind,
    pub copy_rel: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncEvent {
    pub phase: String,
    pub done: usize,
    pub total: usize,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncSummary {
    pub uploaded: usize,
    pub downloaded: usize,
    pub deleted_local: usize,
    pub deleted_remote: usize,
    pub conflicts: Vec<String>,
    pub skipped: Vec<String>,
    pub errors: Vec<String>,
    pub protected_deletes: usize,
    pub dry_run: bool,
    pub cancelled: bool,
    pub plan: Option<Vec<PlanItemDto>>,
}

// ---------------- 变更判据（§4：哈希为准，mtime/size/etag 是缓存加速） ----------------

/// 本地相对快照是否可能已变（cheap：mtime+size；runtime 再做哈希终审）
fn local_maybe_changed(l: &LocalEntry, s: Option<&FileState>) -> bool {
    match s {
        None => true,
        Some(s) => l.size != s.size || l.mtime != s.mtime,
    }
}

/// 远端相对快照是否可能已变（优先 etag，无 etag 用 lastmodified+size，都缺 → 保守已变）
fn remote_maybe_changed(r: &RemoteEntry, s: Option<&FileState>) -> bool {
    let s = match s {
        None => return true,
        Some(s) => s,
    };
    match (&r.etag, r.last_modified) {
        (Some(etag), _) => match &s.remote_etag {
            Some(se) => etag != se,
            None => true,
        },
        (None, Some(lm)) => s.remote_mtime != Some(lm) || r.size != s.size,
        (None, None) => true,
    }
}

/// 冲突副本命名（§6.1）：`{stem}（冲突副本 {label}，远端）{ext}`
pub fn conflict_copy_name(rel: &str, label: &str) -> String {
    let (dir, file) = match rel.rfind('/') {
        Some(i) => (&rel[..i + 1], &rel[i + 1..]),
        None => ("", rel),
    };
    let dot = file.rfind('.').filter(|i| *i > 0);
    match dot {
        Some(i) => format!("{}{}（冲突副本 {}，远端）{}", dir, &file[..i], label, &file[i..]),
        None => format!("{}{}（冲突副本 {}，远端）", dir, file, label),
    }
}

fn default_copy_label() -> String {
    chrono::Local::now().format("%Y-%m-%d %H%M").to_string()
}

// ---------------- 计划（§5.2 分类矩阵） ----------------

pub fn build_plan(
    local: &[LocalEntry],
    remote: &[RemoteEntry],
    snap: &Snapshot,
    opts: &EngineOptions,
    copy_label: &str,
) -> (Vec<PlanItem>, Vec<String>, usize) {
    let mut notes = Vec::new();
    let lmap: HashMap<String, &LocalEntry> =
        local.iter().map(|e| (normalize_rel_key(&e.rel), e)).collect();
    let rmap: HashMap<String, &RemoteEntry> =
        remote.iter().map(|e| (normalize_rel_key(&e.path), e)).collect();

    // 强制模式：忽略快照与判据，全量单向
    if opts.mode == SyncMode::ForceUpload {
        let mut items: Vec<PlanItem> = lmap
            .values()
            .map(|l| PlanItem {
                rel: l.rel.clone(),
                kind: ActionKind::Upload,
                copy_rel: None,
                remote_etag: None,
                remote_mtime: None,
            })
            .collect();
        items.sort_by(|a, b| a.rel.cmp(&b.rel));
        return (items, notes, 0);
    }
    if opts.mode == SyncMode::ForceDownload {
        let mut items: Vec<PlanItem> = rmap
            .values()
            .map(|r| PlanItem {
                rel: r.path.clone(),
                kind: ActionKind::Download,
                copy_rel: None,
                remote_etag: r.etag.clone(),
                remote_mtime: r.last_modified,
            })
            .collect();
        items.sort_by(|a, b| a.rel.cmp(&b.rel));
        return (items, notes, 0);
    }

    let mut items: Vec<PlanItem> = Vec::new();
    let mut all_keys: Vec<&String> = lmap.keys().chain(rmap.keys()).chain(snap.files.keys()).collect();
    all_keys.sort();
    all_keys.dedup();

    for key in all_keys {
        let l = lmap.get(key).copied();
        let r = rmap.get(key).copied();
        let s = snap.files.get(key);
        let rel = l
            .map(|e| e.rel.clone())
            .or_else(|| r.map(|e| e.path.clone()))
            .or_else(|| s.map(|e| e.path.clone()))
            .unwrap_or_else(|| key.clone());
        let rmeta = || (r.and_then(|e| e.etag.clone()), r.and_then(|e| e.last_modified));

        match (l, r) {
            (Some(_), Some(_)) => match s {
                // #3 双方各自新增同名：runtime 哈希比对，相同认领、不同冲突
                None => {
                    let (re, rm) = rmeta();
                    items.push(PlanItem { rel, kind: ActionKind::NewSameName, copy_rel: None, remote_etag: re, remote_mtime: rm })
                }
                Some(s) => {
                    let lc = local_maybe_changed(l.unwrap(), Some(s));
                    let rc = remote_maybe_changed(r.unwrap(), Some(s));
                    match (lc, rc) {
                        (false, false) => {} // #4 均未变 → 跳过
                        (true, false) => items.push(PlanItem { rel, kind: ActionKind::Upload, copy_rel: None, remote_etag: s.remote_etag.clone(), remote_mtime: s.remote_mtime }), // #5
                        (false, true) => {
                            let (re, rm) = rmeta();
                            items.push(PlanItem { rel, kind: ActionKind::Download, copy_rel: None, remote_etag: re, remote_mtime: rm }) // #6
                        }
                        (true, true) => {
                            // #7 冲突；newerWins 且非脏标签在 plan 期定胜负
                            let (re, rm) = rmeta();
                            if opts.policy == ConflictPolicy::NewerWins && !opts.open_dirty.contains(key) {
                                let remote_wins = matches!(rm, Some(rm) if rm > l.unwrap().mtime);
                                let kind = if remote_wins { ActionKind::Download } else { ActionKind::Upload };
                                items.push(PlanItem { rel, kind, copy_rel: None, remote_etag: re, remote_mtime: rm });
                            } else {
                                let copy = conflict_copy_name(&rel, copy_label);
                                items.push(PlanItem { rel, kind: ActionKind::Conflict, copy_rel: Some(copy), remote_etag: re, remote_mtime: rm });
                            }
                        }
                    }
                }
            },
            (Some(l), None) => match s {
                // #1 本地新增 → 上传
                None => items.push(PlanItem { rel, kind: ActionKind::Upload, copy_rel: None, remote_etag: None, remote_mtime: None }),
                Some(s) => {
                    if local_maybe_changed(l, Some(s)) {
                        // #9 远端删、本地已变 → 以新内容重新上传
                        items.push(PlanItem { rel, kind: ActionKind::ReUpload, copy_rel: None, remote_etag: None, remote_mtime: None })
                    } else {
                        // #9 远端删、本地未变 → 删本地（回收站）
                        items.push(PlanItem { rel, kind: ActionKind::DeleteLocal, copy_rel: None, remote_etag: None, remote_mtime: None })
                    }
                }
            },
            (None, Some(r)) => match s {
                // #2 远端新增 → 下载
                None => {
                    let (re, rm) = rmeta();
                    items.push(PlanItem { rel, kind: ActionKind::Download, copy_rel: None, remote_etag: re, remote_mtime: rm })
                }
                Some(s) => {
                    if remote_maybe_changed(r, Some(s)) {
                        // #8 本地删、远端已变 → 删改冲突：远端内容落盘副本 + 删远端原件
                        let copy = conflict_copy_name(&r.path, copy_label);
                        items.push(PlanItem { rel, kind: ActionKind::DeleteRemoteKeepCopy, copy_rel: Some(copy), remote_etag: r.etag.clone(), remote_mtime: r.last_modified })
                    } else {
                        // #8 本地删、远端未变 → 删远端
                        items.push(PlanItem { rel, kind: ActionKind::DeleteRemote, copy_rel: None, remote_etag: None, remote_mtime: None })
                    }
                }
            },
            (None, None) => {
                // #10 双方删除 → 清快照条目
                items.push(PlanItem { rel, kind: ActionKind::SnapPurge, copy_rel: None, remote_etag: None, remote_mtime: None })
            }
        }
    }

    // fail-safe（§5.3）
    let mut protected = 0usize;
    if opts.fail_safe && !snap.files.is_empty() {
        if remote.is_empty() && !local.is_empty() {
            let before = items.len();
            items.retain(|i| i.kind != ActionKind::DeleteLocal);
            protected += before - items.len();
        }
        let dl = items.iter().filter(|i| i.kind == ActionKind::DeleteLocal).count();
        let threshold = std::cmp::max(20, snap.files.len() * 30 / 100);
        if dl > threshold {
            items.retain(|i| i.kind != ActionKind::DeleteLocal);
            notes.push(format!(
                "故障保护：本轮拟删除本地文件 {} 项，超过阈值 {}，已全部跳过（请检查同步配置）",
                dl, threshold
            ));
        }
    }
    if protected > 0 {
        notes.push(format!(
            "故障保护：远端为空（疑似配置错误或服务器异常），本轮跳过 {} 项本地删除",
            protected
        ));
    }
    (items, notes, protected)
}

// ---------------- 执行 ----------------

#[derive(Debug, Clone, Copy)]
enum OutcomeTag {
    Uploaded,
    Downloaded,
    DeletedLocal,
    DeletedRemote,
    Conflict,
}

fn phase_name(k: ActionKind) -> &'static str {
    match k {
        ActionKind::Upload | ActionKind::ReUpload => "upload",
        ActionKind::Download => "download",
        ActionKind::DeleteLocal
        | ActionKind::DeleteRemote
        | ActionKind::DeleteRemoteKeepCopy
        | ActionKind::SnapPurge => "delete",
        ActionKind::NewSameName | ActionKind::Conflict => "conflict",
    }
}

pub struct RunReport {
    pub summary: SyncSummary,
    /// 最终快照（调试/状态查询预留；常规路径 summary 已含全部所需信息）
    #[allow(dead_code)]
    pub snap: Snapshot,
}

/// 顶层入口：扫描 → 列举 → 计划 → 执行 → 汇总（§5.1）。
/// 列举失败（网络错误）直接 Err 冒泡 → 整轮中止（§5.3 网络护栏）。
pub async fn run_folder_sync<T: Transport>(
    transport: &T,
    local_root: &Path,
    snap: Snapshot,
    store: &SnapshotStore,
    folder_id: &str,
    opts: EngineOptions,
    cancel: Arc<AtomicBool>,
    emit: Arc<dyn Fn(SyncEvent) + Send + Sync>,
) -> Result<RunReport, String> {
    if !local_root.is_dir() {
        return Err(format!("本地同步文件夹不存在：{}", local_root.display()));
    }
    emit(SyncEvent { phase: "scan".into(), done: 0, total: 0, path: local_root.display().to_string() });
    let (local, mut skipped) = scan_local(local_root, &opts.ignore_patterns, opts.max_file_size)?;
    emit(SyncEvent { phase: "plan".into(), done: 0, total: 0, path: String::new() });
    let remote = transport.list_all().await?;
    // 双端皆空但有快照 → 极可能配置错误，整轮中止
    if local.is_empty()
        && remote.is_empty()
        && !snap.files.is_empty()
        && opts.fail_safe
        && opts.mode == SyncMode::Normal
    {
        return Err(
            "本地与远端均为空但存在同步记录：疑似配置错误，本轮中止（请检查同步文件夹/URL 设置）"
                .into(),
        );
    }

    let label = default_copy_label();
    let (items, notes, protected) = build_plan(&local, &remote, &snap, &opts, &label);

    // M5 修复：下载执行前未知远端体积，恶意/超大远端对象会被整体读入内存（并发 ≤16）
    // 造成内存耗尽。PROPFIND 列表已带回每个对象的 size，这里据此过滤超限的下载项：
    // 仅跳过下载，不影响上传、也不会因远端「看似消失」而误删本地副本。
    let mut items = items;
    if opts.max_file_size > 0 {
        let rsize: std::collections::HashMap<String, u64> =
            remote.iter().map(|e| (normalize_rel_key(&e.path), e.size)).collect();
        let cap = opts.max_file_size;
        let mut kept = Vec::with_capacity(items.len());
        for it in items.into_iter() {
            if matches!(it.kind, ActionKind::Download) {
                if let Some(sz) = rsize.get(&normalize_rel_key(&it.rel)) {
                    if *sz > cap {
                        skipped.push(format!(
                            "跳过超大远端文件（> {} MB）：{}",
                            cap / (1024 * 1024),
                            it.rel
                        ));
                        continue;
                    }
                }
            }
            kept.push(it);
        }
        items = kept;
    }

    let mut summary = SyncSummary::default();
    summary.skipped.append(&mut skipped);
    summary.errors.extend(notes);

    if opts.mode == SyncMode::DryRun {
        summary.dry_run = true;
        summary.plan = Some(
            items
                .iter()
                .map(|i| PlanItemDto { rel: i.rel.clone(), action: i.kind, copy_rel: i.copy_rel.clone() })
                .collect(),
        );
        return Ok(RunReport { summary, snap });
    }

    let snap = Arc::new(tokio::sync::Mutex::new(snap));
    let total = items.len();
    let done = Arc::new(AtomicUsize::new(0));
    let uploaded = Arc::new(AtomicUsize::new(0));
    let downloaded = Arc::new(AtomicUsize::new(0));
    let del_local = Arc::new(AtomicUsize::new(0));
    let del_remote = Arc::new(AtomicUsize::new(0));
    let conflicts = Arc::new(tokio::sync::Mutex::new(Vec::<String>::new()));
    let errors = Arc::new(tokio::sync::Mutex::new(Vec::<String>::new()));
    let root = local_root.to_path_buf();
    let concurrency = opts.concurrency.clamp(1, 16);

    // 强制下载：先把本地全部文件移入回收站（§9 双重确认由前端完成），再全量拉取
    if opts.mode == SyncMode::ForceDownload {
        for l in &local {
            let abs = l.abs.clone();
            let rel = l.rel.clone();
            let r = tokio::task::spawn_blocking(move || trash::delete(&abs).map_err(|e| e.to_string()))
                .await
                .map_err(|e| e.to_string())?;
            if let Err(e) = r {
                errors.lock().await.push(format!("本地移入回收站失败 {}: {}", rel, e));
            }
        }
        snap.lock().await.files.clear();
    }

    let mut stream = futures::stream::iter(items.into_iter().map(|item| {
        let t = transport;
        let root = root.clone();
        let snap = snap.clone();
        let done = done.clone();
        let cancel = cancel.clone();
        let emit = emit.clone();
        let opts = opts.clone();
        let conflicts = conflicts.clone();
        let errors = errors.clone();
        let uploaded = uploaded.clone();
        let downloaded = downloaded.clone();
        let del_local = del_local.clone();
        let del_remote = del_remote.clone();
        async move {
            if cancel.load(Ordering::Relaxed) {
                return;
            }
            let outcome = apply_item(t, &root, &snap, &opts, &item).await;
            let d = done.fetch_add(1, Ordering::Relaxed) + 1;
            emit(SyncEvent { phase: phase_name(item.kind).into(), done: d, total, path: item.rel.clone() });
            match outcome {
                Ok(tags) => {
                    for tag in tags {
                        match tag {
                            OutcomeTag::Uploaded => {
                                uploaded.fetch_add(1, Ordering::Relaxed);
                            }
                            OutcomeTag::Downloaded => {
                                downloaded.fetch_add(1, Ordering::Relaxed);
                            }
                            OutcomeTag::DeletedLocal => {
                                del_local.fetch_add(1, Ordering::Relaxed);
                            }
                            OutcomeTag::DeletedRemote => {
                                del_remote.fetch_add(1, Ordering::Relaxed);
                            }
                            OutcomeTag::Conflict => {
                                conflicts.lock().await.push(item.rel.clone());
                            }
                        }
                    }
                }
                Err(e) => errors.lock().await.push(format!("{}: {}", item.rel, e)),
            }
        }
    }))
    .buffer_unordered(concurrency);

    let mut processed = 0usize;
    while stream.next().await.is_some() {
        processed += 1;
        // 每 20 项 flush 快照（§4 断点续传）
        if processed % 20 == 0 {
            let guard = snap.lock().await;
            let _ = store.save(folder_id, &guard);
        }
    }

    summary.uploaded = uploaded.load(Ordering::Relaxed);
    summary.downloaded = downloaded.load(Ordering::Relaxed);
    summary.deleted_local = del_local.load(Ordering::Relaxed);
    summary.deleted_remote = del_remote.load(Ordering::Relaxed);
    summary.protected_deletes = protected;
    summary.conflicts = conflicts.lock().await.clone();
    summary.errors.extend(errors.lock().await.iter().cloned());
    summary.cancelled = cancel.load(Ordering::Relaxed);
    if summary.cancelled {
        summary.errors.push("同步被取消；已完成部分已入快照，下次运行自动续传".into());
    }
    let final_snap = snap.lock().await.clone();
    let _ = store.save(folder_id, &final_snap);
    Ok(RunReport { summary, snap: final_snap })
}

// ---------------- 单条动作执行 ----------------

async fn apply_item<T: Transport>(
    t: &T,
    root: &Path,
    snap: &tokio::sync::Mutex<Snapshot>,
    opts: &EngineOptions,
    item: &PlanItem,
) -> Result<Vec<OutcomeTag>, String> {
    match item.kind {
        ActionKind::SnapPurge => {
            snap.lock().await.remove(&item.rel);
            Ok(vec![])
        }
        ActionKind::Upload | ActionKind::ReUpload => do_upload(t, root, snap, item).await,
        ActionKind::Download => {
            let key = normalize_rel_key(&item.rel);
            if opts.open_dirty.contains(&key) && opts.mode == SyncMode::Normal {
                // §7.6：正在编辑的脏文件不被下载覆盖 → 写冲突副本，原路径不动
                return do_conflict(t, root, snap, item, ConflictPolicy::KeepBoth).await;
            }
            do_download(t, root, snap, item).await
        }
        ActionKind::NewSameName => {
            // #3：下载远端字节比对哈希；相同认领，不同按策略冲突
            let remote_bytes = t.download(&item.rel).await?;
            let local_bytes = read_bytes(root.join(slash(&item.rel))).await?;
            if sha256_bytes(&local_bytes) == sha256_bytes(&remote_bytes) {
                let st = stat_of(root, &item.rel).await?;
                let mut s = snap.lock().await;
                s.upsert(
                    &item.rel,
                    FileState {
                        hash: sha256_bytes(&remote_bytes),
                        size: st.0,
                        mtime: st.1,
                        remote_etag: item.remote_etag.clone(),
                        remote_mtime: item.remote_mtime,
                        synced_at: unix_now(),
                        path: canon_rel(&item.rel),
                    },
                );
                return Ok(vec![]); // 认领，不传输
            }
            do_conflict(t, root, snap, item, opts.policy).await
        }
        ActionKind::Conflict => do_conflict(t, root, snap, item, opts.policy).await,
        ActionKind::DeleteRemote => {
            t.delete(&item.rel).await?;
            snap.lock().await.remove(&item.rel);
            Ok(vec![OutcomeTag::DeletedRemote])
        }
        ActionKind::DeleteRemoteKeepCopy => {
            // #8 删改冲突：远端内容落盘为冲突副本 + 删除远端原件（等价双保留）
            let copy = item
                .copy_rel
                .clone()
                .or_else(|| Some(conflict_copy_name(&item.rel, &default_copy_label())))
                .ok_or("缺副本路径")?;
            let copy = unique_copy_name(root, &copy).await;
            let bytes = t.download(&item.rel).await?;
            write_bytes_atomic(root.join(slash(&copy)), &bytes).await?;
            t.delete(&item.rel).await?;
            let mut s = snap.lock().await;
            s.remove(&item.rel);
            let st = stat_of(root, &copy).await?;
            s.upsert(
                &copy,
                FileState {
                    hash: sha256_bytes(&bytes),
                    size: st.0,
                    mtime: st.1,
                    remote_etag: None,
                    remote_mtime: None,
                    synced_at: unix_now(),
                    path: canon_rel(&copy),
                },
            );
            Ok(vec![OutcomeTag::DeletedRemote, OutcomeTag::Downloaded, OutcomeTag::Conflict])
        }
        ActionKind::DeleteLocal => {
            let abs = root.join(slash(&item.rel));
            tokio::task::spawn_blocking(move || trash::delete(&abs).map_err(|e| e.to_string()))
                .await
                .map_err(|e| e.to_string())??;
            snap.lock().await.remove(&item.rel);
            Ok(vec![OutcomeTag::DeletedLocal])
        }
    }
}

async fn do_upload<T: Transport>(
    t: &T,
    root: &Path,
    snap: &tokio::sync::Mutex<Snapshot>,
    item: &PlanItem,
) -> Result<Vec<OutcomeTag>, String> {
    let bytes = read_bytes(root.join(slash(&item.rel))).await?;
    let hash = sha256_bytes(&bytes);
    let st = stat_of(root, &item.rel).await?;
    {
        // 哈希与快照一致（如仅 touch 了 mtime）→ 不重复上传，刷新本地元数据即可
        let mut s = snap.lock().await;
        let old = s.get(&item.rel).cloned();
        if let Some(old) = old {
            if old.hash == hash {
                s.upsert(
                    &item.rel,
                    FileState { size: st.0, mtime: st.1, synced_at: unix_now(), ..old },
                );
                return Ok(vec![]);
            }
        }
    }
    let up = t.upload(&item.rel, bytes).await?;
    let mut s = snap.lock().await;
    s.upsert(
        &item.rel,
        FileState {
            hash,
            size: st.0,
            mtime: st.1,
            remote_etag: up.etag,
            remote_mtime: up.last_modified,
            synced_at: unix_now(),
            path: canon_rel(&item.rel),
        },
    );
    Ok(vec![OutcomeTag::Uploaded])
}

async fn do_download<T: Transport>(
    t: &T,
    root: &Path,
    snap: &tokio::sync::Mutex<Snapshot>,
    item: &PlanItem,
) -> Result<Vec<OutcomeTag>, String> {
    let bytes = t.download(&item.rel).await?;
    let hash = sha256_bytes(&bytes);
    // 与快照哈希一致（无 etag 服务器每轮"保守已变"）→ 不写盘，只刷新远端元数据
    {
        let mut s = snap.lock().await;
        let old = s.get(&item.rel).cloned();
        if let Some(old) = old {
            if old.hash == hash {
                s.upsert(
                    &item.rel,
                    FileState {
                        remote_etag: item.remote_etag.clone(),
                        remote_mtime: item.remote_mtime,
                        synced_at: unix_now(),
                        ..old
                    },
                );
                return Ok(vec![]);
            }
        }
    }
    write_bytes_atomic(root.join(slash(&item.rel)), &bytes).await?;
    let st = stat_of(root, &item.rel).await?;
    let mut s = snap.lock().await;
    s.upsert(
        &item.rel,
        FileState {
            hash,
            size: st.0,
            mtime: st.1,
            remote_etag: item.remote_etag.clone(),
            remote_mtime: item.remote_mtime,
            synced_at: unix_now(),
            path: canon_rel(&item.rel),
        },
    );
    Ok(vec![OutcomeTag::Downloaded])
}

/// 冲突执行（§6）。policy 由调用方定（open-dirty 降级传 KeepBoth）。
async fn do_conflict<T: Transport>(
    t: &T,
    root: &Path,
    snap: &tokio::sync::Mutex<Snapshot>,
    item: &PlanItem,
    policy: ConflictPolicy,
) -> Result<Vec<OutcomeTag>, String> {
    let remote_bytes = t.download(&item.rel).await?;
    let remote_hash = sha256_bytes(&remote_bytes);
    let local_path = root.join(slash(&item.rel));
    let local_exists = tokio::fs::metadata(&local_path).await.is_ok();
    let local_bytes = if local_exists { read_bytes(local_path.clone()).await? } else { Vec::new() };
    let local_hash = sha256_bytes(&local_bytes);

    if remote_hash == local_hash && local_exists {
        // 内容一致：认领入快照，双方都不动
        let st = stat_of(root, &item.rel).await?;
        let mut s = snap.lock().await;
        s.upsert(
            &item.rel,
            FileState {
                hash: local_hash,
                size: st.0,
                mtime: st.1,
                remote_etag: item.remote_etag.clone(),
                remote_mtime: item.remote_mtime,
                synced_at: unix_now(),
                path: canon_rel(&item.rel),
            },
        );
        return Ok(vec![]);
    }

    match policy {
        ConflictPolicy::KeepBoth => {
            // 本地原路径不动 → 上传本地版覆盖远端；远端版写冲突副本 → 上传副本。一轮收敛，双方内容都在。
            let copy_rel = unique_copy_name(
                root,
                item.copy_rel
                    .as_deref()
                    .unwrap_or(&conflict_copy_name(&item.rel, &default_copy_label())),
            )
            .await;
            write_bytes_atomic(root.join(slash(&copy_rel)), &remote_bytes).await?;
            let (lsize, lmtime) = stat_of(root, &item.rel).await?;
            let up_orig = t.upload(&item.rel, local_bytes).await?;
            let up_copy = t.upload(&copy_rel, remote_bytes).await?;
            let mut s = snap.lock().await;
            s.upsert(
                &item.rel,
                FileState {
                    hash: local_hash,
                    size: lsize,
                    mtime: lmtime,
                    remote_etag: up_orig.etag,
                    remote_mtime: up_orig.last_modified,
                    synced_at: unix_now(),
                    path: canon_rel(&item.rel),
                },
            );
            let cst = stat_of(root, &copy_rel).await?;
            s.upsert(
                &copy_rel,
                FileState {
                    hash: remote_hash,
                    size: cst.0,
                    mtime: cst.1,
                    remote_etag: up_copy.etag,
                    remote_mtime: up_copy.last_modified,
                    synced_at: unix_now(),
                    path: canon_rel(&copy_rel),
                },
            );
            Ok(vec![OutcomeTag::Uploaded, OutcomeTag::Uploaded, OutcomeTag::Conflict])
        }
        ConflictPolicy::NewerWins => {
            let (lsize, lmtime) = stat_of(root, &item.rel).await.unwrap_or((0, 0));
            let remote_wins = item.remote_mtime.map(|rm| rm > lmtime).unwrap_or(false);
            if remote_wins {
                // 本地旧版先进回收站（逃生通道），再下载覆盖
                if local_exists {
                    tokio::task::spawn_blocking(move || trash::delete(&local_path).map_err(|e| e.to_string()))
                        .await
                        .map_err(|e| e.to_string())??;
                }
                write_bytes_atomic(root.join(slash(&item.rel)), &remote_bytes).await?;
                let st = stat_of(root, &item.rel).await?;
                let mut s = snap.lock().await;
                s.upsert(
                    &item.rel,
                    FileState {
                        hash: remote_hash,
                        size: st.0,
                        mtime: st.1,
                        remote_etag: item.remote_etag.clone(),
                        remote_mtime: item.remote_mtime,
                        synced_at: unix_now(),
                        path: canon_rel(&item.rel),
                    },
                );
                Ok(vec![OutcomeTag::Downloaded, OutcomeTag::Conflict])
            } else {
                let up = t.upload(&item.rel, local_bytes).await?;
                let mut s = snap.lock().await;
                s.upsert(
                    &item.rel,
                    FileState {
                        hash: local_hash,
                        size: lsize,
                        mtime: lmtime,
                        remote_etag: up.etag,
                        remote_mtime: up.last_modified,
                        synced_at: unix_now(),
                        path: canon_rel(&item.rel),
                    },
                );
                Ok(vec![OutcomeTag::Uploaded, OutcomeTag::Conflict])
            }
        }
    }
}

// ---------------- IO 小工具 ----------------

fn slash(rel: &str) -> PathBuf {
    PathBuf::from(rel.replace('/', std::path::MAIN_SEPARATOR_STR))
}

async fn read_bytes(path: PathBuf) -> Result<Vec<u8>, String> {
    tokio::task::spawn_blocking(move || std::fs::read(&path).map_err(|e| format!("{}: {}", path.display(), e)))
        .await
        .map_err(|e| e.to_string())?
}

async fn write_bytes_atomic(path: PathBuf, bytes: &[u8]) -> Result<(), String> {
    let bytes = bytes.to_vec();
    tokio::task::spawn_blocking(move || {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("{}: {}", parent.display(), e))?;
        }
        let tmp = path.with_extension(format!("tmp-{}", unix_now()));
        std::fs::write(&tmp, &bytes).map_err(|e| format!("{}: {}", tmp.display(), e))?;
        std::fs::rename(&tmp, &path).map_err(|e| format!("{}: {}", path.display(), e))?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// (size, mtime)
async fn stat_of(root: &Path, rel: &str) -> Result<(u64, i64), String> {
    let p = root.join(slash(rel));
    tokio::task::spawn_blocking(move || {
        let m = std::fs::metadata(&p).map_err(|e| format!("{}: {}", p.display(), e))?;
        let mt = m
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        Ok((m.len(), mt))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 冲突副本重名递增：`xxx（冲突副本 …）.md` → `xxx（冲突副本 …） (2).md`
async fn unique_copy_name(root: &Path, base: &str) -> String {
    let mut candidate = base.to_string();
    for i in 2..100 {
        if !root.join(slash(&candidate)).exists() {
            return candidate;
        }
        let (stem, ext) = match base.rfind('.') {
            Some(j) if j > 0 => base.split_at(j),
            _ => (base, ""),
        };
        candidate = format!("{} ({}){}", stem, i, ext);
    }
    candidate
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::transport::{CheckStep, UploadResult};
    use std::sync::Mutex as StdMutex;

    // ---- 内存假 Transport：内容即 etag，last_modified 手动控制 ----
    #[derive(Default)]
    struct MockTransport {
        files: StdMutex<HashMap<String, Vec<u8>>>,
        mtimes: StdMutex<HashMap<String, i64>>,
        fail_list: StdMutex<bool>,
    }
    impl MockTransport {
        fn put_raw(&self, rel: &str, bytes: &[u8], mtime: i64) {
            self.files.lock().unwrap().insert(rel.to_string(), bytes.to_vec());
            self.mtimes.lock().unwrap().insert(rel.to_string(), mtime);
        }
        fn snapshot(&self) -> HashMap<String, Vec<u8>> {
            self.files.lock().unwrap().clone()
        }
    }
    impl Transport for MockTransport {
        async fn check(&self) -> Result<Vec<CheckStep>, String> {
            Ok(vec![])
        }
        async fn list_all(&self) -> Result<Vec<RemoteEntry>, String> {
            if *self.fail_list.lock().unwrap() {
                return Err("mock 网络故障".into());
            }
            let f = self.files.lock().unwrap();
            let m = self.mtimes.lock().unwrap();
            Ok(f.iter()
                .map(|(p, b)| RemoteEntry {
                    path: p.clone(),
                    size: b.len() as u64,
                    etag: Some(sha256_bytes(b)),
                    last_modified: m.get(p).copied(),
                })
                .collect())
        }
        async fn download(&self, rel: &str) -> Result<Vec<u8>, String> {
            self.files.lock().unwrap().get(rel).cloned().ok_or_else(|| format!("mock 404 {}", rel))
        }
        async fn upload(&self, rel: &str, bytes: Vec<u8>) -> Result<UploadResult, String> {
            let hash = sha256_bytes(&bytes);
            self.files.lock().unwrap().insert(rel.to_string(), bytes);
            self.mtimes.lock().unwrap().insert(rel.to_string(), unix_now());
            Ok(UploadResult { etag: Some(hash), last_modified: Some(unix_now()) })
        }
        async fn delete(&self, rel: &str) -> Result<(), String> {
            self.files.lock().unwrap().remove(rel);
            self.mtimes.lock().unwrap().remove(rel);
            Ok(())
        }
    }

    fn le(root: &Path, rel: &str, size: u64, mtime: i64) -> LocalEntry {
        LocalEntry { rel: rel.into(), abs: root.join(rel), size, mtime }
    }
    fn re(rel: &str, etag: &str, lm: i64) -> RemoteEntry {
        RemoteEntry { path: rel.into(), size: 1, etag: Some(etag.into()), last_modified: Some(lm) }
    }
    fn fs_(rel: &str, hash: &str, size: u64, mtime: i64, retag: &str, rlm: i64) -> FileState {
        FileState { hash: hash.into(), size, mtime, remote_etag: Some(retag.into()), remote_mtime: Some(rlm), synced_at: 0, path: rel.into() }
    }
    fn snap_with(entries: Vec<FileState>) -> Snapshot {
        let mut s = Snapshot::new(crate::sync::state::FolderMeta {
            local_root: "x".into(),
            url: "y".into(),
            base_path: "/".into(),
        });
        for e in entries {
            s.upsert(&e.path.clone(), e);
        }
        s
    }

    // ---- build_plan 分类矩阵（§5.2 全 10 行）----
    #[test]
    fn matrix_all_rows() {
        let root = Path::new("/tmp");
        let opts = EngineOptions::default();
        let snap = snap_with(vec![
            fs_("both-unchanged.md", "sha256:s4", 1, 100, "e4", 100),
            fs_("local-changed.md", "sha256:s5", 1, 100, "e5", 100),
            fs_("remote-changed.md", "sha256:s6", 1, 100, "e6", 100),
            fs_("both-changed.md", "sha256:s7", 1, 100, "e7", 100),
            fs_("local-deleted.md", "sha256:s8", 1, 100, "e8", 100),
            fs_("remote-deleted.md", "sha256:s9", 1, 100, "e9", 100),
            fs_("both-deleted.md", "sha256:s10", 1, 100, "e10", 100),
        ]);

        let local = vec![
            le(root, "local-new.md", 2, 50),          // #1
            le(root, "same-name.md", 2, 60),          // #3
            le(root, "both-unchanged.md", 1, 100),    // #4
            le(root, "local-changed.md", 9, 200),     // #5 size+mtime 变
            le(root, "remote-changed.md", 1, 100),    // #6 本地未变
            le(root, "both-changed.md", 8, 300),      // #7
            le(root, "remote-deleted.md", 1, 100),    // #9 本地未变 → DeleteLocal
            le(root, "remote-deleted-mod.md", 5, 400),// #9 变体：无快照? 不，有快照未变→DeleteLocal；这里测无快照
        ];
        // 修正：remote-deleted-mod 不在快照 → 属 #1 上传。移除避免歧义。
        let local: Vec<LocalEntry> = local.into_iter().filter(|e| e.rel != "remote-deleted-mod.md").collect();

        let remote = vec![
            re("remote-new.md", "n2", 70),            // #2
            re("same-name.md", "n3", 70),             // #3
            re("both-unchanged.md", "e4", 100),       // #4
            re("local-changed.md", "e5", 100),        // #5 远端未变
            re("remote-changed.md", "x6", 500),       // #6 etag+mtime 变
            re("both-changed.md", "x7", 500),         // #7
            re("local-deleted.md", "e8", 100),        // #8 远端未变 → DeleteRemote
            re("local-deleted-mod.md", "zz", 600),    // #8 变体：快照无此条 → #2 下载
        ];
        // local-deleted-mod 不在快照 → #2。矩阵快照只含 local-deleted.md。

        let (plan, _, _) = build_plan(&local, &remote, &snap, &opts, "L");
        let get = |rel: &str| plan.iter().find(|p| p.rel == rel).map(|p| p.kind);
        assert_eq!(get("local-new.md"), Some(ActionKind::Upload), "#1");
        assert_eq!(get("remote-new.md"), Some(ActionKind::Download), "#2");
        assert_eq!(get("local-deleted-mod.md"), Some(ActionKind::Download), "#2");
        assert_eq!(get("same-name.md"), Some(ActionKind::NewSameName), "#3");
        assert_eq!(get("both-unchanged.md"), None, "#4 跳过");
        assert_eq!(get("local-changed.md"), Some(ActionKind::Upload), "#5");
        assert_eq!(get("remote-changed.md"), Some(ActionKind::Download), "#6");
        assert_eq!(get("both-changed.md"), Some(ActionKind::Conflict), "#7");
        assert_eq!(get("local-deleted.md"), Some(ActionKind::DeleteRemote), "#8");
        assert_eq!(get("remote-deleted.md"), Some(ActionKind::DeleteLocal), "#9");
        assert_eq!(get("both-deleted.md"), Some(ActionKind::SnapPurge), "#10");
    }

    #[test]
    fn matrix_row8_modified_remote_delete_conflict() {
        // #8 变体：本地删了，远端也变了 → DeleteRemoteKeepCopy + 副本路径
        let snap = snap_with(vec![fs_("a.md", "sha256:s", 1, 100, "e1", 100)]);
        let local = vec![];
        let remote = vec![re("a.md", "e2", 900)];
        let (plan, _, _) = build_plan(&local, &remote, &snap, &EngineOptions::default(), "L");
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].kind, ActionKind::DeleteRemoteKeepCopy);
        assert!(plan[0].copy_rel.as_deref().unwrap().contains("冲突副本 L"));
    }

    #[test]
    fn matrix_row9_modified_local_reupload() {
        // #9 变体：远端删了，本地内容变了（size/mtime 判据）→ ReUpload
        let root = Path::new("/tmp");
        let snap = snap_with(vec![fs_("a.md", "sha256:s", 1, 100, "e1", 100)]);
        let local = vec![le(root, "a.md", 77, 900)];
        let remote = vec![];
        let (plan, _, _) = build_plan(&local, &remote, &snap, &EngineOptions::default(), "L");
        assert_eq!(plan[0].kind, ActionKind::ReUpload);
    }

    #[test]
    fn newer_wins_policy_resolves_at_plan_time() {
        let root = Path::new("/tmp");
        let snap = snap_with(vec![
            fs_("a.md", "sha256:s", 1, 100, "e1", 100),
            fs_("b.md", "sha256:s", 1, 100, "e1", 100),
        ]);
        let local = vec![
            le(root, "a.md", 2, 900), // 本地更新
            le(root, "b.md", 2, 50),  // 远端更新
        ];
        let remote = vec![re("a.md", "x", 100), re("b.md", "x", 800)];
        let opts = EngineOptions { policy: ConflictPolicy::NewerWins, ..Default::default() };
        let (plan, _, _) = build_plan(&local, &remote, &snap, &opts, "L");
        let get = |rel: &str| plan.iter().find(|p| p.rel == rel).map(|p| p.kind);
        assert_eq!(get("a.md"), Some(ActionKind::Upload));
        assert_eq!(get("b.md"), Some(ActionKind::Download));
        // 脏标签例外：仍走 Conflict（runtime 降级 KeepBoth）
        let opts_dirty = EngineOptions {
            open_dirty: ["b.md".into()].into_iter().collect(),
            ..opts
        };
        let (plan2, _, _) = build_plan(&local, &remote, &snap, &opts_dirty, "L");
        assert_eq!(plan2.iter().find(|p| p.rel == "b.md").map(|p| p.kind), Some(ActionKind::Conflict));
    }

    #[test]
    fn fail_safe_blocks_deletions_when_remote_empty() {
        let root = Path::new("/tmp");
        let mut snap = snap_with(vec![
            fs_("a.md", "h", 1, 1, "e", 1),
            fs_("b.md", "h", 1, 1, "e", 1),
        ]);
        snap.remove("a.md"); // a 本地没了、远端空 → 若无保护会删本地? a 不在本地。b 在本地但远端没了 → DeleteLocal
        let local = vec![le(root, "b.md", 1, 1)];
        let opts = EngineOptions::default();
        let (plan, notes, _) = build_plan(&local, &[], &snap, &opts, "L");
        assert!(!plan.iter().any(|p| p.kind == ActionKind::DeleteLocal), "fail-safe 应移除 DeleteLocal");
        assert!(notes.iter().any(|n| n.contains("故障保护")));
        // 关闭 fail-safe 则保留
        let (plan2, _, _) = build_plan(&local, &[], &snap, &EngineOptions { fail_safe: false, ..Default::default() }, "L");
        assert!(plan2.iter().any(|p| p.kind == ActionKind::DeleteLocal));
    }

    #[test]
    fn fail_safe_mass_delete_threshold() {
        let root = Path::new("/tmp");
        // 快照 100 条，远端仅 1 个无关文件（不触发"远端为空"规则）、
        // 本地 100 个文件全在且未变 → 100 个 DeleteLocal > max(20,30)=30 → 全跳
        let entries: Vec<FileState> =
            (0..100).map(|i| fs_(&format!("f{}.md", i), "h", 1, 1, "e", 1)).collect();
        let snap = snap_with(entries);
        let local: Vec<LocalEntry> =
            (0..100).map(|i| le(root, &format!("f{}.md", i), 1, 1)).collect();
        let remote = vec![re("unrelated.md", "e", 1)];
        let (plan, notes, _) = build_plan(&local, &remote, &snap, &EngineOptions::default(), "L");
        assert!(notes.iter().any(|n| n.contains("超过阈值")));
        assert!(!plan.iter().any(|p| p.kind == ActionKind::DeleteLocal));
    }

    #[test]
    fn conflict_copy_naming() {
        assert_eq!(
            conflict_copy_name("笔记.md", "2026-09-13 1422"),
            "笔记（冲突副本 2026-09-13 1422，远端）.md"
        );
        assert_eq!(
            conflict_copy_name("sub/dir/a.tar.gz", "L"),
            "sub/dir/a.tar（冲突副本 L，远端）.gz"
        );
        assert_eq!(conflict_copy_name("noext", "L"), "noext（冲突副本 L，远端）");
    }

    #[test]
    fn force_modes_ignore_snapshot() {
        let root = Path::new("/tmp");
        let snap = snap_with(vec![fs_("x.md", "h", 1, 1, "e", 1)]);
        let local = vec![le(root, "a.md", 1, 1), le(root, "x.md", 1, 1)];
        let remote = vec![re("z.md", "e", 1)];
        let (up, _, _) = build_plan(&local, &remote, &snap, &EngineOptions { mode: SyncMode::ForceUpload, ..Default::default() }, "L");
        assert_eq!(up.len(), 2, "ForceUpload=本地全集上传");
        assert!(up.iter().all(|i| i.kind == ActionKind::Upload));
        let (dl, _, _) = build_plan(&local, &remote, &snap, &EngineOptions { mode: SyncMode::ForceDownload, ..Default::default() }, "L");
        assert_eq!(dl.len(), 1, "ForceDownload=远端全集下载");
        assert_eq!(dl[0].rel, "z.md");
    }

    // ---- 端到端（内存 transport + 真实临时目录）----
    async fn e2e(
        dir: &Path,
        t: &MockTransport,
        snap: Snapshot,
        opts: EngineOptions,
    ) -> (SyncSummary, Snapshot) {
        // 快照目录在同步根之外（对齐生产：app_data_dir）
        let store_dir = tempfile::tempdir().unwrap();
        let store = SnapshotStore::new(store_dir.path().to_path_buf());
        let r = run_folder_sync(
            t,
            dir,
            snap,
            &store,
            "testfid",
            opts,
            Arc::new(AtomicBool::new(false)),
            Arc::new(|_| {}),
        )
        .await
        .unwrap();
        (r.summary, r.snap)
    }

    #[tokio::test]
    async fn first_sync_uploads_local_and_downloads_remote() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("mine.md"), "local content").unwrap();
        let t = MockTransport::default();
        t.put_raw("theirs.md", b"remote content", 100);
        let (summary, snap) = e2e(dir.path(), &t, Snapshot::new(crate::sync::state::FolderMeta { local_root: "x".into(), url: "y".into(), base_path: "/".into() }), EngineOptions::default()).await;
        assert_eq!(summary.uploaded, 1);
        assert_eq!(summary.downloaded, 1);
        assert_eq!(std::fs::read_to_string(dir.path().join("theirs.md")).unwrap(), "remote content");
        assert_eq!(t.snapshot()["mine.md"], b"local content".to_vec());
        assert!(snap.get("mine.md").is_some() && snap.get("theirs.md").is_some());
    }

    #[tokio::test]
    async fn second_sync_is_noop() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.md"), "x").unwrap();
        let t = MockTransport::default();
        let (s1, snap1) = e2e(dir.path(), &t, Snapshot::new(crate::sync::state::FolderMeta { local_root: "x".into(), url: "y".into(), base_path: "/".into() }), EngineOptions::default()).await;
        assert_eq!(s1.uploaded, 1);
        let (s2, _) = e2e(dir.path(), &t, snap1, EngineOptions::default()).await;
        assert_eq!(s2.uploaded + s2.downloaded + s2.errors.len(), 0, "第二轮应零动作，errors={:?}", s2.errors);
    }

    #[tokio::test]
    async fn conflict_keep_both_produces_copy_and_converges() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("note.md"), "LOCAL EDIT").unwrap();
        let t = MockTransport::default();
        t.put_raw("note.md", b"REMOTE EDIT", 999);
        let snap = snap_with(vec![fs_("note.md", "sha256:old", 4, 500, "\"oldetag\"", 500)]);
        let (summary, snap2) = e2e(dir.path(), &t, snap, EngineOptions::default()).await;
        assert_eq!(summary.conflicts, vec!["note.md".to_string()]);
        // 本地原文件保持 LOCAL；远端原件被上传为 LOCAL 版；REMOTE 内容进副本（本地+远端各一份）
        assert_eq!(std::fs::read_to_string(dir.path().join("note.md")).unwrap(), "LOCAL EDIT");
        assert_eq!(t.snapshot()["note.md"], b"LOCAL EDIT".to_vec());
        let copy = snap2
            .files
            .values()
            .find(|f| f.path.contains("冲突副本"))
            .expect("应有冲突副本条目");
        assert_eq!(t.snapshot()[&copy.path], b"REMOTE EDIT".to_vec());
        // 第三轮零动作（收敛）
        let (s3, _) = e2e(dir.path(), &t, snap2, EngineOptions::default()).await;
        assert_eq!(s3.uploaded + s3.downloaded + s3.conflicts.len(), 0, "冲突应一轮收敛: {:?}", s3);
    }

    #[tokio::test]
    async fn new_same_name_identical_adopts_without_transfer() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("dup.md"), "same").unwrap();
        let t = MockTransport::default();
        t.put_raw("dup.md", b"same", 100);
        let (summary, snap) = e2e(dir.path(), &t, Snapshot::new(crate::sync::state::FolderMeta { local_root: "x".into(), url: "y".into(), base_path: "/".into() }), EngineOptions::default()).await;
        assert_eq!(summary.uploaded + summary.downloaded + summary.conflicts.len(), 0);
        assert!(snap.get("dup.md").is_some(), "认领入快照");
    }

    #[tokio::test]
    async fn download_dedup_when_no_etag_server() {
        // 无 etag/last_modified 服务器：remote_maybe_changed 恒真 → 下载但哈希一致不写盘
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.md"), "content").unwrap();
        let t = MockTransport::default();
        let (s1, mut snap1) = e2e(dir.path(), &t, Snapshot::new(crate::sync::state::FolderMeta { local_root: "x".into(), url: "y".into(), base_path: "/".into() }), EngineOptions::default()).await;
        assert_eq!(s1.uploaded, 1);
        // 抹掉快照 etag 模拟无 etag 服务器
        snap1.files.values_mut().for_each(|f| { f.remote_etag = None; f.remote_mtime = None; });
        let mtime_before = std::fs::metadata(dir.path().join("a.md")).unwrap().modified().unwrap();
        let (s2, snap2) = e2e(dir.path(), &t, snap1, EngineOptions::default()).await;
        assert_eq!(s2.downloaded, 0, "哈希一致不应计下载");
        assert_eq!(std::fs::metadata(dir.path().join("a.md")).unwrap().modified().unwrap(), mtime_before, "不写盘");
        assert!(snap2.get("a.md").is_some());
    }

    #[tokio::test]
    async fn listing_failure_aborts_round() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.md"), "x").unwrap();
        let t = MockTransport::default();
        *t.fail_list.lock().unwrap() = true;
        let store = SnapshotStore::new(dir.path().join("_state"));
        let r = run_folder_sync(
            &t, dir.path(),
            Snapshot::new(crate::sync::state::FolderMeta { local_root: "x".into(), url: "y".into(), base_path: "/".into() }),
            &store, "fid", EngineOptions::default(),
            Arc::new(AtomicBool::new(false)), Arc::new(|_| {}),
        ).await;
        assert!(r.is_err(), "列举失败必须整轮中止（§5.3）");
        assert_eq!(std::fs::read_to_string(dir.path().join("a.md")).unwrap(), "x", "本地数据未受影响");
    }

    #[tokio::test]
    async fn dry_run_returns_plan_without_io() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("new.md"), "x").unwrap();
        let t = MockTransport::default();
        t.put_raw("far.md", b"y", 1);
        let (summary, _) = e2e(dir.path(), &t, Snapshot::new(crate::sync::state::FolderMeta { local_root: "x".into(), url: "y".into(), base_path: "/".into() }), EngineOptions { mode: SyncMode::DryRun, ..Default::default() }).await;
        assert!(summary.dry_run);
        let plan = summary.plan.unwrap();
        assert_eq!(plan.len(), 2);
        assert!(plan.iter().any(|p| p.rel == "new.md" && p.action == ActionKind::Upload));
        assert!(plan.iter().any(|p| p.rel == "far.md" && p.action == ActionKind::Download));
        assert!(!dir.path().join("far.md").exists(), "dry-run 不落盘");
        assert!(t.snapshot().get("new.md").is_none(), "dry-run 不上传");
    }

    #[tokio::test]
    async fn delete_propagation() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("keep.md"), "k").unwrap();
        std::fs::write(dir.path().join("gone-local.md"), "g").unwrap();
        let t = MockTransport::default();
        t.put_raw("keep.md", b"k", 10);
        t.put_raw("gone-local.md", b"g", 10);
        t.put_raw("gone-remote.md", b"r", 10); // 首轮远端独有 → 下载
        let (s1, snap1) = e2e(dir.path(), &t, Snapshot::new(crate::sync::state::FolderMeta { local_root: "x".into(), url: "y".into(), base_path: "/".into() }), EngineOptions::default()).await;
        assert_eq!(s1.downloaded, 1, "gone-remote 首轮下载");
        assert_eq!(std::fs::read_to_string(dir.path().join("gone-remote.md")).unwrap(), "r");
        std::fs::remove_file(dir.path().join("gone-local.md")).unwrap();
        // gone-remote 本地在、远端"删了"（模拟：从 mock 移除但快照里还在）
        t.files.lock().unwrap().remove("gone-remote.md");
        let (s2, snap2) = e2e(dir.path(), &t, snap1, EngineOptions::default()).await;
        assert_eq!(s2.deleted_remote, 1, "本地删 → 远端删");
        assert_eq!(s2.deleted_local, 1, "远端删 → 本地进回收站");
        assert!(!dir.path().join("gone-remote.md").exists());
        assert!(snap2.get("gone-local.md").is_none() && snap2.get("gone-remote.md").is_none());
        assert!(snap2.get("keep.md").is_some(), "未变文件快照保留");
    }
}
