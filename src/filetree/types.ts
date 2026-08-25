// 文件树类型定义（从 App.svelte 移出，消除 FileTree 反向依赖父组件的问题 C-02）。
// 纯类型模块：不依赖 Svelte / Tauri / fs.ts，便于单测。

/** 树中一个已加载文件夹节点（单级内容，懒加载） */
export interface FileTreeNode {
  name: string;
  path: string;
  /** 本层 .md / 可见文件 */
  files: TreeFile[];
  /** 子文件夹（未展开时仅壳） */
  children: FileTreeNode[];
  /** 懒加载标记：true=子项已列举；false/undefined=未加载（展开时才 list_dir） */
  loaded?: boolean;
  /** 乐观节点标记：由新建/移动乐观插入，尚未经 listDir 校验（合并刷新时保留以对抗 Windows 通知延迟） */
  optimistic?: boolean;
}

/** 树中单个文件 */
export interface TreeFile {
  name: string;
  path: string;
  isMd: boolean;
  size: number;
  mtime: number;
  /** 乐观文件标记：由新建乐观插入，尚未经 listDir 校验（合并刷新时保留以对抗 Windows 通知延迟，B-01） */
  optimistic?: boolean;
}

/** 单目录加载状态 */
export interface LoadState {
  loading: boolean;
  error: string | null;
}

export type TreeSortKey = "name" | "mtime" | "size" | "type";

/** 扁平化后的渲染节点（虚拟滚动 + 行渲染用） */
export interface FlatNode {
  kind: "folder" | "file" | "loading" | "error" | "remote" | "hint";
  name: string;
  path: string;
  depth: number;
  expanded: boolean;
  isRoot?: boolean;
  loading?: boolean;
  error?: string | null;
  /** 文件专属字段 */
  isDir?: boolean;
  isMd?: boolean;
  size?: number;
  mtime?: number;
  /** remote 行：来自未加载目录的过滤匹配 */
  remoteRel?: string;
}

/**
 * 路径归一化（统一正斜杠、去尾部斜杠）。
 * 特殊处理 Windows 盘符根：避免 "C:\\" → "C:"（相对路径，会导致 key 不一致）。
 */
export function normPath(p: string): string {
  let s = p.replace(/\\/g, "/").replace(/\/+$/, "");
  if (/^[A-Za-z]:$/.test(s)) s = s + "/"; // 盘符根保持 C:/，杜绝相对路径歧义
  return s;
}

/** 取路径末段名称 */
export function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i < 0 ? p : p.slice(i + 1);
}

/** 取父目录路径（盘符根为自身，避免刷新时无限递归） */
export function parentDir(p: string): string {
  const np = normPath(p);
  const i = Math.max(np.lastIndexOf("/"), np.lastIndexOf("\\"));
  if (i < 0) return np; // 已是顶层（盘符根或相对路径）
  const parent = np.slice(0, i);
  return parent; // "C:/" 的父目录为 "C:"（经 normPath 又变回 "C:/"，即根自身）
}

/** 判断路径是否被隐藏（路径本身或其祖先在 hiddenPaths 中） */
export function isPathHidden(p: string, hiddenPaths: string[]): boolean {
  const np = normPath(p);
  return (hiddenPaths ?? []).some((h) => {
    const nh = normPath(h);
    return np === nh || np.startsWith(nh + "/");
  });
}

/** 判断某路径是否位于 root 之下（含等于） */
export function isUnder(p: string, root: string): boolean {
  const np = normPath(p);
  const nr = normPath(root);
  return np === nr || np.startsWith(nr + "/");
}

/** 从路径推导祖先链（不含文件自身）：/a/b/c.md -> ["/a", "/a/b"] */
export function ancestorDirs(p: string, root: string): string[] {
  const np = normPath(p);
  const nr = normPath(root);
  if (np === nr) return [];
  const out: string[] = [];
  let cur = parentDir(np);
  while (cur && cur !== nr && cur.length > nr.length) {
    out.unshift(cur);
    cur = parentDir(cur);
  }
  return out;
}

/** 输入对话框返回 */
export interface PromptResult {
  name: string;
  path: string;
}

/** FileTree 与父组件（App）的通信回调注入（所有副作用经此上抛，保持树组件可独立测试） */
export interface TreeHandlers {
  /** 打开文件（新标签） */
  openFile(p: string): void;
  /** 状态栏消息 */
  setStatus(msg: string): void;
  /** 确认对话框（回收站删除、永久删除等） */
  confirm(opts: {
    title: string;
    message: string;
    confirmText?: string;
    danger?: boolean;
  }): Promise<boolean>;
  /** 输入对话框（新建/重命名） */
  prompt(opts: {
    title: string;
    label: string;
    value: string;
    path: string;
  }): Promise<PromptResult | null>;
  /** 系统目录选择器 */
  pickFolder(): Promise<string | null>;
  /** 重命名/移动后，父组件更新已打开标签的路径 */
  onTabRenamed(oldPath: string, newPath: string): void;
  /** 删除后，父组件关闭对应标签 */
  onTabRemoved(path: string): void;
  /** 更新 settings.hiddenPaths（父组件负责 persist） */
  setHiddenPaths(paths: string[]): void;
  /** 文件树偏好持久化（折叠集合/排序/附件可见性，父组件写入 settings 并 persist） */
  setTreePrefs(prefs: { collapsed: string[]; sort: string; showNonMd: boolean }): void;
  /** 根目录列表变化（父组件更新 settings.roots/lastFolder 并 persist） */
  onRootsChanged(roots: string[], lastFolder: string | null): void;
}
