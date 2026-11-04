# Android overlay: passkeys in the WebView (Digital Asset Links)

Android lets an app use a website's passkeys only when the website confirms the app.
Google checks the Digital Asset Links file on the domain.

1. The website serves `https://dyrakarmy.online/.well-known/assetlinks.json` (this repo:
   `public/.well-known/assetlinks.json`). It lists the Android package name and the SHA-256
   fingerprint of the signing certificate.
2. The app's package name and certificate fingerprint must match exactly.
3. Check the file: `https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://dyrakarmy.online&relation=delegate_permission/common.get_login_creds`

## Steps

1. Package name: `bg.p2pmessenger.app` (same as `appId` in `capacitor.config.ts`).
2. Get the SHA-256 of the signing key:
   `keytool -list -v -keystore <keystore> -alias <alias>` (use the upload key and, when Play App
   Signing is on, also the Play signing key from Play Console).
3. Replace `REPLACE_WITH_SHA256_FINGERPRINT` in `public/.well-known/assetlinks.json` and deploy.
4. Capacitor Android WebView: passkeys go through the Credential Manager. The WebView must be
   configured for WebAuthn; this is the native part still to write (see `MainActivity` note below).

## Native bridge (Credential Manager)

Files in this folder (the code is Java, to match the Capacitor Android template):

- `java/bg/p2pmessenger/app/PasskeyBridgePlugin.java`: Capacitor plugin `PasskeyBridge` with
  `create` and `get`. Each takes `{ requestJson }` (WebAuthn options as JSON) and returns
  `{ responseJson }`.
- `java/bg/p2pmessenger/app/MainActivity.java`: registers the plugin before `super.onCreate`.
- JS side: `src/platform/mobile/nativePasskeys.ts` and `passkeyJson.ts`. `src/identity/webauthn.ts`
  uses the bridge only on Android. Web and iOS keep `navigator.credentials`.

### Setup

1. `npm run build`
2. `npx cap add android` (creates `android/`, once).
3. `npx cap sync android`
4. `npm run mobile:sync`. Copies the Java files into `android/app/src/main/java/bg/p2pmessenger/app/`,
   adds the Gradle dependencies and the camera permission. It is safe to run again.
5. Put the real SHA-256 fingerprint into `public/.well-known/assetlinks.json` and deploy the site.
   Without it Credential Manager refuses the rpId and the call fails.
6. Build the web app with `VITE_PASSKEY_RP_ID=dyrakarmy.online` (the native WebView runs on
   `localhost`; the rpId must be the real domain).
7. Open the project with `npx cap open android` and run it on a device.

Dependencies that `mobile:sync` adds (checked against developer.android.com on 2026-10-14; re-check
before a release):

```gradle
implementation "androidx.credentials:credentials:1.6.0"
implementation "androidx.credentials:credentials-play-services-auth:1.6.0"
```

Do not use the 1.7.0-alpha versions: they are not stable.

`npm run mobile:check` lists what is still blocked (placeholders, missing projects).

### What is not verified

- The Java file has not been compiled (no Android SDK in the development environment). Gradle or Kotlin errors are possible.
- PRF (the device unlock secret) through Credential Manager depends on the device and the Play
  Services version. If PRF is missing, `prfSecret` is `null` and identity code falls back to the
  password path, as it does on the web.
- The web path is unchanged. Test on a real Android device before shipping.

## Bluetooth pairing (BlePairingPlugin)

`java/bg/p2pmessenger/app/BlePairingPlugin.java` is the Capacitor plugin `BlePairing`. It moves the
first-contact invitation over Bluetooth Low Energy instead of a QR code. `MainActivity` registers it
next to `PasskeyBridgePlugin`.

- Initiator = GATT peripheral. Advertises the service UUID; the 4-character tag is in the scan
  response as service data (ASCII). The Bluetooth adapter name is never changed.
- Responder = GATT central. Scans with a service UUID filter, reads the tag from the service data
  (fallback: local name `P2P-XXXX`), connects, asks for MTU 517, enables notifications on TX.
- Methods: `checkAvailability({ role? })`, `requestPermissions()`, `startPeripheral({ tag })`,
  `startScan()`, `connect({ deviceId })`, `send({ data })`, `stop()`.
  Events: `deviceFound`, `connected`, `subscribed`, `data`, `disconnected`, `error`.
- `mobile:sync` adds to the manifest: `BLUETOOTH` and `BLUETOOTH_ADMIN` (`maxSdkVersion="30"`),
  `BLUETOOTH_SCAN` (`usesPermissionFlags="neverForLocation"`), `BLUETOOTH_ADVERTISE`,
  `BLUETOOTH_CONNECT` and `<uses-feature android.hardware.bluetooth_le required="false">`. Android 11
  and older also need `ACCESS_FINE_LOCATION` (already there) and the system location switch on, or
  scans return nothing.
- The BLE link is not encrypted or bonded. The pairing protocol on top must protect the data.
- Not compiled and not run on a device (no Android SDK here). Test advertising, scanning, MTU and
  notifications on two real phones, including Android 11 and Android 13+, before shipping.

## Not verified here

No Android device or Android Studio was used to write this overlay. Treat it as a plan until the
steps above are run on a real device.
