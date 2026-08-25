// 文件操作命令：封装 Tauri 文件 I/O 调用，
// 负责路径处理、错误分类、状态更新（不直接操作编辑器状态，由调用方负责）。
import {
  pickOpenFile,
  pickOpenFolder,
  readFile,
  pickSaveFile,
  createFile,
  createDir,
  deletePath,
  movePath,
  copyPath,
  writeFile,
  pickImageFile,
  importAsset,
  importAssetBytes,
  listMdFiles,
  cleanupOrphans,
  exportHtml,
  settingsFilePath,
  readMdTree,
  type FolderNode,
} from "../fs";

export type { FolderNode };

// ---- 基础文件操作 ----

export async function openFile(): Promise<string | null> {
  const p = await pickOpenFile();
  if (!p) return null;
  return p;
}

export async function openFolder(): Promise<string | null> {
  const folder = await pickOpenFolder();
  if (!folder) return null;
  return folder;
}

export async function readNote(path: string): Promise<string> {
  return readFile(path);
}

export async function saveNote(path: string, content: string): Promise<void> {
  await writeFile(path, content);
}

export async function saveNoteAs(content: string): Promise<{ path: string; content: string } | null> {
  const p = await pickSaveFile();
  if (!p) return null;
  await writeFile(p, content);
  return { path: p, content };
}

// ---- 文件名清洗 ----
// 清洗用户输入的文件/文件夹名：去除路径分隔符与 Windows 非法字符，并剥离 ".."，
// 防止拼接成 "C:/notes/../evil.md" 之类的路径穿越。结果为空时调用方应报错。
export function sanitizeName(name: string): string {
  return name
    .replace(/[\/\\:*?"<>|]/g, "") // 路径分隔符与 Windows 非法字符
    .replace(/\.\./g, "") // 单处或连续 .. 防穿越
    .trim();
}

// ---- 新建 ----

export async function newFile(targetDir: string, filename: string): Promise<string> {
  const clean = sanitizeName(filename);
  if (!clean) throw new Error("文件名不能为空或仅含非法字符");
  const fname = /\.md$/i.test(clean) ? clean : `${clean}.md`;
  const fullPath = `${targetDir}/${fname}`;
  await createFile(fullPath);
  return fullPath;
}

export async function newFolder(targetDir: string, folderName: string): Promise<string> {
  const clean = sanitizeName(folderName);
  if (!clean) throw new Error("文件夹名不能为空或仅含非法字符");
  const fullPath = `${targetDir}/${clean}`;
  await createDir(fullPath);
  return fullPath;
}

// ---- 复制 / 移动 / 删除 ----

export async function copyItem(src: string, destDir: string): Promise<void> {
  await copyPath(src, destDir);
}

export async function moveItem(src: string, destDir: string): Promise<string> {
  return movePath(src, destDir);
}

export async function deleteItem(path: string): Promise<void> {
  await deletePath(path);
}

// ---- 目录树 ----

export async function loadFolderTree(folder: string): Promise<FolderNode[]> {
  return readMdTree(folder);
}

export async function listAllMdFiles(root: string): Promise<string[]> {
  return listMdFiles(root);
}

// ---- 图片处理 ----

export async function pickImage(): Promise<string | null> {
  return pickImageFile();
}

// 插入图片：当前笔记有目录则收编（可选压缩）用相对引用；否则用绝对路径。
// 返回：{ relativePath: string, filePath: string, imported: boolean }
export async function importNoteImage(
  sourcePath: string,
  noteDir: string,
  assetsDir: string,
  compressImages: boolean,
  jpegQuality: number
): Promise<{ relativePath: string; imported: boolean }> {
  const rel = await importAsset(sourcePath, noteDir, assetsDir, compressImages, jpegQuality);
  return { relativePath: rel, imported: true };
}

// 粘贴图片（base64 传入）
export async function importNoteImageBytes(
  noteDir: string,
  assetsDir: string,
  ext: string,
  dataB64: string,
  compressImages: boolean,
  jpegQuality: number
): Promise<string> {
  return importAssetBytes(noteDir, assetsDir, ext, dataB64, compressImages, jpegQuality);
}

// ---- 迁移 / 清理 ----

// 迁移单篇内容：把绝对路径图片收编到该笔记目录下的附件文件夹，改写为相对引用
export async function migrateNoteImages(
  text: string,
  noteDir: string,
  assetsDir: string,
  compressImages: boolean,
  jpegQuality: number
): Promise<{ text: string; count: number; failed: number }> {
  const imgRe = /!\[([^\]]*)\]\((<[^>]+>|[^)\s]+)\)/g;
  const jobs: { full: string; alt: string; src: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = imgRe.exec(text))) {
    let src = m[2];
    if (src.startsWith("<") && src.endsWith(">")) src = src.slice(1, -1);
    // 识别绝对路径（含 UNC 网络路径 \\server\share、//server/share）：
    //  drive:\ 或 drive:/  | 双分隔符（UNC） | 单分隔符（Unix 根）
    if (/^([A-Za-z]:[\\/]|[\\/]{2}|[\\/])/.test(src)) {
      jobs.push({ full: m[0], alt: m[1], src });
    }
  }
  let next = text;
  let count = 0;
  let failed = 0;
  for (const job of jobs) {
    try {
      const rel = await importAsset(job.src, noteDir, assetsDir, compressImages, jpegQuality);
      next = next.replace(job.full, `![${job.alt}](${rel})`);
      count++;
    } catch {
      failed++;
    }
  }
  return { text: next, count, failed };
}

export async function cleanupOrphanedAssets(
  dir: string,
  assetsDir: string
): Promise<string[]> {
  return cleanupOrphans(dir, assetsDir);
}

// ---- 导出 ----

export async function exportToHtml(path: string, html: string): Promise<void> {
  await exportHtml(path, html);
}

// ---- 设置路径 ----

export async function getConfigFilePath(): Promise<string> {
  return settingsFilePath();
}

// ---- 工具函数 ----

export function basename(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

export function dirname(p: string): string {
  return p.replace(/[\\/][^\\/]+$/, "") || p;
}
