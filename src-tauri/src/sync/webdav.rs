// WebDAV 客户端（设计方案 §7）：PROPFIND(Depth:1 逐层)/GET/PUT/MKCOL/DELETE + 四步分级检查。
// 兼容性要点（§7.2）：逐段百分号编码（中文/空格）、href 反解、XML 按 local-name 匹配、
// 无 etag 降级、405/已存在 MKCOL 视为成功。

use quick_xml::events::Event;
use quick_xml::Reader;
use reqwest::header::HeaderMap;
use std::time::Duration;

use crate::sync::transport::{CheckStep, RemoteEntry, Transport, UploadResult};

const PROPFIND_BODY: &str = concat!(
    r#"<?xml version="1.0" encoding="utf-8"?>#,
    r#"<d:propfind xmlns:d="DAV:"><d:prop>"#,
    r#"<d:getcontentlength/><d:getetag/><d:getlastmodified/><d:resourcetype/>"#,
    r#"</d:prop></d:propfind>"#
);

/// 列举护栏：最多 5000 次 PROPFIND、5 万条目，防选错根目录把服务器打爆
const MAX_PROPFIND_REQUESTS: usize = 5000;
const MAX_ENTRIES: usize = 50_000;

#[derive(Debug, Clone)]
pub struct WebDavConfig {
    pub url: String,
    pub username: String,
    pub password: String,
    pub ignore_tls_errors: bool,
    pub custom_tls_certs: String,
    pub proxy_enabled: bool,
    pub proxy_url: String,
    pub proxy_timeout_sec: u64,
}

pub struct WebDav {
    client: reqwest::Client,
    /// 归一后的完整基 URL（含路径、以 '/' 结尾），如 https://host/notes/
    base: String,
    /// base 的路径部分（'/' 分隔、首尾带 '/'），href 反解用
    base_path: String,
    credentials: Option<(String, String)>,
}

/// 把用户填的 url + 文件夹 basePath 归一成完整基 URL。
/// 返回 (base_url 尾带斜杠, base_path 首尾带斜杠)。
/// B 修复：仅允许 https；明文 http 只放行本机地址（localhost/127.0.0.1/[::1]，调试用），
/// 避免 WebDAV 账号密码经明文链路传输。
pub fn normalize_base(url: &str, folder_base_path: &str) -> Result<(String, String), String> {
    let u = url.trim();
    if u.is_empty() {
        return Err("WebDAV URL 为空".into());
    }
    let lower = u.to_lowercase();
    let scheme = if lower.starts_with("https://") {
        "https://"
    } else if lower.starts_with("http://") {
        "http://"
    } else {
        return Err("URL 必须以 https:// 开头（本机调试可用 http://localhost）".into());
    };
    let without_scheme = &u[scheme.len()..];
    let (authority, path) = match without_scheme.find('/') {
        Some(i) => (&without_scheme[..i], &without_scheme[i..]),
        None => (without_scheme, "/"),
    };
    if authority.is_empty() {
        return Err("URL 缺少主机名".into());
    }
    if scheme == "http://" && !is_loopback_authority(authority) {
        return Err("WebDAV 必须使用 HTTPS（localhost 除外）：明文 http 会以明文传输账号密码".into());
    }
    let mut merged = path.trim_end_matches('/').trim_start_matches('/').to_string();
    let extra = folder_base_path.trim().trim_matches('/');
    if !extra.is_empty() {
        if !merged.is_empty() {
            merged.push('/');
        }
        merged.push_str(extra);
    }
    // 折叠连续 '/' 并消解 "." / ".."：保证 base_path 与真实请求路径一致，
    // 同时避免用户 URL 中的 "../" 让前缀匹配永远失效。
    let mut segs: Vec<&str> = Vec::new();
    for s in merged.split('/') {
        match s {
            "" | "." => {}
            ".." => {
                segs.pop();
            }
            _ => segs.push(s),
        }
    }
    let merged = segs.join("/");
    let base_path = if merged.is_empty() {
        "/".to_string()
    } else {
        format!("/{}/", merged)
    };
    let base_url = format!("{}{}{}", scheme, authority, base_path);
    Ok((base_url, base_path))
}

/// 明文 http 白名单：本机地址（调试）。authority 可能含 userinfo / 端口 / [IPv6]。
fn is_loopback_authority(authority: &str) -> bool {
    // 去掉 userinfo（取最后一个 '@' 之后）
    let host_port = authority.rsplit('@').next().unwrap_or(authority);
    let host = if let Some(rest) = host_port.strip_prefix('[') {
        // [::1] 或 [::1]:8088
        match rest.find(']') {
            Some(i) => &rest[..i],
            None => return false,
        }
    } else {
        // host 或 host:port（无括号 host 不含 ':'）
        host_port.split(':').next().unwrap_or(host_port)
    };
    matches!(host.to_ascii_lowercase().as_str(), "localhost" | "127.0.0.1" | "::1")
}

