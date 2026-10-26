//! Desktop shell for the messenger. It only opens a window with the bundled web app:
//! no Tauri commands, no plugins, no network access of its own. Everything the app
//! does (crypto, WebRTC, storage) runs in the web code, exactly as in the browser.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running the P2P messenger window");
}
