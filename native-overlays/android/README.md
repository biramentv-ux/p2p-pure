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

Files in this folder:

- `PasskeyBridgePlugin.kt`: Capacitor plugin `PasskeyBridge` with `create` and `get`. Each takes
  `{ requestJson }` (WebAuthn options as JSON) and returns `{ responseJson }`.
- `MainActivity.snippet.kt`: registers the plugin in `MainActivity`.
- JS side: `src/platform/mobile/nativePasskeys.ts` and `passkeyJson.ts`. `src/identity/webauthn.ts`
  uses the bridge only when the platform is Android. Web and iOS keep `navigator.credentials`.

### Setup

1. `npx cap add android` (creates `android/`). Then `npm run build && npx cap sync android`.
2. Copy `PasskeyBridgePlugin.kt` to `android/app/src/main/java/com/dyrakarmy/p2pmessenger/`.
3. Replace `MainActivity` with the snippet in `MainActivity.snippet.kt`.
4. In `android/app/build.gradle` add the dependencies (latest stable versions, checked against
   developer.android.com on 2026-10-14; re-check before a release):

   ```gradle
   implementation "androidx.credentials:credentials:1.6.0"
   implementation "androidx.credentials:credentials-play-services-auth:1.6.0"
   implementation "androidx.lifecycle:lifecycle-runtime-ktx:2.11.0"
   ```

   Do not use the 1.7.0-alpha or 2.12.0-alpha versions: they are not stable.

5. Put the real SHA-256 fingerprint into `assetlinks.json` (see above). Without it Credential
   Manager refuses the rpId and the call fails.

### What is not verified

- The Kotlin file has not been compiled. Gradle or Kotlin errors are possible.
- PRF (the device unlock secret) through Credential Manager depends on the device and the Play
  Services version. If PRF is missing, `prfSecret` is `null` and identity code falls back to the
  password path, as it does on the web.
- The web path is unchanged. Test on a real Android device before shipping.

## Not verified here

No Android device or Android Studio was used to write this overlay. Treat it as a plan until the
steps above are run on a real device.
