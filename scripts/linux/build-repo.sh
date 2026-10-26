#!/usr/bin/env bash
# Builds a signed APT repository and a signed dnf/zypper repository from the release packages.
#
#   bash scripts/linux/build-repo.sh IN_DIR OUT_DIR
#
# IN_DIR holds the .deb/.rpm (the .rpm already signed by sign-release.sh) and the public key
# files from sign-release.sh. Needs SIGNING_FPR, optional GPG_PASSPHRASE_FILE, and the tools
# apt-ftparchive (apt-utils), createrepo_c, gpg.
#
# OUT_DIR gets (served later under <site>/linux/):
#   apt/dists/stable/{InRelease,Release,Release.gpg}
#   apt/dists/stable/main/binary-amd64/Packages{,.gz}
#   apt/pool/main/p2p-messenger_<version>_amd64.deb
#   rpm/repodata/{repomd.xml,repomd.xml.asc,...}   rpm/<package>.rpm
#   rpm/p2p-messenger.repo                         (needs REPO_BASE_URL)
#   p2p-messenger-archive-keyring.gpg, p2p-messenger-signing-key.asc
#   ASSETS   "<sha256> <path in repo> <release asset name>" for every package, so the Pages
#            build can put the release files back without storing them twice
#            (scripts/linux/assemble-pages-repo.sh)
#
# Only the newest version is kept: this is an update channel, not an archive. Older files stay
# on the GitHub Releases.
set -euo pipefail

IN="$(cd "${1:?usage: build-repo.sh IN_DIR OUT_DIR}" && pwd)"
OUT="${2:?usage: build-repo.sh IN_DIR OUT_DIR}"
FPR="${SIGNING_FPR:?SIGNING_FPR must be the full key fingerprint}"
BASE_URL="${REPO_BASE_URL:-}"

GPG=(gpg --batch --yes --local-user "$FPR")
if [ -n "${GPG_PASSPHRASE_FILE:-}" ]; then
  GPG+=(--pinentry-mode loopback --passphrase-file "$GPG_PASSPHRASE_FILE")
fi

rm -rf "$OUT"
mkdir -p "$OUT/apt/pool/main" "$OUT/apt/dists/stable/main/binary-amd64" "$OUT/rpm"
OUT="$(cd "$OUT" && pwd)"

shopt -s nullglob
debs=("$IN"/*.deb)
rpms=("$IN"/*.rpm)
[ "${#debs[@]}" -gt 0 ] || { echo "no .deb in $IN" >&2; exit 1; }

cp "$IN/p2p-messenger-archive-keyring.gpg" "$IN/p2p-messenger-signing-key.asc" "$OUT/"

# ------------------------------------------------------------------------------------ APT
for deb in "${debs[@]}"; do
  name="$(dpkg-deb -f "$deb" Package)_$(dpkg-deb -f "$deb" Version)_$(dpkg-deb -f "$deb" Architecture).deb"
  cp "$deb" "$OUT/apt/pool/main/$name"
  printf '%s %s %s\n' "$(sha256sum "$deb" | cut -d' ' -f1)" "apt/pool/main/$name" "$(basename "$deb")" >> "$OUT/ASSETS"
done
(
  cd "$OUT/apt"
  apt-ftparchive packages pool/main > dists/stable/main/binary-amd64/Packages
  gzip -9nk dists/stable/main/binary-amd64/Packages
  apt-ftparchive \
    -o APT::FTPArchive::Release::Origin="P2P Messenger" \
    -o APT::FTPArchive::Release::Label="P2P Messenger" \
    -o APT::FTPArchive::Release::Suite=stable \
    -o APT::FTPArchive::Release::Codename=stable \
    -o APT::FTPArchive::Release::Architectures=amd64 \
    -o APT::FTPArchive::Release::Components=main \
    -o APT::FTPArchive::Release::Description="P2P Messenger desktop (Electron) packages" \
    release dists/stable > dists/stable/Release.tmp
  mv dists/stable/Release.tmp dists/stable/Release
  "${GPG[@]}" --clearsign --output dists/stable/InRelease dists/stable/Release
  "${GPG[@]}" --armor --detach-sign --output dists/stable/Release.gpg dists/stable/Release
)

# ------------------------------------------------------------------------------------ dnf
if [ "${#rpms[@]}" -gt 0 ]; then
  for rpm in "${rpms[@]}"; do
    cp "$rpm" "$OUT/rpm/"
    printf '%s %s %s\n' "$(sha256sum "$rpm" | cut -d' ' -f1)" "rpm/$(basename "$rpm")" "$(basename "$rpm")" >> "$OUT/ASSETS"
  done
  createrepo_c --quiet --simple-md-filenames "$OUT/rpm"
  "${GPG[@]}" --armor --detach-sign --output "$OUT/rpm/repodata/repomd.xml.asc" "$OUT/rpm/repodata/repomd.xml"
  if [ -n "$BASE_URL" ]; then
    cat > "$OUT/rpm/p2p-messenger.repo" <<REPO
[p2p-messenger]
name=P2P Messenger
baseurl=${BASE_URL%/}/rpm
enabled=1
gpgcheck=1
repo_gpgcheck=1
gpgkey=${BASE_URL%/}/p2p-messenger-signing-key.asc
REPO
  fi
fi

# ------------------------------------------------------------------------------------ check
check="$(mktemp -d)"
trap 'rm -rf "$check"' EXIT
gpg --homedir "$check" --batch --quiet --import "$OUT/p2p-messenger-signing-key.asc"
gpg --homedir "$check" --batch --status-fd 1 --verify "$OUT/apt/dists/stable/InRelease" 2>/dev/null | grep "VALIDSIG .*$FPR" >/dev/null
gpg --homedir "$check" --batch --status-fd 1 --verify "$OUT/apt/dists/stable/Release.gpg" "$OUT/apt/dists/stable/Release" 2>/dev/null | grep "VALIDSIG .*$FPR" >/dev/null
if [ -f "$OUT/rpm/repodata/repomd.xml.asc" ]; then
  gpg --homedir "$check" --batch --status-fd 1 --verify "$OUT/rpm/repodata/repomd.xml.asc" "$OUT/rpm/repodata/repomd.xml" 2>/dev/null | grep "VALIDSIG .*$FPR" >/dev/null
fi
echo "repository in $OUT signed with $FPR"
find "$OUT" -type f | sort
