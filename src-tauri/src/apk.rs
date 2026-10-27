//! First run: extract the Cordova shell (`assets/www`) from the user's own Dofus Touch APK, so no Ankama file
//! is ever shipped with this app. Accepts a plain APK or an XAPK/APKM bundle wrapping it.

use std::fs;
use std::io::{Cursor, Read};
use std::path::Path;

use serde_json::{json, Map, Value};
use zip::ZipArchive;

/// Android intercepts `file:///__cdvfile_<fs>__/` and `cdvfile://` natively; WebView2 cannot, so the cache is served
/// by `cdvfile.rs` as `http://cdvfile.localhost/<fs>/`. These target the cordova-android 15 shell (client 3.14.x).
const PATCHES: [(&str, &str, &str); 4] = [
    (
        "plugins/cordova-plugin-file/www/android/FileSystem.js",
        "window.location.origin + '/__cdvfile_' + this.name + '__'",
        "'http://cdvfile.localhost/' + this.name",
    ),
    ("js/CordovaFileSystem.js", "'cdvfile://localhost/'", "'http://cdvfile.localhost/'"),
    ("js/autoupdate.js", "'file:///__cdvfile_persistent__/data/'", "'http://cdvfile.localhost/persistent/data/'"),
    ("js/autoupdate.js", "uri.indexOf('file://')", "uri.indexOf('http://cdvfile.localhost/')"),
];

type Zip<'a> = ZipArchive<Cursor<&'a [u8]>>;

/// Writes `<dest>/www/...` (patched) and `<dest>/apk.json` (the identity the official client reports).
pub fn install(file: &[u8], dest: &Path) -> Result<(), String> {
    let mut zip = ZipArchive::new(Cursor::new(file)).map_err(|_| "This file is not an APK.".to_string())?;
    if zip.by_name("assets/www/index.html").is_err() {
        let inner = find_base_apk(&mut zip).ok_or("No Dofus Touch APK found in this file.")?;
        return install(&inner, dest);
    }

    let manifest = axml(&read(&mut zip, "AndroidManifest.xml")?).ok_or("Unreadable AndroidManifest.xml")?;
    let attrs = &manifest.iter().find(|(tag, _)| tag == "manifest").ok_or("No <manifest> in the APK")?.1;
    if attrs.get("package").and_then(Value::as_str) != Some("com.ankama.dofustouch") {
        return Err("This is not the Dofus Touch APK.".into());
    }
    let mut prefs = Map::new();
    for (tag, a) in axml(&read(&mut zip, "res/xml/config.xml")?).ok_or("Unreadable config.xml")? {
        if let (true, Some(name)) = (tag == "preference", a.get("name").and_then(Value::as_str)) {
            prefs.insert(name.to_lowercase(), a.get("value").cloned().unwrap_or(Value::Null));
        }
    }
    if !prefs.get("server").is_some_and(Value::is_string) || !prefs.get("appenduseragent").is_some_and(Value::is_string) {
        return Err("Unsupported APK: no server/user-agent settings.".into());
    }

    let tmp = dest.with_extension("tmp");
    let _ = fs::remove_dir_all(&tmp);
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let Some(rel) = entry.enclosed_name().and_then(|p| p.strip_prefix("assets").ok().map(Path::to_path_buf)) else { continue };
        if !rel.starts_with("www") || entry.is_dir() {
            continue;
        }
        let out = tmp.join(rel);
        fs::create_dir_all(out.parent().unwrap()).map_err(|e| e.to_string())?;
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        fs::write(&out, bytes).map_err(|e| e.to_string())?;
    }
    for (file, from, to) in PATCHES {
        let path = tmp.join("www").join(file);
        let src = fs::read_to_string(&path).map_err(|_| format!("Unsupported APK version: missing {file}"))?;
        if !src.contains(from) {
            return Err(format!("Unsupported APK version: {file} changed"));
        }
        fs::write(&path, src.replace(from, to)).map_err(|e| e.to_string())?;
    }
    let identity = json!({ "package": attrs["package"], "versionName": attrs["versionName"], "versionCode": attrs["versionCode"], "prefs": prefs });
    fs::write(tmp.join("apk.json"), identity.to_string()).map_err(|e| e.to_string())?;

    let _ = fs::remove_dir_all(dest);
    fs::rename(&tmp, dest).map_err(|e| e.to_string())
}

