# SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
# SPDX-License-Identifier: AGPL-3.0-only

# Sonic Embedder — CLAP('2023') audio embedding HTTP sidecar
#
# Build:
#   docker build -t sonic-embedder workers/sonic-embedder/
#
# Run (HTTP sidecar — default mode):
#   docker run --rm -p 8000:8000 sonic-embedder
#
# CLI debug (bypass uvicorn — run the standalone embed script directly):
#   docker run --rm -i sonic-embedder python3 embed.py
#   (pipe JSON on stdin, get JSONL on stdout)
#
# GPU (CUDA) usage:
#   docker run --rm --gpus all -p 8000:8000 sonic-embedder
#
# CPU quota (the real cross-container lever — set at deploy time, not here):
#   --cpus="2.0"        hard cap: 2 CPU-seconds per wall-second
#   --cpu-shares=512    soft weight: 512 = half the default 1024 share
#   These are set in the Compose service definition.
#   nice -n 19 in the ENTRYPOINT below is belt-and-suspenders only
#   (nice does NOT arbitrate across cgroup-v2 containers).

# pytorch/pytorch CUDA runtime image — includes torch, CUDA libs, and cuDNN.
# Pinned by digest (verified 2026-09-14 against registry-1.docker.io), not just
# the tag: a tag is a mutable pointer pytorch/pytorch could repoint (or lose
# control of), and this base is what ships torch's CUDA build — silently
# getting a different one would be a much bigger surprise than a normal
# dependency update. The tag is kept alongside the digest for readability; it
# plays no part in what actually gets pulled. Use the -runtime (not -devel)
# variant to keep image size down; embed.py only needs inference, not
# compilation. Bump deliberately (re-resolve the digest by hand) when moving
# to a newer base.
FROM pytorch/pytorch:2.3.1-cuda12.1-cudnn8-runtime@sha256:fc47f8018254e6df30f48c48f2db1c758d44de21a8c553de1a1c451a65baa70a

LABEL org.opencontainers.image.title="sonic-embedder"
LABEL org.opencontainers.image.description="CLAP('2023') audio embedding CLI for Lumastra"
LABEL org.opencontainers.image.licenses="AGPL-3.0-only"

# Avoid interactive prompts during apt installs
ENV DEBIAN_FRONTEND=noninteractive

# HuggingFace cache location for the auto-downloaded CLAP-2023 weights.
# Pinning it to a single, predictable path lets an operator mount a persistent
# named volume here so the weights are downloaded ONCE (not on every container
# recreate) and lets air-gapped installs pre-populate the cache out-of-band.
# The weights themselves are NOT bundled in this image (see the commented
# warmup RUN below) — they download from HuggingFace (microsoft/msclap) on
# first model load, or are loaded from SONIC_MODEL_FP if that env is set.
ENV HF_HOME=/app/.cache/huggingface
RUN mkdir -p /app/.cache/huggingface
# librosa's numba JIT caches compiled functions next to the package by default
# (site-packages), which is unwritable for the non-root `sonic` user and under a
# read_only root filesystem: measured on prod 2026-09-27, 134 cache files were
# written into site-packages by the old root image. /tmp is the tmpfs the
# compose example mounts, so the cache is per-container and never persisted.
ENV NUMBA_CACHE_DIR=/tmp/numba-cache

# glibc gives each thread that allocates its own malloc arena (up to 8 per core), and
# freed memory in one arena cannot serve another thread's next allocation; the executor
# threads, torch's intra-op pool and librosa then each keep their own high-water mark.
# Two arenas bound that; server.py also malloc_trim()s after every heavy job.
# Override with -e MALLOC_ARENA_MAX=... if it ever costs throughput.
ENV MALLOC_ARENA_MAX=2

# NOTE: numba's CPU target is set per-arch in Python at startup (analyze.py) —
# NUMBA_CPU_NAME=generic ONLY on arm64 (fixes a SIGILL), because on x86_64 the
# generic target SEGFAULTS. Do NOT set it globally here.

