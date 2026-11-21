//! П4 (experiment): the Tauri shell's half of the native transport (src/native/bridge.ts).
//! UDP sockets, an SSDP search and HTTP to a router on the LAN; nothing else. STUN, punching
//! and the encryption stay in the web code. Standard library only (no new crates), so this file
//! is also tested on its own: `rustc --edition 2021 --test src/native_net.rs -o /tmp/t && /tmp/t`.
//! The Tauri commands that call it are in native_net_cmd.rs, built only with the
//! "native-transport" feature.

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream, ToSocketAddrs, UdpSocket};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const MAX_SOCKETS: usize = 300; // a birthday punch opens 256
const MAX_DATAGRAM: usize = 2048;
const MAX_QUEUE: usize = 4096;
const MAX_HTTP_ANSWER: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub struct Datagram {
    pub id: u32,
    pub data: Vec<u8>,
    pub host: String,
    pub port: u16,
}

struct Shared {
    queue: Mutex<VecDeque<Datagram>>,
    ready: Condvar,
}

pub struct NetHub {
    sockets: Mutex<HashMap<u32, Arc<UdpSocket>>>,
    next_id: Mutex<u32>,
    shared: Arc<Shared>,
}

impl Default for NetHub {
    fn default() -> Self {
        Self::new()
    }
}

impl NetHub {
    pub fn new() -> Self {
        NetHub {
            sockets: Mutex::new(HashMap::new()),
            next_id: Mutex::new(1),
            shared: Arc::new(Shared { queue: Mutex::new(VecDeque::new()), ready: Condvar::new() }),
        }
    }

    /// Opens a UDP socket on a free port; a thread queues what arrives.
    pub fn open(&self) -> Result<(u32, u16), String> {
        let mut sockets = self.sockets.lock().map_err(|_| "lock")?;
        if sockets.len() >= MAX_SOCKETS {
            return Err("too many sockets".into());
        }
        let sock = UdpSocket::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
        sock.set_read_timeout(Some(Duration::from_millis(500))).map_err(|e| e.to_string())?;
        let port = sock.local_addr().map_err(|e| e.to_string())?.port();
        let mut next = self.next_id.lock().map_err(|_| "lock")?;
        let id = *next;
        *next += 1;
        let sock = Arc::new(sock);
        sockets.insert(id, sock.clone());
        let shared = self.shared.clone();
        thread::spawn(move || {
            let mut buf = [0u8; MAX_DATAGRAM];
            // Ends when close() drops the last other reference (strong_count falls to 1).
            while Arc::strong_count(&sock) > 1 {
                match sock.recv_from(&mut buf) {
                    Ok((n, from)) => {
                        let mut q = match shared.queue.lock() {
                            Ok(q) => q,
                            Err(_) => return,
                        };
                        if q.len() < MAX_QUEUE {
                            q.push_back(Datagram { id, data: buf[..n].to_vec(), host: from.ip().to_string(), port: from.port() });
                            shared.ready.notify_all();
                        }
                    }
                    Err(_) => continue, // timeout: check whether the socket is still wanted
                }
            }
        });
        Ok((id, port))
    }