impl WebDav {
    pub fn new(cfg: &WebDavConfig, folder_base_path: &str) -> Result<Self, String> {
        let (base, base_path) = normalize_base(&cfg.url, folder_base_path)?;
        let mut builder = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(300))
            .user_agent(concat!("LiteMD-Sync/", env!("CARGO_PKG_VERSION")));
        if cfg.ignore_tls_errors {
            builder = builder.danger_accept_invalid_certs(true);
        }
        for cert in read_custom_certs(&cfg.custom_tls_certs)? {
            builder = builder.add_root_certificate(cert);
        }
        if cfg.proxy_enabled {
            let proxy = reqwest::Proxy::all(cfg.proxy_url.trim())
                .map_err(|e| format!("代理地址无效: {}", e))?;
            builder = builder.proxy(proxy);
            // reqwest 0.12 Proxy 无独立 timeout：代理超时并入连接超时（连不上代理即失败）
            if cfg.proxy_timeout_sec > 0 {
                builder = builder.connect_timeout(Duration::from_secs(cfg.proxy_timeout_sec.max(5)));
            }
        }
        let client = builder
            .build()
            .map_err(|e| format!("HTTP 客户端初始化失败: {}", e))?;
        let credentials = if cfg.username.is_empty() && cfg.password.is_empty() {
            None
        } else {
            Some((cfg.username.clone(), cfg.password.clone()))
        };
        Ok(Self { client, base, base_path, credentials })
    }

    /// rel（解码、'/' 分隔、无前导斜杠）→ 完整 URL，逐段百分号编码
    fn url_for(&self, rel: &str) -> String {
        let rel = rel.trim_matches('/');
        if rel.is_empty() {
            return self.base.clone();
        }
        let encoded: Vec<String> = rel
            .split('/')
            .map(|seg| urlencoding::encode(seg).into_owned())
            .collect();
        format!("{}{}", self.base, encoded.join("/"))
    }

    /// 响应 href → rel：可能是全 URL / 根相对路径 / 已编码；反解 + 解码 + 去 basePath 前缀。
    /// A 修复：解码后把反斜杠（%5C 或字面 '\'）统一视为分隔符参与分析，并按「路径段」做
    /// base 前缀匹配（/notes 不再匹配 /notes2、/notes-old）；要求 base 后紧跟 '/'（段边界）。
    /// 逐段拒绝空段 / "." / ".." / 盘符与冒号 / 反斜杠 / Windows 非法字符；任何异常返回 None
    /// （宁漏不错：可疑条目直接不进同步集），而不是靠字符串裁剪去猜测。
    fn href_to_rel(&self, href: &str) -> Option<String> {
        let h = href.trim();
        if h.is_empty() {
            return None;
        }
        // 若是绝对 URL 去 scheme://authority，只留路径
        let path_part = if let Some(i) = h.find("://") {
            let rest = &h[i + 3..];
            match rest.find('/') {
                Some(j) => &rest[j..],
                None => "/",
            }
        } else {
            h
        };
        let path_part = path_part.split(['?', '#']).next().unwrap_or(path_part);
        let decoded = urlencoding::decode(path_part).ok()?.to_string();
        // 反斜杠视为分隔符（防 "..\..\x" 绕过），但含反斜杠的远端路径整体拒绝：
        // Windows 无对应文件名，映射过去属于猜测（且可能是穿越/别名攻击）。
        let has_backslash = decoded.contains('\\');
        let decoded_norm = decoded.replace('\\', "/");
        let segs = split_path_segments(&decoded_norm)?;
        let base_segs = split_path_segments(&self.base_path)?;
        // base 前缀必须逐段（ASCII 大小写不敏感）完全对齐且落在段边界上
        if segs.len() < base_segs.len() {
            return None;
        }
        for (p, b) in segs.iter().zip(base_segs.iter()) {
            if !p.eq_ignore_ascii_case(b) {
                return None; // 不属于本基路径（含父目录回显、/notes2 等伪前缀）
            }
        }
        let rel_segs = &segs[base_segs.len()..];
        if rel_segs.is_empty() {
            return None; // 目录自身
        }
        if has_backslash {
            return None;
        }
        let mut out = String::new();
        for seg in rel_segs {
            if !is_safe_rel_segment(seg) {
                return None;
            }
            if !out.is_empty() {
                out.push('/');
            }
            out.push_str(seg);
        }
        Some(out)
    }

    async fn propfind(&self, dir_rel: &str, depth: &str) -> Result<(u16, String), String> {
        let url = self.url_for(dir_rel);
        let mut req = self
            .client
            .request(reqwest::Method::from_bytes(b"PROPFIND").unwrap(), &url)
            .header("Depth", depth)
            .header("Content-Type", "application/xml; charset=utf-8")
            .body(PROPFIND_BODY.as_bytes().to_vec());
        req = self.with_auth(req);
        let resp = req
            .send()
            .await
            .map_err(|e| format!("PROPFIND {}: {}", dir_rel, friendly_reqwest_err(&e)))?;
        let status = resp.status().as_u16();
        let text = resp
            .text()
            .await
            .map_err(|e| format!("PROPFIND {} 读取响应失败: {}", dir_rel, e))?;
        Ok((status, text))
    }

    fn with_auth(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match &self.credentials {
            Some((u, p)) => req.basic_auth(u, Some(p.clone())),
            None => req,
        }
    }

    /// 递归建父目录链：对 rel 的每个祖先目录 MKCOL；任何失败都忽略
    /// （已存在 405 / 成功 201 / 服务器限制均交由随后的 PUT 结果裁决）。
    async fn mkdir_all(&self, rel: &str) {
        let segs: Vec<&str> = rel.split('/').filter(|s| !s.is_empty()).collect();
        let mut cur = String::new();
        for seg in segs.iter().take(segs.len().saturating_sub(1)) {
            if !cur.is_empty() {
                cur.push('/');
            }
            cur.push_str(seg);
            let url = self.url_for(&cur);
            let req = self.with_auth(self.client.request(reqwest::Method::from_bytes(b"MKCOL").unwrap(), &url));
            let _ = req.send().await;
        }
    }
}

