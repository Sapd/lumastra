# sonic-embedder

CLAP('2023') audio embedding CLI used by the Lumastra sonic-similarity pipeline.

Node spawns `embed.py` via `execFile` (one fresh process per batch), writes a
JSON payload to its stdin, and reads JSONL results from its stdout.

---

## Stdin / stdout contract

### Input (one JSON line on stdin, then EOF)

```json
{ "paths": ["/abs/path/to/track1.flac", "/abs/path/to/track2.mp3"] }
```

### Output (one JSONL line per path on stdout)

Success:

```json
{ "path": "/abs/path/to/track1.flac", "embedding": [0.012, ..., -0.034] }
```

Failure (per-file — batch continues):

```json
{ "path": "/abs/path/to/track2.mp3", "error": "FileNotFoundError: [Errno 2]..." }
```

- **Dimension:** exactly 1024 floats (float32)
- **Model:** `CLAP(version='2023', use_cuda=torch.cuda.is_available())`
- **Tensor path:** `model.get_audio_embeddings([path]).detach().cpu().numpy()[0].tolist()`
- **Stderr:** free for diagnostic logs — Node ignores it
- **Exit 0** on success (even if some files failed); **exit 1** on model load failure

---

## Local usage (without Docker)

```bash
# Install deps (GPU host with CUDA-enabled torch already installed)
pip install msclap librosa soundfile

# Run
echo '{"paths":["/data/music/track.flac"]}' | python3 embed.py
```

---

## Docker usage

