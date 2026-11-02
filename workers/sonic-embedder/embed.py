#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
# SPDX-License-Identifier: AGPL-3.0-only
"""
Sonic Embedder CLI — msclap CLAP('2023') batch audio embedder.

Reads one JSON object from stdin:
    { "paths": ["/abs/path/to/track1.flac", "/abs/path/to/track2.mp3", ...] }

Writes one JSONL line per input path to stdout:
    Success: { "path": "/abs/path/to/track1.flac", "embedding": [0.012, ..., -0.034] }
    Failure: { "path": "/abs/path/to/track2.mp3",  "error": "error message string"   }

Embedding dimensionality: 1024 floats (float32).
Model: CLAP(version='2023', use_cuda=torch.cuda.is_available()).

All logging goes to stderr. Stdout carries ONLY the JSONL result lines.
"""

import hashlib
import json
import os
import sys
import traceback

# P1 (2026-09-16): the DEFAULT path below (SONIC_MODEL_FP unset — the only
# active configuration in docker-compose.example.yml) used to download
# CLAP_weights_2023.pth from HuggingFace with no revision pin and no digest
# check, then hand it straight to CLAP()/torch.load(). A tampered .pth is a
# torch pickle: loading one runs arbitrary code as this process (see
# 469fd08b0's own commit message, which fixed exactly this for the opt-in
# SONIC_MODEL_FP path only, via the `if model_fp:` guard below).
#
# Both constants were captured from HuggingFace's raw git blob for the file
# at this commit — NOT by downloading the 690MB LFS-resolved weights
# themselves, which is the network fetch this fix avoids trusting blindly.
# `raw/<rev>/<path>` on a Git-LFS-tracked file serves the small (134-byte)
# LFS *pointer* text, which already names the object's sha256 and size:
#
#   curl -sI https://huggingface.co/microsoft/msclap/raw/main/CLAP_weights_2023.pth
#     x-repo-commit: c47d441165daa21986ead0850660917636a81775
#   curl -s  https://huggingface.co/microsoft/msclap/raw/main/CLAP_weights_2023.pth
#     version https://git-lfs.github.com/spec/v1
#     oid sha256:2cef4016d47d00eb28d153d522f397222057f95000e9bad6b9583c631284a1e6
#     size 689950036
#
# The commit SHA matches `curl -s https://huggingface.co/api/models/microsoft/msclap`'s
# top-level "sha" (the repo's current HEAD at the time this was pinned), so
# this is the exact, current, unmodified file — re-verify the same way (or
# via `hf_hub_download`'s own metadata) before ever changing these values,
# and never accept a value you have not independently confirmed against
# HuggingFace's own metadata for the file.
CLAP_WEIGHTS_REVISION = "c47d441165daa21986ead0850660917636a81775"
CLAP_WEIGHTS_SHA256 = "2cef4016d47d00eb28d153d522f397222057f95000e9bad6b9583c631284a1e6"


