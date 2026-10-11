# Lio

> **Self-hostable, deterministic cross-browser bookmark and tab synchronization.**

Lio synchronizes browser bookmarks (preserving folder hierarchy, exact positioning, and favicons) and active tab sessions across multiple devices and browsers (Chrome, Edge, Firefox, Brave, Vivaldi) using a lightweight, private collection server.

---

## Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                        BROWSER EXTENSION (lio-plugin)                  │
│                                                                        │
│  - Listens to chrome.bookmarks events (create, update, move, delete)   │
│  - Assigns client sequences & idempotency keys                         │
│  - Captures and synchronizes active tab sessions                       │
│  - Local offline operation queue with automatic reconnection barrier   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    │ POST /api/v1/collections/{token}/bookmarks/sync
                                    │ Two-way batch with sequence watermarks
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        LIO SERVER (lio-server)                         │
│                                                                        │
│  - FastAPI + SQLite with WAL mode and serial write locks               │
│  - Idempotent operation deduplication & monotonic server versions     │
│  - Durable deletion tombstones (tombstone-wins conflict resolution)    │
│  - LWW content conflict resolution with timestamp tie-breaking         │
│  - Tab session persistence (no TTL; adopt-and-consume lifecycle)       │
│  - Serves embedded Web Management Console (React + Tailwind)           │
└────────────────────────────────────────────────────────────────────────┘
```

---

## Repository Structure

The project is organized into three components:

* **`lio-server/`** — The pure Python FastAPI backend and deployment packaging.
  * `lio_server/`: Python package, database schema (`schema.sql`), and API routes.
  * `lio_server/web_dist/`: Pre-compiled production build of the Web UI served directly by FastAPI (zero Node.js dependency on server).
  * `deploy/`: Debian VPC installer (`debian-install.sh`), systemd service unit (`lio-server.service`), and bundle scripts.
  * `tests/`: Comprehensive pytest integration and unit test suite.
* **`web-ui/`** — The React + Tailwind web management console source code (dev-only; compiles into `lio-server/lio_server/web_dist/`).
* **`lio-plugin/`** — The cross-browser WebExtension client (WXT + React).
* **`verify.sh`** — End-to-end acceptance test driving real browser instances via Playwright.

---
## Deployment

### 1. Proxmox VE LXC Container (Community Helper Script)

Deploy Lio as a lightweight, unprivileged Debian LXC container on Proxmox VE:

```bash
bash -c "$(wget -qLO - https://raw.githubusercontent.com/iios-co/lio/main/ct/lio.sh)"
```

The script automatically provisions a Debian container, configures the service user, installs the Python runtime, and starts the systemd service on port `8787`.

---

### 2. Debian / Ubuntu VPC or Bare Metal

Single-command installer for dedicated servers, VPS instances, or Raspberry Pi running Debian/Ubuntu:

```bash
# Download and execute with sudo:
curl -fsSL https://raw.githubusercontent.com/iios-co/lio/main/lio-server/deploy/debian-install.sh -o /tmp/lio-install.sh && sudo bash /tmp/lio-install.sh && rm -f /tmp/lio-install.sh

# Or from a cloned repository:
sudo bash lio-server/deploy/debian-install.sh
```

#### What the installer does:
1. Installs minimal system packages (`ca-certificates`, `curl`, `git`, `tar`, `sqlite3`, `python3-venv`).
2. Configures a dedicated system user (`lio`) and state directory (`/var/lib/lio`).
3. Provisions an isolated Python runtime and installs dependencies.
4. Builds the SQLite database from `schema.sql`.
5. Prompts for (or generates) admin credentials in `/etc/lio/lio.env`.
6. Installs and starts the systemd service (`lio-server.service`).
7. Verifies healthcheck on `http://127.0.0.1:8787/healthz`.

#### Managing the Service:

```bash
# Check service status
sudo systemctl status lio-server

# View live service logs
sudo journalctl -u lio-server -f

# Restart service
sudo systemctl restart lio-server
```

---

### 3. Local LAN & HTTP Deployment Notes

Lio is designed to operate out-of-the-box in private, local area network (LAN) home-lab and office environments over plain HTTP:

- **No Mandatory HTTPS**: Session cookies use `SameSite=Lax` without the `Secure` flag by default (`LIO_COOKIE_SECURE=0`), allowing administrative console access over local IP addresses (`http://192.168.x.x:8787`).
- **Native WebSockets**: Real-time push updates connect via standard `ws://` protocols without requiring TLS reverse proxies.
- **Private Subnet Probing**: To verify dead bookmarks pointing to local intranet services, set `LIO_DEADLINK_ALLOW_PRIVATE=1`. Loopback (`127.0.0.1`) and cloud metadata (`169.254.169.254`) remain strictly protected against SSRF.
---

## Manual Setup & Development

### 1. Server & Web UI (`lio-server`)

Requires Python >= 3.12 and Node.js >= 20.

```bash
cd lio-server

# Create virtual environment and install dependencies
python3 -m venv .venv
source .venv/bin/activate
pip install -e '.[dev]'

# Initialize database schema
python -m lio_server --init-db --db-path lio.db

# Set admin password
python -m lio_server --set-admin admin "your-password" --db-path lio.db

# Create your first sync collection
python -m lio_server --create-collection "Personal" --db-path lio.db

# Build Web UI (optional if using pre-built assets in lio_server/web_dist)
cd web-ui && npm install && npm run build && cd ..

# Start development server
python -m lio_server --host 127.0.0.1 --port 8787 --reload
```

Interactive API documentation will be available at `http://127.0.0.1:8787/docs`.

### 2. Browser Extension

