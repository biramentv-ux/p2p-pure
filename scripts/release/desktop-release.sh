#!/usr/bin/env bash
# Desktop releases are immutable once published: files can only be added while the release is a
# draft. Windows and Linux share one release, so both workflows go through this script:
#
#   desktop-release.sh attach TAG DIR SHA NOTES_FILE
#       create the draft if the other platform has not, upload DIR/*, and publish the draft only
#       when every file in REQUIRED_ASSETS is there (so the platform that finishes last publishes).
#   desktop-release.sh wait TAG MINUTES
#       block until the release is published (the install checks need public download links).
#
# Needs GH_TOKEN and GITHUB_REPOSITORY. REQUIRED_ASSETS is a space-separated list of file names.
set -euo pipefail

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
REQUIRED_ASSETS="${REQUIRED_ASSETS:-P2P-Messenger-Setup-x64.exe SHA256SUMS-linux.txt}"

# "<id> <draft>" of the release with this tag, or nothing. Drafts are not found by tag in the REST
# API, so the list is searched.
find_release() {
  gh api "repos/$GITHUB_REPOSITORY/releases" --paginate \
    --jq ".[] | select(.tag_name == \"$1\") | \"\(.id) \(.draft)\"" | sed -n 1p
}

attach() {
  local tag="$1" dir="$2" sha="$3" notes="$4" info id draft
  case "$tag" in desktop-v*) ;; *) echo "::error::release tag must start with desktop-v"; exit 1 ;; esac
  info="$(find_release "$tag")"
  if [ -n "$info" ] && [ "${info#* }" = "false" ]; then
    echo "::error::release $tag is already published and immutable: no more files can be added. Use a new version/tag, or delete the release first."
    exit 1
  fi
  if [ -z "$info" ]; then
    gh release create "$tag" --draft --prerelease --target "$sha" --title "P2P Messenger $tag" --notes-file "$notes"
  fi
  gh release upload "$tag" "$dir"/* --clobber

  info="$(find_release "$tag")"
  id="${info%% *}"; draft="${info#* }"
  [ -n "$id" ] || { echo "::error::release $tag disappeared"; exit 1; }
  local names missing=""
  names="$(gh api "repos/$GITHUB_REPOSITORY/releases/$id" --jq '.assets[].name')"
  for a in $REQUIRED_ASSETS; do
    printf '%s\n' "$names" | grep -qxF "$a" || missing="$missing $a"
  done
  if [ -n "$missing" ]; then
    echo "::notice title=release-draft::$tag stays a draft until the other platform adds:$missing"
    echo "published=false" >> "${GITHUB_OUTPUT:-/dev/null}"
    return 0
  fi
  if [ "$draft" = "true" ]; then
    gh release edit "$tag" --draft=false
  fi
  echo "::notice title=release-published::$tag published with every required file"
  echo "published=true" >> "${GITHUB_OUTPUT:-/dev/null}"
}

wait_published() {
  local tag="$1" minutes="$2" deadline info
  deadline=$(( $(date +%s) + minutes * 60 ))
  while :; do
    info="$(find_release "$tag")"
    if [ -n "$info" ] && [ "${info#* }" = "false" ]; then
      echo "release $tag is published"
      return 0
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "::error::release $tag was not published within $minutes minutes: the other platform's workflow did not finish or failed"
      return 1
    fi
    sleep "${WAIT_SLEEP:-20}"
  done
}

cmd="${1:-}"; shift || true
case "$cmd" in
  attach) [ $# -eq 4 ] || { echo "usage: $0 attach TAG DIR SHA NOTES_FILE" >&2; exit 2; }; attach "$@" ;;
  wait) [ $# -eq 2 ] || { echo "usage: $0 wait TAG MINUTES" >&2; exit 2; }; wait_published "$@" ;;
  *) echo "usage: $0 attach|wait ..." >&2; exit 2 ;;
esac
