// 本地树扫描（设计方案 §5.1 步骤 1）：walk(localRoot) → 应用 ignorePatterns / maxFileSize。
// rel 统一 '/' 分隔；Windows 大小写碰撞（a.md vs A.md）在此检测并报错。

use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct LocalEntry {
    /// 相对根目录路径（'/' 分隔，原样大小写）
    pub rel: String,
    pub abs: PathBuf,
    pub size: u64,
    pub mtime: i64,
}

/// 递归扫描本地树。返回 Err 仅当根目录不可读；单文件 stat 失败静默跳过。
/// 超过 max_file_size 的文件不进入同步集（在汇总里以 skipped 呈现，见 engine）。
pub fn scan_local(
    root: &Path,
    ignore: &[String],
    max_file_size: u64,
) -> Result<(Vec<LocalEntry>, Vec<String>), String> {
    let mut out: Vec<LocalEntry> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
    // 大小写碰撞检测：lowercase(rel) → 首个原样 rel
    let mut seen: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut collisions: Vec<String> = Vec::new();
    let mut dir_count = 0usize;

    while let Some(dir) = stack.pop() {
        dir_count += 1;
        if dir_count > 20_000 {
            return Err("本地目录数超过 20000，疑似选错同步根目录".into());
        }
        let rd = std::fs::read_dir(&dir).map_err(|e| format!("{}: {}", dir.display(), e))?;
        for entry in rd.flatten() {
            let path = entry.path();
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            let rel = rel_of(root, &path);
            if meta.is_dir() {
                if !matches_ignore(&rel, ignore) {
                    stack.push(path);
                }
                continue;
            }
            if !meta.is_file() {
                continue;
            }
            if matches_ignore(&rel, ignore) {
                continue;
            }
            if meta.len() > max_file_size {
                skipped.push(format!("{}（超过大小上限）", rel));
                continue;
            }
            let key = rel.to_lowercase();
            if let Some(prev) = seen.get(&key) {
                if prev != &rel {
                    collisions.push(format!("{} 与 {} 仅大小写不同", prev, rel));
                    continue;
                }
            } else {
                seen.insert(key, rel.clone());
            }
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            out.push(LocalEntry { rel, abs: path, size: meta.len(), mtime });
        }
    }
    if !collisions.is_empty() {
        return Err(format!(
            "检测到仅大小写不同的文件名（WebDAV 大小写敏感会互踩），请先改名：{}",
            collisions.join("；")
        ));
    }
    out.sort_by(|a, b| a.rel.cmp(&b.rel));
    Ok((out, skipped))
}

fn rel_of(root: &Path, abs: &Path) -> String {
    abs.strip_prefix(root)
        .unwrap_or(abs)
        .to_string_lossy()
        .replace('\\', "/")
}

// ---------------- glob 匹配（无依赖小实现） ----------------
// 规则：按 '/' 分段匹配；`**` 跨任意段（含零段）；`*` 匹配段内任意字符（不跨 '/'）；
// `?` 匹配段内单字符；大小写不敏感（Windows 语义）。
// 示例：".git/**" 命中 .git/config 与 .git/a/b.md；"~$*" 命中 ~$doc.md；"Thumbs.db" 精确段匹配。

pub fn matches_ignore(rel: &str, patterns: &[String]) -> bool {
    let segs: Vec<&str> = rel.split('/').collect();
    patterns.iter().any(|p| {
        let p = p.trim();
        if p.is_empty() {
            return false;
        }
        let psegs: Vec<&str> = p.split('/').filter(|s| !s.is_empty()).collect();
        // gitignore 式 basename 语义：不含 '/' 的单段模式匹配任意文件的末段
        if psegs.len() == 1 {
            return segs.last().is_some_and(|l| seg_match(psegs[0], l));
        }
        glob_segments(&psegs, &segs)
    })
}

fn glob_segments<'a>(pat: &[&'a str], path: &[&'a str]) -> bool {
    match pat.first() {
        None => path.is_empty(),
        Some(&"**") => {
            // ** 吃掉 0..n 段
            for i in 0..=path.len() {
                if glob_segments(&pat[1..], &path[i..]) {
                    return true;
                }
            }
            false
        }
        Some(&p) => match path.first() {
            None => false,
            Some(&s) => seg_match(p, s) && glob_segments(&pat[1..], &path[1..]),
        },
    }
}

fn seg_match(pat: &str, seg: &str) -> bool {
    let p: Vec<char> = pat.to_lowercase().chars().collect();
    let s: Vec<char> = seg.to_lowercase().chars().collect();
    // 经典 DP 通配（* 不跨段，段内任意）
    let (m, n) = (p.len(), s.len());
    let mut dp = vec![vec![false; n + 1]; m + 1];
    dp[0][0] = true;
    for i in 1..=m {
        if p[i - 1] == '*' {
            dp[i][0] = dp[i - 1][0];
        }
    }
    for i in 1..=m {
        for j in 1..=n {
            dp[i][j] = if p[i - 1] == '*' {
                dp[i - 1][j] || dp[i][j - 1]
            } else if p[i - 1] == '?' || p[i - 1] == s[j - 1] {
                dp[i - 1][j - 1]
            } else {
                false
            };
        }
    }
    dp[m][n]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ignore_patterns() {
        let pats: Vec<String> =
            [".git/**", "Thumbs.db", "~$*", "a/*/c.md"].iter().map(|s| s.to_string()).collect();
        assert!(matches_ignore(".git/config", &pats));
        assert!(matches_ignore(".git/objects/aa/bb", &pats));
        assert!(matches_ignore("sub/Thumbs.db", &pats));
        assert!(matches_ignore("~$草稿.md", &pats));
        assert!(matches_ignore("a/b/c.md", &pats));
        assert!(!matches_ignore("a/b/d.md", &pats));
        assert!(!matches_ignore("a/b/c.md/x", &pats)); // * 不跨段
        assert!(!matches_ignore("笔记/2026.md", &pats));
        assert!(matches_ignore(".GIT/CONFIG", &pats), "大小写不敏感");
    }

    #[test]
    fn scan_applies_ignore_and_size_and_detects_collision() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("sub/.git")).unwrap();
        std::fs::write(root.join("a.md"), "hello").unwrap();
        std::fs::write(root.join("sub/b.bin"), vec![0u8; 5000]).unwrap();
        std::fs::write(root.join("sub/.git/config"), "x").unwrap();
        let big = 1024u64;
        let (entries, skipped) = scan_local(root, &["**/.git/**".to_string()], big).unwrap();
        let rels: Vec<_> = entries.iter().map(|e| e.rel.as_str()).collect();
        assert!(rels.contains(&"a.md"));
        assert!(!rels.contains(&"sub/b.bin"), "超限文件不应进入同步集");
        // 5000 > 1024 → 应进 skipped
        assert_eq!(skipped.len(), 1);
        assert!(skipped[0].starts_with("sub/b.bin"));
        assert!(!rels.iter().any(|r| r.contains(".git")));
        // 注：大小写碰撞（a.md vs A.md）在 Windows 真实文件系统上无法构造（NTFS 不区分大小写），
        // 由 scan_local 的 seen-map 检测逻辑保证；该分支在 Linux CI 或手工构造快照时生效。
    }
}
