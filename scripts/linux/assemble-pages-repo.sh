#!/usr/bin/env bash
# Puts the signed Linux update channel (APT + dnf) into the GitHub Pages site, next to the
# web app, under <site>/linux/. Run by .github/workflows/pages.yml after the web build.
#
#   bash scripts/linux/assemble-pages-repo.sh DEST_DIR      (e.g. dist/linux)
#
# Takes the newest desktop-v* release that carries p2p-messenger-linux-repo.tar.gz (made and
# signed by the Linux release job), unpacks the signed metadata and downloads the packages it
# names from the same release. Nothing is signed here and no key is needed: the metadata is
# already signed, and every package must match the SHA-256 listed for it (apt and dnf check
# the same hashes again through the signed InRelease / repomd.xml).
# No signed release yet: does nothing and exits 0, so the web app deploys as before.
set -euo pipefail

DEST="${1:?usage: assemble-pages-repo.sh DEST_DIR}"
REPO="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set}"
ASSET=p2p-messenger-linux-repo.tar.gz

tag="$(gh api "repos/$REPO/releases?per_page=30" \
  --jq "[.[] | select(.tag_name | startswith(\"desktop-v\")) | select(any(.assets[]; .name == \"$ASSET\"))][0].tag_name // \"\"")"
if [ -z "$tag" ]; then
  echo "::notice title=linux-repo::no signed desktop release yet; the site has no /linux/ update channel"
  exit 0
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
gh release download "$tag" --repo "$REPO" --pattern "$ASSET" --dir "$work"
mkdir -p "$DEST"
tar -xzf "$work/$ASSET" -C "$DEST" --strip-components=1 --no-same-owner
[ -s "$DEST/ASSETS" ] || { echo "::error::$ASSET has no ASSETS list"; exit 1; }

while read -r sha path name; do
  case "$path" in apt/pool/main/*.deb|rpm/*.rpm) ;; *) echo "::error::unexpected path $path"; exit 1 ;; esac
  case "$name" in */*|..*) echo "::error::unexpected asset name $name"; exit 1 ;; esac
  gh release download "$tag" --repo "$REPO" --pattern "$name" --dir "$work" --clobber
  echo "$sha  $work/$name" | sha256sum -c --quiet
  mkdir -p "$DEST/$(dirname "$path")"
  mv "$work/$name" "$DEST/$path"
done < "$DEST/ASSETS"
rm -f "$DEST/ASSETS"
echo "::notice title=linux-repo::update channel from $tag in $DEST"
find "$DEST" -type f | sort
