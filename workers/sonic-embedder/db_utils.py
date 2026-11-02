#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
# SPDX-License-Identifier: AGPL-3.0-only
"""
Shared database utilities for the sonic-embedder worker scripts.

Extracted from project_map.py and cluster.py to eliminate the duplicated
get_embeddings_from_db() implementation (#3 in the dedup audit).

Both project_map.py and cluster.py import this module:
    from db_utils import get_embeddings_from_db
"""

from __future__ import annotations

import sys
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import numpy as np


# Rows fetched per round trip from the server-side cursor.
_FETCH_ROWS = 2000


def _parse_vector(text: str) -> np.ndarray:
    """pgvector text '[0.1,0.2,...]' -> 1-D float32 ndarray.

    Same values as the old list[float] path: each component goes through Python
    float() (double) and is then rounded to float32, exactly what
    np.array(list_of_lists, dtype=np.float32) in run_umap/run_kmeans did.
    """
    import numpy as np

    return np.array([float(x) for x in text.strip("[]").split(",")], dtype=np.float32)


def get_embeddings_from_db(database_url: str, model_id: str) -> list[tuple[str, np.ndarray]]:
    """
    Fetch all (media_id, embedding) pairs from media_audio_embeddings.

    Returns a list of (media_id_str, float32 ndarray) tuples, ordered by
    media_id for deterministic output.

    Memory: rows stream through a server-side cursor and each vector is stored
    as a float32 array (4 KB for 1024 dims). The old version fetchall()'d every
    row as text and kept each vector as a list of Python floats (~32 bytes per
    component): ~1.4 GB transient for 31.7k tracks, twice over when /cluster and
    /project-map run together, and glibc kept most of it after the job.

    Raises ImportError if psycopg2 is not installed, or any psycopg2 /
    network exception if the database is unreachable or the query fails.

    This function is the single authoritative copy; project_map.py and
    cluster.py both import it instead of maintaining their own copies.
    """
    try:
        import psycopg2
    except ImportError:
        print(
            "[db_utils] psycopg2 not available — install psycopg2-binary",
            file=sys.stderr,
            flush=True,
        )
        raise

    result = []
    conn = psycopg2.connect(database_url)
    try:
        # A named cursor is server-side: rows arrive _FETCH_ROWS at a time.
        with conn.cursor(name="sonic_embeddings") as cur:
            cur.itersize = _FETCH_ROWS
            cur.execute(
                """
                SELECT media_id::text, embedding::text
                FROM media_audio_embeddings
                WHERE model_id = %s
                ORDER BY media_id
                """,
                (model_id,),
            )
            for media_id, vec_str in cur:
                result.append((media_id, _parse_vector(vec_str)))
    finally:
        conn.close()

    return result


def count_embeddings(database_url: str, model_id: str) -> int:
    """Rows get_embeddings_from_db() would load (the memory gate costs the job by it)."""
    import psycopg2

    conn = psycopg2.connect(database_url)
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT count(*) FROM media_audio_embeddings WHERE model_id = %s", (model_id,)
            )
            return int(cur.fetchone()[0])
    finally:
        conn.close()
