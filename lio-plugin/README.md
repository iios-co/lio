# lio-plugin

MV3 WebExtension client for [Lio](../README.md). Synchronizes browser bookmarks and tab sessions to a self-hosted [`lio-server`](../lio-server/README.md).

Built with [WXT](https://wxt.dev/) and React. Supports Chrome, Edge, Firefox, Brave, and other Chromium-based browsers.

---

## Features

* **Deterministic Bookmark Sync**: Listens to browser bookmark events (`create`, `update`, `move`, `delete`), assigns monotonic client sequences and idempotency keys, and applies changes with an apply-guard (preventing echo loops).
* **Offline Operation Queue**: Buffer mutations locally in `browser.storage.local` while offline; automatically flushes and acknowledges operations upon reconnection barrier settlement.
* **Multi-Device Tab Sessions**: Debounced snapshot of active windows and tabs. Other devices appear in the popup; clicking **Adopt** restores those tabs locally and consumes the snapshot on the server.
* **Sync Scoping**: Pair specific local folders to collection subfolders, or synchronize the whole tree.
* **Liveness & Scope Verification**: Continuous connection gate validation preventing desynchronization loops.

---

## Development & Building

Requires Node.js >= 20.

```bash
cd lio-plugin

# Install dependencies
npm install

# Run development mode with hot-reloading (Chromium)
npm run dev

# Build production bundle for Chromium (Chrome, Edge, Brave)
npm run build

# Build production bundle for Firefox
npm run build:firefox

# Run unit tests
npm test
```

---
## Packaging for Distribution

```bash
# Package production store submission bundles:
npm run zip          # Produces .output/lio-plugin-*-chrome.zip (Chrome Web Store / Edge Add-ons)
npm run zip:firefox  # Produces .output/lio-plugin-*-firefox.zip (Mozilla Add-ons / AMO)
```
---

## Testing
```bash
npm test
```

---

## Privacy

See [PRIVACY.md](../PRIVACY.md) for data collection, storage, and transmission disclosures. Data is strictly transmitted to the user's configured self-hosted server with zero third-party telemetry.
