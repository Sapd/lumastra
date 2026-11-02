# tasks/

Clean-rewrite task system — queue orchestration, plugin contracts, Lua state machine, scheduler, and builtin task implementations for Lumastra.

---

## Context construction (CRITICAL)

**Never hand-roll a `TaskContext`/`PluginContext` object literal cast through `as unknown as ...`.** SDK fields get added over time (e.g. `catalog`, `mediaItems`, `mediaFiles`, `userCredentials`); a hand-rolled stub silently misses them and throws `TypeError` when the plugin reaches for the missing surface. Bug class: the per-item retry endpoint shipped with a hand-rolled stub that omitted those four fields.

| Use case                                                              | Helper                                                          |
| --------------------------------------------------------------------- | --------------------------------------------------------------- |
| Plugin/provider call from a service or route                          | `buildPluginContext(pluginId, opts?)` in `plugin-context.ts`    |
| Admin route invoking a task lifecycle/backlog hook outside a real run | `buildAdminContextStub(pluginId, opts?)` in `plugin-context.ts` |
| Provider one-shot (search/detail/childList)                           | `invokeProviderSearch / Detail / ChildList` wrappers            |

`buildAdminContextStub` is the only sanctioned shape for "I need a `TaskContext` but I'm not inside a queued run." Adding a new SDK field updates the helper once; every admin route picks it up for free.

The concrete builders both callers compose from live in `context-primitives.ts` (`HttpClient`, `NamespacedCache`, etc., backed by Valkey/fetch/`plugin_settings`) — `runner.ts` uses them to build the real in-run `TaskContext`, `plugin-context.ts` uses them to build the non-task `PluginContext`. There is no separate `context.ts` file; that responsibility was split across these two.

---

## For plugin authors

This section is for developers writing new plugins against `@sapd/lumastra-plugin-sdk`. Read this first before opening any other file.

### Recommended reading order

Start with the five native exemplars in `builtin/native/` — each one is tutorial-grade with `// TUTORIAL:` markers. Read them in order from smallest to largest:

| Exemplar                       | What it demonstrates                                                 |
| ------------------------------ | -------------------------------------------------------------------- |
| `native/dummy-sync.ts`         | Smallest possible plugin — read this FIRST                           |
| `native/cache-cleanup.ts`      | Scheduled maintenance with Valkey                                    |
| `native/tmdb-metadata-sync.ts` | External API: rate limit + secrets + retry + cost                    |
| `native/library-embeddings.ts` | Chunked drain via `backlog: { stages, compute }`                     |
| `native/file-system-scan.ts`   | Multi-stage pipeline + conditional `when:` + `scope: 'libraryGroup'` |

### Minimal end-to-end example

```ts
// 1. Define the task
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import { z } from 'zod';

export const myTask = defineTask({
    id: 'my-task',
    name: 'My Task',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '1.0.0',
    capabilities: { database: true },
    resourceClass: 'io',
    schedule: { every: '15m' },
    inputSchema: z.object({ libraryGroupId: z.string().optional() }),
    identityFor: (input) => input.libraryGroupId ?? 'global',
    async execute(ctx) {
        ctx.logger.info('running');
        return { success: true, itemsProcessed: 0 };
    },
});

// 2. Register it (in builtin/index.ts or your plugin's boot path)
import { registry } from '$lib/server/tasks/registry.js';
registry.registerTask(myTask);

// 3. Trigger it in-process
import { orchestrator } from '$lib/server/tasks/orchestrator.js';
await orchestrator.startRun(
    'my-task',
    {},
    {
        trigger: { kind: 'in-process', sourceRoute: 'my-service' },
    },
);
```

### SDK exports

All SDK types and helpers live in `packages/@sapd/lumastra-plugin-sdk/` and are re-exported from `@sapd/lumastra-plugin-sdk`. The `define*.ts` factory-file pattern that used to live inside `tasks/` has moved there in full — there is no `define-task.ts` / `define-provider.ts` / etc. under `tasks/` anymore:

| Export                         | Purpose                                                                                            |
| ------------------------------ | -------------------------------------------------------------------------------------------------- |
| `defineTask(def)`              | Validate + return a TaskDefinition                                                                 |
| `defineProvider(def)`          | Validate + return a ProviderDefinition                                                             |
| `defineTrickplayProvider(def)` | Validate + return a TrickplayProviderDefinition                                                    |
| `defineWatchSync(def, opts?)`  | Validate + synthesize push/pull auto-tasks                                                         |
| `defineFeature(def)`           | Validate + return a FeatureDefinition (HTTP route registration)                                    |
| `defineIntegration(def)`       | Validate + return an IntegrationDefinition (webhook/IPC)                                           |
| `defineExternalService(def)`   | Validate + return an ExternalServiceDefinition                                                     |
| `defineMediaSource(def)`       | Validate + return a MediaSourceDefinition                                                          |
| `defineSubtitleProvider(def)`  | Validate + return a SubtitleProviderDefinition                                                     |
| `defineLyricsProvider(def)`    | Validate + return a LyricsProviderDefinition                                                       |
| `defineAuthProvider(def)`      | Validate + return an AuthProviderDefinition (pre-auth carve-out — see root CLAUDE.md)              |
| `definePlugin(def)`            | Bundle multiple contracts from one plugin manifest                                                 |
| `TaskError`                    | Throw to signal transient/permanent/fatal failure                                                  |
| `PluginDefinitionError`        | Thrown by `defineTask` (and siblings) on manifest validation failure                               |
| `COST_KINDS`                   | `['openai_tokens', 'cpu_seconds', 'api_calls']`                                                    |
| `RESOURCE_CLASSES`             | `['cpu', 'io', 'embedding', 'maintenance', 'ingest', 'bulk', 'analysis', 'discovery']` (8 classes) |

