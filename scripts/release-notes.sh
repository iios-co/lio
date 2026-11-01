#!/usr/bin/env bash
# Compose the GitHub release body for a tag: the curated release-notes/<tag>.md
# followed by every commit since the previous release tag and a diff link.
#
#   scripts/release-notes.sh v0.9.72            # new release (tag not created yet → HEAD)
#   scripts/release-notes.sh v0.9.71 > notes.md # existing tag (backfill)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

REPO="iios-co/lio"
TAG="${1:?usage: scripts/release-notes.sh vX.Y.Z}"
NOTES_FILE="release-notes/${TAG}.md"
[ -s "$NOTES_FILE" ] || { echo "error: $NOTES_FILE is missing or empty" >&2; exit 1; }

# An existing tag bounds the range (backfill) and the previous tag is found from
# its parent; a new release is HEAD, whose nearest tag IS the previous release.
if git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
  END="$TAG"
  PREV="$(git describe --tags --abbrev=0 --match 'v[0-9]*' "${TAG}^" 2>/dev/null || true)"
else
  END="HEAD"
  PREV="$(git describe --tags --abbrev=0 --match 'v[0-9]*' HEAD 2>/dev/null || true)"
fi

cat "$NOTES_FILE"
printf '\n## Commits\n\n'
if [ -n "$PREV" ]; then
  git log --no-merges --reverse --pretty='- %s (%h)' "${PREV}..${END}"
  printf '\n**Full diff**: https://github.com/%s/compare/%s...%s\n' "$REPO" "$PREV" "$TAG"
else
  git log --no-merges --reverse --pretty='- %s (%h)' "$END"
fi
