#!/usr/bin/env bash
# Builds the Flatpak bundle from the unpacked Electron app.
#
#   bash scripts/linux/build-flatpak.sh [OUT_DIR]        (default: out)
#
# Needs: flatpak, flatpak-builder, and the runtime/SDK/BaseApp from Flathub
#   flatpak install flathub org.freedesktop.Platform//25.08 org.freedesktop.Sdk//25.08 org.electronjs.Electron2.BaseApp//25.08
# and electron/release/linux-unpacked (npm run build:desktop && npm --prefix electron run dist:dir).
# Result: OUT_DIR/P2P-Messenger-<version>-x86_64.flatpak. Nothing here needs a secret.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
out="${1:-out}"
app_id="bg.p2pmessenger.app"
version="$(node -p "require('$root/electron/package.json').version")"
unpacked="$root/electron/release/linux-unpacked"
[ -x "$unpacked/p2p-messenger" ] || { echo "missing $unpacked/p2p-messenger: run 'npm --prefix electron run dist:dir' first" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
src="$work/flatpak"
mkdir -p "$src" "$out"
cp "$root"/flatpak/{p2p-messenger.sh,"$app_id".desktop,"$app_id".metainfo.xml} "$src/"
cp "$root/public/icons/icon-512.png" "$src/icon-512.png"

# Reproducible archive of the app (sorted names, fixed owner and time), so the checksum is stable.
tar --sort=name --owner=0 --group=0 --numeric-owner --mtime='2000-01-01 UTC' \
  -C "$unpacked" -czf "$src/p2p-messenger-app.tar.gz" .
sha="$(sha256sum "$src/p2p-messenger-app.tar.gz" | cut -d' ' -f1)"
printf '%s' "$sha" | grep -Eq '^[0-9a-f]{64}$'
sed -e "s/'@APP_SHA256@'/'$sha'/" \
  "$root/flatpak/$app_id.yml" > "$src/$app_id.yml"
grep -q '@APP_SHA256@' "$src/$app_id.yml" && { echo "checksum was not filled in" >&2; exit 1; }

# Checks of the packaging files, when the tools are there (CI installs them).
command -v desktop-file-validate >/dev/null && desktop-file-validate "$src/$app_id.desktop"
command -v appstreamcli >/dev/null && appstreamcli validate --no-net "$src/$app_id.metainfo.xml"

( cd "$src"
  flatpak-builder --force-clean --disable-rofiles-fuse --user --install-deps-from=flathub \
    --repo="$work/repo" "$work/build" "$app_id.yml" )
flatpak build-bundle "$work/repo" "$out/P2P-Messenger-$version-x86_64.flatpak" "$app_id" \
  --runtime-repo=https://dl.flathub.org/repo/flathub.flatpakrepo
ls -la "$out/P2P-Messenger-$version-x86_64.flatpak"
