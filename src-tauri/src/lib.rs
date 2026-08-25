#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use serde::Serialize;
use tauri::{Emitter, Manager};
use notify::Watcher;
use tauri_plugin_dialog::DialogExt;
use regex::Regex;
use printpdf::{Mm, PdfDocument};
use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
use owned_ttf_parser as otp;

// ---- 文件树数据结构（与 src/fs.ts 的 FolderNode / MdFile 对应）----
#[derive(Serialize, Clone)]
struct MdFile {
    name: String,
    path: String,
}

#[derive(Serialize, Clone)]
struct FolderNode {
    name: String,
    path: String,
    files: Vec<MdFile>,
    children: Vec<FolderNode>,
}

// 把 dialog 返回的 FilePath 转成字符串路径；用户取消/转 path 失败都视为 None
fn path_to_string(fp: Option<tauri_plugin_dialog::FilePath>) -> Option<String> {
    fp.and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().to_string())
}

// ---- 路径安全校验（ISSUE-001/002/009）----
/// 校验并规范化路径：拒绝空路径、拒绝含 .. 穿越的路径、返回绝对路径。
/// defense-in-depth：即使前端被 XSS 注入，也无法通过 IPC 读写任意文件。
fn validate_path(path: &str) -> Result<PathBuf, String> {
    if path.trim().is_empty() {
        return Err("路径不能为空".to_string());
    }
    let p = PathBuf::from(path);
    // 词法规范化：消除 .. 和 . 组件，防止路径穿越
    let mut normalized = PathBuf::new();
    for component in p.components() {
        match component {
            std::path::Component::ParentDir => {
                if !normalized.pop() {
                    return Err(format!("路径穿越被拒绝: {}", path));
                }
            }
            std::path::Component::CurDir => {} // 跳过 ./
            other => normalized.push(other.as_os_str()),
        }
    }
    if normalized.as_os_str().is_empty() {
        return Err("路径规范化后为空".to_string());
    }
    Ok(normalized)
}

// ---- 文件读写 ----
// ---- 轻量前端崩溃日志：仅记录未捕获异常，供排障回传（平时无日志、不影响体验）----
#[tauri::command]
fn log_frontend(line: String) {
    let p = std::env::temp_dir().join("litemd-frontend.log");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
        let _ = std::io::Write::write_all(&mut f, format!("{}\n", line).as_bytes());
    }
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    let validated = validate_path(&path)?;
    fs::read_to_string(validated).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    let validated = validate_path(&path)?;
    fs::write(validated, content).map_err(|e| e.to_string())
}

// ---- 大文档分片流式载入（P0）----
// 一次性 read_file 50MB 会产生单次 600~1200ms 的 IPC 长任务 + 与 rope 同时在世的
// 50MB 字符串副本。改为：头片（read_file_head）先让编辑器出字，剩余部分经 Channel
// 分片推送，前端在空闲帧逐片 append，任何一帧都不超预算。

#[tauri::command]
fn file_size(path: String) -> Result<u64, String> {
    // 安全：元数据查询也过路径校验
    let p = validate_path(&path).map_err(|e| e.to_string())?;
    fs::metadata(p).map(|m| m.len()).map_err(|e| e.to_string())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ReadHead {
    head: String,
    /// 头片实际消费的字节数（按 UTF-8 字符边界对齐截断），供 stream_file_rest 续读
    head_bytes: u64,
    /// 文件总字节数（前端进度条用）
    total: u64,
}

/// 返回 data[..end] 中最后一个 UTF-8 字符边界位置（最多回溯 3 字节，再用
/// from_utf8 兜底，损坏文件也不会 panic）
fn utf8_boundary(data: &[u8]) -> usize {
    let min = data.len().saturating_sub(3);
    let mut end = data.len();
    while end > min && end > 0 && (data[end - 1] & 0xC0) == 0x80 {
        end -= 1;
    }
    match std::str::from_utf8(&data[..end]) {
        Ok(_) => end,
        Err(e) => e.valid_up_to(),
    }
}

#[tauri::command]
async fn read_file_head(path: String, bytes: usize) -> Result<ReadHead, String> {
    // 安全：文档读取也过路径校验，杜绝 XSS 经 IPC 做 ../ 穿越读取任意文件
    let norm = validate_path(&path).map_err(|e| e.to_string())?.to_string_lossy().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Read;
        let mut f = fs::File::open(&norm).map_err(|e| e.to_string())?;
        let total = f.metadata().map(|m| m.len()).unwrap_or(0);
        let take = (bytes as u64).min(total) as usize;
        let mut buf = vec![0u8; take];
        f.read_exact(&mut buf).map_err(|e| e.to_string())?;
        let end = utf8_boundary(&buf);
        let head = String::from_utf8(buf[..end].to_vec()).map_err(|e| e.to_string())?;
        Ok(ReadHead { head, head_bytes: end as u64, total })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 从 offset 字节起按 chunk 分片读取，经 Channel 推送字符串片（按字符边界切分）。
/// 读毕（含尾片）正常返回；前端以 invoke 的 Promise 结束作为「流结束」信号。
#[tauri::command]
async fn stream_file_rest(
    path: String,
    offset: u64,
    chunk: usize,
    on_chunk: tauri::ipc::Channel<String>,
) -> Result<(), String> {
    // 安全：流式读取同样过路径校验，杜绝 XSS 经 IPC 读取任意绝对路径
    let norm = validate_path(&path).map_err(|e| e.to_string())?.to_string_lossy().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::{Read, Seek, SeekFrom};
        let chunk = chunk.max(64 * 1024);
        let mut f = fs::File::open(&norm).map_err(|e| e.to_string())?;
        f.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; chunk];
        let mut tail: Vec<u8> = Vec::new(); // 上一片末尾被字符边界截剩的 1~3 字节
        loop {
            let n = f.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                if !tail.is_empty() {
                    // 文件尾部残留非法 UTF-8（损坏文件）：lossy 输出兜底，不丢内容
                    on_chunk
                        .send(String::from_utf8_lossy(&tail).into_owned())
                        .map_err(|e| e.to_string())?;
                }
                break;
            }
            let mut data = if tail.is_empty() { Vec::new() } else { std::mem::take(&mut tail) };
            data.extend_from_slice(&buf[..n]);
            let end = utf8_boundary(&data);
            if end < data.len() {
                tail = data.split_off(end);
            }
            if !data.is_empty() {
                let s = String::from_utf8(data).map_err(|e| e.to_string())?;
                on_chunk.send(s).map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---- 原生文件选择器（dialog 插件）----
#[tauri::command]
fn pick_open_file(app: tauri::AppHandle) -> Option<String> {
    let fp = app
        .dialog()
        .file()
        .add_filter("Markdown", &["md", "markdown"])
        .blocking_pick_file();
    path_to_string(fp)
}

#[tauri::command]
fn pick_open_folder(app: tauri::AppHandle) -> Option<String> {
    path_to_string(app.dialog().file().blocking_pick_folder())
}

#[tauri::command]
fn pick_save_file(app: tauri::AppHandle) -> Option<String> {
    let fp = app
        .dialog()
        .file()
        .add_filter("Markdown", &["md", "markdown"])
        .blocking_save_file();
    path_to_string(fp)
}

#[tauri::command]
fn pick_save_pdf_file(app: tauri::AppHandle) -> Option<String> {
    let fp = app
        .dialog()
        .file()
        .add_filter("PDF", &["pdf"])
        .blocking_save_file();
    path_to_string(fp)
}

#[tauri::command]
fn pick_image_file(app: tauri::AppHandle) -> Option<String> {
    let fp = app
        .dialog()
        .file()
        .add_filter("图片", &["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico"])
        .blocking_pick_file();
    path_to_string(fp)
}

// ---- 读取文件夹下「一级文件夹 → 其内 .md 文件」的二级结构 ----
// 根目录散落的 .md 文件归入虚拟节点「(根目录)」，保证不遗漏。
// 微优化：用 DirEntry 自带的 file_type() 判类型（Windows 上每条目省去额外 stat 系统调用）；
// 排序用 sort_by_cached_key 预计算小写键（避免比较函数里 O(n log n) 次 to_lowercase 分配）。
fn is_md_ext(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("markdown"))
        .unwrap_or(false)
}

fn to_md_file(path: &std::path::Path) -> MdFile {
    MdFile {
        name: path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string(),
        path: path.to_string_lossy().to_string(),
    }
}

// 是否隐藏目录（以 . 开头，如 .git）：文件树不展示，避免递归出一大串无意义节点
fn is_hidden_dir(path: &std::path::Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.starts_with('.'))
        .unwrap_or(false)
}

// 递归构建文件夹节点：files 为本层直属 .md 文件，children 为子文件夹
/// 目录树递归上限：超过该深度的子目录不再展开，避免极端深目录或符号链接环导致栈溢出/长时间卡死。
const MAX_FOLDER_DEPTH: u32 = 50;

fn build_folder(path: &std::path::Path, depth: u32) -> FolderNode {
    let mut files: Vec<MdFile> = Vec::new();
    let mut children: Vec<FolderNode> = Vec::new();
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            let p = entry.path();
            // file_type() 用 DirEntry 自带元数据，免额外 stat；失败时回退 path 查询
            let is_dir = entry
                .file_type()
                .map(|t| t.is_dir())
                .unwrap_or_else(|_| p.is_dir());
            if is_dir {
                if !is_hidden_dir(&p) {
                    // 超深目录截断（仍作为空文件夹节点呈现，不递归其内容）
                    if depth < MAX_FOLDER_DEPTH {
                        children.push(build_folder(&p, depth + 1));
                    }
                }
            } else if is_md_ext(&p) {
                files.push(to_md_file(&p));
            }
        }
    }
    files.sort_by_cached_key(|a| a.name.to_lowercase());
    children.sort_by_cached_key(|a| a.name.to_lowercase());
    FolderNode {
        name: path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string(),
        path: path.to_string_lossy().to_string(),
        files,
        children,
    }
}

// 异步命令：大目录递归可达数百 ms～秒级，同步执行会阻塞 IPC 处理线程导致整个窗口冻结；
// spawn_blocking 把重活丢到独立线程池，前端 invoke 无需任何改动。
#[tauri::command]
async fn read_md_tree(root: String) -> Result<Vec<FolderNode>, String> {
    tauri::async_runtime::spawn_blocking(move || read_md_tree_sync(root))
        .await
        .map_err(|e| e.to_string())?
}

