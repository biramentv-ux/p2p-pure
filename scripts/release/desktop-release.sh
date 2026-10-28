#!/usr/bin/env bash
# Desktop releases are immutable once published: files can only be added while the release is a
# draft. Windows and Linux share one release, so both workflows go through this script:
#
#   desktop-release.sh attach TAG DIR SHA NOTES_FILE
#       create the draft if the other platform has not, upload DIR/*, and publish the draft only
#       when every file in REQUIRED_ASSETS is there (so the platform that finishes last publishes).
#       The draft records the source commit (SHA). A draft left by an earlier, failed run of the same
#       tag on another commit is deleted first: its files are stale and would otherwise let the
#       first platform publish at once with the other platform's old files.
#   desktop-release.sh wait TAG MINUTES
#       block until the release is published (the install checks need public download links).
#
# Needs GH_TOKEN and GITHUB_REPOSITORY. REQUIRED_ASSETS is a space-separated list of file names.
# RELEASES_REPO (optional, "owner/name"): where the releases live. Unset = this repository. Set it
# to a separate public repository when the source repository is private; GH_TOKEN must then be a
# token that can write releases there (the workflow's own token cannot). See docs/PRIVATE-REPO.md.
set -euo pipefail

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
REL_REPO="${RELEASES_REPO:-$GITHUB_REPOSITORY}"
# Windows installer, Linux checksums, SBOM checksums (release-sbom.yml): the last of the three publishes.
REQUIRED_ASSETS="${REQUIRED_ASSETS:-P2P-Messenger-Setup-x64.exe SHA256SUMS-linux.txt SHA256SUMS-sbom.txt}"

# "<id> <draft>" of the release with this tag, or nothing. Drafts are not found by tag in the REST
# API, so the list is searched.
find_release() {
  gh api "repos/$REL_REPO/releases" --paginate \
    --jq ".[] | select(.tag_name == \"$1\") | \"\(.id) \(.draft)\"" | sed -n 1p
}

# The source commit a draft was made from (the marker in its notes), or nothing.
draft_commit() {
  gh api "repos/$REL_REPO/releases/$1" --jq '.body // ""' | sed -n 's/.*<!-- source-commit: \([0-9a-f]*\) -->.*/\1/p' | sed -n 1p
}

# With a separate public releases repository the source repository is private, so a link to one of
# its files would be a 404 for everyone else. The guides (docs/WINDOWS.md, LINUX.md, SIGNING.md) and
# LICENSE/SECURITY are copied to the public repository by public-docs.yml: point the links there.
public_notes() {
  if [ "$REL_REPO" = "$GITHUB_REPOSITORY" ]; then cat; return; fi
  sed -e "s#github.com/${GITHUB_REPOSITORY}/blob/#github.com/${REL_REPO}/blob/#g" \
      -e "s#github.com/${GITHUB_REPOSITORY}/releases#github.com/${REL_REPO}/releases#g"
}

attach() {
  local tag="$1" dir="$2" sha="$3" notes="$4" info id draft made
  case "$tag" in desktop-v*) ;; *) echo "::error::release tag must start with desktop-v"; exit 1 ;; esac
  info="$(find_release "$tag")"
  if [ -n "$info" ] && [ "${info#* }" = "false" ]; then
    echo "::error::release $tag is already published and immutable: no more files can be added. Use a new version/tag, or delete the release first."
    exit 1
  fi
  if [ -n "$info" ]; then
    made="$(draft_commit "${info%% *}")"
    if [ "$made" != "$sha" ]; then
      echo "::notice title=release-stale-draft::draft $tag was made from ${made:-an unknown commit}, this build is $sha: deleting the stale draft and its files"
      gh api -X DELETE "repos/$REL_REPO/releases/${info%% *}" > /dev/null
      info=""
    fi
  fi
  if [ -z "$info" ]; then
    local full
    full="$(mktemp)"
    { public_notes < "$notes"; printf '\n\n<!-- source-commit: %s -->\n' "$sha"; } > "$full"
    notes="$full"
    # A commit of another repository cannot be a target, so a separate releases repo tags its own
    # default branch; the tag in the source repository is what names the source commit.
    local target=(--target "$sha")
    [ "$REL_REPO" = "$GITHUB_REPOSITORY" ] || target=()
    gh release create "$tag" --draft --prerelease ${target[@]+"${target[@]}"} --title "P2P Messenger $tag" --notes-file "$notes" --repo "$REL_REPO"
  fi
  gh release upload "$tag" "$dir"/* --clobber --repo "$REL_REPO"

  info="$(find_release "$tag")"
  id="${info%% *}"; draft="${info#* }"
  [ -n "$id" ] || { echo "::error::release $tag disappeared"; exit 1; }
  local names missing=""
  names="$(gh api "repos/$REL_REPO/releases/$id" --jq '.assets[].name')"
  for a in $REQUIRED_ASSETS; do
    printf '%s\n' "$names" | grep -qxF "$a" || missing="$missing $a"
  done
  if [ -n "$missing" ]; then
    echo "::notice title=release-draft::$tag stays a draft until the other platform adds:$missing"
    echo "published=false" >> "${GITHUB_OUTPUT:-/dev/null}"
    return 0
  fi
  if [ "$draft" = "true" ]; then
    gh release edit "$tag" --draft=false --repo "$REL_REPO"
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
