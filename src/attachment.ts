// 附件目录解析与引用改写（纯函数，可单测）。
//
// 两种附件组织模式：
//  - "perDocument"（默认）：每个「测试.md」同级带一个「测试_attachment/」（名称由
//    attachmentTemplate 渲染，默认 "{filename}_attachment"），只放该文档自己的图片。
//    满足「同目录多文档各自附件互不串门」的需求。
//  - "shared"：所有图片统一收编进笔记目录下的 settings.assetsDir（默认 "_attachment"），
//    与早期版本行为一致。
//
// resolveAttachmentDir 根据当前 .md 路径算出其附件目录绝对路径；
// rewriteAttachmentRefs 在重命名 .md 时把文档内指向旧附件目录的图片引用改写为新目录。

import type { Settings } from "./settings";

export type AttachmentSettings = Pick<
  Settings,
  "attachmentMode" | "attachmentTemplate" | "assetsDir"
>;

// ---------------- 路径工具 ----------------

function normSlash(p: string): string {
  return p.replace(/\\/g, "/");
}
function splitPath(p: string): string[] {
  return normSlash(p).split("/").filter((s) => s.length > 0);
}
function lower(p: string): string {
  return normSlash(p).toLowerCase();
}
function isAbsolute(p: string): boolean {
  return /^([A-Za-z]:\/|\/)/.test(p);
}
/** 文件名去扩展名（note.md → note） */
export function fileStem(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
}

// ---------------- 附件目录名 / 路径 ----------------

/** 由 .md 路径算出其附件目录的【文件夹名】（不含父目录） */
export function attachmentDirName(
  mdPath: string,
  s: AttachmentSettings
): string {
  const stem = fileStem(mdPath.split(/[\\/]/).pop() || mdPath);
  if (s.attachmentMode === "shared") {
    return s.assetsDir && s.assetsDir.length ? s.assetsDir : "_attachment";
  }
  const tpl =
    s.attachmentTemplate && s.attachmentTemplate.length
      ? s.attachmentTemplate
      : "{filename}_attachment";
  return tpl.replace(/\{filename\}/gi, stem);
}

/** 由 .md 路径算出其附件目录的【完整路径】（/ 分隔） */
export function resolveAttachmentDir(
  mdPath: string,
  s: AttachmentSettings
): string {
  const dir = (mdPath.replace(/[\\/][^\\/]+$/, "") || mdPath).replace(/\\/g, "/");
  return dir + "/" + attachmentDirName(mdPath, s);
}

// ---------------- 引用改写（重命名 .md 时联动） ----------------

// 跳过的引用：协议 / 锚点 / 裸 scheme:（如 javascript:、someproto:）
const EXTERNAL_RE = /^(https?:|data:|mailto:|tel:|file:|#|\/\/)/i;
function isExternalRef(ref: string): boolean {
  if (EXTERNAL_RE.test(ref)) return true;
  // 形如 "scheme:" 但非 Windows 盘符（C:/）的其它协议
  if (/^[^/\\]*[a-z][a-z0-9+.-]*:/i.test(ref) && !/^[A-Za-z]:[\\/]/.test(ref))
    return true;
  return false;
}

/** 把引用 ref 解析为相对 baseDir 的绝对路径（/ 分隔）；外部/协议类返回 null */
export function resolveRef(baseDir: string, ref: string): string | null {
  const r = ref.trim();
  if (!r) return null;
  if (isExternalRef(r)) return null;
  let resolved: string[];
  if (isAbsolute(r)) {
    resolved = splitPath(r);
  } else {
    resolved = splitPath(baseDir);
    for (const seg of splitPath(r)) {
      if (seg === ".") continue;
      else if (seg === "..") resolved.pop();
      else resolved.push(seg);
    }
  }
  return resolved.join("/");
}

/** 计算从 baseDir 到 absPath 的相对路径 */
export function relativize(baseDir: string, absPath: string): string {
  const b = splitPath(baseDir);
  const a = splitPath(absPath);
  let i = 0;
  while (i < b.length && i < a.length && lower(b[i]) === lower(a[i])) i++;
  const up = b.length - i;
  const rel = [...Array<string>(up).fill(".."), ...a.slice(i)];
  return rel.join("/");
}

/**
 * 改写 markdown 文本里所有【指向 assetDirs 之下】的图片引用：
 * 把路径中等于 oldName 的目录段替换为 newName，其余保持不变。
 * 仅当引用解析后落在某个待迁移附件目录之下才改写（精确，不误伤散文/其它目录）。
 */
export function rewriteAttachmentRefs(
  text: string,
  mdDir: string,
  assetDirs: string[],
  oldName: string,
  newName: string
): { text: string; count: number } {
  const dirsLower = assetDirs.map((d) => lower(d));
  const mdDirN = normSlash(mdDir);
  let count = 0;

  const process = (full: string, urlRaw: string): string => {
    let url = urlRaw;
    if (url.startsWith("<") && url.endsWith(">")) url = url.slice(1, -1);
    const resolved = resolveRef(mdDirN, url);
    if (!resolved) return full;
    const resLower = lower(resolved);
    const hit = dirsLower.some((d) => resLower === d || resLower.startsWith(d + "/"));
    if (!hit) return full;
    const parts = splitPath(resolved);
    const idx = parts.findIndex((p) => lower(p) === lower(oldName));
    if (idx === -1) return full;
    parts[idx] = newName;
    const newAbs = "/" + parts.join("/");
    const newRef = relativize(mdDirN, newAbs);
    count++;
    return full.replace(urlRaw, newRef);
  };

  // Markdown 图片：![alt](url) 或 ![alt](<url>)
  let out = text.replace(
    /!\[([^\]]*)\]\((<[^>]+>|[^)\s]+)\)/g,
    (_m, _alt, url) => process(_m, url)
  );
  // HTML 图片：<img src="url"> / <img src='url'>
  out = out.replace(
    /<img\b[^>]*\bsrc=(["'])([^"']+)\1[^>]*>/gi,
    (m, _q, url) => process(m, url)
  );
  return { text: out, count };
}
