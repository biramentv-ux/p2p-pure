//! П6 (experiment): Tor through Arti, built only with `--features tor-transport`. The app gets
//! its own onion service (a new address per run: nothing is published that links two runs) and
//! can open streams to the other person's onion address. No exit relays are used: both ends are
//! onion services, so neither side's IP address is ever seen by the other or by a relay that
//! knows who it talks to.
//!
//! The web code (src/tor/*.ts) does the rest: it puts the onion address into the signed
//! invitation, frames messages on the stream and proves on the first frame that it belongs to
//! this pairing. Everything stays end-to-end encrypted as always; Tor hides the network path.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use arti_client::config::onion_service::OnionServiceConfigBuilder;
use arti_client::config::TorClientConfigBuilder;
use arti_client::{DataWriter, TorClient};
use futures::io::{AsyncReadExt, AsyncWriteExt};
use futures::StreamExt;
use safelog::DisplayRedacted;
use tokio::sync::{Mutex, Notify};
use tor_cell::relaycell::msg::Connected;
use tor_hsservice::{handle_rend_requests, HsNickname, RunningOnionService};
use tor_rtcompat::PreferredRuntime;

/// The virtual port of our onion service; anything else is refused.
pub const ONION_PORT: u16 = 7777;
const MAX_STREAMS: usize = 8;
const MAX_CHUNK: usize = 64 * 1024;

pub enum Event {
    Open { id: u64, incoming: bool },
    Data { id: u64, data: Vec<u8> },
    Close { id: u64 },
}

#[derive(Default)]
struct Inner {
    client: Option<Arc<TorClient<PreferredRuntime>>>,
    service: Option<Arc<RunningOnionService>>,
    onion: Option<String>,
    writers: HashMap<u64, Arc<Mutex<DataWriter>>>,
}

#[derive(Default)]
pub struct TorHub {
    inner: Mutex<Inner>,
    events: std::sync::Mutex<VecDeque<Event>>,
    notify: Notify,
    next: AtomicU64,
}

impl TorHub {
    pub fn new() -> Arc<Self> {
        Arc::new(TorHub { next: AtomicU64::new(1), ..Default::default() })
    }

    fn push(&self, e: Event) {
        let mut q = self.events.lock().unwrap();
        if q.len() < 4096 {
            q.push_back(e);
        }
        drop(q);
        self.notify.notify_one();
    }