fn read_md_tree_sync(root: String) -> Result<Vec<FolderNode>, String> {
    let root = PathBuf::from(root);
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let mut folders: Vec<FolderNode> = Vec::new();
    let mut root_files: Vec<MdFile> = Vec::new();
    let entries = fs::read_dir(&root).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        let is_dir = entry
            .file_type()
            .map(|t| t.is_dir())
            .unwrap_or_else(|_| path.is_dir());
        if is_dir {
            if !is_hidden_dir(&path) {
                folders.push(build_folder(&path, 1));
            }
        } else if is_md_ext(&path) {
            root_files.push(to_md_file(&path));
        }
    }
    // 根目录散落文件作为第一个虚拟节点
    if !root_files.is_empty() {
        root_files.sort_by_cached_key(|a| a.name.to_lowercase());
        let root_name = root
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(".")
            .to_string();
        folders.insert(
            0,
            FolderNode {
                name: root_name,
                path: root.to_string_lossy().to_string(),
                files: root_files,
                children: Vec::new(),
            },
        );
    }
    folders.sort_by_cached_key(|a| a.name.to_lowercase());
    // 确保根目录虚拟节点始终在最前
    if let Some(pos) = folders.iter().position(|f| f.path == root.to_string_lossy()) {
        let node = folders.remove(pos);
        folders.insert(0, node);
    }
    Ok(folders)
}

// ---- 单级目录列举（懒加载文件树用）----
// 只返回「一个目录层」的子项，不递归；前端按需逐层展开，
// 避免大目录整树遍历卡死 / 权限错误导致整面板崩溃（旧 read_md_tree 的痛点）。
#[derive(Serialize, Clone)]
struct DirItem {
    name: String,
    path: String,
    is_dir: bool,
    is_md: bool,
    hidden: bool,
    /// 文件字节数（目录为 0）
    size: u64,
    /// 最后修改时间（UNIX 秒；读取失败为 0）
    mtime: u64,
}

#[tauri::command]
async fn list_dir(dir: String, show_hidden: bool) -> Result<Vec<DirItem>, String> {
    // 大目录列举可能达数百 ms：丢到独立线程池，避免阻塞 IPC/异步执行线程导致窗口冻结。
    tauri::async_runtime::spawn_blocking(move || {
    let dir = PathBuf::from(&dir);
    eprintln!("[list_dir] 请求路径: {:?}", dir);
    if !dir.is_dir() {
        eprintln!("[list_dir] 路径不是文件夹: {:?}", dir);
        return Err(format!("路径不是文件夹或不存在: {}", dir.to_string_lossy()));
    }
    let mut items: Vec<DirItem> = Vec::new();
    let entries = fs::read_dir(&dir)
        .map_err(|e| format!("无法读取目录 {}: {}", dir.to_string_lossy(), e))?;
    let mut total = 0;
    let mut skipped_hidden = 0;
    for entry in entries.flatten() {
        total += 1;
        let p = entry.path();
        let is_dir = entry
            .file_type()
            .map(|t| t.is_dir())
            .unwrap_or_else(|_| p.is_dir());
        let hidden = p
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.starts_with('.'))
            .unwrap_or(false);
        // 隐藏项（以 . 开头）按 show_hidden 决定；文件夹始终返回，
        // 文件全量返回（带 is_md 标志），由前端按「显示资源文件」开关决定是否展示。
        if hidden && !show_hidden {
            skipped_hidden += 1;
            continue;
        }
        let (size, mtime) = if is_dir {
            (0u64, 0u64)
        } else {
            entry
                .metadata()
                .map(|m| {
                    let sz = m.len();
                    let mt = m
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs())
                        .unwrap_or(0);
                    (sz, mt)
                })
                .unwrap_or((0, 0))
        };
        items.push(DirItem {
            name: p
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string(),
            path: p.to_string_lossy().to_string(),
            is_dir,
            is_md: !is_dir && is_md_ext(&p),
            hidden,
            size,
            mtime,
        });
    }
    // 目录在前、文件在后，各自按名称（不区分大小写）排序
    items.sort_by_cached_key(|a| (if a.is_dir { 0 } else { 1 }, a.name.to_lowercase()));
    eprintln!("[list_dir] 返回 {} 项 (总条目: {}, 隐藏跳过: {})", items.len(), total, skipped_hidden);
    Ok(items)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 在目标路径已存在时返回可用名称：`xxx(1).ext`、`xxx(2).ext`…（Windows 资源管理器风格）。
/// 与 move_path / copy_path / 新建默认名共用，保证同名冲突不再硬报错（F-03）。
fn find_unique_path(p: &Path) -> PathBuf {
    if !p.exists() {
        return p.to_path_buf();
    }
    let parent = p.parent().unwrap_or_else(|| Path::new(""));
    let stem = p
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{}", e))
        .unwrap_or_default();
    for i in 1..10000u64 {
        let candidate = parent.join(format!("{}({}){}", stem, i, ext));
        if !candidate.exists() {
            return candidate;
        }
    }
    // 极端兜底：用时间戳保证不冲突
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    parent.join(format!("{}({}){}", stem, ts, ext))
}

#[tauri::command]
fn unique_path(path: String) -> Result<String, String> {
    let p = validate_path(&path)?;
    Ok(find_unique_path(&p).to_string_lossy().to_string())
}

/// 递归搜索目录树中文件名包含 query 的项（大小写不敏感，最多 limit 条）。
/// 用于文件树过滤时搜索「未加载目录」中的匹配（FEAT-1）。
#[tauri::command]
fn search_filenames(
    root: String,
    query: String,
    show_hidden: bool,
    limit: usize,
) -> Result<Vec<String>, String> {
    let root = PathBuf::from(&root);
    if !root.is_dir() {
        return Err(format!("路径不是文件夹或不存在: {}", root.to_string_lossy()));
    }
    let q = query.to_lowercase();
    let limit = limit.max(1).min(1000);
    let mut out: Vec<String> = Vec::new();
    fn walk(dir: &Path, q: &str, show_hidden: bool, limit: usize, out: &mut Vec<String>) {
        if out.len() >= limit {
            return;
        }
        let entries = match fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            if out.len() >= limit {
                return;
            }
            let p = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let hidden = name.starts_with('.');
            if hidden && !show_hidden {
                continue;
            }
            if p.is_dir() {
                walk(&p, q, show_hidden, limit, out);
            } else if name.to_lowercase().contains(q) {
                out.push(p.to_string_lossy().to_string());
            }
        }
    }
    walk(&root, &q, show_hidden, limit, &mut out);
    Ok(out)
}

// ---- 目录监视（FEAT-2）：notify 递归监视根目录，外部变更经 "fs-change" 事件推送前端 ----
// 全局保存当前 watcher 的停止信号；重复调用 watch_dirs 会先停掉旧 watcher（幂等）。
struct WatchHandle {
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    tx: Option<std::sync::mpsc::Sender<()>>,
}
static WATCHER: Mutex<Option<WatchHandle>> = Mutex::new(None);

#[tauri::command]
fn watch_dirs(roots: Vec<String>, app: tauri::AppHandle) -> Result<(), String> {
    // 停止旧的 watcher
    if let Some(old) = WATCHER.lock().unwrap().take() {
        old.stop.store(true, std::sync::atomic::Ordering::SeqCst);
        if let Some(tx) = old.tx {
            let _ = tx.send(());
        }
    }
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    *WATCHER.lock().unwrap() = Some(WatchHandle {
        stop: stop.clone(),
        tx: Some(tx),
    });
    let app2 = app.clone();
    let watch_roots = roots.clone();
    std::thread::spawn(move || {
        let mut watcher = match notify::recommended_watcher(
            move |res: notify::Result<notify::Event>| {
                if let Ok(ev) = res {
                    let path = ev
                        .paths
                        .first()
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_default();
                    if path.is_empty() {
                        return;
                    }
                    let kind = match ev.kind {
                        notify::EventKind::Create(_) => "create",
                        notify::EventKind::Remove(_) => "remove",
                        notify::EventKind::Modify(notify::event::ModifyKind::Name(_)) => "rename",
                        notify::EventKind::Modify(_) => "modify",
                        _ => "other",
                    };
                    let _ = app2.emit(
                        "fs-change",
                        serde_json::json!({ "path": path, "kind": kind }),
                    );
                }
            },
        ) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("[watch_dirs] 监视初始化失败: {}", e);
                return;
            }
        };
        for root in &watch_roots {
            let p = std::path::Path::new(root);
            // 跳过已不存在的根（用户删除/移动后 roots 残留），不产生噪音日志；
            // 其余有效根继续监视，单个失败不影响整体。
            if !p.is_dir() {
                continue;
            }
            if let Err(e) = watcher.watch(p, notify::RecursiveMode::Recursive) {
                eprintln!("[watch_dirs] 无法监视 {}: {}", root, e);
            }
        }
        // 阻塞直到停止信号或持续运行
        while !stop.load(std::sync::atomic::Ordering::SeqCst) {
            if rx.recv_timeout(std::time::Duration::from_millis(300)).is_ok() {
                break;
            }
        }
    });
    Ok(())
}

#[tauri::command]
fn watch_stop() -> Result<(), String> {
    if let Some(old) = WATCHER.lock().unwrap().take() {
        old.stop.store(true, std::sync::atomic::Ordering::SeqCst);
        if let Some(tx) = old.tx {
            let _ = tx.send(());
        }
    }
    Ok(())
}

// ---- 新建文件 / 文件夹（文件面板管理，直接落盘到默认目录）----
/// 检查路径是否存在（用于拖拽冲突检测）
#[tauri::command]
fn path_exists(path: String) -> bool {
    PathBuf::from(&path).exists()
}

