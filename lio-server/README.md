# lio-server

Self-hostable bookmark and tab synchronization server for [Lio](../README.md).

FastAPI + SQLite. A **token is a collection**: any browser configured with the same token syncs to the same isolated namespace, authenticated with `Authorization: Bearer <token>`.

Includes the embedded Web Management Console (React + Tailwind) served directly at `/`.

---

## Directory Layout

```
lio-server/
├── lio_server/             # FastAPI application
│   ├── routes/             # API route handlers
│   ├── web_dist/           # Pre-compiled static Web UI assets (bundled in wheel)
│   ├── schema.sql          # Authoritative SQLite database schema
│   ├── models.py           # Wire contracts & Pydantic data models
│   ├── db.py               # SQLite connection management, transaction safety & migrations
│   └── __main__.py         # CLI & uvicorn runner
├── deploy/                 # Systemd service units & Debian installer
└── tests/                  # Integration & unit test suite
```

---

## Quick Run

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -e '.[dev]'

# Initialize database schema and create admin user
python -m lio_server --init-db
python -m lio_server --set-admin admin "mypassword"

# Start server
python -m lio_server --reload
```

Interactive API documentation will be available at `http://127.0.0.1:8787/docs`.

---

## Web UI Development

The frontend source lives in `../web-ui/` and compiles into `lio_server/web_dist/` (FastAPI serves this statically with zero Node.js runtime required on the server):

```bash
cd ../web-ui
npm install

# Run frontend dev server with API proxying to http://127.0.0.1:8787
npm run dev

# Build production assets into ../lio_server/web_dist/
npm run build

# Run unit tests
npm test
```

---

## Debian VPC Deployment

An automated installer for Debian / Ubuntu hosts is provided in `deploy/`:

```bash
sudo bash deploy/debian-install.sh
```

Installs an isolated Python runtime, builds the database from `schema.sql`, creates the `lio` system user, and configures the `lio-server.service` systemd unit.

---

## CLI Commands

```bash
# Initialize database tables & indexes from schema.sql
python -m lio_server --init-db [--db-path PATH]

# Set or update admin credentials in database
python -m lio_server --set-admin USERNAME PASSWORD [--db-path PATH]

# Create a new collection and display its token
python -m lio_server --create-collection "Collection Name" [--db-path PATH]

# Start server
python -m lio_server [--host HOST] [--port PORT] [--reload]
```

---

## Testing

```bash
pytest -q
```
