// 真实 HTTP 端到端测试：与 scripts/webdav-test-server.mjs（本地 WebDAV 服务器）联调。
// 运行前置：
//   1) node scripts/webdav-test-server.mjs 18088 <空目录>
//   2) 设环境变量 LITEMD_WEBDAV_TEST=http://127.0.0.1:18088/
//   3) cd src-tauri && cargo test --test webdav_e2e
// 未设环境变量时全部自动 skip（CI/离线不毛刺）。
#![cfg(test)]

use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use litemd_lib::sync::engine::{run_folder_sync, ConflictPolicy, EngineOptions, SyncMode};
use litemd_lib::sync::state::{FolderMeta, Snapshot, SnapshotStore};
use litemd_lib::sync::transport::Transport;
use litemd_lib::sync::webdav::{WebDav, WebDavConfig};

fn base_url() -> Option<String> {
    std::env::var("LITEMD_WEBDAV_TEST").ok().filter(|s| !s.is_empty())
}

/// 每次运行唯一子目录：测试幂等（服务器 root 跨运行复用）
fn uniq_sub(tag: &str) -> String {
    let ns = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    format!("/e2e-{}-{:x}/", tag, ns)
}

fn test_webdav(base: &str, sub: &str) -> WebDav {
    let cfg = WebDavConfig {
        url: base.to_string(),
        username: "testuser".into(),
        password: "testpass".into(),
        ignore_tls_errors: false,
        custom_tls_certs: String::new(),
        proxy_enabled: false,
        proxy_url: String::new(),
        proxy_timeout_sec: 0,
    };
    WebDav::new(&cfg, sub).expect("WebDav 初始化")
}

fn meta(root: &Path, base: &str, sub: &str) -> FolderMeta {
    FolderMeta {
        local_root: root.display().to_string(),
        url: base.to_string(),
        base_path: sub.to_string(),
    }
}

async fn snap_dir() -> tempfile::TempDir {
    tempfile::tempdir().unwrap()
}

/// E2E：中文/空格/多级/附件目录 首轮上传 → 服务器可见 → 二轮零动作 → 远端新增下载
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn e2e_upload_download_roundtrip() {
    let Some(base) = base_url() else {
        eprintln!("skip: LITEMD_WEBDAV_TEST 未设置");
        return;
    };
    let local = tempfile::tempdir().unwrap();
    let state = snap_dir().await;
    std::fs::create_dir_all(local.path().join("日记")).unwrap();
    std::fs::write(local.path().join("日记/2026 09.md"), "九月计划 #待办".repeat(50)).unwrap();
    std::fs::write(local.path().join("readme.md"), "# readme").unwrap();
    std::fs::create_dir_all(local.path().join("笔记_attachment")).unwrap();
    std::fs::write(local.path().join("笔记_attachment/img 1.png"), [0x89u8, 0x50, 0x4e, 0x47]).unwrap();

    let sub = uniq_sub("rt");
    let wd = test_webdav(&base, &sub);
    let opts = EngineOptions::default();
    let store = SnapshotStore::new(state.path().to_path_buf());
    let snap = Snapshot::new(meta(local.path(), &base, &sub));

    let r1 = run_folder_sync(&wd, local.path(), snap, &store, "e2e1", opts.clone(), Arc::new(AtomicBool::new(false)), Arc::new(|_| {})).await.unwrap();
    assert_eq!(r1.summary.uploaded, 3, "首轮应上传 3 文件: {:?}", r1.summary.errors);
    assert!(r1.summary.errors.is_empty(), "{:?}", r1.summary.errors);

    // 服务器侧确实有这些对象
    let listed = wd.list_all().await.unwrap();
    let paths: Vec<_> = listed.iter().map(|e| e.path.as_str()).collect();
    assert!(paths.contains(&"readme.md"), "{:?}", paths);
    assert!(paths.iter().any(|p| p.contains("2026 09.md")), "{:?}", paths);
    assert!(paths.iter().any(|p| p.contains("img 1.png")), "{:?}", paths);

    // 二轮零动作
    let r2 = run_folder_sync(&wd, local.path(), r1.snap, &store, "e2e1", opts.clone(), Arc::new(AtomicBool::new(false)), Arc::new(|_| {})).await.unwrap();
    assert_eq!(r2.summary.uploaded + r2.summary.downloaded, 0, "{:?}", r2.summary);

    // 远端新增 → 本地下载（模拟另一设备上传）
    wd.upload("来自手机.md", "手机写的笔记".into()).await.unwrap();
    let r3 = run_folder_sync(&wd, local.path(), r2.snap, &store, "e2e1", opts, Arc::new(AtomicBool::new(false)), Arc::new(|_| {})).await.unwrap();
    assert_eq!(r3.summary.downloaded, 1, "{:?}", r3.summary);
    assert_eq!(std::fs::read_to_string(local.path().join("来自手机.md")).unwrap(), "手机写的笔记");
}

