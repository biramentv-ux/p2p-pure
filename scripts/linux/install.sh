#!/usr/bin/env bash
# Инсталира P2P Messenger на Linux от GitHub Release, след проверка на контролната сума.
#
#   Debian/Ubuntu/Mint  -> .deb      (apt)
#   Fedora/RHEL/openSUSE -> .rpm     (dnf или zypper)
#   всичко останало, или с --appimage -> AppImage, само за теб, без root
#
# Употреба:
#   bash install.sh                  най-новото издание
#   bash install.sh --version 0.7.0  конкретна версия
#   bash install.sh --appimage       AppImage в ~/.local, без администраторски права
#   bash install.sh --uninstall      премахва програмата (данните ти остават)
#   bash install.sh --dry-run        само показва какво ще направи
#   bash install.sh --from-dir ПАПКА файловете вече са изтеглени в ПАПКА (без интернет)
#
# Скриптът не вика нищо от интернет освен самите файлове на Release-а. Всичко се проверява
# със SHA256SUMS-linux.txt преди да се инсталира.
set -euo pipefail

REPO="${P2P_REPO:-biramentv-ux/p2p-pure}"
VERSION=""
FROM_DIR=""
FORCE_APPIMAGE=0
UNINSTALL=0
DRY=0

say() { printf '%s\n' "$*"; }
die() { printf 'ГРЕШКА: %s\n' "$*" >&2; exit 1; }
run() { if [ "$DRY" = 1 ]; then printf '  (само показва) %s\n' "$*"; else "$@"; fi; }

while [ $# -gt 0 ]; do
  case "$1" in
    --version) [ $# -ge 2 ] || die "--version иска стойност"; VERSION="${2#v}"; shift 2 ;;
    --from-dir) [ $# -ge 2 ] || die "--from-dir иска папка"; FROM_DIR="$2"; shift 2 ;;
    --appimage) FORCE_APPIMAGE=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "непознат параметър: $1 (виж --help)" ;;
  esac
done

[ "$(uname -s)" = "Linux" ] || die "Този скрипт е само за Linux."
case "$(uname -m)" in
  x86_64|amd64) ARCH_DEB=amd64; ARCH_RPM=x86_64 ;;
  *) die "Засега има пакет само за 64-битов x86 (x86_64). Твоята система е $(uname -m)." ;;
esac

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 && SUDO="sudo"
fi
need_root() { [ -n "$SUDO" ] || [ "$(id -u)" -eq 0 ] || die "Трябват администраторски права (sudo) или използвай --appimage."; }

APP_HOME="${XDG_DATA_HOME:-$HOME/.local/share}/p2p-messenger"
BIN_LINK="$HOME/.local/bin/p2p-messenger"
DESKTOP_FILE="${XDG_DATA_HOME:-$HOME/.local/share}/applications/p2p-messenger.desktop"

pick_kind() {
  if [ "$FORCE_APPIMAGE" = 1 ]; then echo appimage
  elif command -v apt-get >/dev/null 2>&1 && command -v dpkg >/dev/null 2>&1; then echo deb
  elif command -v dnf >/dev/null 2>&1 || command -v zypper >/dev/null 2>&1; then echo rpm
  else echo appimage; fi
}

# ---------------------------------------------------------------------------- премахване
if [ "$UNINSTALL" = 1 ]; then
  removed=0
  # Първо това, което е само за теб (не иска права), после системният пакет.
  if [ -e "$APP_HOME" ] || [ -L "$BIN_LINK" ] || [ -e "$DESKTOP_FILE" ]; then
    run rm -rf "$APP_HOME"; run rm -f "$BIN_LINK" "$DESKTOP_FILE"; removed=1
  fi
  if command -v dpkg-query >/dev/null 2>&1 && dpkg-query -W -f='${Status}' p2p-messenger 2>/dev/null | grep -q 'install ok installed'; then
    need_root; run $SUDO apt-get remove -y p2p-messenger; removed=1
  elif command -v rpm >/dev/null 2>&1 && rpm -q p2p-messenger >/dev/null 2>&1; then
    need_root
    if command -v dnf >/dev/null 2>&1; then run $SUDO dnf remove -y p2p-messenger
    elif command -v zypper >/dev/null 2>&1; then run $SUDO zypper --non-interactive remove p2p-messenger
    else run $SUDO rpm -e p2p-messenger; fi
    removed=1
  fi
  if [ "$removed" = 1 ]; then say "Премахнато."; else say "Не намерих инсталиран P2P Messenger."; fi
  say "Профилът, контактите и историята ти (шифровани) остават в: ${XDG_CONFIG_HOME:-$HOME/.config}/p2p-messenger"
  say "За да ги изтриеш завинаги, махни тази папка сам."
  exit 0
fi

