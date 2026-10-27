#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod apk;
mod cdvfile;

use std::fs;
use std::path::PathBuf;

use serde_json::json;
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};

#[cfg(debug_assertions)]
macro_rules! debug_port { () => { " --remote-debugging-port=9222" } }
#[cfg(not(debug_assertions))]
macro_rules! debug_port { () => { "" } }

// WebView2 needs identical args for every webview of the app.
const BROWSER_ARGS: &str = concat!(
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection \
     --disable-web-security --allow-file-access-from-files --autoplay-policy=no-user-gesture-required",
    // debug builds only: DevTools protocol for inspecting the game page
    debug_port!()
);

const TITLE: &str = "HPL - Dofus Touch PC";
pub const REPO: &str = "hopollo/HPL-Dofus-Touch-PC";
const SHIM: &str = include_str!("../shim.js");
const OVERLAY: &str = include_str!("../overlay.js");
// Release builds: no browser context menu, reload, print or inspector shortcuts.
const LOCKDOWN: &str = "addEventListener('contextmenu', function (e) { e.preventDefault(); }, true);\
    addEventListener('keydown', function (e) { var k = e.key.toLowerCase();\
    if (k === 'f5' || k === 'f12' || (e.ctrlKey && (k === 'r' || k === 'p' || k === 'u' || (e.shiftKey && /^[ijc]$/.test(k))))) e.preventDefault(); }, true);";

// The device the Cordova plugins report. A real, common Android tablet, so UA and plugin data stay consistent.
const ANDROID_VERSION: &str = "13";
const ANDROID_SDK: u32 = 33;
const MODEL: &str = "SM-X700";
const MANUFACTURER: &str = "samsung";
const BUILD_ID: &str = "TP1A.220624.014";

fn shell_dir(app: &AppHandle) -> PathBuf {
    app.path().app_data_dir().expect("app data dir").join("shell")
}