/// E2E：四步分级检查全过
#[tokio::test(flavor = "multi_thread")]
async fn e2e_check_config() {
    let Some(base) = base_url() else { return };
    let wd = test_webdav(&base, &uniq_sub("check"));
    let steps = wd.check().await.unwrap();
    assert_eq!(steps.len(), 4);
    for s in &steps {
        assert!(s.ok, "{} 应通过: {}", s.name, s.message);
    }
}

/// E2E：冲突双保留——本地与远端同改，keepBoth 一轮收敛且内容都在
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn e2e_conflict_keep_both() {
    let Some(base) = base_url() else { return };
    let local = tempfile::tempdir().unwrap();
    let state = snap_dir().await;
    let sub = uniq_sub("conflict");
    let wd = test_webdav(&base, &sub);
    let store = SnapshotStore::new(state.path().to_path_buf());

    // 首轮同步建立基线
    std::fs::write(local.path().join("note.md"), "LOCAL").unwrap();
    let r1 = run_folder_sync(&wd, local.path(), Snapshot::new(meta(local.path(), &base, &sub)), &store, "cf", EngineOptions::default(), Arc::new(AtomicBool::new(false)), Arc::new(|_| {})).await.unwrap();
    assert_eq!(r1.summary.uploaded, 1);

    // 制造双端修改：本地改 + 远端直接 PUT 改（绕过快照 etag）
    std::fs::write(local.path().join("note.md"), "LOCAL EDIT").unwrap();
    wd.upload("note.md", "REMOTE EDIT".into()).await.unwrap();

    let r2 = run_folder_sync(&wd, local.path(), r1.snap, &store, "cf", EngineOptions::default(), Arc::new(AtomicBool::new(false)), Arc::new(|_| {})).await.unwrap();
    assert_eq!(r2.summary.conflicts, vec!["note.md".to_string()], "{:?}", r2.summary);
    // 本地原文件保持 LOCAL EDIT
    assert_eq!(std::fs::read_to_string(local.path().join("note.md")).unwrap(), "LOCAL EDIT");
    // 远端原件 = LOCAL EDIT；远端有冲突副本 = REMOTE EDIT
    assert_eq!(wd.download("note.md").await.unwrap(), b"LOCAL EDIT");
    let listed = wd.list_all().await.unwrap();
    let copy = listed.iter().find(|e| e.path.contains("冲突副本")).expect("远端应有冲突副本");
    assert_eq!(wd.download(&copy.path).await.unwrap(), b"REMOTE EDIT");
    // 本地磁盘也有副本
    assert!(local.path().join(copy.path.as_str()).exists());
}

