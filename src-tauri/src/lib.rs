//! Desktop shell for the messenger. It opens a window with the bundled web app. Everything the
//! app does (crypto, WebRTC, storage) runs in the web code, exactly as in the browser. The one
//! exception is Windows Hello unlock: two commands (status, sign) in `windows_hello`, and the
//! capability file allows only those two for the main window. No plugins, no network, unless
//! built with the "native-transport" feature (П4, experiment): see native_net.rs.

mod windows_hello;
#[cfg(feature = "native-transport")]
mod native_net;
#[cfg(feature = "native-transport")]
mod native_net_cmd;
#[cfg(feature = "tor-transport")]
mod tor_net;
#[cfg(feature = "tor-transport")]
mod tor_net_cmd;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(not(feature = "native-transport"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        windows_hello::windows_hello_status,
        windows_hello::windows_hello_sign
    ]);
    // П4 (experiment): UDP sockets and LAN HTTP for the native transport (src/native/bridge.ts).
    #[cfg(all(feature = "native-transport", not(feature = "tor-transport")))]
    let builder = builder.manage(native_net::NetHub::new()).invoke_handler(tauri::generate_handler![
        windows_hello::windows_hello_status,
        windows_hello::windows_hello_sign,
        native_net_cmd::native_udp_open,
        native_net_cmd::native_udp_send,
        native_net_cmd::native_udp_close,
        native_net_cmd::native_udp_recv,
        native_net_cmd::native_ssdp,
        native_net_cmd::native_lan_http
    ]);
    // П6 (experiment): Tor onion services (src/tor/*.ts), on top of the native transport.
    #[cfg(feature = "tor-transport")]
    let builder = builder.manage(native_net::NetHub::new()).manage(tor_net::TorHub::new()).invoke_handler(tauri::generate_handler![
        windows_hello::windows_hello_status,
        windows_hello::windows_hello_sign,
        native_net_cmd::native_udp_open,
        native_net_cmd::native_udp_send,
        native_net_cmd::native_udp_close,
        native_net_cmd::native_udp_recv,
        native_net_cmd::native_ssdp,
        native_net_cmd::native_lan_http,
        tor_net_cmd::tor_start,
        tor_net_cmd::tor_status,
        tor_net_cmd::tor_connect,
        tor_net_cmd::tor_send,
        tor_net_cmd::tor_close,
        tor_net_cmd::tor_recv
    ]);
    builder
        .run(tauri::generate_context!())
        .expect("error while running the P2P messenger window");
}
