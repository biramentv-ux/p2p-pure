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