def _verify_model_sha256(
    model_fp: str, expected_sha256: str, source: str = "the expected digest"
) -> None:
    """Verify model_fp's SHA256 digest matches expected_sha256 (case-insensitive
    hex). Raises ValueError on mismatch or if model_fp cannot be read.

    This is the supply-chain gate for a pinned weights file, called from TWO
    places with different provenance for expected_sha256: the operator-set
    SONIC_MODEL_SHA256 env var (offline/air-gapped SONIC_MODEL_FP path) and
    the module-level CLAP_WEIGHTS_SHA256 constant (default HuggingFace
    download path, P1). `source` names which one, for the error message
    ONLY — a mismatch on the default path used to say "SONIC_MODEL_SHA256
    mismatch" even though that env var was never set, pointing an operator
    at the wrong knob to fix. Same verification pattern used elsewhere in
    this repo (scripts/ffmpeg/resolve-asset.ts, the Essentia extractor in
    the main Dockerfile) for a binary fetched or mounted from outside our
    own source tree.
    """
    hasher = hashlib.sha256()
    with open(model_fp, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            hasher.update(chunk)
    actual = hasher.hexdigest()
    if actual.lower() != expected_sha256.strip().lower():
        raise ValueError(
            f"SHA256 mismatch for {model_fp!r} against {source}: "
            f"expected {expected_sha256!r}, got {actual!r}. Refusing to load."
        )


def load_model():
    """Load and return the CLAP model. Raises on failure.

    By default (SONIC_MODEL_FP unset) the CLAP-2023 weights auto-download
    from HuggingFace (microsoft/msclap) via hf_hub_download, pinned to
    CLAP_WEIGHTS_REVISION and verified against CLAP_WEIGHTS_SHA256 (both
    module-level constants, above) BEFORE CLAP unpickles the file — a .pth is
    a torch pickle; loading a tampered one runs arbitrary code as this
    process (P1). The download is cached under HF_HOME exactly as before, so
    this is still only a fetch on first boot per volume.

    For offline / air-gapped installs (or to pin a different vetted weights
    file, e.g. for compliance), set SONIC_MODEL_FP to the absolute path of a
    local weights .pth and CLAP loads from there instead of downloading.
    Optionally set SONIC_MODEL_SHA256 to that file's expected SHA256 digest —
    when set, it is hashed and verified the same way, against your own value
    instead of the pinned CLAP_WEIGHTS_SHA256 constant.
    """
    import torch
    from msclap import CLAP

    use_cuda = torch.cuda.is_available()
    model_fp = os.environ.get("SONIC_MODEL_FP", "").strip()
    model_sha256 = os.environ.get("SONIC_MODEL_SHA256", "").strip()

    if model_fp:
        if model_sha256:
            _verify_model_sha256(model_fp, model_sha256, source="SONIC_MODEL_SHA256")
            print(
                f"[sonic-embedder] SONIC_MODEL_SHA256 verified for {model_fp!r}",
                file=sys.stderr,
                flush=True,
            )
        model = CLAP(version='2023', use_cuda=use_cuda, model_fp=model_fp)
        print(
            f"[sonic-embedder] model loaded (cuda={use_cuda}) "
            f"from local SONIC_MODEL_FP={model_fp!r}",
            file=sys.stderr,
            flush=True,
        )
    else:
        from huggingface_hub import hf_hub_download

        # Pin BOTH the revision (which commit's copy of the file) and verify
        # its digest (that the bytes at that commit are what we expect)
        # before this ever reaches CLAP()/torch.load(). hf_hub_download
        # caches under HF_HOME exactly like msclap's own unpinned downloader
        # did, so this is still a one-time-per-volume fetch, not a fetch on
        # every boot.
        downloaded_fp = hf_hub_download(
            repo_id="microsoft/msclap",
            filename="CLAP_weights_2023.pth",
            revision=CLAP_WEIGHTS_REVISION,
        )
        _verify_model_sha256(
            downloaded_fp, CLAP_WEIGHTS_SHA256, source="the pinned CLAP_WEIGHTS_SHA256 constant"
        )
        model = CLAP(version='2023', use_cuda=use_cuda, model_fp=downloaded_fp)
        print(
            f"[sonic-embedder] model loaded (cuda={use_cuda}) from HuggingFace "
            f"pinned revision {CLAP_WEIGHTS_REVISION[:12]} (sha256-verified)",
            file=sys.stderr,
            flush=True,
        )
    return model


def embed_paths(model, paths: list[str], infos: dict | None = None) -> list[dict]:
    """
    Embed a list of audio file paths using the loaded CLAP model.

    Returns one result dict per input path (success or failure).
    Per-file errors are caught individually so one bad file does not
    abort the rest of the batch.

    `infos` maps a path to its windowed_embed.AudioInfo (the server probes for its
    memory gate and passes them on); missing paths are probed here. A file with a
    readable header is embedded from a bounded decode of the crop msclap would have
    taken (windowed_embed.py); one ffprobe cannot read, or one shorter than the 7 s
    window, goes through msclap's own full-decode path as before.
    """
    import torch
    from windowed_embed import embed_windowed, probe

    results = []

    for path in paths:
        try:
            # A path the server already probed is not probed again, also when that
            # probe failed (None): msclap's path then decodes it, as before.
            info = infos[path] if infos is not None and path in infos else probe(path)
            embedding_tensor = embed_windowed(model, path, info) if info is not None else None
            if embedding_tensor is None:
                # get_audio_embeddings accepts a list; process one at a time so a
                # single broken file does not poison the rest of the batch.
                embedding_tensor = model.get_audio_embeddings([path])

            # Always move to CPU before converting to numpy, even on CPU-only
            # boxes where .cpu() is a no-op — required for CUDA correctness.
            embedding: list[float] = (
                embedding_tensor.detach().cpu().numpy()[0].tolist()
            )

            if len(embedding) != 1024:
                raise ValueError(
                    f"Unexpected embedding dimension: {len(embedding)} (expected 1024)"
                )

            results.append({"path": path, "embedding": embedding})

        except Exception as exc:  # noqa: BLE001
            error_msg = f"{type(exc).__name__}: {exc}"
            print(
                f"[sonic-embedder] failed to embed {path!r}: {error_msg}",
                file=sys.stderr,
                flush=True,
            )
            results.append({"path": path, "error": error_msg})

    return results


def main() -> None:
    # Read exactly one JSON object from stdin (Node sends the entire payload
    # then closes the pipe, so read all of stdin at once).
    raw_input = sys.stdin.read().strip()
    if not raw_input:
        print(
            "[sonic-embedder] stdin was empty — nothing to embed",
            file=sys.stderr,
            flush=True,
        )
        return

    try:
        payload = json.loads(raw_input)
    except json.JSONDecodeError as exc:
        print(
            f"[sonic-embedder] invalid JSON on stdin: {exc}",
            file=sys.stderr,
            flush=True,
        )
        sys.exit(1)

    paths = payload.get("paths", [])
    if not isinstance(paths, list) or len(paths) == 0:
        print(
            "[sonic-embedder] 'paths' key missing or empty — nothing to embed",
            file=sys.stderr,
            flush=True,
        )
        return

    print(
        f"[sonic-embedder] received {len(paths)} path(s)",
        file=sys.stderr,
        flush=True,
    )

    try:
        model = load_model()
    except Exception as exc:  # noqa: BLE001
        # Model load failure is fatal — report every path as failed and exit.
        print(
            f"[sonic-embedder] model load failed: {exc}\n{traceback.format_exc()}",
            file=sys.stderr,
            flush=True,
        )
        # "fatal": "engine" tells the app this failure is about the embedder,
        # not the file, so it never counts toward the track's write-off
        # (sonic-embedding.service.ts, SonicEngineError).
        for path in paths:
            result = {"path": path, "error": f"model load failed: {exc}", "fatal": "engine"}
            sys.stdout.write(json.dumps(result, ensure_ascii=False) + "\n")
            sys.stdout.flush()
        sys.exit(1)

    results = embed_paths(model, paths)

    for result in results:
        sys.stdout.write(json.dumps(result, ensure_ascii=False) + "\n")
        sys.stdout.flush()

    success_count = sum(1 for r in results if "embedding" in r)
    failure_count = len(results) - success_count
    print(
        f"[sonic-embedder] done — {success_count} succeeded, {failure_count} failed",
        file=sys.stderr,
        flush=True,
    )


if __name__ == "__main__":
    main()
