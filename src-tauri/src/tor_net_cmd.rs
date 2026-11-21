//! П6 (experiment): the Tauri commands for Tor (tor_net.rs). Built only with
//! `--features tor-transport`; capabilities-tor/tor.json allows them for the main window.

use crate::native_net::{b64_decode, b64_encode};
use crate::tor_net::{Event, TorHub};
use serde::Serialize;
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};

#[derive(Serialize)]
pub struct TorEvent {
    id: u64,
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    incoming: Option<bool>,
}

#[derive(Serialize)]
pub struct TorStatus {
    started: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    onion: Option<String>,
}

#[tauri::command]
pub async fn tor_start(app: AppHandle, hub: State<'_, Arc<TorHub>>) -> Result<String, String> {
    let base = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("tor");
    hub.start(base.join("state"), base.join("cache")).await
}

#[tauri::command]
pub async fn tor_status(hub: State<'_, Arc<TorHub>>) -> Result<TorStatus, String> {
    let (started, onion) = hub.status().await;
    Ok(TorStatus { started, onion })
}

#[tauri::command]
pub async fn tor_connect(hub: State<'_, Arc<TorHub>>, onion: String) -> Result<u64, String> {
    hub.connect(&onion).await
}

#[tauri::command]
pub async fn tor_send(hub: State<'_, Arc<TorHub>>, id: u64, data: String) -> Result<(), String> {
    let bytes = b64_decode(&data).ok_or("bad data")?;
    hub.send(id, &bytes).await
}

#[tauri::command]
pub async fn tor_close(hub: State<'_, Arc<TorHub>>, id: u64) -> Result<(), String> {
    hub.close(id).await;
    Ok(())
}

#[tauri::command]
pub async fn tor_recv(hub: State<'_, Arc<TorHub>>, wait_ms: u64) -> Result<Vec<TorEvent>, String> {
    Ok(hub
        .recv(wait_ms)
        .await
        .into_iter()
        .map(|e| match e {
            Event::Open { id, incoming } => TorEvent { id, kind: "open", data: None, incoming: Some(incoming) },
            Event::Data { id, data } => TorEvent { id, kind: "data", data: Some(b64_encode(&data)), incoming: None },
            Event::Close { id } => TorEvent { id, kind: "close", data: None, incoming: None },
        })
        .collect())
}
