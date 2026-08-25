// 扁平化：文件树状态 → 平铺渲染列表（纯函数，可单测）。
// 替代旧 App.svelte 的 buildFlat/buildFlatInner（C-05）：排序、过滤、隐藏、折叠剪枝集中在此。
import type {
  FileTreeNode,
  FlatNode,
  LoadState,
  TreeFile,
  TreeSortKey,
} from "./types";
import { isPathHidden, isUnder, normPath } from "./types";

export interface FlattenInput {
  nodeMap: Map<string, FileTreeNode>;
  loadState: Map<string, LoadState>;
  rootPaths: string[];
  collapsed: Set<string>;
  filter: string;
  showHidden: boolean;
  showNonMd: boolean;
  /** 是否隐藏附件文件夹 */
  hideAttachments: boolean;
  /** 附件文件夹名称（shared 模式下的统一目录名，如 "_attachment"） */
  assetsDir: string;
  /** 附件组织模式：perDocument=每篇文档带自己的 <文档名>_attachment；shared=统一收编进 assetsDir */
  attachmentMode: "perDocument" | "shared";
  /** perDocument 模式下的附件目录名模板（{filename} 渲染为文档名） */
  attachmentTemplate: string;
  hiddenPaths: string[];
  sort: TreeSortKey;
  /** 数据版本号：nodeMap/loadState/rootPaths 变化时自增，用于 memo 失效 */
  version: number;
}

// ---------------- 附件文件夹检测 ----------------
// 两种附件目录都会被隐藏（当 hideAttachments 开启时）：
// 1. 统一附件目录（shared 模式）：名称由 assetsDir 指定，默认 "_attachment"，与 .md 文件同级。
// 2. 按文档命名的附件目录（perDocument 模式，默认）：`<文档名>_attachment`，
//    名称由 attachmentTemplate 渲染（默认 "{filename}_attachment"）。
//    仅当同级存在同名 .md 时才判定为附件文件夹，避免误隐藏用户命名为 `xxxattachment` 的普通目录。
// 命中后可在文件树中隐藏（磁盘仍保留）。
/** 文件名去扩展名（note.md → note） */
function mdBase(name: string): string {
  const i = name.lastIndexOf(".");
  return i <= 0 ? name : name.slice(0, i);
}

/**
 * 该目录是否为其同级某 .md 的 perDocument 附件文件夹。
 * 根据模板渲染每个同级 .md 的文档名，得到其预期附件目录名并与 folderName 比对，
 * 从而支持自定义模板（如 "{filename}-files"），而不只是硬编码的 _attachment 后缀。
 */
function isDocAttachmentFolder(
  folderName: string,
  siblingFiles: TreeFile[],
  template: string
): boolean {
  if (template.length === 0) return false;
  for (const f of siblingFiles) {
    if (!f.isMd) continue;
    const expected = template.replace(/\{filename\}/gi, mdBase(f.name));
    if (folderName === expected) return true;
  }
  return false;
}

/** 该目录是否为统一附件文件夹（shared 模式下名称等于 assetsDir） */
function isUnifiedAttachmentFolder(folderName: string, assetsDir: string): boolean {
  return folderName === assetsDir && assetsDir.length > 0;
}

/** 远程匹配行（过滤未加载目录的结果） */
export interface RemoteMatch {
  path: string;
  name: string;
  rel: string;
}

/**
 * 排序比较：文件夹恒在前；文件按 sort 键。
 * name: 不区分大小写；mtime/size: 降序；type: 按扩展名分组。
 */
function compareBy(sort: TreeSortKey, a: TreeFile, b: TreeFile): number {
  switch (sort) {
    case "mtime":
      return (b.mtime || 0) - (a.mtime || 0) || a.name.localeCompare(b.name);
    case "size":
      return (b.size || 0) - (a.size || 0) || a.name.localeCompare(b.name);
    case "type": {
      const ea = a.name.slice(a.name.lastIndexOf(".") + 1).toLowerCase();
      const eb = b.name.slice(b.name.lastIndexOf(".") + 1).toLowerCase();
      return ea.localeCompare(eb) || a.name.localeCompare(b.name);
    }
    default:
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  }
}

