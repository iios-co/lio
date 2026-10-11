# Privacy Policy for Lio

**Last updated**: October 11, 2026

Lio is a self-hostable, private bookmark and tab synchronization system consisting of the Lio Browser Extension (`lio-plugin`) and the Lio Server (`lio-server`).

---

## 1. No Lio-operated Telemetry

- **Zero Central Tracking**: Neither the extension nor the server transmits telemetry, analytics, diagnostic logs, or metrics to the authors of Lio or any third-party analytics or advertising provider.
- **Primary Data Flow**: All synchronization payloads are transmitted strictly to the self-hosted server address configured by the user (e.g. `http://localhost:8000` or a private LAN IP).
- **Destination-Site Network Requests**:
  1. **Favicon Retrieval**: When a bookmark is created or updated, the browser extension issues a direct HTTP(S) request to the origin of the bookmarked website (`${origin}/favicon.ico`) to retrieve and cache its icon. This exposes the browser client's IP address and standard HTTP request headers to the bookmarked origin.
  2. **Operator-Triggered Dead-Link Verification**: When manually initiated by the operator via the Web Console, the self-hosted server issues outbound HTTP HEAD/GET probes directly to bookmarked destination URLs to verify link liveness. This exposes the self-hosted server's IP address and standard HTTP metadata to destination hosts. This feature defaults to ignoring private/local IP addresses unless explicitly enabled by the operator (`LIO_DEADLINK_ALLOW_PRIVATE=1`).

---

## 2. Information Collected and Transmitted

### A. Bookmarks Information (`bookmarksInfo`)
- **Data**: Bookmark titles, URLs, folder structure, item positions, dates created/modified, and site favicons.
- **Purpose**: Synchronize bookmark hierarchies deterministically between the user's browser and their self-hosted server.
- **Storage**: Persisted in the server's SQLite database (`bookmarks` table).

### B. Browsing & Tab Activity (`browsingActivity`)
- **Data**: URLs and page titles of active open browser tabs and windows; visit timestamps and visit counts for bookmarked URLs.
- **Purpose**:
  1. Capture active browsing sessions so they can be viewed and adopted on other paired devices.
  2. Track local visit counts to enable smart sorting in the Web Management Console.
- **Storage**: Active tab snapshots are saved in `device_tabs` on the user's server.

### C. Local Extension Storage (`browser.storage.local`)
The extension locally stores:
- Configured server endpoint URL and bearer collection token
- Unique client device identifier (`deviceId`) and monotonic sequence counters
- Offline mutation queue buffering changes while disconnected
- Synchronization timestamps, watermark state, and local diagnostic event logs

---

## 3. Browser Permissions Justification

| Permission | Justification |
| :--- | :--- |
| `bookmarks` | Required to detect local bookmark creations, updates, moves, and deletions, and apply remote changes. |
| `tabs` | Required to read active window and tab URLs/titles for cross-device tab session synchronization. |
| `storage` | Required to store offline sync queues and the user's self-hosted server configuration in `browser.storage.local`. |
| `alarms` | Required to execute periodic background reconciliation cycles and connection health probes. |

---

## 4. User Control & Data Retention

- **Offline Queuing**: If the self-hosted server is unreachable, mutations are queued locally in `browser.storage.local` and never forwarded elsewhere.
- **Tombstones & History Retention**: Deleting a bookmark records a durable tombstone (`deleted = 1`) and change-feed delta to prevent deletion resurrection across asynchronous clients. Tombstones, change-feed rows, and pre-reorganize tree snapshots persist on the server until collection deletion or delta retention pruning (`LIO_DELTA_LOG_MAX_ROWS`, default 10,000). Archived tab history persists until adopted, manually deleted, or evicted by the retention cap.
- **Collection Purging**: Operators can delete collections, rotate tokens, or clear past tab sessions at any time via the Web Management Console, which cascades permanent removal of all associated bookmark records and history.

---

## 5. Contact & Auditing

Lio is open-source software published under the MIT license. The complete source code is publicly auditable at:  
[https://github.com/iios-co/lio](https://github.com/iios-co/lio)

For privacy inquiries, security reports, or questions, open an issue on GitHub:  
[https://github.com/iios-co/lio/issues](https://github.com/iios-co/lio/issues)
