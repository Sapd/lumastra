#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
# SPDX-License-Identifier: AGPL-3.0-only
"""
Sonic Clustering CLI — KMeans over MSCLAP audio embeddings.

Reads all rows from media_audio_embeddings (model_id='msclap-2023') from the
database, runs KMeans into K clusters, and writes one JSONL line per track to
stdout:

    { "media_id": "<uuid>", "cluster_id": <int> }

Mirrors project_map.py's DB-read + JSONL-out contract.

Environment variables:
    DATABASE_URL      — PostgreSQL connection string (required)
    MODEL_ID          — Embedding model to read (default 'msclap-2023')
    SONIC_CLUSTER_K   — Number of clusters (default 12)
    CLUSTER_RANDOM_STATE — Random seed for reproducibility (default 42)
    CLUSTER_MAX_ITER  — KMeans max iterations (default 300)

Usage (called by the sonic-clustering Node task):
    DATABASE_URL=postgres://... python3 workers/sonic-embedder/cluster.py
"""

import json
import os
import sys
import traceback
from collections.abc import Sequence

from db_utils import get_embeddings_from_db


def run_kmeans(
    embeddings: Sequence[Sequence[float]],
    n_clusters: int,
    random_state: int,
    max_iter: int,
) -> list[int]:
    """
    Run KMeans clustering on the given embedding matrix.
    Returns a list of integer cluster labels (one per row), in input order.
    """
    import numpy as np
    from sklearn.cluster import KMeans  # type: ignore[import]

    X = np.array(embeddings, dtype=np.float32)

    # KMeans requires at least n_clusters points; clamp safely.
    effective_k = min(n_clusters, X.shape[0])
    if effective_k != n_clusters:
        print(
            f"[cluster] clamping K from {n_clusters} to {effective_k} "
            f"(only {X.shape[0]} embeddings available)",
            file=sys.stderr,
            flush=True,
        )

    print(
        f"[cluster] running KMeans: {X.shape[0]} tracks × {X.shape[1]} dims, "
        f"K={effective_k}, random_state={random_state}, max_iter={max_iter}",
        file=sys.stderr,
        flush=True,
    )

    kmeans = KMeans(
        n_clusters=effective_k,
        random_state=random_state,
        max_iter=max_iter,
        n_init="auto",
    )
    labels: list[int] = kmeans.fit_predict(X).tolist()

    print(
        f"[cluster] KMeans complete — inertia={kmeans.inertia_:.4f}",
        file=sys.stderr,
        flush=True,
    )

    return labels


def main() -> None:
    database_url = os.environ.get("DATABASE_URL", "")
    if not database_url:
        print("[cluster] DATABASE_URL environment variable is required", file=sys.stderr, flush=True)
        sys.exit(1)

    model_id = os.environ.get("MODEL_ID", "msclap-2023")
    n_clusters = int(os.environ.get("SONIC_CLUSTER_K", "12"))
    random_state = int(os.environ.get("CLUSTER_RANDOM_STATE", "42"))
    max_iter = int(os.environ.get("CLUSTER_MAX_ITER", "300"))

    print(
        f"[cluster] loading embeddings from DB (model_id={model_id!r})",
        file=sys.stderr,
        flush=True,
    )

    try:
        rows = get_embeddings_from_db(database_url, model_id)
    except Exception as exc:
        print(
            f"[cluster] failed to load embeddings: {type(exc).__name__}: {exc}\n{traceback.format_exc()}",
            file=sys.stderr,
            flush=True,
        )
        sys.exit(1)

    if len(rows) == 0:
        print("[cluster] no embeddings found — nothing to cluster", file=sys.stderr, flush=True)
        # Output empty stream so Node sees a clean exit
        return

    print(f"[cluster] loaded {len(rows)} embeddings", file=sys.stderr, flush=True)

    media_ids = [r[0] for r in rows]
    embeddings = [r[1] for r in rows]

    try:
        labels = run_kmeans(embeddings, n_clusters, random_state, max_iter)
    except Exception as exc:
        print(
            f"[cluster] KMeans failed: {type(exc).__name__}: {exc}\n{traceback.format_exc()}",
            file=sys.stderr,
            flush=True,
        )
        sys.exit(1)

    success = 0
    for media_id, cluster_id in zip(media_ids, labels):
        sys.stdout.write(
            json.dumps({"media_id": media_id, "cluster_id": cluster_id}, ensure_ascii=False) + "\n"
        )
        sys.stdout.flush()
        success += 1

    print(
        f"[cluster] done — wrote {success} assignments across {len(set(labels))} clusters",
        file=sys.stderr,
        flush=True,
    )


if __name__ == "__main__":
    main()
