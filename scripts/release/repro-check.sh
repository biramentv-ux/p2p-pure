#!/usr/bin/env bash
# Reproducibility check for the web bundle: build twice from a clean `npm ci` in two
# different directories, with a fixed clock, locale and time zone, and compare SHA-256 of
# every file in dist/.
#
#   scripts/release/repro-check.sh [--keep] [--mode desktop]
#
# Exit 0 = identical, 1 = differences (listed), 2 = build/setup failure.
# Sources are copied from the git working tree (tracked files only), so the check runs on
# exactly what would be committed, and never touches your own node_modules.
set -euo pipefail

KEEP=0; MODE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --keep) KEEP=1 ;;
    --mode) MODE="$2"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d)"
cleanup() { if [ "$KEEP" = 1 ]; then echo "kept: $WORK"; else rm -rf "$WORK"; fi; }
trap cleanup EXIT

# Fixed environment: the same for both builds (and the same one the release workflow uses).
SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-$(git -C "$REPO" log -1 --format=%ct)}"
export SOURCE_DATE_EPOCH TZ=UTC LC_ALL=C LANG=C NODE_ENV=production CI=true

echo "SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH  node=$(node -v)  npm=$(npm -v)"

build_one() {
  local n="$1"; local dir="$WORK/build$n"
  mkdir -p "$dir"
  # Tracked files that exist in the working tree (deleted-but-unstaged ones are skipped).
  (cd "$REPO" && git ls-files -z | while IFS= read -r -d '' f; do [ -e "$f" ] && printf '%s\0' "$f"; done \
    | tar -C "$REPO" --null -T - -cf - | tar -C "$dir" -xf -) || { echo "copy failed" >&2; exit 2; }
  (
    cd "$dir"
    # NODE_ENV=production would make `npm ci` skip devDependencies (vite, tsc); install them.
    NODE_ENV=development npm ci --no-audit --no-fund --ignore-scripts --loglevel=error
    if [ -n "$MODE" ]; then npm run build:desktop; else npm run build; fi
  ) >"$WORK/build$n.log" 2>&1 || { echo "build $n failed, see log:" >&2; tail -30 "$WORK/build$n.log" >&2; exit 2; }
  (cd "$dir/dist" && find . -type f -print0 | sort -z | xargs -0 sha256sum) >"$WORK/hashes$n.txt"
  echo "build $n: $(wc -l <"$WORK/hashes$n.txt") files, tree hash $(sha256sum <"$WORK/hashes$n.txt" | cut -c1-16)"
}

build_one 1
build_one 2

if diff -u "$WORK/hashes1.txt" "$WORK/hashes2.txt" >"$WORK/diff.txt"; then
  echo "OK: both builds are byte-identical"
  exit 0
fi
echo "DIFFERENT: the builds are not reproducible. Differing files:" >&2
diff "$WORK/hashes1.txt" "$WORK/hashes2.txt" | grep '^[<>]' | awk '{print $3}' | sort -u >&2
KEEP=1
echo "compare the two trees: diff -r $WORK/build1/dist $WORK/build2/dist" >&2
exit 1