/// E2E：删除传播（本地删→远端删；远端删→本地进回收站）
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn e2e_delete_propagation() {
    let Some(base) = base_url() else { return };
    let local = tempfile::tempdir().unwrap();
    let state = snap_dir().await;
    let sub = uniq_sub("del");
    let wd = test_webdav(&base, &sub);
    let store = SnapshotStore::new(state.path().to_path_buf());
    std::fs::write(local.path().join("gone.md"), "x").unwrap();
    std::fs::write(local.path().join("keep.md"), "y").unwrap();
    let r1 = run_folder_sync(&wd, local.path(), Snapshot::new(meta(local.path(), &base, &sub)), &store, "dl", EngineOptions::default(), Arc::new(AtomicBool::new(false)), Arc::new(|_| {})).await.unwrap();
    assert_eq!(r1.summary.uploaded, 2);

    std::fs::remove_file(local.path().join("gone.md")).unwrap();
    let r2 = run_folder_sync(&wd, local.path(), r1.snap, &store, "dl", EngineOptions::default(), Arc::new(AtomicBool::new(false)), Arc::new(|_| {})).await.unwrap();
    assert_eq!(r2.summary.deleted_remote, 1, "{:?}", r2.summary);
    assert!(wd.download("gone.md").await.is_err(), "远端应已删");
    assert!(wd.download("keep.md").await.is_ok(), "未删文件保留");
}

/// E2E：强制上传全量重传 + dry-run 预览不落地
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn e2e_force_and_dryrun() {
    let Some(base) = base_url() else { return };
    let local = tempfile::tempdir().unwrap();
    let state = snap_dir().await;
    let sub = uniq_sub("force");
    let wd = test_webdav(&base, &sub);
    let store = SnapshotStore::new(state.path().to_path_buf());
    std::fs::write(local.path().join("a.md"), "1").unwrap();
    std::fs::write(local.path().join("b.md"), "2").unwrap();

    // dry-run：有 2 个上传计划但远端无文件
    let rd = run_folder_sync(&wd, local.path(), Snapshot::new(meta(local.path(), &base, &sub)), &store, "fc", EngineOptions { mode: SyncMode::DryRun, ..Default::default() }, Arc::new(AtomicBool::new(false)), Arc::new(|_| {})).await.unwrap();
    assert!(rd.summary.dry_run);
    assert_eq!(rd.summary.plan.as_ref().map(|p| p.len()), Some(2));
    assert_eq!(wd.list_all().await.unwrap().len(), 0, "dry-run 不应写远端");

    // 强制上传
    let rf = run_folder_sync(&wd, local.path(), Snapshot::new(meta(local.path(), &base, &sub)), &store, "fc", EngineOptions { mode: SyncMode::ForceUpload, ..Default::default() }, Arc::new(AtomicBool::new(false)), Arc::new(|_| {})).await.unwrap();
    assert_eq!(rf.summary.uploaded, 2);
    assert_eq!(wd.list_all().await.unwrap().len(), 2);
}

/// E2E：SY-067 故障保护——远端被清空（真实 DELETE 掉所有对象）后同步，
/// 绝不删除本地文件，并给出「远端为空」提示（内存 mock 之外的真实 HTTP 覆盖）。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn e2e_fail_safe_remote_wiped() {
    let Some(base) = base_url() else { return };
    let local = tempfile::tempdir().unwrap();
    let state = snap_dir().await;
    let sub = uniq_sub("failsafe");
    let wd = test_webdav(&base, &sub);
    let store = SnapshotStore::new(state.path().to_path_buf());

    // 首轮建立基线：本地 2 文件 → 远端 2 对象
    std::fs::write(local.path().join("a.md"), "A").unwrap();
    std::fs::write(local.path().join("b.md"), "B").unwrap();
    let r1 = run_folder_sync(&wd, local.path(), Snapshot::new(meta(local.path(), &base, &sub)), &store, "fs", EngineOptions::default(), Arc::new(AtomicBool::new(false)), Arc::new(|_| {})).await.unwrap();
    assert_eq!(r1.summary.uploaded, 2);

    // 模拟服务器被清空：把远端对象逐个 DELETE
    for e in wd.list_all().await.unwrap() {
        wd.delete(&e.path).await.unwrap();
    }
    assert_eq!(wd.list_all().await.unwrap().len(), 0, "远端应已清空");

    // 再同步：fail-safe 应阻止本地删除，并提示「远端为空」
    let r2 = run_folder_sync(&wd, local.path(), r1.snap, &store, "fs", EngineOptions::default(), Arc::new(AtomicBool::new(false)), Arc::new(|_| {})).await.unwrap();
    assert_eq!(r2.summary.deleted_local, 0, "故障保护下不得删本地：{:?}", r2.summary);
    assert_eq!(r2.summary.protected_deletes, 2, "应保护 2 项：{:?}", r2.summary);
    assert!(
        r2.summary.errors.iter().any(|e| e.contains("远端为空")),
        "应给出远端为空提示：{:?}",
        r2.summary.errors
    );
    assert_eq!(std::fs::read_to_string(local.path().join("a.md")).unwrap(), "A");
    assert_eq!(std::fs::read_to_string(local.path().join("b.md")).unwrap(), "B");
}

