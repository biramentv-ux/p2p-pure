fn main() {
    // Declaring the app's own commands makes each one need an explicit "allow-..." permission
    // in a capability file; without this, every app command would be callable by default.
    // П4 (experiment): with the "native-transport" feature, the native commands are declared too
    // and their capability (capabilities-native/) is added. Without it nothing changes.
    const BASE: &[&str] = &["windows_hello_status", "windows_hello_sign"];
    const WITH_NATIVE: &[&str] = &[
        "windows_hello_status",
        "windows_hello_sign",
        "native_udp_open",
        "native_udp_send",
        "native_udp_close",
        "native_udp_recv",
        "native_ssdp",
        "native_lan_http",
    ];
    let native = std::env::var_os("CARGO_FEATURE_NATIVE_TRANSPORT").is_some();
    let commands = if native { WITH_NATIVE } else { BASE };
    let mut attrs = tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(commands));
    if native {
        attrs = attrs.capabilities_path_pattern("./capabilities*/**/*.json");
        println!("cargo:rerun-if-changed=capabilities-native");
    }
    tauri_build::try_build(attrs).expect("failed to run tauri-build");
}
