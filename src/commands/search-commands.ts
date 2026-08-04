// 搜索命令：封装跨文件查找替换的 Tauri 调用。
import { searchInFolder, replaceInFolder, type FolderMatch, type FolderSearchResult } from "../fs";

export type { FolderMatch };

export interface ReplaceResult {
  count: number;
  filesChanged: number;
}

export async function searchInCurrentFolder(
  folder: string,
  query: string,
  caseSensitive: boolean
): Promise<FolderSearchResult> {
  return searchInFolder(folder, query, caseSensitive);
}

export async function replaceInCurrentFolder(
  folder: string,
  query: string,
  replacement: string,
  caseSensitive: boolean
): Promise<ReplaceResult> {
  return replaceInFolder(folder, query, replacement, caseSensitive);
}