fn main() {
    tauri::Builder::default()
        .register_asynchronous_uri_scheme_protocol("cdvfile", |ctx, req, responder| {
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                if req.uri().path() == "/__install" {
                    // only while no shell is installed (setup page); the game page can never replace it
                    let shell = shell_dir(&app);
                    let result = if shell.join("apk.json").exists() { Err("Already installed.".into()) } else { apk::install(req.body(), &shell) };
                    let ok = result.is_ok();
                    responder.respond(cdvfile::reply(if ok { 200 } else { 400 }, result.err().unwrap_or_default().into_bytes(), "text/plain"));
                    if ok {
                        std::thread::sleep(std::time::Duration::from_millis(800));
                        app.restart();
                    }
                    return;
                }
                responder.respond(cdvfile::serve(&app.path().app_data_dir().expect("app data dir"), &req));
            });
        })
        .setup(|app| {
            let lockdown = if cfg!(debug_assertions) { "" } else { LOCKDOWN };
            let Ok(identity) = fs::read_to_string(shell_dir(app.handle()).join("apk.json")) else {
                // first run: ask for the user's APK (setup/index.html)
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title(TITLE)
                    .inner_size(720.0, 520.0)
                    .additional_browser_args(BROWSER_ARGS)
                    .initialization_script(lockdown)
                    .build()?;
                return Ok(());
            };
            let apk: serde_json::Value = serde_json::from_str(&identity)?;
            // Same shape as Android System WebView's UA + Cordova's AppendUserAgent; Chrome version = the real engine.
            let user_agent = format!(
                "Mozilla/5.0 (Linux; Android {ANDROID_VERSION}; {MODEL} Build/{BUILD_ID}; wv) AppleWebKit/537.36 \
                 (KHTML, like Gecko) Version/4.0 Chrome/{} Safari/537.36 {}",
                tauri::webview_version()?,
                apk["prefs"]["appenduseragent"].as_str().ok_or("apk.json lacks appenduseragent")?
            );
            let config = json!({
                "apk": apk,
                "device": {
                    "platform": "Android", "version": ANDROID_VERSION, "sdkVersion": ANDROID_SDK.to_string(),
                    "model": MODEL, "manufacturer": MANUFACTURER, "isVirtual": false, "serial": "unknown"
                }
            });
            let overlay = OVERLAY
                .replace("__VERSION__", env!("CARGO_PKG_VERSION"))
                .replace("__REPO__", REPO)
                .replace("__TITLE__", TITLE)
                .replace("__CLIENT__", apk["versionName"].as_str().unwrap_or("?"));

            let menu = MenuBuilder::new(app)
                .item(
                    &SubmenuBuilder::new(app, "Options")
                        .text("keybinds", "Keyboard shortcuts")
                        .separator()
                        .text("change-apk", "Change APK… (after a game update)")
                        .build()?,
                )
                .item(&MenuItemBuilder::with_id("about", "About").build(app)?)
                .build()?;
            app.on_menu_event(|app, event| match event.id().as_ref() {
                "change-apk" => {
                    let _ = fs::remove_dir_all(shell_dir(app));
                    app.restart();
                }
                id @ ("keybinds" | "about") => {
                    if let Some(main) = app.get_webview_window("main") {
                        let _ = main.eval(&format!("window[Symbol.for('overlay')]('{id}')"));
                    }
                }
                _ => {}
            });

            // Loaded from file:// like Cordova's file:///android_asset/www, so the page origin matches Android's.
            let url = Url::from_file_path(shell_dir(app.handle()).join("www").join("index.html")).map_err(|_| "bad shell path")?;
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title(TITLE)
                .menu(menu)
                .inner_size(1280.0, 800.0)
                .user_agent(&user_agent)
                .initialization_script(&SHIM.replace("__CONFIG__", &config.to_string()))
                .initialization_script(&overlay)
                .initialization_script(lockdown)
                // Cordova enables universal file access (no CORS from file://); the first 3 are Tauri's defaults.
                .additional_browser_args(BROWSER_ARGS)
                // overlay.js sets document.title to the character name once in game
                .on_document_title_changed(|window, title| {
                    let _ = window.set_title(if title.is_empty() || title == "Dofus Touch" { TITLE } else { &title });
                })
                .on_new_window({
                    let app = app.handle().clone();
                    move |url, _| {
                        // built off the webview callback: creating a window inside it deadlocks on Windows
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move { open_url(&app, url) });
                        NewWindowResponse::Deny
                    }
                })
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to start");
}

/// Android opens Ankama login in a Custom Tab and gets the result back as a `dofustouch://authorized?code=`
/// deep link. Here the login gets its own window, and that deep link is handed to the shim's IonicDeeplink.
/// Any other link opens in the default browser, like Android's `_system` target.
fn open_url(app: &AppHandle, url: Url) {
    if url.host_str() != Some("auth.ankama.com") {
        if matches!(url.scheme(), "http" | "https") {
            let _ = std::process::Command::new("explorer").arg(url.as_str()).spawn();
        }
        return;
    }
    if let Some(old) = app.get_webview_window("auth") {
        let _ = old.close();
    }
    let handle = app.clone();
    let built = WebviewWindowBuilder::new(app, "auth", WebviewUrl::External(url))
        .title("Ankama")
        .inner_size(480.0, 760.0)
        // Custom Tabs are Chrome on the tablet, not the app's WebView
        .user_agent(&format!(
            "Mozilla/5.0 (Linux; Android {ANDROID_VERSION}; {MODEL}) AppleWebKit/537.36 (KHTML, like Gecko) \
             Chrome/{} Safari/537.36",
            tauri::webview_version().unwrap_or_default()
        ))
        .additional_browser_args(BROWSER_ARGS)
        .on_navigation(move |nav| {
            if nav.scheme() != "dofustouch" {
                return true;
            }
            if let Some(main) = handle.get_webview_window("main") {
                let _ = main.eval(&format!("window[Symbol.for('deeplink')]({})", json!(nav.as_str())));
            }
            let handle = handle.clone();
            tauri::async_runtime::spawn(async move { handle.get_webview_window("auth").map(|w| w.close()) });
            false
        })
        .build();
    if let Err(e) = built {
        eprintln!("auth window: {e}");
    }
}
