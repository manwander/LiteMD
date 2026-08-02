// 与 src-tauri/src/lib.rs 中的 Tauri command 一一对应。
// invoke 的参数名（path / content / root / html）必须与 Rust 命令形参一致。
import { invoke } from "@tauri-apps/api/core";

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

export const pickOpenFile = () => invoke<string | null>("pick_open_file");

export const pickOpenFolder = () => invoke<string | null>("pick_open_folder");

export const pickSaveFile = () => invoke<string | null>("pick_save_file");

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

/** 递归列出文件夹下所有 .md 文件路径（整夹批量迁移用） */
export const listMdFiles = (root: string) => invoke<string[]>("list_md_files", { root });

/** 跨文件查找的单条匹配结果 */
export interface FolderMatch {
  path: string;
  line: number;
  text: string;
}

/** 跨文件替换的汇总结果 */
export interface FolderReplaceResult {
  filesChanged: number;
  count: number;
}

/** 在当前文件夹下所有 .md 中查找（字面子串，可选大小写敏感） */
export const searchInFolder = (folder: string, query: string, caseSensitive: boolean) =>
  invoke<FolderMatch[]>("search_in_folder", { folder, query, caseSensitive });

/** 在当前文件夹下所有 .md 中批量替换，返回受影响文件数与替换总次数 */
export const replaceInFolder = (
  folder: string,
  query: string,
  replacement: string,
  caseSensitive: boolean
) => invoke<FolderReplaceResult>("replace_in_folder", { folder, query, replacement, caseSensitive });

/** 清理附件目录中未被任何 .md 引用的文件（递归子目录），返回被删文件相对路径列表 */
export const cleanupOrphans = (noteDir: string, assetsName: string) =>
  invoke<string[]>("cleanup_orphans", { noteDir, assetsName });

export const exportHtml = (path: string, html: string) =>
  invoke<void>("export_html", { path, html });

/** 设置文件所在路径（仅用于设置面板展示）；非 Tauri 环境返回空串 */
export const settingsFilePath = async (): Promise<string> => {
  try {
    return await invoke<string>("settings_file_path");
  } catch {
    return "";
  }
};
