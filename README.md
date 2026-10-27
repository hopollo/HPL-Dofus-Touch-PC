# HPL - Dofus Touch PC

Play **Dofus Touch** on your Windows PC with great performance, without an Android emulator.

Absolutely nothing more: no logins stored, no telemetry, no ads, never for cheating or abusing the game.

> ⚠️ This is an unofficial client, not made or endorsed by Ankama. Using it may go against the game's terms of use and
> could get your account banned. Use it at your own risk.

## Install

1. Download `HPL-Dofus-Touch-PC.exe` from the [latest release](../../releases/latest). It is portable: no installation.
2. Get the latest **Dofus Touch APK** (`.apk`, `.xapk` or `.apkm`): copy it from your Android device, or download it
   from a trusted APK site. The app ships no game file; it takes what it needs from your APK.
3. Run the exe and pick the APK when asked. The game starts.

After a game update, use **Options ▸ Change APK…** with the new APK.

## Features

- Mouse play, sound, resizable window.
- Keyboard shortcuts for spell slots and Ready / End turn (**Options ▸ Keyboard shortcuts**). Press a spell key twice
  in a fight to cast it on yourself.
- Ankama account and guest login.

## Specs

- Windows 10 or 11 (64-bit) with Microsoft Edge WebView2 (preinstalled on Windows 11).
- Rust + [Tauri 2](https://tauri.app). The app runs the official game code in WebView2 and replaces only the Android
  native layer: Cordova bridge and plugins (`src-tauri/shim.js`), file system (`src-tauri/src/cdvfile.rs`), APK
  extraction (`src-tauri/src/apk.rs`).
- Game data is cached in `%APPDATA%\local.dofustouchpc`.

Build from source: `cd src-tauri && cargo build --release`.

macOS and Linux are not supported yet (planned once they can be tested).

## License

[MIT](LICENSE). Dofus Touch is a trademark of Ankama; this project is not affiliated with Ankama and contains no
Ankama files.