    /// Bootstraps Tor and launches the onion service; returns our address. Idempotent.
    pub async fn start(self: &Arc<Self>, state_dir: std::path::PathBuf, cache_dir: std::path::PathBuf) -> Result<String, String> {
        let mut inner = self.inner.lock().await;
        if let Some(onion) = &inner.onion {
            return Ok(onion.clone());
        }
        let config = TorClientConfigBuilder::from_directories(state_dir, cache_dir).build().map_err(|e| e.to_string())?;
        let client = TorClient::create_bootstrapped(config).await.map_err(|e| e.to_string())?;
        // A fresh nickname per run: a new key, so a new address every time the app starts.
        let nickname: HsNickname = format!("p2p{}", rand_suffix()).parse().map_err(|_| "nickname".to_string())?;
        let svc_config = OnionServiceConfigBuilder::default().nickname(nickname).build().map_err(|e| e.to_string())?;
        let (service, requests) = client
            .launch_onion_service(svc_config)
            .map_err(|e| e.to_string())?
            .ok_or("onion service disabled")?;
        let onion = service
            .onion_address()
            .ok_or("no onion address yet")?
            .display_unredacted()
            .to_string();
        let hub = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let mut streams = Box::pin(handle_rend_requests(requests));
            while let Some(req) = streams.next().await {
                let ok_port = matches!(req.request(), tor_proto::stream::IncomingStreamRequest::Begin(b) if b.port() == ONION_PORT);
                if !ok_port || hub.inner.lock().await.writers.len() >= MAX_STREAMS {
                    let _ = req.shutdown_circuit();
                    continue;
                }
                if let Ok(stream) = req.accept(Connected::new_empty()).await {
                    hub.adopt(stream, true).await;
                }
            }
        });
        inner.client = Some(client);
        inner.service = Some(service);
        inner.onion = Some(onion.clone());
        Ok(onion)
    }

    async fn adopt(self: &Arc<Self>, stream: arti_client::DataStream, incoming: bool) -> u64 {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (mut reader, writer) = stream.split();
        self.inner.lock().await.writers.insert(id, Arc::new(Mutex::new(writer)));
        self.push(Event::Open { id, incoming });
        let hub = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let mut buf = vec![0u8; 16 * 1024];
            loop {
                match reader.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => hub.push(Event::Data { id, data: buf[..n].to_vec() }),
                }
            }
            hub.inner.lock().await.writers.remove(&id);
            hub.push(Event::Close { id });
        });
        id
    }

    /// Opens a stream to another onion service (only .onion: never an exit relay).
    pub async fn connect(self: &Arc<Self>, onion: &str) -> Result<u64, String> {
        if !is_onion_v3(onion) {
            return Err("not a v3 onion address".into());
        }
        let client = self.inner.lock().await.client.clone().ok_or("tor not started")?;
        if self.inner.lock().await.writers.len() >= MAX_STREAMS {
            return Err("too many streams".into());
        }
        let stream = client.connect((onion, ONION_PORT)).await.map_err(|e| e.to_string())?;
        Ok(self.adopt(stream, false).await)
    }

    pub async fn send(&self, id: u64, data: &[u8]) -> Result<(), String> {
        if data.len() > MAX_CHUNK {
            return Err("too large".into());
        }
        let w = self.inner.lock().await.writers.get(&id).cloned().ok_or("no such stream")?;
        let mut w = w.lock().await;
        w.write_all(data).await.map_err(|e| e.to_string())?;
        w.flush().await.map_err(|e| e.to_string())
    }

    pub async fn close(&self, id: u64) {
        let w = self.inner.lock().await.writers.remove(&id);
        if let Some(w) = w {
            let _ = w.lock().await.close().await;
        }
    }

    /// Waits up to `wait_ms` for events, then returns all that are queued (at most 256).
    pub async fn recv(&self, wait_ms: u64) -> Vec<Event> {
        if self.events.lock().unwrap().is_empty() {
            let _ = tokio::time::timeout(Duration::from_millis(wait_ms.min(1000)), self.notify.notified()).await;
        }
        let mut q = self.events.lock().unwrap();
        let n = q.len().min(256);
        q.drain(..n).collect()
    }

    pub async fn status(&self) -> (bool, Option<String>) {
        let inner = self.inner.lock().await;
        (inner.client.is_some(), inner.onion.clone())
    }
}

fn rand_suffix() -> String {
    let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("{:x}", (t ^ (std::process::id() as u128) << 64) & 0xffff_ffff_ffff)
}

/// 56 base32 characters + ".onion" (v3). The checksum is checked by Arti when connecting.
pub fn is_onion_v3(s: &str) -> bool {
    let Some(name) = s.strip_suffix(".onion") else { return false };
    name.len() == 56 && name.bytes().all(|b| b.is_ascii_lowercase() || (b'2'..=b'7').contains(&b)) && name.ends_with('d')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn onion_v3_shape() {
        assert!(is_onion_v3("2gzyxa5ihm7nsggfxnu52rck2vv4rvmdlkiu3zzui5du4xyclen53wid.onion"));
        assert!(!is_onion_v3("example.com"));
        assert!(!is_onion_v3("2gzyxa5ihm7nsggfxnu52rck2vv4rvmdlkiu3zzui5du4xyclen53wi.onion"));
        assert!(!is_onion_v3("2GZYXA5IHM7NSGGFXNU52RCK2VV4RVMDLKIU3ZZUI5DU4XYCLEN53WID.onion"));
    }
}