#[tauri::command]
fn create_file(path: String) -> Result<String, String> {
    // 安全：新建文件必须过路径校验，与 read/write 一致，杜绝文件名含 ../ 造成穿越
    let path = validate_path(&path)?;
    if path.exists() {
        return Err("文件已存在".to_string());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, "").map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn create_dir(path: String) -> Result<String, String> {
    // 安全：新建目录必须过路径校验，与 read/write 一致，杜绝目录名含 ../ 造成穿越
    let path = validate_path(&path)?;
    if path.exists() {
        return Err("文件夹已存在".to_string());
    }
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

// ---- 文件 / 文件夹管理：删除、移动、复制 ----
/// 危险路径守卫：拒绝删除盘符根 / 文件系统根 / 层级过浅的目录。
///
/// 触发场景并不只有「用户手滑」：路径拼接出错、符号链接指向上层、
/// 前端传来空串被 PathBuf 解析成相对根，都可能让一次删除命中整个盘。
/// 这里做最后一道硬拦截 —— 宁可误拒，不可误删。
fn guard_deletable(path: &Path) -> Result<(), String> {
    if path.parent().is_none() {
        return Err("拒绝删除：不能删除根目录".to_string());
    }
    // 规范化后统计路径组件数：Windows 下 "C:\" 只有 Prefix + RootDir 两段
    // ISSUE-002 修复：canonicalize 失败时不再降级到原始路径（可能绕过守卫），
    // 而是直接拒绝删除，宁误拒不误删。
    let canonical = path.canonicalize().map_err(|e| {
        format!("路径规范化失败，出于安全考虑拒绝操作: {}", e)
    })?;
    let normal_parts = canonical
        .components()
        .filter(|c| matches!(c, std::path::Component::Normal(_)))
        .count();
    if normal_parts == 0 {
        return Err("拒绝删除：路径层级过浅，可能是盘符根目录".to_string());
    }
    Ok(())
}

/// 删除到系统回收站（可恢复）。
///
/// M-01：原实现直接 `remove_dir_all` / `remove_file`，删一个文件夹连同全部子文件
/// 永久消失，UI 的确认框是唯一防线，一旦误点无任何补救手段。
/// 现在默认走系统回收站，用户可在资源管理器还原。
///
/// 回收站不可用时（网络盘 / 部分 U 盘 / 权限受限）返回带 `TRASH_UNAVAILABLE:` 前缀的
/// 错误，由前端识别并二次确认后，才允许调用 `delete_path_permanent` 永久删除。
#[tauri::command]
fn delete_path(path: String) -> Result<(), String> {
    let path = PathBuf::from(&path);
    if !path.exists() {
        return Err("路径不存在".to_string());
    }
    guard_deletable(&path)?;
    trash::delete(&path).map_err(|e| format!("TRASH_UNAVAILABLE:{}", e))
}

/// 永久删除（不可恢复）。仅在回收站不可用且用户二次确认后由前端调用。
#[tauri::command]
fn delete_path_permanent(path: String) -> Result<(), String> {
    let path = PathBuf::from(&path);
    if !path.exists() {
        return Err("路径不存在".to_string());
    }
    guard_deletable(&path)?;
    if path.is_dir() {
        fs::remove_dir_all(&path).map_err(|e| e.to_string())
    } else {
        fs::remove_file(&path).map_err(|e| e.to_string())
    }
}

// 递归复制文件夹
fn copy_dir_recursive(src: &std::path::Path, dest: &std::path::Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())?.flatten() {
        let s = entry.path();
        let d = dest.join(entry.file_name());
        if s.is_dir() {
            copy_dir_recursive(&s, &d)?;
        } else {
            fs::copy(&s, &d).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

// 计算目标完整路径（目标目录 + 源文件名）；目标已存在时自动去重为 xxx(1).ext（F-03）
fn resolve_dest(src: &std::path::Path, dest_dir: &str) -> Result<PathBuf, String> {
    let name = src
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "无法解析文件名".to_string())?;
    let dest = PathBuf::from(dest_dir).join(name);
    Ok(find_unique_path(&dest))
}

// 防止把文件夹移动/复制到其自身或子目录内
fn guard_not_into_self(src: &std::path::Path, dest_dir: &str) -> Result<(), String> {
    if src.is_dir() && PathBuf::from(dest_dir).starts_with(src) {
        return Err("不能放入自身或其子文件夹内".to_string());
    }
    Ok(())
}

#[tauri::command]
fn move_path(src: String, dest_dir: String) -> Result<String, String> {
    // 安全：源与目标目录均过路径校验，与 read/write 一致，杜绝 ../ 穿越
    let src = validate_path(&src)?;
    let dest_dir_s = validate_path(&dest_dir)?.to_string_lossy().to_string();
    if !src.exists() {
        return Err("源路径不存在".to_string());
    }
    guard_not_into_self(&src, &dest_dir_s)?;
    let dest = resolve_dest(&src, &dest_dir_s)?;
    // 同盘 rename 最快；跨盘符会失败，退回「复制 + 删除」。
    // 注意：copy 成功但 remove 失败会留下两份内容，必须把 dest 回滚并把错误抛给前端。
    match fs::rename(&src, &dest) {
        Ok(()) => Ok(dest.to_string_lossy().to_string()),
        Err(_) => {
            if src.is_dir() {
                copy_dir_recursive(&src, &dest)?;
                if let Err(e) = fs::remove_dir_all(&src) {
                    // ISSUE-012 修复：回滚失败时记录日志，便于排查数据不一致
                    if let Err(re) = fs::remove_dir_all(&dest) {
                        eprintln!("[move_path] 回滚失败: src={}, dest={}, 删除源失败: {}, 回滚dest失败: {}",
                            src.display(), dest.display(), e, re);
                    }
                    return Err(format!("已复制到目标，但删除源失败：{}", e));
                }
            } else {
                fs::copy(&src, &dest).map_err(|e| e.to_string())?;
                if let Err(e) = fs::remove_file(&src) {
                    if let Err(re) = fs::remove_file(&dest) {
                        eprintln!("[move_path] 回滚失败: src={}, dest={}, 删除源失败: {}, 回滚dest失败: {}",
                            src.display(), dest.display(), e, re);
                    }
                    return Err(format!("已复制到目标，但删除源失败：{}", e));
                }
            }
            Ok(dest.to_string_lossy().to_string())
        }
    }
}

#[tauri::command]
fn copy_path(src: String, dest_dir: String) -> Result<String, String> {
    // 安全：源与目标目录均过路径校验，与 read/write 一致，杜绝 ../ 穿越
    let src = validate_path(&src)?;
    let dest_dir_s = validate_path(&dest_dir)?.to_string_lossy().to_string();
    if !src.exists() {
        return Err("源路径不存在".to_string());
    }
    guard_not_into_self(&src, &dest_dir_s)?;
    let dest = resolve_dest(&src, &dest_dir_s)?;
    if src.is_dir() {
        copy_dir_recursive(&src, &dest)?;
    } else {
        fs::copy(&src, &dest).map_err(|e| e.to_string())?;
    }
    Ok(dest.to_string_lossy().to_string())
}

// 重命名文件 / 文件夹（dest 为完整目标路径，需在同目录；跨目录请用 move_path）。
// 用于文件树右键「重命名」：前端计算 父目录/新名 组成 dest 后调用。
#[tauri::command]
fn rename_path(src: String, dest: String) -> Result<(), String> {
    // 安全：重命名也过路径校验；dest 由前端「父目录/新名」拼出，需防止新名含 .. 穿越
    let src = validate_path(&src)?;
    let dest = validate_path(&dest)?;
    if !src.exists() {
        return Err("源路径不存在".to_string());
    }
    if dest.exists() {
        return Err("目标名称已存在".to_string());
    }
    fs::rename(&src, &dest).map_err(|e| e.to_string())
}

// 在系统文件管理器中定位并选中目标（文件则选中，文件夹则打开）。
// 不引入新依赖：Windows 用 explorer /select，macOS/Linux 用 open/xdg-open 打开父目录。
// 安全：先过 validate_path 防穿越/空路径；Windows 侧改用 .arg() 让 OS 负责引号转义，
// 取代原先 raw_arg 手工拼引号串（路径含特殊字符时可能绕过转义、产生参数注入）。
#[tauri::command]
fn reveal_in_explorer(path: String) -> Result<(), String> {
    let p = validate_path(&path)?;
    #[cfg(target_os = "windows")]
    {
        let mut cmd = std::process::Command::new("explorer");
        if p.is_dir() {
            // 文件夹：直接打开
            cmd.arg(&p);
        } else {
            // 文件：选中（/select, 与路径分两个参数，由 OS 安全转义）
            cmd.arg("/select,").arg(&p);
        }
        cmd.spawn()
            .map_err(|e| format!("无法打开资源管理器: {}", e))?;
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        let parent = p.parent().map(|x| x.to_path_buf()).unwrap_or_else(|| p.clone());
        std::process::Command::new("open")
            .arg(parent)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(target_os = "linux")]
    {
        let parent = p.parent().map(|x| x.to_path_buf()).unwrap_or_else(|| p.clone());
        std::process::Command::new("xdg-open")
            .arg(parent)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

// ---- 图片压缩：仅处理 JPEG/PNG，且仅在压缩后比原文件更小时才采用结果 ----
// SVG（矢量）、GIF（动画）、WebP、BMP 等保持原样，避免破坏。
fn maybe_compress(bytes: &[u8], ext: &str, quality: u8) -> Vec<u8> {
    use image::ImageEncoder;

    let lower = ext.to_lowercase();
    let is_jpeg = lower == "jpg" || lower == "jpeg";
    let is_png = lower == "png";
    if !is_jpeg && !is_png {
        return bytes.to_vec();
    }
    let img = match image::load_from_memory(bytes) {
        Ok(i) => i,
        Err(_) => return bytes.to_vec(),
    };
    let mut out: Vec<u8> = Vec::new();
    let ok = if is_jpeg {
        // JPEG 不支持透明：转 RGB 后按指定质量编码
        let rgb = img.to_rgb8();
        let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality);
        enc.write_image(rgb.as_raw(), rgb.width(), rgb.height(), image::ExtendedColorType::Rgb8)
            .is_ok()
    } else {
        // PNG 无损：保留 alpha 通道
        let rgba = img.to_rgba8();
        let enc = image::codecs::png::PngEncoder::new(&mut out);
        enc.write_image(rgba.as_raw(), rgba.width(), rgba.height(), image::ExtendedColorType::Rgba8)
            .is_ok()
    };
    if ok && !out.is_empty() && out.len() < bytes.len() {
        out
    } else {
        bytes.to_vec()
    }
}

// 以内容哈希命名并写入 assets/（已存在则跳过，天然去重）；返回相对路径
fn store_asset(
    bytes: &[u8],
    ext: &str,
    note_dir: &str,
    assets_name: &str,
    compress: bool,
    quality: u8,
) -> Result<String, String> {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::Hasher;

    let mut hasher = DefaultHasher::new();
    hasher.write(bytes);
    let hash = hasher.finish();

    let assets_dir = PathBuf::from(note_dir).join(assets_name);
    fs::create_dir_all(&assets_dir).map_err(|e| e.to_string())?;

    let filename = format!("img-{:016x}.{}", hash, ext);
    let target = assets_dir.join(&filename);
    // 目标已存在（内容相同）则跳过写入，直接复用
    if !target.exists() {
        let final_bytes = if compress {
            maybe_compress(bytes, ext, quality)
        } else {
            bytes.to_vec()
        };
        fs::write(&target, &final_bytes).map_err(|e| e.to_string())?;
    }
    Ok(format!("{}/{}", assets_name, filename))
}

// ---- 附件收编：把图片复制到笔记目录的 assets/，内容哈希命名（去重），可选压缩，返回相对路径 ----
// 异步：image crate 解码+重编码是 CPU 密集（大图可达数百 ms），不能阻塞 IPC 线程。
#[tauri::command]
async fn import_asset(
    source: String,
    note_dir: String,
    assets_name: String,
    compress: bool,
    quality: u8,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        import_asset_sync(source, note_dir, assets_name, compress, quality)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn import_asset_sync(
    source: String,
    note_dir: String,
    assets_name: String,
    compress: bool,
    quality: u8,
) -> Result<String, String> {
    let source = PathBuf::from(&source);
    if !source.is_file() {
        return Err("源文件不存在".to_string());
    }
    let ext = source
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png")
        .to_lowercase();
    let bytes = fs::read(&source).map_err(|e| e.to_string())?;
    store_asset(&bytes, &ext, &note_dir, &assets_name, compress, quality)
}

// ---- 粘贴图片收编：前端把剪贴板图片以 base64 传入，解码后写入 assets/ ----
#[tauri::command]
async fn import_asset_bytes(
    note_dir: String,
    assets_name: String,
    ext: String,
    data_b64: String,
    compress: bool,
    quality: u8,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        import_asset_bytes_sync(note_dir, assets_name, ext, data_b64, compress, quality)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn import_asset_bytes_sync(
    note_dir: String,
    assets_name: String,
    ext: String,
    data_b64: String,
    compress: bool,
    quality: u8,
) -> Result<String, String> {
    use base64::Engine;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_b64.as_bytes())
        .map_err(|e| e.to_string())?;
    let ext = ext.trim_start_matches('.').trim().to_lowercase();
    let ext = if ext.is_empty() { "png".to_string() } else { ext };
    store_asset(&bytes, &ext, &note_dir, &assets_name, compress, quality)
}

// ---- 粘贴图片收编（原始字节版）：前端把 Uint8Array 作为 InvokeBody::Raw 直传，
//      元数据走请求头；免 base64 的 +33% 体积膨胀与主线程编码成本 ----
#[tauri::command]
async fn import_asset_raw(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expect raw body".into());
    };
    let bytes = bytes.clone();
    let header = |name: &str| -> Result<String, String> {
        request
            .headers()
            .get(name)
            .ok_or_else(|| format!("missing header {}", name))?
            .to_str()
            .map(|s| s.to_string())
            .map_err(|e| e.to_string())
    };
    let note_dir = header("x-note-dir")?;
    let assets_name = header("x-assets-name")?;
    let ext = header("x-ext").unwrap_or_else(|_| "png".to_string());
    let compress = header("x-compress").map(|v| v == "1").unwrap_or(false);
    let quality = header("x-quality")
        .ok()
        .and_then(|v| v.parse::<u8>().ok())
        .unwrap_or(82);
    tauri::async_runtime::spawn_blocking(move || {
        store_asset(&bytes, &ext, &note_dir, &assets_name, compress, quality)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---- 递归列出文件夹下所有 .md 文件路径（用于整夹批量迁移）----
fn collect_md_paths(dir: &std::path::Path, out: &mut Vec<String>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            collect_md_paths(&p, out);
        } else if is_md_ext(&p) {
            out.push(p.to_string_lossy().to_string());
        }
    }
}

#[tauri::command]
async fn list_md_files(root: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || list_md_files_sync(root))
        .await
        .map_err(|e| e.to_string())?
}

fn list_md_files_sync(root: String) -> Result<Vec<String>, String> {
    let root = PathBuf::from(root);
    if !root.is_dir() {
        return Err("文件夹不存在".to_string());
    }
    let mut out = Vec::new();
    collect_md_paths(&root, &mut out);
    out.sort();
    Ok(out)
}

// ---- 跨文件查找 / 替换 ----
#[derive(Serialize, Clone)]
struct FolderMatch {
    path: String,
    line: usize,
    text: String,
}

/// 搜索结果：matches 最多 SEARCH_MAX 条，truncated 表示因上限被截断
#[derive(Serialize, Clone)]
struct FolderSearchResult {
    matches: Vec<FolderMatch>,
    truncated: bool,
}

const SEARCH_MAX: usize = 2000;

#[derive(Serialize, Clone)]
struct FolderReplaceResult {
    files_changed: usize,
    count: usize,
}

// 字节级 ASCII 大小写折叠查找（非 ASCII 字节要求精确相等，中文不受影响），
// 返回匹配起始字节下标。避免 to_lowercase 改变字节长度导致下标错位。
fn find_ci(text: &str, query: &str, from: usize) -> Option<usize> {
    let tb = text.as_bytes();
    let qb = query.as_bytes();
    if qb.is_empty() || from + qb.len() > tb.len() {
        return None;
    }
    let fold = |b: u8| if (b'A'..=b'Z').contains(&b) { b + 32 } else { b };
    let mut i = from;
    while i + qb.len() <= tb.len() {
        let mut matched = true;
        for (j, &qb_j) in qb.iter().enumerate() {
            if fold(tb[i + j]) != fold(qb_j) {
                matched = false;
                break;
            }
        }
        if matched {
            return Some(i);
        }
        i += 1;
    }
    None
}

// 字面量替换：大小写敏感走标准库；不敏感走 find_ci 逐处替换。返回 (新文本, 替换次数)。
fn replace_literal(text: &str, query: &str, replacement: &str, case_sensitive: bool) -> (String, usize) {
    if query.is_empty() {
        return (text.to_string(), 0);
    }
    if case_sensitive {
        let count = text.match_indices(query).count();
        return (text.replace(query, replacement), count);
    }
    let mut out = String::with_capacity(text.len());
    let mut count = 0usize;
    let mut pos = 0usize;
    while let Some(idx) = find_ci(text, query, pos) {
        out.push_str(&text[pos..idx]);
        out.push_str(replacement);
        pos = idx + query.len();
        count += 1;
    }
    out.push_str(&text[pos..]);
    (out, count)
}

// 异步：全量读文件+逐行扫描；大小写不敏感走 regex 字面量快速路径（memchr 加速）
#[tauri::command]
async fn search_in_folder(folder: String, query: String, case_sensitive: bool) -> Result<FolderSearchResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        search_in_folder_sync(folder, query, case_sensitive)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn search_in_folder_sync(folder: String, query: String, case_sensitive: bool) -> Result<FolderSearchResult, String> {
    if query.is_empty() {
        return Ok(FolderSearchResult { matches: Vec::new(), truncated: false });
    }
    let root = PathBuf::from(&folder);
    if !root.is_dir() {
        return Err("文件夹不存在".to_string());
    }
    // 大小写不敏感：regex ASCII 字面量模式（(?-u) 保证非 ASCII 按字节精确匹配，
    // 与旧 find_ci 的 ASCII 折叠语义完全一致），内部走 SIMD memchr 快速路径
    let ci_re = if !case_sensitive {
        match regex::Regex::new(&format!("(?-u)(?i){}", regex::escape(&query))) {
            Ok(r) => Some(r),
            Err(_) => None,
        }
    } else {
        None
    };
    let mut files = Vec::new();
    collect_md_paths(&root, &mut files);
    files.sort();
    let mut out = Vec::new();
    let mut truncated = false;
    'outer: for path in files {
        // ISSUE-005 修复：跳过超大文件（>32MB），防止 OOM
        let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        if size > 32 * 1024 * 1024 {
            continue;
        }
        let content = match fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        for (i, line) in content.lines().enumerate() {
            let hit = if case_sensitive {
                line.contains(&query)
            } else if let Some(re) = &ci_re {
                re.is_match(line)
            } else {
                find_ci(line, &query, 0).is_some()
            };
            if hit {
                out.push(FolderMatch {
                    path: path.clone(),
                    line: i + 1,
                    text: line.trim().to_string(),
                });
                if out.len() >= SEARCH_MAX {
                    truncated = true;
                    break 'outer;
                }
            }
        }
    }
    Ok(FolderSearchResult { matches: out, truncated })
}

// 异步：全量读文件+逐行替换+备份回滚，重 IO/CPU
#[tauri::command]
async fn replace_in_folder(
    folder: String,
    query: String,
    replacement: String,
    case_sensitive: bool,
) -> Result<FolderReplaceResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        replace_in_folder_sync(folder, query, replacement, case_sensitive)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn replace_in_folder_sync(
    folder: String,
    query: String,
    replacement: String,
    case_sensitive: bool,
) -> Result<FolderReplaceResult, String> {
    if query.is_empty() {
        return Ok(FolderReplaceResult { files_changed: 0, count: 0 });
    }
    let root = PathBuf::from(&folder);
    if !root.is_dir() {
        return Err("文件夹不存在".to_string());
    }
    let mut files = Vec::new();
    collect_md_paths(&root, &mut files);

    // 原子回滚：先将所有目标文件 rename 为 .bak，全部成功后统一删除 bak。
    // 任意一步失败则从 bak 恢复全部已修改的文件。
    let mut bak_paths: Vec<(PathBuf, PathBuf)> = Vec::new(); // (orig, bak)
    let mut files_changed = 0usize;
    let mut total = 0usize;

    // 大文件跳过：避免全量读入内存导致 OOM（与 search_in_folder 一致，阈值 32MB）
    const MAX_REPLACE_FILE: u64 = 32 * 1024 * 1024;
    // 第一步：创建所有 .bak
    for path in &files {
        if let Ok(m) = fs::metadata(path) {
            if m.len() > MAX_REPLACE_FILE {
                continue;
            }
        }
        let bak_path = PathBuf::from(path).with_extension("md.bak");
        if let Err(e) = fs::copy(path, &bak_path) {
            // 复制失败：删除已创建的 .bak 备份（原始文件尚未改动，无需从 bak 恢复）
            for (_orig, bak) in &bak_paths {
                let _ = fs::remove_file(bak);
            }
            return Err(format!("备份文件 {} 失败：{}", path, e));
        }
        bak_paths.push((PathBuf::from(path), bak_path));
    }

    // 第二步：执行替换
    for (orig, _bak) in &bak_paths {
        let content = match fs::read_to_string(orig) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let (new_text, count) = replace_literal(&content, &query, &replacement, case_sensitive);
        if count > 0 {
            if let Err(e) = fs::write(orig, &new_text) {
                // 写入失败：全部从 bak 恢复
                for (o, b) in &bak_paths {
                    let _ = fs::remove_file(o);
                    let _ = fs::copy(b, o);
                }
                return Err(format!("写入文件 {} 失败：{}", orig.display(), e));
            }
            files_changed += 1;
            total += count;
        }
    }

    // 第三步：全部成功，删除 bak
    for (_orig, bak) in bak_paths {
        let _ = fs::remove_file(bak);
    }

    Ok(FolderReplaceResult { files_changed, count: total })
}

// 递归收集 dir 下所有 .md 的文本内容（用于孤儿引用检测）
fn collect_md_contents(dir: &std::path::Path, out: &mut Vec<String>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            collect_md_contents(&p, out);
        } else if is_md_ext(&p) {
            if let Ok(c) = fs::read_to_string(&p) {
                out.push(c);
            }
        }
    }
}

// ---- 孤儿附件清理：递归遍历目录下每一处附件文件夹，删除未被任何 .md 引用的文件 ----
// 引用判定采用正则精确匹配 Markdown 图片语法：![alt](assets_name/file) 和 HTML <img src="assets_name/file">
// 宁可漏删不可误删。
// 返回被删文件相对 root 的路径列表。
// 返回被删文件相对 root 的路径列表。
// 异步：递归扫描+全文正则匹配，重 CPU
/// 仅扫描并返回孤儿附件相对 root 的路径（不删除），供 UI 预览。
/// 与 `cleanup_orphans_with` 共用同一份判定逻辑，确保列表与删除一致。
// ---- 从资源管理器拖入窗口：把外部文件复制到目标目录（非破坏性 copy）----
// 由前端 tauri://drag-drop 事件触发；仅在 dragDropEnabled=true 时可用（Windows 平台限制：
// 原生 OLE 拖拽处理器与 WebView 内部 HTML5 拖拽互斥，内拖已改用 Pointer Events 规避）。
#[tauri::command]
fn import_files(src_paths: Vec<String>, dest_dir: String) -> Result<Vec<String>, String> {
    let dest = validate_path(&dest_dir).map_err(|e| e.to_string())?;
    if !dest.is_dir() {
        return Err(format!("目标不是文件夹: {}", dest.to_string_lossy()));
    }
    let mut imported: Vec<String> = Vec::new();
    for src in src_paths {
        let sp = PathBuf::from(&src);
        if !sp.is_file() {
            continue; // 仅导入文件；目录拖入忽略（避免整目录递归复制的意外行为）
        }
        let name = match sp.file_name() {
            Some(n) => n.to_string_lossy().to_string(),
            None => continue,
        };
        // 同名冲突自动改名（Windows 资源管理器风格），不覆盖目标已有文件
        let target = find_unique_path(&dest.join(&name));
        fs::copy(&sp, &target).map_err(|e| format!("复制 {} 失败: {}", sp.to_string_lossy(), e))?;
        imported.push(target.to_string_lossy().replace('\\', "/"));
    }
    Ok(imported)
}

#[tauri::command]
async fn list_orphan_assets(note_dir: String, assets_name: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || scan_orphans_sync(note_dir, assets_name))
        .await
        .map_err(|e| e.to_string())?
}