> **Production / Docker Compose — you normally do NOT build this by hand.** The
> sidecar is published by CI as `ghcr.io/lumastra/lumastra-sonic-embedder`, tagged like the main image (`:stable`/`:latest`/`:X.Y.Z` for releases, `:edge` for `main` builds that changed it; amd64 only), and
> `docker-compose.example.yml` ships a ready `lumastra-sonic-embedder` service that
> pulls it — just `docker compose up`. The CLAP-2023 weights download from
> HuggingFace (`microsoft/msclap`) at runtime; they are **not bundled**. Mount a
> volume at `HF_HOME` (`/app/.cache/huggingface`) to persist them across recreates,
> or set `SONIC_MODEL_FP` to a local `.pth` for air-gapped installs. See
> [Deploy with Docker](https://lumastra.org/guides/deploy-docker/) for the full
> service definition (incl. the NVIDIA GPU block). The steps below are only for
> building from source.

### Build from source

```bash
docker build -t sonic-embedder workers/sonic-embedder/
```

### Run (CPU)

```bash
echo '{"paths":["/data/music/track.flac"]}' | \
  docker run -i --rm \
    -v /data/music:/data/music:ro \
    sonic-embedder
```

### Run (NVIDIA GPU)

```bash
echo '{"paths":["/data/music/track.flac"]}' | \
  docker run -i --rm --gpus all \
    -v /data/music:/data/music:ro \
    sonic-embedder
```

### Run (Intel Arc / AMD via ROCm)

Use an appropriate base image instead of `pytorch/pytorch` (e.g.
`rocm/pytorch` for AMD). The `embed.py` script itself is hardware-agnostic —
`use_cuda=torch.cuda.is_available()` is the only GPU check.

---

## HTTP sidecar mode (server.py)

When `SONIC_EMBEDDER_URL` is set (the Docker Compose deployment),
Node talks to a long-lived FastAPI/uvicorn server instead of spawning a fresh
`embed.py` process per batch — the CLAP model loads once and stays warm.
Endpoints: `GET /health`, `POST /embed`, `POST /analyze`, `POST /embed-text`,
`POST /project-map`, `POST /cluster`. Empty/unset `SONIC_EMBEDDER_URL` falls
back to the subprocess mode documented above.

**CPU controls** — a bad file or a large backlog must not be able to peg every
core on the host:

- `SONIC_EMBEDDER_THREADS` (env) caps PyTorch/BLAS intra-op threads; a
  per-request `threads` field overrides it. Unset default: half the container's
  CPU budget — the smaller of its cgroup quota (`cpus:`) and its cpuset.
- The Compose `deploy.resources.limits.cpus` value is the actual cross-container
  enforcement (cgroup-level) — `SONIC_EMBEDDER_THREADS` should not exceed it,
  or a single request can ask for more threads than the container is allotted.
- `nice -n 19` in the `ENTRYPOINT` is belt-and-suspenders only; it doesn't
  arbitrate across containers on cgroup-v2.
- **Set `SONIC_EMBEDDER_THREADS`.** Images before 2026-09-30 derived the unset default
  from `os.cpu_count()`, which inside a container is the host's core count, not the
  `cpus:` limit. On a 48-core host that meant 24 threads, and the sidecar was
  OOM-killed every ~30 s (7000+ restarts). The default now follows the container's
  CPU budget.

**Memory controls** — the sidecar sizes itself from the container's memory limit
(Compose `memory:`, Kubernetes `limits.memory`), so the limit is the one setting
that matters:

- `/embed` decodes only the 7-second window CLAP embeds (`windowed_embed.py`), not
  the whole track, so it costs about the same for a 3-minute song and a 2-hour mix
  (+25 MB measured for 80 minutes; the full decode needed +5 GB). The window is drawn
  exactly as msclap draws it: embeddings are unchanged and nothing is re-embedded.
- `/analyze` runs chunk by chunk (`analyze_chunked.py`) with output identical to the
  whole-track code it replaced (`analyze_golden_test.py` checks it). Only the
  decoded 44.1 kHz mono signal and per-frame arrays grow with the track: about
  22 MB per minute of audio (measured +0.9 GB at 30 minutes, +2.7 GB at 2 hours;
  the whole-track code needed +8.0 GB at 30 minutes).
- Every heavy job (`/embed`, `/analyze`, `/cluster`, `/project-map`) is admitted by a
  memory gate (`admission.py`) against **budget = limit − the loaded model − a
  reserve**, in arrival order. A job that does not fit next to the running ones
  waits; one bigger than the budget runs alone; one that would not fit even alone is
  refused with a per-file error (`code: exceeds_memory_budget`) instead of
  OOM-killing the sidecar. The app asks for HTTP 429 + `Retry-After` when a request
  waits too long, waits, and resends without blaming the track.
- The CLAP text encoder (GPT-2, 0.5 GB) serves only text search. Below 8 GiB it is
  loaded on the first text query and dropped again after 15 idle minutes
  (`text_encoder.py`; the text embeddings are bit-identical either way).
- `GET /health` reports the limit, budget, running jobs and counters under
  `memory`; every job logs its estimate next to the RSS it reached.

| Env var                             | Default                                                    | What it does                                              |
| ----------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------- |
| `SONIC_MEMORY_LIMIT_MB`             | the container limit (cgroup v2/v1), else half the host RAM | Memory the sidecar may plan with. Normally leave unset.   |
| `SONIC_MEMORY_RESERVE_MB`           | max(512, 10 % of the limit)                                | Headroom kept out of the budget.                          |
| `SONIC_MAX_CONCURRENT_JOBS`         | CPUs ÷ threads, at most 2                                  | Heavy jobs at once (the memory gate may run fewer).       |
| `SONIC_ADMISSION_QUEUE_TIMEOUT_SEC` | 120                                                        | How long a request that accepts a 429 may queue.          |
| `SONIC_TEXT_ENCODER`                | `auto` (warm at ≥ 8 GiB, else lazy)                        | `warm`, `lazy` or `auto`.                                 |
| `SONIC_TEXT_ENCODER_IDLE_SEC`       | 900                                                        | Idle time before a lazy text encoder is dropped again.    |
| `SONIC_ANALYZE_MAX_DURATION_SEC`    | 7200                                                       | `/analyze` refuses longer files before decoding them.     |
| `SONIC_ANALYZE_CHUNK_SEC`           | 30                                                         | Audio per `/analyze` chunk; output-neutral.               |
| `MALLOC_ARENA_MAX`                  | 2 (image)                                                  | glibc malloc arenas; fewer arenas hold less freed memory. |

Suggested sizes (measured on preprod, 4 threads):

| Box                 | Sidecar memory           | Result                                                                                                                                                                                                      |
| ------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Small NAS / mini PC | 3g                       | Lazy text encoder (~0.8 GB idle). Everything embeds; `/analyze` takes tracks up to about 1 hour; up to about 80 minutes they run alone, longer ones are refused with that reason (`exceeds_memory_budget`). |
| Home server         | 6g (the example compose) | Every job, `/analyze` up to the 2-hour cap.                                                                                                                                                                 |
| Large library       | 10g+                     | Warm text encoder; more room for two jobs at once.                                                                                                                                                          |

**Upgrading from an image before 2026-09-27:** the image now runs as non-root uid
1000 (user `sonic`); older images ran as root. A model cache volume or bind mount at
`HF_HOME` (`/app/.cache/huggingface`) created by the old image is owned by root, and
the model can then neither load nor download. Fix it once before upgrading:
`chown -R 1000:1000 <cache dir>` (for a named volume, e.g.
`docker run --rm -v sonic-model-cache:/c alpine chown -R 1000:1000 /c`).

**Hardened setup (supported, and how the example compose runs it):**
`read_only: true`, a `tmpfs` on `/tmp`, `cap_drop: [ALL]` and
`security_opt: [no-new-privileges:true]`. The image sets
`NUMBA_CACHE_DIR=/tmp/numba-cache`, so librosa's numba JIT cache works with a
read-only root filesystem.

**Event loop isolation** — uvicorn runs a single worker (one asyncio event
loop). All the blocking librosa/torch/umap/sklearn work is dispatched through
`loop.run_in_executor()` onto a small dedicated `ThreadPoolExecutor`
(`_CPU_EXECUTOR`, one thread per job the memory gate may run; `/embed-text` has its
own one-thread lane so a search never waits behind a batch) instead of running inline in the `async def`
handlers. Without this, the event loop — and therefore `GET /health` — is
blocked for the full duration of a job (several seconds per track), which
previously caused the container's own healthcheck (and real caller
connections) to time out under sustained backlog load even though the model
was working fine.