function pushFolder(
  out: FlatNode[],
  nodeMap: Map<string, FileTreeNode>,
  loadState: Map<string, LoadState>,
  rootPaths: string[],
  collapsed: Set<string>,
  filter: string,
  showNonMd: boolean,
  hiddenPaths: string[],
  sort: TreeSortKey,
  hideAttachments: boolean,
  assetsDir: string,
  attachmentMode: "perDocument" | "shared",
  attachmentTemplate: string,
  path: string,
  depth: number,
  seen: Set<string>
): void {
  const node = nodeMap.get(path);
  if (!node) return;
  if (isPathHidden(path, hiddenPaths)) return;
  // 最终兜底：同一 (path|kind) 只能出现一次，否则 Svelte keyed-each 抛
  // "Cannot have duplicate keys" 并卡死主线程（来回移动时乐观节点残留会触发）。
  const folderKey = path + "|folder";
  if (seen.has(folderKey)) return;
  seen.add(folderKey);
  const expanded = !collapsed.has(path);
  const st = loadState.get(path);
  out.push({
    kind: "folder",
    name: node.name,
    path,
    depth,
    expanded,
    isRoot: rootPaths.includes(path),
    loading: !node.loaded,
    error: st?.error ?? null,
  });
  if (!expanded) return;
  // 错误优先于 loaded：已加载目录在刷新时失败（如根被外部删除）应显示「无法访问」，
  // 而非继续展示陈旧子节点（reveal.test.ts 回归点）。
  if (st?.error) {
    out.push({ kind: "error", name: "无法访问", path, depth: depth + 1, expanded: false, error: st.error });
    return;
  }
  if (!node.loaded) {
    out.push({ kind: "loading", name: "加载中…", path, depth: depth + 1, expanded: false, error: null });
    return;
  }
  const flt = filter.trim().toLowerCase();
  // 文件夹在前、文件在后（资源管理器习惯）；文件夹按名称，文件按 sort 键。
  // 关键：跳过「位于其他根目录之下」的子目录——该子树由对应的根节点单独展示，
  // 否则同一路径会在 keyed each 中重复出现导致渲染崩溃（多根嵌套场景）。
  const children = node.children
    .filter((c) => !isPathHidden(c.path, hiddenPaths))
    .filter((c) => !flt || c.name.toLowerCase().includes(flt))
    // 隐藏附件文件夹：统一附件目录（assetsDir，shared 模式）与按文档命名的 `<文档名>_attachment` 目录（perDocument 模式）在文件树中不展示（磁盘仍保留）
    .filter((c) => !(hideAttachments && (
      isUnifiedAttachmentFolder(c.name, assetsDir) ||
      (attachmentMode === "perDocument" && isDocAttachmentFolder(c.name, node.files, attachmentTemplate))
    )))
    // 多根嵌套场景：如果子目录位于「另一个根」之下（当前 path 不在该根之下），
    // 才跳过由那个根单独展示；若该根是当前 path 的祖先（同一棵子树），必须保留，
    // 否则会错误过滤掉所有深层子目录（如 111/新建文件夹/新建文件夹）。
    .filter((c) => !rootPaths.some((r) => {
      const nr = normPath(r);
      return nr !== path && isUnder(c.path, nr) && !isUnder(path, nr);
    }))
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  for (const child of children) {
    pushFolder(out, nodeMap, loadState, rootPaths, collapsed, filter, showNonMd, hiddenPaths, sort, hideAttachments, assetsDir, attachmentMode, attachmentTemplate, child.path, depth + 1, seen);
  }
  const files = node.files
    .filter((f) => (showNonMd || f.isMd) && !isPathHidden(f.path, hiddenPaths))
    .filter((f) => !flt || f.name.toLowerCase().includes(flt))
    .sort((a, b) => compareBy(sort, a, b));
  for (const f of files) {
    const fileKey = f.path + "|file";
    if (seen.has(fileKey)) continue; // 去重兜底
    seen.add(fileKey);
    out.push({
      kind: "file",
      name: f.name,
      path: f.path,
      depth: depth + 1,
      expanded: false,
      isDir: false,
      isMd: f.isMd,
      size: f.size,
      mtime: f.mtime,
    });
  }
  // B-08：已加载且无任何子项（且非过滤态）时，给出明确「空文件夹」提示，
  // 区分"未加载"与"真·空"，避免用户误以为新建失败。
  if (!flt && node.loaded && children.length === 0 && files.length === 0) {
    out.push({ kind: "hint", name: "（空文件夹）", path: path + "/\u0000empty", depth: depth + 1, expanded: false, error: null });
  }
}

/** 扁平化（无全局 memo：直接重算，避免「version 相同但内容不同」误命中缓存导致渲染陈旧，M-01） */
export function flatten(inp: FlattenInput): FlatNode[] {
  // 防御：rootPaths 去重（addRoot 已去重，但 settings.roots 可能历史遗留重复）
  const roots = [...new Set(inp.rootPaths.map(normPath))];

  const out: FlatNode[] = [];
  const seen: Set<string> = new Set();
  for (const rp of roots) {
    pushFolder(
      out,
      inp.nodeMap,
      inp.loadState,
      roots,
      inp.collapsed,
      inp.filter,
      inp.showNonMd,
      inp.hiddenPaths,
      inp.sort,
      inp.hideAttachments,
      inp.assetsDir,
      inp.attachmentMode ?? "perDocument",
      inp.attachmentTemplate ?? "{filename}_attachment",
      normPath(rp),
      0,
      seen
    );
  }
  return out;
}

/** 在 flat 列表中查找 path 所在行号（找不到返回 -1） */
export function indexOfPath(flat: FlatNode[], path: string): number {
  const np = normPath(path);
  return flat.findIndex((n) => normPath(n.path) === np);
}
