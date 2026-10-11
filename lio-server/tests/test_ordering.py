"""Tests for fractional indexing (canonical) and domain extraction."""

from __future__ import annotations

import pytest

from lio_server.ordering import domain_of, key_between


def test_after_last():
    a = key_between(None, None)
    b = key_between(a, None)
    assert a < b


def test_before_first():
    a = key_between(None, None)
    b = key_between(None, a)
    assert b < a


def test_between_two():
    a = key_between(None, None)
    c = key_between(a, None)
    b = key_between(a, c)
    assert a < b < c


def test_repeated_inserts_between_stay_ordered():
    lo = key_between(None, None)
    hi = key_between(lo, None)
    keys = [lo, hi]
    for _ in range(50):
        mid = key_between(keys[0], keys[1])
        assert keys[0] < mid < keys[1], f"{keys[0]} < {mid} < {keys[1]} failed"
        keys.insert(1, mid)
    assert keys == sorted(keys)
    assert len(set(keys)) == len(keys)


def test_dense_between_same_pair_1000x():
    lo = key_between(None, None)
    hi = key_between(lo, None)
    keys = [lo, hi]
    for _ in range(1000):
        mid = key_between(keys[0], keys[1])
        assert keys[0] < mid < keys[1]
        keys.insert(1, mid)
    assert keys == sorted(keys)
    assert len(set(keys)) == len(keys)


@pytest.mark.parametrize(
    "url,expected",
    [
        ("https://www.example.com/path?q=1", "example.com"),
        ("http://Example.COM", "example.com"),
        ("https://sub.example.co.uk/", "sub.example.co.uk"),
        ("not a url", None),
        ("", None),
        (None, None),
        ("ftp://files.example.org/x", "files.example.org"),
    ],
)
def test_domain_of(url, expected):
    assert domain_of(url) == expected
