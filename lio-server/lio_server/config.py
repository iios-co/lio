"""Runtime configuration for lio-server, sourced from environment variables."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


# A per-process random secret used to sign admin cookies when the operator has
# not set LIO_SESSION_SECRET. Stable for the life of the process (so cookies
# stay valid across requests) but resets on restart (so sessions do too).
_PROCESS_SECRET: str | None = None


def _process_secret() -> str:
    global _PROCESS_SECRET
    if _PROCESS_SECRET is None:
        import secrets

        _PROCESS_SECRET = secrets.token_hex(32)
    return _PROCESS_SECRET


# The settings the running app was created with. Request-time dependencies read
# this rather than re-deriving from the environment, so an injected Settings
# (e.g. in tests) is honoured. Falls back to from_env() if never set.
_ACTIVE: "Settings | None" = None


def set_active_settings(settings: "Settings") -> None:
    global _ACTIVE
    _ACTIVE = settings


def active_settings() -> "Settings":
    return _ACTIVE if _ACTIVE is not None else Settings.from_env()


@dataclass(frozen=True)
class Settings:
    """Immutable server settings."""

    # Absolute path to the SQLite database file.
    db_path: Path
    # Bind host/port for uvicorn when launched via `lio-server`.
    host: str
    port: int
    # If set, only these tokens may be used. Empty means any token
    # auto-provisions its own collection on first use (open mode).
    allowed_tokens: frozenset[str]
    # Retention cap for the delta_log change feed. Rows beyond this count
    # per collection are pruned oldest-first; a device that falls further
    # behind must re-bootstrap via the full-tree endpoint.
    delta_log_max_rows: int
    # Dead-link liveness checking runs ONLY when the operator triggers it (the
    # console's "Check links" button) on an authenticated collection route — never
    # as background polling — so it defaults ON and a server that must make zero
    # outbound requests sets LIO_DEADLINK_CHECK=0. Private/loopback targets are
    # skipped unless explicitly allowed (SSRF guard relaxation for intranet
    # bookmark sets, which is the normal case for a self-hosted LAN).
    deadlink_check_enabled: bool
    deadlink_allow_private: bool
    # Admin console. When admin_password is empty the admin API returns 503
    # (console disabled). session_secret signs admin cookies; a random one is
    # generated per process if unset (sessions then reset on restart).
    admin_password: str
    admin_username: str
    session_secret: str
    # When True an UNKNOWN bearer token silently creates a new collection
    # ("open mode"). That makes every token valid, so a device holding a stale or
    # rotated token keeps reporting success while writing into a phantom
    # collection — which is why this defaults to False. Tokens are credentials
    # minted by the admin; an unrecognised one must be rejected.
    auto_provision: bool = False
    deadlink_verify_ssl: bool = True
    cookie_secure: bool = False

    @staticmethod
    def from_env() -> "Settings":
        db_path = Path(
            os.environ.get("LIO_DB_PATH", "lio.db")
        ).expanduser().resolve()

        tokens_raw = os.environ.get("LIO_ALLOWED_TOKENS", "").strip()
        allowed = (
            frozenset(t.strip() for t in tokens_raw.split(",") if t.strip())
            if tokens_raw
            else frozenset()
        )

        return Settings(
            db_path=db_path,
            host=os.environ.get("LIO_HOST", "127.0.0.1"),
            port=_env_int("LIO_PORT", 8787),
            allowed_tokens=allowed,
            delta_log_max_rows=_env_int("LIO_DELTA_LOG_MAX_ROWS", 10_000),
            deadlink_check_enabled=_env_bool("LIO_DEADLINK_CHECK", True),
            deadlink_allow_private=_env_bool("LIO_DEADLINK_ALLOW_PRIVATE", False),
            deadlink_verify_ssl=_env_bool("LIO_DEADLINK_VERIFY_SSL", True),
            cookie_secure=_env_bool("LIO_COOKIE_SECURE", False),
            admin_password=os.environ.get("LIO_ADMIN_PASSWORD", ""),
            admin_username=os.environ.get("LIO_ADMIN_USERNAME", "admin"),
            session_secret=os.environ.get("LIO_SESSION_SECRET", "")
            or _process_secret(),
            auto_provision=_env_bool("LIO_AUTO_PROVISION", False),
        )
