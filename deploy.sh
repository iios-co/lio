#!/usr/bin/env bash
# Lio deployment and release script.
# Validates tests, builds production bundles, and pushes releases to GitHub under iios-co.

set -euo pipefail

REPO_OWNER="iios-co"
REPO_NAME="lio"
REMOTE_URL="https://github.com/${REPO_OWNER}/${REPO_NAME}.git"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

log "Running pre-flight verification gate..."
./verify.sh || die "Pre-flight verification failed. Fix errors before deploying."

log "Building packaged browser extension release bundles..."
mkdir -p release
rm -f release/*.zip

(
  cd lio-plugin
  rm -rf .output
  VERSION=$(node -p "require('./package.json').version")
  BUILD_BUMP=0 npm run zip
  BUILD_BUMP=0 npm run zip:firefox
  [ -f ".output/lio-plugin-${VERSION}-chrome.zip" ] || die "Chrome bundle not found at .output/lio-plugin-${VERSION}-chrome.zip"
  [ -f ".output/lio-plugin-${VERSION}-firefox.zip" ] || die "Firefox bundle not found at .output/lio-plugin-${VERSION}-firefox.zip"
  cp ".output/lio-plugin-${VERSION}-chrome.zip" ../release/lio-extension-chrome.zip
  cp ".output/lio-plugin-${VERSION}-firefox.zip" ../release/lio-extension-firefox.zip
)
log "Packaged extension release artifacts:"
ls -lh release/*.zip

log "Configuring Git remote for ${REPO_OWNER}/${REPO_NAME}..."
if ! git remote | grep -q '^origin$'; then
  git remote add origin "$REMOTE_URL"
else
  git remote set-url origin "$REMOTE_URL"
fi

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
log "Deploying branch '${CURRENT_BRANCH}' to ${REMOTE_URL}..."
git push -u origin "$CURRENT_BRANCH"

TAG="${1:-}"
if [ -n "$TAG" ]; then
  log "Creating GitHub Release ${TAG} with extension packages..."
  if ! git rev-parse "$TAG" >/dev/null 2>&1; then
    git tag -a "$TAG" -m "Release $TAG"
    git push origin "$TAG"
  fi
  if command -v gh >/dev/null 2>&1; then
    gh release create "$TAG" release/lio-extension-chrome.zip release/lio-extension-firefox.zip \
      --title "Lio ${TAG}" \
      --notes "Production release of Lio with packaged browser extension bundles." || true
  fi
fi

log "Deployment complete: https://github.com/${REPO_OWNER}/${REPO_NAME}"
