#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::PathBuf;
use serde::Serialize;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

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
fn is_md(path: &std::path::Path) -> bool {
    path.is_file()
        && path
            .extension()
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
            if p.is_dir() {
                if !is_hidden_dir(&p) {
                    children.push(build_folder(&p));
                }
            } else if is_md(&p) {
                files.push(to_md_file(&p));
            }
        }
    }
    files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    children.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
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

#[tauri::command]
fn read_md_tree(root: String) -> Result<Vec<FolderNode>, String> {
    let root = PathBuf::from(root);
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let mut folders: Vec<FolderNode> = Vec::new();
    let mut root_files: Vec<MdFile> = Vec::new();
    let entries = fs::read_dir(&root).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if !is_hidden_dir(&path) {
                folders.push(build_folder(&path));
            }
        } else if is_md(&path) {
            root_files.push(to_md_file(&path));
        }
    }
    // 根目录散落文件作为第一个虚拟节点
    if !root_files.is_empty() {
        root_files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
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
    folders.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
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
#[tauri::command]
fn import_asset(
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
fn import_asset_bytes(
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
        } else if is_md(&p) {
            out.push(p.to_string_lossy().to_string());
        }
    }
}

#[tauri::command]
fn list_md_files(root: String) -> Result<Vec<String>, String> {
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

#[tauri::command]
fn search_in_folder(folder: String, query: String, case_sensitive: bool) -> Result<Vec<FolderMatch>, String> {
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let root = PathBuf::from(&folder);
    if !root.is_dir() {
        return Err("文件夹不存在".to_string());
    }
    let mut files = Vec::new();
    collect_md_paths(&root, &mut files);
    files.sort();
    let mut out = Vec::new();
    for path in files {
        let content = match fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        for (i, line) in content.lines().enumerate() {
            let hit = if case_sensitive {
                line.contains(&query)
            } else {
                find_ci(line, &query, 0).is_some()
            };
            if hit {
                out.push(FolderMatch {
                    path: path.clone(),
                    line: i + 1,
                    text: line.trim().to_string(),
                });
            }
        }
    }
    Ok(out)
}

#[tauri::command]
fn replace_in_folder(
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
    let mut files_changed = 0usize;
    let mut total = 0usize;
    for path in files {
        let content = match fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let (new_text, count) = replace_literal(&content, &query, &replacement, case_sensitive);
        if count > 0 {
            fs::write(&path, new_text).map_err(|e| e.to_string())?;
            files_changed += 1;
            total += count;
        }
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
        } else if is_md(&p) {
            if let Ok(c) = fs::read_to_string(&p) {
                out.push(c);
            }
        }
    }
}

// ---- 孤儿附件清理：递归遍历目录下每一处附件文件夹，删除未被任何 .md 引用的文件 ----
// 引用判定采用子串包含（出现 assets_name/文件名 即视为被引用），宁可漏删不可误删。
// 返回被删文件相对 root 的路径列表。
#[tauri::command]
fn cleanup_orphans(note_dir: String, assets_name: String) -> Result<Vec<String>, String> {
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
        let mut md_contents: Vec<String> = Vec::new();
        collect_md_contents(dir, &mut md_contents);
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
                let ref_slash = format!("{}/{}", assets_name, name);
                let ref_back = format!("{}\\{}", assets_name, name);
                let referenced = md_contents
                    .iter()
                    .any(|c| c.contains(&ref_slash) || c.contains(&ref_back));
                if !referenced && fs::remove_file(&p).is_ok() {
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
            pick_open_file,
            pick_open_folder,
            pick_save_file,
            pick_image_file,
            read_md_tree,
            create_file,
            create_dir,
            delete_path,
            move_path,
            copy_path,
            import_asset,
            import_asset_bytes,
            list_md_files,
            search_in_folder,
            replace_in_folder,
            cleanup_orphans,
            export_html,
            load_settings,
            save_settings,
            settings_file_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running LiteMD");
}