The Lio browser extension synchronizes bookmarks and open tab sessions directly from your browser toolbar.

#### Supported Browsers & Distribution:

| Browser | Distribution Channel | Status |
| :--- | :--- | :--- |
| **Google Chrome** | [Chrome Web Store](https://chromewebstore.google.com/) | *Store Submission Pending* |
| **Brave / Vivaldi / Arc** | [Chrome Web Store](https://chromewebstore.google.com/) | *Store Submission Pending* |
| **Microsoft Edge** | [Edge Add-ons](https://microsoftedge.microsoft.com/addons/) | *Store Submission Pending* |
| **Mozilla Firefox** | [Firefox Add-ons (AMO)](https://addons.mozilla.org/) | *AMO Review Pending* |

Pre-packaged production store submission bundles are compiled and attached to each [GitHub Release](https://github.com/iios-co/lio/releases):

- **`lio-extension-chrome.zip`**: Production package ready for upload to the Chrome Web Store and Microsoft Edge Add-ons dashboards.
- **`lio-extension-firefox.zip`**: Production package ready for upload and signing on Mozilla Add-ons (AMO).

*(Modern Chromium and Firefox browsers require extensions to be distributed through their respective official stores for standard one-click installation. Once store reviews complete, direct 1-click install links will be enabled in the table above).*
#### Building Release Packages:
```bash
cd lio-plugin
npm install
npm run zip          # Packages lio-plugin-*-chrome.zip for Chrome Web Store
npm run zip:firefox  # Packages lio-plugin-*-firefox.zip for Mozilla Add-ons
```
#### Pairing Extension with your Lio Server:
1. Click the **Lio** icon in your browser toolbar to open the popup.
2. Enter your **Server Address**:
   - e.g. `http://192.168.1.50:8000` or `http://localhost:8000`
3. Enter your **Collection Token**:
   - Copy this token from your Web Console dashboard at `http://<server-ip>:8000`, or generate one via CLI:
     ```bash
     python -m lio_server --create-collection "Personal"
     ```
4. Select your **Initial Sync Mode**:
   - **Union Merge (Recommended)**: Seamlessly combines bookmarks from this browser with the server collection without duplicating existing links.
   - **Server Wins**: Replaces local browser bookmarks with the collection stored on the server.
   - **Browser Wins**: Uploads this browser's bookmark tree to the server.
5. Click **Connect & Sync**. The live status dot turns green and bookmarks/tabs sync automatically.

---

## Using Port 8000 for the Web UI & Server

Lio serves both the REST/WebSocket API and the embedded single-page Web Management Console on the same port:

- **Proxmox LXC Container**: Pre-configured to run on port `8000` by default (`http://<container-ip>:8000`).
- **Debian/Ubuntu Service**: Set `LIO_PORT=8000` in `/etc/lio/lio.env` and restart the service:
  ```bash
  echo "LIO_PORT=8000" | sudo tee -a /etc/lio/lio.env
  sudo systemctl restart lio-server
  ```
- **Manual / CLI**: Pass `--port 8000` when starting the server:
  ```bash
  python -m lio_server --host 0.0.0.0 --port 8000
  ```

Once started, open `http://<server-ip>:8000` in any web browser to access the Web Console.

## Configuration

Server settings can be configured via environment variables or `/etc/lio/lio.env`:

| Variable | Default | Description |
| :--- | :--- | :--- |
| `LIO_HOST` | `127.0.0.1` | Bind host IP (`0.0.0.0` for all interfaces). |
| `LIO_PORT` | `8787` | HTTP listening port. |
| `LIO_DB_PATH` | `lio.db` | Path to SQLite database file. |
| `LIO_SESSION_SECRET` | *(random)* | Secret key for signing admin authentication session cookies. |
| `LIO_ADMIN_USERNAME` | `admin` | Default admin username. |
| `LIO_ADMIN_PASSWORD` | *(empty)* | Optional env override for admin password. When unset, prompts for first-run setup. |
| `LIO_ALLOWED_TOKENS` | *(empty)* | Allowed collection tokens (comma-separated). When set, only specified tokens may connect. |
| `LIO_AUTO_PROVISION` | `0` | Auto-create collections on first use for unknown bearer tokens (`1` to enable). |
| `LIO_DEADLINK_CHECK` | `1` | Enable link liveness verification (`1` to enable, `0` to disable). |
| `LIO_DEADLINK_ALLOW_PRIVATE` | `0` | Allow probing private LAN IP addresses (RFC1918; set to `1` to enable). |
| `LIO_COOKIE_SECURE` | `0` | Set `Secure` flag on session cookies (`0` for plain HTTP LAN, `1` behind HTTPS). |
| `LIO_DELTA_LOG_MAX_ROWS` | `10000` | Change log retention limit per collection before pruning. |

---

## CLI Reference

The `lio-server` executable includes built-in operational utilities:

```bash
# Initialize or upgrade database schema
python -m lio_server --init-db [--db-path /path/to/lio.db]

# Set or update admin password
python -m lio_server --set-admin <username> <password> [--db-path /path/to/lio.db]

# Create a new sync collection and output its credentials
python -m lio_server --create-collection "Work Bookmarks" [--db-path /path/to/lio.db]

# Run server with custom host and port
python -m lio_server --host 0.0.0.0 --port 8787
```

---

## Testing

Run all test suites across server, extension, and web-ui:

```bash
# Server tests (121 unit and integration tests)
cd lio-server && .venv/bin/python -m pytest

# Web UI tests
cd web-ui && npm test

# Extension client tests
cd lio-plugin && npm test

# Full end-to-end acceptance harness (runs real Chrome against a throwaway server)
./verify.sh
```

---

## License

MIT
