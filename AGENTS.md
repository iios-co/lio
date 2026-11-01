# Agent Instructions & Workflow Rules for Lio

## Critical Mandate: ALWAYS Build and Deploy

After implementing any fix, feature, or change, you MUST ALWAYS build and deploy.
Without completing the build and deployment step, the user cannot test the changes in their environment (Proxmox/LXC container update, browser extension reload, etc.).

---

### Standard Build & Deployment Procedure

1. **Build Web UI**:
   ```bash
   cd web-ui && npm run build
   ```
   Ensures `lio-server/lio_server/web_dist/` is up-to-date with `web-ui/src/`.

2. **Run Verification Gate**:
   ```bash
   ./verify.sh
   ```
   Runs server unit tests, plugin unit tests, web-ui unit tests, production builds, and the end-to-end browser test against a live Chrome profile. All checks must pass.

3. **Increment Extension Version**:
   Increment the patch version in `lio-plugin/package.json` (e.g. `0.9.64` -> `0.9.65`).

4. **Write Release Notes**:
   Create `release-notes/v${VERSION}.md`. It becomes the GitHub release body; `deploy.sh` refuses to release without it. Cover EVERY change since the previous tag. Review the full range, not just your own commit:
   ```bash
   git log --no-merges --oneline "$(git describe --tags --abbrev=0)"..HEAD
   ```
   Required format (all three headings, exactly as written):
   ```markdown
   ## Summary
   One or two sentences: what changed for the user and why it matters.

   ## Changes
   - **Fixed** (server): New bookmarks dragged onto the bookmark bar now stay where they were dropped instead of jumping to the end. Cause: ...
   - **Added** / **Changed** / **Removed** (extension | server | web UI): ...

   ## Upgrade notes
   Which components must be updated for the release to take effect (server container, extension reload, both), plus any migration or config change. Write "None" only if nothing needs updating.
   ```
   Rules:
   - Describe behavior the user can observe, then the root cause or mechanism in one clause. No vague entries like "bug fixes", "improvements", or "misc".
   - Name the affected component on every bullet; the upgrade notes depend on it.
   - Mention known limitations or follow-ups that the release does not address.
   - `deploy.sh` appends the commit list and a compare link automatically; do not paste them.

5. **Commit Changes**:
   Ensure all changes (source, tests, `web_dist`, `package.json`, and the release notes file) are committed to git with a descriptive commit message:
   ```bash
   git add -A
   git commit -m "fix/feat: ..."
   ```
   The working tree must be clean before deploying.

6. **Deploy**:
   Execute the release script:
   ```bash
   VERSION=$(node -p "require('./lio-plugin/package.json').version")
   ./deploy.sh "v${VERSION}"
   ```
   This packages the extension bundles (`.crx`, `.zip`, `.xpi`), pushes to GitHub `main`, pushes tag `v${VERSION}`, and creates the GitHub release via `gh`, using `scripts/release-notes.sh` to build the body from `release-notes/v${VERSION}.md`, the commits since the previous tag, and a compare link.
