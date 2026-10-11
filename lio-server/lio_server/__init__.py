"""lio-server: self-hostable bookmark and tab synchronization server."""

from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path


def get_version_info() -> dict[str, str]:
    ver = (
        os.environ.get("LIO_RELEASE_VERSION")
        or os.environ.get("LIO_SERVER_VERSION")
        or os.environ.get("GITHUB_REF_NAME")
    )
    sha = os.environ.get("LIO_RELEASE_SHA") or os.environ.get("GITHUB_SHA")

    if not ver or not sha:
        try:
            repo_root = Path(__file__).resolve().parent.parent.parent
            if (repo_root / ".git").exists():
                if not ver:
                    ver = (
                        subprocess.check_output(
                            ["git", "describe", "--tags", "--always"],
                            cwd=str(repo_root),
                            stderr=subprocess.DEVNULL,
                            timeout=1,
                        )
                        .decode()
                        .strip()
                    )
                if not sha:
                    sha = (
                        subprocess.check_output(
                            ["git", "rev-parse", "--short=12", "HEAD"],
                            cwd=str(repo_root),
                            stderr=subprocess.DEVNULL,
                            timeout=1,
                        )
                        .decode()
                        .strip()
                    )
        except Exception:
            pass

    clean_ver = (ver or "unknown").lstrip("v")
    if sha and re.fullmatch(r"[0-9a-fA-F]{12}|[0-9a-fA-F]{40}", sha):
        clean_sha = sha[:12].lower()
    else:
        clean_sha = "unknown"

    return {
        "version": clean_ver,
        "sha": clean_sha,
        "display": f"v{clean_ver} ({clean_sha})",
    }


def get_version() -> str:
    return get_version_info()["version"]


__version__ = get_version()
