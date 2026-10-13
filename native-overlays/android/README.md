# Android overlay: passkeys in the WebView (Digital Asset Links)

Android lets an app use a website's passkeys only when the website confirms the app.
Google checks the Digital Asset Links file on the domain.

1. The website serves `https://dyrakarmy.online/.well-known/assetlinks.json` (this repo:
   `public/.well-known/assetlinks.json`). It lists the Android package name and the SHA-256
   fingerprint of the signing certificate.
2. The app's package name and certificate fingerprint must match exactly.
3. Check the file: `https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://dyrakarmy.online&relation=delegate_permission/common.get_login_creds`

## Steps

1. Pick the package name (placeholder: `com.dyrakarmy.p2pmessenger`, same as in `capacitor.config`).
2. Get the SHA-256 of the signing key:
   `keytool -list -v -keystore <keystore> -alias <alias>` (use the upload key and, when Play App
   Signing is on, also the Play signing key from Play Console).
3. Replace `REPLACE_WITH_SHA256_FINGERPRINT` in `public/.well-known/assetlinks.json` and deploy.
4. Capacitor Android WebView: passkeys go through the Credential Manager. The WebView must be
   configured for WebAuthn; this is the native part still to write (see `MainActivity` note below).

## Native part still to write (not in this repo yet)

`WebAuthnBridge` in `MainActivity`: the WebView must hand `navigator.credentials` calls to the
Android Credential Manager. Until it exists, passkey calls inside the Android WebView may fail; the app then
shows the error and the user can use the browser flow as a fallback.

## Not verified here

No Android device or Android Studio was used to write this overlay. Treat it as a plan until the
steps above are run on a real device.
