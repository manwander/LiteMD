import { normPath, parentDir } from "./types";

/**
 * 由拖放落点的 DOM 数据解析「目标目录」：
 * - 落在文件行（data-path 指向文件）→ 该文件所在目录（parentDir）
 * - 落在文件夹行（data-path 指向文件夹）→ 该文件夹自身
 * - data-path 缺失（落在空白/容器/滚动区）→ 回退到第一个根目录
 * 纯函数，便于单测；OS 文件拖入与内部 Pointer 拖拽共用同一解析。
 */
export function resolveDropTargetDir(
  dataPath: string | null,
  isFolder: boolean,
  rootPaths: string[]
): string | null {
  if (dataPath) {
    const np = normPath(dataPath);
    return isFolder ? np : normPath(parentDir(np));
  }
  return rootPaths.length ? normPath(rootPaths[0]) : null;
}
