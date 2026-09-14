// 同步快照（设计方案 §4）：上次同步时「本地=远端」的基线状态。
// 存放 %APPDATA%\com.litemd.app\sync\<folderId>.json，独立于 settings.json。
// 变更判定以内容哈希为准，mtime/size 仅是避免重算哈希的缓存加速。

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::PathBuf;

pub const SNAPSHOT_VERSION: u32 = 1;

/// 单个文件的基线条目
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FileState {
    /// "sha256:<hex>"，上次同步时双方一致的内容哈希
    pub hash: String,
    pub size: u64,
    /// 上次同步时本地 mtime（UNIX 秒，快速路径判据）
    pub mtime: i64,
    /// 远端 etag（服务器支持时优先用）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_etag: Option<String>,
    /// 远端 lastModified（无 etag 时的变更判据）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_mtime: Option<i64>,
    pub synced_at: i64,
    /// 原样大小写的相对路径（展示/回写用；map key 是归一小写）
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderMeta {
    pub local_root: String,
    pub url: String,
    pub base_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub version: u32,
    pub folder: FolderMeta,
    /// key = 归一相对路径（Windows 大小写不敏感 → 统一小写；分隔符统一 '/'）
    pub files: BTreeMap<String, FileState>,
}

impl Snapshot {
    pub fn new(folder: FolderMeta) -> Self {
        Self { version: SNAPSHOT_VERSION, folder, files: BTreeMap::new() }
    }

    pub fn upsert(&mut self, rel: &str, st: FileState) {
        self.files.insert(normalize_rel_key(rel), st);
    }

    pub fn get(&self, rel: &str) -> Option<&FileState> {
        self.files.get(&normalize_rel_key(rel))
    }

    pub fn remove(&mut self, rel: &str) {
        self.files.remove(&normalize_rel_key(rel));
    }
}

/// 相对路径归一 key：'\\'→'/'，去首尾 '/'，小写（Windows 语义；远端 WebDAV 大小写敏感
/// 的差异由碰撞检测兜底——同 key 不同原样路径会报冲突而不是静默合并）。
pub fn normalize_rel_key(rel: &str) -> String {
    rel.replace('\\', "/").trim_matches('/').to_lowercase()
}

/// rel 统一为 '/' 分隔、去首尾 '/'（保留原大小写）
pub fn canon_rel(rel: &str) -> String {
    rel.replace('\\', "/").trim_matches('/').to_string()
}

/// 文件夹稳定 id：sha256(归一 localRoot) 前 12 位
pub fn folder_id(local_root: &str) -> String {
    let norm = local_root.replace('\\', "/").trim_end_matches('/').to_lowercase();
    let mut h = Sha256::new();
    h.update(norm.as_bytes());
    let hex = format!("{:x}", h.finalize());
    hex[..12].to_string()
}

pub struct SnapshotStore {
    dir: PathBuf,
}

impl SnapshotStore {
    pub fn new(sync_dir: PathBuf) -> Self {
        Self { dir: sync_dir }
    }

    fn path(&self, fid: &str) -> PathBuf {
        self.dir.join(format!("{}.json", fid))
    }

    /// 读取快照；不存在 → None；JSON 损坏 → 改名 .corrupt-<ts> 后返回 None（§4：
    /// 快照丢失退化为「双方新文件」，不丢数据只多冲突副本）
    pub fn load(&self, fid: &str) -> Option<Snapshot> {
        let p = self.path(fid);
        let text = std::fs::read_to_string(&p).ok()?;
        match serde_json::from_str::<Snapshot>(&text) {
            Ok(s) if s.version == SNAPSHOT_VERSION => Some(s),
            Ok(_) => None, // 版本不符：保守丢弃（将来在此做迁移）
            Err(_) => {
                let bad = self.dir.join(format!("{}.corrupt-{}.json", fid, unix_now()));
                let _ = std::fs::rename(&p, &bad);
                None
            }
        }
    }

    /// 原子写：tmp + rename，避免中途崩溃留下半截 JSON
    pub fn save(&self, fid: &str, snap: &Snapshot) -> Result<(), String> {
        std::fs::create_dir_all(&self.dir).map_err(|e| format!("创建同步状态目录失败: {}", e))?;
        let tmp = self.path(fid).with_extension("json.tmp");
        let text = serde_json::to_string(snap).map_err(|e| e.to_string())?;
        std::fs::write(&tmp, text).map_err(|e| format!("写快照临时文件失败: {}", e))?;
        let dst = self.path(fid);
        std::fs::rename(&tmp, &dst).map_err(|e| format!("快照落盘失败: {}", e))?;
        Ok(())
    }
}

pub fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub fn sha256_bytes(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    format!("sha256:{:x}", h.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folder_id_stable_and_normalized() {
        let a = folder_id("E:\\notes\\my docs");
        let b = folder_id("e:/notes/my docs/");
        assert_eq!(a, b, "大小写/分隔符/尾斜杠归一后 id 一致");
        assert_eq!(a.len(), 12);
        assert_ne!(a, folder_id("E:\\other"));
    }

    #[test]
    fn normalize_key_case_and_sep() {
        assert_eq!(normalize_rel_key("A\\B\\C.MD"), "a/b/c.md");
        assert_eq!(normalize_rel_key("/日记/2026.md/"), "日记/2026.md");
        assert_eq!(canon_rel("A\\B.md"), "A/B.md");
    }

    #[test]
    fn snapshot_roundtrip_and_corrupt_recovery() {
        let dir = tempfile::tempdir().unwrap();
        let store = SnapshotStore::new(dir.path().to_path_buf());
        let mut snap = Snapshot::new(FolderMeta {
            local_root: "E:\\notes".into(),
            url: "http://x/".into(),
            base_path: "/notes/".into(),
        });
        snap.upsert(
            "日记/a.md",
            FileState { hash: "sha256:aa".into(), size: 3, mtime: 100, synced_at: 101, path: "日记/a.md".into(), ..Default::default() },
        );
        store.save("fid1", &snap).unwrap();
        let got = store.load("fid1").expect("应能读回");
        assert_eq!(got.files.len(), 1);
        assert_eq!(got.get("日记/A.MD").unwrap().hash, "sha256:aa", "key 归一后大小写不敏感命中");

        // 损坏 JSON → load None 且原文件改名 .corrupt-*
        std::fs::write(store.path("fid1"), b"{ not json").unwrap();
        assert!(store.load("fid1").is_none());
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains("corrupt"))
            .collect();
        assert_eq!(leftovers.len(), 1);
    }

    #[test]
    fn missing_snapshot_is_none() {
        let dir = tempfile::tempdir().unwrap();
        let store = SnapshotStore::new(dir.path().to_path_buf());
        assert!(store.load("nope").is_none());
    }

    #[test]
    fn hash_helpers() {
        assert_eq!(sha256_bytes(b"hello"), sha256_bytes(b"hello"));
        assert_ne!(sha256_bytes(b"hello"), sha256_bytes(b"world"));
        assert!(sha256_bytes(b"hello").starts_with("sha256:"));
    }
}