impl Transport for WebDav {
    async fn check(&self) -> Result<Vec<CheckStep>, String> {
        let mut steps: Vec<CheckStep> = Vec::new();
        // ① OPTIONS：网络可达 + DAV 头
        let opts = self
            .with_auth(self.client.request(reqwest::Method::OPTIONS, &self.base))
            .send()
            .await;
        match opts {
            Ok(r) => {
                let status = r.status().as_u16();
                let dav = header_str(r.headers(), "dav").unwrap_or_default();
                let msg = if status == 401 || status == 403 {
                    "网络可达（服务器要求认证）".to_string()
                } else if dav.contains('1') || dav.contains('2') {
                    "网络可达，服务器声明支持 DAV".to_string()
                } else {
                    "网络可达（未声明 DAV 头，部分服务器如此，继续尝试）".to_string()
                };
                steps.push(CheckStep { name: "network".into(), ok: true, skipped: false, message: msg });
            }
            Err(e) => {
                steps.push(CheckStep {
                    name: "network".into(),
                    ok: false,
                    skipped: false,
                    message: friendly_reqwest_err(&e),
                });
                for name in ["auth", "read", "write"] {
                    steps.push(CheckStep { name: name.into(), ok: false, skipped: true, message: "网络不可达，已跳过".into() });
                }
                return Ok(steps);
            }
        }
        // ② 认证 + ③ 读取：PROPFIND Depth:0
        let (status, text) = self.propfind("", "0").await?;
        if status == 401 || status == 403 {
            steps.push(CheckStep { name: "auth".into(), ok: false, skipped: false, message: format!("认证失败（{}），检查用户名/密码", status) });
            steps.push(CheckStep { name: "read".into(), ok: false, skipped: true, message: "认证未通过".into() });
            steps.push(CheckStep { name: "write".into(), ok: false, skipped: true, message: "认证未通过".into() });
            return Ok(steps);
        }
        steps.push(CheckStep { name: "auth".into(), ok: true, skipped: false, message: "认证成功".into() });
        if status == 404 || status == 409 {
            steps.push(CheckStep { name: "read".into(), ok: true, skipped: false, message: "远端路径不存在，首次同步时将自动创建".into() });
        } else if status == 207 || status == 200 {
            let n = parse_multistatus(&text).map(|v| v.len()).unwrap_or(0);
            steps.push(CheckStep { name: "read".into(), ok: true, skipped: false, message: format!("读取正常（当前层级 {} 项）", n) });
        } else {
            steps.push(CheckStep { name: "read".into(), ok: false, skipped: false, message: format!("PROPFIND 返回异常状态 {}", status) });
        }
        // ④ 写入探测：PUT 探针 → DELETE 探针
        let probe = format!(
            ".litemd-probe-{}.tmp",
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
        );
        match self.upload(&probe, b"litemd-probe".to_vec()).await {
            Ok(_) => {
                let del = self.delete(&probe).await;
                steps.push(CheckStep {
                    name: "write".into(),
                    ok: true,
                    skipped: false,
                    message: match del {
                        Ok(_) => "写入正常".into(),
                        Err(_) => "写入正常，但探针清理失败（服务器可能限制删除；不影响同步）".into(),
                    },
                });
            }
            Err(e) => {
                steps.push(CheckStep { name: "write".into(), ok: false, skipped: false, message: format!("写入失败：{}", e) });
            }
        }
        Ok(steps)
    }

