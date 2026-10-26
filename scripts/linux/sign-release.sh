#!/usr/bin/env bash
# Signs the Linux release files in a folder with the release GPG key (CI, release job only).
#
#   bash scripts/linux/sign-release.sh OUT_DIR
#
# Needs: the private key already imported into $GNUPGHOME (or ~/.gnupg), SIGNING_FPR set to its
# full fingerprint, and optionally GPG_PASSPHRASE_FILE (a file holding the passphrase).
#
# What it does, in this order (the order matters, because signing changes the files):
#   1. rpm --addsign on every .rpm               (dnf/zypper check this signature)
#   2. pins SIGNING_FPR inside install.sh         (install.sh then demands a valid signature)
#   3. writes SHA256SUMS-linux.txt again          (the .rpm and install.sh changed)
#   4. SHA256SUMS-linux.txt.asc                   (detached, ASCII-armoured signature)
#   5. p2p-messenger-signing-key.asc              (public key, for people and for install.sh)
#      p2p-messenger-archive-keyring.gpg          (same key, binary, for apt "signed-by")
#
# The .deb is NOT signed inside: dpkg never checks embedded signatures (dpkg-sig is gone from
# Debian since 12 and debsigs is off by default), so that would be decoration. Debian and Ubuntu
# trust packages through the signed APT "InRelease" file (scripts/linux/build-repo.sh), and a
# downloaded .deb through the signed SHA256SUMS-linux.txt.asc.
set -euo pipefail

OUT="${1:?usage: sign-release.sh OUT_DIR}"
FPR="${SIGNING_FPR:?SIGNING_FPR must be the full key fingerprint}"
[ "${#FPR}" -eq 40 ] || { echo "SIGNING_FPR must be 40 hex characters" >&2; exit 1; }

GPG=(gpg --batch --yes)
if [ -n "${GPG_PASSPHRASE_FILE:-}" ]; then
  GPG+=(--pinentry-mode loopback --passphrase-file "$GPG_PASSPHRASE_FILE")
fi
gpg --batch --list-secret-keys "$FPR" >/dev/null || { echo "secret key $FPR is not in the keyring" >&2; exit 1; }

cd "$OUT"

shopt -s nullglob
for rpm in *.rpm; do
  extra="--batch --no-tty"
  [ -n "${GPG_PASSPHRASE_FILE:-}" ] && extra="$extra --pinentry-mode loopback --passphrase-file $GPG_PASSPHRASE_FILE"
  rpmsign --define "_gpg_name $FPR" --define "_gpg_sign_cmd_extra_args $extra" --addsign "$rpm"
  echo "signed $rpm"
done

if [ -f install.sh ]; then
  sed -i "s/^PINNED_FPR_DEFAULT=\"[0-9A-Fa-f]*\"\$/PINNED_FPR_DEFAULT=\"$FPR\"/" install.sh
  grep -q "^PINNED_FPR_DEFAULT=\"$FPR\"\$" install.sh || { echo "could not pin the fingerprint in install.sh" >&2; exit 1; }
fi

gpg --batch --yes --armor --export "$FPR" > p2p-messenger-signing-key.asc
gpg --batch --yes --export "$FPR" > p2p-messenger-archive-keyring.gpg

rm -f SHA256SUMS-linux.txt SHA256SUMS-linux.txt.asc
files=(P2P-Messenger-* install.sh p2p-messenger-signing-key.asc p2p-messenger-archive-keyring.gpg)
sha256sum "${files[@]}" > SHA256SUMS-linux.txt
"${GPG[@]}" --local-user "$FPR" --armor --detach-sign --output SHA256SUMS-linux.txt.asc SHA256SUMS-linux.txt

# Prove it before anything is published: a fresh keyring that holds only the exported public key.
check="$(mktemp -d)"
trap 'rm -rf "$check"' EXIT
gpg --homedir "$check" --batch --quiet --import p2p-messenger-signing-key.asc
gpg --homedir "$check" --batch --status-fd 1 --verify SHA256SUMS-linux.txt.asc SHA256SUMS-linux.txt | grep "VALIDSIG .*$FPR" >/dev/null
for rpm in *.rpm; do
  rpm --dbpath "$check/rpmdb" --initdb
  rpm --dbpath "$check/rpmdb" --import p2p-messenger-signing-key.asc
  rpm --dbpath "$check/rpmdb" -K "$rpm" | tee /dev/stderr | grep -Ei 'digests signatures OK|pgp.*OK' >/dev/null
done
sha256sum -c SHA256SUMS-linux.txt
echo "signed with $FPR"
