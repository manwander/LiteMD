#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::PathBuf;
use serde::Serialize;
use tauri::Manager;
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

// ---- 文件读写 ----
#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    fs::read_to_string(path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    fs::write(path, content).map_err(|e| e.to_string())
}

// ---- 大文档分片流式载入（P0）----
// 一次性 read_file 50MB 会产生单次 600~1200ms 的 IPC 长任务 + 与 rope 同时在世的
// 50MB 字符串副本。改为：头片（read_file_head）先让编辑器出字，剩余部分经 Channel
// 分片推送，前端在空闲帧逐片 append，任何一帧都不超预算。

#[tauri::command]
fn file_size(path: String) -> Result<u64, String> {
    fs::metadata(path).map(|m| m.len()).map_err(|e| e.to_string())
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
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Read;
        let mut f = fs::File::open(&path).map_err(|e| e.to_string())?;
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
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::{Read, Seek, SeekFrom};
        let chunk = chunk.max(64 * 1024);
        let mut f = fs::File::open(&path).map_err(|e| e.to_string())?;
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
fn build_folder(path: &std::path::Path) -> FolderNode {
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
                    children.push(build_folder(&p));
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
                folders.push(build_folder(&path));
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

// ---- 新建文件 / 文件夹（文件面板管理，直接落盘到默认目录）----
#[tauri::command]
fn create_file(path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    if path.exists() {
        return Err("文件已存在".to_string());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, "").map_err(|e| e.to_string())
}

#[tauri::command]
fn create_dir(path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    if path.exists() {
        return Err("文件夹已存在".to_string());
    }
    fs::create_dir_all(&path).map_err(|e| e.to_string())
}

// ---- 文件 / 文件夹管理：删除、移动、复制 ----
#[tauri::command]
fn delete_path(path: String) -> Result<(), String> {
    let path = PathBuf::from(&path);
    if path.is_dir() {
        fs::remove_dir_all(&path).map_err(|e| e.to_string())
    } else if path.is_file() {
        fs::remove_file(&path).map_err(|e| e.to_string())
    } else {
        Err("路径不存在".to_string())
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

// 计算目标完整路径（目标目录 + 源文件名）；目标已存在则报错
fn resolve_dest(src: &std::path::Path, dest_dir: &str) -> Result<PathBuf, String> {
    let name = src
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "无法解析文件名".to_string())?;
    let dest = PathBuf::from(dest_dir).join(name);
    if dest.exists() {
        return Err("目标位置已存在同名项".to_string());
    }
    Ok(dest)
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
    let src = PathBuf::from(&src);
    if !src.exists() {
        return Err("源路径不存在".to_string());
    }
    guard_not_into_self(&src, &dest_dir)?;
    let dest = resolve_dest(&src, &dest_dir)?;
    // 同盘 rename 最快；跨盘符会失败，退回「复制 + 删除」
    match fs::rename(&src, &dest) {
        Ok(()) => Ok(dest.to_string_lossy().to_string()),
        Err(_) => {
            if src.is_dir() {
                copy_dir_recursive(&src, &dest)?;
                fs::remove_dir_all(&src).map_err(|e| e.to_string())?;
            } else {
                fs::copy(&src, &dest).map_err(|e| e.to_string())?;
                fs::remove_file(&src).map_err(|e| e.to_string())?;
            }
            Ok(dest.to_string_lossy().to_string())
        }
    }
}

#[tauri::command]
fn copy_path(src: String, dest_dir: String) -> Result<String, String> {
    let src = PathBuf::from(&src);
    if !src.exists() {
        return Err("源路径不存在".to_string());
    }
    guard_not_into_self(&src, &dest_dir)?;
    let dest = resolve_dest(&src, &dest_dir)?;
    if src.is_dir() {
        copy_dir_recursive(&src, &dest)?;
    } else {
        fs::copy(&src, &dest).map_err(|e| e.to_string())?;
    }
    Ok(dest.to_string_lossy().to_string())
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

    // 第一步：创建所有 .bak
    for path in &files {
        let bak_path = PathBuf::from(path).with_extension("md.bak");
        if let Err(e) = fs::copy(path, &bak_path) {
            // 复制失败：回滚已创建的 bak
            for (orig, bak) in &bak_paths {
                let _ = fs::remove_file(bak);
                let _ = fs::copy(orig, bak); // 忽略二次错误
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
#[tauri::command]
async fn cleanup_orphans(note_dir: String, assets_name: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || cleanup_orphans_sync(note_dir, assets_name))
        .await
        .map_err(|e| e.to_string())?
}

fn cleanup_orphans_sync(note_dir: String, assets_name: String) -> Result<Vec<String>, String> {
    let root = PathBuf::from(&note_dir);
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let mut deleted: Vec<String> = Vec::new();
    cleanup_dir_recursive(&root, &root, &assets_name, &mut deleted);
    Ok(deleted)
}

fn cleanup_dir_recursive(
    root: &std::path::Path,
    dir: &std::path::Path,
    assets_name: &str,
    deleted: &mut Vec<String>,
) {
    // 当前目录下若存在附件文件夹，则以 dir 下的 .md 为引用依据清理一轮
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
                // 对每个文件名单独构造精确匹配正则
                let truly_referenced = if let Ok(file_re) = Regex::new(&file_re_str) {
                    file_re.is_match(&all_content)
                } else {
                    // 正则构建失败（极低概率）回退到简单子串
                    let ref_slash = format!("{}/{}", assets_name, name);
                    let ref_back = format!("{}\\{}", assets_name, name);
                    all_content.contains(&ref_slash) || all_content.contains(&ref_back)
                };
                if !truly_referenced && fs::remove_file(&p).is_ok() {
                    let rel = p
                        .strip_prefix(root)
                        .map(|r| r.to_string_lossy().replace('\\', "/"))
                        .unwrap_or(name);
                    deleted.push(rel);
                }
            }
        }
    }
    // 递归进入子目录（跳过附件文件夹本身）
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() && p.file_name().and_then(|n| n.to_str()) != Some(assets_name) {
                cleanup_dir_recursive(root, &p, assets_name, deleted);
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

/// 系统中文字体缓存（导出是低频操作，OnceLock 保证只查找/解析一次）
struct CjkFont {
    data: &'static [u8],
    face: otp::Face<'static>,
}

static FONT_CACHE: std::sync::OnceLock<Option<CjkFont>> = std::sync::OnceLock::new();

fn get_cjk_font() -> Option<&'static CjkFont> {
    FONT_CACHE.get_or_init(|| {
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
                // 只泄漏一次（OnceLock 保证），换回 'static 生命周期供 Face 借用
                let data: &'static [u8] = Box::leak(data.into_boxed_slice());
                if let Ok(face) = otp::Face::parse(data, 0) {
                    return Some(CjkFont { data, face });
                }
            }
        }
        None
    })
    .as_ref()
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

    let mut ordered_n: u64 = 1;

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
                    ordered_n = start.unwrap_or(0);
                }
                Tag::Item => {
                    flush(&mut lt, &style, &mut buf, skip_depth);
                    let prefix = if ordered_n > 0 {
                        let p = format!("{}.", ordered_n);
                        ordered_n += 1;
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
    // 先写临时文件，再用 rename 原子替换，避免写一半崩溃导致配置损坏。
    // Windows 上 rename 不覆盖已存在目标，先移除旧文件再改名。
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json).map_err(|e| e.to_string())?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[tauri::command]
fn settings_file_path(app: tauri::AppHandle) -> Result<String, String> {
    settings_path(&app).map(|p| p.to_string_lossy().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
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
            create_file,
            create_dir,
            delete_path,
            move_path,
            copy_path,
            import_asset,
            import_asset_bytes,
            import_asset_raw,
            list_md_files,
            search_in_folder,
            replace_in_folder,
            cleanup_orphans,
            export_html,
            export_pdf,
            load_settings,
            save_settings,
            settings_file_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running LiteMD");
}