    async fn list_all(&self) -> Result<Vec<RemoteEntry>, String> {
        let mut out: Vec<RemoteEntry> = Vec::new();
        let mut queue: Vec<String> = vec![String::new()];
        let mut requests = 0usize;
        while let Some(dir) = queue.pop() {
            requests += 1;
            if requests > MAX_PROPFIND_REQUESTS {
                return Err("远端目录层级/数量过大，已中止列举（请检查是否选错同步路径）".into());
            }
            let (status, text) = self.propfind(&dir, "1").await?;
            match status {
                404 | 409 => continue, // 基路径不存在 → 空远端（fail-safe 兜底）
                401 | 403 => return Err(format!("认证失败（{}）", status)),
                207 | 200 => {} // 200：部分非标准服务器也返回体（§7.2 降级）
                s => return Err(format!("PROPFIND {} 返回 {}", dir, s)),
            }
            let entries = parse_multistatus(&text)?;
            for e in entries {
                let rel = match self.href_to_rel(&e.href) {
                    Some(r) => r,
                    None => continue,
                };
                if rel == dir.trim_matches('/') {
                    continue; // 目录自身回显
                }
                if e.is_dir {
                    queue.push(rel);
                } else {
                    if out.len() >= MAX_ENTRIES {
                        return Err("远端文件数超过 50000，已中止".into());
                    }
                    out.push(RemoteEntry {
                        path: rel,
                        size: e.size.unwrap_or(0),
                        etag: e.etag,
                        last_modified: e.last_modified,
                    });
                }
            }
        }
        Ok(out)
    }

    async fn download(&self, rel: &str) -> Result<Vec<u8>, String> {
        let url = self.url_for(rel);
        let req = self.with_auth(self.client.get(&url));
        let resp = req
            .send()
            .await
            .map_err(|e| format!("GET {}: {}", rel, friendly_reqwest_err(&e)))?;
        let status = resp.status().as_u16();
        if status == 404 {
            return Err(format!("GET {} 404（远端文件不存在）", rel));
        }
        if status != 200 {
            return Err(format!("GET {} 返回 {}", rel, status));
        }
        Ok(resp.bytes().await.map_err(|e| format!("GET {} 读取响应失败: {}", rel, e))?.to_vec())
    }

    async fn upload(&self, rel: &str, bytes: Vec<u8>) -> Result<UploadResult, String> {
        self.mkdir_all(rel).await;
        let url = self.url_for(rel);
        let req = self
            .with_auth(
                self.client
                    .put(&url)
                    .header("Content-Type", "application/octet-stream"),
            )
            .body(bytes);
        let resp = req
            .send()
            .await
            .map_err(|e| format!("PUT {}: {}", rel, friendly_reqwest_err(&e)))?;
        let status = resp.status();
        if status.as_u16() == 401 || status.as_u16() == 403 {
            return Err(format!("{} 上传被拒绝（{}），检查服务器写权限", rel, status.as_u16()));
        }
        if !status.is_success() {
            return Err(format!("PUT {} 返回 {}", rel, status.as_u16()));
        }
        let headers = resp.headers().clone();
        Ok(UploadResult {
            etag: header_str(&headers, "etag").map(|s| s.trim().trim_matches('"').to_string()),
            last_modified: header_str(&headers, "last-modified").and_then(|s| httpdate_to_unix(&s)),
        })
    }

    async fn delete(&self, rel: &str) -> Result<(), String> {
        let url = self.url_for(rel);
        let req = self.with_auth(self.client.delete(&url));
        let resp = req
            .send()
            .await
            .map_err(|e| format!("DELETE {}: {}", rel, friendly_reqwest_err(&e)))?;
        let status = resp.status().as_u16();
        if status == 404 || status == 204 || status == 200 {
            return Ok(());
        }
        Err(format!("DELETE {} 返回 {}", rel, status))
    }
}

