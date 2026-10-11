"""Authentication and collection resolution.

Two distinct roles:

* **Collection token** — a browser/device sync credential. 1 collection == 1
  token. The token is rotatable; the collection's data hangs off a stable
  ``collections.id`` (``cid``). ``require_collection`` resolves a bearer token to
  its ``cid`` and returns that; all data routes key on ``cid``.
* **Admin** — server-wide operator. Authenticated by a signed session cookie
  issued by ``/admin/login`` after checking ``LIO_ADMIN_PASSWORD``. Admin routes
  can manage every collection and mint/rotate tokens.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
import time

from fastapi import Cookie, Header, HTTPException, Path, status

from . import db
from .config import Settings, active_settings

# ---- Token / collection resolution ----------------------------------------


def new_collection_id() -> str:
    return "col_" + secrets.token_hex(12)


def new_token() -> str:
    return secrets.token_urlsafe(12)


def resolve_cid(token: str) -> str | None:
    """Map a bearer token to its stable collection id, or None if unknown."""
    conn = db.get_conn()
    row = conn.execute(
        "SELECT id FROM collections WHERE token = ?", (token,)
    ).fetchone()
    return row["id"] if row else None


def ensure_collection(token: str, settings: Settings | None = None) -> str:
    """Return the cid for ``token``.

    An unknown token is REJECTED with 404 unless the server explicitly enables
    ``auto_provision`` (LIO_AUTO_PROVISION=1). Auto-provisioning made every token
    valid, so a device holding a rotated or deleted collection's token kept
    receiving 200s while syncing into a phantom collection named after the token.
    """
    cid = resolve_cid(token)
    if cid is not None:
        return cid

    settings = settings or active_settings()
    if not settings.auto_provision:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=(
                "Unknown collection token. Create the collection in the admin "
                "console and paste its current token into this device."
            ),
        )

    cid = new_collection_id()
    with db.write_tx() as conn:
        conn.execute(
            "INSERT INTO collections (id, token, name) VALUES (?, ?, ?)",
            (cid, token, token),
        )
    return cid


def require_collection(
    token: str = Path(..., description="Collection token."),
    authorization: str | None = Header(default=None),
) -> str:
    """FastAPI dependency for token-scoped data routes. Authenticates the bearer
    token against the path token and returns the resolved collection id (cid).
    """
    settings = active_settings()

    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or malformed Authorization header.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    header_token = authorization[len("Bearer ") :].strip()
    if not hmac.compare_digest(header_token, token):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token in Authorization header does not match collection.",
        )
    if settings.allowed_tokens and token not in settings.allowed_tokens:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Token not permitted on this server.",
        )
    return ensure_collection(token, settings)


# ---- Admin session ---------------------------------------------------------

_SESSION_TTL_SECONDS = 7 * 24 * 3600
ADMIN_COOKIE = "lio_admin"

_TOKEN_VERSION_KEY = "admin_token_version"


def get_admin_token_version() -> int:
    val = _get_setting(_TOKEN_VERSION_KEY)
    try:
        return int(val) if val is not None else 0
    except ValueError:
        return 0


def revoke_admin_session() -> None:
    current = get_admin_token_version()
    with db.write_tx() as conn:
        conn.execute(
            "INSERT INTO app_settings (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (_TOKEN_VERSION_KEY, str(current + 1)),
        )


def _sign(value: str, secret: str) -> str:
    mac = hmac.new(secret.encode(), value.encode(), hashlib.sha256).hexdigest()
    return f"{value}.{mac}"


def _verify(signed: str, secret: str) -> bool:
    if "." not in signed:
        return False
    value, mac = signed.rsplit(".", 1)
    expected = hmac.new(secret.encode(), value.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(mac, expected):
        return False
    parts = value.split(":")
    if len(parts) < 2:
        return False
    try:
        issued = int(parts[0])
    except ValueError:
        return False
    if (time.time() - issued) >= _SESSION_TTL_SECONDS:
        return False
    if len(parts) >= 3:
        try:
            ver = int(parts[1])
            if ver != get_admin_token_version():
                return False
        except ValueError:
            return False
    return True


def issue_admin_cookie(settings: Settings) -> str:
    """Create a signed, timestamped admin session cookie value."""
    ver = get_admin_token_version()
    payload = f"{int(time.time())}:{ver}:{secrets.token_hex(8)}"
    return _sign(payload, settings.session_secret)

# ---- Admin password: env override, else DB-stored PBKDF2 hash --------------

_PW_KEY = "admin_password_hash"
_USER_KEY = "admin_username"
_PBKDF2_ROUNDS = 200_000


def _hash_password(password: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, _PBKDF2_ROUNDS)
    return f"pbkdf2_sha256${_PBKDF2_ROUNDS}${salt.hex()}${dk.hex()}"


def _verify_password_hash(password: str, stored: str) -> bool:
    try:
        algo, rounds_s, salt_hex, dk_hex = stored.split("$")
        if algo != "pbkdf2_sha256":
            return False
        dk = hashlib.pbkdf2_hmac(
            "sha256", password.encode(), bytes.fromhex(salt_hex), int(rounds_s)
        )
        return hmac.compare_digest(dk.hex(), dk_hex)
    except (ValueError, AttributeError):
        return False


def _get_setting(key: str) -> str | None:
    conn = db.get_conn()
    row = conn.execute(
        "SELECT value FROM app_settings WHERE key = ?", (key,)
    ).fetchone()
    return row["value"] if row else None


def _stored_hash() -> str | None:
    return _get_setting(_PW_KEY)


def stored_username() -> str | None:
    """The configured admin username: the env override's implicit name, or the
    one captured at first-run setup."""
    settings = active_settings()
    if settings.admin_password:
        return settings.admin_username or "admin"
    return _get_setting(_USER_KEY)


def store_account(username: str, password: str) -> None:
    """Persist the single admin account (first-run setup / change)."""
    with db.write_tx() as conn:
        conn.executemany(
            "INSERT INTO app_settings (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [(_USER_KEY, username), (_PW_KEY, _hash_password(password))],
        )


def setup_first_account(username: str, password: str, settings: Settings) -> None:
    """Atomically create the admin account during first-run setup.
    Raises HTTPException(409) if an admin account is already configured.
    """
    if bool(settings.admin_password):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Admin account already set.",
        )
    with db.write_tx() as conn:
        rows = conn.execute(
            "SELECT key FROM app_settings WHERE key IN (?, ?)",
            (_USER_KEY, _PW_KEY),
        ).fetchall()
        if rows:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Admin account already set.",
            )
        conn.executemany(
            "INSERT INTO app_settings (key, value) VALUES (?, ?)",
            [(_USER_KEY, username), (_PW_KEY, _hash_password(password))],
        )

def admin_is_configured(settings: Settings) -> bool:
    """True when an admin account exists (env override or stored hash)."""
    return bool(settings.admin_password) or _stored_hash() is not None


def check_admin_credentials(
    username: str, password: str, settings: Settings
) -> bool:
    """Verify username + password against the env override or the stored account.
    Username comparison is case-insensitive and constant-time on the password."""
    if settings.admin_password:
        env_user = settings.admin_username or "admin"
        user_ok = hmac.compare_digest(username.lower(), env_user.lower())
        pass_ok = hmac.compare_digest(password, settings.admin_password)
        return user_ok and pass_ok
    stored = _stored_hash()
    stored_user = _get_setting(_USER_KEY)
    if stored is None or stored_user is None:
        return False
    user_ok = hmac.compare_digest(username.lower(), stored_user.lower())
    return user_ok and _verify_password_hash(password, stored)


def require_admin(lio_admin: str | None = Cookie(default=None)) -> None:
    """FastAPI dependency gating admin routes on a valid session cookie."""
    settings = active_settings()
    if not admin_is_configured(settings):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin password not set. Complete first-run setup.",
        )
    if not lio_admin or not _verify(lio_admin, settings.session_secret):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Admin authentication required.",
        )
