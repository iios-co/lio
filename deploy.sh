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

TAG="${1:-}"
if [ -z "$TAG" ]; then
  die "Usage: ./deploy.sh <tag> (e.g. ./deploy.sh v0.4.157)"
fi

if [[ ! "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  die "Release tag must follow semantic format 'vX.Y.Z' (got: '$TAG')"
fi

PKG_VER=$(node -p "require('./lio-plugin/package.json').version")
EXPECTED_TAG="v${PKG_VER}"
if [ "$TAG" != "$EXPECTED_TAG" ]; then
  die "Tag mismatch: requested tag is '$TAG', but lio-plugin/package.json is at '$PKG_VER' (expected '$EXPECTED_TAG')"
fi
log "Checking release prerequisites..."
command -v gh >/dev/null 2>&1 || die "GitHub CLI (gh) is required to publish releases. Install gh first."
gh auth status >/dev/null 2>&1 || die "GitHub CLI is not authenticated. Run 'gh auth login' before releasing."

if git ls-files --error-unmatch lio-plugin/key.pem >/dev/null 2>&1; then
  die "Security violation: lio-plugin/key.pem is tracked by git. Untrack it before releasing."
fi

if [ ! -f "lio-plugin/key.pem" ] && [ -z "${CRX_KEY_PATH:-}" ] && [ -z "${CRX_KEY_BASE64:-}" ]; then
  die "Missing CRX private signing key. Provide CRX_KEY_PATH, CRX_KEY_BASE64, or place key.pem in lio-plugin/"
fi
log "Configuring Git remote for ${REPO_OWNER}/${REPO_NAME}..."
if ! git remote | grep -q '^origin$'; then
  git remote add origin "$REMOTE_URL"
else
  git remote set-url origin "$REMOTE_URL"
fi

log "Checking remote tag collision on GitHub..."
git fetch origin --tags --quiet
if git ls-remote --tags origin "$TAG" | grep -q "$TAG"; then
  die "Tag '$TAG' already exists on remote origin. Increment version in lio-plugin/package.json before releasing."
fi

log "Checking git working tree before build..."
[ -z "$(git status --porcelain)" ] || die "Working tree is dirty. Commit or stash all changes before releasing."

log "Running pre-flight verification gate (BUILD_BUMP=0)..."
BUILD_BUMP=0 ./verify.sh || die "Pre-flight verification failed. Fix errors before deploying."

if ! git diff --quiet lio-server/lio_server/web_dist/; then
  die "Verification produced uncommitted changes in lio-server/lio_server/web_dist/. Run 'cd web-ui && npm run build', review, and commit before releasing."
fi
[ -z "$(git status --porcelain)" ] || die "Working tree has untracked or unstaged files after verify. Clean tree before release."

log "Building packaged browser extension release bundles..."
mkdir -p release
rm -f release/*.zip release/*.crx release/*.xpi

(
  cd lio-plugin
  rm -rf .output
  BUILD_BUMP=0 npm run zip
  BUILD_BUMP=0 npm run zip:firefox
  BUILD_BUMP=0 npm run crx
  [ -f ".output/lio-plugin-${PKG_VER}-chrome.zip" ] || die "Chrome bundle not found at .output/lio-plugin-${PKG_VER}-chrome.zip"
  [ -f ".output/lio-plugin-${PKG_VER}-firefox.zip" ] || die "Firefox bundle not found at .output/lio-plugin-${PKG_VER}-firefox.zip"
  [ -f "../release/lio-extension.crx" ] || die "CRX bundle not found at release/lio-extension.crx"
  cp ".output/lio-plugin-${PKG_VER}-chrome.zip" ../release/lio-extension-chrome.zip
  cp ".output/lio-plugin-${PKG_VER}-firefox.zip" ../release/lio-extension-firefox.zip
  cp ".output/lio-plugin-${PKG_VER}-firefox.zip" ../release/lio-extension.xpi
)

# Validate all 4 release files are present and non-empty
for f in release/lio-extension.crx release/lio-extension-chrome.zip release/lio-extension-firefox.zip release/lio-extension.xpi; do
  [ -s "$f" ] || die "Release asset $f is missing or empty"
done

log "Packaged extension release artifacts:"
ls -lh release/*.zip release/*.crx release/*.xpi


CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
log "Deploying branch '${CURRENT_BRANCH}' to ${REMOTE_URL}..."
git push -u origin "$CURRENT_BRANCH"

log "Creating and pushing Git tag ${TAG}..."
git tag -a "$TAG" -m "Release $TAG"
git push origin "$TAG"

log "Publishing GitHub Release ${TAG} with extension packages..."
gh release create "$TAG" \
  release/lio-extension.crx \
  release/lio-extension-chrome.zip \
  release/lio-extension-firefox.zip \
  release/lio-extension.xpi \
  --title "Lio ${TAG}" \
  --notes "Production release of Lio with packaged browser extension bundles."

log "Verifying published GitHub Release..."
gh release view "$TAG"

log "Deployment complete: https://github.com/${REPO_OWNER}/${REPO_NAME}"
