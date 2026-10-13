# Lio Deployment Specification

This document defines the formal deployment and operational specification for **Lio** (Link Input Output), covering architecture, server runtime, containerization, environment configuration, networking, security hardening, disaster recovery, and browser extension deployment.

---

## 1. System Architecture & Topology

```
┌────────────────────────────────────────────────────────────────────────┐
│                        CLIENT EXTENSION LAYER                          │
│                                                                        │
│   Chrome / Brave / Edge (Manifest V3)      Firefox (Manifest V2)       │
│   - Local bookmark event hooks             - Offline operation queue   │
│   - Tab session boundary tracking          - WebSocket push consumer   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ HTTPS / WSS (:443) or HTTP (:80)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                     REVERSE PROXY / INGRESS LAYER                      │
│                                                                        │
│   Nginx / Caddy / Traefik (Optional for LAN; Mandatory for WAN/HTTPS) │
│   - TLS Termination                                                    │
│   - WebSocket Upgrade (Connection: Upgrade)                            │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ HTTP / WS (:8787 or :8000 in LXC)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                          LIO SERVER RUNTIME                            │
│                                                                        │
│   Uvicorn + FastAPI (Python >= 3.12)                                   │
│   - Serves API routes: /api/v1/...                                     │
│   - Serves embedded Web Management Console (web_dist/ SPA)             │
│   - Native WebSockets: /api/v1/collections/{token}/events             │
│   - Serialized write transactions via db.write_tx()                    │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ POSIX File Lock
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                         PERSISTENCE STORAGE                            │
│                                                                        │
│   SQLite 3.37+ in WAL Mode (/var/lib/lio/lio.db)                       │
│   - PRAGMA journal_mode = WAL                                          │
│   - PRAGMA foreign_keys = ON                                           │
│   - PRAGMA busy_timeout = 5000                                         │
│   - Tables: collections, bookmarks, delta_log, device_tabs, etc.       │
└────────────────────────────────────────────────────────────────────────┘
```

### Component Boundaries
- **Server (`lio-server`)**: Standalone Python service running on Uvicorn. Embeds its own production-compiled Single Page Application (SPA) in `lio_server/web_dist/`. Requires **zero Node.js or npm runtime** on the host.
- **Database (`lio.db`)**: Single-file relational storage with Write-Ahead Logging (WAL). Concurrent reads proceed without locking; writes are serialized via application-level context managers and SQLite locks.
- **Client Extensions (`lio-plugin`)**: Run inside browser worker contexts. Maintain a local FIFO event queue and sync coordinator to coalesce operations.

---

## 2. Resource Requirements & Prerequisites

### Minimum Hardware Sizing
| Resource | Minimum | Recommended (Multi-user / Multi-device) |
| :--- | :--- | :--- |
| **CPU** | 1 vCPU (x86_64 or aarch64) | 2 vCPU |
| **RAM** | 512 MB | 1024 MB (1 GB) |
| **Disk** | 2 GB SSD | 5 GB SSD |
| **Network** | 10 Mbps LAN / WAN | 100 Mbps+ LAN |

### Software Prerequisites
- **Operating System**: Debian 12/13, Ubuntu 22.04/24.04 LTS, or Proxmox VE 8.x (LXC unprivileged).
- **Python**: `>= 3.12` (with `python3-venv` and `sqlite3` support).
- **SQLite**: `>= 3.37.0` (with JSON1 extension support enabled by default in Python 3.12).

---

## 3. Configuration Specification

Lio is configured via environment variables, typically loaded from `/etc/lio/lio.env` or passed via container environment blocks.

### Environment Variable Reference