# Install system dependencies:
#   ffmpeg      — required by librosa/soundfile for audio decoding
#   libsndfile1 — C backend for soundfile (Python audio I/O)
#   git         — pip may need it to clone msclap if it sources from GitHub
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ffmpeg \
        libsndfile1 \
        git \
        curl \
        && \
    rm -rf /var/lib/apt/lists/*

# Install Python dependencies — exact-pinned and hash-pinned (requirements.txt;
# see its header for how it is resolved — on CPython 3.10 / linux-x86_64, i.e.
# THIS base image, not a developer laptop — and why torch/torchaudio and
# torch's CUDA wheels are excluded).
#
# Pin order matters for CUDA visibility:
#   1. torch is already present in the base image — do NOT reinstall it or pip
#      may downgrade to a CPU-only wheel from PyPI. It is deliberately absent
#      from requirements.txt for exactly this reason.
#   2. msclap pulls in transformers, torchaudio, etc.
#   3. librosa + soundfile are the audio decode backends.
#   4. pyloudnorm provides EBU R128 integrated loudness for /analyze
#      (the Essentia-binary replacement; MIT-licensed, arm64-wheel-clean).
COPY requirements.txt requirements.in /app/
# --require-hashes: requirements.txt is now hash-pinned (every entry carries
# --hash=sha256:... digests sourced from PyPI's own upload-time metadata, see
# that file's header) so a compromised or re-uploaded artifact at the same
# pinned version fails the install instead of silently landing. Verified this
# does not break on the deliberately-excluded torch/torchaudio (already
# installed by the base image, see requirements.txt's header): pip's
# hash-checking resolver treats an already-satisfied transitive requirement
# as resolved without needing its own hash entry.
RUN pip install --no-cache-dir --require-hashes -r /app/requirements.txt

WORKDIR /app
COPY embed.py /app/embed.py
COPY embed_text.py /app/embed_text.py
COPY analyze.py /app/analyze.py
COPY analyze_chunked.py /app/analyze_chunked.py
COPY project_map.py /app/project_map.py
COPY cluster.py /app/cluster.py
COPY db_utils.py /app/db_utils.py
COPY server.py /app/server.py
COPY cpu_budget.py /app/cpu_budget.py
COPY mem_budget.py /app/mem_budget.py
COPY admission.py /app/admission.py
COPY windowed_embed.py /app/windowed_embed.py
COPY text_encoder.py /app/text_encoder.py
COPY host_metrics.py /app/host_metrics.py

# Warm up the model weights on first build (optional — saves first-run latency).
# Disabled by default because it adds ~1 GB to the layer and the weights are
# already cached in the container's pip cache on first real invocation.
# Uncomment the next RUN block to pre-bake the weights:
#
# RUN python3 -c "from msclap import CLAP; CLAP(version='2023', use_cuda=False)"

# Run as uid 1000, not root. This image previously had no USER at all — a
# compromise of the FastAPI/uvicorn process (or of one of its many third-party
# deps: transformers, librosa, etc.) would otherwise run as root with no
# further privilege boundary. 1000 matches the main Lumastra image's `node`
# user (deploy/docker convention) so a bind-mounted /data/music:ro and the
# sonic-model-cache volume behave predictably across both images.
#
# chown AFTER all the COPY/RUN steps above (not before) so every layer up to
# here stays cacheable regardless of the target uid, and so this is a single
# ownership pass over the whole tree rather than one per COPY.
RUN groupadd -g 1000 sonic && useradd -u 1000 -g 1000 -m -s /usr/sbin/nologin sonic \
    && chown -R sonic:sonic /app
USER sonic

# Health check — polls /health until the CLAP model finishes loading.
# start_period gives the model time to load before the first probe counts.
# Plain curl, not `python3 -c "import urllib..."` — spinning up a fresh
# interpreter (+ import machinery) on every 15s tick adds its own CPU/scheduling
# cost on top of whatever /analyze is doing, which made the probe itself a
# contributor to false "unhealthy" flaps under load.
HEALTHCHECK --interval=15s --timeout=5s --start-period=120s --retries=3 \
    CMD curl -fsS --max-time 4 http://localhost:8000/health || exit 1

# HTTP sidecar — uvicorn serves server.py on port 8000, run at low OS priority
# (nice -n 19) as belt-and-suspenders CPU yielding.  The standalone CLI scripts
# (embed.py, etc.) remain executable directly for the execFile subprocess fallback
# path when SONIC_EMBEDDER_URL is not set.
#
# Hard CPU cap is controlled by --cpus / --cpu-shares in the Compose
# service, not here.  SONIC_EMBEDDER_THREADS controls the PyTorch thread budget.
ENTRYPOINT ["nice", "-n", "19", "uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