/// E2E：SY-069 列举/网络失败——transport.list_all 连不上时整轮 Err 中止，本地零变动。
#[tokio::test(flavor = "multi_thread")]
async fn e2e_listing_network_abort() {
    let Some(_base) = base_url() else { return }; // 离线门控（此例不依赖服务器，但保持一致的 skip 语义）
    let local = tempfile::tempdir().unwrap();
    let state = snap_dir().await;
    std::fs::write(local.path().join("keep.md"), "KEEP").unwrap();

    // 指向必然拒绝连接的死端口，使 PROPFIND 列举失败
    let bad_url = "http://127.0.0.1:1/".to_string();
    let cfg = WebDavConfig {
        url: bad_url.clone(),
        username: "u".into(),
        password: "p".into(),
        ignore_tls_errors: false,
        custom_tls_certs: String::new(),
        proxy_enabled: false,
        proxy_url: String::new(),
        proxy_timeout_sec: 0,
    };
    let wd = WebDav::new(&cfg, "/abort/").expect("WebDav 初始化");
    let store = SnapshotStore::new(state.path().to_path_buf());

    let res = run_folder_sync(&wd, local.path(), Snapshot::new(meta(local.path(), &bad_url, "/abort/")), &store, "net", EngineOptions::default(), Arc::new(AtomicBool::new(false)), Arc::new(|_| {})).await;
    assert!(res.is_err(), "列举网络失败应整轮中止并返回 Err");
    assert_eq!(std::fs::read_to_string(local.path().join("keep.md")).unwrap(), "KEEP", "中止不得改动本地数据");
}

/// E2E：SY-046 取消机制 + 断点续传——首轮处理若干文件后取消，已传部分入快照；
/// 再运行只补传剩余，不重复上传已完成项。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn e2e_cancel_and_resume() {
    let Some(base) = base_url() else { return };
    let local = tempfile::tempdir().unwrap();
    let state = snap_dir().await;
    let sub = uniq_sub("cancel");
    let wd = test_webdav(&base, &sub);
    let store = SnapshotStore::new(state.path().to_path_buf());

    const TOTAL: usize = 40;
    for i in 0..TOTAL {
        std::fs::write(local.path().join(format!("f{i:02}.md")), format!("content-{i}")).unwrap();
    }

    // 首轮：emit 回调在第 10 个完成后置取消标志 → 之后未启动的项在块首检查处跳过
    let cancel = Arc::new(AtomicBool::new(false));
    let done = Arc::new(AtomicUsize::new(0));
    {
        let c = cancel.clone();
        let d = done.clone();
        let emit = Arc::new(move |_ev| {
            if d.fetch_add(1, Ordering::Relaxed) + 1 >= 10 {
                c.store(true, Ordering::Relaxed);
            }
        });
        let r1 = run_folder_sync(&wd, local.path(), Snapshot::new(meta(local.path(), &base, &sub)), &store, "cz", EngineOptions::default(), cancel.clone(), emit).await.unwrap();
        assert!(r1.summary.cancelled, "首轮应标记为已取消：{:?}", r1.summary);
        let u1 = r1.summary.uploaded;
        assert!(u1 >= 1 && u1 < TOTAL, "应部分完成（{} 应落在 1..{}）", u1, TOTAL);
        assert_eq!(wd.list_all().await.unwrap().len(), u1, "远端应恰有已传部分");
        assert!(r1.summary.errors.iter().any(|e| e.contains("续传")), "应含断点续传提示：{:?}", r1.summary.errors);

        // 次轮：取消关闭，用首轮返回的快照续传剩余
        let cancel2 = Arc::new(AtomicBool::new(false));
        let r2 = run_folder_sync(&wd, local.path(), r1.snap, &store, "cz", EngineOptions::default(), cancel2, Arc::new(|_| {})).await.unwrap();
        assert!(!r2.summary.cancelled);
        assert_eq!(r2.summary.uploaded, TOTAL - u1, "第二轮应恰好补齐剩余、不重复上传已完成项");
        assert_eq!(wd.list_all().await.unwrap().len(), TOTAL, "全部 {} 个文件最终都应在远端", TOTAL);

        // 第三轮：幂等，零动作
        let r3 = run_folder_sync(&wd, local.path(), r2.snap, &store, "cz", EngineOptions::default(), Arc::new(AtomicBool::new(false)), Arc::new(|_| {})).await.unwrap();
        assert_eq!(r3.summary.uploaded + r3.summary.downloaded, 0, "续传完成后应幂等：{:?}", r3.summary);
    }
}

