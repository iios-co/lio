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
  BUILD_BUMP=0 npm run zip
  BUILD_BUMP=0 npm run zip:firefox
  CHROME_ZIP=$(find .output -name '*-chrome.zip' -type f | head -n 1)
  FIREFOX_ZIP=$(find .output -name '*-firefox.zip' -type f | head -n 1)
  [ -n "$CHROME_ZIP" ] && cp "$CHROME_ZIP" ../release/lio-extension-chrome.zip
  [ -n "$FIREFOX_ZIP" ] && cp "$FIREFOX_ZIP" ../release/lio-extension-firefox.zip
  [ -n "$FIREFOX_ZIP" ] && cp "$FIREFOX_ZIP" ../release/lio-extension.xpi

  # Pack native .crx extension binary if Chromium is available
  CHROME_BIN=$(which chromium 2>/dev/null || which google-chrome 2>/dev/null || find "${HOME}/Library/Caches/ms-playwright" -name "Google Chrome for Testing" 2>/dev/null | head -n 1 || true)
  if [ -n "$CHROME_BIN" ] && [ -x "$CHROME_BIN" ]; then
    "$CHROME_BIN" --pack-extension="$(pwd)/.output/chrome-mv3" >/dev/null 2>&1 || true
    if [ -f .output/chrome-mv3.crx ]; then
      cp .output/chrome-mv3.crx ../release/lio-extension.crx
    fi
  fi
)
log "Packaged extension release artifacts:"
ls -lh release/*

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
      release/lio-extension.crx release/lio-extension.xpi \
      --title "Lio ${TAG}" \
      --notes "Production release of Lio with packaged browser extension bundles." || true
  fi
fi

log "Deployment complete: https://github.com/${REPO_OWNER}/${REPO_NAME}"
