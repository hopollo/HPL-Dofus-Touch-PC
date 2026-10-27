//! Native side of cordova-plugin-file: serves `http://cdvfile.localhost/<fs>/<path>` from the app data dir.
//! Plain GET reads a file (what <script>/<link>/<img> do); POST with an `x-op` header is a file-system op.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use percent_encoding::percent_decode_str;
use serde_json::json;
use tauri::http::{Request, Response};

const ANDROID_URL: &str = "cdvfile://localhost/";
const LOCAL_URL: &str = "http://cdvfile.localhost/";
const JSON: &str = "application/json";

pub fn serve(root: &Path, req: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    if req.method() == "OPTIONS" {
        return reply(204, Vec::new(), "text/plain");
    }
    let Some(path) = resolve(root, req.uri().path()) else {
        return reply(400, b"bad path".to_vec(), "text/plain");
    };
    let header = |k: &str| req.headers().get(k).and_then(|v| v.to_str().ok());
    let num = |k: &str| header(k).and_then(|v| v.parse::<u64>().ok());

    let result: io::Result<(Vec<u8>, &'static str)> = match header("x-op") {
        None => fs::read(&path).map(|b| (rewrite(&path, b), mime(&path))),
        Some("read") => read_range(&path, num("x-start"), num("x-end")).map(|b| (b, mime(&path))),
        Some("stat") => fs::metadata(&path).map(|m| {
            let mtime = m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64);
            (json!({ "dir": m.is_dir(), "size": m.len(), "mtime": mtime }).to_string().into_bytes(), JSON)
        }),
        Some("list") => list(&path).map(|b| (b, JSON)),
        Some("mkdir") => fs::create_dir_all(&path).map(empty),
        Some("touch") => create_parent(&path).and_then(|_| OpenOptions::new().create(true).append(true).open(&path)).map(empty),
        Some("write") => write_at(&path, num("x-pos").unwrap_or(0), req.body()).map(empty),
        Some("truncate") => OpenOptions::new().write(true).open(&path).and_then(|f| f.set_len(num("x-pos").unwrap_or(0))).map(empty),
        Some("remove") => if path.is_dir() { fs::remove_dir(&path) } else { fs::remove_file(&path) }.map(empty),
        Some("rmrf") => fs::remove_dir_all(&path).map(empty),
        Some(op @ ("move" | "copy")) => match header("x-dest").and_then(|d| resolve(root, d)) {
            Some(dest) => create_parent(&dest)
                .and_then(|_| if op == "move" { fs::rename(&path, &dest) } else { fs::copy(&path, &dest).map(drop) })
                .map(empty),
            None => Err(io::Error::new(io::ErrorKind::InvalidInput, "bad x-dest")),
        },
        Some(_) => Err(io::Error::new(io::ErrorKind::Unsupported, "unknown op")),
    };
    match result {
        Ok((body, content_type)) => reply(200, body, content_type),
        Err(e) if e.kind() == io::ErrorKind::NotFound => reply(404, Vec::new(), "text/plain"),
        Err(e) => reply(500, e.to_string().into_bytes(), "text/plain"),
    }
}

/// Maps a URL path to a file under `root`, refusing anything that could escape it (paths come from server data).
fn resolve(root: &Path, url_path: &str) -> Option<PathBuf> {
    let decoded = percent_decode_str(url_path).decode_utf8().ok()?;
    let mut parts = decoded.split('/').filter(|p| !p.is_empty());
    let fs_name = parts.next()?;
    if fs_name != "persistent" && fs_name != "temporary" {
        return None;
    }
    let mut path = root.join(fs_name);
    for part in parts {
        if part == "." || part == ".." || part.contains([':', '\\', '\0']) {
            return None;
        }
        path.push(part);
    }
    Some(path)
}

/// Game CSS/JS downloaded from the server reference cached files with Android's cdvfile:// scheme.
fn rewrite(path: &Path, bytes: Vec<u8>) -> Vec<u8> {
    if !matches!(ext(path), "js" | "css") {
        return bytes;
    }
    match String::from_utf8(bytes) {
        Ok(s) if s.contains(ANDROID_URL) => s.replace(ANDROID_URL, LOCAL_URL).into_bytes(),
        Ok(s) => s.into_bytes(),
        Err(e) => e.into_bytes(),
    }
}

fn read_range(path: &Path, start: Option<u64>, end: Option<u64>) -> io::Result<Vec<u8>> {
    let mut f = File::open(path)?;
    let len = f.metadata()?.len();
    let start = start.unwrap_or(0).min(len);
    let end = end.unwrap_or(len).clamp(start, len);
    let mut buf = vec![0; (end - start) as usize];
    f.seek(SeekFrom::Start(start))?;
    f.read_exact(&mut buf)?;
    Ok(buf)
}

/// Cordova semantics: writing at `pos` truncates the file there first.
fn write_at(path: &Path, pos: u64, data: &[u8]) -> io::Result<()> {
    create_parent(path)?;
    let mut f = OpenOptions::new().create(true).write(true).truncate(false).open(path)?;
    f.set_len(pos)?;
    f.seek(SeekFrom::Start(pos))?;
    f.write_all(data)
}

fn list(path: &Path) -> io::Result<Vec<u8>> {
    let mut entries = Vec::new();
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        entries.push(json!({ "name": entry.file_name().to_string_lossy(), "dir": entry.file_type()?.is_dir() }));
    }
    Ok(serde_json::Value::from(entries).to_string().into_bytes())
}

fn create_parent(path: &Path) -> io::Result<()> {
    path.parent().map_or(Ok(()), fs::create_dir_all)
}

fn empty<T>(_: T) -> (Vec<u8>, &'static str) {
    (Vec::new(), "text/plain")
}

fn ext(path: &Path) -> &str {
    path.extension().and_then(|e| e.to_str()).unwrap_or("")
}

fn mime(path: &Path) -> &'static str {
    match ext(path).to_ascii_lowercase().as_str() {
        "js" => "application/javascript",
        "css" => "text/css",
        "json" => JSON,
        "html" => "text/html",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "mp3" => "audio/mpeg",
        "ogg" => "audio/ogg",
        "m4a" => "audio/mp4",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        _ => "application/octet-stream",
    }
}

pub fn reply(status: u16, body: Vec<u8>, content_type: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("Content-Type", content_type)
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Allow-Headers", "*")
        .header("Access-Control-Allow-Methods", "*")
        .body(body)
        .expect("static response parts are valid")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_stays_inside_root() {
        let root = Path::new("/root");
        assert_eq!(resolve(root, "/persistent/data/a%20b.js"), Some(root.join("persistent/data/a b.js")));
        assert_eq!(resolve(root, "/temporary/"), Some(root.join("temporary")));
        for bad in ["/persistent/../x", "/persistent/%2e%2e/x", "/persistent/a%5C..%5Cb", "/persistent/C:/x", "/EBWebView/x", "/"] {
            assert_eq!(resolve(root, bad), None, "{bad}");
        }
    }

    #[test]
    fn rewrite_only_touches_code() {
        let css = b"url(cdvfile://localhost/persistent/data/a.png)".to_vec();
        assert_eq!(rewrite(Path::new("a.css"), css.clone()), b"url(http://cdvfile.localhost/persistent/data/a.png)");
        assert_eq!(rewrite(Path::new("a.json"), css.clone()), css);
    }
}