/// 按给定的相对路径列表删除孤儿附件（来自 list_orphan_assets 预览）。
/// 两步流程避免「一键清理」误删正在引用的文件：UI 先列、后确认、再删。
#[tauri::command]
async fn cleanup_orphans_with(note_dir: String, assets_name: String, rel_paths: Vec<String>) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(&note_dir);
        let mut deleted: Vec<String> = Vec::new();
        for rel in rel_paths {
            // 防越界：必须落在 root 下，且确实位于一处 assets_name 文件夹内
            let candidate = root.join(&rel);
            let parent_name = candidate.parent().and_then(|p| p.file_name()).and_then(|n| n.to_str());
            if parent_name != Some(assets_name.as_str()) {
                continue;
            }
            // canonicalize 防止 ../ 等逃逸
            if let (Ok(c), Ok(r)) = (candidate.canonicalize(), root.canonicalize()) {
                if !c.starts_with(&r) {
                    continue;
                }
            } else {
                continue;
            }
            if candidate.is_file() {
                if let Err(e) = fs::remove_file(&candidate) {
                    eprintln!("[cleanup_orphans_with] 删除失败 {:?}: {}", candidate, e);
                    continue;
                }
                deleted.push(rel);
            }
        }
        Ok(deleted)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 保留旧接口以兼容旧前端：内部走「列 + 删」两步，等价于以前的直接删除语义。
