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

4. **Commit Changes**:
   Ensure all changes (source, tests, `web_dist`, and `package.json`) are committed to git with a descriptive commit message:
   ```bash
   git add -A
   git commit -m "fix/feat: ..."
   ```
   The working tree must be clean before deploying.

5. **Deploy**:
   Execute the release script:
   ```bash
   VERSION=$(node -p "require('./lio-plugin/package.json').version")
   ./deploy.sh "v${VERSION}"
   ```
   This packages the extension bundles (`.crx`, `.zip`, `.xpi`), pushes to GitHub `main`, pushes tag `v${VERSION}`, and creates the GitHub release via `gh`.
