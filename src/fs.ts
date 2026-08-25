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
  /** 懒加载标记：true=子项已列举；false/undefined=未加载（展开时才 list_dir） */
  loaded?: boolean;
}

/** 单级目录列举的返回项（list_dir 命令） */
export interface DirItem {
  name: string;
  path: string;
  is_dir: boolean;
  is_md: boolean;
  hidden: boolean;
  /** 文件字节数（目录为 0） */
  size: number;
  /** 最后修改时间（UNIX 秒；读取失败为 0） */
  mtime: number;
}

export const readFile = (path: string) => invoke<string>("read_file", { path });

/** 写一行前端崩溃日志到 %TEMP%/litemd-frontend.log（仅未捕获异常时调用） */
export const logFrontend = (line: string) => invoke("log_frontend", { line });

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

/** 单级目录列举（懒加载文件树用）：只返回 dir 这一层的子项，不递归 */
export const listDir = (dir: string, showHidden: boolean) =>
  invoke<DirItem[]>("list_dir", { dir, showHidden });

/** 目标路径已存在时返回可用名（如 xxx(1).md）；不存在则原样返回。新建默认名预填用（F-03） */
export const uniquePath = (path: string) => invoke<string>("unique_path", { path });

/** 递归搜索目录树中文件名包含 query 的项（大小写不敏感，上限 limit 条）。文件树过滤未加载层用（F-01） */
export const searchFilenames = (root: string, query: string, showHidden: boolean, limit: number) =>
  invoke<string[]>("search_filenames", { root, query, showHidden, limit });

/** 启动目录监视（notify 递归监视 roots；重复调用会替换旧 watcher）。返回是否成功。 */
export const watchDirs = (roots: string[]) => invoke<void>("watch_dirs", { roots });

/** 停止目录监视 */
export const watchStop = () => invoke<void>("watch_stop");

/** 重命名文件/文件夹：dest 为完整目标路径（通常位于同目录、仅改末段名称） */
export const renamePath = (src: string, dest: string) =>
  invoke<void>("rename_path", { src, dest });

/** 在系统文件管理器中定位并选中目标路径 */
export const revealInExplorer = (path: string) =>
  invoke<void>("reveal_in_explorer", { path });

/** 检查路径是否存在 */
export const pathExists = (path: string) => invoke<boolean>("path_exists", { path });

/** 新建文件（空 .md，直接落盘到默认目录），返回实际创建路径 */
export const createFile = (path: string) => invoke<string>("create_file", { path });

/** 新建文件夹（直接落盘到默认目录），返回实际创建路径 */
export const createDir = (path: string) => invoke<string>("create_dir", { path });

/**
 * 删除文件或文件夹 → **移入系统回收站**（可恢复，M-01）。
 * 回收站不可用时抛出以 `TRASH_UNAVAILABLE:` 开头的错误，
 * 调用方应据此二次确认后再走 deletePathPermanent。
 */
export const deletePath = (path: string) => invoke<void>("delete_path", { path });

/** 永久删除（不可恢复）。仅在回收站不可用且用户明确确认后调用。 */
export const deletePathPermanent = (path: string) =>
  invoke<void>("delete_path_permanent", { path });

/** 判断错误是否为「回收站不可用」 */
export const isTrashUnavailable = (e: unknown) => String(e).includes("TRASH_UNAVAILABLE");

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

/** 从资源管理器拖入：把外部文件复制到目标目录（非破坏性，同名自动改名），返回导入后的路径列表 */
export const importFiles = (srcPaths: string[], destDir: string) =>
  invoke<string[]>("import_files", { srcPaths, destDir });

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

/** 导出「自包含 Markdown」：Rust 侧把文档内本地图片内嵌为 base64 data URI，写出单文件 .md。
 *  baseDir 为源 .md 所在目录（用于解析相对图片路径）。返回内嵌/失败/跳过计数。 */
export const exportBundledMarkdown = (
  savePath: string,
  markdown: string,
  baseDir: string
) =>
  invoke<{ embedded: number; failed: number; skipped: number }>(
    "export_bundled_markdown",
    { savePath, markdown, baseDir }
  );

/** 导出「自包含 Markdown」的保存对话框：预填 `原名_bundled.md` */
export const pickSaveBundledFile = (srcPath: string) =>
  invoke<string | null>("pick_save_bundled_file", { srcPath });

/** 设置文件所在路径（仅用于设置面板展示）；非 Tauri 环境返回空串 */
export const settingsFilePath = async (): Promise<string> => {
  try {
    return await invoke<string>("settings_file_path");
  } catch {
    return "";
  }
};