/// 新代码请改用 list_orphan_assets + cleanup_orphans_with。
#[tauri::command]
async fn cleanup_orphans(note_dir: String, assets_name: String) -> Result<Vec<String>, String> {
    let candidates = list_orphan_assets(note_dir.clone(), assets_name.clone()).await?;
    cleanup_orphans_with(note_dir, assets_name, candidates).await
}

fn scan_orphans_sync(note_dir: String, assets_name: String) -> Result<Vec<String>, String> {
    let root = PathBuf::from(&note_dir);
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let mut orphans: Vec<String> = Vec::new();
    collect_orphans_recursive(&root, &root, &assets_name, &mut orphans);
    Ok(orphans)
}

// 仅收集未引用附件的相对路径（只读，绝不删除）。
// 删除动作只发生在 cleanup_orphans_with，确保「预览=列 + 确认=删」两步分离，
// 避免 list_orphan_assets 预览时静默永久删除用户文件（ISSUE 数据丢失）。
fn collect_orphans_recursive(
    root: &std::path::Path,
    dir: &std::path::Path,
    assets_name: &str,
    orphans: &mut Vec<String>,
) {
    // 当前目录下若存在附件文件夹，则以 dir 下的 .md 为引用依据收集一轮
    let assets_dir = dir.join(assets_name);
    if assets_dir.is_dir() {
        // 精确匹配文件名在 Markdown 图片引用或 HTML img src 中是否出现。
        // 模式：`assets_name/file.ext` 或 `assets_name\file.ext`，斜杠反斜杠均匹配。
        // Markdown:  ![alt](assets_name/file.ext)  — 用 r##...## 包裹含引号的正则
        // HTML:      <img src="assets_name/file.ext"> — 同上
        let assets_escaped = regex::escape(assets_name);
        let mut md_contents: Vec<String> = Vec::new();
        collect_md_contents(dir, &mut md_contents);
        let all_content = md_contents.join("\n");

        if let Ok(entries) = fs::read_dir(&assets_dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if !p.is_file() {
                    continue;
                }
                let name = match p.file_name().and_then(|n| n.to_str()) {
                    Some(n) => n.to_string(),
                    None => continue,
                };
                // 对每个文件名单独构造精确匹配正则，避免一次性对所有内容做总匹配
                let file_re_str = format!(r##"{}[/\\]{}"##, assets_escaped, regex::escape(&name));
                let truly_referenced = if let Ok(file_re) = Regex::new(&file_re_str) {
                    file_re.is_match(&all_content)
                } else {
                    // 正则构建失败（极低概率）回退到简单子串
                    let ref_slash = format!("{}/{}", assets_name, name);
                    let ref_back = format!("{}\\{}", assets_name, name);
                    all_content.contains(&ref_slash) || all_content.contains(&ref_back)
                };
                // 仅收集未引用项；删除由 cleanup_orphans_with 负责（绝对不在此处 remove_file）
                if !truly_referenced {
                    let rel = p
                        .strip_prefix(root)
                        .map(|r| r.to_string_lossy().replace('\\', "/"))
                        .unwrap_or(name);
                    orphans.push(rel);
                }
            }
        }
    }
    // 递归进入子目录（跳过附件文件夹本身）
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() && p.file_name().and_then(|n| n.to_str()) != Some(assets_name) {
                collect_orphans_recursive(root, &p, assets_name, orphans);
            }
        }
    }
}

// ---- 导出 HTML（前端已拼好完整文档，这里只负责落盘）----
#[tauri::command]
fn export_html(path: String, html: String) -> Result<(), String> {
    fs::write(path, html).map_err(|e| e.to_string())
}

// ---- 导出 PDF：pulldown-cmark 解析 → printpdf 排版（A4，自动换行/分页）----
// 文本流渲染：标题/段落/列表/引用/代码块/表格/任务列表；行内样式只保留文本。
// 中文字体从常见系统路径查找（TTF/TTC 均可，ttf-parser 支持读取 collection 第 0 个字体）。

const PAGE_W_MM: f64 = 210.0;
const PAGE_H_MM: f64 = 297.0;
const MARGIN_MM: f64 = 20.0;
const CONTENT_W_MM: f64 = PAGE_W_MM - MARGIN_MM * 2.0;

/// 系统中文字体缓存（导出是低频操作，缓存保证只查找/解析一次）。
///
/// 实现权衡：Face<'_> 必须借用底层字节，所以为了让缓存返回 'static 引用，
/// 底层数据用 `Box::leak` 永久驻留。单次进程生命周期只泄漏一份字体（10~30MB），
/// 对于长时间运行的桌面编辑器可以接受；每次 `tauri dev` 重启进程也不会累积。
///
/// 用 `Mutex<Option<…>>` 而非 `OnceLock` 是为了测试可重置（`OnceLock::take` 在
/// 1.86 才稳定，本项目 MSRV=1.77.2）。生产环境下锁只在首次加载时进入慢路径，
/// 后续热路径是无竞争的 fast path。
struct CjkFont {
    data: &'static [u8],
    face: otp::Face<'static>,
}

static FONT_CACHE: std::sync::Mutex<Option<CjkFont>> = std::sync::Mutex::new(None);

fn get_cjk_font() -> Option<&'static CjkFont> {
    // 双重检查：fast path 完全无锁（读 + 命中），slow path 拿锁再判断
    if let Some(ref f) = *FONT_CACHE.lock().unwrap_or_else(|e| e.into_inner()) {
        // 安全：Mutex 内的 Option<CjkFont> 持有 'static 借用，
        // Mutex 自身是 'static 静态项，所以可以从指针取引用并扩展到 'static。
        // 这里通过 *const 指针桥接避免借用检查器误判。
        let ptr: *const CjkFont = f as *const CjkFont;
        return Some(unsafe { &*ptr });
    }
    // 真正需要加载时再拿写锁：候选人路径遍历 + ttf-parser 解析，单进程只走一次
    let mut guard = FONT_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_none() {
        // 常见系统中文字体路径（TTF/TTC）；找不到时返回 None，PDF 导出报错提示
        let candidates = [
            r"C:\Windows\Fonts\msyh.ttc",     // 微软雅黑
            r"C:\Windows\Fonts\simhei.ttf",   // 黑体
            r"C:\Windows\Fonts\simsun.ttc",   // 宋体
            r"C:\Windows\Fonts\msyhbd.ttc",   // 微软雅黑粗体
            "/System/Library/Fonts/PingFang.ttc",
            "/System/Library/Fonts/STHeiti Light.ttc",
            "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
            "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
        ];
        for p in candidates {
            if let Ok(data) = fs::read(p) {
                // 只泄漏一次（Mutex 缓存保证），换回 'static 生命周期供 Face 借用
                let data: &'static [u8] = Box::leak(data.into_boxed_slice());
                if let Ok(face) = otp::Face::parse(data, 0) {
                    *guard = Some(CjkFont { data, face });
                    break;
                }
            }
        }
        // 候选路径全部 miss 时 guard 仍为 None，下次调用会再重试（候选可能运行时安装）。
        // 这里不缓存失败结果，让用户安装字体后立刻能生效。
    }
    let ptr: *const CjkFont = match guard.as_ref() {
        Some(f) => f as *const CjkFont,
        None => return None,
    };
    Some(unsafe { &*ptr })
}