| Variable | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `LIO_HOST` | String | `127.0.0.1` | Network interface to bind. Use `0.0.0.0` for containers or direct LAN access. |
| `LIO_PORT` | Integer | `8787` | TCP port for the server process (default Proxmox LXC uses `8000`). |
| `LIO_DB_PATH` | Path | `lio.db` | Absolute path to SQLite database file. Production standard: `/var/lib/lio/lio.db`. |
| `LIO_ADMIN_USERNAME` | String | `admin` | Administrative login username for the Web Console. |
| `LIO_ADMIN_PASSWORD` | String | *Empty* | Plaintext environment override, compared directly at login via `hmac.compare_digest`. If unset, the server checks the stored hash in SQLite (configured via first-run web setup or CLI `python -m lio_server --set-admin admin <password>`). |
| `LIO_SESSION_SECRET` | String | *Random* | Secret key used to sign HMAC-SHA256 session cookies. Defaults to a per-process ephemeral key if unset. |
| `LIO_COOKIE_SECURE` | Boolean | `0` | If `1`, cookies require HTTPS (`Secure` flag). Set `0` for plain HTTP LAN environments. |
| `LIO_AUTO_PROVISION` | Boolean | `0` | If `1`, unknown bearer tokens automatically mint new collections. Keep `0` in production. |
| `LIO_ALLOWED_TOKENS` | CSV | *Empty* | Comma-separated list of allowed collection tokens. If empty, any admin-minted token is allowed. |
| `LIO_DELTA_LOG_MAX_ROWS` | Integer | `10000` | Maximum change log operations retained per collection before pruning oldest entries. |
| `LIO_DEADLINK_CHECK` | Boolean | `1` | Enables operator-triggered dead link verification. Zero background polling. |
| `LIO_DEADLINK_ALLOW_PRIVATE` | Boolean | `0` | If `1`, dead-link checks may probe private RFC1918 LAN hosts. Loopback/metadata always blocked. |
| `LIO_DEADLINK_VERIFY_SSL` | Boolean | `1` | Verifies SSL certificates during dead-link checking. Set `0` if using self-signed intranet certs. |

### Production Configuration Template (`/etc/lio/lio.env`)

```ini
# Lio Production Configuration
LIO_HOST=0.0.0.0
LIO_PORT=8787
LIO_DB_PATH=/var/lib/lio/lio.db

# Admin Security
LIO_ADMIN_USERNAME=admin
LIO_ADMIN_PASSWORD=change_this_secure_admin_password
LIO_SESSION_SECRET=generate_with_openssl_rand_hex_32

# Network & Environment
LIO_COOKIE_SECURE=0
LIO_AUTO_PROVISION=0
LIO_DELTA_LOG_MAX_ROWS=10000

# Link Liveness
LIO_DEADLINK_CHECK=1
LIO_DEADLINK_ALLOW_PRIVATE=1
LIO_DEADLINK_VERIFY_SSL=1
```

---

## 4. Deployment Methods

### Method 1: Proxmox VE LXC Container (Recommended for Home Labs)

Proxmox VE can deploy Lio into an unprivileged Debian container using the automated community helper:

```bash
bash -c "$(wget -qLO - https://raw.githubusercontent.com/iios-co/lio/main/ct/lio.sh)"
```

- **Container Profile**: Unprivileged Debian container, 2 vCPUs, 1024 MB RAM, 4 GB SSD.
- **Service Address**: `http://<CONTAINER_IP>:8000`
- **Configuration**: `/etc/lio/lio.env`
- **System Service**: `systemctl status lio-server`

---

### Method 2: Debian / Ubuntu Bare Metal or VPS

Deploy onto a dedicated Linux VM or server using the standard system installer:

```bash
# Execute remote installer with root/sudo:
curl -fsSL https://raw.githubusercontent.com/iios-co/lio/main/lio-server/deploy/debian-install.sh -o /tmp/lio-install.sh
sudo bash /tmp/lio-install.sh
rm -f /tmp/lio-install.sh
```

#### Filesystem & Runtime Layouts
Lio supports two production deployment layouts:

