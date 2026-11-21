# Handoff
n8-n9-p4-p5-p6 and the tutorial videos are ready (ADR-006…010).

Verified here: vitest (all), tsc -b, oxlint, cargo check (default, native-transport, tor-transport),
NAT lab (WebRTC 6/8 + 2 IPv6 skipped, native 4/4), site build in 8 languages, the 14 videos.

Not verified here:
- Android: NativeNetPlugin and MeshRadioPlugin were never compiled (no Android SDK). Try on the device farm.
- Windows/Tauri native transport on a real router (UPnP/PCP).
- Tor against the real network (no outbound Tor here). Arti on Android: not started.
- IPv6 NAT lab scenarios: CI only.
- Mesh has no UI yet: next step is an outbox and showing mesh messages in the chat.

Security-relevant: Electron now has one narrow preload (window.p2pNative) with an origin check in main.
