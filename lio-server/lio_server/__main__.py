"""`lio-server` console entrypoint: CLI commands and server runner."""

from __future__ import annotations
import argparse
import dataclasses
import sys
from pathlib import Path
import uvicorn

from . import __version__, auth, db
from .config import Settings, set_active_settings


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="lio-server",
        description="Self-hostable bookmark and tab synchronization server for Lio.",
    )
    parser.add_argument(
        "-v", "--version",
        action="version",
        version=f"lio-server {__version__}",
    )
    parser.add_argument(
        "--host",
        type=str,
        default=None,
        help="Bind host (default: LIO_HOST env var or 127.0.0.1)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=None,
        help="Bind port (default: LIO_PORT env var or 8787)",
    )
    parser.add_argument(
        "--db-path",
        type=str,
        default=None,
        help="SQLite database file path (default: LIO_DB_PATH or lio.db)",
    )
    parser.add_argument(
        "--reload",
        action="store_true",
        help="Enable uvicorn auto-reload for development",
    )
    parser.add_argument(
        "--init-db",
        action="store_true",
        help="Initialize database tables and indexes from schema.sql then exit",
    )
    parser.add_argument(
        "--set-admin",
        nargs=2,
        metavar=("USERNAME", "PASSWORD"),
        help="Set or update the admin credentials in the database then exit",
    )
    parser.add_argument(
        "--set-admin-stdin",
        metavar="USERNAME",
        type=str,
        help="Set admin credentials reading password from stdin/LIO_ADMIN_PASSWORD then exit",
    )
    parser.add_argument(
        "--create-collection",
        type=str,
        metavar="NAME",
        help="Create a new collection with the given name and output its token",
    )
    args = parser.parse_args()

    settings = Settings.from_env()
    updates = {}
    if args.host:
        updates["host"] = args.host
    if args.port:
        updates["port"] = args.port
    if args.db_path:
        updates["db_path"] = Path(args.db_path)
    if updates:
        settings = dataclasses.replace(settings, **updates)

    set_active_settings(settings)

    if args.init_db:
        db.init_db(settings.db_path)
        print(f"Initialized database schema at {settings.db_path.resolve()}")
        db.close_db()
        return

    if args.set_admin:
        db.init_db(settings.db_path)
        username, password = args.set_admin
        if len(password) < 8:
            print("error: password must be at least 8 characters long", file=sys.stderr)
            sys.exit(1)
        auth.store_account(username, password)
        print(f"Admin account for '{username}' saved successfully in {settings.db_path}")
        db.close_db()
        return

    if args.set_admin_stdin:
        db.init_db(settings.db_path)
        username = args.set_admin_stdin.strip()
        password = os.environ.get("LIO_ADMIN_PASSWORD")
        if not password:
            password = sys.stdin.readline().rstrip("\r\n")
        if len(password) < 8:
            print("error: password must be at least 8 characters long", file=sys.stderr)
            sys.exit(1)
        auth.store_account(username, password)
        print(f"Admin account for '{username}' saved successfully in {settings.db_path}")
        db.close_db()
        return

    if args.create_collection:
        db.init_db(settings.db_path)
        cid = auth.new_collection_id()
        token = auth.new_token()
        with db.write_tx() as conn:
            conn.execute(
                "INSERT INTO collections (id, token, name) VALUES (?, ?, ?)",
                (cid, token, args.create_collection.strip()),
            )
        print(f"Collection '{args.create_collection}' created:")
        print(f"  ID:    {cid}")
        print(f"  Token: {token}")
        db.close_db()
        return

    uvicorn.run(
        "lio_server.app:app",
        host=settings.host,
        port=settings.port,
        reload=args.reload,
        log_level="info",
        proxy_headers=True,
        forwarded_allow_ips="*",
        limit_concurrency=100,
        timeout_keep_alive=30,
    )


if __name__ == "__main__":
    main()
