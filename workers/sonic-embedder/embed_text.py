#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
# SPDX-License-Identifier: AGPL-3.0-only
"""
Text-to-Sound Embedder CLI — msclap CLAP('2023') text encoder.

Reads one JSON object from stdin:
    { "text": "calm piano" }

Writes a single JSON array of 1024 float values to stdout representing the
CLAP text embedding in the same 1024-dim space as media_audio_embeddings:
    [0.012, -0.034, ..., 0.007]   (1024 elements, one line)

The CLAP text embedding lives in the same cosine space as audio embeddings,
so the <=> (cosine distance) pgvector operator can directly compare a text
vector against audio vectors stored in media_audio_embeddings.

All logging goes to stderr. Stdout carries ONLY the JSON array.

Model: CLAP(version='2023', use_cuda=torch.cuda.is_available()).
"""

import json
import sys
import traceback

from embed import load_model


def embed_text(model, text: str) -> list[float]:
    """
    Embed a text query using the CLAP text encoder.

    Returns a list of 1024 floats. Raises on failure.
    The CLAP model's get_text_embeddings expects a list of strings.
    """
    embedding_tensor = model.get_text_embeddings([text])

    # Always move to CPU before converting to numpy, even on CPU-only
    # boxes where .cpu() is a no-op — required for CUDA correctness.
    embedding: list[float] = (
        embedding_tensor.detach().cpu().numpy()[0].tolist()
    )

    if len(embedding) != 1024:
        raise ValueError(
            f"Unexpected embedding dimension: {len(embedding)} (expected 1024)"
        )

    return embedding


def main() -> None:
    # Read exactly one JSON object from stdin.
    raw_input = sys.stdin.read().strip()
    if not raw_input:
        print(
            "[embed_text] stdin was empty — nothing to embed",
            file=sys.stderr,
            flush=True,
        )
        sys.exit(1)

    try:
        payload = json.loads(raw_input)
    except json.JSONDecodeError as exc:
        print(
            f"[embed_text] invalid JSON on stdin: {exc}",
            file=sys.stderr,
            flush=True,
        )
        sys.exit(1)

    text = payload.get("text", "")
    if not isinstance(text, str) or not text.strip():
        print(
            "[embed_text] 'text' key missing or empty — nothing to embed",
            file=sys.stderr,
            flush=True,
        )
        sys.exit(1)

    text = text.strip()
    print(
        f"[embed_text] embedding text query ({len(text)} chars)",
        file=sys.stderr,
        flush=True,
    )

    try:
        model = load_model()
    except Exception as exc:  # noqa: BLE001
        print(
            f"[embed_text] model load failed: {exc}\n{traceback.format_exc()}",
            file=sys.stderr,
            flush=True,
        )
        sys.exit(1)

    try:
        embedding = embed_text(model, text)
    except Exception as exc:  # noqa: BLE001
        print(
            f"[embed_text] embedding failed: {type(exc).__name__}: {exc}",
            file=sys.stderr,
            flush=True,
        )
        sys.exit(1)

    # Write the embedding as a single JSON array on stdout.
    sys.stdout.write(json.dumps(embedding, ensure_ascii=False) + "\n")
    sys.stdout.flush()

    print(
        "[embed_text] done — 1024-dim text vector written to stdout",
        file=sys.stderr,
        flush=True,
    )


if __name__ == "__main__":
    main()
