#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
# SPDX-License-Identifier: AGPL-3.0-only
"""
Sonic Embedder HTTP Sidecar — FastAPI/uvicorn warm-model server.

Loads the CLAP('2023') model ONCE at startup via embed.py's load_model(),
keeps it warm in memory, and exposes five endpoints:

    GET  /health          → {"status":"ready"} once model is loaded; 503 if still loading
    POST /embed           → JSONL {path, embedding|error} per input path
    POST /analyze         → JSONL {path, analysis|error} per input path (raw music features)
    POST /embed-text      → JSON array[1024] for a text query
    POST /project-map     → JSONL {media_id, x, y} (reads DB via DATABASE_URL)
    POST /cluster         → JSONL {media_id, cluster_id} (reads DB via DATABASE_URL)

The four heavy scripts (embed.py, embed_text.py, project_map.py, cluster.py)
remain importable as standalone CLIs — no logic is duplicated here.

umap and sklearn are lazy-imported inside their handlers so the embedding
endpoints do not pay the import cost.

Environment variables:
    DATABASE_URL          — required for /project-map and /cluster
    MODEL_ID              — embedding model (default 'msclap-2023')
    SONIC_CLUSTER_K       — default number of KMeans clusters (default 12)
    SONIC_EMBEDDER_THREADS — hard cap on PyTorch intra-op threads; also used as
                            the default when no per-request 'threads' is supplied.
                            Defaults to max(1, available_cpus // 2) when unset, where
                            available_cpus is the CONTAINER's budget (cgroup quota /
                            cpuset), not the host's core count — see cpu_budget.py.
    PORT                  — uvicorn listen port (default 8000; override via CLI arg)
    UMAP_N_NEIGHBORS, UMAP_MIN_DIST, UMAP_METRIC, UMAP_RANDOM_STATE, UMAP_N_EPOCHS
                          — forwarded to project_map logic (same defaults as project_map.py)
    CLUSTER_RANDOM_STATE, CLUSTER_MAX_ITER
                          — forwarded to cluster logic (same defaults as cluster.py)

CPU controls:
    Background ML must not starve the serving app.  Thread budget is resolved as:
        per-request 'threads' field (if > 0)
        else SONIC_EMBEDDER_THREADS env var (if set and > 0)
        else max(1, available_cpus() // 2)   ← default: half the container's CPUs

    torch.set_num_interop_threads() is called ONCE at module import time (before
    any torch op) because PyTorch only allows it to be set once.
    torch.set_num_threads() is called per-request when the caller supplies 'threads'.

    Cross-container CPU arbitration (the real lever on Linux) is set via Docker
    --cpus / --cpu-shares in the Compose service definition; nice-19
    in the ENTRYPOINT is belt-and-suspenders only.

Event loop isolation:
    uvicorn runs a single worker (one asyncio event loop). All the blocking
    librosa/torch/umap/sklearn work is dispatched via loop.run_in_executor()
    to the module-level _CPU_EXECUTOR (a small ThreadPoolExecutor) instead of
    running inline in the `async def` handlers. Otherwise the event loop itself
    — and therefore GET /health — is blocked for the full duration of a job,
    which previously caused the healthcheck (and real caller connections) to
    time out under sustained load even though the model was working fine.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from typing import Any

# ---------------------------------------------------------------------------
# CPU thread budget — resolve BEFORE importing torch so OMP_NUM_THREADS takes
# effect.  torch.set_num_interop_threads() must be called before any torch op.
# ---------------------------------------------------------------------------
from cpu_budget import available_cpus
from mem_budget import memory_limit, memory_reserve_mb, own_rss_mb
from host_metrics import node_info


def _default_thread_count() -> int:
    """Half the container's CPU budget (cgroup quota / cpuset), not the host's cores."""
    return max(1, available_cpus() // 2)


def _env_thread_count() -> int | None:
    """Return the SONIC_EMBEDDER_THREADS env value, or None if unset/invalid."""
    raw = os.environ.get("SONIC_EMBEDDER_THREADS", "").strip()
    if raw:
        try:
            val = int(raw)
            return val if val > 0 else None
        except ValueError:
            pass
    return None


# Startup thread count (env or half-cores default).
_STARTUP_THREADS: int = _env_thread_count() or _default_thread_count()

# Set thread env vars before torch or librosa are imported by any downstream
# module. OMP_NUM_THREADS is already set above for torch. MKL, OpenBLAS,
# numexpr, and numba vars must be capped too so the librosa/numpy BLAS path
# respects the thread budget when /analyze is first called (librosa imports
# lazily on first /analyze; BLAS reads these vars at import time).
for _blas_var in (
    "OMP_NUM_THREADS",
    "MKL_NUM_THREADS",
    "OPENBLAS_NUM_THREADS",
    "NUMEXPR_NUM_THREADS",
    "NUMBA_NUM_THREADS",
):
    if _blas_var not in os.environ:
        os.environ[_blas_var] = str(_STARTUP_THREADS)

# FastAPI + uvicorn — installed alongside this server (not needed by the CLI scripts)
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import PlainTextResponse

# Set torch inter-op thread count once here, before any torch operation.
# intra-op is safe to change per-request via torch.set_num_threads().
try:
    import torch as _torch
    _torch.set_num_interop_threads(_STARTUP_THREADS)
except Exception:  # noqa: BLE001
    pass  # torch not yet available (e.g. running tests without torch installed)

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="[sonic-server] %(levelname)s %(message)s",
    stream=sys.stderr,
)
log = logging.getLogger("sonic-server")

log.info(
    "CPU thread budget: startup=%d (OMP_NUM_THREADS=%s, SONIC_EMBEDDER_THREADS=%s, available_cpus=%s, host cpu_count=%s)",
    _STARTUP_THREADS,
    os.environ.get("OMP_NUM_THREADS"),
    os.environ.get("SONIC_EMBEDDER_THREADS", "<unset>"),
    available_cpus(),
    os.cpu_count(),
)

# ---------------------------------------------------------------------------
# CPU-bound work executor
# ---------------------------------------------------------------------------
# uvicorn runs a single worker with one asyncio event loop. Every route below
# is `async def`, but the actual librosa/torch/umap/sklearn work is synchronous
# — calling it inline would block that one event loop thread for the entire
# duration of the job (several seconds per track), during which the process
# cannot accept new connections or answer GET /health. That starved the
# Docker healthcheck and produced real connection failures for callers under
# sustained load, even though the model itself was working fine.
#
# Routing the blocking calls through this executor keeps the event loop free
# to serve /health and accept connections while a job runs. Which job may run
# when is decided by the memory gate (admission.py) before a job is submitted;
# the executor has one thread per job the gate may run at once.
#
# SONIC_MAX_CONCURRENT_JOBS: heavy jobs (/embed, /analyze, /cluster, /project-map)
# at once. Default: as many as the CPU budget fits at the thread count, at most 2
# (what the server always ran). The memory gate still runs fewer when they would
# not fit in memory together.
def _max_concurrent_jobs() -> int:
    raw = os.environ.get("SONIC_MAX_CONCURRENT_JOBS", "").strip()
    try:
        if raw and int(raw) > 0:
            return int(raw)
    except ValueError:
        pass
    return max(1, min(2, available_cpus() // max(1, _STARTUP_THREADS)))


_MAX_JOBS: int = _max_concurrent_jobs()
_CPU_EXECUTOR = ThreadPoolExecutor(max_workers=_MAX_JOBS, thread_name_prefix="sonic-cpu")
# /embed-text has a lane of its own: it is a user's search query, and it used to wait
# behind /embed batches and /analyze jobs on the shared executor. It also owns the
# lazy text encoder (text_encoder.py), whose methods must all run on this one thread.
_TEXT_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="sonic-text")

# Memory budget (mem_budget.py) and admission (admission.py). The gate is built in
# lifespan, once the model's own memory (the baseline) can be measured.
_LIMIT_MB, _LIMIT_SOURCE = memory_limit()
_RESERVE_MB: int = memory_reserve_mb(_LIMIT_MB)
_baseline_mb: int = 0
_gate: Any = None   # admission.MemoryGate
_text: Any = None   # text_encoder.TextEncoderManager


def _queue_timeout_s() -> float:
    raw = os.environ.get("SONIC_ADMISSION_QUEUE_TIMEOUT_SEC", "").strip()
    try:
        return max(1.0, float(raw)) if raw else 120.0
    except ValueError:
        return 120.0

# ---------------------------------------------------------------------------
# Global warm model state
# ---------------------------------------------------------------------------
_model: Any = None   # CLAP model instance, set during lifespan startup
_model_ready: bool = False


# ---------------------------------------------------------------------------
# Thread cap helper
# ---------------------------------------------------------------------------
def _apply_thread_cap(requested: int | None) -> int:
    """
    Resolve and apply the effective intra-op thread count for this request.

    Priority (highest → lowest):
      1. per-request 'threads' field (if > 0)
      2. SONIC_EMBEDDER_THREADS env var (resolved once at startup as _STARTUP_THREADS)
      3. max(1, available_cpus() // 2)  ← half the container's CPUs

    Sets torch.set_num_threads(n) and returns the effective count.
    """
    effective = _STARTUP_THREADS  # already env-or-default
    if requested is not None and requested > 0:
        effective = requested

    try:
        import torch
        torch.set_num_threads(effective)
    except Exception:  # noqa: BLE001
        pass  # torch not available in test environments

    return effective


# ---------------------------------------------------------------------------
# Returning freed heap to the OS
# ---------------------------------------------------------------------------
_libc_malloc_trim: Any = None


def _release_freed_heap() -> None:
    """Hand memory the finished job freed back to the OS (glibc malloc_trim).

    glibc keeps freed heap mapped. Once a large buffer has been freed, its
    adaptive mmap threshold rises, so later decode buffers come from the heap and
    stay resident after the job: on preprod one 45-minute /embed left ~1 GB, model
    load ~0.5 GB, and prod idles at 3.8 GB against 1.7 GB right after model load. No-op where libc
    has no malloc_trim (musl, macOS).
    """
    global _libc_malloc_trim
    if _libc_malloc_trim is None:
        try:
            import ctypes
            trim = ctypes.CDLL("libc.so.6").malloc_trim
            trim.argtypes = [ctypes.c_size_t]
            trim.restype = ctypes.c_int
            _libc_malloc_trim = trim
        except (OSError, AttributeError):
            _libc_malloc_trim = False
    if _libc_malloc_trim:
        try:
            _libc_malloc_trim(0)
        except Exception:  # noqa: BLE001
            pass


# ---------------------------------------------------------------------------
# Executor job wrappers
#
# Each wrapper does its (possibly lazy/heavy) import AND the blocking call, so
# the import cost also lands on the executor thread instead of the event loop.
# /embed and /analyze trim the heap once their buffers are gone; /cluster and
# /project-map trim in the handler, after it has dropped the fetched rows.
# ---------------------------------------------------------------------------
def _run_embed(paths: list[str], infos: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    from embed import embed_paths  # type: ignore[import]
    try:
        return embed_paths(_model, paths, infos)
    finally:
        _release_freed_heap()


def _run_analyze(paths: list[str], threads: int) -> list[str]:
    from analyze import analyze_paths  # type: ignore[import]  # lazy: pays librosa import cost
    try:
        return analyze_paths(paths, threads)
    finally:
        _release_freed_heap()


def _run_embed_text(text: str) -> tuple[list[float], bool]:
    """(embedding, whether this call loaded the lazy text encoder)."""
    from embed_text import embed_text  # type: ignore[import]
    loaded = _text.ensure_loaded() if _text is not None else False
    return embed_text(_model, text), loaded


def _fetch_map_embeddings(database_url: str, model_id: str) -> list[Any]:
    from db_utils import get_embeddings_from_db  # type: ignore[import]
    return get_embeddings_from_db(database_url, model_id)


def _run_map_projection(
    rows: list[Any],
    n_neighbors: int,
    min_dist: float,
    metric: str,
    random_state: int,
    n_epochs: int | None,
) -> list[str]:
    from project_map import run_projection  # type: ignore[import]  # lazy: pays umap import cost
    return run_projection(rows, n_neighbors, min_dist, metric, random_state, n_epochs)


def _fetch_cluster_embeddings(database_url: str, model_id: str) -> list[Any]:
    from db_utils import get_embeddings_from_db  # type: ignore[import]
    return get_embeddings_from_db(database_url, model_id)


def _run_kmeans_job(embeddings: list[Any], n_clusters: int, random_state: int, max_iter: int) -> list[int]:
    from cluster import run_kmeans  # type: ignore[import]  # lazy: pays sklearn import cost
    return run_kmeans(embeddings, n_clusters, random_state, max_iter)


# ---------------------------------------------------------------------------
# Lifespan: load model once at startup
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):  # type: ignore[type-arg]
    global _model, _model_ready
    log.info("Loading CLAP model at startup…")
    try:
        # Reuse embed.py's load_model() — no duplication
        from embed import load_model  # type: ignore[import]
        _model = load_model()
        _release_freed_heap()  # unpickling the weights leaves ~0.5 GB of freed heap
        _model_ready = True
        log.info("CLAP model ready — server accepting requests")
    except Exception as exc:  # noqa: BLE001
        log.error("Model load FAILED: %s — /health will return 503", exc)
        # Server starts, but /health returns 503 until model is loaded
    if _model is not None:
        _setup_text_encoder()
        _release_freed_heap()
    _setup_gate()
    background = [asyncio.create_task(_rss_sampler()), asyncio.create_task(_text_idle_unloader())]
    yield
    for task in background:
        task.cancel()
    # Shutdown: nothing to clean up for the model
    log.info("Shutting down sonic-embedder sidecar")


def _setup_text_encoder() -> None:
    global _text
    from text_encoder import TextEncoderManager, idle_seconds, resolve_mode

    try:
        mode = resolve_mode(os.environ.get("SONIC_TEXT_ENCODER"), _LIMIT_MB)
        cache = os.environ.get("HF_HOME", "/app/.cache/huggingface")
        _text = TextEncoderManager(_model, mode, os.path.join(cache, "sonic"), idle_seconds())
        _text.prepare()
    except Exception as exc:  # noqa: BLE001 — never let this take the model's readiness down
        log.warning("Text encoder offload failed, keeping it loaded: %s", exc)
        if _text is not None:
            _text.mode, _text.state = "warm", "warm"


def _setup_gate() -> None:
    global _gate, _baseline_mb
    from admission import MemoryGate

    # A lazy text encoder is out of RAM now but loads on the first search, outside the
    # gate: plan as if it were loaded, so a search can never push admitted jobs over the
    # limit. Lazy mode then lowers what the sidecar holds while idle, not its budget.
    _baseline_mb = (own_rss_mb() or 0) + (_text.size_mb if _text is not None and _text.state == "unloaded" else 0)
    hard = _LIMIT_MB - _baseline_mb
    budget = hard - _RESERVE_MB
    _gate = MemoryGate(budget_mb=budget, hard_mb=hard, max_jobs=_MAX_JOBS)
    log.info(
        "Memory budget: limit=%d MB (%s), baseline=%d MB, reserve=%d MB -> budget=%d MB, "
        "max concurrent jobs=%d, text encoder=%s",
        _LIMIT_MB, _LIMIT_SOURCE, _baseline_mb, _RESERVE_MB, budget, _MAX_JOBS,
        _text.state if _text is not None else "n/a",
    )
    if budget < 800:
        log.warning(
            "Memory budget is only %d MB: long tracks will run one at a time or be refused. "
            "Give the sidecar at least 3 GB (see workers/sonic-embedder/README.md).", budget,
        )


async def _rss_sampler() -> None:
    """Record the process RSS high-water mark of every running job, for its log line."""
    while True:
        await asyncio.sleep(0.25)
        try:
            if _gate is None or not _gate.running:
                continue
            rss = own_rss_mb() or 0
            for ticket in _gate.running:
                ticket.peak_rss_mb = max(ticket.peak_rss_mb, rss)
        except Exception as exc:  # noqa: BLE001 — a log aid must never stop
            log.debug("rss sampler: %s", exc)


async def _text_idle_unloader() -> None:
    while True:
        await asyncio.sleep(60)
        try:
            if _text is None or _text.state != "loaded":
                continue
            await asyncio.get_running_loop().run_in_executor(_TEXT_EXECUTOR, _unload_text_if_idle)
        except Exception as exc:  # noqa: BLE001 — keep unloading on later ticks
            log.warning("Text encoder idle unload failed: %s", exc)


def _unload_text_if_idle() -> bool:
    if _text.unload_if_idle():
        _release_freed_heap()
        return True
    return False


async def _admit(kind: str, cost_mb: int, accept_busy: bool):
    """Wait for the memory gate. 429 when the caller accepts it and the wait is too long."""
    from admission import AdmissionBusy

    try:
        ticket = await _gate.acquire(kind, cost_mb, _queue_timeout_s() if accept_busy else None)
    except AdmissionBusy as busy:
        log.info("/%s — busy, 429 (queue depth %d, retry after %ds)", kind, busy.queue_depth, busy.retry_after_s)
        raise HTTPException(
            status_code=429,
            detail={"code": "busy", "queue_depth": busy.queue_depth, "retry_after_s": busy.retry_after_s},
            headers={"Retry-After": str(busy.retry_after_s)},
        ) from None
    ticket.peak_rss_mb = own_rss_mb() or 0
    return ticket


async def _run_admitted(request: Request | None, ticket, job, extra: str = ""):
    """Run `job` (a coroutine function) under an admitted ticket.

    The ticket is released when the job's work has really ended: if this handler is
    cancelled while an executor thread is still decoding, the release waits for that
    thread, so the gate never admits a new job on top of memory still in use. A client
    that went away while queued (an older app's request timed out) gets nothing run.
    """
    if request is not None and await request.is_disconnected():
        _finish(ticket, extra + ", client gone before start")
        return PlainTextResponse(content="", media_type="application/x-ndjson")
    task = asyncio.ensure_future(job())
    try:
        return await asyncio.shield(task)
    finally:
        if task.done():
            _finish(ticket, extra)
        else:
            task.add_done_callback(lambda _t: _finish(ticket, extra + ", after cancel"))


def _finish(ticket, extra: str = "") -> None:
    ticket.peak_rss_mb = max(ticket.peak_rss_mb, own_rss_mb() or 0)
    _gate.release(ticket)
    log.info(
        "job %s: est=%d MB, process rss peak=%d MB (baseline %d MB), %.1fs%s",
        ticket.kind, ticket.cost_mb, ticket.peak_rss_mb, _baseline_mb,
        ticket.duration_s, extra,
    )


def _over_budget_line(path: str, cost_mb: int) -> dict[str, Any]:
    return {
        "path": path,
        "error": (
            f"needs about {cost_mb} MB, more than this sidecar can ever give a job "
            f"({_gate.hard_mb} MB: container limit {_LIMIT_MB} MB minus the loaded model); "
            "give the sidecar more memory"
        ),
        "code": "exceeds_memory_budget",
        "cost_mb": cost_mb,
        "budget_mb": _gate.hard_mb,
    }


async def _admit_map_job(kind: str, database_url: str, model_id: str, accept_busy: bool):
    """Admit /cluster or /project-map at a cost from the number of rows it will load."""
    from admission import map_cost_mb
    from db_utils import count_embeddings

    loop = asyncio.get_running_loop()
    try:
        rows = await loop.run_in_executor(None, count_embeddings, database_url, model_id)
    except Exception as exc:  # noqa: BLE001 — the fetch reports DB errors properly
        log.warning("/%s — could not count embeddings for the memory gate: %s", kind, exc)
        rows = None
    cost = map_cost_mb(rows)
    # Too big to fit even alone: run it alone anyway. Refusing would break the map and
    # the clusters for good on this box, and the kernel reports a real OOM clearly.
    return await _admit(kind, min(cost, _gate.hard_mb), accept_busy)


def _probe_paths(paths: list[str]) -> dict[str, Any]:
    from windowed_embed import probe

    return {p: probe(p) for p in paths}


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------
app = FastAPI(title="sonic-embedder", lifespan=lifespan)


# ---------------------------------------------------------------------------
# GET /health
# ---------------------------------------------------------------------------
@app.get("/health")
def health() -> dict[str, Any]:
    """
    Returns {"status":"ready", ...} once the CLAP model is loaded.
    Returns HTTP 503 {"status":"loading"} while the model is still initializing.

    Beside "status" (all the app reads), "memory" describes the admission budget and
    the jobs running against it, "text_encoder" is warm, loaded or unloaded, and "node"
    carries the host/process figures Admin → System health → Cluster shows
    (host_metrics.py). No file paths: /health is unauthenticated.
    """
    if not _model_ready:
        raise HTTPException(status_code=503, detail={"status": "loading", "node": node_info()})
    memory: dict[str, Any] = {
        "limit_mb": _LIMIT_MB,
        "limit_source": _LIMIT_SOURCE,
        "baseline_mb": _baseline_mb,
        "reserve_mb": _RESERVE_MB,
        "rss_mb": own_rss_mb(),
    }
    if _gate is not None:
        memory.update(_gate.snapshot())
    return {
        "status": "ready",
        "memory": memory,
        "text_encoder": _text.state if _text is not None else "warm",
        "node": node_info(),
    }


# ---------------------------------------------------------------------------
# POST /embed
# Request:  {"paths": ["/abs/path/to/track1.flac", ...]}
# Response: JSONL — one {"path": ..., "embedding": [...]} or {"path":..., "error":"..."} per line
# ---------------------------------------------------------------------------
@app.post("/embed")
async def embed(request: Request) -> PlainTextResponse:
    """
    Batch audio embedding.  Reuses embed.py's embed_paths(model, paths).
    Returns JSONL, one line per input path (success or per-file error).

    Optional request field:
        threads (int, > 0) — intra-op thread cap for this request only.
            Overrides SONIC_EMBEDDER_THREADS env / half-cores default.
            Absent or <= 0: uses the startup default.
    """
    _require_model()
    body = await _parse_json_body(request)
    paths = body.get("paths", [])
    if not isinstance(paths, list) or len(paths) == 0:
        raise HTTPException(status_code=422, detail="'paths' must be a non-empty list")

    threads_raw = body.get("threads")
    threads: int | None = int(threads_raw) if isinstance(threads_raw, (int, float)) else None
    accept_busy = body.get("accept_busy") is True

    # Cost: the bounded decode makes every file about the same; one msclap reads
    # whole (header unreadable) is costed as unknown. Files run one after another,
    # so the request costs its most expensive file.
    from admission import EMBED_UNKNOWN_MB, EMBED_WINDOWED_MB

    loop = asyncio.get_running_loop()
    infos = await loop.run_in_executor(None, _probe_paths, paths)
    costs = {p: EMBED_WINDOWED_MB if infos.get(p) else EMBED_UNKNOWN_MB for p in paths}
    over = {p for p in paths if _gate.infeasible(costs[p])}
    runnable = [p for p in paths if p not in over]
    _gate.counters["exceeds_budget"] += len(over)
    out: dict[str, str] = {p: json.dumps(_over_budget_line(p, costs[p])) for p in over}

    if runnable:
        async def job() -> None:
            effective_threads = _apply_thread_cap(threads)
            log.info("/embed — %d path(s), threads=%d", len(runnable), effective_threads)
            results = await loop.run_in_executor(_CPU_EXECUTOR, _run_embed, runnable, infos)
            out.update((r["path"], json.dumps(r, ensure_ascii=False)) for r in results)

        ticket = await _admit("embed", max(costs[p] for p in runnable), accept_busy)
        gone = await _run_admitted(request, ticket, job, f", {len(runnable)} path(s)")
        if gone is not None:
            return gone

    lines = "\n".join(out[p] for p in paths if p in out) + "\n"
    return PlainTextResponse(content=lines, media_type="application/x-ndjson")


# ---------------------------------------------------------------------------
# POST /analyze
# Request:  {"paths": ["/abs/path/to/track1.flac", ...], "threads": 4?}
# Response: JSONL — one {"path": ..., "analysis": {...}} or {"path":..., "error":"..."} per line
# ---------------------------------------------------------------------------
@app.post("/analyze")
async def analyze(request: Request) -> PlainTextResponse:
    """
    Batch music audio analysis (Essentia-binary replacement, Integration Shape A).
    Reuses analyze.py's analyze_paths(paths, threads) — emits RAW features only;
    all derivation happens on the TS side (essentia-analysis.service.ts).

    Unlike /embed, this endpoint does NOT require the warm CLAP model — analysis
    uses librosa/pyloudnorm, lazy-imported inside analyze.py. The librosa import
    cost is therefore paid here and not on the embedding endpoints.

    Optional request field:
        threads (int, > 0) — BLAS/numba thread cap for this request only.
            Overrides SONIC_EMBEDDER_THREADS env / half-cores default.
            Absent or <= 0: uses the startup default.

    Returns JSONL, one line per input path (success or per-file error).
    """
    body = await _parse_json_body(request)
    paths = body.get("paths", [])
    if not isinstance(paths, list) or len(paths) == 0:
        raise HTTPException(status_code=422, detail="'paths' must be a non-empty list")

    threads_raw = body.get("threads")
    threads: int | None = int(threads_raw) if isinstance(threads_raw, (int, float)) else None
    accept_busy = body.get("accept_busy") is True

    # Cost grows with duration (the decoded mono signal and per-frame arrays). A file over
    # SONIC_ANALYZE_MAX_DURATION_SEC is refused by analyze.py before decoding, so it
    # costs nothing; one that cannot fit even alone gets a per-file error line.
    loop = asyncio.get_running_loop()
    costs = await loop.run_in_executor(None, _analyze_costs, paths)
    over = {p for p in paths if _gate.infeasible(costs[p])}
    runnable = [p for p in paths if p not in over]
    _gate.counters["exceeds_budget"] += len(over)
    out: dict[str, str] = {p: json.dumps(_over_budget_line(p, costs[p])) + "\n" for p in over}

    if runnable:
        async def job() -> None:
            effective_threads = _apply_thread_cap(threads)
            log.info("/analyze — %d path(s), threads=%d", len(runnable), effective_threads)
            lines = await loop.run_in_executor(_CPU_EXECUTOR, _run_analyze, runnable, effective_threads)
            out.update(zip(runnable, lines))

        ticket = await _admit("analyze", max(costs[p] for p in runnable), accept_busy)
        gone = await _run_admitted(request, ticket, job, f", {len(runnable)} path(s)")
        if gone is not None:
            return gone

    return PlainTextResponse(content="".join(out[p] for p in paths if p in out), media_type="application/x-ndjson")


def _analyze_costs(paths: list[str]) -> dict[str, int]:
    from admission import analyze_cost_mb
    from analyze import _analyze_sr, _max_duration_sec  # type: ignore[import]
    from windowed_embed import probe

    cap = _max_duration_sec()
    costs: dict[str, int] = {}
    for p in paths:
        info = probe(p)
        if info is None:
            # Unknown length (ffprobe could not read it): run it alone at most, never
            # blame its failure on memory; analyze.py reports the real decode error.
            costs[p] = min(analyze_cost_mb(None), _gate.hard_mb)
        elif info.duration_s > cap:
            costs[p] = 100  # refused before decoding
        else:
            costs[p] = analyze_cost_mb(info.duration_s, _analyze_sr())
    return costs


# ---------------------------------------------------------------------------
# POST /embed-text
# Request:  {"text": "calm piano"}
# Response: JSON array[1024]  (single line)
# ---------------------------------------------------------------------------
@app.post("/embed-text")
async def embed_text_endpoint(request: Request) -> PlainTextResponse:
    """
    Text-to-embedding.  Reuses embed_text.py's embed_text(model, text).
    Returns a single JSON array of 1024 floats.

    Optional request field:
        threads (int, > 0) — intra-op thread cap for this request only.
            Overrides SONIC_EMBEDDER_THREADS env / half-cores default.
            Absent or <= 0: uses the startup default.

    Note: embedTextQuery() in the Node layer is a request-path call with no
    task context and should NOT supply 'threads' — the sidecar default applies.
    """
    _require_model()
    body = await _parse_json_body(request)
    text = body.get("text", "")
    if not isinstance(text, str) or not text.strip():
        raise HTTPException(status_code=422, detail="'text' must be a non-empty string")

    text = text.strip()
    threads_raw = body.get("threads")
    threads: int | None = int(threads_raw) if isinstance(threads_raw, (int, float)) else None
    effective_threads = _apply_thread_cap(threads)
    log.info("/embed-text — %d chars, threads=%d", len(text), effective_threads)

    loop = asyncio.get_running_loop()
    embedding, _loaded = await loop.run_in_executor(_TEXT_EXECUTOR, _run_embed_text, text)

    return PlainTextResponse(
        content=json.dumps(embedding, ensure_ascii=False) + "\n",
        media_type="application/json",
    )


# ---------------------------------------------------------------------------
# POST /project-map
# Request:  {} (empty body; reads DB via DATABASE_URL env)
# Response: JSONL — {"media_id": "<uuid>", "x": <float>, "y": <float>}
# ---------------------------------------------------------------------------
@app.post("/project-map")
async def project_map_endpoint(request: Request) -> PlainTextResponse:
    """
    UMAP 2D projection over media_audio_embeddings.
    Lazy-imports umap-learn so the main embedding paths don't pay for it.
    Reuses project_map.py's get_embeddings_from_db / run_umap / normalise_coords.
    DATABASE_URL must be set in the environment.

    Optional request field:
        threads (int, > 0) — intra-op thread cap for this request only.
            Overrides SONIC_EMBEDDER_THREADS env / half-cores default.
            Absent or <= 0: uses the startup default.
    """
    database_url = os.environ.get("DATABASE_URL", "")
    if not database_url:
        raise HTTPException(status_code=503, detail="DATABASE_URL is not set")

    body = await _parse_json_body(request, allow_empty=True)
    threads_raw = body.get("threads")
    threads: int | None = int(threads_raw) if isinstance(threads_raw, (int, float)) else None
    effective_threads = _apply_thread_cap(threads)

    model_id = os.environ.get("MODEL_ID", "msclap-2023")
    n_neighbors = int(os.environ.get("UMAP_N_NEIGHBORS", "15"))
    min_dist = float(os.environ.get("UMAP_MIN_DIST", "0.1"))
    metric = os.environ.get("UMAP_METRIC", "cosine")
    random_state = int(os.environ.get("UMAP_RANDOM_STATE", "42"))
    n_epochs_raw = os.environ.get("UMAP_N_EPOCHS", "")
    n_epochs: int | None = int(n_epochs_raw) if n_epochs_raw.strip() else None

    log.info("/project-map — model_id=%r threads=%d", model_id, effective_threads)

    loop = asyncio.get_running_loop()
    ticket = await _admit_map_job("project-map", database_url, model_id, body.get("accept_busy") is True)
    return await _run_admitted(
        request, ticket,
        lambda: _project_map_job(loop, database_url, model_id, n_neighbors, min_dist, metric, random_state, n_epochs),
    )


async def _project_map_job(
    loop: asyncio.AbstractEventLoop,
    database_url: str,
    model_id: str,
    n_neighbors: int,
    min_dist: float,
    metric: str,
    random_state: int,
    n_epochs: int | None,
) -> PlainTextResponse:
    try:
        rows = await loop.run_in_executor(_CPU_EXECUTOR, _fetch_map_embeddings, database_url, model_id)
    except Exception as exc:  # noqa: BLE001
        log.error("/project-map DB error: %s", exc)
        raise HTTPException(status_code=500, detail=f"DB error: {exc}") from exc

    if len(rows) == 0:
        log.info("/project-map — no embeddings, returning empty stream")
        return PlainTextResponse(content="", media_type="application/x-ndjson")

    try:
        lines = await loop.run_in_executor(
            _CPU_EXECUTOR, _run_map_projection, rows, n_neighbors, min_dist, metric, random_state, n_epochs
        )
    except Exception as exc:  # noqa: BLE001
        log.error("/project-map UMAP error: %s", exc)
        raise HTTPException(status_code=500, detail=f"UMAP error: {exc}") from exc
    finally:
        del rows
        await loop.run_in_executor(None, _release_freed_heap)

    log.info("/project-map — projected %d points", len(lines))
    return PlainTextResponse(
        content="\n".join(lines) + "\n",
        media_type="application/x-ndjson",
    )


# ---------------------------------------------------------------------------
# POST /cluster
# Request:  {"k": <int>?}   (k overrides SONIC_CLUSTER_K env; optional)
# Response: JSONL — {"media_id": "<uuid>", "cluster_id": <int>}
# ---------------------------------------------------------------------------
@app.post("/cluster")
async def cluster_endpoint(request: Request) -> PlainTextResponse:
    """
    KMeans clustering over media_audio_embeddings.
    Lazy-imports sklearn so the embedding endpoints don't pay for it.
    Reuses cluster.py's get_embeddings_from_db / run_kmeans.
    DATABASE_URL must be set in the environment.

    Optional request fields:
        k       (int)       — number of clusters (overrides SONIC_CLUSTER_K env).
        threads (int, > 0)  — intra-op thread cap for this request only.
            Overrides SONIC_EMBEDDER_THREADS env / half-cores default.
            Absent or <= 0: uses the startup default.
    """
    database_url = os.environ.get("DATABASE_URL", "")
    if not database_url:
        raise HTTPException(status_code=503, detail="DATABASE_URL is not set")

    body = await _parse_json_body(request, allow_empty=True)
    threads_raw = body.get("threads")
    threads: int | None = int(threads_raw) if isinstance(threads_raw, (int, float)) else None
    effective_threads = _apply_thread_cap(threads)

    model_id = os.environ.get("MODEL_ID", "msclap-2023")
    default_k = int(os.environ.get("SONIC_CLUSTER_K", "12"))
    n_clusters = int(body.get("k", default_k)) if body else default_k
    random_state = int(os.environ.get("CLUSTER_RANDOM_STATE", "42"))
    max_iter = int(os.environ.get("CLUSTER_MAX_ITER", "300"))

    log.info("/cluster — model_id=%r k=%d threads=%d", model_id, n_clusters, effective_threads)

    loop = asyncio.get_running_loop()
    ticket = await _admit_map_job("cluster", database_url, model_id, body.get("accept_busy") is True)
    return await _run_admitted(
        request, ticket, lambda: _cluster_job(loop, database_url, model_id, n_clusters, random_state, max_iter)
    )


async def _cluster_job(
    loop: asyncio.AbstractEventLoop,
    database_url: str,
    model_id: str,
    n_clusters: int,
    random_state: int,
    max_iter: int,
) -> PlainTextResponse:
    try:
        rows = await loop.run_in_executor(_CPU_EXECUTOR, _fetch_cluster_embeddings, database_url, model_id)
    except Exception as exc:  # noqa: BLE001
        log.error("/cluster DB error: %s", exc)
        raise HTTPException(status_code=500, detail=f"DB error: {exc}") from exc

    if len(rows) == 0:
        log.info("/cluster — no embeddings, returning empty stream")
        return PlainTextResponse(content="", media_type="application/x-ndjson")

    media_ids = [r[0] for r in rows]
    embeddings = [r[1] for r in rows]

    try:
        labels = await loop.run_in_executor(_CPU_EXECUTOR, _run_kmeans_job, embeddings, n_clusters, random_state, max_iter)
    except Exception as exc:  # noqa: BLE001
        log.error("/cluster KMeans error: %s", exc)
        raise HTTPException(status_code=500, detail=f"KMeans error: {exc}") from exc
    finally:
        del rows, embeddings
        await loop.run_in_executor(None, _release_freed_heap)

    lines = [
        json.dumps({"media_id": media_id, "cluster_id": cluster_id}, ensure_ascii=False)
        for media_id, cluster_id in zip(media_ids, labels)
    ]
    log.info("/cluster — assigned %d tracks", len(lines))
    return PlainTextResponse(
        content="\n".join(lines) + "\n",
        media_type="application/x-ndjson",
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _require_model() -> None:
    """Raise 503 if the model is not yet loaded."""
    if not _model_ready:
        raise HTTPException(status_code=503, detail={"status": "loading"})


async def _parse_json_body(request: Request, allow_empty: bool = False) -> dict[str, Any]:
    """
    Parse the request body as JSON. Returns {} if body is empty and allow_empty=True.
    Raises 422 on malformed JSON.
    """
    raw = await request.body()
    if not raw:
        if allow_empty:
            return {}
        raise HTTPException(status_code=422, detail="Request body must be a JSON object")
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=422, detail=f"Invalid JSON: {exc}") from exc


# ---------------------------------------------------------------------------
# Standalone entry point (for local testing without uvicorn CLI)
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import uvicorn  # type: ignore[import]

    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run("server:app", host="0.0.0.0", port=port, log_level="info")
