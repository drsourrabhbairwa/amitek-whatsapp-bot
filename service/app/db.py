"""Postgres access.

A small connection pool over Supabase's transaction pooler. `check` makes the
pool test a connection before handing it out, which is what lets the service
survive the laptop sleeping overnight: the stale socket is quietly replaced
instead of blowing up the first query of the morning.

Every query here is parameterised. Nothing in this file ever builds SQL by
pasting values into a string.
"""
from __future__ import annotations

import logging
from contextlib import contextmanager
from typing import Any, Iterable, Sequence

from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from .config import get_settings

log = logging.getLogger(__name__)
_pool: ConnectionPool | None = None


def pool() -> ConnectionPool:
    global _pool
    if _pool is None:
        url = get_settings().database_url
        if not url:
            raise RuntimeError("DATABASE_URL is empty — fill it in .env")
        _pool = ConnectionPool(
            url,
            min_size=1,
            max_size=8,
            timeout=20,
            max_idle=300,
            check=ConnectionPool.check_connection,
            kwargs={"row_factory": dict_row, "application_name": "amitek-bot"},
        )
        _pool.wait(timeout=20)
        log.info("database pool ready")
    return _pool


@contextmanager
def cursor():
    with pool().connection() as conn:
        with conn.cursor() as cur:
            yield cur


def rows(sql: str, params: Sequence[Any] | None = None) -> list[dict]:
    with cursor() as cur:
        cur.execute(sql, params or ())
        return cur.fetchall()


def one(sql: str, params: Sequence[Any] | None = None) -> dict | None:
    with cursor() as cur:
        cur.execute(sql, params or ())
        return cur.fetchone()


def run(sql: str, params: Sequence[Any] | None = None) -> int:
    with cursor() as cur:
        cur.execute(sql, params or ())
        return cur.rowcount


def run_many(sql: str, seq: Iterable[Sequence[Any]]) -> int:
    with cursor() as cur:
        cur.executemany(sql, list(seq))
        return cur.rowcount


def healthy() -> bool:
    try:
        return one("select 1 as ok") is not None
    except Exception as err:  # noqa: BLE001 - health check must never raise
        log.warning("database health check failed: %s", err)
        return False


def close() -> None:
    global _pool
    if _pool is not None:
        _pool.close()
        _pool = None
