"""Ordering + URL helpers.

Fractional indexing lets us reorder a single item by rewriting only its own key,
never renumbering siblings. ``sort_key`` values are strings compared
lexicographically; to place an item between two neighbours we compute a string
that sorts strictly between their keys.

The algorithm is subtle at the boundaries (min-terminated keys, exhausted digit
ranges, the integer-part "head" markers), so rather than hand-roll it we delegate
to the maintained ``fractional-indexing`` package — a direct port of the
canonical rocicorp/fractional-indexing implementation. Keys look like ``"a0"``,
``"a1"``, ``"Zz"`` (a head char + digits) and always sort correctly.
"""

from __future__ import annotations

from urllib.parse import urlsplit

from fractional_indexing import generate_key_between


def key_between(a: str | None, b: str | None) -> str:
    """Return a ``sort_key`` that sorts strictly between ``a`` and ``b``.

    ``a is None`` = before the first item; ``b is None`` = after the last.
    Requires ``a < b`` when both are given (the underlying library also accepts
    them in either order, but we keep the strict contract for clarity).
    """
    return generate_key_between(a, b)


def domain_of(url: str | None) -> str | None:
    """Extract a lowercase host from a URL, or None. Strips a leading ``www.``."""
    if not url:
        return None
    try:
        host = urlsplit(url).hostname
    except ValueError:
        return None
    if not host:
        return None
    host = host.lower()
    return host[4:] if host.startswith("www.") else host
