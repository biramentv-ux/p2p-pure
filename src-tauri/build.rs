fn main() {
    // Declaring the app's own commands makes each one need an explicit "allow-..." permission
    // in a capability file; without this, every app command would be callable by default.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&["windows_hello_status", "windows_hello_sign"]),
        ),
    )
    .expect("failed to run tauri-build");
}
