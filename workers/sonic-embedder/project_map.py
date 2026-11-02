#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
# SPDX-License-Identifier: AGPL-3.0-only
"""
Music Map UMAP Projection CLI

Reads all media_audio_embeddings rows for model_id='msclap-2023',
runs UMAP to project 1024-dim vectors into 2D space, and writes
the (x, y) coordinates to stdout as JSONL.

Input: none (reads environment variables for DB connection)
Output (stdout): one JSONL line per track:
    { "media_id": "<uuid>", "x": 0.312, "y": 0.741 }

Coordinates are normalised to [0, 1] after projection.

Environment variables (required):
    DATABASE_URL  — PostgreSQL connection string

Usage (called by the sonic-map-projection Node task):
    DATABASE_URL=postgres://... python3 workers/sonic-embedder/project_map.py

Options (env):
    UMAP_N_NEIGHBORS     — UMAP n_neighbors parameter (default 15)
    UMAP_MIN_DIST        — UMAP min_dist parameter (default 0.1)
    UMAP_METRIC          — UMAP metric (default 'cosine')
    UMAP_RANDOM_STATE    — Random seed for reproducibility (default 42)
    UMAP_N_EPOCHS        — UMAP n_epochs (default None = auto)
    MODEL_ID             — Embedding model to read (default 'msclap-2023')
"""

import json
import os
import sys
import traceback
from collections.abc import Sequence

from db_utils import get_embeddings_from_db


def normalise_coords(xs: list[float], ys: list[float]) -> tuple[list[float], list[float]]:
    """
    Normalise a pair of coordinate arrays to [0, 1].
    Returns (norm_xs, norm_ys).  Falls back to 0.5 when all values are equal.
    """
    import numpy as np

    x_arr = np.array(xs, dtype=np.float32)
    y_arr = np.array(ys, dtype=np.float32)

    x_min, x_max = float(x_arr.min()), float(x_arr.max())
    y_min, y_max = float(y_arr.min()), float(y_arr.max())

    x_range = x_max - x_min
    y_range = y_max - y_min

    if x_range < 1e-9:
        norm_xs = [0.5] * len(xs)
    else:
        norm_xs = ((x_arr - x_min) / x_range).tolist()

    if y_range < 1e-9:
        norm_ys = [0.5] * len(ys)
    else:
        norm_ys = ((y_arr - y_min) / y_range).tolist()

    return norm_xs, norm_ys


def run_umap(
    embeddings: Sequence[Sequence[float]],
    n_neighbors: int,
    min_dist: float,
    metric: str,
    random_state: int,
    n_epochs: int | None,
) -> tuple[list[float], list[float]]:
    """
    Run UMAP on the given embedding matrix.
    Returns (xs, ys) as lists of floats (raw 2D projection).
    """
    import numpy as np
    import umap  # type: ignore[import]

    X = np.array(embeddings, dtype=np.float32)

    print(
        f"[project_map] running UMAP: {X.shape[0]} points × {X.shape[1]} dims, "
        f"n_neighbors={n_neighbors}, min_dist={min_dist}, metric={metric}",
        file=sys.stderr,
        flush=True,
    )

    umap_kwargs: dict = {
        "n_components": 2,
        "n_neighbors": n_neighbors,
        "min_dist": min_dist,
        "metric": metric,
        "random_state": random_state,
        "low_memory": False,
    }
    if n_epochs is not None:
        umap_kwargs["n_epochs"] = n_epochs

    reducer = umap.UMAP(**umap_kwargs)
    embedding_2d = reducer.fit_transform(X)

    xs = embedding_2d[:, 0].tolist()
    ys = embedding_2d[:, 1].tolist()
    return xs, ys