**Healthcheck**: `curl -fsS --max-time 4 http://localhost:8000/health` on a
15s interval, 3 retries, 120s start period (model load time). Deliberately
_not_ a fresh `python3 -c "import urllib..."` per tick — spinning up an
interpreter on every probe added its own CPU/scheduling cost on top of
whatever `/analyze` was doing.

---

## Node configuration (config.ts)

| Env var                     | Default                           | Purpose                     |
| --------------------------- | --------------------------------- | --------------------------- |
| `SONIC_EMBEDDER_PYTHON`     | `python3`                         | Python interpreter path     |
| `SONIC_EMBEDDER_SCRIPT`     | `workers/sonic-embedder/embed.py` | Path to this script         |
| `SONIC_EMBEDDER_BATCH_SIZE` | `16`                              | Tracks per spawn invocation |

Set `FEATURE_MUSIC_SONIC=true` to enable the feature (also requires
`FEATURE_AI_RECOMMENDATIONS=true` — see `features.sonicEmbeddings` getter).

---

## How it fits into the pipeline

```
Node task: sonic-embedding-backfill
  └─ Queries tracks missing 'done' state in media_audio_embedding_state
  └─ Batches file_paths (batch size from config)
  └─ For each batch:
       └─ Spawns: python3 embed.py  (execFile)
            stdin  ← { "paths": [...] }
            stdout → { "path": ..., "embedding": [...] }  (per line)
       └─ Writes vectors → media_audio_embeddings (model_id='msclap-2023')
       └─ Marks state  → media_audio_embedding_state (status='done'/'failed')
```

Results are served by `GET /api/music/[id]/sonic-similar` (gated by
`FEATURE_MUSIC_SONIC`), which does a cosine kNN over the HNSW index on
`media_audio_embeddings.embedding`.

---

## Dependencies

| Package     | Purpose                               |
| ----------- | ------------------------------------- |
| `msclap`    | Microsoft CLAP model wrapper          |
| `torch`     | Tensor operations + CUDA backend      |
| `librosa`   | Audio loading and resampling          |
| `soundfile` | Audio file I/O (C-backed, fast)       |
| `ffmpeg`    | System dep: decodes MP3/AAC/FLAC/etc. |