# ---------------------------------------------------------------------------- изтегляне
fetch() { # fetch URL OUTFILE
  if command -v curl >/dev/null 2>&1; then curl -fsSL --proto '=https' --tlsv1.2 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then wget -q --https-only -O "$2" "$1"
  else die "Трябва curl или wget."; fi
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
BASE_URL=""

if [ -z "$FROM_DIR" ]; then
  if [ -z "$VERSION" ]; then
    say "Търся най-новото издание…"
    fetch "https://api.github.com/repos/$REPO/releases?per_page=30" "$WORK/releases.json" || die "Не успях да чета изданията на $REPO."
    for tag in $(grep -o '"tag_name": *"desktop-v[^"]*"' "$WORK/releases.json" | sed 's/.*"desktop-v\([^"]*\)"/\1/'); do
      if fetch "https://github.com/$REPO/releases/download/desktop-v$tag/SHA256SUMS-linux.txt" "$WORK/SHA256SUMS-linux.txt" 2>/dev/null; then VERSION="$tag"; break; fi
    done
    [ -n "$VERSION" ] || die "Няма издание с Linux пакет в $REPO. Задай --version или --from-dir."
  fi
  BASE_URL="https://github.com/$REPO/releases/download/desktop-v$VERSION"
else
  [ -d "$FROM_DIR" ] || die "Няма такава папка: $FROM_DIR"
  if [ -z "$VERSION" ]; then
    f="$(ls "$FROM_DIR"/P2P-Messenger-*-amd64.deb 2>/dev/null | head -1 || true)"
    [ -n "$f" ] || die "В $FROM_DIR няма P2P-Messenger-*-amd64.deb."
    VERSION="$(basename "$f" | sed 's/^P2P-Messenger-\(.*\)-amd64\.deb$/\1/')"
  fi
fi

KIND="$(pick_kind)"
case "$KIND" in
  deb) FILE="P2P-Messenger-$VERSION-$ARCH_DEB.deb" ;;
  rpm) FILE="P2P-Messenger-$VERSION-$ARCH_RPM.rpm" ;;
  appimage) FILE="P2P-Messenger-$VERSION-$ARCH_RPM.AppImage" ;;
esac
say "Версия $VERSION, вид на пакета: $KIND ($FILE)"

if [ "$DRY" = 1 ]; then
  say "  (само показва) изтегляне и проверка на $FILE и SHA256SUMS-linux.txt"
else
  if [ -n "$FROM_DIR" ]; then
    cp "$FROM_DIR/$FILE" "$WORK/$FILE"; cp "$FROM_DIR/SHA256SUMS-linux.txt" "$WORK/SHA256SUMS-linux.txt"
  else
    [ -s "$WORK/SHA256SUMS-linux.txt" ] || fetch "$BASE_URL/SHA256SUMS-linux.txt" "$WORK/SHA256SUMS-linux.txt"
    say "Свалям $FILE…"
    fetch "$BASE_URL/$FILE" "$WORK/$FILE"
  fi
  want="$(grep -E "^[0-9a-f]{64} +\*?$FILE\$" "$WORK/SHA256SUMS-linux.txt" | awk '{print $1}' | head -1 || true)"
  [ -n "$want" ] || die "В SHA256SUMS-linux.txt няма ред за $FILE."
  have="$(sha256sum "$WORK/$FILE" | awk '{print $1}')"
  [ "$want" = "$have" ] || die "Контролната сума не съвпада (очаквана $want, получена $have). Файлът не е инсталиран."
  say "Контролната сума съвпада."
fi

# ---------------------------------------------------------------------------- инсталиране
case "$KIND" in
  deb)
    need_root
    run $SUDO apt-get install -y "$WORK/$FILE"
    ;;
  rpm)
    need_root
    if command -v dnf >/dev/null 2>&1; then run $SUDO dnf install -y "$WORK/$FILE"
    else run $SUDO zypper --non-interactive --no-gpg-checks install "$WORK/$FILE"; fi
    ;;
  appimage)
    if [ -r /proc/sys/kernel/apparmor_restrict_unprivileged_userns ] && [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns)" = 1 ]; then
      say "ВНИМАНИЕ: тази система (Ubuntu 23.10+) забранява sandbox-а на AppImage."
      say "Ако програмата не се отвори, ползвай .deb (стартирай скрипта без --appimage)."
    fi
    run mkdir -p "$APP_HOME" "$(dirname "$BIN_LINK")" "$(dirname "$DESKTOP_FILE")"
    run install -m 755 "$WORK/$FILE" "$APP_HOME/P2P-Messenger.AppImage"
    run ln -sf "$APP_HOME/P2P-Messenger.AppImage" "$BIN_LINK"
    if [ "$DRY" != 1 ]; then
      ( cd "$WORK" && "$APP_HOME/P2P-Messenger.AppImage" --appimage-extract usr/share/icons/hicolor/512x512/apps/p2p-messenger.png >/dev/null 2>&1 \
        && cp squashfs-root/usr/share/icons/hicolor/512x512/apps/p2p-messenger.png "$APP_HOME/icon.png" ) 2>/dev/null || true
      cat > "$DESKTOP_FILE" <<DESK
[Desktop Entry]
Name=P2P Messenger
Comment=Encrypted peer-to-peer messenger
Exec="$APP_HOME/P2P-Messenger.AppImage" %U
Icon=$( [ -f "$APP_HOME/icon.png" ] && echo "$APP_HOME/icon.png" || echo p2p-messenger )
Terminal=false
Type=Application
Categories=Network;InstantMessaging;Chat;
StartupWMClass=p2p-messenger
DESK
    fi
    case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) say "Съвет: добави $HOME/.local/bin към PATH, за да пишеш просто 'p2p-messenger'." ;; esac
    ;;
esac

say "Готово. Отвори "P2P Messenger" от менюто с програми или напиши: p2p-messenger"
say "Данните ти (шифровани) са в: ${XDG_CONFIG_HOME:-$HOME/.config}/p2p-messenger"
