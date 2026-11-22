//! П6 (experiment): the JNI side of `bg.p2pmessenger.app.TorPlugin`. A thin wrapper: one tokio
//! runtime, one TorHub (src-tauri/src/tor_net.rs, the same code as on the desktop), and five
//! calls that block a Java worker thread (never the UI thread: TorPlugin runs them on an executor).

#[allow(dead_code)] // status() is for the desktop app
#[path = "../../src-tauri/src/tor_net.rs"]
mod tor_net;

use jni::objects::{JByteArray, JClass, JString};
use jni::sys::{jint, jlong, jstring};
use jni::JNIEnv;
use std::sync::{Arc, OnceLock};
use tor_net::{Event, TorHub};

fn runtime() -> &'static tokio::runtime::Runtime {
    static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RT.get_or_init(|| tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("tokio runtime"))
}

fn hub() -> &'static Arc<TorHub> {
    static HUB: OnceLock<Arc<TorHub>> = OnceLock::new();
    HUB.get_or_init(TorHub::new)
}

fn throw(env: &mut JNIEnv, msg: &str) {
    let _ = env.throw_new("java/io/IOException", msg);
}

fn string(env: &mut JNIEnv, s: &JString) -> Option<String> {
    env.get_string(s).ok().map(|s| s.into())
}

/// Base64 (standard, with padding) for the JSON of nativeRecv; Java decodes it with android.util.Base64.
fn b64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

/// Events as a JSON array: [{"id":1,"kind":"open","incoming":true},{"id":1,"kind":"data","data":"..."}].
fn events_json(events: Vec<Event>) -> String {
    let parts: Vec<String> = events
        .into_iter()
        .map(|e| match e {
            Event::Open { id, incoming } => format!("{{\"id\":{id},\"kind\":\"open\",\"incoming\":{incoming}}}"),
            Event::Data { id, data } => format!("{{\"id\":{id},\"kind\":\"data\",\"data\":\"{}\"}}", b64(&data)),
            Event::Close { id } => format!("{{\"id\":{id},\"kind\":\"close\"}}"),
        })
        .collect();
    format!("[{}]", parts.join(","))
}

#[no_mangle]
pub extern "system" fn Java_bg_p2pmessenger_app_TorPlugin_nativeStart(mut env: JNIEnv, _c: JClass, state: JString, cache: JString) -> jstring {
    let (Some(state), Some(cache)) = (string(&mut env, &state), string(&mut env, &cache)) else {
        throw(&mut env, "bad directories");
        return std::ptr::null_mut();
    };
    let hub = Arc::clone(hub());
    match runtime().block_on(async move { hub.start(state.into(), cache.into()).await }) {
        Ok(onion) => env.new_string(onion).map(|s| s.into_raw()).unwrap_or(std::ptr::null_mut()),
        Err(e) => {
            throw(&mut env, &e);
            std::ptr::null_mut()
        }
    }
}

#[no_mangle]
pub extern "system" fn Java_bg_p2pmessenger_app_TorPlugin_nativeConnect(mut env: JNIEnv, _c: JClass, onion: JString) -> jlong {
    let Some(onion) = string(&mut env, &onion) else {
        throw(&mut env, "bad address");
        return 0;
    };
    let hub = Arc::clone(hub());
    match runtime().block_on(async move { hub.connect(&onion).await }) {
        Ok(id) => id as jlong,
        Err(e) => {
            throw(&mut env, &e);
            0
        }
    }
}

#[no_mangle]
pub extern "system" fn Java_bg_p2pmessenger_app_TorPlugin_nativeSend(mut env: JNIEnv, _c: JClass, id: jlong, data: JByteArray) {
    let Ok(bytes) = env.convert_byte_array(&data) else {
        throw(&mut env, "bad data");
        return;
    };
    let hub = Arc::clone(hub());
    if let Err(e) = runtime().block_on(async move { hub.send(id as u64, &bytes).await }) {
        throw(&mut env, &e);
    }
}

#[no_mangle]
pub extern "system" fn Java_bg_p2pmessenger_app_TorPlugin_nativeClose(_env: JNIEnv, _c: JClass, id: jlong) {
    let hub = Arc::clone(hub());
    runtime().block_on(async move { hub.close(id as u64).await });
}

#[no_mangle]
pub extern "system" fn Java_bg_p2pmessenger_app_TorPlugin_nativeRecv(env: JNIEnv, _c: JClass, wait_ms: jint) -> jstring {
    let hub = Arc::clone(hub());
    let events = runtime().block_on(async move { hub.recv(wait_ms.max(0) as u64).await });
    env.new_string(events_json(events)).map(|s| s.into_raw()).unwrap_or(std::ptr::null_mut())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_the_standard() {
        assert_eq!(b64(b""), "");
        assert_eq!(b64(b"f"), "Zg==");
        assert_eq!(b64(b"fo"), "Zm8=");
        assert_eq!(b64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn events_are_json() {
        let j = events_json(vec![Event::Open { id: 1, incoming: true }, Event::Data { id: 1, data: b"hi".to_vec() }, Event::Close { id: 1 }]);
        assert_eq!(j, "[{\"id\":1,\"kind\":\"open\",\"incoming\":true},{\"id\":1,\"kind\":\"data\",\"data\":\"aGk=\"},{\"id\":1,\"kind\":\"close\"}]");
    }
}