1. **Debian / Ubuntu Bare Metal (`debian-install.sh`)**:
   - Release Root: `/opt/lio/releases/<version>/`
   - Active Release Symlink: `/opt/lio/current`
   - Runtime Virtualenv: `/opt/lio/current/runtime/`
   - Systemd Service Binary: `/opt/lio/current/runtime/bin/python -m lio_server`

2. **Proxmox VE LXC Container (`ct/lio.sh`)**:
   - Persistent Runtime: `/opt/lio-runtime/` (symlinked from `/opt/lio/runtime`)
   - Systemd Service Binary: `/opt/lio-runtime/bin/python -m lio_server`

Both runtime layouts store active database state in `/var/lib/lio/lio.db` (owned by `lio:lio`, mode `0640`) and runtime environment configuration in `/etc/lio/lio.env` (owned by `root:lio`, mode `0640`).

#### Systemd Service Unit Specification (`/etc/systemd/system/lio-server.service`)

```ini
[Unit]
Description=Lio - Bookmark & Tab Sync Server
After=network.target
Wants=network-online.target

[Service]
Type=simple
User=lio
Group=lio
WorkingDirectory=/var/lib/lio
EnvironmentFile=-/etc/lio/lio.env
Environment=LIO_DB_PATH=/var/lib/lio/lio.db
Environment=LIO_HOST=0.0.0.0
Environment=LIO_PORT=8787
ExecStart=/opt/lio/current/runtime/bin/python -m lio_server
Restart=always
RestartSec=3

# Hardening Sandbox
LimitNOFILE=65536
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/lib/lio /etc/lio
ProtectKernelTunables=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
MemoryMax=1G
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```
---

## 5. Reverse Proxy & Network Specification

### Port Allocations
- **`8787` (Default)**: Standalone native service port.
- **`8000` (Alternative)**: Standard Proxmox LXC installation port.
- **`ws://` / `wss://`**: Re-uses the primary HTTP port via HTTP Connection Upgrade.

### Nginx Configuration Template (TLS + WebSockets)

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl http2;
    server_name lio.example.com;

    ssl_certificate     /etc/letsencrypt/live/lio.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/lio.example.com/privkey.pem;

    client_max_body_size 10M;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;

        # WebSocket headers
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;

        # Upstream proxy headers
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Timeouts for real-time WebSocket connection
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

### Caddyfile Template (Automatic HTTPS + WebSockets)

```caddy
lio.example.com {
    reverse_proxy 127.0.0.1:8787 {
        header_up Host {host}
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-Proto {scheme}
    }
}
```

---

## 6. Security & Synchronization Invariants

### 1. Synchronization Model: Strict Non-Destructive Invariants
Lio implements a deterministic synchronization engine with hard safety rules:
- **Zero Inferred Deletions**: Local bookmarks absent from the server are treated as uncommitted local work. The client **never** infers deletions via set difference (`Local - Server`).
- **Authoritative Tombstones Only**: The browser removes a local bookmark **only** when an explicit `{ operation: "delete" }` tombstone is delivered from the server's change log.
- **Additive Union on Merge**: Connecting a browser in `merge` mode is strictly additive (`toDelete = []`). It emits 0 delete deltas to the server and 0 deletions locally.
- **Circuit Breaker on Server Rejection**: If the server rejects a batch of operations due to existing tombstones (`skipped_stale > 0`), the client immediately:
  1. Refuses to log success.
  2. Refuses to add unpersisted items to `knownServerIds`.
  3. Pauses synchronization fail-closed (`globalEnabled = false`).
  4. Surfaces a structured **"Server Conflict Detected"** banner in the extension popup.

### 2. SSRF Protection (Dead-Link Checking)
The dead-link probe engine (`routes/reports.py`) enforces strict host verification:
- Loopback addresses (`127.0.0.0/8`, `::1`, `localhost`) are **unconditionally blocked**.
- Cloud instance metadata addresses (`169.254.169.254`, `fd00:ec2::254`) are **unconditionally blocked**.
- Private RFC1918 subnets (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) are blocked unless explicitly allowed by the operator setting `LIO_DEADLINK_ALLOW_PRIVATE=1`.

