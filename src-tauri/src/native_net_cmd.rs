//! П4 (experiment): the Tauri commands for the native transport. Built only with
//! `--features native-transport`; then capabilities-native/native.json allows them for the main
//! window. The work is in native_net.rs.

use crate::native_net::{b64_decode, b64_encode, lan_address, lan_http, ssdp, NetHub};
use serde::Serialize;
use tauri::State;

#[derive(Serialize)]
pub struct Opened {
    id: u32,
    port: u16,
    #[serde(rename = "lanAddress", skip_serializing_if = "Option::is_none")]
    lan_address: Option<String>,
}

#[derive(Serialize)]
pub struct Received {
    id: u32,
    data: String,
    host: String,
    port: u16,
}

#[derive(Serialize)]
pub struct HttpAnswer {
    status: u16,
    text: String,
}

#[tauri::command]
pub fn native_udp_open(hub: State<'_, NetHub>) -> Result<Opened, String> {
    let (id, port) = hub.open()?;
    Ok(Opened { id, port, lan_address: lan_address() })
}

#[tauri::command]
pub fn native_udp_send(hub: State<'_, NetHub>, id: u32, host: String, port: u16, data: String, ttl: u32) -> Result<(), String> {
    let bytes = b64_decode(&data).ok_or("bad data")?;
    hub.send(id, &host, port, &bytes, ttl)
}

#[tauri::command]
pub fn native_udp_close(hub: State<'_, NetHub>, id: u32) {
    hub.close(id);
}

#[tauri::command]
pub async fn native_udp_recv(hub: State<'_, NetHub>, wait_ms: u64) -> Result<Vec<Received>, String> {
    Ok(hub
        .recv(wait_ms)
        .into_iter()
        .map(|d| Received { id: d.id, data: b64_encode(&d.data), host: d.host, port: d.port })
        .collect())
}

#[tauri::command]
pub async fn native_ssdp(timeout_ms: u64) -> Vec<String> {
    ssdp(timeout_ms)
}

#[tauri::command]
pub async fn native_lan_http(url: String, method: String, soap_action: String, body: String) -> Result<HttpAnswer, String> {
    let (status, text) = lan_http(&url, &method, &soap_action, &body)?;
    Ok(HttpAnswer { status, text })
}
