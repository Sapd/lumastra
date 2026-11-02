# Task System Schema Reference

**This is the schema-of-record for the Lumastra task system rewrite.**

This document is authoritative for all task-system schema decisions: contracts, tables, Valkey key shapes, and env vars. Change it in the same commit as any change to those.

See `src/lib/server/tasks/CLAUDE.md` for directory-level architecture overview.

---

## Table of Contents

1. [Plugin contracts (6-family)](#1-plugin-contracts-6-family)
2. [Shared types](#2-shared-types)
3. [Run schema and state machine](#3-run-schema-and-state-machine)
4. [Postgres schema (migration 15.0.0)](#4-postgres-schema-migration-1500)
5. [Tables to DROP](#5-tables-to-drop)
6. [No data migration](#6-no-data-migration)
7. [Valkey key schema](#7-valkey-key-schema)
8. [Resource classes](#8-resource-classes)
9. [Identity and dedup formulas](#9-identity-and-dedup-formulas)
10. [Backpressure](#10-backpressure)
11. [CloudEvents envelope and type taxonomy](#11-cloudevents-envelope-and-type-taxonomy)
12. [Observability contracts](#12-observability-contracts)
13. [Env constants](#13-env-constants)

---

## 1. Plugin contracts (6-family)

The system ships six define helpers under `@sapd/lumastra-plugin-sdk`. Each has a fundamentally different lifecycle.

### 1.1 `defineTask` — background work

Used for sync plugins, media-source scans, chunked drains. Queue-driven via BullMQ.

```ts
interface TaskDefinition<TInput = unknown, TResult = unknown> {
    // Identity
    id: string;
    name: string;
    version: string;
    processingVersion: number;
    minAppVersion: string;

    // Capability declaration (informational)
    capabilities: {
        database?: boolean;
        http?: boolean;
        ffmpeg?: boolean;
        cache?: boolean;
        dataDir?: boolean; // ffmpeg/fingerprint temp files (existed in PluginContext)
    };

    // Scheduling
    schedule?: {
        every: string;
        runOnStartup?: boolean;
        startupDelay?: string;
        envOverride?: string;
    };

    // Identity & exclusion
    identityFor: (input: TInput) => string;
    exclusiveWith?: { scope: 'global' | 'libraryGroup' | 'user'; ttl: string };

    // Multi-tenancy
    scope?: 'global' | 'libraryGroup' | 'user';

    // Resource class
    resourceClass: 'cpu' | 'io' | 'embedding' | 'maintenance';

    // External deps (rate-limited via runtime)
    externalDeps?: Array<{
        name: string;
        rps?: number;
        retryAfter?: 'header' | number;
        circuitBreaker?: { failures: number; cooldownMs: number };
    }>;

    // Retry policy
    retry?: {
        attempts: number;
        backoff: 'exponential' | number[];
        retryOn: (err: unknown) => boolean;
    };

    // Backpressure
    backpressure?: {
        onQueueDepthOver: number;
        action: 'drop' | 'fail-fast' | 'shed-oldest';
    };

    // Pipeline membership (declarative DAG)
    pipeline?: {
        of: string;
        after?: string[];
        when?: (parentResult: unknown) => boolean;
    };

    // Backlog (chunked drains)
    backlog?: {
        unitLabel: string;
        sliceSize: number;
        softBudget: string;
        idOf: (row: unknown) => string;
        stages: (ctx: TaskContext) => Promise<BacklogStage[]>;
        compute: (
            ctx: TaskContext,
            limit: number,
        ) => Promise<{ items: unknown[]; remainingHint?: number }>;
        wipe?: (ctx: TaskContext) => Promise<void>;
    };

    // Incremental processing hook (preserves current sync-plugin processItems)
    processItems?: (ctx: TaskContext, items: unknown[]) => Promise<void>;

    // Failure drilldown — backed by plugin_failure_events table
    failures?: {
        list: (
            ctx: TaskContext,
            opts: PaginationOpts,
        ) => Promise<{ items: FailedItem[]; total: number }>;
        retry?: (ctx: TaskContext, itemId: string) => Promise<void>;
    };

    // Cost accounting
    cost?: {
        kind: 'openai_tokens' | 'cpu_seconds' | 'api_calls';
    };

    // Settings UI generation — backed by plugin_settings + plugin_secrets
    settings?: {
        canToggle?: boolean;
        fields: SettingField[];
        customComponent?: string; // escape hatch — Svelte component path
    };

    // Input validation — MANDATORY
    inputSchema: z.ZodSchema<TInput>;

    // Quotas
    quotas?: {
        maxRunsPerDay?: number;
        maxRunsPerTenant?: number;
        maxConcurrent?: number;
        costBudgetMonthly?: number;
    };

    // Retention
    retention?: {
        policy: 'standard' | 'audit' | 'forensic' | 'ephemeral';
        days?: number;
    };

    // Timeout
    timeout?: { hard: string; soft: string };

    // Lifecycle
    lifecycle?: {
        resumeOnInterrupt?: false | SyncResumeManifest; // opt-out per current contract
        onStartup?: (ctx: TaskContext) => Promise<void>;
        onShutdown?: () => Promise<void>;
        onConfigChange?: (ctx: TaskContext, newConfig: unknown) => Promise<void>;
    };

    // Plugin schema migrations
    migrations?: PluginMigration[];

    // v2 placeholders (parsed not enforced)
    isolation?: 'inline' | 'worker';
    scopes?: string[];

    execute: (ctx: TaskContext<TInput>) => Promise<TaskResult<TResult>>;
}

interface SyncResumeManifest {
    defaultMode: 'catchup' | 'manual' | 'force';
    requiresInput?: boolean;
}

export function defineTask<I, R>(def: TaskDefinition<I, R>): TaskDefinition<I, R>;
```

### 1.2 `defineProvider` — metadata provider

Replaces `MetadataProviderPlugin`. Called synchronously from RAG / metadata-enrichment pipelines. Not queue-driven.

```ts
interface ProviderDefinition<TParams, TItem> {
    id: string;
    name: string;
    version: string;
    capabilities: { http?: boolean; cache?: boolean; database?: boolean };
    rateLimit?: { rps: number; circuitBreaker?: CircuitBreakerCfg };

    // Lifecycle: queries during user requests, not BullMQ jobs
    isConfigured(ctx: PluginContext): Promise<boolean>;
    search(ctx: PluginContext, params: TParams): Promise<TItem[]>;
    detail(ctx: PluginContext, id: string): Promise<TItem>;
    childList?(ctx: PluginContext, parentId: string): Promise<TItem[]>;

    // Settings (same shape as defineTask.settings)
    settings?: SettingsConfig;
}
```

### 1.3 `defineTrickplayProvider` — playback-time thumbnail strips

Latency-critical, not queue-driven. Called from the trickplay HTTP handler with a <100ms budget.

```ts
interface TrickplayProviderDefinition {
    id: string;
    capabilities: { http?: boolean; cache?: boolean };

    // Called from the trickplay HTTP handler with <100ms budget
    fetchParams(
        ctx: PluginContext,
        params: { mediaItemId: string; width: number },
    ): Promise<TrickplayParams | null>;

    settings?: SettingsConfig;
}
```

### 1.4 `defineWatchSync` — bidirectional watch state

Runs both as queue tasks (background sync via `defineTask` underneath) and as immediate-push callables (`enqueueImmediateWatchSyncPush`). Auto-registers two underlying `defineTask`: `<id>-push` and `<id>-pull`.

```ts
interface WatchSyncDefinition {
    id: string;
    capabilities: { http?: boolean; database?: boolean };

    push(ctx: PluginContext, event: WatchEvent): Promise<void>;
    pull(ctx: PluginContext, since: Date): Promise<WatchEvent[]>;
    resolveIds(ctx: PluginContext, externalIds: string[]): Promise<IdMap>;

    settings?: SettingsConfig;
    // Auto-registers two underlying defineTask: <id>-push and <id>-pull
}
```

### 1.5 `defineFeature` — HTTP route registration

Routes mount at startup. Not queue-driven.

```ts
interface FeatureDefinition {
    id: string;
    routes: FeatureRoute[];
    settings?: SettingsConfig;
    onStartup?(ctx: PluginContext): Promise<void>;
}
```

### 1.6 `defineIntegration` — webhook receivers / external dispatchers

Sonarr/Radarr/Jellyseerr webhooks and notification dispatchers. Has both inbound and outbound surfaces.

```ts
interface IntegrationDefinition {
    id: string;
    capabilities: { http?: boolean; database?: boolean };

    handleWebhook?(ctx: PluginContext, payload: unknown): Promise<unknown>;
    sendNotification?(ctx: PluginContext, event: NotificationEvent): Promise<void>;

    settings?: SettingsConfig;
}
```

---

## 2. Shared types

```ts
// Context for execute() in defineTask
interface TaskContext<TInput = unknown> {
    readonly runId: string;
    readonly parentRunId?: string;
    readonly attemptNumber: number;
    readonly input: TInput;
    readonly scope: { libraryGroupId?: string; userId?: string };
    readonly mode: 'scheduled' | 'manual' | 'pipeline-child' | 'resume';

    readonly sql: postgres.Sql;
    readonly logger: Logger;
    readonly signal: AbortSignal;
    readonly abortSignal: AbortSignal;

    readonly http?: HttpClient;
    readonly cache?: NamespacedCache;
    readonly ffmpeg?: FfmpegRunner;
    readonly dataDir?: string; // temp dir, plugin-scoped

    dep(name: string): RateLimitedFetch;
    settings(): Promise<Record<string, unknown>>;
    readonly secrets: {
        get(key: string): Promise<string>;
        getUser(userId: string, key: string): Promise<string>; // OAuth tokens (MAL/Trakt)
    };

    reportProgress(processed: number, total?: number, currentItem?: string): void;
    reportFailure(itemId: string, reason: string, meta?: object): Promise<void>;
    spend(kind: string, units: number): void;
    drain(opts?: { mode?: DrainMode }): Promise<DrainResult>;
}

// Lighter context for non-task plugins (provider, trickplay, feature, integration)
interface PluginContext {
    readonly sql: postgres.Sql;
    readonly logger: Logger;
    readonly http?: HttpClient;
    readonly cache?: NamespacedCache;
    readonly dataDir?: string;
    settings(): Promise<Record<string, unknown>>;
    readonly secrets: {
        get(key: string): Promise<string>;
        getUser(userId: string, key: string): Promise<string>;
    };
}

interface TaskResult<R = unknown> {
    success: boolean;
    itemsProcessed?: number;
    result?: R;
    downstream?: Array<{ taskId: string; input: unknown }>;
    stopReason?: 'drained' | 'budget' | 'no-progress' | 'aborted' | 'single-slice';
}
```

---

## 3. Run schema and state machine

### 3.1 Run schema (wire/storage)

```ts
const RunSchema = z.object({
    id: z.string(), // 'run_<ulid>'
    taskId: z.string(),
    parentRunId: z.string().optional(),
    label: z.string(),

    state: z.enum(['pending', 'active', 'cancelling', 'completed', 'failed', 'cancelled']),

    input: z.unknown(), // canonical input (replay-capable)
    scope: z
        .object({
            libraryGroupId: z.string().optional(),
            userId: z.string().optional(),
        })
        .optional(),

    trigger: z.object({
        kind: z.enum(['scheduled', 'manual', 'pipeline-child', 'resume', 'webhook', 'in-process']),
        by: z.string().optional(),
        sourceRoute: z.string().optional(), // for in-process callers
    }),

    startedAt: z.string().datetime(),
    completedAt: z.string().datetime().optional(),
    heartbeatAt: z.string().datetime().optional(),

    stages: z.array(
        z.object({
            id: z.string(),
            label: z.string(),
            state: z.enum(['waiting', 'active', 'completed', 'failed', 'skipped']),
            processed: z.number().int().nonnegative().optional(),
            total: z.number().int().nonnegative().optional(),
            currentItem: z.string().optional(),
            startedAt: z.string().datetime().optional(),
            completedAt: z.string().datetime().optional(),
            etaMs: z.number().finite().nonnegative().optional(),
        }),
    ),

    result: z.unknown().optional(),
    error: z
        .object({
            message: z.string(),
            kind: z.enum(['transient', 'permanent', 'fatal']).optional(),
            stack: z.string().optional(),
        })
        .optional(),

    costBreakdown: z.record(z.number()).optional(),
    ownerInstanceId: z.string().optional(),
    actor: z.object({
        type: z.enum(['user', 'service', 'system', 'webhook']),
        id: z.string().optional(),
        via: z.enum(['ui', 'pat', 'cron', 'webhook', 'in-process']).optional(),
    }),
});
```

### 3.2 State machine

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

---

## 4. Postgres schema (migration 15.0.0)

Migration file: `migrations/15.0.0_task_system_redesign.ts`. Must be registered in `migrate-schema.ts MIGRATIONS` array (2-step rule).

```sql
-- Primary run table (replaces task_history + task_history_dead_letter + task_history_dead_letter_archive)
CREATE TABLE task_history (
    id              TEXT PRIMARY KEY,           -- 'run_<ulid>'
    task_id         TEXT NOT NULL,
    parent_run_id   TEXT,
    label           TEXT NOT NULL,
    state           TEXT NOT NULL CHECK (state IN
        ('pending','active','cancelling','completed','failed','cancelled')),

    input           JSONB NOT NULL,
    scope           JSONB,
    trigger         JSONB NOT NULL,
    actor           JSONB NOT NULL,             -- v2 authz placeholder

    -- Multi-tenancy
    tenant_id       UUID,

    -- Lifecycle timing
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at    TIMESTAMPTZ,
    heartbeat_at    TIMESTAMPTZ,
    duration_ms     INTEGER GENERATED ALWAYS AS
        (EXTRACT(EPOCH FROM (completed_at - started_at))*1000)::INTEGER STORED,

    -- Cost + provenance
    cost_units      NUMERIC(12,4),
    cost_kind       TEXT,
    cost_breakdown  JSONB,
    processing_version TEXT NOT NULL,
    owner_instance_id TEXT,
    audit_chain_hash TEXT,

    -- Retention
    retention_policy TEXT NOT NULL DEFAULT 'standard',
    retain_until    TIMESTAMPTZ,

    -- Stages denormalized
    stages          JSONB NOT NULL DEFAULT '[]',

    -- Result + error
    result          JSONB,
    error           JSONB,

    -- Optional cluster context
    events_during_run JSONB
);

-- Indexes
CREATE INDEX idx_task_history_state ON task_history(state)
    WHERE state IN ('pending','active','cancelling');
CREATE INDEX idx_task_history_task_completed ON task_history(task_id, completed_at DESC)
    WHERE duration_ms IS NOT NULL;
CREATE INDEX idx_task_history_parent ON task_history(parent_run_id)
    WHERE parent_run_id IS NOT NULL;
CREATE INDEX idx_task_history_tenant ON task_history(tenant_id, started_at DESC)
    WHERE tenant_id IS NOT NULL;
CREATE INDEX idx_task_history_retain ON task_history(retain_until)
    WHERE retain_until IS NOT NULL;
CREATE INDEX idx_task_history_heartbeat ON task_history(state, heartbeat_at)
    WHERE state = 'active';

-- Archive (cold tier)
CREATE TABLE task_history_archive (LIKE task_history INCLUDING ALL);
CREATE INDEX ... (same indexes)

-- Quota counters (rolled up from Valkey)
CREATE TABLE task_quota_usage (
    task_id     TEXT NOT NULL,
    tenant_id   UUID,
    day         DATE NOT NULL,
    runs        INTEGER NOT NULL DEFAULT 0,
    cost_units  NUMERIC(12,4) NOT NULL DEFAULT 0,
    PRIMARY KEY (task_id, tenant_id, day)
);

-- Plugin schema versioning
CREATE TABLE plugin_migrations (
    plugin_id    TEXT NOT NULL,
    version      INTEGER NOT NULL,
    applied_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (plugin_id, version)
);

-- Per-plugin secrets (AES-GCM via LUMASTRA_MASTER_KEY)
CREATE TABLE plugin_secrets (
    plugin_id    TEXT NOT NULL,
    key          TEXT NOT NULL,
    value_encrypted BYTEA NOT NULL,
    encryption_version INTEGER NOT NULL DEFAULT 1,  -- for key rotation
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    last_accessed_at TIMESTAMPTZ,
    PRIMARY KEY (plugin_id, key)
);

-- Per-user OAuth tokens (MAL, Trakt — replaces plugin_user_credentials)
CREATE TABLE plugin_user_credentials (
    plugin_id    TEXT NOT NULL,
    user_id      TEXT NOT NULL,
    key          TEXT NOT NULL,
    value_encrypted BYTEA NOT NULL,
    encryption_version INTEGER NOT NULL DEFAULT 1,
    expires_at   TIMESTAMPTZ,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    last_accessed_at TIMESTAMPTZ,
    PRIMARY KEY (plugin_id, user_id, key)
);

-- Plugin settings (non-secret, replaces task_settings — same shape)
CREATE TABLE plugin_settings (
    plugin_id    TEXT NOT NULL,
    key          TEXT NOT NULL,
    value        JSONB NOT NULL,
    updated_at   TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (plugin_id, key)
);

-- Plugin analysis tracking (preserves plugin_analysis_log — backlog "already analyzed" state)
CREATE TABLE plugin_analysis_log (
    plugin_id    TEXT NOT NULL,
    media_id     UUID NOT NULL,
    processing_version INTEGER NOT NULL,
    analyzed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (plugin_id, media_id)
);
CREATE INDEX idx_plugin_analysis_lookup
    ON plugin_analysis_log(plugin_id, processing_version, analyzed_at);

-- Plugin failure events (preserves plugin_failure_events — for failures.list)
CREATE TABLE plugin_failure_events (
    id           BIGSERIAL PRIMARY KEY,
    plugin_id    TEXT NOT NULL,
    item_id      TEXT NOT NULL,
    run_id       TEXT,
    reason       TEXT NOT NULL,
    meta         JSONB,
    occurred_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at  TIMESTAMPTZ
);
CREATE INDEX idx_failure_events_lookup
    ON plugin_failure_events(plugin_id, occurred_at DESC)
    WHERE resolved_at IS NULL;

-- Secret access audit
CREATE TABLE plugin_secret_access_log (
    id           BIGSERIAL PRIMARY KEY,
    plugin_id    TEXT NOT NULL,
    key          TEXT NOT NULL,
    user_id      TEXT,                          -- for getUser() calls
    run_id       TEXT,
    accessed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Webhook subscriptions
CREATE TABLE task_webhook_hooks (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    url          TEXT NOT NULL,
    secret_encrypted BYTEA NOT NULL,
    event_filter JSONB NOT NULL,
    task_filter  JSONB,
    library_group_filter JSONB,
    headers      JSONB,
    active       BOOLEAN NOT NULL DEFAULT true,
    include_progress BOOLEAN NOT NULL DEFAULT false,
    created_by   TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-user notification endpoints (migration 16.192.0). A SEPARATE table from
-- task_webhook_hooks on purpose: operator hooks are filter-driven and attributed
-- to an actor username (GDPR-anonymized), a user hook is the subject's own data
-- (GDPR-deleted) and has no filters. Both share the outbox below and therefore
-- the same backoff / HMAC / DLQ; nothing else.
CREATE TABLE user_notification_webhooks (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    url              TEXT NOT NULL,
    secret_encrypted BYTEA NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE task_webhook_outbox (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Exactly one of hook_id / user_hook_id is set (see the CHECK below).
    hook_id          UUID REFERENCES task_webhook_hooks(id) ON DELETE CASCADE,
    user_hook_id     UUID REFERENCES user_notification_webhooks(id) ON DELETE CASCADE,
    CONSTRAINT task_webhook_outbox_one_owner
        CHECK (num_nonnulls(hook_id, user_hook_id) = 1),
    event_id         TEXT NOT NULL,
    payload          JSONB NOT NULL,
    attempts         INTEGER NOT NULL DEFAULT 0,
    next_attempt_at  TIMESTAMPTZ NOT NULL,
    delivered_at     TIMESTAMPTZ,
    last_status      INTEGER,
    last_error       TEXT,
    dead             BOOLEAN NOT NULL DEFAULT false,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Per-hook uniqueness so the same event can fan out to multiple
    -- subscribers without one row hijacking the global key.
    UNIQUE (hook_id, event_id)
);
-- NULLs are distinct in a unique index, so the constraint above does NOT
-- constrain user-owned rows (their hook_id is NULL). This is its mirror.
CREATE UNIQUE INDEX task_webhook_outbox_user_hook_event_uniq
    ON task_webhook_outbox (user_hook_id, event_id)
    WHERE user_hook_id IS NOT NULL;
CREATE INDEX idx_outbox_pending
    ON task_webhook_outbox(next_attempt_at)
    WHERE delivered_at IS NULL AND dead = false;
```

### Webhook signing & verification contract

Delivery worker (`src/lib/server/tasks/webhook-outbox.ts`) and the admin
test endpoint (`src/routes/api/v1/webhooks/[id]/test/+server.ts`) share a
single signing helper in `src/lib/server/tasks/webhook-signature.ts`.

Header format:

```
X-Lumastra-Signature: t=<unix-seconds>,v1=<hex-hmac-sha256>
```

Receivers MUST:

1. Parse `t=` and `v1=` from the header.
2. Reject requests where `|now - t| > 300` seconds (±5-minute replay window).
3. Compute `expected = HMAC_SHA256(secret, "${t}.${rawBody}").hex` using the
   raw request body — re-serializing JSON breaks the signature.
4. Compare `v1` to `expected` using a **constant-time** comparison
   (`crypto.timingSafeEqual` in Node, `hmac.compare_digest` in Python).
   Plain `===` leaks timing.

Hook cache invalidation: admin POST/DELETE on `/api/v1/webhooks` publishes
to `task:webhook-hooks:invalidate`. Every `WebhookOutbox` subscribes on
start and drops its in-memory cache. A 60-second TTL fallback bounds drift
when pubsub is unavailable.

```sql

-- Circuit breaker
CREATE TABLE task_circuit_state (
    task_id      TEXT PRIMARY KEY,
    state        TEXT NOT NULL CHECK (state IN ('closed','open','half_open')),
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    failure_rate_window_count INTEGER NOT NULL DEFAULT 0,
    failure_rate_window_started_at TIMESTAMPTZ,
    opened_at    TIMESTAMPTZ,
    opened_reason TEXT,
    next_probe_at TIMESTAMPTZ,
    manual_override TEXT,
    override_by  TEXT,
    override_at  TIMESTAMPTZ
);

-- Scheduler "last fired at" persistence
CREATE TABLE scheduler_state (
    task_id      TEXT PRIMARY KEY,
    last_fired_at TIMESTAMPTZ,
    next_fire_at TIMESTAMPTZ NOT NULL,
    paused       BOOLEAN NOT NULL DEFAULT false,
    paused_by    TEXT,
    paused_at    TIMESTAMPTZ
);
```

---

## 5. Tables to DROP

In the same transaction as migration 15.0.0. No data preservation — project is unreleased.

```sql
-- Old task-system tables (drop, no migration)
DROP TABLE task_history;
DROP TABLE task_history_dead_letter;
DROP TABLE task_history_dead_letter_archive;
DROP TABLE task_settings;

-- Old plugin tables (drop, recreate with new schema)
DROP TABLE plugin_failure_events;
DROP TABLE plugin_analysis_log;
DROP TABLE plugin_user_credentials;
```

Then recreate from §4 above with clean schemas.

---

## 6. No data migration

Unreleased project — no users — no historic data worth preserving. Drop-and-recreate is the migration strategy. The `pg_dump` from the pre-cutover backup exists only for rollback, not forward data movement.

This eliminates: PK type-change ceremony, intermediate rename steps, data-copy queries, partial-rollback fallbacks.

---

## 7. Valkey key schema

All orchestrator keys live under `task:*` prefix. They are explicitly excluded from the `unified-cache.ts` cache namespace registry. Add this comment to `src/lib/server/cache/namespaces.ts`:

```ts
// EXCLUDED FROM CACHE NAMESPACE: task:* keys are owned by TaskOrchestrator.
// Do NOT register these in CACHE_NAMESPACES. "Clear All Caches" admin
// action MUST NOT touch this prefix.
```

| Key pattern                        | Type                  | TTL                  | Purpose                                                             | Writer                      |
| ---------------------------------- | --------------------- | -------------------- | ------------------------------------------------------------------- | --------------------------- |
| `task:run:active:<runId>`          | hash                  | 15min (refreshed)    | Live run state                                                      | Orchestrator only (via Lua) |
| `task:run:terminal:<runId>`        | hash                  | 1h                   | Cancel/retry UI window                                              | Orchestrator on terminal    |
| `task:identity:<formula>`          | string (SETNX)        | 24h                  | Dedup key                                                           | `enqueue-with-identity.lua` |
| `task:circuit:<taskId>`            | hash                  | 7d                   | Mirrored circuit state                                              | Orchestrator after DB write |
| `lock:orch:<class>`                | string (SET NX EX 5)  | 5s, renewed every 2s | Per-class leader                                                    | Orchestrator candidate      |
| `lock:orch:coordinator`            | string (SET NX EX 5)  | 5s, renewed every 2s | Coordinator (reconciler + event dispatcher + media-added notifier)  | Orchestrator candidate      |
| `lock:scheduler:<taskId>:<bucket>` | string (SET NX EX 30) | 30s                  | Scheduler fire claim                                                | Each replica's scheduler    |
| `task:events:<class>`              | pubsub                | —                    | Per-class SSE channel                                               | Orchestrator                |
| `task:events:meta`                 | pubsub                | —                    | Orchestrator self-observability                                     | Orchestrator                |
| `task:active:index`                | hash                  | none                 | Snapshot index (top 100)                                            | Orchestrator via Lua        |
| `task:log:<runId>`                 | LIST                  | 24h                  | Live log buffer per run                                             | Runner via task-log mirror  |
| `task:cancel:<runId>`              | pubsub                | —                    | Cancel signal per run                                               | Orchestrator                |
| `task:run:interrupted:<runId>`     | string                | 6h                   | A resumable manual run stopped by a graceful shutdown (resume gate) | Runner on shutdown abort    |
| `task:run:checkpoint:<rootRunId>`  | string (JSON, ≤64 KB) | 7d                   | `ctx.checkpoint` of a resume chain                                  | Runner (`ctx.checkpoint`)   |

### Cutover housekeeping

At migration time, flush legacy keys:

```bash
# Run as part of cutover playbook
valkey-cli --scan --pattern "v1:run-group:*" | xargs valkey-cli DEL
valkey-cli --scan --pattern "v1:scan-group:*" | xargs valkey-cli DEL
valkey-cli --scan --pattern "v1:file-scanner:watcher-heartbeat" | xargs valkey-cli DEL
valkey-cli --scan --pattern "v1:keyframe-probe-progress:*" | xargs valkey-cli DEL
valkey-cli DEL "lumastra:active-worker-count"
valkey-cli DEL "cluster:transition-detector"   # cluster-heartbeat re-creates if needed
```

---

## 8. Resource classes

Replace 6 BullMQ queues with 4 resource classes.

| Class         | Concurrency (env-overridable)                           | Backpressure cap | Tasks                                                                                               |
| ------------- | ------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------- |
| `cpu`         | auto: `floor(cores/2)` 1–6 (`LUMASTRA_CONCURRENCY_CPU`) | 500              | trickplay, intro-analyzer, ffmpeg, fingerprint                                                      |
| `io`          | 4 (`LUMASTRA_CONCURRENCY_IO`)                           | 2000             | file-scan, image-sync, watch-sync-push/pull, sync plugins                                           |
| `embedding`   | 2 (`LUMASTRA_CONCURRENCY_EMBEDDING`)                    | 10000            | library-embeddings, discovery-embeddings, music-embedding                                           |
| `maintenance` | 3 (`LUMASTRA_CONCURRENCY_MAINTENANCE`)                  | 100              | cache-cleanup, oauth-cleanup, task-history-cleanup, telemetry-cleanup, music-transcode-cache-reaper |

**Priority bands (per-queue, BullMQ native):**

- `admin = 1`
- `scheduler = 5`
- `downstream = 7`

**Admin-reserved slots:** 1 of N concurrency slots per class reserved for `priority <= 2` jobs.

**Fair-share across `libraryGroupId`:** Round-robin pop cursor in `task:rr-cursor:<class>`. Starvation watchdog: any waiting job >5min jumps queue.

**Per-task concurrency cap:** `task.quotas.maxConcurrent` enforced via Lua counter `task:active-count:<taskId>` in addition to class slot.

---

## 9. Identity and dedup formulas

One mechanism: BullMQ `opts.jobId` = `${task.id}::${task.identityFor(input)}`. BullMQ rejects duplicates atomically.

```ts
defineTask({
    id: 'file-system-scan',
    identityFor: (input) => `${input.libraryGroupId ?? 'all'}`,
    // jobId = 'file-system-scan::all' or 'file-system-scan::<uuid>'
});
```

For cross-time dedup (not just concurrent): `task:identity:<formula>` SETNX with TTL via `enqueue-with-identity.lua`.

Implementation lives in `src/lib/server/tasks/identity.ts` (`computeIdentity()`).

---

## 10. Backpressure

```ts
defineTask({ backpressure: { onQueueDepthOver: 1000, action: 'fail-fast' } });
```

Orchestrator enqueue path checks queue depth across `waiting + prioritized + delayed`. On overflow:

- `'fail-fast'`: throw `BackpressureError`, caller decides (HTTP 503 with `Retry-After`, in-process services log + skip)
- `'drop'`: return `{ runId: null, dropped: true }`
- `'shed-oldest'`: remove waiting jobs with `priority >= 7` (downstream only); never sheds scheduler or admin

Prometheus gauge `lumastra_task_queue_depth` per class. Admin UI red bar at 80% of cap.

Implementation: `src/lib/server/tasks/backpressure.ts`

---

## 11. CloudEvents envelope and type taxonomy

### 11.1 Envelope

```json
{
    "specversion": "1.0",
    "id": "01HXYZ...ULID",
    "source": "lumastra://task-orchestrator/{instanceId}",
    "type": "org.lumastra.task.run.completed",
    "subject": "{taskId}/{runId}",
    "time": "2026-05-13T10:00:00.000Z",
    "datacontenttype": "application/json",
    "dataschema": "urn:lumastra:schema:v1:task-run",
    "data": {/* Run fields */}
}
```

### 11.2 Type taxonomy

- `org.lumastra.task.run.started`
- `org.lumastra.task.run.completed`
- `org.lumastra.task.run.failed`
- `org.lumastra.task.run.cancelled`
- `org.lumastra.task.run.stage.completed`
- `org.lumastra.task.cost.threshold.exceeded` (v2 reserved)

Implementation: `src/lib/server/tasks/cloud-events.ts`

---

## 12. Observability contracts

### 12.1 Log streaming (replaces `task-log-buffer.ts`)

Per-run live log contract:

- Valkey LIST `task:log:<runId>` (LPUSH new entries, LTRIM to 1000)
- Per-run pubsub channel `task:log-stream:<runId>` for SSE consumers
- Each log entry: `{ts, level, message, meta?}` JSON
- TTL 24h on the LIST
- Byte caps: per-line 4KB, per-run 4MB; exceeded → `[truncated:N more bytes]` marker
- SSE endpoint: `GET /api/v1/runs/{runId}/logs?since=<last-event-id>` returns NDJSON stream with `Last-Event-ID` reconnect support

Implementation: `src/lib/server/tasks/log-buffer.ts`

### 12.2 Progress contract (replaces `progress-updater.ts`)

Plugin calls `ctx.reportProgress(processed, total?, currentItem?)`:

- Throttled: minimum 250ms between writes (coalesced)
- Heartbeat: forced write every 30s even if values unchanged
- High-watermark: `total` only ever increases (refuses decreases unless `total === 0`)
- Stall detection: if no progress event for 2min while plugin running → reconciler marks `failed`

Implementation: `src/lib/server/tasks/progress.ts`

### 12.3 Cost ledger keys

`ctx.spend(kind, units)` accumulates in-memory; written to `task_history.cost_breakdown` JSONB on terminal. Daily rollup to `task_quota_usage`. Admin UI: `/admin/cost`.

Implementation: `src/lib/server/tasks/cost-ledger.ts`

### 12.4 Self-observability events

Orchestrator emits to `task:events:meta` pubsub:

- `subscription-lost` — QueueEvents disconnected
- `lua-rejected` — invalid transition attempted
- `transition-conflict` — concurrent transition lost race
- `recovery-reclaimed` — boot recovery marked N runs failed
- `quota-exceeded` — task hit cap
- `circuit-opened` — task auto-quarantined
- `pending-write-backlog` — Postgres unreachable, queue depth

Admin UI surface: `/admin/system-health` tab.

### 12.5 SSE reconnect protocol

Admin SSE endpoint (`/api/v1/runs/stream`):

- Server emits `id: <monotonic>` per frame
- Replay buffer: 200 most-recent frames in memory
- Client reconnects with `Last-Event-ID: <id>` → server replays missing
- Coalescing: progress events coalesced at 250ms window per run; lifecycle events flush immediately
- Snapshot endpoint cached at 1s per replica; one BullMQ scan / sec regardless of session count

---

## 13. Env constants

**Project rule:** Every `LUMASTRA_*` env var requires a getter in `src/lib/server/config.ts` AND an entry in `src/lib/config/schema.ts`. All vars below must be registered in the same commit that introduces the task system.

```ts
// src/lib/server/config.ts additions
// cpu default is auto-sized to the effective (cgroup-aware) CPU budget:
// floor(cores/2) clamped 1–6. See utils/cpu-budget.ts + schema.ts dynamicDefault.
export const LUMASTRA_CONCURRENCY_CPU = getInt(
    'LUMASTRA_CONCURRENCY_CPU',
    cpuClassConcurrencyDefault(getCpuBudgetCores()),
);
export const LUMASTRA_CONCURRENCY_IO = getInt('LUMASTRA_CONCURRENCY_IO', 4);
export const LUMASTRA_CONCURRENCY_EMBEDDING = getInt('LUMASTRA_CONCURRENCY_EMBEDDING', 2);
export const LUMASTRA_CONCURRENCY_MAINTENANCE = getInt('LUMASTRA_CONCURRENCY_MAINTENANCE', 3);

export const LUMASTRA_QUEUE_DEPTH_CAP_CPU = getInt('LUMASTRA_QUEUE_DEPTH_CAP_CPU', 500);
export const LUMASTRA_QUEUE_DEPTH_CAP_IO = getInt('LUMASTRA_QUEUE_DEPTH_CAP_IO', 2000);
export const LUMASTRA_QUEUE_DEPTH_CAP_EMBEDDING = getInt(
    'LUMASTRA_QUEUE_DEPTH_CAP_EMBEDDING',
    10000,
);
export const LUMASTRA_QUEUE_DEPTH_CAP_MAINTENANCE = getInt(
    'LUMASTRA_QUEUE_DEPTH_CAP_MAINTENANCE',
    100,
);

export const LUMASTRA_ORCHESTRATOR_LEADER_TTL_MS = getInt(
    'LUMASTRA_ORCHESTRATOR_LEADER_TTL_MS',
    5000,
);
export const LUMASTRA_ORCHESTRATOR_LEADER_RENEW_MS = getInt(
    'LUMASTRA_ORCHESTRATOR_LEADER_RENEW_MS',
    2000,
);
export const LUMASTRA_TRANSITION_BATCH_WINDOW_MS = getInt(
    'LUMASTRA_TRANSITION_BATCH_WINDOW_MS',
    50,
);
export const LUMASTRA_TRANSITION_BATCH_MAX = getInt('LUMASTRA_TRANSITION_BATCH_MAX', 200);

export const LUMASTRA_RUN_STATE_TTL_ACTIVE_MS = getInt('LUMASTRA_RUN_STATE_TTL_ACTIVE_MS', 900_000);
export const LUMASTRA_RUN_STATE_TTL_TERMINAL_MS = getInt(
    'LUMASTRA_RUN_STATE_TTL_TERMINAL_MS',
    3_600_000,
);
export const LUMASTRA_RUN_HEARTBEAT_INTERVAL_MS = getInt(
    'LUMASTRA_RUN_HEARTBEAT_INTERVAL_MS',
    30_000,
);

export const LUMASTRA_TASK_HISTORY_HOT_DAYS = getInt('LUMASTRA_TASK_HISTORY_HOT_DAYS', 30);

export const LUMASTRA_WEBHOOK_RETRY_ATTEMPTS = getInt('LUMASTRA_WEBHOOK_RETRY_ATTEMPTS', 8);
export const LUMASTRA_WEBHOOK_DELIVERY_CONCURRENCY = getInt(
    'LUMASTRA_WEBHOOK_DELIVERY_CONCURRENCY',
    16,
);

export const LUMASTRA_CIRCUIT_FAILURE_THRESHOLD = getInt('LUMASTRA_CIRCUIT_FAILURE_THRESHOLD', 5);
export const LUMASTRA_CIRCUIT_FAILURE_RATE_WINDOW_MS = getInt(
    'LUMASTRA_CIRCUIT_FAILURE_RATE_WINDOW_MS',
    1_800_000,
);
export const LUMASTRA_CIRCUIT_FORCE_ENABLE_TTL_MS = getInt(
    'LUMASTRA_CIRCUIT_FORCE_ENABLE_TTL_MS',
    86_400_000,
);

export const LUMASTRA_METRICS_BEARER_TOKEN = getString('LUMASTRA_METRICS_BEARER_TOKEN', '');
export const LUMASTRA_MASTER_KEY = getString('LUMASTRA_MASTER_KEY', ''); // required for plugin_secrets

// Per-plugin interval overrides (existing env vars, but need first-time config.ts + schema entries)
export const SYNC_TMDB_METADATA_INTERVAL = getString('SYNC_TMDB_METADATA_INTERVAL', '24h');
export const SYNC_MDBLIST_INTERVAL = getString('SYNC_MDBLIST_INTERVAL', '24h');
export const SYNC_FRIBB_ANIME_INTERVAL = getString('SYNC_FRIBB_ANIME_INTERVAL', '7d');
export const SYNC_MAL_ANIME_ID_ENRICHMENT_INTERVAL = getString(
    'SYNC_MAL_ANIME_ID_ENRICHMENT_INTERVAL',
    '24h',
);
export const SYNC_TRICKPLAY_PARAMS_INTERVAL = getString('SYNC_TRICKPLAY_PARAMS_INTERVAL', '12h');
export const SYNC_WATCH_SYNC_PULL_INTERVAL = getString('SYNC_WATCH_SYNC_PULL_INTERVAL', '15m');
export const SYNC_WATCH_SYNC_PUSH_INTERVAL = getString('SYNC_WATCH_SYNC_PUSH_INTERVAL', '5m');
export const SYNC_CURATED_LISTS_INTERVAL = getString('SYNC_CURATED_LISTS_INTERVAL', '24h');
export const SYNC_MUSIC_ANALYSIS_INTERVAL = getString('SYNC_MUSIC_ANALYSIS_INTERVAL', '6h');
export const SYNC_MUSIC_POPULARITY_INTERVAL = getString('SYNC_MUSIC_POPULARITY_INTERVAL', '24h');

// Replaces PLUGIN_FAILURE_EVENT_AGE_DAYS
export const LUMASTRA_FAILURE_EVENT_RETENTION_DAYS = getInt(
    'LUMASTRA_FAILURE_EVENT_RETENTION_DAYS',
    90,
);
```

Each gets a corresponding entry in `src/lib/config/schema.ts` with `.describe()` for the admin UI.

**Security note:** `LUMASTRA_MASTER_KEY` must NOT be included in `config.ts:mirrorToProcessEnv` persistence — explicit exclusion required in code + comment.