fn header_str(headers: &HeaderMap, name: &str) -> Option<String> {
    headers.get(name).and_then(|v| v.to_str().ok()).map(|s| s.to_string())
}

fn httpdate_to_unix(s: &str) -> Option<i64> {
    httpdate::parse_http_date(s.trim())
        .ok()
        .map(|t| t.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0))
}

/// 切分 URL 路径为段：允许前导/尾随 '/'，但中间空段（"a//b"）视为异常拒绝。
/// 空路径（基路径根 "/"）返回空段列表。
fn split_path_segments(path: &str) -> Option<Vec<&str>> {
    let trimmed = path.trim_matches('/');
    if trimmed.is_empty() {
        return Some(Vec::new());
    }
    let segs: Vec<&str> = trimmed.split('/').collect();
    if segs.iter().any(|s| s.is_empty()) {
        return None;
    }
    Some(segs)
}

/// 相对路径段白名单（A/L）：拒绝空段 / "." / ".." / 绝对路径痕迹（反斜杠、冒号盘符）
/// / Windows 非法字符；尾随空格与点（Windows 建文件时会自动去除，易造成同名互踩）同样拒绝。
fn is_safe_rel_segment(seg: &str) -> bool {
    if seg.is_empty() || seg == "." || seg == ".." {
        return false;
    }
    if seg.contains(['\\', '<', '>', ':', '"', '|', '?', '*']) {
        return false;
    }
    if seg.ends_with(' ') || seg.ends_with('.') {
        return false;
    }
    // 控制字符与 DEL：文件名里出现即视为异常
    if seg.chars().any(|c| (c as u32) < 0x20 || c == '\u{7f}') {
        return false;
    }
    true
}

/// reqwest 错误 → 中文友好文案（连接/超时/拒绝）
fn friendly_reqwest_err(e: &reqwest::Error) -> String {
    if e.is_connect() {
        return "无法连接服务器（检查 URL/端口/防火墙/服务器是否启动）".into();
    }
    if e.is_timeout() {
        return "请求超时（网络慢或服务器无响应）".into();
    }
    format!("{}", e)
}

fn read_custom_certs(spec: &str) -> Result<Vec<reqwest::Certificate>, String> {
    let mut out = Vec::new();
    for item in spec.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()) {
        let p = std::path::Path::new(item);
        if p.is_dir() {
            let rd = std::fs::read_dir(p).map_err(|e| format!("证书目录 {}: {}", item, e))?;
            for e in rd.flatten() {
                push_cert(&e.path(), &mut out)?;
            }
        } else {
            push_cert(p, &mut out)?;
        }
    }
    Ok(out)
}

fn push_cert(path: &std::path::Path, out: &mut Vec<reqwest::Certificate>) -> Result<(), String> {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    if !matches!(ext.as_str(), "pem" | "crt" | "cer") {
        return Ok(());
    }
    let bytes = std::fs::read(path).map_err(|e| format!("读证书 {}: {}", path.display(), e))?;
    match reqwest::Certificate::from_pem(&bytes) {
        Ok(c) => {
            out.push(c);
            Ok(())
        }
        Err(e) => Err(format!("证书解析失败 {}: {}", path.display(), e)),
    }
}

// ---------------- PROPFIND Multi-Status 解析 ----------------

#[derive(Debug, Default)]
struct ParsedResponse {
    href: String,
    is_dir: bool,
    size: Option<u64>,
    etag: Option<String>,
    last_modified: Option<i64>,
}

/// 解析 Multi-Status。命名空间前缀不可信（D:response/response 混合）→ 一律按 local-name 匹配。
/// 同一 response 内多个 propstat：仅采信 status 含 200 的 propstat 属性（§7.2 无 etag 降级）。
/// 注意 status 在 prop 之后到达 → 记录本组写过的槽位，非 200 时回滚。
#[derive(Default)]
struct ParseCtx {
    results: Vec<ParsedResponse>,
    cur: Option<ParsedResponse>,
    prop_valid: bool,
    in_propstat: bool,
    wrote: PropSlots,
}

#[derive(Default, Clone, Copy)]
struct PropSlots {
    etag: bool,
    size: bool,
    lm: bool,
}

