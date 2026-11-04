# iOS overlay: passkeys in WKWebView (Associated Domains)

The entitlement is already wired into `ios/App/App/App.entitlements`, and the Team ID is put into the
association file by the Pages build (variable `APPLE_TEAM_ID`). Full guide: `docs/IOS.md`.

Passkeys in a Capacitor app (WKWebView) work only when the app is allowed to use the
domain. Apple checks two files:

1. The app declares the domain in its entitlements:

   `webcredentials:dyrakarmy.online`

   Template: `App.entitlements.template`. In Xcode: Signing & Capabilities → Associated Domains.

2. The domain serves `https://dyrakarmy.online/.well-known/apple-app-site-association`
   with `Content-Type: application/json` (no `.json` extension). Template:
   `public/.well-known/apple-app-site-association` in this repo. Replace `TEAMID` with the
   Apple Developer Team ID and the bundle id with the real one.

## Steps

1. In Apple Developer, note the Team ID (10 characters) and create the App ID with the bundle id
   (bundle id: `bg.p2pmessenger.app`, same as `capacitor.config.ts`).
2. Replace `TEAMID` in `public/.well-known/apple-app-site-association` and deploy the site.
3. Check: `curl -sI https://dyrakarmy.online/.well-known/apple-app-site-association` → `200` and
   `content-type: application/json`.
4. In Xcode, add the Associated Domains capability with `webcredentials:dyrakarmy.online`.
5. Build and test on a real iPhone.

## Rules that are not optional

- The rpId stays `dyrakarmy.online`. It must match the domain in the entitlement.
- A passkey is tied to its RP ID. Passkeys created on the web (rpId `dyrakarmy.online`) are only usable in the app if the app uses the same RP ID.
- The app never falls back to a different RP ID: `src/platform/mobile/webBridge.ts` already enforces this.

## Not verified here

This overlay was written without an Apple Developer account or a Mac. The steps above have not been
run on a device. Confirm each step before relying on passkeys in the app.

# iOS overlay: BLE first-contact pairing (`BlePairing` plugin)

Files: `BlePairingPlugin.swift` (CoreBluetooth transport) and `MainViewController.swift`
(subclass of `CAPBridgeViewController`; its `capacitorDidLoad()` registers the plugin with
`bridge?.registerPluginInstance(BlePairingPlugin())`, because app-local Capacitor 8 plugins
are not auto-discovered).

## What `scripts/mobile/sync-overlays.mjs` must do

1. Copy both `.swift` files into `ios/App/App/`.
2. Add `NSBluetoothAlwaysUsageDescription` to `ios/App/App/Info.plist` (without it iOS kills the
   app on the first CoreBluetooth call). Suggested text: "Bluetooth is used to pair with a
   nearby contact without any server."
3. In `ios/App/App/Base.lproj/Main.storyboard` change the view controller from
   `customClass="CAPBridgeViewController" customModule="Capacitor"` to
   `customClass="MainViewController" customModule="App"`.
4. Xcode target membership: the two files must belong to the `App` target. If the Xcode project
   uses a synchronized folder group for `App/`, this happens automatically; with the classic
   file list, add them in Xcode (File, Add Files to "App", tick target "App") or the build fails
   with "cannot find BlePairingPlugin in scope". No background mode is configured on purpose.

## Roles and contract

- Service `3da7960c-96f3-4d14-a3c8-b842772e603e`, RX `7b8af345-7943-48e4-9134-e268f787d5cf`
  (central writes, with response), TX `ae4c0870-c466-48e6-af14-d814739213db` (peripheral notify).
- Initiator is the peripheral: advertises the service and local name `P2P-<TAG>`.
- Responder is the central: scans for the service, reads the tag from the local name (or from
  the service data of an Android advertiser), connects, subscribes to TX; `connect()` resolves
  with `mtu = maximumWriteValueLength(for: .withResponse) + 3`.
- Methods: `checkAvailability`, `requestPermissions`, `startPeripheral({tag})`, `startScan()`,
  `connect({deviceId})`, `send({data})` (base64), `stop()`. Events: `deviceFound`, `connected`,
  `subscribed`, `data`, `disconnected`, `error`.

## Limits

- iOS advertises only while the app is in the foreground. In the background the local name is
  not sent and the service UUID moves to the "overflow area", so pairing must be done with the
  app open on both phones.
- The advertised local name can be truncated or dropped when the advertisement is too big; the
  tag is short on purpose.
- iOS hides the Bluetooth MAC address. `deviceId` is a per-device UUID
  (`peripheral.identifier`) that is stable only on that iPhone and cannot be matched with an
  Android address.
- The first Bluetooth call shows the system permission prompt. Without Bluetooth permission or
  with Bluetooth off, `checkAvailability` returns `unauthorized` or `off`.
- Not compiled or run: written without a Mac (see "Not verified here").

## Manual test (two real phones; the simulator has no Bluetooth)

1. Build the app on an iPhone and on a second phone (iOS or Android) and open it on both.
2. Phone A: start pairing as initiator (shows the tag). Phone B: scan; the device with A's tag
   must appear.
3. Pick it on B. Both sides must reach the connected state and show the same MTU class value
   (iPhone usually 185 or more).
4. Send a short message each way; check that it arrives and the safety code matches.
5. Turn Bluetooth off on one phone: the other must see `disconnected`.
6. Press "stop"/cancel, then start again: no stale state, no hung promise.
