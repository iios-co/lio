"""lio-server: self-hostable bookmark and tab synchronization server."""

import os
import subprocess
from pathlib import Path

__version__ = "0.9.30"


def get_version() -> str:
    env_ver = os.environ.get("LIO_SERVER_VERSION") or os.environ.get("BUILD_VERSION")
    if env_ver:
        return env_ver
    try:
        repo_root = Path(__file__).resolve().parent.parent.parent
        if (repo_root / ".git").exists():
            commit = (
                subprocess.check_output(
                    ["git", "rev-parse", "--short", "HEAD"],
                    cwd=str(repo_root),
                    stderr=subprocess.DEVNULL,
                    timeout=1,
                )
                .decode()
                .strip()
            )
            if commit:
                return f"{__version__}+{commit}"
    except Exception:
        pass
    return __version__