fn parse_multistatus(xml: &str) -> Result<Vec<ParsedResponse>, String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut ctx = ParseCtx {
        results: Vec::new(),
        cur: None,
        prop_valid: true,
        in_propstat: false,
        wrote: PropSlots::default(),
    };

    loop {
        match reader.read_event() {
            // 自闭合 <tag/> 与配对 <tag>…</tag> 必须分开：Empty 无子事件可读
            Ok(Event::Empty(e)) => {
                let name = e.local_name().as_ref().to_vec();
                handle_element(&mut ctx, &name, "");
            }
            Ok(Event::Start(e)) => {
                let name = e.local_name().as_ref().to_vec();
                let inner = if matches!(
                    name.as_slice(),
                    b"href" | b"getetag" | b"getcontentlength" | b"getlastmodified" | b"status"
                ) {
                    read_inner_text(&mut reader)
                } else {
                    String::new()
                };
                handle_element(&mut ctx, &name, &inner);
            }
            Ok(Event::End(e)) => {
                let name = e.local_name().as_ref().to_vec();
                if name == b"response" {
                    if let Some(c) = ctx.cur.take() {
                        if !c.href.is_empty() {
                            ctx.results.push(c);
                        }
                    }
                } else if name == b"propstat" {
                    ctx.in_propstat = false;
                    ctx.prop_valid = true;
                }
            }
            Ok(Event::Eof) => break,
            Err(err) => return Err(format!("PROPFIND XML 解析失败: {}", err)),
            _ => {}
        }
    }
    Ok(ctx.results)
}

/// 处理一个（自闭合或带文本的）元素。`inner` 为其内部文本（Empty 时传 ""）。
fn handle_element(ctx: &mut ParseCtx, name: &[u8], inner: &str) {
    match name {
        b"response" => {
            ctx.cur = Some(ParsedResponse::default());
            ctx.in_propstat = false;
            ctx.prop_valid = true;
            ctx.wrote = PropSlots::default();
        }
        b"propstat" => {
            ctx.in_propstat = true;
            ctx.prop_valid = true;
            ctx.wrote = PropSlots::default();
        }
        b"collection" => {
            if let Some(c) = ctx.cur.as_mut() {
                c.is_dir = true;
            }
        }
        b"href" => {
            if let Some(c) = ctx.cur.as_mut() {
                if c.href.is_empty() {
                    c.href = inner.to_string();
                }
            }
        }
        b"getetag" | b"getcontentlength" | b"getlastmodified" => {
            if ctx.prop_valid {
                if let Some(c) = ctx.cur.as_mut() {
                    match name {
                        b"getetag" => {
                            ctx.wrote.etag = true;
                            c.etag = if inner.is_empty() { None } else { Some(inner.trim().trim_matches('"').to_string()) }
                        }
                        b"getcontentlength" => {
                            ctx.wrote.size = true;
                            c.size = inner.trim().parse().ok();
                        }
                        b"getlastmodified" => {
                            ctx.wrote.lm = true;
                            c.last_modified = httpdate_to_unix(inner);
                        }
                        _ => {}
                    }
                }
            }
        }
        b"status" if ctx.in_propstat => {
            ctx.prop_valid = inner.contains("200");
            if !ctx.prop_valid {
                // status 后到：回滚本 propstat 已写入的属性（404 的 getetag 不得采信）
                if let Some(c) = ctx.cur.as_mut() {
                    if ctx.wrote.etag {
                        c.etag = None;
                    }
                    if ctx.wrote.size {
                        c.size = None;
                    }
                    if ctx.wrote.lm {
                        c.last_modified = None;
                    }
                }
            }
        }
        _ => {}
    }
}