---

## 7. Disaster Recovery & Backup Procedures

### Safe Online SQLite Backup (WAL Mode)
Because SQLite runs in WAL mode, **never copy `lio.db` with standard `cp` while the service is running**. Use SQLite's online vacuum/backup API:

```bash
# Safe online backup without stopping the service:
sqlite3 /var/lib/lio/lio.db ".backup '/var/backups/lio/lio_$(date +%Y%m%d_%H%M%S).db'"
```

### Automated Nightly Backup Cron
Create the backup directory with appropriate service user ownership:
```bash
sudo install -d -o lio -g lio -m 0750 /var/backups/lio
```

Add to `/etc/cron.d/lio-backup`:
```cron
0 2 * * * lio sqlite3 /var/lib/lio/lio.db ".backup '/var/backups/lio/lio_$(date +\%F).db'" && find /var/backups/lio -name "*.db" -mtime +14 -delete
```

### Server-Side Emergency Recovery Runbook
If an operator needs to restore a backup:

```bash
set -euo pipefail

# Target backup file to restore from
TARGET_BACKUP="${1:-/var/backups/lio/lio_target.db}"

# 1. Assert backup source is an existing non-empty regular file
if [ ! -f "$TARGET_BACKUP" ] || [ ! -s "$TARGET_BACKUP" ]; then
  echo "Error: Backup file does not exist or is empty: $TARGET_BACKUP" >&2
  exit 1
fi
# 2. Restore backup into a temporary file in read-only URI mode and assert integrity
sudo rm -f /var/lib/lio/lio_restore.db
sudo sqlite3 "file:${TARGET_BACKUP}?mode=ro" ".backup '/var/lib/lio/lio_restore.db'"

CHECK=$(sudo sqlite3 /var/lib/lio/lio_restore.db "PRAGMA integrity_check;")
[ "$CHECK" = "ok" ] || { echo "Database integrity check failed: $CHECK" >&2; exit 1; }

TABLES=$(sudo sqlite3 /var/lib/lio/lio_restore.db "SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('bookmarks', 'collections');")
[ "$TABLES" = "2" ] || { echo "Database schema validation failed (missing core tables)" >&2; exit 1; }

# 3. Stop service only after the restored database is fully validated
sudo systemctl stop lio-server

# 4. Archive existing active database and sidecars (db, wal, shm) together
INCIDENT_DIR="/var/backups/lio/incident_$(date +%Y%m%d_%H%M%S)"
sudo mkdir -p "$INCIDENT_DIR"
sudo cp -a /var/lib/lio/lio.db "$INCIDENT_DIR/lio.db"
if [ -f /var/lib/lio/lio.db-wal ]; then
  sudo cp -a /var/lib/lio/lio.db-wal "$INCIDENT_DIR/"
fi
if [ -f /var/lib/lio/lio.db-shm ]; then
  sudo cp -a /var/lib/lio/lio.db-shm "$INCIDENT_DIR/"
fi
sudo rm -f /var/lib/lio/lio.db /var/lib/lio/lio.db-wal /var/lib/lio/lio.db-shm

# 5. Atomically move verified database into place and set ownership
sudo mv /var/lib/lio/lio_restore.db /var/lib/lio/lio.db
sudo chown lio:lio /var/lib/lio/lio.db
sudo chmod 0640 /var/lib/lio/lio.db

# 6. Start service
sudo systemctl start lio-server
```

### Authoritative Collection Baseline Restore API
1. Open the Lio extension popup.
2. The popup detects the conflict and renders **"Restore browser as baseline"**.
3. Confirming sends a transactional payload to `/api/v1/collections/{token}/bookmarks/restore-baseline`.
4. The server validates structural hierarchy, supersedes tombstones for submitted IDs, sets a fresh watermark, and establishes the browser as the new ground truth.

---

## 8. Build, Packaging & GitHub Release Deployment