def run_projection(
    rows: list[tuple[str, Sequence[float]]],
    n_neighbors: int,
    min_dist: float,
    metric: str,
    random_state: int,
    n_epochs: int | None,
) -> list[str]:
    """
    Run the scatter/clamp/UMAP/normalise pipeline on the given rows.

    Takes a list of (media_id, embedding) pairs (as returned by
    get_embeddings_from_db) and UMAP hyperparameters; returns a list of
    JSONL strings, one per track, of the form:
        '{"media_id": "<uuid>", "x": <float>, "y": <float>}'

    Raises on UMAP failure (caller should catch and propagate as appropriate).
    An empty rows list returns an empty list without error.
    """
    import math

    if len(rows) == 0:
        return []

    media_ids = [r[0] for r in rows]
    embeddings = [r[1] for r in rows]
    lines: list[str] = []

    if len(rows) < 4:
        # UMAP needs at least n_neighbors+1 points; for tiny sets just scatter
        # them uniformly to avoid a crash.
        print(
            f"[project_map] only {len(rows)} points — too few for UMAP, scattering uniformly",
            file=sys.stderr,
            flush=True,
        )
        step = 1.0 / max(len(rows), 1)
        for i, media_id in enumerate(media_ids):
            angle = 2 * math.pi * i * step
            x = 0.5 + 0.4 * math.cos(angle)
            y = 0.5 + 0.4 * math.sin(angle)
            lines.append(json.dumps({"media_id": media_id, "x": round(x, 6), "y": round(y, 6)}, ensure_ascii=False))
        return lines

    # Clamp n_neighbors to be at most len(rows)-1 (UMAP requirement)
    effective_n_neighbors = min(n_neighbors, len(rows) - 1)
    if effective_n_neighbors != n_neighbors:
        print(
            f"[project_map] clamping n_neighbors from {n_neighbors} to {effective_n_neighbors}",
            file=sys.stderr,
            flush=True,
        )

    xs, ys = run_umap(embeddings, effective_n_neighbors, min_dist, metric, random_state, n_epochs)
    norm_xs, norm_ys = normalise_coords(xs, ys)

    for media_id, x, y in zip(media_ids, norm_xs, norm_ys):
        lines.append(json.dumps({"media_id": media_id, "x": round(x, 6), "y": round(y, 6)}, ensure_ascii=False))

    return lines


def main() -> None:
    database_url = os.environ.get("DATABASE_URL", "")
    if not database_url:
        print("[project_map] DATABASE_URL environment variable is required", file=sys.stderr, flush=True)
        sys.exit(1)

    model_id = os.environ.get("MODEL_ID", "msclap-2023")
    n_neighbors = int(os.environ.get("UMAP_N_NEIGHBORS", "15"))
    min_dist = float(os.environ.get("UMAP_MIN_DIST", "0.1"))
    metric = os.environ.get("UMAP_METRIC", "cosine")
    random_state = int(os.environ.get("UMAP_RANDOM_STATE", "42"))
    n_epochs_raw = os.environ.get("UMAP_N_EPOCHS", "")
    n_epochs: int | None = int(n_epochs_raw) if n_epochs_raw.strip() else None

    print(f"[project_map] loading embeddings from DB (model_id={model_id!r})", file=sys.stderr, flush=True)

    try:
        rows = get_embeddings_from_db(database_url, model_id)
    except Exception as exc:
        print(
            f"[project_map] failed to load embeddings: {type(exc).__name__}: {exc}\n{traceback.format_exc()}",
            file=sys.stderr,
            flush=True,
        )
        sys.exit(1)

    if len(rows) == 0:
        print("[project_map] no embeddings found — nothing to project", file=sys.stderr, flush=True)
        # Output empty stream so Node sees a clean exit
        return

    print(f"[project_map] loaded {len(rows)} embeddings", file=sys.stderr, flush=True)

    try:
        lines = run_projection(rows, n_neighbors, min_dist, metric, random_state, n_epochs)
    except Exception as exc:
        print(
            f"[project_map] UMAP failed: {type(exc).__name__}: {exc}\n{traceback.format_exc()}",
            file=sys.stderr,
            flush=True,
        )
        sys.exit(1)

    for line in lines:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()

    print(
        f"[project_map] done — projected {len(lines)} points",
        file=sys.stderr,
        flush=True,
    )


if __name__ == "__main__":
    main()