/// 读当前 Start 元素直到配对 End 的全部文本（实体已解码）
fn read_inner_text(reader: &mut Reader<&[u8]>) -> String {
    let mut val = String::new();
    loop {
        match reader.read_event() {
            Ok(Event::Text(t)) => val.push_str(&t.unescape().unwrap_or_default()),
            Ok(Event::CData(t)) => val.push_str(&String::from_utf8_lossy(t.as_ref())),
            Ok(Event::End(_)) | Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    val
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_normalization() {
        let (b, p) = normalize_base("https://182.61.58.145:8443", "/notes/").unwrap();
        assert_eq!(b, "https://182.61.58.145:8443/notes/");
        assert_eq!(p, "/notes/");
        let (b, p) = normalize_base("https://host/dav/", "").unwrap();
        assert_eq!(b, "https://host/dav/");
        assert_eq!(p, "/dav/");
        let (b, _) = normalize_base("https://host", "/a/b/").unwrap();
        assert_eq!(b, "https://host/a/b/");
        assert!(normalize_base("ftp://host/", "").is_err());
        assert!(normalize_base("", "").is_err());
        // 嵌套 basePath 拼接到 URL 自带路径
        let (b, p) = normalize_base("https://host/dav", "/JoplinSync/").unwrap();
        assert_eq!(b, "https://host/dav/JoplinSync/");
        assert_eq!(p, "/dav/JoplinSync/");
        // URL 只给根
        let (b, p) = normalize_base("https://host/", "").unwrap();
        assert_eq!(b, "https://host/");
        assert_eq!(p, "/");
        // 连续 '/' 折叠为单斜杠（A：段匹配前提）
        let (b, p) = normalize_base("https://host/dav//sub//", "//x//").unwrap();
        assert_eq!(b, "https://host/dav/sub/x/");
        assert_eq!(p, "/dav/sub/x/");
    }

    #[test]
    fn plain_http_rejected_except_loopback() {
        // B：明文 http 一律拒绝（Basic 认证口令会明文传输），仅本机调试地址例外
        assert!(normalize_base("http://example.com/dav/", "").is_err());
        assert!(normalize_base("http://182.61.58.145:8088", "/notes/").is_err());
        assert!(normalize_base("http://localhost.evil.com/", "").is_err());
        for url in ["http://localhost:8088", "http://127.0.0.1:8088", "http://[::1]:8088/dav"] {
            assert!(normalize_base(url, "").is_ok(), "{} 应放行（本机调试）", url);
        }
        let (b, _) = normalize_base("http://localhost:8088", "/notes/").unwrap();
        assert_eq!(b, "http://localhost:8088/notes/");
        assert!(normalize_base("https://example.com/dav/", "").is_ok());
    }

    fn wd(base_url: &str) -> WebDav {
        // 仅测 URL/href/解析，不发请求 → client 用默认配置
        let cfg = WebDavConfig {
            url: base_url.into(),
            username: "".into(),
            password: "".into(),
            ignore_tls_errors: false,
            custom_tls_certs: "".into(),
            proxy_enabled: false,
            proxy_url: "".into(),
            proxy_timeout_sec: 0,
        };
        WebDav::new(&cfg, "").unwrap()
    }

    #[test]
    fn url_encoding_chinese_space_hash_percent() {
        let c = wd("https://host:8443/notes/");
        assert_eq!(c.url_for("日记/2026-09.md"), "https://host:8443/notes/%E6%97%A5%E8%AE%B0/2026-09.md");
        assert_eq!(c.url_for("my note.md"), "https://host:8443/notes/my%20note.md");
        assert_eq!(c.url_for("a#b.md"), "https://host:8443/notes/a%23b.md");
        assert_eq!(c.url_for("100%.md"), "https://host:8443/notes/100%25.md");
        assert_eq!(c.url_for(""), "https://host:8443/notes/");
        assert_eq!(c.url_for("/x.md/"), "https://host:8443/notes/x.md");
    }

    #[test]
    fn href_reverse_resolution() {
        let c = wd("https://host:8443/notes/");
        assert_eq!(c.href_to_rel("/notes/%E6%97%A5%E8%AE%B0/a.md").as_deref(), Some("日记/a.md"));
        assert_eq!(c.href_to_rel("https://host:8443/notes/sub/b.md").as_deref(), Some("sub/b.md"));
        assert_eq!(c.href_to_rel("/notes/").as_deref(), None, "目录自身");
        assert_eq!(c.href_to_rel("/other/x.md").as_deref(), None, "基外路径丢弃");
        assert_eq!(c.href_to_rel("/notes/../escape.md").as_deref(), None, "穿越拒绝");
        assert_eq!(c.href_to_rel("/notes/a?x=1").as_deref(), Some("a"), "query 剥离");
        assert_eq!(c.href_to_rel("/notes/%25E6%2597%25A5.md").as_deref(), Some("%E6%97%A5.md"), "双重编码只解一层");
        assert_eq!(c.href_to_rel("/NOTES/x.md").as_deref(), Some("x.md"), "basePath 匹配大小写不敏感");
    }

    #[test]
    fn href_rejects_traversal_and_backslash() {
        // A：%2e%2e（".."）与 %5C（'\'）都不得绕过护栏
        let c = wd("https://host/notes/");
        assert_eq!(c.href_to_rel("/notes/%2e%2e/x.md").as_deref(), None, "%2e%2e 解码为 .. 应拒绝");
        assert_eq!(c.href_to_rel("/notes/a/%2E%2E/%2e%2e/b.md").as_deref(), None, "混合大小写 %2e 应拒绝");
        assert_eq!(c.href_to_rel("/notes/..%5C..%5Cescape.md").as_deref(), None, "%5C 反斜杠穿越应拒绝");
        assert_eq!(c.href_to_rel("/notes/..\\..\\escape.md").as_deref(), None, "字面反斜杠穿越应拒绝");
        assert_eq!(c.href_to_rel("/notes/a%5Cb.md").as_deref(), None, "段内反斜杠（Windows 无对应文件名）拒绝而非猜测");
        assert_eq!(c.href_to_rel("/notes/C:%5Cevil.md").as_deref(), None, "盘符/冒号路径拒绝");
        assert_eq!(c.href_to_rel("/notes/./a.md").as_deref(), None, "「.」段拒绝");
        assert_eq!(c.href_to_rel("/notes//a.md").as_deref(), None, "空段拒绝");
        assert_eq!(c.href_to_rel("/notes/a.md.").as_deref(), None, "尾随点（Windows 会截断）拒绝");
        assert_eq!(c.href_to_rel("/notes/..%2Fa.md").as_deref(), None, "%2F 解码出的「..」段拒绝");
    }

    #[test]
    fn href_prefix_requires_segment_boundary() {
        // A：base 前缀必须落在 '/' 边界，/notes 不得匹配 /notes2 / /notes-old
        let c = wd("https://host/notes/");
        assert_eq!(c.href_to_rel("/notes2/x.md").as_deref(), None, "/notes 不得匹配 /notes2");
        assert_eq!(c.href_to_rel("/notes-old/x.md").as_deref(), None, "/notes 不得匹配 /notes-old");
        assert_eq!(c.href_to_rel("/notes/sub/b.md").as_deref(), Some("sub/b.md"), "段边界后正常相对化");
        assert_eq!(c.href_to_rel("/notes").as_deref(), None, "完全相等 = 目录自身");
        // 根基路径（base_path="/"）下所有段都视为相对路径
        let root = wd("https://host/");
        assert_eq!(root.href_to_rel("/a/b.md").as_deref(), Some("a/b.md"));
        assert_eq!(root.href_to_rel("/notes2/x.md").as_deref(), Some("notes2/x.md"));
    }

    const XML_FULL: &str = r#"<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:s="http://example/">
  <d:response>
    <d:href>/notes/</d:href>
    <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype><d:getetag>"base"</d:getetag></d:prop>
    <d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
  <d:response>
    <d:href>/notes/%E6%97%A5%E8%AE%B0/2026.md</d:href>
    <d:propstat><d:prop>
      <d:getcontentlength>2048</d:getcontentlength>
      <d:getetag>"abc123"</d:getetag>
      <d:getlastmodified>Sun, 13 Sep 2026 06:00:00 GMT</d:getlastmodified>
      <d:resourcetype/>
    </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
  <d:response>
    <d:href>/notes/onlymissing.md</d:href>
    <d:propstat><d:prop><d:getetag>"stale"</d:getetag></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>
    <d:propstat><d:prop><d:getcontentlength>7</d:getcontentlength><d:resourcetype/></d:prop>
    <d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
</d:multistatus>"#;

    #[test]
    fn multistatus_parsing() {
        let v = parse_multistatus(XML_FULL).unwrap();
        assert_eq!(v.len(), 3);
        assert!(v[0].is_dir, "base 是目录");
        assert_eq!(v[1].href, "/notes/%E6%97%A5%E8%AE%B0/2026.md");
        assert_eq!(v[1].size, Some(2048));
        assert_eq!(v[1].etag.as_deref(), Some("abc123"), "etag 去引号");
        assert!(v[1].last_modified.unwrap() > 1_700_000_000);
        assert_eq!(v[2].etag, None, "404 propstat 的 etag 不采信");
        assert_eq!(v[2].size, Some(7), "200 propstat 的 size 采信");
    }

    #[test]
    fn multistatus_no_namespace_prefix() {
        let xml = r#"<?xml version="1.0"?><multistatus xmlns="DAV:"><response><href>/notes/a.md</href><propstat><prop><getcontentlength>1</getcontentlength><resourcetype/></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>"#;
        let v = parse_multistatus(xml).unwrap();
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].size, Some(1));
    }

    #[test]
    fn multistatus_empty_etag_element() {
        let xml = r#"<?xml version="1.0"?><multistatus xmlns="DAV:"><response><href>/notes/a.md</href><propstat><prop><getetag/><getcontentlength>5</getcontentlength></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>"#;
        let v = parse_multistatus(xml).unwrap();
        assert_eq!(v[0].etag, None, "<getetag/> 空元素不应 panic 也不应产出空 etag");
        assert_eq!(v[0].size, Some(5));
    }

    #[test]
    fn percent_encode_roundtrip_via_href_to_rel() {
        let c = wd("https://host/");
        let enc = urlencoding::encode("日记 a#b.md");
        assert_eq!(c.href_to_rel(&format!("/{}", enc)).as_deref(), Some("日记 a#b.md"));
    }
}