This section details the exact procedures for versioning, building production bundles, packaging the CRX extension, and publishing releases to GitHub under **`iios-co`**.

### 1. Version Authority & Synchronization

Lio uses unified semantic versioning (`major.minor.patch`) across the client extension and backend server:
- **Primary Version Authority**: `lio-plugin/package.json` defines the canonical release version (e.g. `0.4.157`).
- **Release Tag**: Git tags must strictly match `v${PACKAGE_VERSION}` (e.g. `v0.4.157`).
- **Server Version Resolution**: `lio-server` dynamically resolves its runtime release version from the active Git tag (`git describe --tags --always`) or `LIO_RELEASE_VERSION` environment variable.
- **Manifest Version Pinning**: During production releases, always pass `BUILD_BUMP=0` to freeze the patch version and prevent automated build counter drift.

### 2. CRX Private Signing Key Specification

To package the signed Chromium CRX (`release/lio-extension.crx`) with a stable, persistent extension ID across browser updates:
- `scripts/pack-crx.mjs` resolves the private RSA key from one of three sources (in order):
  1. `CRX_KEY_PATH`: Path to an external `.pem` key file.
  2. `CRX_KEY_BASE64`: Base64-encoded string of the `.pem` key file (standard for CI/CD environments).
  3. Local file `lio-plugin/key.pem`: Local development signing key (**strictly gitignored; never committed**).
- **Security Enforcement**: The release script rejects the release if `lio-plugin/key.pem` is tracked by git (`git ls-files --error-unmatch`). If no key is found, the packaging script fails closed.

### 3. Automated Release Pipeline (`./deploy.sh`)
The repository provides a single-command release automation script `deploy.sh`:

```bash
# Check CLI authentication
gh auth status

# Publish a production release matching the current package version:
VERSION=$(node -p "require('./lio-plugin/package.json').version")
./deploy.sh "v${VERSION}"
```

**Release Invariants Enforced by `deploy.sh`**:
1. **Tag Validation**: Requires `vX.Y.Z` format matching `lio-plugin/package.json` exactly.
2. **Remote Origin Setup**: Sets or updates `origin` to `https://github.com/iios-co/lio.git`.
3. **Tag Collision Prevention**: Fetches remote tags and halts if `vX.Y.Z` already exists on GitHub.
4. **Prerequisite Check**: Validates `gh` CLI presence, GitHub authentication, and CRX signing key availability.
5. **Working Tree Guard**: Asserts git working tree is clean before starting.
6. **Pre-flight Gate**: Executes `BUILD_BUMP=0 ./verify.sh` (127 server tests, 88 plugin tests, 36 web tests, 50/50 e2e browser assertions).
7. **Tracked Asset Verification**: Asserts that `verify.sh` produced no uncommitted diff in `lio-server/lio_server/web_dist/`. If drift occurs, halts release to ensure changes are reviewed and committed before tagging.
8. **Artifact Packaging**: Clears `.output/` and builds all 4 production bundles with `BUILD_BUMP=0`:
   - `release/lio-extension.crx`
   - `release/lio-extension-chrome.zip`
   - `release/lio-extension-firefox.zip`
   - `release/lio-extension.xpi`
9. **Asset Integrity Check**: Asserts all 4 release files are present and non-empty.
10. **Git Push & Tag**: Pushes the active branch, tags `vX.Y.Z`, and pushes the tag to GitHub.
11. **GitHub Release Publication**: Executes `gh release create "v${VERSION}" release/*` and verifies the published release view.

### 4. Release Artifact Matrix

The published release must contain the 4 verified production bundles in `release/`:

| Artifact | Target Platform | Description |
| :--- | :--- | :--- |
| `lio-extension.crx` | Chrome, Brave, Edge | Packaged binary with persistent extension ID. |
| `lio-extension-chrome.zip` | Chrome, Brave, Edge, Opera | Unpackable zip for developer mode / manual load. |
| `lio-extension-firefox.zip` | Firefox, Floorp, Zen | Standard zipped extension archive. |
| `lio-extension.xpi` | Floorp, Zen, Firefox Dev/Nightly | Unsigned XPI package (installable directly on unbranded/developer builds; retail Firefox requires AMO signing). |