/// XAPK/APKM: the base APK is the largest inner `.apk` (splits only hold resources).
fn find_base_apk(zip: &mut Zip) -> Option<Vec<u8>> {
    let index = (0..zip.len())
        .filter_map(|i| zip.by_index(i).ok().filter(|f| f.name().ends_with(".apk")).map(|f| (i, f.size())))
        .max_by_key(|&(_, size)| size)?
        .0;
    let mut bytes = Vec::new();
    zip.by_index(index).ok()?.read_to_end(&mut bytes).ok()?;
    Some(bytes)
}

fn read(zip: &mut Zip, name: &str) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    zip.by_name(name).map_err(|_| format!("{name} missing from the APK"))?.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes)
}

/// Minimal Android binary XML reader: every start element with its attributes (strings or raw integers).
fn axml(b: &[u8]) -> Option<Vec<(String, Map<String, Value>)>> {
    let u16_at = |o: usize| b.get(o..o + 2).map(|s| u16::from_le_bytes([s[0], s[1]]));
    let u32_at = |o: usize| b.get(o..o + 4).map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]));
    let sp = 8; // string pool chunk right after the file header
    let utf8 = u32_at(sp + 16)? & 0x100 != 0;
    let strings_start = sp + u32_at(sp + 20)? as usize;
    let mut strings = Vec::new();
    for i in 0..u32_at(sp + 8)? as usize {
        let mut p = strings_start + u32_at(sp + 28 + i * 4)? as usize;
        strings.push(if utf8 {
            p += if b.get(p)? & 0x80 != 0 { 2 } else { 1 }; // skip the UTF-16 length
            let mut len = *b.get(p)? as usize;
            if len & 0x80 != 0 {
                p += 1;
                len = ((len & 0x7f) << 8) | *b.get(p)? as usize;
            }
            String::from_utf8_lossy(b.get(p + 1..p + 1 + len)?).into_owned()
        } else {
            let units = (0..u16_at(p)? as usize).map(|k| u16_at(p + 2 + k * 2)).collect::<Option<Vec<_>>>()?;
            String::from_utf16_lossy(&units)
        });
    }
    let mut elements = Vec::new();
    let mut off = sp + u32_at(sp + 4)? as usize;
    while off + 8 <= b.len() {
        let size = u32_at(off + 4)? as usize;
        if u16_at(off)? == 0x0102 {
            let mut attrs = Map::new();
            for i in 0..u16_at(off + 28)? as usize {
                let a = off + 36 + i * 20;
                let raw = u32_at(a + 8)?;
                let value = if raw == u32::MAX { Value::from(u32_at(a + 16)?) } else { Value::from(strings.get(raw as usize)?.clone()) };
                attrs.insert(strings.get(u32_at(a + 4)? as usize)?.clone(), value);
            }
            elements.push((strings.get(u32_at(off + 20)? as usize)?.clone(), attrs));
        }
        if size == 0 {
            break;
        }
        off += size;
    }
    Some(elements)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_apk() {
        assert!(install(b"not a zip", Path::new("unused")).is_err());
    }

    /// Needs a real APK: `DT_APK=path\to\base.apk cargo test` (Ankama files are never committed).
    #[test]
    fn installs_real_apk() {
        let Ok(apk) = std::env::var("DT_APK") else { return };
        let dest = std::env::temp_dir().join("hpl-dtpc-apk-test");
        install(&fs::read(apk).unwrap(), &dest).unwrap();
        let identity: Value = serde_json::from_str(&fs::read_to_string(dest.join("apk.json")).unwrap()).unwrap();
        assert_eq!(identity["package"], "com.ankama.dofustouch");
        assert!(identity["prefs"]["appenduseragent"].as_str().unwrap().starts_with("DofusTouch Client"));
        let autoupdate = fs::read_to_string(dest.join("www/js/autoupdate.js")).unwrap();
        assert!(autoupdate.contains("http://cdvfile.localhost/persistent/data/"));
        fs::remove_dir_all(dest).unwrap();
    }
}
