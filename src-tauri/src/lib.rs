//! Desktop shell for the messenger. It opens a window with the bundled web app. Everything the
//! app does (crypto, WebRTC, storage) runs in the web code, exactly as in the browser. The one
//! exception is Windows Hello unlock: two commands (status, sign) in `windows_hello`, and the
//! capability file allows only those two for the main window. No plugins, no network.

mod windows_hello;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            windows_hello::windows_hello_status,
            windows_hello::windows_hello_sign
        ])
        .run(tauri::generate_context!())
        .expect("error while running the P2P messenger window");
}