/// 仅测试入口：清空字体缓存，便于在不同字体环境下验证重载路径。
/// 注意：原先 Box::leak 的字节不会被回收（这是设计权衡），但缓存指针会被替换，
/// 下次 `get_cjk_font` 会重新走加载流程。
#[cfg(test)]
pub(crate) fn reset_cjk_font_for_test() {
    *FONT_CACHE.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

/// 单个字符在指定字号下的宽度（pt）；无字形时按 0.5em 估算
fn char_width_mm(face: &otp::Face, c: char, size_pt: f64) -> f64 {
    let upm = face.units_per_em() as f64;
    let adv = face
        .glyph_index(c)
        .and_then(|g| face.glyph_hor_advance(g))
        .map(|a| a as f64)
        .unwrap_or(upm * 0.5);
    adv * size_pt / upm * 0.3528
}

/// 按内容宽度折行：优先在空格处断行；无合适空格则逐字符断。返回（本行文本，已消费字符数）
fn split_line(face: &otp::Face, text: &str, size_pt: f64, max_w_mm: f64) -> (String, usize) {
    let mut cur_w = 0.0f64;
    let mut chars: Vec<char> = Vec::new();
    let mut last_space: Option<usize> = None; // 空格在 chars 中的索引
    for (ci, c) in text.chars().enumerate() {
        let cw = char_width_mm(face, c, size_pt);
        if cur_w + cw > max_w_mm && !chars.is_empty() {
            if let Some(li) = last_space {
                // 空格位于行中部以后才用空格断（否则逐字断更均匀）
                if li >= chars.len() / 2 {
                    return (chars[..li].iter().collect(), li);
                }
            }
            return (chars.iter().collect(), ci);
        }
        if c == ' ' || c == '\u{3000}' {
            last_space = Some(chars.len());
        }
        chars.push(c);
        cur_w += cw;
    }
    (chars.iter().collect(), chars.len())
}

struct PdfLayout {
    doc: printpdf::PdfDocumentReference,
    font: printpdf::IndirectFontRef,
    layer: printpdf::PdfLayerReference,
    baseline: f64, // 当前文本基线（距页顶 mm）
}

impl PdfLayout {
    fn new_page(&mut self) {
        let (page_idx, layer_idx) = self
            .doc
            .add_page(Mm(PAGE_W_MM as f32), Mm(PAGE_H_MM as f32), "Layer 1");
        self.layer = self.doc.get_page(page_idx).get_layer(layer_idx);
        self.baseline = MARGIN_MM + 8.0;
    }

    /// 渲染单行（已折行），超页底自动分页
    fn render_line(&mut self, text: &str, size_pt: f64, indent_mm: f64) {
        let line_h = size_pt * 0.3528 * 1.6;
        if self.baseline > PAGE_H_MM - MARGIN_MM - 4.0 {
            self.new_page();
        }
        self.layer.use_text(
            text,
            size_pt as f32,
            Mm((MARGIN_MM + indent_mm) as f32),
            Mm(self.baseline as f32),
            &self.font,
        );
        self.baseline += line_h;
    }

    fn save(self, path: &str) -> Result<(), String> {
        let file = std::fs::File::create(path).map_err(|e| e.to_string())?;
        self.doc
            .save(&mut std::io::BufWriter::new(file))
            .map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn export_pdf(path: String, markdown: String) -> Result<(), String> {
    let font = get_cjk_font().ok_or_else(|| "未找到可用的中文字体（如微软雅黑/黑体）".to_string())?;
    let face = &font.face;
    let (doc, page_idx, layer_idx) = PdfDocument::new(
        "LiteMD 导出",
        Mm(PAGE_W_MM as f32),
        Mm(PAGE_H_MM as f32),
        "Layer 1",
    );
    let font_ref = doc.add_external_font(font.data).map_err(|e| e.to_string())?;
    let layer = doc.get_page(page_idx).get_layer(layer_idx);

    let mut lt = PdfLayout {
        doc,
        font: font_ref,
        layer,
        baseline: MARGIN_MM + 8.0,
    };

    let mut opts = Options::empty();
    opts.insert(Options::ENABLE_TABLES);
    opts.insert(Options::ENABLE_STRIKETHROUGH);
    opts.insert(Options::ENABLE_TASKLISTS);
    let events: Vec<Event> = Parser::new_ext(&markdown, opts).collect();

    // 块级状态：当前风格 + 文本缓冲（相邻 Text/Code 累积，块边界时 flush）
    enum Style {
        Body,
        Heading(u32),
        Code,
        Quote,
        ListItem(String), // 前缀如 "• " / "1. "
        Table,
        TableHead,
    }

    let mut style = Style::Body;
    let mut buf = String::new();
    let mut skip_depth = 0usize; // 图片等跳过嵌套深度

    // flush：把缓冲文本按当前风格渲染为多行。skip>0（图片内）时缓冲为空，直接返回。
    let flush = |lt: &mut PdfLayout, style: &Style, buf: &mut String, skip: usize| {
        if skip > 0 {
            return;
        }
        let (size_pt, indent, prefix, line_gap) = match style {
            Style::Body => (11.0, 0.0, "", 1),
            Style::Heading(l) => match l {
                1 => (22.0, 0.0, "", 2),
                2 => (18.0, 0.0, "", 2),
                3 => (15.0, 0.0, "", 1),
                4 => (13.0, 0.0, "", 1),
                _ => (12.0, 0.0, "", 1),
            },
            Style::Code => (9.5, 4.0, "", 0),
            Style::Quote => (11.0, 6.0, "", 0),
            Style::ListItem(p) => (11.0, 4.0, p.as_str(), 0),
            Style::Table | Style::TableHead => (10.0, 2.0, "", 0),
        };
        let is_table = matches!(style, Style::Table | Style::TableHead);
        let mut text = buf.trim_end_matches('\n').replace('\t', if is_table { "  " } else { "" });
        *buf = String::new();
        if text.is_empty() {
            if line_gap > 0 {
                lt.baseline += size_pt * 0.3528 * 1.2 * line_gap as f64;
            }
            return;
        }
        // 段落整体前加空行（标题/正文），保持块间距
        if line_gap > 0 {
            lt.baseline += size_pt * 0.3528 * 0.8;
        }
        let mut lines: Vec<String> = Vec::new();
        for raw in text.split('\n') {
            let with_prefix = if prefix.is_empty() {
                raw.to_string()
            } else {
                let mut s = prefix.to_string();
                s.push_str(raw);
                s
            };
            // 折行
            let mut rest = with_prefix.as_str();
            loop {
                let (one, consumed) = split_line(face, rest, size_pt, CONTENT_W_MM - indent);
                if consumed == 0 || consumed >= rest.chars().count() {
                    lines.push(one);
                    break;
                }
                lines.push(one);
                rest = &rest[rest.char_indices().nth(consumed).map(|(i, _)| i).unwrap_or(rest.len())..];
            }
        }
        for line in &lines {
            lt.render_line(line, size_pt, indent);
        }
        if line_gap > 0 {
            lt.baseline += size_pt * 0.3528 * 0.8;
        }
    };

    // 有序列表计数器栈：每层 List(start) 入栈对应起始编号（0 表示无序/未指定），
    // 每层 Item 出号后自增栈顶；TagEnd::List 出栈。修复嵌套有序列表沿用外层计数的问题。
    let mut ordered_stack: Vec<u64> = Vec::new();

    for ev in events {
        match ev {
            Event::Start(tag) => match tag {
                Tag::Heading { level, .. } => {
                    flush(&mut lt, &style, &mut buf, skip_depth);
                    style = Style::Heading(level as u32);
                }
                Tag::Paragraph => {
                    flush(&mut lt, &style, &mut buf, skip_depth);
                    style = Style::Body;
                }
                Tag::CodeBlock(_) => {
                    flush(&mut lt, &style, &mut buf, skip_depth);
                    style = Style::Code;
                }
                Tag::BlockQuote(_) => {
                    flush(&mut lt, &style, &mut buf, skip_depth);
                    style = Style::Quote;
                }
                Tag::List(start) => {
                    flush(&mut lt, &style, &mut buf, skip_depth);
                    // pulldown-cmark 在嵌套无序列表里也会触发 Tag::List(None)；
                    // 这里统一入栈，0 表示「无序 / 未指定编号」，由 Item 分支判定。
                    ordered_stack.push(start.unwrap_or(0));
                }
                Tag::Item => {
                    flush(&mut lt, &style, &mut buf, skip_depth);
                    // 当前层编号：栈顶 = 0（无序）或正整数（有序起点）
                    let current = ordered_stack.last().copied().unwrap_or(0);
                    let prefix = if current > 0 {
                        let p = format!("{}.", current);
                        // 自增栈顶；深层嵌套只动本层，不影响外层
                        if let Some(top) = ordered_stack.last_mut() {
                            *top += 1;
                        }
                        p
                    } else {
                        "•".to_string()
                    };
                    style = Style::ListItem(format!("{} ", prefix));
                }
                Tag::Table(_) | Tag::TableHead => {
                    flush(&mut lt, &style, &mut buf, skip_depth);
                    style = Style::Table;
                }
                Tag::TableRow => {
                    flush(&mut lt, &style, &mut buf, skip_depth);
                }
                Tag::TableCell => {
                    buf.push('\t');
                }
                Tag::Image { .. } => {
                    flush(&mut lt, &style, &mut buf, skip_depth);
                    skip_depth += 1;
                }
                Tag::HtmlBlock | Tag::FootnoteDefinition(_) => {
                    skip_depth += 1;
                }
                _ => {}
            },
            Event::End(tag) => match tag {
                TagEnd::Heading(_)
                | TagEnd::Paragraph
                | TagEnd::CodeBlock
                | TagEnd::BlockQuote(_)
                | TagEnd::Item
                | TagEnd::Table
                | TagEnd::TableHead
                | TagEnd::TableRow => {
                    flush(&mut lt, &style, &mut buf, skip_depth);
                    style = Style::Body;
                }
                TagEnd::List(_) => {
                    flush(&mut lt, &style, &mut buf, skip_depth);
                    ordered_stack.pop(); // 出栈：嵌套有序列表恢复外层计数
                }
                TagEnd::Image => {
                    if skip_depth > 0 {
                        skip_depth -= 1;
                    }
                }
                TagEnd::HtmlBlock | TagEnd::FootnoteDefinition => {
                    if skip_depth > 0 {
                        skip_depth -= 1;
                    }
                }
                _ => {}
            },
            Event::Text(t) => {
                if skip_depth == 0 {
                    buf.push_str(&t);
                }
            }
            Event::Code(t) => {
                if skip_depth == 0 {
                    buf.push_str(&t);
                }
            }
            Event::SoftBreak | Event::HardBreak => buf.push('\n'),
            Event::TaskListMarker(checked) => {
                buf.push_str(if checked { "[x] " } else { "[ ] " });
            }
            Event::Rule => {
                flush(&mut lt, &style, &mut buf, skip_depth);
                lt.render_line("────────────────────────", 10.0, 0.0);
            }
            _ => {}
        }
    }
    flush(&mut lt, &style, &mut buf, skip_depth);

    lt.save(&path)
}

// ---- 导出「自包含 Markdown」：把文档内本地图片内嵌为 base64 data URI，输出单文件 .md ----
// 类似 PDF 的资源内嵌：导出后无需附带图片文件夹，任意 Markdown 软件打开即可显示图片。
// 仅内嵌：相对/绝对路径的本地图片文件；已内嵌的 data: URI、网络(http/https)、锚点等外部
// 引用保持原样（skipped）。读取失败的文件保留原路径引用并计入 failed。

use std::collections::HashMap;

#[derive(Serialize)]
struct BundleResult {
    embedded: usize,
    failed: usize,
    skipped: usize,
}

struct BundleStats {
    embedded: usize,
    failed: usize,
    skipped: usize,
}

/// 由扩展名推断 MIME（base64 data URI 的媒体类型）
fn mime_for_ext(ext: &str) -> &'static str {
    match ext.to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "tif" | "tiff" => "image/tiff",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    }
}

/// 判断引用是否为「外部/已内嵌」引用（应原样保留，不尝试读本地文件）
fn is_external_ref(url: &str) -> bool {
    let u = url.trim();
    if u.is_empty() {
        return true;
    }
    if u.starts_with("data:")
        || u.starts_with('#')
        || u.starts_with("//")
        || u.starts_with("mailto:")
        || u.starts_with("tel:")
        || u.starts_with("http://")
        || u.starts_with("https://")
        || u.starts_with("file://")
    {
        return true;
    }
    // 判定 scheme:（协议）引用，但排除 Windows 盘符 C:/ D:\
    if let Some(colon) = u.find(':') {
        let scheme = &u[..colon];
        let is_drive = colon == 1
            && scheme
                .chars()
                .next()
                .map(|c| c.is_ascii_alphabetic())
                .unwrap_or(false)
            && (u.get(colon + 1..colon + 2) == Some("/")
                || u.get(colon + 1..colon + 2) == Some("\\"));
        if !is_drive {
            let looks_scheme = !scheme.is_empty()
                && scheme
                    .chars()
                    .next()
                    .map(|c| c.is_ascii_alphabetic())
                    .unwrap_or(false)
                && scheme
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.');
            if looks_scheme {
                return true;
            }
        }
    }
    false
}

/// 把引用解析为绝对路径（相对 base_dir 拼接；绝对路径原样），并词法归一化（消解 .. / .）。
/// 归一化后路径为空（如纯 ".." 逃逸）返回 None，调用方按失败处理。
fn resolve_image_path(ref_url: &str, base_dir: &Path) -> Option<PathBuf> {
    let u = ref_url.trim();
    let p = PathBuf::from(u);
    let abs = if p.is_absolute() {
        p
    } else {
        base_dir.join(u)
    };
    let mut norm = PathBuf::new();
    for c in abs.components() {
        match c {
            std::path::Component::ParentDir => {
                if !norm.pop() {
                    return None;
                }
            }
            std::path::Component::CurDir => {}
            other => norm.push(other.as_os_str()),
        }
    }
    if norm.as_os_str().is_empty() {
        return None;
    }
    Some(norm)
}

/// 尝试内嵌单个图片引用：本地文件存在则读字节并 base64；否则返回 None（保留原引用）。
fn embed_one(url: &str, base_dir: &Path, stats: &mut BundleStats) -> Option<String> {
    if is_external_ref(url) {
        stats.skipped += 1;
        return None;
    }
    let path = match resolve_image_path(url, base_dir) {
        Some(p) => p,
        None => {
            stats.failed += 1;
            return None;
        }
    };
    let bytes = match fs::read(&path) {
        Ok(b) => b,
        Err(_) => {
            stats.failed += 1;
            return None;
        }
    };
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let mime = mime_for_ext(&ext);
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    stats.embedded += 1;
    Some(format!("data:{};base64,{}", mime, b64))
}

/// 从 `![alt](inner)` 的 inner 中提取图片 URL（去掉可选标题与 < > 包裹）
fn extract_img_url(inner: &str) -> String {
    let s = inner.trim();
    if let Some(rest) = s.strip_prefix('<') {
        if let Some(end) = rest.find('>') {
            return rest[..end].to_string();
        }
    }
    s.split_whitespace().next().unwrap_or("").to_string()
}

/// 纯函数：把 markdown 文本中所有本地图片引用内嵌为 base64 data URI，返回新文本。
fn bundle_markdown_sync(markdown: &str, base_dir: &Path, stats: &mut BundleStats) -> String {
    let mut out = markdown.to_string();

    // 1) 收集引用式定义 [id]: url（供引用式图片解析）
    let def_re = Regex::new(r"(?m)^\[([^\]]+)\]:\s*(\S+)").unwrap();
    let mut defs: HashMap<String, String> = HashMap::new();
    for c in def_re.captures_iter(markdown) {
        let id = c[1].to_lowercase();
        let url = c[2].to_string();
        defs.entry(id).or_insert(url);
    }

    // 2) 行内图片 ![alt](url) / ![alt](url "标题") / ![alt](<url>)
    let img_re = Regex::new(r"!\[([^\]]*)\]\(([^)]*)\)").unwrap();
    out = img_re
        .replace_all(&out, |c: &regex::Captures| {
            let full = c.get(0).unwrap().as_str();
            let alt = &c[1];
            let url = extract_img_url(&c[2]);
            if let Some(data) = embed_one(&url, base_dir, stats) {
                format!("![{}]({})", alt, data)
            } else {
                full.to_string()
            }
        })
        .to_string();

    // 3) 引用式图片 ![alt][id] / ![alt][]（id 省略时取 alt 作 id）
    let refimg_re = Regex::new(r"!\[([^\]]*)\]\[([^\]]*)\]").unwrap();
    out = refimg_re
        .replace_all(&out, |c: &regex::Captures| {
            let full = c.get(0).unwrap().as_str();
            let alt = &c[1];
            let id_raw = &c[2];
            let id = if id_raw.is_empty() {
                alt.to_lowercase()
            } else {
                id_raw.to_lowercase()
            };
            let url = match defs.get(&id) {
                Some(u) => u.clone(),
                None => return full.to_string(),
            };
            if let Some(data) = embed_one(&url, base_dir, stats) {
                format!("![{}]({})", alt, data)
            } else {
                full.to_string()
            }
        })
        .to_string();

    // 4) HTML <img src="..."> / <img src='...'>
    let html_re =
        Regex::new(r#"(?i)<img\b([^>]*?)\bsrc=(["'])([^"']+)\2([^>]*)>"#).unwrap();
    out = html_re
        .replace_all(&out, |c: &regex::Captures| {
            let full = c.get(0).unwrap().as_str();
            let before = &c[1];
            let q = &c[2];
            let url = &c[3];
            let after = &c[4];
            if let Some(data) = embed_one(url, base_dir, stats) {
                format!("<img{}src={}{}{}>", before, q, data, after)
            } else {
                full.to_string()
            }
        })
        .to_string();

    out
}

#[tauri::command]
fn export_bundled_markdown(
    save_path: String,
    markdown: String,
    base_dir: String,
) -> Result<BundleResult, String> {
    let save = validate_path(&save_path)?;
    let base = PathBuf::from(&base_dir);
    let mut stats = BundleStats {
        embedded: 0,
        failed: 0,
        skipped: 0,
    };
    let bundled = bundle_markdown_sync(&markdown, &base, &mut stats);
    fs::write(&save, bundled).map_err(|e| e.to_string())?;
    Ok(BundleResult {
        embedded: stats.embedded,
        failed: stats.failed,
        skipped: stats.skipped,
    })
}

/// 导出「自包含 Markdown」的保存对话框：预填 `原名_bundled.md`
#[tauri::command]
fn pick_save_bundled_file(app: tauri::AppHandle, src_path: String) -> Option<String> {
    let stem = Path::new(&src_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("note")
        .to_string();
    let default = format!("{}_bundled.md", stem);
    let fp = app
        .dialog()
        .file()
        .add_filter("Markdown", &["md", "markdown"])
        .set_file_name(&default)
        .blocking_save_file();
    path_to_string(fp)
}

// ---- 设置持久化：<app_config_dir>/settings.json ----
// Windows: %APPDATA%\com.litemd.app\settings.json
// Linux:   ~/.config/com.litemd.app/settings.json
fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(dir.join("settings.json"))
}

#[tauri::command]
fn load_settings(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let path = settings_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    fs::read_to_string(path).map(Some).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_settings(app: tauri::AppHandle, json: String) -> Result<(), String> {
    let path = settings_path(&app)?;
    // ISSUE-004 修复：原子写入。先写临时文件，再用 rename 原子替换。
    // Rust std::fs::rename 在 Windows 上使用 MoveFileExW + MOVEFILE_REPLACE_EXISTING，
    // 可原子替换已存在文件，无需先 remove（消除中间崩溃致配置丢失的窗口）。
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &json).map_err(|e| e.to_string())?;
    match fs::rename(&tmp, &path) {
        Ok(()) => Ok(()),
        Err(_) => {
            // 兜底：某些老旧 Windows / 网络盘不支持原子替换，回退到 remove+rename
            if path.exists() {
                let _ = fs::remove_file(&path);
            }
            fs::rename(&tmp, &path).map_err(|e| e.to_string())
        }
    }
}

#[tauri::command]
fn settings_file_path(app: tauri::AppHandle) -> Result<String, String> {
    settings_path(&app).map(|p| p.to_string_lossy().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 启动参数中的 .md/.markdown 路径（文件关联 / 拖到图标打开，冷启动场景）。
    // 消费链路：Rust 端暂存缓存 → 前端启动后 take_open_files 主动拉（唯一消费入口）。
    // 热启动（已有实例在运行）由 single-instance 插件直接 emit "open-files" 事件——
    // 主实例运行中 listen 必已注册，事件可靠；**不再写入缓存**，避免残留到下次启动
    // 导致意外打开旧文件（q14 边界 bug）。
    let open_args: Vec<String> = std::env::args()
        .skip(1)
        .filter(is_md_arg)
        .collect();
    // 诊断日志：把完整 argv 与归一化后的待打开文件写到日志文件，
    // 帮助排查「双击 .md 却没打开」时 Rust 端究竟收到了什么参数。
    // 文件位置：%TEMP%\litemd-startup.log（追加，便于多次启动连续观察）。
    {
        use std::io::Write;
        let all: Vec<String> = std::env::args().collect();
        let path = std::env::temp_dir().join("litemd-startup.log");
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true).append(true).open(&path)
        {
            let _ = writeln!(f, "---- startup ----");
            let _ = writeln!(f, "argv raw: {:?}", all);
            let _ = writeln!(f, "open_args (md filtered): {:?}", open_args);
            let _ = writeln!(f, "");
        }
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(move |app, argv, _cwd| {
            // 第二个实例启动：把其中的 md 路径转发给主实例
            let paths: Vec<String> = argv
                .into_iter()
                .skip(1)
                .map(|a| normalize_md_path(&a))
                .filter(|p| {
                    let l = p.to_lowercase();
                    l.ends_with(".md") || l.ends_with(".markdown")
                })
                .collect();
            if !paths.is_empty() {
                // 先 emit「open-files」事件，前端收到后打开文件。
                // 窗口可见性由前端控制（visible:false in tauri.conf.json）：
                // - 热启动（窗口已可见）：unminimize + set_focus 提到前台
                // - 冷启动初始化中（窗口尚未 visible）：前端初始化完成后统一 show，
                //   路径暂存在 pendingOpenFiles 队列中，避免提前显示空白/欢迎页
                let _ = app.emit("open-files", paths);
                // 关键修复：热启动时**无条件**把窗口带到前台。
                // 旧逻辑只在 `is_visible()` 为 true 时才 focus——而最小化窗口在
                // Tauri 2 里 `is_visible()` 返回 false，于是「LiteMD 已开且窗口最小化
                // 时双击 .md」只会把文件加进后台标签页、却不唤出窗口，用户看到的就是
                // 「双击打不开文档」。unminimize/show/set_focus 对「已可见/未最小化」
                // 的窗口都是幂等无副作用，故直接无条件执行。
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.unminimize();
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
        }))
        .manage(OpenFiles(Mutex::new(open_args.clone())))
        .setup(move |app| {
            // 修复：decorations:false 时 Windows 创建 13x13 像素的 popup 窗口，
            // 需要显式设置窗口大小并居中。
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_size(tauri::LogicalSize::new(1280.0, 800.0));
                let _ = w.center();
            }
            // 冷启动文件关联修复：invoke("take_open_files") 在 WebView2 冷启动时
            // 可能因 IPC 未就绪而全部失败。这里延迟 600ms emit "open-files" 事件，
            // 确保前端 listen 已注册后可靠送达。前端 pendingOpenFiles 队列会暂存
            // 并在初始化完成后处理。
            if !open_args.is_empty() {
                let app_handle = app.handle().clone();
                let files = open_args.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(600));
                    let _ = app_handle.emit("open-files", files);
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            file_size,
            read_file_head,
            stream_file_rest,
            pick_open_file,
            pick_open_folder,
            pick_save_file,
            pick_save_pdf_file,
            pick_image_file,
            read_md_tree,
            list_dir,
            unique_path,
            search_filenames,
            watch_dirs,
            watch_stop,
            rename_path,
            reveal_in_explorer,
            log_frontend,
            path_exists,
            create_file,
            create_dir,
            delete_path,
            delete_path_permanent,
            move_path,
            copy_path,
            import_asset,
            import_asset_bytes,
            import_asset_raw,
            list_md_files,
            search_in_folder,
            replace_in_folder,
            cleanup_orphans,
            cleanup_orphans_with,
            list_orphan_assets,
            import_files,
            export_html,
            export_pdf,
            export_bundled_markdown,
            pick_save_bundled_file,
            load_settings,
            save_settings,
            settings_file_path,
            take_open_files,
            ack_open_files,
            open_external,
        ])
        .run(tauri::generate_context!())
        .expect("error while running LiteMD");
}

/// 归一化文件关联 / 命令行传入的路径：去首尾引号、去 file:// 前缀、trim。
/// Windows 文件关联注册表命令（"$EXE" "%1"）会把含空格路径用引号包裹，
/// 而某些环境下路径可能以 file:// 形式传入——这些都可能导致 ends_with(".md") 误判，
/// 进而「双击 md 打开后停在首页」。统一归一化后再判定扩展名。
fn normalize_md_path(a: &str) -> String {
    let mut s = a.trim().to_string();
    // 去首尾引号（"C:\a.md" 或 'C:\a.md'）
    if s.len() >= 2 {
        let first = s.chars().next().unwrap();
        let last = s.chars().last().unwrap();
        if (first == '"' && last == '"') || (first == '\'' && last == '\'') {
            s = s[1..s.len() - 1].to_string();
        }
    }
    // 去 file:// / file:/// / file:/ 前缀
    for prefix in ["file:///", "file://", "file:/"] {
        if let Some(stripped) = s.strip_prefix(prefix) {
            s = stripped.to_string();
            break;
        }
    }
    s
}

/// 判断命令行参数是否为待打开的 Markdown 文档路径（已归一化）
fn is_md_arg(a: &String) -> bool {
    let l = normalize_md_path(a).to_lowercase();
    l.ends_with(".md") || l.ends_with(".markdown")
}

/// 读取当前所有待打开文档路径（**不清空缓存**）。
///
/// 设计要点：早期实现用 `std::mem::take`「一次消费」语义，导致**多次调用**或前端
/// 启动 race（HMR、Slow webview ready、Vite 慢启动）时丢失 argv——表现为
/// 「双击 .md 却没打开」（欢迎页）。改成「只读不删」，并配套一个独立的
/// `ack_open_files` 让前端在确认收到并使用完后显式清空缓存，避免下次冷启动残留。
///
/// 缓存**只**含 cold-start argv（热启动 single-instance 路径走 emit，不写入这里），
/// 所以多次调用同一份 argv 不会引发重放。
#[tauri::command]
fn take_open_files(state: tauri::State<'_, OpenFiles>) -> Vec<String> {
    let v: Vec<String> = state
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .map(|a| normalize_md_path(a))
        .filter(|p| {
            let l = p.to_lowercase();
            l.ends_with(".md") || l.ends_with(".markdown")
        })
        .collect();
    // 诊断：每次调用都写到启动日志，便于确认前端到底调了几次、拿到什么。
    {
        use std::io::Write;
        let path = std::env::temp_dir().join("litemd-startup.log");
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true).append(true).open(&path)
        {
            let _ = writeln!(f, "[take_open_files] returned {} path(s): {:?}", v.len(), v);
        }
    }
    v
}

/// 确认消费缓存并清空。前端在 `take_open_files` 拿到路径并完成处理（已加入 tabs
/// / 写入会话）后调用。**冷启动 argv 只在这次被清空**，避免下次启动时残留到
/// 上次会话中。
///
/// 设计取舍：理论上不清空也能容忍——因为缓存里只有 cold-start argv，下次启动
/// 会被新的 argv 覆盖。但显式 ack 让缓存语义清晰、可测、可调试。
#[tauri::command]
fn ack_open_files(state: tauri::State<'_, OpenFiles>) {
    state.0.lock().unwrap_or_else(|e| e.into_inner()).clear();
}

#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    // 仅允许常见外部协议，防止被用于打开本地可执行文件或内部资源。
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("unsupported URL scheme".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/c", "start", "", &url])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 启动参数暂存（仅冷启动路径使用；热启动路径走 emit 事件，不经过这里）
struct OpenFiles(Mutex<Vec<String>>);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unique_path_generates_sequential_suffix() {
        let dir = std::env::temp_dir().join("litemd-uniq-test");
        let _ = fs::create_dir_all(&dir);
        let p = dir.join("a.md");
        let _ = fs::write(&p, "x");
        let u1 = find_unique_path(&p);
        assert_eq!(u1.file_name().unwrap().to_str().unwrap(), "a(1).md");
        let _ = fs::write(&u1, "x");
        let u2 = find_unique_path(&p);
        assert_eq!(u2.file_name().unwrap().to_str().unwrap(), "a(2).md");
        // 不存在的路径原样返回
        let fresh = dir.join("fresh.md");
        assert_eq!(find_unique_path(&fresh), fresh);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_filenames_finds_matches_and_skips_hidden() {
        let dir = std::env::temp_dir().join("litemd-search-test");
        let _ = fs::create_dir_all(dir.join("sub"));
        let _ = fs::write(dir.join("hello.md"), "x");
        let _ = fs::write(dir.join("sub").join("world.md"), "x");
        let _ = fs::write(dir.join("sub").join("hello.txt"), "x");
        // 大小写不敏感
        let hits = search_filenames(dir.to_string_lossy().to_string(), "HELLO".into(), false, 100).unwrap();
        assert_eq!(hits.len(), 2);
        // 隐藏目录跳过
        let _ = fs::create_dir_all(dir.join(".git"));
        let _ = fs::write(dir.join(".git").join("hello2.md"), "x");
        let hits2 = search_filenames(dir.to_string_lossy().to_string(), "hello2".into(), false, 100).unwrap();
        assert_eq!(hits2.len(), 0);
        // show_hidden=true 时能搜到
        let hits3 = search_filenames(dir.to_string_lossy().to_string(), "hello2".into(), true, 100).unwrap();
        assert_eq!(hits3.len(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_dir_returns_non_md_with_metadata() {
        let dir = std::env::temp_dir().join("litemd-list-test");
        let _ = fs::create_dir_all(&dir);
        let _ = fs::write(dir.join("a.md"), "hello");
        let _ = fs::write(dir.join("b.png"), "img");
        let items = tauri::async_runtime::block_on(list_dir(dir.to_string_lossy().to_string(), false)).unwrap();
        assert_eq!(items.len(), 2);
        let png = items.iter().find(|i| i.name == "b.png").unwrap();
        assert!(!png.is_md);
        assert_eq!(png.size, 3);
        assert!(png.mtime > 0);
        let md = items.iter().find(|i| i.name == "a.md").unwrap();
        assert!(md.is_md);
        assert_eq!(md.size, 5);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn import_files_copies_into_dest_and_renames_collision() {
        let dir = std::env::temp_dir().join("litemd-import-test");
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::create_dir_all(&dir);
        let src = dir.join("src");
        let _ = fs::create_dir_all(&src);
        let _ = fs::write(src.join("note.md"), "content");
        let existing = dir.join("note.md");
        let _ = fs::write(&existing, "keep");

        let imported = import_files(
            vec![src.join("note.md").to_string_lossy().to_string()],
            dir.to_string_lossy().to_string(),
        )
        .unwrap();
        assert_eq!(imported.len(), 1);
        // 目标已存在同名 → 自动改名，不覆盖原文件
        let imported_path = std::path::Path::new(&imported[0]);
        assert_ne!(imported_path, existing.as_path());
        assert!(imported_path.exists());
        // 原文件内容保持不变
        assert_eq!(fs::read_to_string(&existing).unwrap(), "keep");
        // 目录不会被复制（仅文件）
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn validate_path_rejects_empty_and_whitespace() {
        assert!(validate_path("").is_err());
        assert!(validate_path("   ").is_err());
    }

    #[test]
    fn validate_path_normalizes_parent_dir() {
        let p = validate_path("C:/Users/me/../other/note.md").unwrap();
        assert_eq!(p.to_string_lossy().replace('\\', "/"), "C:/Users/other/note.md");
    }

    #[test]
    fn validate_path_rejects_escape_above_root() {
        assert!(validate_path("C:/../windows/secret.txt").is_err());
    }

    #[test]
    fn collect_orphans_does_not_delete_files() {
        // 回归：list_orphan_assets 预览扫描绝对不能删除任何文件（数据丢失防护）
        let base = std::env::temp_dir().join(format!("litemd_orphan_test_{}", std::process::id()));
        let _ = std::fs::create_dir_all(base.join("assets"));
        std::fs::write(base.join("note.md"), "![](assets/used.png)").unwrap();
        std::fs::write(base.join("assets/used.png"), "u").unwrap();
        std::fs::write(base.join("assets/orphan.png"), "o").unwrap();

        let mut orphans = Vec::new();
        collect_orphans_recursive(&base, &base, "assets", &mut orphans);

        // 预览扫描后，未引用与已引用的附件都必须仍在磁盘上
        assert!(
            base.join("assets/orphan.png").is_file(),
            "预览扫描误删了未引用附件"
        );
        assert!(base.join("assets/used.png").is_file());
        // 仅未引用项被收集
        assert_eq!(orphans, vec!["assets/orphan.png".to_string()]);

        let _ = std::fs::remove_dir_all(&base);
    }
}