`TaskRegistry` (`registry.ts`) loads all 11 contract types (everything above except `TaskError`/`PluginDefinitionError`/the two constants/`definePlugin`, which is a bundler rather than its own contract) at startup. Full authoring guide (all contracts, multi-contract bundles, signing, ABI): https://lumastra.org/developers/plugins/

Testing helpers live in `@sapd/lumastra-plugin-sdk-testing`:

```ts
import { mockContext, expectRun, runTask } from '@sapd/lumastra-plugin-sdk-testing';
import { mockHttpClient, mockCache, mockLogger } from '@sapd/lumastra-plugin-sdk-testing';
```

### Resource class decision rubric

Ask the questions in order. The first YES is your answer.

```
Q1. Will any single run take longer than 5 minutes?
  YES → "long-running" path:
    - ffmpeg / chromaprint / per-season audio analysis  →  'analysis'
    - bulk API enrichment (rate-limited, hours per pass) →  'bulk'
    - OpenAI / vector embeddings                         →  'embedding'
    - catalog/discovery embedding backfill (fresh-install →  'discovery'
      floods, isolated so they can't starve the user's
      own library/music embeddings on the shared
      'embedding' budget)

  NO  → "fast-cycle" path:
    - ffmpeg / CPU subprocess (single short job)        →  'cpu'
    - per-file ingest fast path                          →  'ingest'
    - HTTP / disk / network                              →  'io'
    - periodic housekeeping / cleanup                    →  'maintenance'

Default if unsure → 'bulk' (safe — won't starve fast-cycle tasks)
```

**Why duration first?** The most common starvation failure isn't "CPU task put on IO class" — it's "long-running task put on a class with short-running tasks." When trickplay (10-min jobs) and intro-analyzer (per-season chromaprint, ~hour) shared `cpu`, intro-analyzer starved for 30 hours. Class invention (`analysis`) was the fix because BullMQ pops strict-priority FIFO and the _duration_ difference is what causes head-of-line blocking. `discovery` was split out of `embedding` for the same reason: a fresh-install catalog backfill can enqueue tens of thousands of jobs back-to-back and would otherwise starve a user's own library embeddings.

| Class         | Default concurrency        | Typical job duration | Examples                                                              |
| ------------- | -------------------------- | -------------------- | --------------------------------------------------------------------- |
| `cpu`         | auto (floor(cores/2), 1–6) | seconds–minutes      | trickplay-generation (short ffmpeg)                                   |
| `io`          | 4                          | seconds              | file-scan, image-sync, watch-sync push/pull, refresh-epg              |
| `ingest`      | 2                          | seconds              | media-probe, chapter-sync, image-sync                                 |
| `embedding`   | 2                          | minutes              | library-embeddings, music-embedding                                   |
| `discovery`   | 1                          | minutes–hours        | discovery-embeddings (catalog backfill)                               |
| `maintenance` | 3                          | seconds              | cache-cleanup, oauth-cleanup, history-cleanup                         |
| `bulk`        | 3                          | minutes–hours        | file-library-scan, tmdb-metadata-sync, mdblist-sync, music-popularity |
| `analysis`    | 1                          | minutes–hours        | lumastra-intro-analyzer, music-analysis (chromaprint)                 |

**About `taskPriority`** — DON'T use it for fairness. BullMQ pops strict-priority FIFO; a starved priority-7 task next to a backlogged priority-5 task never runs. Use class isolation instead. `taskPriority` is appropriate only for within-class admin-retry jumps (priority 1 jumps over default 5 of the same class for a one-shot retry).

**About `quotas.maxConcurrent`** — per-task ceiling enforced via Valkey INCR/DECR. Use this when a task must never have more than N concurrent runs (e.g., third-party API with hard rate limit).