### 5. Manual Release Procedure (Step-by-Step Runbook)

If performing a release manually without `deploy.sh`:
```bash
set -euo pipefail

# 1. Determine canonical version
VERSION=$(node -p "require('./lio-plugin/package.json').version")
TAG="v${VERSION}"

# 2. Verify git status and gh authentication
[ -z "$(git status --porcelain)" ] || { echo "Working tree dirty"; exit 1; }
gh auth status

# 3. Run pre-flight verification gate
BUILD_BUMP=0 ./verify.sh

# Ensure no uncommitted web_dist drift occurred during verification
if ! git diff --quiet lio-server/lio_server/web_dist/; then
  echo "web_dist modified during verify. Build, review, and commit web_dist before tagging."
  exit 1
fi

# 4. Package extension release bundles
mkdir -p release
rm -f release/*.zip release/*.crx release/*.xpi
(
  cd lio-plugin
  rm -rf .output
  BUILD_BUMP=0 npm run zip
  BUILD_BUMP=0 npm run zip:firefox
  BUILD_BUMP=0 npm run crx
  cp ".output/lio-plugin-${VERSION}-chrome.zip" ../release/lio-extension-chrome.zip
  cp ".output/lio-plugin-${VERSION}-firefox.zip" ../release/lio-extension-firefox.zip
  cp ".output/lio-plugin-${VERSION}-firefox.zip" ../release/lio-extension.xpi
)

# Assert all 4 files are generated
for f in release/lio-extension.crx release/lio-extension-chrome.zip release/lio-extension-firefox.zip release/lio-extension.xpi; do
  [ -s "$f" ] || { echo "Missing asset: $f"; exit 1; }
done

# 5. Push branch and release tag to GitHub
git remote set-url origin https://github.com/iios-co/lio.git
git push origin main
git tag -a "$TAG" -m "Release $TAG"
git push origin "$TAG"

# 6. Publish release on GitHub
gh release create "$TAG" \
  release/lio-extension.crx \
  release/lio-extension-chrome.zip \
  release/lio-extension-firefox.zip \
  release/lio-extension.xpi \
  --title "Lio ${TAG}" \
  --notes "Production release of Lio with packaged browser extension bundles."

# 7. Verify release publication
gh release view "$TAG"
```

### 6. Client Connection Payload Specification
Connecting an extension to a self-hosted instance uses a standard base64 connection string:

```text
lio-connect:v1:<base64-json>
```

Where the decoded payload contains:
```json
{
  "endpoint": "http://192.168.1.100:8787",
  "token": "a1b2c3d4e5f6"
}
```
This payload can be copied directly from the collection card in the Web Console and pasted into the extension setup screen.
---

## 9. Verification & Acceptance Criteria

Every production release of Lio must pass the single gate script:

```bash
./verify.sh
```

### Acceptance Checklist
1. **Server Test Suite**: All pytest unit and integration tests pass (`pytest: 127 passed`).
2. **Plugin Test Suite**: All Node.js test runner unit and property tests pass (`88 passed`).
3. **Web UI Test Suite**: All UI transform and logic tests pass (`36 passed`).
4. **Production Builds**: `web-ui` compiles to `lio-server/lio_server/web_dist/` with 0 errors; `lio-plugin` builds Chrome MV3 and Firefox MV2 bundles.
5. **Real-Browser E2E Harness**: Drives actual Chromium instances via Playwright against a throwaway server, verifying:
   - Token authentication and gate closure.
   - Initial merge synchronization without link loss.
   - Real-time WebSocket push updates across devices.
   - Cascade deletions and last-write-wins resolution.
   - In-place title and URL inline editing.
   - Zero-leak folder scoping and tab session capture.