    /// Sends one datagram; `ttl` > 0 sends it with that TTL (the low-TTL opener of a punch).
    pub fn send(&self, id: u32, host: &str, port: u16, data: &[u8], ttl: u32) -> Result<(), String> {
        if data.len() > MAX_DATAGRAM || port == 0 {
            return Err("bad datagram".into());
        }
        let sock = self.sockets.lock().map_err(|_| "lock")?.get(&id).cloned().ok_or("no such socket")?;
        let addr: SocketAddr = (host, port).to_socket_addrs().map_err(|e| e.to_string())?.find(|a| a.is_ipv4()).ok_or("no IPv4 address")?;
        if ttl > 0 && ttl < 64 {
            let old = sock.ttl().unwrap_or(64);
            sock.set_ttl(ttl).map_err(|e| e.to_string())?;
            let r = sock.send_to(data, addr);
            let _ = sock.set_ttl(old);
            r.map_err(|e| e.to_string())?;
        } else {
            sock.send_to(data, addr).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn close(&self, id: u32) {
        if let Ok(mut s) = self.sockets.lock() {
            s.remove(&id);
        }
    }

    /// Waits up to `wait_ms` for datagrams and returns what is queued (at most 256).
    pub fn recv(&self, wait_ms: u64) -> Vec<Datagram> {
        let deadline = Instant::now() + Duration::from_millis(wait_ms.min(1000));
        let mut q = match self.shared.queue.lock() {
            Ok(q) => q,
            Err(_) => return vec![],
        };
        while q.is_empty() {
            let now = Instant::now();
            if now >= deadline {
                return vec![];
            }
            q = match self.shared.ready.wait_timeout(q, deadline - now) {
                Ok((g, _)) => g,
                Err(_) => return vec![],
            };
        }
        let n = q.len().min(256);
        q.drain(..n).collect()
    }
}

/// The first private IPv4 address of this machine (asks the OS which address it would use
/// for the internet; no packet is sent).
pub fn lan_address() -> Option<String> {
    let s = UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("192.0.2.1:9").ok()?;
    match s.local_addr().ok()?.ip() {
        std::net::IpAddr::V4(ip) if is_private_v4(ip) => Some(ip.to_string()),
        _ => None,
    }
}

pub fn is_private_v4(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    o[0] == 10 || (o[0] == 192 && o[1] == 168) || (o[0] == 172 && (16..=31).contains(&o[1]))
}

/// M-SEARCH for an Internet Gateway Device; the raw answers (at most 20).
pub fn ssdp(timeout_ms: u64) -> Vec<String> {
    let mut out = vec![];
    let sock = match UdpSocket::bind("0.0.0.0:0") {
        Ok(s) => s,
        Err(_) => return out,
    };
    let q = "M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 1\r\nST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n\r\n";
    if sock.send_to(q.as_bytes(), "239.255.255.250:1900").is_err() {
        return out;
    }
    let deadline = Instant::now() + Duration::from_millis(timeout_ms.clamp(200, 5000));
    let mut buf = [0u8; 4096];
    while out.len() < 20 {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() || sock.set_read_timeout(Some(left)).is_err() {
            break;
        }
        match sock.recv_from(&mut buf) {
            Ok((n, _)) => out.push(String::from_utf8_lossy(&buf[..n]).into_owned()),
            Err(_) => break,
        }
    }
    out
}

/// `http://a.b.c.d[:port]/path` with a private IPv4 host, else None.
pub fn parse_lan_url(url: &str) -> Option<(Ipv4Addr, u16, String)> {
    let rest = url.strip_prefix("http://")?;
    let (hostport, path) = match rest.find('/') {
        Some(i) => (&rest[..i], rest[i..].to_string()),
        None => (rest, "/".to_string()),
    };
    let (host, port) = match hostport.rsplit_once(':') {
        Some((h, p)) => (h, p.parse::<u16>().ok()?),
        None => (hostport, 80),
    };
    let ip: Ipv4Addr = host.parse().ok()?;
    if !is_private_v4(ip) || port == 0 || path.contains(['\r', '\n', ' ']) {
        return None;
    }
    Some((ip, port, path))
}

/// GET a description or POST a SOAP call to the router; LAN only, 3 s and 64 KB at most.
pub fn lan_http(url: &str, method: &str, soap_action: &str, body: &str) -> Result<(u16, String), String> {
    let (ip, port, path) = parse_lan_url(url).ok_or("only http to a LAN address")?;
    if soap_action.contains(['\r', '\n']) {
        return Err("bad header".into());
    }
    let mut s = TcpStream::connect_timeout(&SocketAddr::from((ip, port)), Duration::from_secs(3)).map_err(|e| e.to_string())?;
    s.set_read_timeout(Some(Duration::from_secs(3))).map_err(|e| e.to_string())?;
    s.set_write_timeout(Some(Duration::from_secs(3))).map_err(|e| e.to_string())?;
    let req = if method == "POST" {
        format!(
            "POST {path} HTTP/1.1\r\nHost: {ip}:{port}\r\nContent-Type: text/xml; charset=\"utf-8\"\r\nSOAPAction: {soap_action}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    } else {
        format!("GET {path} HTTP/1.1\r\nHost: {ip}:{port}\r\nConnection: close\r\n\r\n")
    };
    s.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
    let mut answer = Vec::new();
    let mut buf = [0u8; 4096];
    loop {
        match s.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                answer.extend_from_slice(&buf[..n]);
                if answer.len() > MAX_HTTP_ANSWER {
                    return Err("answer too large".into());
                }
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    parse_http_answer(&answer)
}

pub fn parse_http_answer(raw: &[u8]) -> Result<(u16, String), String> {
    let text = String::from_utf8_lossy(raw);
    let status: u16 = text.split_whitespace().nth(1).and_then(|s| s.parse().ok()).ok_or("not HTTP")?;
    let body = match text.find("\r\n\r\n") {
        Some(i) => text[i + 4..].to_string(),
        None => String::new(),
    };
    Ok((status, body))
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn b64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { B64[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { B64[n as usize & 63] as char } else { '=' });
    }
    out
}

pub fn b64_decode(s: &str) -> Option<Vec<u8>> {
    let s = s.trim_end_matches('=');
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let mut acc: u32 = 0;
    let mut bits = 0;
    for c in s.bytes() {
        let v = B64.iter().position(|&x| x == c)? as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn datagrams_between_two_sockets() {
        let hub = NetHub::new();
        let (a, _) = hub.open().unwrap();
        let (b, pb) = hub.open().unwrap();
        hub.send(a, "127.0.0.1", pb, b"hello", 3).unwrap();
        let got = hub.recv(1000);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].id, b);
        assert_eq!(got[0].data, b"hello");
        assert_eq!(got[0].host, "127.0.0.1");
        assert!(hub.send(a, "127.0.0.1", 0, b"x", 0).is_err());
        assert!(hub.send(a, "127.0.0.1", pb, &[0u8; 5000], 0).is_err());
        hub.close(a);
        assert!(hub.send(a, "127.0.0.1", pb, b"x", 0).is_err());
        assert!(hub.recv(50).is_empty());
    }

    #[test]
    fn lan_urls_only() {
        assert_eq!(parse_lan_url("http://192.168.1.1:5000/rootDesc.xml"), Some(("192.168.1.1".parse().unwrap(), 5000, "/rootDesc.xml".into())));
        assert_eq!(parse_lan_url("http://10.0.0.1"), Some(("10.0.0.1".parse().unwrap(), 80, "/".into())));
        for u in ["https://192.168.1.1/", "http://8.8.8.8/", "http://example.com/", "http://192.168.1.1/a b", "http://172.32.0.1/"] {
            assert_eq!(parse_lan_url(u), None, "{u}");
        }
        assert!(lan_http("http://93.184.216.34/", "GET", "", "").is_err());
    }

    #[test]
    fn http_answer() {
        assert_eq!(parse_http_answer(b"HTTP/1.1 500 Internal\r\nX: y\r\n\r\n<errorCode>718</errorCode>").unwrap(), (500, "<errorCode>718</errorCode>".into()));
        assert!(parse_http_answer(b"garbage").is_err());
    }

    #[test]
    fn base64_round_trip() {
        for n in 0..70usize {
            let data: Vec<u8> = (0..n).map(|i| (i * 37 + 5) as u8).collect();
            assert_eq!(b64_decode(&b64_encode(&data)).unwrap(), data);
        }
        assert_eq!(b64_encode(b"hi"), "aGk=");
        assert!(b64_decode("*").is_none());
    }
}