> **Architecture note (Wave 8.5 — SHIPPED, default-ON):** the per-task-queue redesign is live. `FEATURE_PER_TASK_QUEUES` defaults `true` (`config.ts`), so the runner creates **one BullMQ queue + worker per task** (not one worker per class — the "TaskRunner (4 workers)" diagram below is legacy), governed by a **per-physical-class budget semaphore** (`budget-semaphore.ts`, Valkey `INCR` on key `task:resource-budget:<class>`, 300s TTL backstop). The 8 SDK `resourceClass` values still validate but three of them map to physical pools via a **legacy compat shim** in `registry.ts`: `ingest`+`bulk` → `io`, `analysis` → `cpu` (so a task without `quotas.maxConcurrent` defaults its worker concurrency to the full physical-class budget — `defaultConcurrencyFor()` in `runner.ts` sums the folded classes, e.g. `io` = io+ingest+bulk, so the physical budget doesn't shrink versus the old separate pools). `discovery` is NOT folded — it has been its own physical class (and its own `LUMASTRA_CONCURRENCY_DISCOVERY` / `LUMASTRA_QUEUE_DEPTH_CAP_DISCOVERY` env vars) since it was introduced, precisely so a catalog backfill can't eat the `embedding` budget. Size `LUMASTRA_CONCURRENCY_IO`/`_CPU`/`_EMBEDDING`/`_MAINTENANCE`/`_DISCOVERY` per environment. No plugin needs to change a `resourceClass` it already declared.
>
> **Architecture note (Redis connection consolidation):** Queue/Worker/QueueEvents connections are built via `getQueueConnection()` (`connection.ts`), which shares one `IORedis` instance across them when `FEATURE_SHARED_QUEUE_CONNECTION` is on. The flag defaults to the value of `LUMASTRA_LOW_RAM_MODE` unless explicitly set, so constrained installs get the lower connection count automatically. This reduces but does not eliminate per-task connection count, since Worker's blocking pop and QueueEvents always duplicate regardless. (Two admin endpoints, `src/lib/server/api/defs/queues/[queue]/pause.ts` and `.../resume.ts`, still build a transient Queue directly via `getQueueConnectionOptions()` — harmless, ephemeral on-demand admin actions, intentionally out of scope here.)

---

## Files

| File                              | What                                                                                                                                                                                                         | When to read                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `registry.ts`                     | `TaskRegistry` + `ProviderRegistry` — load, validate, resolve DAGs, legacy fairness-lane → physical-class rewrite (Wave 8.5)                                                                                 | Understanding plugin load order or registry lookup      |
| `orchestrator.ts`                 | `TaskOrchestrator` — leader election, `startRun`, state transitions                                                                                                                                          | Triggering runs, understanding run lifecycle            |
| `runner.ts`                       | `TaskRunner` — BullMQ workers, dispatch by name, builds the real `TaskContext`, heartbeat                                                                                                                    | Understanding task execution or concurrency model       |
| `context-primitives.ts`           | Shared host-side builders (`HttpClient`, `NamespacedCache`, etc.) that `runner.ts` (`TaskContext`) and `plugin-context.ts` (`PluginContext`) both compose from                                               | Understanding what plugins receive at execute time      |
| `plugin-context.ts`               | `buildPluginContext` / `buildAdminContextStub` for non-task callers — see "Context construction" above                                                                                                       | Calling a plugin/provider outside a queued run          |
| `identity.ts`                     | `computeIdentity()` — BullMQ jobId formula + cross-time SETNX                                                                                                                                                | Understanding dedup logic                               |
| `pipeline-builder.ts`             | FlowProducer tree construction from declarative DAG                                                                                                                                                          | Understanding pipeline orchestration                    |
| `state-machine.ts`                | Lua-backed atomic `transitionRun`, `transitionStage`, `incrementStage`, `claimRun`                                                                                                                           | Understanding state transitions or writing Lua tests    |
| `reconciler.ts`                   | 30s leader-elected sweep — stale-active recovery, waiting-children drain                                                                                                                                     | Understanding orphan recovery                           |
| `run-liveness-authority.ts`       | Single liveness rule for orphan recovery — a run whose `heartbeat_at` is stale past threshold is DEAD (replaced the old 3-signal BullMQ/Valkey/cluster-node classification)                                  | Understanding orphan/zombie run classification          |
| `run-resume.ts`                   | Resume-after-restart for manual runs of `resumeAfterRestart` tasks — the loop-protection rules (graceful-shutdown marker, max 3, crash-loop window, cancel wins), `ctx.checkpoint`, the reclaim messages     | Changing what happens to a run a restart interrupts     |
| `boot-recovery.ts`                | `BootRecovery` — thin shim delegating to `run-liveness-authority.ts`; kept only for `orchestrator.ts` call sites, slated for deletion                                                                        | Understanding startup reconciliation                    |
| `recovery-thresholds.ts`          | Single source of truth for the boot/reconciler/watchdog stale-heartbeat thresholds, which must stay ordered                                                                                                  | Tuning or debugging orphan-recovery timing              |
| `circuit-breaker.ts`              | Per-task circuit breaker — DB-backed (no Valkey mirror), open/half-open/closed + force-enable; half-open probe gate uses a Valkey SETNX                                                                      | Understanding auto-quarantine behavior                  |
| `backpressure.ts`                 | Queue-depth cap enforcement (drop / fail-fast / shed-oldest), per resource class                                                                                                                             | Implementing or debugging backpressure                  |
| `budget-semaphore.ts`             | Per-physical-class concurrency token semaphore (Wave 8.5) — every per-task worker acquires a token here before invoking the plugin handler                                                                   | Debugging per-task-queue concurrency                    |
| `task-queue-registry.ts`          | Per-task BullMQ Queue cache (Wave 8.5) — one Queue per task instead of one per class                                                                                                                         | Understanding per-task queue creation/caching           |
| `secrets.ts`                      | AES-GCM secret store (`ctx.secrets.get/getUser`) + access audit                                                                                                                                              | Working with plugin secrets or OAuth tokens             |
| `rate-limiter.ts`                 | `ctx.dep(name).fetch()` — per-dependency limiter: local token bucket composed with the cross-replica `shared-rate-bucket.ts`                                                                                 | Adding rate-limited external API calls                  |
| `http-rate-limit.ts`              | Enforces a provider's declared `rateLimit: { rps }` on `ctx.http` (previously metadata-only)                                                                                                                 | Adding a rate-limited provider                          |
| `url-safety.ts`                   | `safeFetch` / `assertPublicHttpUrl` — SSRF guard (DNS pinning, private/loopback IP rejection, manual redirect re-validation) behind `ctx.http` and `ctx.dep().fetch()`                                       | Touching outbound HTTP from a plugin                    |
| `cost-ledger.ts`                  | `ctx.spend()` accumulator → `cost_breakdown` JSONB on terminal                                                                                                                                               | Understanding cost tracking                             |
| `cloud-events.ts`                 | CloudEvents 1.0 envelope builder                                                                                                                                                                             | Understanding event emission shape                      |
| `webhook-outbox.ts`               | HMAC-signed delivery worker, retries, DLQ, `task_webhook_outbox` drain                                                                                                                                       | Debugging webhook delivery                              |
| `webhook-signature.ts`            | Shared HMAC signing helpers (`X-Lumastra-Signature`) — outbox worker and the admin "test" endpoint both import from here                                                                                     | Touching the webhook wire format                        |
| `metrics.ts`                      | Prometheus metric surface — 17 metrics, bounded cardinality (e.g. `pushDeliveriesTotal` (`lumastra_push_deliveries_total`) has `outcome` label values `delivered`/`dead`/`retry`/`partial_dead`/`no_tokens`) | Understanding metrics or adding new counters            |
| `log-buffer.ts`                   | Valkey LIST `task:log:<runId>` + pubsub mirror for live log tail                                                                                                                                             | Understanding log streaming                             |
| `progress.ts`                     | `ctx.reportProgress()` — throttled 250ms, 30s forced heartbeat                                                                                                                                               | Understanding progress reporting contract               |
| `scheduler.ts`                    | Interval-based scheduler reading task manifests, fires via `startRun`; multi-replica fairness via Valkey SETNX per `<taskId>:<bucket>`                                                                       | Understanding scheduled task firing                     |
| `scheduler-state.ts`              | `scheduler_state` table queries — `last_fired_at` persistence                                                                                                                                                | Debugging missed-cycle detection                        |
| `pending-write-drain.ts`          | Valkey LIST → Postgres drain when DB unreachable during an orchestrator write                                                                                                                                | Understanding write durability                          |
| `cancel-channel.ts`               | Per-run cancel pubsub, multiplexed over ONE shared Valkey subscription                                                                                                                                       | Understanding cancellation propagation                  |
| `hard-kill.ts`                    | BullMQ `moveToFailed` + Redis pipeline bypass for SIGKILL'd/unresponsive workers, 60s after soft-cancel                                                                                                      | Understanding hard-kill path                            |
| `orphan-sweep.ts`                 | Stuck `waiting-children` parent drain — force-completes a parent whose dependency ZSET is empty but never self-advanced                                                                                      | Understanding orphaned parent recovery                  |
| `connection.ts`                   | BullMQ connection builder — `getQueueConnectionOptions()` (default, one connection per Queue/Worker/QueueEvents) and the flag-gated shared `getQueueConnection()`                                            | Debugging connection count / low-RAM mode               |
| `connection-watchdog.ts`          | Crash-only recovery for wedged worker Valkey/BullMQ connections after a partition or peer-IP change                                                                                                          | Debugging a worker stuck "running" but not processing   |
| `leader-lock.ts`                  | Renewable SET-NX leader lock for per-class orchestrator leadership (extracted from `orchestrator.ts`)                                                                                                        | Debugging leader election                               |
| `transition-batcher.ts`           | Ordered buffer that coalesces run-state transitions before flushing (extracted from `orchestrator.ts`)                                                                                                       | Debugging transition write batching                     |
| `queue-naming.ts`                 | Centralized BullMQ queue-name / Redis-prefix helpers (queue names are the bare resource class; the `bull:task` prefix is applied separately, since BullMQ 5.69+ rejects `:` in queue names)                  | Touching queue/worker construction                      |
| `bull-defaults.ts`                | Shared BullMQ Queue defaults (retention) — single source of truth for `task-queue-registry.ts` and legacy class queues                                                                                       | Changing job retention                                  |
| `duration.ts`                     | Canonical duration-string parser — single source of truth for `schedule.every`, `timeout.hard/soft`, `exclusiveWith.ttl`                                                                                     | Parsing or validating a duration string                 |
| `decline-loop.ts`                 | Backoff constants + shared streak-reset fragment that stop a per-item stage task looping forever on `{ success: false }` without a permanent marker                                                          | Debugging a stage stuck retrying the same item          |
| `identity-ttl-floor.ts`           | Derived per-task floor for the `exclusiveWith` identity-key TTL: `max(timeout.hard_ms, schedule.every_ms) + margin`                                                                                          | Debugging identity-key expiry vs. run duration          |
| `infra-retry.ts`                  | Classifies transient infra errors (network, HTTP 5xx, Postgres connection loss) as safe for `retry.retryOn`                                                                                                  | Wiring task-level retry policy                          |
| `shared-rate-bucket.ts`           | Cross-replica shared rate-limit bucket — replaces the process-local bucket so N replicas don't multiply an external provider's effective rps by N                                                            | Debugging multi-replica rate-limit overshoot            |
| `cache-namespace.ts`              | `buildNamespacedCache(pluginId)` — the one definition of how a task's Valkey cache keys are namespaced                                                                                                       | Reconstructing a task's cache key for an admin SCAN/DEL |
| `valkey-types.ts`                 | Shared Valkey primitives: `ValkeyLike` (minimal GLIDE-client interface for mocking), `errMessage`                                                                                                            | Writing Valkey-touching code or tests                   |
| `stage-disposition-runner.ts`     | Executes a stage's declared `terminalDisposition` + `eligibility` dispose pass in one pre-enqueue call                                                                                                       | Understanding the Declarative Stage Contract            |
| `stage-disposition-validation.ts` | Registry-independent validation of a stage's `terminalDisposition` shape, reachable from both live registration and unit tests                                                                               | Writing/debugging stage disposition validation          |
| `run-wrapper.ts`                  | Wraps a task's `execute()` so the matching `media_item_stage_state` row flips running → completed/failed around it                                                                                           | Understanding pipeline-coverage stage state transitions |
| `run-event.ts`                    | Single redaction point for run lifecycle events, shared by the SSE publisher and `GET /api/runs` so they can't drift apart on what gets stripped                                                             | Touching run-event serialization                        |
| `runner-events.ts`                | Run lifecycle event emission from the writer side — the runner (not the orchestrator's QueueEvents observer) writes terminal rows for normally-finishing runs                                                | Debugging a missing/duplicate terminal event            |
| `plugin-ai-surface.ts`            | Optional `ctx.ai` bridge — reaches the (proprietary, AGPL-boundary-respecting) AI assistant pipeline only through the AGPL-core registry indirection                                                         | Touching `ctx.ai` or the license boundary               |
| `plugin-stores.ts`                | Typed `ctx` stores for smart playlists / intro detectors — a contract on top of raw `capabilities.database` SQL access                                                                                       | Adding a plugin that writes playlists or media segments |
| `handle-trigger-failure.ts`       | Fail-loud helper for `orchestrator.startRun` callers so a missing-task-id error can't blend into normal log noise                                                                                            | Wrapping a `startRun` call site                         |
| `global-enqueue-backoff.ts`       | Non-progress backoff for GLOBAL-identity coverage enqueues (added after a scheduled task fired 1,037×/day and burned a provider's daily API quota)                                                           | Debugging a runaway enqueue loop                        |
| `global-pause-reconcile.ts`       | Shared "pause everything for N hours" / quiet-hours logic used by both the admin HTTP endpoint and the `pause-reconcile` scheduled task                                                                      | Touching global pause / quiet hours                     |
| `queue-depth-throttle.ts`         | Shared queue-depth throttle thresholds consulted by both the periodic stage-sweep enqueue loop and the eager-enqueue fast path, so eager enqueue can't bypass the sweep's back-off                           | Debugging a queue-depth flood                           |
| `lane-data.ts`                    | `TaskLane` resolution — re-exports the Zod-schema-derived source of truth so existing importers (the admin `/tasks` page) keep resolving                                                                     | Adding or reading a task lane                           |
| `task-history.ts`                 | Single home for the `task_history` row INSERT (previously duplicated at 3 call sites)                                                                                                                        | Changing the `task_history` schema/columns              |
| `run-filter-sql.ts`               | `listRuns` filter fragment builders — the subject-scope filter is intentionally NOT the usual `AND ($n IS NULL OR col = $n)` shape, to keep a partial index usable                                           | Touching run-listing filters or their index usage       |
| `api-auth.ts`                     | Auth resolution for `/api/v1` task endpoints                                                                                                                                                                 | Debugging task API auth                                 |
| `api-call-spend.ts`               | Per-host provider call spend for a task run: `api_calls:<host>`, plus `api_errors:<host>` and `api_429:<host>` when they occur (fed by `utils/external-request-counter.ts`)                                                                                                                                            | Debugging provider call / error / 429 cost accounting   |

## Subdirectories

| Directory                     | What                                                                                                                                                                                                                                                                                             | When to read                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `lua/`                        | Lua atomic scripts (state transitions, identity dedup) + `SCRIPT_VERSIONS.ts` version pins                                                                                                                                                                                                       | Writing or debugging Lua state transitions                       |
| `builtin/`                    | All builtin task/provider/feature/integration/media-source/watch-sync/trickplay plugin implementations — see `builtin/CLAUDE.md`                                                                                                                                                                 | Working on a specific sync plugin or background task             |
| `isolation/`                  | `node:worker_threads` isolation for `execute()` (`worker-host.ts` main-thread host, `sandbox-entry.ts` in-worker entry, `protocol.ts` the RPC shape) — see Reliability section below                                                                                                             | Debugging worker-isolated plugin execution, or the sandbox build |
| `observability/`              | "Mission Control" health/observability layer: audit log, backpressure counters, circuit-breaker fleet roll-up, error fingerprinting, failure-pattern aggregation, health verdict, heartbeat/leader readers, `/now` snapshot assembly, schedule-overdue detection, periodic trend-snapshot writer | Building or debugging an admin health/observability surface      |
| `perf/`                       | Performance baseline capture + benchmarks (`baselines.json`, `*.bench.ts`) for Lua transitions, run listing, etc.                                                                                                                                                                                | Investigating a perf regression, or updating a captured baseline |
| `__testkit__/`                | Shared typed test harness for the task system                                                                                                                                                                                                                                                    | Writing a new task-system unit/integration test                  |
| `__fixtures__/`, `__tests__/` | Test-only mocks and ported cross-cutting test suites (event payload/emit coverage, etc.)                                                                                                                                                                                                         | Adding regression coverage that spans multiple modules           |

---

## Architecture overview

```
                   ┌─────────────────────────────────────┐
                   │ @sapd/lumastra-plugin-sdk                 │
                   │   defineTask        — background    │
                   │   defineProvider    — metadata      │
                   │   defineTrickplay   — playback-time │
                   │   defineWatchSync   — bidirectional │
                   │   defineFeature     — HTTP routes   │
                   │   defineIntegration — webhooks/IPC  │
                   │   + 5 more contracts (media-source,  │
                   │   subtitle/lyrics provider, auth     │
                   │   provider, external service)        │
                   └────────────────┬────────────────────┘
                                    │ registers
                                    ▼
┌──────────────────────────┐   ┌─────────────────────────────────┐
│   TaskRegistry           │   │   Postgres (source of truth)    │
│   - load + validate      │   │   - task_history (Run records)  │
│   - resolve pipeline DAG │   │   - task_quota_usage            │
│   - capability summary   │   │   - plugin_migrations           │
└────────────┬─────────────┘   │   - plugin_secrets              │
             │                 │   - plugin_settings             │
             ▼                 │   - plugin_user_credentials     │
┌──────────────────────────┐   │   - media_item_stage_state      │
│  ProviderRegistry        │◀──│   - plugin_failure_events       │
│  (metadata + trickplay)  │   │   - task_webhook_hooks          │
└──────────────────────────┘   │   - task_webhook_outbox         │
                               │   - task_circuit_state          │
┌──────────────────────────┐   │   - scheduler_state             │
│  TaskOrchestrator        │◀──│                                 │
│  (leader-per-class)      │   └─────────────────────────────────┘
│  - startRun (HTTP + IPC) │                  ▲
│  - Lua atomic transitions│                  │ recovery sweep
│  - boot reconciliation   │   ┌──────────────┴──────────────────┐
│  - circuit breaker       │   │   Valkey (hot cache, TTL'd)     │
│  - emits CloudEvents     │   │   - run state hashes (15m/1h)   │
└────────────┬─────────────┘   │   - active-count counters (TTL) │
             │                 │   - half-open probe gate (SETNX)│
             ▼                 │   - leader locks (5s/2s renew)  │
┌──────────────────────────┐   │   - identity SETNX (24h)        │
│  TaskRunner               │   │   - log buffers (LIST per run)  │
│  (one BullMQ worker per   │   │   - progress heartbeats         │
│   task, Wave 8.5 default) │   └─────────────────────────────────┘
│  - dispatch by name       │                  ▲
│  - parking transparent    │                  │
│  - heartbeat + cancel      │                  │
└──────────────────────────┘──── job pick ────┘
             │
             ▼ emits
┌─────────────────────────────────────────────────────────────────┐
│   Outbox + SSE + /metrics + /api/v1 + Admin UI                  │
│   - CloudEvents 1.0 envelope                                    │
│   - HMAC-signed webhooks with DLQ                                │
│   - Prometheus 17 metrics (bounded cardinality)                  │
│   - REST /api/v1/ endpoints                                     │
│   - Admin SSE at /api/v1/runs/stream                             │
│   - Admin UI: /admin/runs, /admin/tasks (catalog), /admin/cost  │
│                /admin/system-health, /admin/webhooks             │
└─────────────────────────────────────────────────────────────────┘
```

Note: the circuit breaker (`circuit-breaker.ts`) is DB-backed — `task_circuit_state` is the source of truth, and Valkey is only used for the half-open probe gate (a short-TTL SETNX), not as a full state mirror.

### Key component roles

**`TaskRegistry`** — Loads all 11 contract types at startup. Validates manifests via Zod (throws on invalid plugin IDs, missing `inputSchema`, cycles in `pipeline.after`). Resolves pipeline DAGs topologically. Also performs the Wave 8.5 legacy fairness-lane → physical-class rewrite (`ingest`/`bulk` → `io`, `analysis` → `cpu`) at registration time. Read-only after init.

**`TaskOrchestrator`** — One instance per resource class. Acquires Valkey leader lock `lock:orch:<class>` (5s TTL, renewed every 2s, via `leader-lock.ts`). Owns all `Run` state transitions via Lua scripts. Primary entry point for HTTP routes AND in-process services via `startRun()`. Emits CloudEvents. Handles scheduler subsystem (reads manifests with `schedule:`, claims fire via `SET NX EX` for multi-replica fairness).

**`TaskRunner`** — Since Wave 8.5 (default-on), one BullMQ Worker per task rather than one per resource class; a `budget-semaphore.ts` token gates each worker's actual concurrency against its physical-class budget. Dispatches by `job.name` → registry lookup. Builds `TaskContext` with capability gates (via `context-primitives.ts`). Writes heartbeat every `LUMASTRA_RUN_HEARTBEAT_INTERVAL_MS`. Transparent parking for pipeline children (plugin never sees `WaitingChildrenError`).

**`ProviderRegistry`** — Non-task plugins (provider/trickplay/feature/integration/media-source/subtitle/lyrics/auth-provider/external-service) loaded separately. No queue interaction; callers get a typed handle for synchronous calls.

### In-process API

All services, route handlers, and startup hooks trigger runs via:

```ts
import { orchestrator } from '$lib/server/tasks/orchestrator.js';

await orchestrator.startRun(
    'embed-metadata',
    { mediaItemId },
    {
        trigger: { kind: 'in-process', sourceRoute: 'media-lifecycle.service' },
    },
);
```

This is the canonical replacement for all direct `queue.add()` callsites.

---

## State machine

```
Run states:
    pending → active → completed
    pending → active → failed
    pending → active → cancelling → cancelled
    pending → cancelling → cancelled  (cancel-before-start)
    active  → cancelling → cancelled

Stage states (per stage within a run):
    waiting → active → completed
    waiting → active → failed
    waiting → skipped     (conditional `when:` returned false)

Invalid transitions: rejected by Lua scripts with explicit error.
```

Lua scripts in `lua/`:

| Script                      | Purpose                                                         |
| --------------------------- | --------------------------------------------------------------- |
| `transition-run.lua`        | Atomic Run state transition with HEXISTS guard + EXPIRE refresh |
| `transition-stage.lua`      | Stage-level transition                                          |
| `increment-stage.lua`       | INCR `stage:N:processed` + auto-complete on threshold           |
| `claim-run.lua`             | Owner claim with `instanceId/bootId/claimedAt`                  |
| `enqueue-with-identity.lua` | SETNX on `identity:<formula>`; returns existing runId on dup    |

The daily-run quota (`maxRunsPerDay`) is **not** a Lua/Valkey script — it lives in Postgres (`task_quota_usage`), enforced atomically inside an `INSERT ... ON CONFLICT DO UPDATE ... WHERE runs < cap` so the cap can't be bypassed by TTL'd-key eviction under memory pressure (TASK-C4). See `database/queries/task-quota.queries.ts`.

All scripts versioned with `-- @version N` header. Pinned in `lua/SCRIPT_VERSIONS.ts`. Loaded at startup via EVALSHA with EVAL fallback.

---

## Limitations

### Job input size cap

`startRun` rejects serialized task input larger than **256 KB** (UTF-8 bytes) with a permanent `TaskError`; override the cap via the `LUMASTRA_MAX_TASK_INPUT_BYTES` environment variable.

### Pipeline topology

- **Single-predecessor chains** (`A → B → C`): supported.
- **Multi-predecessor fan-in** (`A + B → C`): supported via gate-task synthesis
  in `pipeline-builder.ts`. A synthetic `__gate__<taskId>` job is inserted that
  carries all predecessors as its children; the convergent task becomes the
  gate's sole child. Authors declare `pipeline.after: ['A', 'B']` on `C` — no
  manual gate wiring needed.
- **Diamond DAGs** (one predecessor feeding multiple successors, e.g.
  `A → B, A → C, B + C → D`): **not supported**. `pipeline-builder.ts` rejects
  this at build time because BullMQ FlowProducer expects a strict tree:
  embedding the same FlowJob under two parents enqueues the predecessor
  twice. Workaround: factor the shared work into its own task that writes a
  single result, then have the convergent stage read it. Proper diamond-DAG
  support is deferred.

### Async `pipeline.when`

`pipeline.when(parentResult)` predicates must return a synchronous boolean.
Returning a `Promise` throws at evaluation time — async predicates would make
the negation always falsy and silently re-enable the skipped stage. Compute
any async data inside the stage's `execute()` and return-early there instead.

---

## Reliability & security caveats (plugin authors + operators)

- **`execute()` MUST yield to the event loop (in-process mode).** By default it
  is `await`ed in-process on a shared worker thread. A _synchronous_ busy-loop (a
  `while(true)` with no `await`) starves the heartbeat `setInterval` and BullMQ
  lock renewal for ALL runs on that worker — the wall-clock/stall watchdog can't
  fire because it too is on the blocked loop. Always `await` (yield) inside long
  loops. **Hard defense:** a CPU-heavy task can declare `isolation: 'worker'` to
  run `execute()` in a `node:worker_threads` Worker that the watchdog can
  `terminate()` even through a synchronous wedge. It is gated by
  `FEATURE_PLUGIN_WORKER_ISOLATION` (default ON; the main-thread stall watchdog
  is the cross-thread liveness probe that hard-kills a wedged worker). When the
  flag is on but the sandbox bundle (`build/sandbox-entry.js`, produced by
  `npm run build:sandbox` — part of `npm run build`) is absent (e.g. `npm run
dev`), the runner warns once and falls back to in-process so no run fails
  outright. Set `FEATURE_PLUGIN_WORKER_ISOLATION=false` to force the legacy
  in-process path. The
  worker rebuilds real worker-local `ctx.sql`/`http`/`catalog`; host-owned
  surfaces (logger/progress/spend/secrets/settings/cache/userCredentials/
  reportFailure) cross a MessagePort; `ctx.dep()`/`ctx.drain()` are unavailable
  there. Implementation: `tasks/isolation/` (`worker-host.ts` main-thread host,
  `sandbox-entry.ts` in-worker entry, `protocol.ts` the RPC message shape) +
  `scripts/build-sandbox.ts` (the worker bundle has a build-time guard that any
  externalized import must be a Node builtin or production dependency).
- **Fire-and-forget async work must `.catch()`.** An unhandled rejection from a
  `void`/`.then()` without a catch (or a timer/event callback) used to crash the
  whole process; a process-level handler now logs-and-continues (`hooks.server.ts`),
  but you should still attach `.catch()` — a swallowed rejection is a silent bug.
- **`ctx.http` and `ctx.dep().fetch()` are SSRF-hardened with DNS pinning.** Both
  funnel the actual network call through `safeFetch` (`url-safety.ts`): the URL is
  syntactically gated (`assertPublicHttpUrl` — rejects loopback/private/link-local
  IPs, non-http(s) schemes, embedded userinfo) AND every hostname is DNS-resolved
  with the connection pinned to the validated address, so an attacker controlling
  an allowlisted hostname can't rebind to a private IP between the check and the
  TCP connect. Redirects are followed manually and re-validated at every hop.
  `ctx.http` `allowedDomains` adds a per-plugin hostname allowlist on top. Every
  `ctx.http` request also carries a default 30s timeout
  (`LUMASTRA_PLUGIN_HTTP_TIMEOUT_MS`) so an unresponsive endpoint can't TCP-park a
  worker. Plugins that hit arbitrary attacker-influenced URLs still get this
  protection for free; no plugin-side address validation is required.
- **Webhook receivers must enforce the timestamp window themselves.** The HMAC
  signature header carries a timestamp and `X-Lumastra-Event-Id`; replay
  protection is the receiver's job — reject events older than your tolerance
  (~5 min) and dedupe on the event id. The sender does not enforce this.
- **Deploy with NTP.** The scheduler and watchdogs compare wall-clock across
  replicas; large clock skew can mis-fire schedules or mis-classify heartbeats.
  Static-schedule double-fires are now DB-deduped (skew-immune idempotency key),
  but keep replica clocks synchronized. Run the task keyspace under Valkey
  `noeviction` (TTL'd state keys can otherwise be evicted under memory pressure).
- **Inside `execute()`, your own stage row is `running`.** The framework sets it before the task
  body starts, so a predicate that looks for `status = 'completed'` on the task's own stage row
  matches nothing, and a freshness guard built on it never skips. Use `completed_at IS NOT NULL`
  (plus an `invalidated_at <= completed_at` check so invalidations still force a re-run). Run such
  a predicate against real rows in an integration test, including the `running` state; a mocked `sql`
  cannot show it is wrong.
- **A task that declares two or more `coversStages` records no stage transitions at all.**
  `runner.ts` wraps `execute()` with the stage recorder only for a single-stage declaration, so
  adding a second stage id to "document" it stops the first from being recorded. If a stage is
  written but must stay undeclared, add it to `UNDECLARED_BY_DESIGN_STAGE_IDS`
  (`services/health-invariants/invariants.ts`), which `stage-id-mirrors.test.ts` guards; otherwise the
  orphan-stage invariant turns the system health verdict red.
- **valkey-glide `customCommand` returns booleans for some commands.** `HEXISTS` answers `true` or
  `false`, not the RESP integer, while `EXISTS` answers a number. Compare with a helper that
  accepts both (`false`, `0` and `'0'` mean absent) and fail closed. Do not write `=== 1` on a
  `customCommand` reply.
- **Task integration tests must get Valkey through `requireClient`** (`tasks/valkey-types.ts`), the
  same coordination client the state machine writes through. Injecting the cache client splits run
  state across two instances when the task keyspace is separate.
- **`lastProgressAt` on a transcode job is not a client heartbeat.** The process runner bumps it on
  every FFmpeg progress line. Use `lastClientHeartbeatAt` (set only by client requests) to decide
  whether a viewer is still there, otherwise abandoned jobs keep encoding at full speed. Heartbeats
  can reach a pod that does not own the job, so liveness across pods goes through
  `active_transcode_jobs.last_progress_at`.

---

## Cross-links

- **Architecture reference** (long-form companion to this file — orchestrator/runner/registry, pipeline coverage, reliability, footguns): https://lumastra.org/architecture/task-system/
- **Admin UI walkthrough** (what each admin operations page surfaces): https://lumastra.org/guides/task-monitoring/
- **Debug recipes** (stuck items, zombies, queue not draining, mirror drift, etc.): https://lumastra.org/guides/task-troubleshooting/
- Full schema reference (contracts, DDL, Valkey keys, env vars): `docs/architecture/task-system-schema.md`
- Database migration guide: `docs/architecture/database-architecture.md` (2-step migration rule applies here too — see root `CLAUDE.md`)