/// E2E：SY-065 newerWins——双端同改冲突，远端更新时本地旧版被回收站留存、本地覆盖为远端版
/// （通过把本地文件 mtime 设为 2000 年、远端此刻上传，制造无歧义的「远端更新」）。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn e2e_newer_wins_overwrite() {
    let Some(base) = base_url() else { return };
    let local = tempfile::tempdir().unwrap();
    let state = snap_dir().await;
    let sub = uniq_sub("newer");
    let wd = test_webdav(&base, &sub);
    let store = SnapshotStore::new(state.path().to_path_buf());

    // 首轮基线：本地/远端/快照同为 base
    std::fs::write(local.path().join("note.md"), "base").unwrap();
    let r1 = run_folder_sync(&wd, local.path(), Snapshot::new(meta(local.path(), &base, &sub)), &store, "nw", EngineOptions::default(), Arc::new(AtomicBool::new(false)), Arc::new(|_| {})).await.unwrap();
    assert_eq!(r1.summary.uploaded, 1);

    // 双端都改：远端此刻上传（mtime=now），本地改内容后把 mtime 压到 2000 年（远端更新）
    wd.upload("note.md", b"REMOTE WINNER".to_vec()).await.unwrap();
    let lp = local.path().join("note.md");
    std::fs::write(&lp, "LOCAL OLD").unwrap();
    {
        use std::fs::OpenOptions;
        use std::time::{Duration, SystemTime};
        let f = OpenOptions::new().write(true).open(&lp).unwrap();
        f.set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(946_684_800)).unwrap();
    }

    let r2 = run_folder_sync(&wd, local.path(), r1.snap, &store, "nw", EngineOptions { policy: ConflictPolicy::NewerWins, ..Default::default() }, Arc::new(AtomicBool::new(false)), Arc::new(|_| {})).await.unwrap();
    // newerWins 在 plan 期定胜负（engine.rs:239-242），产出的是纯 Download/Upload，不产生冲突项/副本
    assert!(r2.summary.conflicts.is_empty(), "newerWins 不应留下冲突项：{:?}", r2.summary.conflicts);
    assert_eq!(r2.summary.downloaded, 1, "远端更新 → 本地应下载覆盖：{:?}", r2.summary);
    assert_eq!(std::fs::read_to_string(&lp).unwrap(), "REMOTE WINNER", "newerWins 下远端更新→本地覆盖为远端版");
    assert_eq!(wd.list_all().await.unwrap().len(), 1, "newerWins 不应生成冲突副本");

    // 幂等：newerWins 收敛后再次常规同步应零动作
    let r3 = run_folder_sync(&wd, local.path(), r2.snap, &store, "nw", EngineOptions::default(), Arc::new(AtomicBool::new(false)), Arc::new(|_| {})).await.unwrap();
    assert_eq!(r3.summary.uploaded + r3.summary.downloaded, 0, "覆盖后应幂等：{:?}", r3.summary);
}
