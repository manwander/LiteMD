// 最小 WebDAV 测试服务器（仅用于 LiteMD 同步 E2E 验证，勿用于生产）
// 实现：OPTIONS / PROPFIND(Depth 0|1) / GET / PUT / MKCOL / DELETE + Basic Auth
// 用法：node scripts/webdav-test-server.mjs [port] [rootDir]
//   凭据 testuser / testpass；默认端口 18088，root 为系统临时目录下的 litemd-webdav-root
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const PORT = Number(process.argv[2] || 18088);
const ROOT = process.argv[3] || path.join(os.tmpdir(), "litemd-webdav-root");
const USER = "testuser";
const PASS = "testpass";

fs.mkdirSync(ROOT, { recursive: true });

const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// URL 路径 → 解码后的文件系统路径（带越界防护）
function fsPath(urlPath) {
  const decoded = decodeURIComponent(urlPath.replace(/^\/+/, ""));
  const p = path.resolve(ROOT, decoded);
  if (!p.startsWith(path.resolve(ROOT))) return null; // 穿越拒绝
  return p;
}

// 文件系统路径 → URL 路径（逐段百分号编码，与真实服务器行为一致）
function urlPath(fp) {
  const rel = path.relative(ROOT, fp).split(path.sep).filter(Boolean);
  return "/" + rel.map((s) => encodeURIComponent(s)).join("/") ;
}

function mimeLike(fp) {
  return "application/octet-stream";
}

function propsXml(fp, href) {
  const st = fs.statSync(fp);
  const isDir = st.isDirectory();
  const etag = `"${st.size.toString(16)}-${st.mtimeMs.toString(16)}"`;
  return (
    "<d:response>" +
    `<d:href>${esc(href)}</d:href>` +
    "<d:propstat><d:prop>" +
    `<d:resourcetype>${isDir ? "<d:collection/>" : ""}</d:resourcetype>` +
    (isDir ? "" : `<d:getcontentlength>${st.size}</d:getcontentlength>`) +
    `<d:getetag>${esc(etag)}</d:getetag>` +
    `<d:getlastmodified>${st.mtime.toUTCString()}</d:getlastmodified>` +
    "</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>" +
    "</d:response>"
  );
}

function multistatus(body) {
  return `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">${body}</d:multistatus>`;
}

function authOk(req) {
  const h = req.headers.authorization || "";
  if (!h.startsWith("Basic ")) return false;
  const dec = Buffer.from(h.slice(6), "base64").toString("utf8");
  return dec === `${USER}:${PASS}`;
}

const server = http.createServer((req, res) => {
  if (!authOk(req)) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="litemd-test"' });
    res.end("auth required");
    return;
  }
  const fp = fsPath(req.url);
  if (!fp) {
    res.writeHead(403); res.end("forbidden"); return;
  }
  const method = req.method.toUpperCase();

  if (method === "OPTIONS") {
    res.writeHead(200, { DAV: "1, 2", Allow: "OPTIONS,GET,PUT,DELETE,MKCOL,PROPFIND", "MS-Author-Via": "DAV" });
    res.end();
    return;
  }

  if (method === "PROPFIND") {
    const depth = (req.headers.depth || "0").trim();
    if (!fs.existsSync(fp)) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }
    let body = propsXml(fp, urlPath(fp) + (fs.statSync(fp).isDirectory() && !req.url.endsWith("/") ? "/" : ""));
    if (depth === "1" && fs.statSync(fp).isDirectory()) {
      for (const name of fs.readdirSync(fp)) {
        const child = path.join(fp, name);
        let cHref = urlPath(child);
        if (fs.statSync(child).isDirectory()) cHref += "/";
        body += propsXml(child, cHref);
      }
    }
    const xml = multistatus(body);
    res.writeHead(207, { "Content-Type": "application/xml; charset=utf-8" });
    res.end(xml);
    return;
  }

  if (method === "GET") {
    if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
      res.writeHead(404); res.end("not found"); return;
    }
    const data = fs.readFileSync(fp);
    res.writeHead(200, { "Content-Type": mimeLike(fp), ETag: `"${data.length.toString(16)}-${fs.statSync(fp).mtimeMs.toString(16)}"` });
    res.end(data);
    return;
  }

  if (method === "PUT") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const buf = Buffer.concat(chunks);
      try {
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, buf);
        res.writeHead(201, { ETag: `"${buf.length.toString(16)}-${Date.now().toString(16)}"` });
        res.end();
      } catch (e) {
        res.writeHead(500); res.end(String(e));
      }
    });
    return;
  }

  if (method === "MKCOL") {
    if (fs.existsSync(fp)) {
      res.writeHead(405); res.end("exists"); return;
    }
    try {
      fs.mkdirSync(fp, { recursive: false });
      res.writeHead(201); res.end();
    } catch {
      res.writeHead(409); res.end("conflict");
    }
    return;
  }

  if (method === "DELETE") {
    if (!fs.existsSync(fp)) {
      res.writeHead(404); res.end(); return;
    }
    fs.rmSync(fp, { recursive: true, force: true });
    res.writeHead(204); res.end();
    return;
  }

  res.writeHead(405); res.end("method not allowed");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`webdav-test-server listening on http://127.0.0.1:${PORT}/ root=${ROOT} auth=${USER}/${PASS}`);
});
