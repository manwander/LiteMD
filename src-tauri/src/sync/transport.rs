// Transport 抽象：engine 只依赖此接口做三方合并，不感知具体协议。
// 生产实现 = webdav::WebDav；单测实现 = tests 里的内存 MockTransport。
// AFIT（async fn in trait，Rust ≥1.75）：engine 侧泛型单态化，无 dyn/装箱；
// 具体实现（reqwest/HashMap）的 future 均满足 Send，tauri 命令 spawn 时按具体类型校验。

use serde::{Deserialize, Serialize};

/// 远端文件条目（rel = 相对同步基路径，'/' 分隔，原样大小写）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteEntry {
    pub path: String,
    pub size: u64,
    pub etag: Option<String>,
    /// 远端 lastModified（UNIX 秒；服务器未提供则 None）
    pub last_modified: Option<i64>,
}

/// 上传结果：优先取响应头新 etag，无则取 Last-Modified / 本地时钟
#[derive(Debug, Clone, Default)]
pub struct UploadResult {
    pub etag: Option<String>,
    pub last_modified: Option<i64>,
}

/// 检查同步配置的单步结果（四步分级：network / auth / read / write）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckStep {
    pub name: String,
    pub ok: bool,
    /// 该步未执行（如网络都不通时后续步骤跳过）
    pub skipped: bool,
    pub message: String,
}

pub type TError = String;

// AFIT：future 的 Send 性由具体实现（WebDav=reqwest、Mock=HashMap）自然满足，
// engine 泛型单态化后在 tauri 命令 spawn 点按具体类型校验；此处无需 dyn 兼容。
#[allow(async_fn_in_trait)]
pub trait Transport: Send + Sync {
    /// 四步分级检查（§7.1）：OPTIONS → PROPFIND Depth:0 → PUT 探针 → DELETE 探针
    async fn check(&self) -> Result<Vec<CheckStep>, TError>;

    /// 递归列举 basePath 下全部文件（Depth:1 逐层；不含目录本身；rel 已解码）
    async fn list_all(&self) -> Result<Vec<RemoteEntry>, TError>;

    async fn download(&self, rel: &str) -> Result<Vec<u8>, TError>;

    /// 上传（内部负责递归建父目录 MKCOL；405/已存在视为成功）
    async fn upload(&self, rel: &str, bytes: Vec<u8>) -> Result<UploadResult, TError>;

    async fn delete(&self, rel: &str) -> Result<(), TError>;
}
