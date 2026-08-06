// 与 src-tauri/src/lib.rs 中的 Tauri command 一一对应。
// invoke 的参数名（path / content / root / html）必须与 Rust 命令形参一致。
import { invoke, Channel } from "@tauri-apps/api/core";

export interface MdFile {
  name: string;
  path: string;
}

export interface FolderNode {
  name: string;
  path: string;
  files: MdFile[];
  children: FolderNode[];
}

export const readFile = (path: string) => invoke<string>("read_file", { path });

export const writeFile = (path: string, content: string) =>
  invoke<void>("write_file", { path, content });

/** 文件字节数（O(1) stat）；大文档判定走流式载入用 */
export const fileSize = (path: string) => invoke<number>("file_size", { path });

/** 分片流式载入头片：head 按 UTF-8 字符边界对齐；headBytes 供续读偏移 */
export interface ReadHead {
  head: string;
  headBytes: number;
  total: number;
}
export const readFileHead = (path: string, bytes: number) =>
  invoke<ReadHead>("read_file_head", { path, bytes });

/** 从 offset 字节起分片推送剩余内容；Promise resolve = 流结束 */
export const streamFileRest = (
  path: string,
  offset: number,
  chunk: number,
  onChunk: Channel<string>
) => invoke<void>("stream_file_rest", { path, offset, chunk, onChunk });

export const pickOpenFile = () => invoke<string | null>("pick_open_file");

export const pickOpenFolder = () => invoke<string | null>("pick_open_folder");

export const pickSaveFile = () => invoke<string | null>("pick_save_file");

/** 导出 PDF 时选择保存路径（带 .pdf 过滤器） */
export const pickSavePdfFile = () => invoke<string | null>("pick_save_pdf_file");

export const pickImageFile = () => invoke<string | null>("pick_image_file");

export const readMdTree = (root: string) =>
  invoke<FolderNode[]>("read_md_tree", { root });

/** 新建文件（空 .md，直接落盘到默认目录） */
export const createFile = (path: string) => invoke<void>("create_file", { path });

/** 新建文件夹（直接落盘到默认目录） */
export const createDir = (path: string) => invoke<void>("create_dir", { path });

/** 删除文件或文件夹（文件夹递归删除） */
export const deletePath = (path: string) => invoke<void>("delete_path", { path });

/** 移动文件/文件夹到目标目录，返回新路径 */
export const movePath = (src: string, destDir: string) =>
  invoke<string>("move_path", { src, destDir });

/** 复制文件/文件夹到目标目录，返回新路径 */
export const copyPath = (src: string, destDir: string) =>
  invoke<string>("copy_path", { src, destDir });

/** 把图片收编到笔记目录的附件文件夹，返回相对路径（如 assets/img-xxx.png）；compress 开启时仅 JPEG/PNG 且压缩后更小才采用 */
export const importAsset = (
  source: string,
  noteDir: string,
  assetsName: string,
  compress: boolean,
  quality: number
) => invoke<string>("import_asset", { source, noteDir, assetsName, compress, quality });

/** 粘贴图片收编：剪贴板图片以 base64 传入，解码后写入附件文件夹 */
export const importAssetBytes = (
  noteDir: string,
  assetsName: string,
  ext: string,
  dataB64: string,
  compress: boolean,
  quality: number
) => invoke<string>("import_asset_bytes", { noteDir, assetsName, ext, dataB64, compress, quality });

/** 粘贴图片收编（原始字节版）：Uint8Array 作为 InvokeBody::Raw 直传（零 base64），
 *  元数据走请求头；返回相对路径。旧运行时不支持 raw body 时调用方回退 importAssetBytes */
export const importAssetRaw = (
  noteDir: string,
  assetsName: string,
  ext: string,
  bytes: Uint8Array,
  compress: boolean,
  quality: number
) =>
  invoke<string>("import_asset_raw", bytes, {
    headers: {
      "x-note-dir": noteDir,
      "x-assets-name": assetsName,
      "x-ext": ext,
      "x-compress": compress ? "1" : "0",
      "x-quality": String(quality),
    },
  });

/** 递归列出文件夹下所有 .md 文件路径（整夹批量迁移用） */
export const listMdFiles = (root: string) => invoke<string[]>("list_md_files", { root });

/** 跨文件查找的单条匹配结果 */
export interface FolderMatch {
  path: string;
  line: number;
  text: string;
}

/** 跨文件查找结果：matches 最多 2000 条，truncated 表示因上限被截断 */
export interface FolderSearchResult {
  matches: FolderMatch[];
  truncated: boolean;
}

/** 跨文件替换的汇总结果 */
export interface FolderReplaceResult {
  filesChanged: number;
  count: number;
}

/** 在当前文件夹下所有 .md 中查找（字面子串，可选大小写敏感；结果上限 2000 条） */
export const searchInFolder = (folder: string, query: string, caseSensitive: boolean) =>
  invoke<FolderSearchResult>("search_in_folder", { folder, query, caseSensitive });

/** 在当前文件夹下所有 .md 中批量替换，返回受影响文件数与替换总次数 */
export const replaceInFolder = (
  folder: string,
  query: string,
  replacement: string,
  caseSensitive: boolean
) => invoke<FolderReplaceResult>("replace_in_folder", { folder, query, replacement, caseSensitive });

/**
 * 仅扫描并返回孤儿附件相对路径（不删除），供 UI 预览。
 * 与 cleanupOrphansWith 共用同一份判定逻辑，结果一致。
 */
export const listOrphanAssets = (noteDir: string, assetsName: string) =>
  invoke<string[]>("list_orphan_assets", { noteDir, assetsName });

/**
 * 按给定相对路径列表删除孤儿附件（来自 listOrphanAssets 预览）。
 * 两步流程：UI 先预览、后确认、再删除，避免误删正在引用的文件。
 */
export const cleanupOrphansWith = (
  noteDir: string,
  assetsName: string,
  relPaths: string[]
) => invoke<string[]>("cleanup_orphans_with", { noteDir, assetsName, relPaths });

/** 旧接口保留兼容：内部走 list + cleanup 两步 */
export const cleanupOrphans = (noteDir: string, assetsName: string) =>
  invoke<string[]>("cleanup_orphans", { noteDir, assetsName });

export const exportHtml = (path: string, html: string) =>
  invoke<void>("export_html", { path, html });

/** 导出 PDF：Rust 侧用 pulldown-cmark + printpdf 渲染（A4、自动换行/分页、中文字体） */
export const exportPdf = (path: string, markdown: string) =>
  invoke<void>("export_pdf", { path, markdown });

/** 设置文件所在路径（仅用于设置面板展示）；非 Tauri 环境返回空串 */
export const settingsFilePath = async (): Promise<string> => {
  try {
    return await invoke<string>("settings_file_path");
  } catch {
    return "";
  }
};
