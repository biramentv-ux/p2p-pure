#!/bin/sh
# Starts the app inside the Flatpak sandbox (zypak makes Chromium's own sandbox work here).
export TMPDIR="${XDG_RUNTIME_DIR:-/tmp}/app/${FLATPAK_ID:-bg.p2pmessenger.app}"
mkdir -p "$TMPDIR"
export CHROME_DESKTOP="bg.p2pmessenger.app.desktop"
exec zypak-wrapper /app/lib/p2p-messenger/p2p-messenger --ozone-platform-hint=auto "$@"
