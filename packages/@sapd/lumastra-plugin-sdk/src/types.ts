// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: Apache-2.0

import type postgres from 'postgres';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Primitive aliases
// ---------------------------------------------------------------------------

/**
 * Plugin contract ABI. Bump ONLY when a change to the contracts in this file
 * would break a plugin compiled against the previous number — a removed or
 * renamed `PluginContext` / `TaskContext` surface, a changed `defineX` shape, a
 * new required field on a definition.
 *
 * A signed plugin manifest declares the ABI it was built for. The host refuses
 * to install or load a plugin whose ABI is not this one, which is the whole
 * point: a plugin built in 2026 must fail with a readable message on a 2028
 * host rather than with a TypeError at first call, from inside third-party code
 * the operator cannot debug.
 *
 * A manifest with no `sdkAbi` is treated as ABI 1 (it predates the field).
 */
export const PLUGIN_SDK_ABI = 1;

export type ResourceClass =
    'cpu' | 'io' | 'embedding' | 'maintenance' | 'ingest' | 'bulk' | 'analysis' | 'discovery';

export const RESOURCE_CLASSES: readonly ResourceClass[] = [
    'cpu',
    'io',
    'embedding',
    'maintenance',
    // Fast-path file ingest pool — kept lightly loaded so new files (probe,
    // keyframes, integrity-scan, image-sync, chapter-sync, file-library-scan
    // batches) drain promptly even when `io` is saturated by long-running
    // metadata syncs. Without isolation, a wedged series-sync run can hold
    // every io slot and starve the user-visible "new file just arrived"
    // path — observed on preprod as a 6.5 h series-sync stuck on TMDB
    // pinning 1 of 4 io workers while 1606 ingest-class jobs queued.
    'ingest',
    // Mass-enrichment pool — TMDB / mdblist / popularity / enrichment scans
    // over large libraries. Lower concurrency than ingest because each unit
    // is API-bound and the pool's goal is "make steady progress" rather
    // than "stay responsive".
    'bulk',
    // Long-running audio/video analysis (chromaprint fingerprinting for
    // skip-intro / outro detection). Isolated from `cpu` because both tasks
    // are ffmpeg-heavy and would otherwise contend with trickplay-generation
    // — observed on preprod as 450+ trickplay jobs blocking intro-analyzer
    // for 30+ hours when they shared the `cpu` pool with FIFO scheduling.
    // Even with intro priority=3, BullMQ's strict-priority popper would
    // give intro 100% of cpu slots until its backlog drained, starving
    // trickplay completely in the other direction. Separate class delivers
    // true fairness with no per-task priority engineering.
    'analysis',
    // Discovery/catalog embedding backfill (`discovery-embeddings`). Isolated
    // from `embedding` so the large, low-priority catalog backfill — which runs
    // back-to-back for hours over a 10k+ item discovery flood — can NEVER starve
    // the user's own library embeddings (`library-embeddings`, `music-embedding-
    // generation`) that share the `embedding` budget. Observed on a fresh
    // Windows install: discovery-embeddings held the cap=1 `embedding` slot
    // continuously and library embeddings sat `pending` indefinitely
    // (coverage frozen 0/2); pausing discovery drained library in ~40s.
    'discovery',
] as const;

/**
 * Cost categories accepted by `ctx.spend(kind, units)`.
 *
 * The runtime aggregates spend into `Run.costBreakdown` keyed by this exact
 * union. Adding a new kind requires updating the cost-ledger consumers and
 * any admin UI that displays per-kind totals. Misspellings like
 * `'openai_token'` (singular) used to silently accumulate into a separate
 * bucket — the union narrowing on `ctx.spend()` prevents that at compile time.
 */
export type CostKind =
    | 'openai_tokens'
    | 'cpu_seconds'
    | 'api_calls'
    // Per-host external request volume, e.g. `api_calls:api.themoviedb.org`.
    // These accompany the bare `api_calls` total and are persisted in
    // `Run.costBreakdown` for the admin Usage & Cost page's domain breakdown.
    // They are intentionally NOT emitted to Prometheus (writeCostBreakdown
    // filters to the bare COST_KINDS below) to keep label cardinality bounded.
    | `api_calls:${string}`
    // Per-host failed external calls (4xx, 5xx, no response; includes 429) and
    // the rate-limited subset (HTTP 429). Written by the runtime's API-call
    // wrapper, like `api_calls:<host>`; DB-only, never emitted to Prometheus.
    | `api_errors:${string}`
    | `api_429:${string}`;

/**
 * The bare, fixed cost kinds — the ones emitted to Prometheus as `cost_unit`
 * labels. The open-ended per-host namespaces (`api_calls:<host>`,
 * `api_errors:<host>`, `api_429:<host>`) are deliberately excluded here
 * (bounded-cardinality Prometheus surface) but still accepted by the cost
 * ledger and persisted to the DB breakdown.
 */
export const COST_KINDS: readonly Exclude<
    CostKind,
    `api_calls:${string}` | `api_errors:${string}` | `api_429:${string}`
>[] = ['openai_tokens', 'cpu_seconds', 'api_calls'] as const;

/**
 * Discriminator for how a run was started. Mirrors `Run.trigger.kind` and is
 * the single source of truth for `TaskContext.mode` — keep this union in sync
 * with `TriggerSchema` below.
 */
export type TriggerKind =
    'scheduled' | 'manual' | 'pipeline-child' | 'resume' | 'webhook' | 'in-process';

export const TRIGGER_KINDS: readonly TriggerKind[] = [
    'scheduled',
    'manual',
    'pipeline-child',
    'resume',
    'webhook',
    'in-process',
] as const;

export type DrainMode = 'catchup' | 'manual' | 'force';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export interface Logger {
    info(msg: string, meta?: object): void;
    warn(msg: string, meta?: object): void;
    error(msg: string, meta?: object): void;
    debug(msg: string, meta?: object): void;
    child(bindings: Record<string, unknown>): Logger;
}

// ---------------------------------------------------------------------------
// Capability types
// ---------------------------------------------------------------------------

export interface RateLimitedFetch {
    fetch: typeof fetch;
}

export interface HttpClient {
    get(url: string, opts?: RequestInit): Promise<Response>;
    post(url: string, body: unknown, opts?: RequestInit): Promise<Response>;
}

export interface NamespacedCache {
    get<T>(key: string): Promise<T | null>;
    set<T>(key: string, value: T, ttlMs?: number): Promise<void>;
    del(key: string): Promise<void>;
}

/**
 * NOT EXPOSED TO PLUGINS.
 *
 * `ctx.ffmpeg` and `ctx.dataDir` were declared on the context but never
 * implemented — the host handed back a stub that threw on first use, and a
 * temp-directory path that did not exist. A contract member that always fails
 * is worse than an absent one, so both are gone from the context rather than
 * left as a promise an author only discovers is empty at runtime.
 *
 * The `ffmpeg` and `dataDir` CAPABILITY FLAGS remain: builtin tasks declare
 * them as a truthful disclosure of what they do, and the trust model treats
 * every capability as a disclosure rather than a grant.
 *
 * This type is retained for the host's internal transcode helpers.
 */
export interface FfmpegRunner {
    run(args: string[]): Promise<{ stdout: string; stderr: string; code: number }>;
}

// ---------------------------------------------------------------------------
// Backlog + drain
// ---------------------------------------------------------------------------

export interface BacklogStage {
    id: string;
    label: string;
    count: number;
}

// ---------------------------------------------------------------------------
// Dynamic schedule (DB-row-driven firing)
// ---------------------------------------------------------------------------

/**
 * One row returned from a `dynamicSchedule.loader`. The loader is responsible
 * for parsing the row's cron/interval and including the row in its result only
 * if it is due NOW. The host fires one `startRun(task.id, input, ...)` per
 * returned entry, deduplicated via `rowId + bucket` so multi-replica sweeps
 * collapse to a single run per cycle.
 */
export interface DynamicScheduleEntry<TInput = unknown> {
    /**
     * Stable identifier for the row (e.g. `livetv_sources.id`). Combined with
     * `bucket` to form the idempotency key.
     */
    rowId: string;

    /**
     * Bucket label that identifies "the current cron cycle" for this row.
     * Two sweeps that observe the same `rowId + bucket` collapse to a single
     * run. Typically `Math.floor(now / intervalMs).toString()`.
     */
    bucket: string;

    /**
     * Per-row input passed to the task's `execute(ctx)` via `ctx.input`.
     */
    input: TInput;
}

/**
 * Context handed to a `dynamicSchedule.loader`. The loader has SQL + a logger
 * + the current wall-clock time + an abort signal so it can short-circuit
 * during shutdown.
 */
export interface DynamicScheduleContext {
    sql: postgres.Sql;
    logger: Logger;
    signal: AbortSignal;
    now: Date;
}

export interface DrainResult {
    processed: number;
    remaining: number;
    stopReason: 'drained' | 'budget' | 'no-progress' | 'aborted' | 'single-slice' | 'skipped';
}

// ---------------------------------------------------------------------------
// Failed items + pagination
// ---------------------------------------------------------------------------

export interface FailedItem {
    id: string;
    label: string;
    reason: string;
    detectedAt: string | null;
    subtitle?: string;
    firstSeen?: string;
    failureCount?: number;
    lastSeen?: string;
    /** Run id the failure was recorded against. Stamped by the runtime when
     * `ctx.reportFailure(...)` flushes to the audit table. */
    taskRunId?: string;
}

export interface PaginationOpts {
    limit: number;
    offset: number;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface SettingField {
    key: string;
    label: string;
    type:
        'string' | 'number' | 'boolean' | 'secret' | 'select' | 'array' | 'multiline' | 'keyvalue';
    description?: string;
    required?: boolean;
    default?: unknown;
    options?: Array<{ value: string; label: string }>;
    /**
     * Optional input validation hints surfaced to the admin UI. Host-side
     * code may also enforce these on PATCH; clients render appropriate
     * input constraints.
     */
    validation?: {
        min?: number;
        max?: number;
        pattern?: string; // RFC-flavour regex (string form for serialisability)
    };
    /**
     * Fine-tuning knob most operators never need. The admin UI folds these
     * under an "Advanced" disclosure below the everyday settings, so a task
     * with twenty tuning parameters does not open as a twenty-field wall.
     */
    advanced?: boolean;
    /**
     * Key of a `boolean` field in the same settings block. The admin UI shows
     * this field only while that one is on (e.g. AI options under an
     * "Enable AI" switch), so an operator is never asked to tune something
     * that currently does nothing.
     */
    dependsOn?: string;
    /**
     * `array` fields only: the value is a list of user group names. The admin
     * UI offers a picker of known groups instead of a free-text list.
     */
    groups?: boolean;
}

export interface SettingsConfig {
    fields: SettingField[];
    customComponent?: string;
}

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

export interface CircuitBreakerCfg {
    failures: number;
    cooldownMs: number;
}

// ---------------------------------------------------------------------------
// Plugin migration
// ---------------------------------------------------------------------------

export interface PluginMigration {
    version: number;
    up(sql: postgres.Sql): Promise<void>;
}

// ---------------------------------------------------------------------------
// SyncResumeManifest
// ---------------------------------------------------------------------------

export interface SyncResumeManifest {
    defaultMode: 'catchup' | 'manual' | 'force';
    requiresInput?: boolean;
}

// ---------------------------------------------------------------------------
// Watch sync auxiliary types
// ---------------------------------------------------------------------------

export interface WatchEvent {
    externalId: string;
    mediaType: string;
    watchedAt: Date;
    progress?: number;
}

export type IdMap = Map<string, string>;

/**
 * An item to be resolved to a provider-specific ID before syncing.
 */
export interface WatchSyncResolveItem {
    /** Internal UUID of the media item */
    mediaId: string;
    /** Media type (e.g., 'movie', 'episode') */
    mediaType: string;
    /** TMDB ID for resolution */
    tmdbId: string | null;
    /** IMDB ID for resolution */
    imdbId: string | null;
    /** Season number (for episodes) */
    seasonNumber?: number;
    /** Episode number (for episodes) */
    episodeNumber?: number;
    /** Title of the media item */
    title?: string;
    /** TMDB ID of the parent series (for episodes) */
    seriesTmdbId?: string;
}

/**
 * Result of resolving a single item to a provider ID.
 * Only successfully resolved items are returned (providerId is always non-null).
 */
export interface WatchSyncResolvedId {
    /** Internal UUID */
    mediaId: string;
    /** Provider-specific ID (e.g., Jellyfin item ID, Trakt slug) */
    providerId: string;
}

/**
 * A watch state change to push to the provider.
 */
export interface WatchStateChange {
    /** ISO timestamp of the latest queued decisive event, for upstream arbitration. */
    occurredAt?: string;
    /** The provider's ID for this item */
    providerId: string;
    /** Internal UUID of the media item */
    mediaId: string;
    /**
     * The Lumastra `users.id` UUID — NOT a username, despite the field name,
     * which is kept for cross-package compatibility.
     *
     * The engine has populated this from `user_media_events.user_id` since
     * `26b502ae4`. A connector that resolves it as a display name silently
     * matches nothing and drains every item as "no link for this user" — read
     * as a dead integration, not an error. That is exactly what happened to the
     * AudiobookShelf connector, which was written against the previous wording
     * here. Resolve it by id.
     */
    username: string;
    /** Whether the item has been watched */
    isWatched: boolean;
    /** Playback position in milliseconds */
    resumePositionMs: number;
    /** Total runtime in milliseconds */
    runtimeMs: number;
    /** Number of times the item has been watched */
    watchCount: number;
}

/**
 * A resume position update to push to the provider without changing watched state.
 */
export interface ResumePositionItem {
    /** The provider's ID for this item */
    providerId: string;
    /** Internal UUID of the media item */
    mediaId: string;
    /**
     * The Lumastra `users.id` UUID — NOT a username. See the identical field on
     * {@link WatchStateChange} for why the name is misleading and what it costs
     * to resolve it as a display name.
     */
    username: string;
    /** Playback position in milliseconds */
    resumePositionMs: number;
    /**
     * When the user last moved this position in Lumastra (ISO 8601). Optional
     * (backward compatible): a connector that ignores it behaves exactly as
     * before.
     *
     * A connector whose upstream also stamps its own last-played time can compare
     * the two and decline to overwrite a position that was set there AFTER this
     * one: the newest stop wins, whichever side's export runs first. Report such
     * an item as a non-terminal failure (never `drainedAsSkipped`); the pull
     * imports the newer upstream position and the retry then succeeds.
     */
    eventAt?: string;
    /**
     * Newest upstream stop for this item that a previous import already brought
     * in (ISO 8601), or null when none. Only set together with `eventAt`, and
     * only for users whose import runs. Upstream time later than this is news the
     * import has not seen: hold the item back (a non-terminal failure, so it is
     * retried after the import) rather than overwrite it. Upstream time at or
     * before it was already imported and is safe to write over, whatever the two
     * hosts' clocks say.
     */
    importedAt?: string | null;
    /**
     * Total runtime in milliseconds, when known. Optional (backward
     * compatible): a connector that ignores it behaves exactly as before.
     *
     * Exists for the same reason {@link WatchStateChange.runtimeMs} does — a
     * connector whose upstream ties `duration` to whether it can mark an item
     * finished (AudiobookShelf) needs it to avoid creating a progress row
     * with `duration: 0`, which silently blocks that item from ever
     * completing. Zero or unknown must be treated as "omit", never sent as a
     * literal 0 — that would overwrite a good upstream duration.
     */
    runtimeMs?: number;
}

/**
 * Per-(user, media) success record. Used by the engine to mark the
 * exact set of lumastra-* events as pushed for the right user — a bare
 * mediaId is ambiguous in shared libraries where two users may own the
 * same media row, since the plugin can succeed for one and fail for the
 * other.
 */
export interface WatchSyncPushSuccess {
    /** Lumastra username (matches `WatchStateChange.username`). */
    username: string;
    /** Internal Lumastra media UUID (matches `WatchStateChange.mediaId`). */
    mediaId: string;
}

/**
 * Per-item push failure record. Optional (backward compatible): plugins that
 * don't populate it fall back to the flat `failed` count + `errors` array.
 * When present, the engine prefers it so it can attribute an error and a
 * retry-vs-gave-up verdict to a specific (user, media) pair.
 */
export interface WatchSyncPushFailure {
    /** Lumastra username (matches `WatchStateChange.username`). */
    username: string;
    /** Internal Lumastra media UUID (matches `WatchStateChange.mediaId`). */
    mediaId: string;
    /** Human-readable failure reason. Keep under ~500 chars. */
    error: string;
    /** true = terminal (won't retry); false = transient (retried next cycle). */
    terminal: boolean;
    /**
     * true = a deliberate, benign hold (for example "upstream holds a newer
     * position; retry after the import"), not a fault. The engine retries it like
     * any transient failure but records it quietly: no error entry, no failure
     * count, no failed activity row.
     */
    deferred?: boolean;
}

/**
 * Batch result of pushing watch state to the provider.
 *
 * Plugins must distinguish terminal failures (drain from queue) from
 * transient failures (retry next cycle):
 *
 * - **Terminal**: resolution failure (no provider user, no external_id,
 *   404 not-found). The item will never succeed without a code/data
 *   change, so leaving it queued head-of-line-blocks newer items.
 *   Report in `skipped` and add the (username, mediaId) pair to
 *   `drainedAsSkipped` so the engine marks the backing events pushed.
 *
 * - **Transient**: network error, 5xx, parse error. The item may
 *   succeed next cycle. Report in `failed` / `errors`. The engine
 *   leaves the events un-pushed for retry.
 */
export interface WatchSyncPushResult {
    /** Number of items successfully pushed */
    succeeded: number;
    /** Number of items that failed to push (transient — retry next cycle) */
    failed: number;
    /**
     * Number of items the plugin terminally drained without a successful
     * push (e.g. 404 not-found, missing provider user, missing external
     * ID). Pair each one with a `drainedAsSkipped` entry so the engine
     * marks the backing events pushed and the row stops blocking newer
     * work.
     */
    skipped: number;
    /** Provider IDs that returned 404 (stale — will be re-resolved next cycle) */
    staleIds: string[];
    /** Error messages for failed items */
    errors: string[];
    /**
     * (username, mediaId) pairs whose push call returned success. The
     * push engine uses these pairs to mark the corresponding lumastra-*
     * events as pushed for the right user. Items absent from this list
     * (transient failures, unresolved IDs without a terminal verdict)
     * stay un-pushed and the next cycle retries them.
     *
     * NB: keyed by (user, media) — not media alone — because a shared
     * library can have two users dirty on the same internal UUID, and
     * the plugin can succeed for one user while failing for the other.
     */
    successful: WatchSyncPushSuccess[];
    /**
     * (username, mediaId) pairs the plugin terminally drained without a
     * successful push (404, missing user, no external ID). The engine
     * marks the backing events pushed for these — same plumbing as
     * `successful` — so they stop coming back every cycle. Counted
     * separately from `successful` so admin UI can distinguish "delivered"
     * from "given up on".
     */
    drainedAsSkipped: WatchSyncPushSuccess[];
    /**
     * Optional per-item failures. When populated, each entry attributes an
     * error + terminal verdict to a specific (username, mediaId). Transient
     * entries (terminal=false) stay queued for retry; terminal entries were
     * given up on. The engine uses this only for reporting — draining is still
     * driven by `drainedAsSkipped`.
     */
    failedItems?: WatchSyncPushFailure[];
}

/**
 * A watch state item pulled from the provider.
 */
export interface WatchStatePullItem {
    /**
     * Pre-resolved internal Lumastra media UUID. When set, the engine skips
     * its own resolution strategies (TMDB ID, provider ID cache, episode
     * drill-down) and uses this directly. Plugins set this when they can
     * determine the Lumastra UUID themselves — e.g. MAL pull reverse-lookups
     * via `media_external_groupings` to map a MAL list entry to multiple
     * episode UUIDs that have no individual external IDs.
     */
    internalMediaId?: string;
    /** Provider-specific ID */
    providerId: string;
    /** TMDB ID if available from the provider */
    tmdbId: string | null;
    /** IMDB ID if available from the provider */
    imdbId: string | null;
    /** Media type as reported by the provider */
    mediaType: string;
    /** Whether the item has been watched on the provider */
    isWatched: boolean;
    /** Playback position in milliseconds */
    resumePositionMs: number;
    /** Total runtime in milliseconds */
    runtimeMs: number;
    /** Number of times the item has been watched */
    watchCount: number;
    /** Provider username — used to map back to a Lumastra username */
    providerUsername: string;
    /** Season number (for episodes) */
    seasonNumber?: number;
    /** Episode number (for episodes) */
    episodeNumber?: number;
    /** Series TMDB ID (for episodes — used to find parent series in DB) */
    seriesTmdbId?: string;
    /** Item title (for logging unresolved items) */
    title?: string;
    /**
     * Parent series title (episodes only) — carried through from the
     * provider pull so the activity feed can show "<Series> · <Episode>"
     * instead of a bare episode title. Undefined/omitted for non-episode
     * items or providers that don't expose it.
     */
    seriesTitle?: string;
    /**
     * When the item was last played on the provider, if known.
     * Threaded into the upsert so pulls don't clobber last_watched_at with NOW().
     */
    lastWatchedAt?: Date | null;
    /**
     * When the item was first played on the provider, if known.
     * Threaded into the upsert so the first pull doesn't stamp today's date
     * over a long-lived provider history.
     */
    firstWatchedAt?: Date | null;
    /**
     * True when this row comes from an active provider playback session
     * rather than a persisted played/resume list. Used to preserve live
     * rewatches near EOF instead of auto-completing them back to watched.
     *
     * NB: this asserts the row is the provider's FRESHEST truth (Jellyfin
     * builds it from the live session list, which leads its persisted resume
     * data). It therefore still contributes a `progress` event. If instead the
     * position is a STALE checkpoint that must not be applied, use
     * {@link freezePosition} — the two are independent.
     */
    isActiveSession?: boolean;

    /**
     * True when the position in this row must NOT be applied because some other
     * device is authoritative for it right now.
     *
     * The engine appends no `progress` event for such an item, so its stored
     * position is left exactly as-is. Decisive state (`isWatched`) still
     * applies — "finished" is a fact the provider may assert mid-session.
     *
     * Distinct from {@link isActiveSession} on purpose. That flag means "this IS
     * the live truth"; this one means "the live truth is elsewhere, what I'm
     * handing you is a stale checkpoint". AudiobookShelf needs the latter: it
     * persists a session's position server-side only periodically, so a 5-minute
     * pull would otherwise yank a listener back to the last checkpoint. Guarding
     * cannot be done inside a plugin — by the time the engine appends the event
     * the plugin is no longer in the call path.
     *
     * Optional and defaulting false, so providers that never set it are
     * unaffected.
     */
    freezePosition?: boolean;
}

/**
 * Optional inputs to a pull cycle. Plugins that don't honour cursors
 * silently ignore them and pull everything; the engine then persists
 * no new cursor for that user and the next cycle is again a full pull.
 */
export interface WatchSyncPullOptions {
    signal?: AbortSignal;
    /**
     * Per-Lumastra-user-id cursor of the newest item we've already imported.
     * Plugins should short-circuit pagination at this date
     * to keep each cycle's cost proportional to new activity rather
     * than total history. Missing entries mean "do a full pull for
     * this user."
     */
    cursors?: Map<string, string>;

    /**
     * Canonical Lumastra identity keys that have a matching local account.
     * Jellyfin keys are lowercased provider login names; same-name providers
     * use trimmed, NFC-normalized, lowercased Lumastra usernames. The
     * engine resolves provider users to Lumastra users by username and discards
     * items from provider users with no Lumastra account *after* the pull. On a
     * multi-user provider, plugins SHOULD skip fetching the (potentially large)
     * watch history of accounts NOT in this set — otherwise every provider
     * account's full history is fetched every cycle only to be thrown away,
     * which can starve the pull on a busy server. Undefined → pull all users
     * (back-compat; also used as a safety fallback when the set can't be
     * resolved).
     */
    knownUsernames?: ReadonlySet<string>;

    /** Restrict the pull to these lumastra user-ids only (per-user Import + pull
     *  direction gating). Absent ⇒ all linked users (current behavior). */
    onlyUserIds?: string[];
    /** Incremental progress callback for long pulls (manual Import UI). */
    onProgress?(p: PullProgress): void;
}

/**
 * Incremental progress reported by a long-running pull cycle (e.g. manual
 * per-user Import in the admin UI).
 */
export interface PullProgress {
    processed: number;
    total?: number;
    currentUser?: string;
}

/**
 * Result of pulling watch state from the provider.
 */
export interface WatchSyncPullResult {
    /** Items pulled from the provider */
    items: WatchStatePullItem[];
    /** Error messages if any part of the pull failed */
    errors: string[];
    /**
     * Per-(provider username) newest LastPlayedDate observed during
     * this pull. The engine persists these only for users whose
     * imports succeeded, so a partial-failure user retries from the
     * old cursor next cycle. Plugins that don't track per-user
     * cursors omit this and the engine leaves cursors unchanged.
     */
    newCursors?: Map<string, string>;
    /**
     * Provider usernames the plugin skipped BEFORE fetching their history
     * because `knownUsernames` had no Lumastra match for them. Their items
     * are never in `items`, so the engine counts them from this list.
     * Plugins without a pre-fetch filter omit it.
     */
    skippedUsernames?: string[];
}

// ---------------------------------------------------------------------------
// Feature route
// ---------------------------------------------------------------------------

export interface FeatureRoute {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    /** Path with optional `:name` segments, e.g. `/messages/:id`. */
    path: string;
    /**
     * Handler. `params` carries the values matched from `:name` segments in
     * `path` (e.g. `{ id }` for `/messages/:id`); empty object for static paths.
     *
     * The host only enforces that SOME user is authenticated (401 for none)
     * before calling this — unlike {@link FeaturePage.access}, there is no
     * host-enforced `access` gate here. Anything finer (admin-only, group-
     * restricted, per-resource ownership) is the plugin author's own job:
     * check `ctx.user` inside the handler before doing anything sensitive.
     */
    handler: (
        ctx: PluginContext,
        req: Request,
        params: Record<string, string>,
    ) => Promise<Response>;
}

// ---------------------------------------------------------------------------
// Notification event
// ---------------------------------------------------------------------------

export interface NotificationEvent {
    type: string;
    payload: unknown;
}

// ---------------------------------------------------------------------------
// Trickplay auxiliary
// ---------------------------------------------------------------------------

export interface TrickplayParams {
    url: string;
    tileWidth: number;
    tileHeight: number;
    interval: number;
    columns: number;
    rows: number;
    /**
     * Total number of thumbnails available across every sprite sheet for
     * this item — NOT `columns * rows` (that's one sheet's tile capacity).
     * Optional for back-compat with older/external providers; callers that
     * omit it fall back to the single-sheet capacity, which understates the
     * real count for any item spanning more than one sheet.
     */
    thumbnailCount?: number;
    /**
     * Pixel height of one thumbnail in the sprite sheet. It follows the
     * source's aspect ratio (240 for 4:3 at width 320, 134 for 2.39:1).
     * Optional for back-compat; callers that omit it get a 16:9 guess, which
     * puts every row offset in the wrong place for any other aspect ratio.
     */
    thumbnailHeight?: number;
}

// ---------------------------------------------------------------------------
// Pipeline coverage — stage declarations on TaskDefinition
// ---------------------------------------------------------------------------

/**
 * The subset of media types that pipeline-coverage stages can apply to.
 * Narrower than `MediaType` — excludes exotic/legacy types that the coverage
 * tracking system does not model.
 */
export type SdkMediaType = 'movie' | 'series' | 'season' | 'episode' | 'album' | 'artist' | 'track';

/**
 * Typed pipeline event taxonomy. A stage declares interest in events it
 * cares about via `invalidatedBy: ['file.attached', 'file.contentChanged']`
 * (or the legacy `['file-content']` for backwards compatibility).
 *
 * Adding a new event:
 *   1. Add the literal to this union (and to PIPELINE_EVENT_NAMES below).
 *   2. Wire the runtime emit site (DB trigger or lifecycle service).
 *   3. External plugins recompile against the new SDK and can opt-in.
 */
export type PipelineEventName =
    | 'item.created'
    | 'item.reclaimed'
    | 'item.dismissed'
    | 'item.deleted'
    | 'file.attached'
    | 'file.detached'
    | 'file.contentChanged'
    | 'file.defaultChanged'
    | 'file.windowChanged'
    | 'file.probed'
    | 'identity.assigned'
    | 'identity.changed'
    | 'identity.cleared'
    | 'metadata.changed'
    | 'media.becamePlayable';

export const PIPELINE_EVENT_NAMES: readonly PipelineEventName[] = [
    'item.created',
    'item.reclaimed',
    'item.dismissed',
    'item.deleted',
    'file.attached',
    'file.detached',
    'file.contentChanged',
    'file.defaultChanged',
    'file.windowChanged',
    'file.probed',
    'identity.assigned',
    'identity.changed',
    'identity.cleared',
    'metadata.changed',
    'media.becamePlayable',
] as const;

/**
 * Retry behaviour for a single stage when it reaches `failed_transient`.
 * All fields are optional; the runtime applies its own defaults when absent.
 */
export interface StageRetryPolicy {
    maxAttempts?: number;
    backoff?: 'exponential' | 'fixed';
    initialDelayMs?: number;
    maxDelayMs?: number;
    skipTransientAfterMs?: number;
}

/**
 * Read-only snapshot of a media item passed to stage eligibility predicates.
 */
export interface MediaItemSnapshot {
    readonly id: string;
    readonly media_type: SdkMediaType;
    readonly has_audio: boolean;
    readonly has_video: boolean;
    /**
     * True iff the item has at least one row in `media_file_items`. Stages
     * that strictly need a local file (probe, trickplay, intro-analyzer)
     * should short-circuit their eligibility predicate on `!has_file` so a
     * file-less item is seeded as `skipped_permanent` instead of waiting
     * forever. When a file is later attached, the `file.attached` event
     * re-runs the predicate.
     */
    readonly has_file: boolean;
    readonly runtime_seconds: number | null;
    readonly provider_tmdb_id: number | null;
    readonly provider_imdb_id: string | null;
    readonly provider_musicbrainz_id: string | null;
    readonly added_at: Date;
}

/**
 * Type-only handle for a parameterised SQL fragment, used by the
 * `kind:'predicate'` terminal disposition's `excludes` field.
 *
 * **Why `postgres.PendingQuery`, type-only:** this SDK is a *types-only*
 * contract (see memory `project_plugin_sdk_types_only` — the SDK must never
 * import a runtime, otherwise external plugins hit `ERR_MODULE_NOT_FOUND` at
 * load). `postgres` here is a `import type` only (line 1), so naming
 * `postgres.PendingQuery` pulls in NO runtime dependency — it is purely a type
 * reference. The fragment *value* is produced by the **host** application's
 * `sql` template tag (postgres.js) and embedded back into the framework's
 * canonical bulk-drain UPDATE via `${fragment}`.
 *
 * **Why this alias and not a weak `{ strings; parameters }` structural shape:**
 * the host's `sql\`…\`` template tag returns `postgres.PendingQuery<Row[]>`,
 * which shares NO properties with a hand-rolled `{ strings?; parameters? }`
 * surface — so the builder's return value was rejected at every call site. The
 * real driver type is the only thing assignable from `sql\`…\``. A plain string
 * is also (correctly) rejected by this type — it is not a `PendingQuery` — so
 * the injection-guard intent is preserved.
 *
 * External plugins cannot construct a valid value here (they have no host
 * `sql`); those authors use `kind:'self-terminal'` instead — see
 * {@link StageTerminalDisposition}.
 */
export type StageDispositionFragment = postgres.PendingQuery<postgres.Row[]>;

/**
 * Builder for a `kind:'predicate'` disposition's `excludes` fragment.
 *
 * **Why a builder, not a bare fragment value:** `terminalDisposition` is a
 * *static* property on `coversStages`, evaluated when the task module loads
 * (inside `defineTask`). The host `sql` template tag is NOT available at module
 * load — `getDb()`/`getTaskDb()` are lazy and return `null` before the pool is
 * initialised. So the author hands the framework a function; the framework
 * calls it with its OWN `sql` (the connection the disposition runs on) at drain
 * time. This matches the codebase's fragment-builder idiom
 * (`buildMetadataLateralJoinFragment(sql)` etc.) and avoids any module-load /
 * connection-init ordering hazard. `sql` is typed `postgres.Sql` (type-only in
 * the SDK — no runtime import).
 */
export type StageDispositionFragmentBuilder = (sql: postgres.Sql) => StageDispositionFragment;

/**
 * Minimal context handed to a {@link StageTerminalDisposition} `global-guard`
 * at drain time. Type-only: the host constructs the concrete value (its real
 * `sql` connection + a scoped logger) when `stage-sweep` evaluates the guard.
 *
 * Intentionally narrow — a guard answers a single global yes/no question
 * ("is this integration configured / authed?") and should not need the full
 * `TaskContext`. Kept to the two surfaces a cheap guard query needs.
 */
export interface StageGuardContext {
    /** Host database handle (postgres.js). Use for the guard's probe query. */
    readonly sql: postgres.Sql;
    /** Scoped logger for diagnostics emitted by the guard. */
    readonly logger: Logger;
}

/**
 * Declares how the framework disposes a coverage row the task will NOT
 * advance to `completed` this cycle. Exactly one disposition variant is
 * required on every `enqueueable` stage (enforced — warn-only during the
 * phased rollout, fail-closed once every stage declares one). The
 * framework — not the task — applies the resulting terminal status. This
 * closes the "wedge" class: a `pending` row can no longer survive a drain
 * cycle undecided.
 */
export type StageTerminalDisposition =
    /**
     * (a) The exclusion rule is a SQL-expressible predicate over the item.
     *
     * The framework runs it as the bulk-drain `UPDATE` that today lives
     * hand-written in each task's `execute()`. `disposeAs` chooses the
     * terminal status applied to every row the candidate query excludes.
     * This is the SQL counterpart of `eligibilityPredicate` — same intent,
     * different (drain-time, JOIN-capable) evaluation site.
     */
    | {
          kind: 'predicate';
          /**
           * Stable id for diffing this rule against the generated wedge-guard
           * invariant fixture and for audit logs. Kebab-case, unique within
           * the stage.
           */
          ruleId: string;
          /**
           * Terminal status applied to rows the candidate query excludes:
           * - `'skipped_permanent'` — ineligible until an invalidation event
           *   fires (`next_eligible_at` cleared to NULL).
           * - `'skipped_transient'` — ineligible for now; retries after
           *   `retryAfterMs` (`next_eligible_at = now() + retryAfterMs`).
           * - `'completed'` — already satisfied by other means (no further
           *   work needed).
           */
          disposeAs: 'skipped_permanent' | 'skipped_transient' | 'completed';
          /** `skipped_reason` written to the row (audit / Ingest Map surface). */
          reason: string;
          /**
           * REQUIRED when `disposeAs === 'skipped_transient'`: backoff (ms)
           * before the row becomes sweep-eligible again. Ignored for the
           * permanent / completed variants.
           */
          retryAfterMs?: number;
          /**
           * SQL fragment naming the *ineligibility* condition — i.e. the
           * NEGATION of the candidate query's precondition. Given aliases
           * `mi` (media_items) and `s` (media_item_stage_state), it returns
           * the rows that should be disposed. Authored as a builder
           * `(sql) => sql\`…\`` (parameterised host fragment, NOT raw string
           * interpolation) — see {@link StageDispositionFragmentBuilder} for why
           * it is a function. The framework calls it with its own `sql` and
           * wraps the result in the canonical:
           * ```
           *   UPDATE media_item_stage_state s ... FROM media_items mi
           *    WHERE mi.id = s.media_item_id
           *      AND s.stage_id = <id>
           *      AND s.status IN (<sweepable statuses>)
           *      AND <excludes fragment>
           * ```
           */
          excludes: StageDispositionFragmentBuilder;
          /**
           * OPTIONAL readiness gate against the cold-start race where a
           * terminal skip is evaluated against a half-populated file-linkage
           * view (fresh large install: scan/probe still attaching files when
           * the sweep runs this disposition → mass-tombstone of items that
           * WOULD be eligible once linkage settles). When set, the framework
           * AND-composes a "source files are QUIET" condition into the
           * disposition UPDATE: the row is disposed only once the relevant file
           * set has stopped changing for `windowMs` (freshest of
           * `created_at` / `file_mtime` / `updated_at` is older than the
           * window) OR has no files at all (→ disposed immediately, terminal is
           * correct). While files are still arriving the row simply falls
           * through and stays sweepable, re-evaluated free every sweep tick.
           *
           * `scope` selects whose files gate the skip:
           *   - `'self'`   — files linked directly to this media_item (`mi`).
           *   - `'parent'` — files linked to ANY item sharing `mi.parent_id`
           *                  (e.g. every episode of a season, for
           *                  season-aggregate predicates such as the
           *                  intro-analyzer's "season has no analyzable
           *                  episodes" rule).
           *
           * Use it ONLY for skips whose precondition reads upstream-populated
           * data. Do NOT use it for skips on immutable attributes (e.g.
           * `season_number = 0` specials) — those should terminalize
           * immediately regardless of scan freshness.
           */
          requiresQuietUpstream?: { windowMs: number; scope: 'self' | 'parent' };
          /**
           * OPTIONAL: suppress this terminal skip until the named upstream
           * stage has reached a terminal status for the SAME item. Guards a
           * disposition that races a slow feeder — e.g. mal-anime-id-enrichment
           * disposing 'not-anime' ~60s after seed while its fribb-anime-sync
           * feeder runs on a 48h schedule. The framework AND-composes
           * "an upstream `media_item_stage_state` row for `<stageId>` exists for
           * this item AND its status IN ('completed','skipped_permanent',
           * 'failed_permanent')" into the disposition UPDATE, so the skip can't
           * fire until the feeder has actually run. Pair with a
           * `sqlEligibilityMirror` on the stage so the row still recovers if the
           * feeder later makes it eligible.
           */
          requiresUpstreamRun?: string;
      }
    /**
     * (b) The task GUARANTEES it writes a terminal status for every candidate
     * it is handed — including no-match / no-data / no-provider outcomes.
     *
     * Used by tasks whose candidate query is identical to the sweep selector
     * (no extra, JOIN-only precondition). Registration always passes; the
     * framework enforces the guarantee at *runtime* via wedge-guard
     * Invariant 2, which converts a silent infinite wedge into a bounded,
     * alerted one. Prefer `kind:'predicate'` whenever the exclusion can be
     * expressed in SQL.
     */
    | {
          kind: 'self-terminal';
          /** Stable id for audit logs and the wedge-guard invariant. */
          ruleId: string;
      }
    /**
     * (c) The precondition is GLOBAL, not per-item — e.g. "no MAL auth
     * linked", "integration not configured".
     *
     * The framework calls `guard(ctx)` once per stage per drain cycle; on
     * `false` it drains the whole stage to `skipped_transient`
     * (via `markAllPendingSkippedTransientForStage`), on `true` it proceeds
     * normally. The long `retryAfterMs` prevents the sweep from spamming a
     * still-unconfigured task.
     */
    | {
          kind: 'global-guard';
          /** Stable id for audit logs and the wedge-guard invariant. */
          ruleId: string;
          /** `skipped_reason` written to every drained row. */
          reason: string;
          /** Backoff (ms) before drained rows become sweep-eligible again. */
          retryAfterMs: number;
          /**
           * Cheap async guard. `false` => whole-stage transient skip this
           * cycle; `true` => the stage drains normally. Must be side-effect
           * free and fast (it runs every sweep tick).
           */
          guard: (ctx: StageGuardContext) => Promise<boolean>;
      };

/**
 * The SINGLE eligibility declaration for a stage: "should this stage ever run on this item?"
 *
 * Answer it ONCE — `sql` (native, bulk) OR `appliesTo` (external/immutable, per-row). The framework
 * derives all three lifecycle uses from this one block:
 *   1. SEED      → every applicable row is born `pending` (an immutable-only `appliesTo` may decline to
 *                  CREATE a row, but it can NEVER write `skipped_permanent`).
 *   2. DISPOSE   → the first sweep tick disposes ineligible rows to `skipped_permanent/'ineligible'`
 *                  BEFORE the enqueue pass (so an ineligible row is removed, never executed).
 *   3. HEAL      → the same expression flips a wrongly-skipped row back to `pending` the instant it
 *                  becomes eligible again — event-independent, so a dropped invalidation event can never
 *                  strand a row.
 *
 * It is NEVER evaluated to write `skipped_permanent` at seed time — only at sweep time, repeatedly,
 * against live data. That is what makes the cold-start data-loss class structurally impossible: the only
 * writer of an eligibility `skipped_permanent` is a predicate the framework re-evaluates every tick, so
 * "permanent" is always recoverable.
 *
 * This block REPLACES the former three-way `eligibilityPredicate` / `sqlEligibilityMirror` /
 * `reEnrollReasons` seam.
 */
export interface StageEligibility {
    /**
     * NATIVE path — a positive SQL eligibility fragment: TRUE for items this stage should run on.
     * Expressed over alias `mi` (media_items) with correlated EXISTS subqueries as needed. The framework
     * negates it once for the dispose pass (`NOT (<sql>)` → skipped_permanent) and uses it verbatim for
     * the heal pass (`<sql>` TRUE → pending). This is the canonical truth for native stages.
     *
     * External plugins CANNOT author this (they have no host `sql` tag) — they use `appliesTo`.
     *
     * Must be MONOTONE-RECOVERABLE: a row that is ineligible only because upstream data (probe streams /
     * file linkage / provider ids) has not landed YET must become eligible once that data lands. Do NOT
     * gate on a column that is cleared/rewritten by an unrelated mutation, or the heal/dispose passes will
     * oscillate. For file-gated eligibility, require a present, non-missing file so a healed row also
     * satisfies any file-count terminal disposition (no re-skip oscillation).
     */
    sql?: StageDispositionFragmentBuilder;

    /**
     * EXTERNAL / IMMUTABLE path — a pure, synchronous TS predicate over a media-item snapshot.
     *
     * TWO sanctioned jobs ONLY:
     *   (a) external plugins, which have no host `sql` and so cannot author `sql`; and
     *   (b) a cheap IMMUTABLE-FIELD short-circuit so a `tv`-only stage does not seed a row per movie.
     *
     * HARD RULE — gating on a probe-derived field (`has_video`, `has_audio`, `has_file`,
     * `runtime_seconds`) is a DECLARATION-TIME validation ERROR for native stages (one that also declares
     * `sql`) and a documented data-loss footgun for external ones. If your eligibility depends on
     * probe-derived data, put it in `sql` (native) or handle "not ready yet" as a transient skip inside
     * `execute()` (external) — the framework heals a wrongly-skipped row, but the cleanest external
     * pattern is: be eligible by media-type, then self-decide readiness at run time.
     *
     * EVALUATION TIMING:
     *   - At SEED: if present and returns false, NO ROW IS CREATED (it gates row creation; it NEVER writes
     *     skipped_permanent). Worst case of a mis-authored predicate is a MISSING row, which the sweep's
     *     seed-missing-coverage self-heal re-adds — never a LOST row.
     *   - At SWEEP (external stages with NO `sql`): re-evaluated per-row over the bounded candidate page
     *     for both dispose and heal. Native stages that declare `sql` use the bulk-SQL path and do NOT pay
     *     per-row TS at sweep time.
     */
    appliesTo?: (item: MediaItemSnapshot) => boolean;

    /**
     * `skipped_reason` written when the dispose pass skips an ineligible row. Defaults to `'ineligible'`
     * (the framework-reserved, heal-owned reason). Authors almost never set this; the heal pass reclaims
     * whatever this stage's own `skipReason` is.
     */
    skipReason?: string;

    /**
     * Opt OUT of the framework's automatic eligibility dispose pass (the `NOT(sql)` → `skipped_permanent`
     * bulk UPDATE), while KEEPING the event-independent heal. Default `false` (sql drives both dispose and
     * heal — the right choice for the vast majority of stages).
     *
     * Set `true` ONLY when disposal must be expressed by THIS stage's `terminalDisposition` instead —
     * typically because the skip is gated on an upstream stage (`requiresUpstreamRun`) or a quiet window
     * (`requiresQuietUpstream`) that the generic `NOT(sql)` dispose cannot express. The classic case:
     * mal-anime-id-enrichment must not tombstone a series for "no anime_genres" until mdblist-sync has run
     * for it — its predicate disposition carries `requiresUpstreamRun:'mdblist-sync'`, so the generic
     * dispose (which would fire immediately) must be suppressed. `eligibility.sql` still powers the heal,
     * so a wrongly-skipped row is still recovered the instant it becomes eligible.
     */
    skipAutoDispose?: boolean;

    /**
     * MIGRATION-WINDOW ONLY. Extra legacy `skipped_reason` values the heal pass should ALSO reclaim, on
     * top of this stage's own `skipReason`. Used to drain historical rows skipped under an old reason
     * string into the new eligibility model. NEVER list a reason evaluated against a real probed file
     * (e.g. `'essentia-empty-result'`) — those are legitimately permanent.
     */
    recoverWhenAdditionalReasons?: ReadonlyArray<string>;
}

/**
 * Declaration that a task is responsible for processing a named pipeline stage.
 * Attach one or more of these to `TaskDefinition.coversStages` to tell the
 * coverage system which stages this task advances.
 *
 * Stage IDs must be globally unique across all registered tasks — the registry
 * throws a `PluginDefinitionError` at boot time if two tasks claim the same id.
 */
export interface CoversStagesDeclaration {
    /**
     * Stable, kebab-case identifier for this stage. Must be unique across all
     * tasks in the registry.
     */
    id: string;
    /**
     * Eligibility version for THIS stage. Omit to inherit the task's
     * `processingVersion` — which is what every task did before this field
     * existed, so omitting it is byte-identical to the old behaviour.
     *
     * 🔴 Declare it when ONE task owns SEVERAL stages whose work moves
     * independently. The version is what `detectVersionBumps` compares against
     * `stage_version_state` to decide which completed rows are stale, and a
     * task-level number cannot describe two stages that advance separately.
     * `lumastra-intro-analyzer` declares `PROCESSING_VERSION = 4` as detector
     * provenance while stamping `VISUAL_PROCESSING_VERSION = 5` on the rows it
     * writes: on prod the ledger read 4 while all 14,651 completed `:visual`
     * rows carried 5, so bumping the real constant marked nothing obsolete and
     * bumping the provenance one would have re-analysed the lot.
     *
     * Bump it when the work this stage does changes, not when anything else
     * about the task does.
     */
    processingVersion?: number;
    /**
     * Media types this stage applies to. Items whose `media_type` is not in
     * this list are skipped without recording a state row.
     */
    appliesTo: ReadonlyArray<SdkMediaType>;
    /**
     * The SINGLE eligibility declaration — "should this stage ever run on this item?" — collapsing the
     * former `eligibilityPredicate` / `sqlEligibilityMirror` / `reEnrollReasons` seam. Native stages set
     * `eligibility.sql` (bulk); external/immutable stages set `eligibility.appliesTo` (per-row). Omit for
     * a stage gated only by `appliesTo` (media type). See {@link StageEligibility} for the full contract
     * and the cold-start-safety rules.
     */
    eligibility?: StageEligibility;
    /**
     * Events that invalidate a previously-`completed` (or `skipped_permanent`)
     * state row for this stage. When a matching lifecycle event fires, the
     * row reverts to `pending` so the task re-runs it. Declared with the typed
     * {@link PipelineEventName} taxonomy (e.g. `['file.attached', 'metadata.changed']`).
     */
    invalidatedBy?: ReadonlyArray<PipelineEventName>;
    retryPolicy?: StageRetryPolicy;
    /**
     * Phase 2 opt-in flag. When `true`, the `stage-sweep` task will enqueue
     * per-item runs of the owning task for rows that are eligible (pending /
     * failed_transient / skipped_transient / obsolete past `next_eligible_at`).
     *
     * Default `false`. A stage declaration is purely descriptive unless the
     * owning task opts in. Tasks whose `inputSchema` does not tolerate a
     * `mediaItemId` field, or whose `identityFor` reduces every enqueue to a
     * single global run, should leave this `false`.
     */
    enqueueable?: boolean;
    /**
     * Declares how the framework disposes a row the task will NOT advance to
     * `completed` this cycle — closing the "wedge" class structurally.
     *
     * Terminal OUTCOMES only — orthogonal to {@link StageEligibility}. The clean split:
     *   - `eligibility` answers "should this stage EVER run on this item?" (re-evaluated, heal-eligible).
     *   - `terminalDisposition` answers "given we considered/ran it, what terminal status?" — i.e.
     *     `self-terminal` (the task writes its own per-file terminal rows), `global-guard` (whole-stage
     *     transient skip when an integration is unconfigured), and `kind:'predicate'` dispositions whose
     *     `excludes` encodes a DATA-OBSERVED terminal fact (a probed file genuinely has no analyzable
     *     audio), NOT an eligibility gate. `requiresUpstreamRun` / `requiresQuietUpstream` stay here.
     *
     * REQUIRED when `enqueueable === true` (enforced warn-only during the
     * phased rollout; fail-closed once every stage declares one). Optional
     * otherwise — a purely descriptive, never-swept stage cannot wedge.
     *
     * Accepts a single {@link StageTerminalDisposition} or an ordered array
     * for multi-pass tasks (each disposition runs in declaration order, e.g.
     * a "no-gap → completed" pass followed by a "no-primary-id →
     * skipped_permanent" pass).
     */
    terminalDisposition?: StageTerminalDisposition | ReadonlyArray<StageTerminalDisposition>;
    /**
     * Per-tick row cap for this stage's eligibility-heal pass (the bounded flip of
     * `skipped_permanent/'ineligible'` rows back to `pending` once `eligibility` is TRUE again). Defaults
     * to the host `SELF_HEAL_LIMIT`. Raise for a large one-time backlog recovery (the flip only marks rows
     * `pending`; downstream enqueue stays bounded by the sweep's per-tick cap + per-class budget).
     */
    healLimit?: number;
    /**
     * Events for which an already-`completed` row should NOT be flipped back to
     * `pending` by `invalidateByEvent`. Use when a given event is a weak signal
     * that shouldn't re-run already-done work — e.g. declare `['file.attached']`
     * on a per-item analysis stage so adding an alternate-version file doesn't
     * mass-re-analyse the library. The flip still happens for unlisted events.
     */
    preserveCompletedOn?: ReadonlyArray<PipelineEventName>;
}

// ---------------------------------------------------------------------------
// Media type (canonical lowercase — matches media_items.media_type DDL CHECK)
// ---------------------------------------------------------------------------

/**
 * Canonical media type union. Matches the `media_items.media_type` CHECK
 * constraint after the migration-6.0.0 lowercase migration
 * (see memory `project_media_type_lowercase.md`).
 *
 * Convenience APIs (`ctx.catalog`, `ctx.mediaItems`) accept any common case
 * convention (`'Movie'`, `'MOVIE'`, `'series'`) and normalize at the boundary
 * — e.g. `'Movie'` → `'movie'`, `'Series'` → `'tv'`, `'song'` → `'track'`.
 * Plugin authors who pass non-canonical strings get the right behaviour rather
 * than a silent miss.
 */
export type MediaType =
    | 'movie'
    | 'tv'
    | 'episode'
    | 'season'
    | 'extra'
    | 'artist'
    | 'album'
    | 'track'
    | 'audiobook'
    | 'audio'
    | 'tvchannel'
    | 'book'
    | 'manga'
    | 'comic'
    | 'podcast'
    | 'music'
    | 'home_video'
    | 'training'
    | 'educational'
    | 'personal'
    | 'radio';

// ---------------------------------------------------------------------------
// Catalog / media-item convenience APIs (the "paved road")
//
// These wrap the highest-risk and most-common raw-SQL operations plugins
// would otherwise duplicate. Plugins with `capabilities: { database: true }`
// still get raw `ctx.sql` as an escape hatch — these surfaces exist so the
// 95% case never has to reach for it.
// ---------------------------------------------------------------------------

/**
 * Narrow read-only DTO for media items returned via `ctx.mediaItems.*`.
 *
 * Intentionally exposes only the fields a plugin needs for routing/display
 * decisions — internal flags (`status`, `canonical_id`, `preferred_provider`,
 * `parent_id`, `has_files`, search vectors) are deliberately omitted so the
 * SDK surface doesn't lock the host into exposing them forever.
 */
export interface MediaItemSummary {
    /** Internal Lumastra UUID (`media_items.id`). */
    id: string;
    title: string;
    /** Release year, or `null` for items where no year is known. */
    year: number | null;
    mediaType: MediaType;
    /** Long-form synopsis, when known. */
    overview: string | null;
    /**
     * Timestamp when the item was first added to the library (ISO 8601).
     * Falls back to `created_at` when `library_added_at` was never stamped.
     * `null` only on rows that pre-date both columns (theoretically unreachable).
     */
    libraryAddedAt: string | null;
}

/**
 * `ctx.catalog` — composite-key-safe external-id surface.
 *
 * Direct INSERTs to `external_ids` from plugins violate the
 * `(provider, external_id, media_type)` composite-key invariant and can
 * silently corrupt cross-media-type lookups (TMDB id `1429` resolves to
 * "25th Hour" the movie AND "Attack on Titan" the series — the wrong row
 * wins if `media_type` is empty or wrong). Use these methods instead.
 */
export interface CatalogStore {
    /**
     * Upsert one `(provider, externalId, mediaType) → mediaItemId` mapping.
     *
     * - Wraps the host's `CatalogService.upsertExternalId` (transactional,
     *   stale-mapping cleanup, lifecycle hook fan-out).
     * - `mediaType` is normalized at the boundary — passing `'Movie'`,
     *   `'MOVIE'`, or `'series'` works the same as `'movie'` / `'tv'`.
     */
    upsertExternalId(params: {
        provider: string;
        externalId: string;
        mediaType: MediaType;
        mediaItemId: string;
    }): Promise<void>;

    /**
     * Resolve `(provider, externalId, mediaType)` to a Lumastra UUID, or null
     * when no mapping exists. The `mediaType` filter is mandatory — composite
     * keys exist precisely because the same provider id maps to different
     * lumastra items per media type.
     */
    findByExternalId(params: {
        provider: string;
        externalId: string;
        mediaType: MediaType;
    }): Promise<{ mediaItemId: string } | null>;
}

/**
 * `ctx.mediaItems` — convenience reads against `media_items`.
 *
 * Returns the narrow `MediaItemSummary` rather than raw DB rows so the host
 * stays free to refactor internal columns without breaking plugins.
 */
export interface MediaItemsStore {
    /** Look up a single item by internal UUID. Returns null for unknown ids. */
    getById(id: string): Promise<MediaItemSummary | null>;

    /**
     * Fuzzy title search (trigram). `opts.limit` caps results (default 20);
     * `opts.mediaType` restricts the search to one media type.
     */
    search(
        query: string,
        opts?: { limit?: number; mediaType?: MediaType },
    ): Promise<MediaItemSummary[]>;
}

/**
 * `ctx.mediaFiles` — convenience reads against `media_files`.
 *
 * Plugins that process file-system events (e.g. file-system-scan adopters,
 * external library-watcher feeders) need to know whether Lumastra already has
 * a row for the absolute path on disk.
 */
export interface MediaFilesStore {
    /**
     * Look up a `media_files` row by absolute path. Returns the media file's
     * UUID and the first linked media item (if any). Returns null when no
     * `media_files` row exists for the path. `mediaItemId` is `null` when the
     * file exists in the table but isn't yet linked to a media item (e.g.
     * scanned but not matched).
     */
    findByPath(
        absolutePath: string,
    ): Promise<{ mediaFileId: string; mediaItemId: string | null } | null>;
}

// ---------------------------------------------------------------------------
// User credential storage
// ---------------------------------------------------------------------------

/**
 * Per-user encrypted credential storage scoped to the calling plugin.
 *
 * Wraps `plugin_user_credentials` so plugins never touch raw SQL or worry
 * about encryption. The host injects an instance pre-scoped to the plugin's
 * id — calls are automatically isolated from other plugins' credentials.
 *
 * Use for: OAuth access/refresh tokens, per-user API keys, provider
 * usernames, anything keyed by (Lumastra user, credential name).
 *
 * Expiry semantics: `get()` returns the value even when `expires_at` is in
 * the past. Plugins decide what to do with an expired credential (typically:
 * refresh via the provider's refresh-token flow, then `set()` the new value).
 * If you need fail-on-expiry semantics, check the value yourself or use the
 * audit-logged `ctx.secrets.getUser` surface.
 */
export interface UserCredentialStore {
    /**
     * Read a credential. Returns the stored value (even when expired) or
     * null when no row exists.
     */
    get(userId: string, key: string): Promise<string | null>;

    /**
     * Write or update a credential. Encrypts before persisting.
     * `opts.expiresAt` sets `expires_at` for the row; omit for credentials
     * with no defined lifetime. `opts.ifKeyExists` atomically checks and locks
     * another credential before writing; use it for connection state that must
     * not recreate credentials after an unlink (e.g. 'access_token').
     */
    set(
        userId: string,
        key: string,
        value: string,
        opts?: { expiresAt?: Date; ifKeyExists?: string },
    ): Promise<void>;

    /**
     * Delete a single (userId, key) credential. No-op if absent.
     */
    delete(userId: string, key: string): Promise<void>;

    /**
     * List keys present for this (plugin, userId). Returns the key names
     * only — values are never decrypted.
     */
    listKeys(userId: string): Promise<string[]>;

    /**
     * List userIds that have at least one credential for this plugin.
     * Useful for cron tasks iterating all linked users.
     */
    listLinkedUsers(): Promise<string[]>;

    /**
     * List userIds that have a specific credential key for this plugin.
     */
    listUsersWithKey(key: string): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// Task / plugin contexts
// ---------------------------------------------------------------------------

/** One time-coded region of an item. Seconds from its start. */
export interface PluginMediaSegment {
    /**
     * No `credits`: the host's `media_segments` table has no representation for
     * one, so it could never be stored. A published type promising a value that
     * every write rejects is worse than a narrower one.
     */
    type: 'intro' | 'outro' | 'recap' | 'preview' | 'commercial';
    startTime: number;
    endTime: number;
}

/**
 * Intro/outro/recap markers.
 *
 * Segments are keyed by `(item, type, source)` and your plugin id IS the
 * source, so you can never overwrite another detector's findings and yours can
 * be removed without touching theirs.
 */
export interface MediaSegmentStore {
    list(mediaItemId: string): Promise<Array<PluginMediaSegment & { source: string }>>;
    /** Record yours for an item, replacing your own previous ones per type. */
    upsert(mediaItemId: string, segments: PluginMediaSegment[]): Promise<void>;
    /** Remove everything YOUR plugin recorded for an item. */
    clear(mediaItemId: string): Promise<void>;
}

/** A user's playlist, as a plugin sees it. */
export interface PluginPlaylistSummary {
    id: number;
    name: string;
    itemCount: number;
}

/** Create and maintain playlists — the smart-playlist / auto-collection shape. */
export interface PlaylistStore {
    listOwned(userId: string): Promise<PluginPlaylistSummary[]>;
    create(opts: {
        userId: string;
        name: string;
        description?: string | null;
        visibility?: 'private' | 'public';
    }): Promise<number>;
    /**
     * Replace a playlist's contents with exactly these items, in this order.
     *
     * The primitive a smart playlist needs: recompute the set, hand it over.
     * Runs as one transaction, so the playlist is never briefly empty — a
     * viewer opening it mid-update must not see their playlist wiped. Ids that
     * do not resolve to a media item are dropped. Returns how many landed.
     */
    replaceItems(playlistId: number, mediaItemIds: string[]): Promise<number>;
}

/**
 * Per-run checkpoint store (`ctx.checkpoint`). One JSON value per resume
 * chain: the original run and every run resumed from it share it, so a
 * resumed run reads what its predecessor saved. Values are capped at 64 KB.
 */
export interface RunCheckpoint {
    /** The last saved value, or null when nothing was saved (or it expired). */
    load<T = unknown>(): Promise<T | null>;
    /** Replace the saved value. Best-effort: a failed write is logged, not thrown. */
    save(value: unknown): Promise<void>;
}

export interface TaskContext<TInput = unknown> {
    readonly runId: string;
    readonly parentRunId?: string;
    readonly attemptNumber: number;
    readonly input: TInput;
    readonly scope: { libraryGroupId?: string; userId?: string };
    readonly mode: TriggerKind;

    readonly sql: postgres.Sql;
    readonly logger: Logger;
    /**
     * Cancellation signal. Prefer this over `abortSignal` in new code — both
     * point at the same controller; `abortSignal` is the back-compat alias.
     */
    readonly signal: AbortSignal;
    /**
     * @deprecated Use `ctx.signal` instead. Retained as a back-compat alias
     * for plugin authors who still reference `ctx.abortSignal`. Both fields
     * are the same `AbortSignal` instance at runtime.
     */
    readonly abortSignal: AbortSignal;
    /**
     * Soft-deadline signal — aborts when the run reaches `timeout.soft`, a few
     * minutes before the hard cap. DISTINCT from `ctx.signal` (cancellation):
     * this fires on its own AbortController and the run is NOT cancelled, so a
     * handler that listens can wind down gracefully (commit partial progress,
     * skip remaining work) and still return `success` — avoiding the hard-timeout
     * watchdog FAIL. Long, resumable tasks (large API sweeps, drains) should
     * listen and stop their loop; everything else can ignore it and run to the
     * hard cap as before.
     *
     * Optional for back-compat (older hosts / hand-rolled contexts may omit it) —
     * guard with `?.`. Provided for both in-process and worker-isolated runs
     * (`isolation: 'worker'`), the latter relayed over the worker MessagePort.
     * Compose with cancellation via `AbortSignal.any([ctx.signal, ctx.softSignal])`
     * when present.
     */
    readonly softSignal?: AbortSignal;

    readonly http?: HttpClient;
    readonly cache?: NamespacedCache;
    /**
     * Saved position for a run that may be resumed after a worker restart.
     * Present only on runs that can be resumed: the task declares
     * `resumeAfterRestart: true` and the run was started manually. Absent
     * otherwise, and absent under `isolation: 'worker'` — guard with `?.`.
     *
     * Save after each unit of work that is already durable (a committed
     * slice), never before it: a resumed run continues from the last save and
     * must not skip work that was not done. Saving is best-effort; a lost
     * checkpoint only makes the resumed run start over, so the task must stay
     * correct when `load()` returns null.
     */
    readonly checkpoint?: RunCheckpoint;

    dep(name: string): RateLimitedFetch;
    settings(): Promise<Record<string, unknown>>;
    readonly secrets: {
        get(key: string): Promise<string>;
        /** Like get(), but resolves to null instead of throwing when the secret is absent. */
        getOptional(key: string): Promise<string | null>;
        getUser(userId: string, key: string): Promise<string>;
    };
    /**
     * Per-user encrypted credential storage scoped to this task's plugin id.
     * Prefer this over raw SQL access to `plugin_user_credentials` — it
     * encrypts, isolates per plugin, and never throws on expiry (so plugins
     * can inspect/refresh expired tokens).
     */
    readonly userCredentials: UserCredentialStore;

    /**
     * Composite-key-safe external-id surface. See `CatalogStore`.
     *
     * Prefer this over raw `external_ids` writes — direct INSERTs break the
     * `(provider, external_id, media_type)` composite-key invariant and can
     * silently corrupt cross-media-type lookups (see memory
     * `bug_catalog_withTx_reserved_sql.md`).
     */
    readonly catalog: CatalogStore;

    /** Convenience reads against `media_items`. See `MediaItemsStore`. */
    readonly mediaItems: MediaItemsStore;

    /** Convenience reads against `media_files`. See `MediaFilesStore`. */
    readonly mediaFiles: MediaFilesStore;

    /** Create and maintain playlists. See `PlaylistStore`. */
    readonly playlists: PlaylistStore;

    /** Intro/outro/recap markers, scoped to your plugin id. See `MediaSegmentStore`. */
    readonly mediaSegments: MediaSegmentStore;

    reportProgress(processed: number, total?: number, currentItem?: string): void;
    reportFailure(itemId: string, reason: string, meta?: object): Promise<void>;
    /**
     * Clear every unresolved failure this task has recorded against `itemId`.
     *
     * The counterpart to `reportFailure`, for tasks that process items in
     * BATCHES rather than one item per run. A single-item task gets this for
     * free — the runner resolves on `markCompleted`. A batch task does not:
     * nothing else can tell that item 47 of 200 finally worked, so call this
     * when it does.
     *
     * The failure log is append-only and a periodic task re-attempts a broken
     * item on every sweep, so without this an item that recovers keeps every
     * row it ever wrote and the operator's attention board keeps reporting it
     * as broken. Idempotent, best-effort, and never throws: an audit write must
     * not fail a run that succeeded.
     */
    reportSuccess(itemId: string): Promise<void>;
    spend(kind: CostKind, units: number): void;
    drain(opts?: { mode?: DrainMode }): Promise<DrainResult>;
}

/** A reference to a media item: internal UUID + canonical media type. */
export interface MediaRef {
    id: string;
    mediaType: MediaType;
}

/** A media reference resolved + access-checked for one viewer. */
export interface ResolvedMediaChip {
    id: string;
    mediaType: MediaType;
    /** True iff the current viewer may see this item. */
    allowed: boolean;
    /** Present only when allowed. */
    title?: string;
    year?: number | null;
    posterUrl?: string;
    /** Host deep-link to open the item; present only when allowed. */
    openHref?: string;
}

/** The authenticated viewer of a request-scoped plugin context. */
export interface PluginUser {
    /**
     * The stable `users.id` UUID — the canonical key for anything a plugin
     * stores per user.
     *
     * **Use this, never `username`, as a data key.** `username` is a mutable
     * login handle: an IdP rename changes it, and a deleted account frees it
     * for reuse by an unrelated person. A plugin that keys rows by username
     * therefore hands the new holder of a name whatever the previous holder
     * owned — which is exactly the bug this field was added to close in the
     * shoutbox plugin, whose table predates user UUIDs entirely.
     *
     * The host populates this from `locals.user.userId`. Plugins that also
     * want to DISPLAY who wrote something should store `username` alongside
     * it, denormalised — it preserves the handle as it was at write time,
     * which is what a chat log wants.
     */
    userId: string;
    /** Mutable login/display handle. Display only — never a data key. */
    username: string;
    groups: string[];
    isAdmin: boolean;
}

export interface PluginContext {
    readonly sql: postgres.Sql;
    readonly logger: Logger;
    readonly http?: HttpClient;
    readonly cache?: NamespacedCache;
    /**
     * Cancellation signal. Optional — defaults to an unaborted signal when
     * the host builds the context outside a task run. Provider implementations
     * should pass it through to `fetch()` so cancellation actually unwinds
     * upstream HTTP calls.
     */
    readonly signal: AbortSignal;
    settings(): Promise<Record<string, unknown>>;
    readonly secrets: {
        get(key: string): Promise<string>;
        /** Like get(), but resolves to null instead of throwing when the secret is absent. */
        getOptional(key: string): Promise<string | null>;
        getUser(userId: string, key: string): Promise<string>;
    };
    /**
     * Per-user encrypted credential storage scoped to this plugin id. See
     * `UserCredentialStore` for semantics (notably: `get` returns expired
     * values, no audit log on each read).
     */
    readonly userCredentials: UserCredentialStore;

    /**
     * Composite-key-safe external-id surface. See `CatalogStore`.
     *
     * Prefer this over raw `external_ids` writes — direct INSERTs break the
     * `(provider, external_id, media_type)` composite-key invariant.
     */
    readonly catalog: CatalogStore;

    /** Convenience reads against `media_items`. See `MediaItemsStore`. */
    readonly mediaItems: MediaItemsStore;

    /** Convenience reads against `media_files`. See `MediaFilesStore`. */
    readonly mediaFiles: MediaFilesStore;

    /** Create and maintain playlists. See `PlaylistStore`. */
    readonly playlists: PlaylistStore;

    /** Intro/outro/recap markers, scoped to your plugin id. See `MediaSegmentStore`. */
    readonly mediaSegments: MediaSegmentStore;

    /**
     * The authenticated viewer, when this context was built for an HTTP request
     * (feature-route dispatcher). Undefined for task-run / boot contexts.
     */
    readonly user?: PluginUser | null;

    /** Fan a UI event out to all dashboard clients across replicas. */
    readonly realtime?: {
        publish(topic: string, payload: unknown): Promise<void>;
    };

    /** Viewer-scoped, access-checked media resolution. Request contexts only. */
    readonly media?: {
        search(
            q: string,
            opts?: { limit?: number; mediaTypes?: MediaType[] },
        ): Promise<ResolvedMediaChip[]>;
        resolveForViewer(refs: MediaRef[]): Promise<ResolvedMediaChip[]>;
    };

    /**
     * Optional AI assistant. Undefined when the assistant is absent from the build.
     *
     * SECURITY: RAG retrieval is scoped to the request's AUTHENTICATED viewer
     * (`ctx.user`), bound host-side. There is deliberately NO caller-supplied
     * user id — a plugin cannot ask "as" another (e.g. admin) user, which would
     * leak access-scoped recommendations. The host answers as whoever this
     * request context belongs to.
     */
    readonly ai?: {
        ask(req: {
            prompt: string;
            history?: Array<{ role: 'user' | 'assistant'; content: string }>;
            systemHint?: string;
            signal?: AbortSignal;
        }): Promise<{
            text: string;
            recommendedMedia: MediaRef[];
            usage: { tokens: number; costUsd: number };
        }>;
    };
}

export interface TaskResult<R = unknown> {
    success: boolean;
    itemsProcessed?: number;
    result?: R;
    downstream?: Array<{ taskId: string; input: unknown }>;
    stopReason?: 'drained' | 'budget' | 'no-progress' | 'aborted' | 'single-slice' | 'skipped';
}

// ---------------------------------------------------------------------------
// Task definition
// ---------------------------------------------------------------------------

export interface TaskDefinition<TInput = unknown, TResult = unknown, TItem = unknown> {
    id: string;
    name: string;
    /**
     * Optional admin-facing description shown in /admin/tasks. Keep this to
     * ONE plain-language operator sentence (admin IA redesign spec §7's text
     * budget) — what the task does and when it matters. It is shown on the
     * task's catalog card, its Overview tab, and inside the `confirmBeforeRun`
     * dialog, so it must read cleanly to a non-developer self-hoster. It is
     * only a fallback: the admin UI prefers a curated Paraglide message from
     * `src/lib/utils/admin/task-descriptions.ts` (en+de) keyed by task id when
     * one exists, and falls back to this field otherwise.
     */
    description?: string;
    /**
     * Optional longer-form operator notes — incident context, caveats,
     * one-shot-repair background, anything that doesn't fit `description`'s
     * one-sentence budget. Rendered ONLY on the task detail's Definition tab
     * (Developer-only surface, admin IA redesign spec §3.7) — never shown on
     * the catalog card or the confirm dialog, so raw internal prose belongs
     * here rather than in `description`.
     */
    notes?: string;
    version: string;
    processingVersion: number;
    minAppVersion: string;

    /**
     * Marks this task as a tutorial / SDK reference exemplar. Demos:
     *  - Are hidden from `/api/v1/tasks` and `/admin/tasks` when
     *    `NODE_ENV === 'production'` so end users don't see fake jobs.
     *  - Stay visible in dev/CI so plugin authors can read + manual-trigger
     *    them as live SDK references.
     *  - Should not declare a `schedule:` (the host filters them out of the
     *    scheduler in prod, but dev-time scheduling is noisy and not what
     *    operators want to demo).
     *
     * Plugin authors publishing reference tasks against the SDK should
     * set `demo: true`. Real production tasks omit the field.
     */
    demo?: boolean;

    /**
     * Admin-facing purpose group. Drives the /admin/tasks catalog grouping
     * (spec: admin IA redesign §3.3) — Library pipeline / Music & AI / Live
     * TV / Watch sync / Maintenance / Repair tools. `'repair'` is for
     * one-shot fix-up tools, visually separated from routine work.
     * Omitted ⇒ the UI buckets the task under Maintenance (collapsed by
     * default), so an unclassified task never goes missing from the catalog.
     */
    purpose?: 'library' | 'music-ai' | 'livetv' | 'watch-sync' | 'maintenance' | 'repair';

    /**
     * Who the task is for in the admin task list. `'system'` marks internal
     * machinery an operator would never run by hand and only cares about when
     * it fails (sweepers, reapers, retention jobs, monitors): hidden from the
     * list behind a "Show system tasks" toggle, but still surfaced whenever it
     * has a problem. Omitted ⇒ `'user'` — shown like any other task.
     */
    visibility?: 'user' | 'system';

    /**
     * When true, the admin UI's "Run" button shows a confirmation dialog
     * (with this task's one-line `description`) before triggering a manual
     * run. Set this for tasks that generate mass external traffic or long
     * CPU work an operator could accidentally kick off library-wide (e.g.
     * a full TMDB re-sync, a per-season chromaprint analysis pass).
     */
    confirmBeforeRun?: boolean;

    capabilities: {
        database?: boolean;
        http?: boolean;
        ffmpeg?: boolean;
        cache?: boolean;
        dataDir?: boolean;
        /**
         * Optional domain allowlist for `ctx.http`. When non-empty, every
         * outbound request is checked against this list before being issued.
         * Exact hostname match or suffix match (prefix `.` means any subdomain).
         * Example: `['api.tmdb.org', '.themoviedb.org']`
         *
         * When absent or empty the allowlist is not enforced (backward-compatible
         * — existing plugins keep working). New plugins should declare the
         * narrowest set of domains they actually call.
         */
        allowedDomains?: string[];
    };

    schedule?: {
        every: string;
        runOnStartup?: boolean;
        startupDelay?: string;
        envOverride?: string;
    };

    /**
     * DB-row-driven schedule. Use this when the firing cadence lives in user
     * data — e.g. per-source refresh interval, per-user sync cadence — rather
     * than a static manifest constant.
     *
     * The host calls `loader()` every `sweepEvery` (default 5m). The loader is
     * responsible for reading its table, parsing per-row cron/interval, and
     * returning ONLY the rows that are due to fire right now. Each returned
     * entry produces one `startRun` call, deduplicated per `bucket` within
     * its cycle so two replicas can't double-fire the same row.
     *
     * Mutually exclusive with `schedule`. Tasks with neither schedule nor
     * dynamicSchedule must declare `manualOnly: true`, be a `pipeline.of`
     * child, or be `demo: true` — otherwise boot audit reports them as
     * trigger-orphaned.
     */
    dynamicSchedule?: {
        loader: (ctx: DynamicScheduleContext) => Promise<Array<DynamicScheduleEntry<TInput>>>;
        sweepEvery?: string;
        envOverride?: string;
    };

    /**
     * Explicit opt-out for tasks fired only via `orchestrator.startRun` from
     * service code or admin UI. Required when there is no `schedule`,
     * `dynamicSchedule`, `pipeline.of`, or `demo: true` declaration — the
     * boot audit fails otherwise.
     *
     * Setting `manualOnly: true` is a contract that says "this task is
     * fired by a known service/route." Anything else is a silent orphan.
     */
    manualOnly?: boolean;

    /**
     * Resume a MANUALLY started run (admin UI, API, service token) after a
     * worker restart instead of failing it. Declare only when re-running the
     * task's work is safe — the resumed run repeats whatever the interrupted
     * run had not saved (see `ctx.checkpoint`).
     *
     * The host resumes a run only when the worker shut down gracefully and the
     * handler had actually stopped; never after a crash, never a cancelled
     * run, at most 3 times per run, and not when the run was interrupted again
     * shortly after its last resume. Scheduled and event-triggered runs are
     * never resumed (their next cycle picks the work up). Not allowed on a
     * `pipeline.of` stage.
     *
     * When `ctx.signal` aborts, return `success: false` (or
     * `stopReason: 'aborted'`) or throw: a run that returns `success: true`
     * after the abort is recorded as completed and is not resumed.
     */
    resumeAfterRestart?: boolean;

    /**
     * True for registry-only stub tasks whose `execute()` always throws
     * because something else (e.g. a watch-sync provider's engine) drives
     * the real work directly. Distinct from `manualOnly`: a `manualOnly`
     * task genuinely can be triggered by a human, just not by the
     * scheduler. A `notManuallyRunnable` task can't be triggered at all —
     * the admin UI disables its "Run" button rather than let an operator
     * trigger a guaranteed failure.
     */
    notManuallyRunnable?: boolean;

    /**
     * True when a manual run accepts `{ mode: 'manual' }` to drain the ENTIRE
     * backlog in one run, instead of the single batch a scheduled `catchup`
     * cycle processes.
     *
     * Every task built on `resolveDrainMode` / `drainBacklog` already honours
     * this input, but there was no way for an operator to ask for it: the admin
     * "Run" button posts an empty body, so a large backlog could only be worked
     * off one batch per scheduled cycle — days, for a library-sized backlog.
     * Declaring it here surfaces a "Full run" action on the task card.
     */
    supportsFullRun?: boolean;

    /**
     * True when a manual run accepts `{ mode: 'force' }` to DISCARD what it
     * previously produced and rebuild it from scratch, instead of only working
     * through the items it has not reached yet.
     *
     * Narrower than `supportsFullRun` on purpose. `drainBacklog` performs the
     * wipe by calling the task's own `onWipe` hook, and a task that reaches
     * force mode without supplying one degrades to an ordinary manual drain
     * with a warning — the operator asks to rebuild everything and silently
     * gets a no-op. Declare this only where an `onWipe` is actually wired up;
     * `supports-force-run.test.ts` holds the two in correspondence.
     */
    supportsForceRun?: boolean;

    /**
     * True when a manual run of this task deletes existing data as part of
     * its normal operation (e.g. wiping AI embeddings before re-queueing
     * them). The admin UI renders the "Run" action in a red/danger variant
     * with a warning tooltip so an operator doesn't mistake it for a
     * routine re-sync. Distinct from `confirmBeforeRun` (which just gates
     * behind a confirmation dialog) — a task can be destructive without
     * `confirmBeforeRun`, though in practice destructive tasks should set
     * both.
     */
    destructive?: boolean;

    identityFor: (input: TInput) => string;
    exclusiveWith?: { scope: 'global' | 'libraryGroup' | 'user'; ttl: string };

    scope?: 'global' | 'libraryGroup' | 'user';

    resourceClass: ResourceClass;

    /**
     * Set by the runtime (NOT by plugin authors) when FEATURE_PER_TASK_QUEUES
     * is on and the declared `resourceClass` was a legacy fairness-lane class
     * (`ingest`/`bulk`/`analysis`). The registry rewrites `resourceClass` to the
     * physical budget class and records the original here so admin surfaces can
     * still show what the author declared. Undefined when no rewrite happened.
     */
    declaredResourceClass?: ResourceClass;

    /**
     * Static priority for runs of this task within its `resourceClass` queue.
     * Lower numbers serve first. When omitted, the orchestrator falls back to
     * the trigger-derived priority (`'in-process' | 'manual' | 'webhook' = 5`,
     * `'pipeline-child' | 'resume' = 7`). The task-level override wins only
     * when the caller doesn't set an explicit `priority` on the startRun opts.
     *
     * Use case: a CPU-bound task that should jump the queue ahead of bulk
     * batch work in the same resource class. Example: `lumastra-intro-analyzer`
     * vs `trickplay-generation` — both on `cpu`, but a backlog of 450
     * trickplay jobs would otherwise block intro analysis for 30+ hours.
     * Declaring `taskPriority: 3` on intro lets it cut the line whenever
     * its row is pending.
     *
     * Valid range matches the trigger ladder: 1 (operator-VIP) → 7
     * (low-priority background). Stick to the existing rungs (1, 2, 3, 5, 7)
     * for predictability. Don't try to use this for fairness — BullMQ's
     * priority is strict, not weighted; a starved task with a high priority
     * value will never run while higher-priority items keep arriving. For
     * fairness, give the task its own `resourceClass` instead.
     */
    taskPriority?: 1 | 2 | 3 | 5 | 7;

    externalDeps?: Array<{
        name: string;
        /**
         * Requests-per-second budget. Fractional values are honoured by the
         * runtime token bucket (e.g. `rps: 0.5` permits one request every
         * two seconds — necessary for slow APIs that publish per-minute
         * limits like 10rpm). Omit to disable the bucket entirely.
         */
        rps?: number;
        retryAfter?: 'header' | number;
        circuitBreaker?: { failures: number; cooldownMs: number };
    }>;

    retry?: {
        attempts: number;
        backoff: 'exponential' | number[];
        retryOn: (err: unknown) => boolean;
    };

    backpressure?: {
        onQueueDepthOver: number;
        action: 'drop' | 'fail-fast' | 'shed-oldest';
    };

    pipeline?: {
        of: string;
        after?: string[];
        when?: (parentResult: unknown) => boolean;
    };

    /**
     * Optional declaration that this task feeds work into other tasks. The
     * admin UI uses these edges as health probes — if last_completed_at(this)
     * is significantly newer than last_completed_at(downstream), the edge is
     * considered stale and surfaces as an alert in the ⚠️ lane. Authors only
     * declare edges worth health-monitoring; undeclared edges generate no
     * probes (no false alarms).
     *
     * ⚠️ MONITORING ONLY — this does NOT enqueue, re-run, invalidate, or
     * re-seed the downstream task. A completed run has ZERO runtime effect on
     * the tasks listed here (the only consumers are `registry.validateFeedsInto`
     * and the admin probe graph in `api/defs/tasks`). Downstream re-processing
     * — e.g. re-embedding when metadata/keywords are enriched — is driven
     * ENTIRELY by the downstream's `coversStages[].invalidatedBy` events, which
     * are emitted by DB triggers / the lifecycle service, NOT by this edge. So
     * adding `library-embeddings` here would NOT cause a re-embed.
     */
    feedsInto?: string[];

    backlog?: {
        unitLabel: string;
        sliceSize: number;
        softBudget: string;
        idOf: (row: TItem) => string;
        // TItem and TInput both flow through these callbacks so plugin
        // authors keep inference end-to-end. ctx.input is typed as TInput;
        // returned items are typed as TItem[].
        stages: (ctx: TaskContext<TInput>) => Promise<BacklogStage[]>;
        compute: (
            ctx: TaskContext<TInput>,
            limit: number,
        ) => Promise<{ items: TItem[]; remainingHint?: number }>;
        wipe?: (ctx: TaskContext<TInput>) => Promise<void>;
    };

    processItems?: (ctx: TaskContext<TInput>, items: TItem[]) => Promise<void>;

    failures?: {
        list: (
            ctx: TaskContext<TInput>,
            opts: PaginationOpts,
        ) => Promise<{ items: FailedItem[]; total: number }>;
        retry?: (ctx: TaskContext<TInput>, itemId: string) => Promise<void>;
    };

    cost?: {
        kind: CostKind;
    };

    settings?: {
        fields: SettingField[];
        customComponent?: string;
    };

    inputSchema: z.ZodSchema<TInput>;

    quotas?: {
        maxRunsPerDay?: number;
        maxRunsPerTenant?: number;
        maxConcurrent?: number;
        costBudgetMonthly?: number;
    };

    retention?: {
        policy: 'standard' | 'audit' | 'forensic' | 'ephemeral';
        days?: number;
    };

    timeout?: { hard: string; soft: string };

    lifecycle?: {
        resumeOnInterrupt?: false | SyncResumeManifest;
        onStartup?: (ctx: TaskContext<TInput>) => Promise<void>;
        onShutdown?: () => Promise<void>;
        onConfigChange?: (ctx: TaskContext<TInput>, newConfig: unknown) => Promise<void>;
    };

    migrations?: PluginMigration[];

    isolation?: 'inline' | 'worker';
    scopes?: string[];

    /**
     * Pipeline-coverage stage declarations. Each entry tells the coverage
     * system that this task is responsible for a named processing stage.
     * Stage IDs must be unique across all registered tasks.
     */
    coversStages?: ReadonlyArray<CoversStagesDeclaration>;

    execute: (ctx: TaskContext<TInput>) => Promise<TaskResult<TResult>>;
}

// ---------------------------------------------------------------------------
// Provider definition
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Provider-neutral detail result shape
// ---------------------------------------------------------------------------

/**
 * A provider-neutral artwork block returned by `ProviderDetailResult.artwork`.
 *
 * All URL fields are absolute (providers expand CDN prefixes before returning).
 * `null` means the provider explicitly has no image for that role; `undefined`
 * means the provider did not supply a value for that role at all.
 */
export interface ProviderArtwork {
    /** Full-resolution poster image URL. */
    posterUrl?: string | null;
    /** Full-resolution backdrop/banner image URL. */
    backdropUrl?: string | null;
    /** Logo image URL (e.g. title card / watermark). */
    logoUrl?: string | null;
    /** Thumbnail / still-frame image URL (for episodes). */
    thumbUrl?: string | null;
}

/**
 * A single cast member in the provider-neutral shape.
 */
export interface ProviderCastMember {
    name: string;
    character?: string;
    /** Billing order (lower = top-billed). */
    order?: number;
    /**
     * Provider person id (e.g. TMDB person id as a string). Lets the app build
     * a proxied, cacheable headshot URL (`/api/image/person/{id}`) and expose
     * the id to clients that resolve images themselves.
     */
    personId?: string;
    /** Absolute URL to the cast member's profile photo. */
    profileUrl?: string | null;
}

/**
 * A single crew member in the provider-neutral shape.
 */
export interface ProviderCrewMember {
    name: string;
    /** Job title (e.g. "Director", "Producer", "Screenplay"). */
    job: string;
    /** Department (e.g. "Directing", "Writing", "Production"). */
    department?: string;
}

/**
 * Rich, provider-neutral detail result — the structured shape that a
 * `ProviderDefinition.detail()` implementation may return when it wants the
 * enrichment pipeline to consume the result without any TMDB-specific field
 * mapping.
 *
 * ALL fields are optional so existing providers that return raw objects
 * (e.g. `Record<string, unknown>`) continue to compile unchanged. TMDB
 * populates every field listed here from a single `append_to_response`
 * round-trip; non-TMDB providers populate the fields their API exposes.
 *
 * Naming convention:
 *   - Names are provider-neutral English identifiers (not TMDB snake_case
 *     API names). For example `genreNames` not `genres`, `releaseDate` not
 *     `release_date`, `voteAverage` not `vote_average`.
 *   - Slug fields (`genreSlugs`, `keywordSlugs`) carry the provider-neutral
 *     slug form so DB browse queries can match without a TMDB ID lookup.
 *   - Provider-specific identifiers (e.g. TMDB numeric keyword IDs) go in
 *     `rawKeywordIds` — a typed escape hatch for the TMDB overlay path.
 */
export interface ProviderDetailResult {
    // ── Core identity ────────────────────────────────────────────────────────
    /** Localized display title. */
    title?: string;
    /** Original-language title (movie: original_title, TV: original_name). */
    originalTitle?: string;
    /** English title derived from the translations append (non-English providers). */
    englishTitle?: string;
    /** Long-form synopsis. */
    overview?: string;
    /** Marketing tagline. */
    tagline?: string;

    // ── Dates + runtime ──────────────────────────────────────────────────────
    /**
     * Release / first-air date in ISO 8601 format (YYYY-MM-DD).
     * Movies: release_date; TV: first_air_date.
     */
    releaseDate?: string;
    /** Runtime in minutes. */
    runtime?: number;

    // ── Categorization ───────────────────────────────────────────────────────
    /** Genre display names (e.g. ["Action", "Thriller"]). */
    genreNames?: string[];
    /**
     * Provider-neutral genre slugs derived from genre names
     * (e.g. ["action", "thriller"]). Used by DB browse queries so a
     * non-TMDB provider does not need TMDB numeric genre IDs.
     */
    genreSlugs?: string[];
    /** Keyword display names (e.g. ["time-travel", "based on novel"]). */
    keywordNames?: string[];
    /**
     * Provider-neutral keyword slugs derived from keyword names.
     * Browse queries prefer these over provider-specific numeric IDs.
     */
    keywordSlugs?: string[];
    /**
     * Raw numeric keyword IDs from the provider (e.g. TMDB keyword IDs).
     * TMDB-specific overlay used by the `tmdb_keyword_ids @> [id]` GIN
     * index path. Non-TMDB providers omit this field.
     */
    rawKeywordIds?: number[];

    // ── Cast + crew ───────────────────────────────────────────────────────────
    /** Top-billed cast members (structured — includes character + order). */
    cast?: ProviderCastMember[];
    /** Director name(s). */
    directors?: string[];
    /** Producer name(s) (e.g. "Producer", "Executive Producer"). */
    producers?: string[];
    /** Writer name(s) (e.g. "Writer", "Screenplay", "Story"). */
    writers?: string[];

    // ── TV-specific ───────────────────────────────────────────────────────────
    /** Broadcast / streaming networks (TV only). */
    networks?: string[];
    /** Total episode count across all seasons (TV only). */
    totalEpisodes?: number;
    /** Total season count (TV only). */
    totalSeasons?: number;
    /**
     * Series production status (e.g. "Returning Series", "Ended",
     * "Canceled"). TV only; movies use `status`.
     */
    seriesStatus?: string;
    /** Last air date (ISO 8601, TV only). */
    lastAirDate?: string;

    // ── Quality + popularity signals ─────────────────────────────────────────
    /** TMDB-style 0–10 vote average (or provider equivalent). */
    voteAverage?: number;
    /** Total vote / review count. */
    voteCount?: number;
    /** Provider popularity score (raw floating-point, provider-specific scale). */
    popularity?: number;
    /**
     * Production/distribution status (movies: "Released", "Post Production",
     * etc.). TV shows use `seriesStatus`.
     */
    status?: string;

    // ── External cross-references ────────────────────────────────────────────
    /** IMDb ID (tt-prefixed string, e.g. "tt0111161"). */
    imdbId?: string;
    /**
     * Open map of provider-specific external IDs the provider knows about.
     * Keys are provider names ("imdb", "tvdb", "facebook", …); values are
     * the provider-specific string ID. Enrichment consumers merge these into
     * `external_ids` rows.
     */
    externalIds?: Record<string, string>;

    // ── Media / artwork ───────────────────────────────────────────────────────
    /**
     * Provider-neutral artwork block. All URLs are absolute; the provider
     * expands CDN prefixes (e.g. TMDB image base URL) before populating
     * this field so consumers never need to know the provider's CDN.
     */
    artwork?: ProviderArtwork;

    // ── Trailer ───────────────────────────────────────────────────────────────
    /** Absolute URL to a YouTube trailer (or other embeddable video). */
    trailerUrl?: string;

    // ── Production meta ───────────────────────────────────────────────────────
    /** Production company names. */
    productionCompanies?: string[];
    /** ISO 3166-1 alpha-2 production country codes (e.g. ["US", "GB"]). */
    productionCountries?: string[];
    /** ISO 639-1 spoken language codes (e.g. ["en", "fr"]). */
    spokenLanguages?: string[];
    /** Budget in USD (movies only). */
    budget?: number;
    /** Revenue in USD (movies only). */
    revenue?: number;
}

// ---------------------------------------------------------------------------
// Discover / trending / popular DTO types
// ---------------------------------------------------------------------------

/**
 * Time window for trending queries. `'day'` returns items trending in the
 * last 24 hours; `'week'` (default) returns items trending in the last 7 days.
 */
export type ProviderTrendingWindow = 'day' | 'week';

/**
 * Parameters for `ProviderDefinition.discover?`.
 *
 * `mediaType` distinguishes movie vs. series discovery; `genreIds` narrows
 * by genre; `page` drives pagination (1-indexed, defaults to 1). Additional
 * provider-specific options may be passed via `extra`.
 */
export interface ProviderDiscoverParams {
    mediaType: 'movie' | 'tv';
    genreIds?: number[];
    sortBy?: string;
    minVoteAverage?: number;
    minVoteCount?: number;
    page?: number;
    /**
     * Provider-specific keyword IDs (e.g. TMDB `with_keywords`). Providers
     * that support keyword-based filtering (TMDB `/discover/movie?with_keywords=…`)
     * pass these through to the underlying request; providers that don't
     * support keyword filtering silently ignore this field.
     */
    keywordIds?: number[];
    extra?: Record<string, unknown>;
}

/**
 * A single item returned from `ProviderDefinition.discover?` /
 * `getTrending?` / `getPopular?`. Providers return a raw object; the host
 * normalizes it via the existing `searchResultToCandidate` / `detailToMetadata`
 * pipeline. Keep this open so providers can attach provider-specific keys.
 */
export type ProviderDiscoverResult = Record<string, unknown>;

/**
 * Parameters for `ProviderDefinition.getTrending?`.
 */
export interface ProviderTrendingParams {
    mediaType: 'movie' | 'tv';
    window?: ProviderTrendingWindow;
    page?: number;
}

/**
 * Parameters for `ProviderDefinition.getPopular?`.
 */
export interface ProviderPopularParams {
    mediaType: 'movie' | 'tv';
    page?: number;
}

/**
 * Parameters for `ProviderDefinition.getTopRated?`.
 * Same shape as `ProviderPopularParams` — a separate type is declared so the
 * two capabilities remain independently extensible.
 */
export interface ProviderTopRatedParams {
    mediaType: 'movie' | 'tv';
    page?: number;
}

// ---------------------------------------------------------------------------
// External-id resolution — provider-neutral cross-reference lookup
// ---------------------------------------------------------------------------

/**
 * The external-id kind passed to `ProviderDefinition.resolveExternalId`.
 *
 * Providers that expose a cross-reference endpoint (e.g. TMDB `/find/{id}`)
 * implement the `resolveExternalId` capability and declare the sources they
 * support. Sources not in this union are silently ignored.
 */
export type ProviderExternalIdSource = 'imdb' | 'tvdb' | 'facebook' | 'instagram' | 'twitter';

/**
 * The result of a successful `ProviderDefinition.resolveExternalId` call.
 *
 * All fields except `externalId` are optional — providers fill in what their
 * endpoint returns. `auto-identify` uses `title` / `originalTitle` /
 * `releaseDate` for the title-similarity gate; absent fields degrade
 * gracefully (score is computed from whatever IS present).
 */
export interface ProviderResolveExternalIdResult {
    /** The provider's own ID for the matched item (used as the external_id key). */
    externalId: string;
    /** Display title as returned by the provider. */
    title?: string;
    /** Original-language title. */
    originalTitle?: string;
    /**
     * Release / first-air date in ISO 8601 format (`YYYY-MM-DD`).
     * Used by the auto-identify year-proximity gate.
     */
    releaseDate?: string;
}

export interface ProviderDefinition<TParams = unknown, TItem = unknown> {
    id: string;
    name: string;
    version: string;
    capabilities: {
        http?: boolean;
        cache?: boolean;
        database?: boolean;
        allowedDomains?: string[];
    };
    /**
     * Optional rate limit hint forwarded to the runtime rate-limiter.
     *
     * `rps` accepts fractions: a provider published with a 10rpm limit
     * should be declared as `{ rps: 10 / 60 }` rather than rounded up to
     * `{ rps: 1 }`. The legacy provider shim previously rounded down to
     * `Math.max(1, Math.floor(rpm / 60))`, which awarded a 60rpm budget
     * to a 10rpm API — fractional rps fixes that overshoot.
     */
    rateLimit?: { rps: number; circuitBreaker?: CircuitBreakerCfg };

    /**
     * Metadata authority configuration for this provider.
     *
     * `priority` is the default weight used when multiple providers supply the
     * same field — higher wins. `fieldAuthorities` overrides priority for
     * specific fields. `cacheTtlHours` sets the default TTL for responses
     * from this provider.
     *
     * Operators may override any of these values via plugin settings.
     */
    metadata?: {
        /** Authority weight; higher wins when multiple providers fill the same field. */
        priority: number;
        /** Per-field authority weights overriding `priority` for specific fields. */
        fieldAuthorities?: Record<string, number>;
        /** Default cache TTL hours for this provider's responses. */
        cacheTtlHours?: number;
    };

    isConfigured(ctx: PluginContext): Promise<boolean>;
    search?(ctx: PluginContext, params: TParams): Promise<TItem[]>;
    detail(ctx: PluginContext, id: string): Promise<TItem>;
    childList?(ctx: PluginContext, parentId: string): Promise<TItem[]>;
    /**
     * Optional batch lookup. Providers that expose a batch endpoint can
     * implement this to avoid N round-trips when callers have ids in hand.
     * Returns one TItem per input id in the same order; absent ids yield
     * `null` placeholders so callers can correlate by index.
     */
    batchLookup?(ctx: PluginContext, ids: string[]): Promise<Array<TItem | null>>;

    /**
     * Optional discover endpoint. Providers that expose a catalog-browse /
     * discover API (e.g. TMDB `/discover/movie`) implement this so callers
     * can request genre- or sort-filtered content without going through the
     * full search surface. Returns an empty array when absent — callers
     * treat "not supported" the same as "no results".
     */
    discover?(
        ctx: PluginContext,
        params: ProviderDiscoverParams,
    ): Promise<ProviderDiscoverResult[]>;

    /**
     * Optional trending endpoint. Returns items trending over the given
     * `window` ('day' | 'week'). Returns an empty array when absent.
     */
    getTrending?(
        ctx: PluginContext,
        params: ProviderTrendingParams,
    ): Promise<ProviderDiscoverResult[]>;

    /**
     * Optional popular endpoint. Returns currently popular items for the
     * given media type. Returns an empty array when absent.
     */
    getPopular?(
        ctx: PluginContext,
        params: ProviderPopularParams,
    ): Promise<ProviderDiscoverResult[]>;

    /**
     * Optional top-rated endpoint. Returns top-rated items for the given
     * media type. Returns an empty array when absent.
     */
    getTopRated?(
        ctx: PluginContext,
        params: ProviderTopRatedParams,
    ): Promise<ProviderDiscoverResult[]>;

    /**
     * Optional person-detail capability.
     *
     * Providers that index person/cast data (e.g. TMDB `/person/{id}`)
     * implement this so callers can fetch a person's biography, filmography,
     * and credits without falling back to a hard-wired TMDB call.
     *
     * `personId` is the provider's own numeric person identifier.
     * `language` is an optional BCP 47 language tag (e.g. `'en-US'`);
     * omitting it lets the provider apply its own default.
     *
     * The return shape is intentionally open (`unknown`) — callers that read
     * structured fields are expected to be co-located with the provider
     * implementation. The host resolves person detail via the highest-priority
     * provider that declares this capability, with TMDB as the fallback when
     * no configured provider supports it.
     *
     * Providers that do not index person data simply omit this method. The
     * `invokeProviderGetPersonDetail` helper in `plugin-context.ts` no-ops
     * and returns `null` when absent.
     */
    getPersonDetail?(ctx: PluginContext, personId: number, language?: string): Promise<unknown>;

    /**
     * Optional cross-id resolution capability.
     *
     * Providers that expose a foreign-id bridge endpoint (e.g. TMDB
     * `/find/{external_id}`) implement this so callers can resolve an
     * IMDB/TVDB/etc. id to the provider's own id without a fuzzy title
     * search. Returns `null` on any miss, availability failure, or
     * unrecognised source — callers fall through to Phase 2 title search.
     *
     * The `source` parameter names the external-id kind being resolved;
     * `mediaType` is the expected media category ('movie' | 'tv') so
     * providers that index both can return the correct result set.
     *
     * Providers that do not expose a cross-reference endpoint simply omit
     * this method. The `invokeProviderResolveExternalId` helper in
     * `plugin-context.ts` no-ops and returns `null` when absent.
     */
    resolveExternalId?(
        ctx: PluginContext,
        externalId: string,
        source: ProviderExternalIdSource,
        mediaType: 'movie' | 'tv',
    ): Promise<ProviderResolveExternalIdResult | null>;

    settings?: SettingsConfig;
}

// ---------------------------------------------------------------------------
// Trickplay provider definition
// ---------------------------------------------------------------------------

export interface TrickplayProviderDefinition {
    id: string;
    /**
     * Your plugin's version, e.g. `'1.2.0'`.
     *
     * Optional only for backward compatibility — DECLARE IT. It is what the
     * admin UI shows an operator, and without it there is nothing to show: a
     * drop-in has no manifest, and the host will not invent a number.
     */
    version?: string;
    capabilities: { http?: boolean; cache?: boolean; database?: boolean };

    fetchParams(
        ctx: PluginContext,
        params: { mediaItemId: string; width: number },
    ): Promise<TrickplayParams | null>;

    /**
     * Optional batch discovery — returns every available width for the item
     * in one call. Providers that can enumerate their storage cheaply (e.g.
     * one `readdir` reveals all widths) should implement this; the
     * trickplay-params-sync task prefers it over N independent `fetchParams`
     * calls.
     *
     * Return empty array when nothing is available; null when the provider
     * is disabled / not applicable to this item.
     */
    discoverParams?: (
        ctx: PluginContext,
        params: { mediaItemId: string },
    ) => Promise<Array<{ width: number; params: TrickplayParams }> | null>;

    settings?: SettingsConfig;
}

// ---------------------------------------------------------------------------
// Watch sync definition
// ---------------------------------------------------------------------------

export interface WatchSyncDefinition {
    id: string;
    name: string;
    version: string;
    capabilities: {
        http?: boolean;
        database?: boolean;
        allowedDomains?: string[];
    };

    /**
     * Display name shown in admin UI for this provider. Mirrors the legacy
     * `manifest.watchSyncConfig.providerName`.
     */
    providerName: string;

    /**
     * Check provider reachability/configuration. Engine short-circuits push
     * and pull when this returns false (e.g., creds missing, host down).
     */
    isAvailable(ctx: PluginContext): Promise<boolean>;

    /**
     * Resolve internal media UUIDs → provider-specific IDs. Plugins may
     * batch into a single API call. Return only successfully resolved
     * items; missing items are treated as unresolved by the engine.
     */
    resolveIds(ctx: PluginContext, items: WatchSyncResolveItem[]): Promise<WatchSyncResolvedId[]>;

    /**
     * Push watched/unwatched + progress state in batches. Distinguish
     * terminal failures (drain from queue) from transient (retry next
     * cycle) via `WatchSyncPushResult.successful` /
     * `drainedAsSkipped` / `failed`.
     */
    pushWatchState(
        ctx: PluginContext,
        items: WatchStateChange[],
        signal?: AbortSignal,
    ): Promise<WatchSyncPushResult>;

    /**
     * User-ids that have LINKED this provider. `null` ⇒ do not gate the push
     * queue (e.g. Jellyfin). The ENGINE intersects this with direction prefs;
     * plugins never read preferences.
     */
    listLinkedUsers?(ctx: PluginContext): Promise<string[] | null>;

    /**
     * User ids eligible for provider-to-Lumastra pulls when that audience is
     * broader than the explicitly linked push audience. When omitted, the
     * engine falls back to `listLinkedUsers` for backwards compatibility.
     *
     * This must never widen outbound push scope. It exists for providers whose
     * operator credential may read matching local users without provisioning a
     * per-user credential, such as AudiobookShelf.
     */
    listPullUsers?(ctx: PluginContext): Promise<string[] | null>;

    /**
     * Pull watch state from the provider. Optional — implement when the
     * provider supports reading watch history. Plugins that honour cursors
     * read `opts.cursors` and emit `newCursors` for incremental sync.
     */
    pullWatchState?(ctx: PluginContext, opts?: WatchSyncPullOptions): Promise<WatchSyncPullResult>;

    /**
     * Called after a pull with the provider usernames whose items the engine could
     * NOT import (the write failed, or the cursor was held). Optional. A plugin that
     * remembers what a pull covered (for example "I walked the whole list") must
     * forget it for these users, so the next pull covers it again.
     */
    pullImportFailed?(ctx: PluginContext, providerUsernames: string[]): Promise<void> | void;

    /**
     * Resume-position-only push. Optional — implement when the provider
     * exposes a separate seek/position endpoint distinct from "mark
     * watched". Used by the engine for high-frequency position writes
     * that shouldn't trigger watched-state changes.
     *
     * SHOULD return a {@link WatchSyncPushResult} so the engine can mark only
     * the positions the provider actually accepted as pushed. Returning `void`
     * is still honoured for backward compatibility, but it means the engine
     * cannot tell a delivered position from a dropped one and drains the whole
     * page either way — a transient provider failure then loses that position
     * permanently, because nothing will retry it.
     *
     * Only `successful` and `drainedAsSkipped` are read here (same (user,
     * media) keying as `pushWatchState`); the counters are advisory.
     */
    pushResumePosition?(
        ctx: PluginContext,
        items: ResumePositionItem[],
        signal?: AbortSignal,
    ): Promise<WatchSyncPushResult | void>;

    settings?: SettingsConfig;
}

// ---------------------------------------------------------------------------
// Feature definition
// ---------------------------------------------------------------------------

/**
 * Where a widget mounts. Additive — a host that does not know a placement
 * simply never renders it, so declaring a newer one degrades to invisible
 * rather than breaking the plugin.
 */
export type WidgetPlacement =
    /** The reorderable home grid. */
    | 'home'
    /** Fixed full-width band under the home hero. Not user-reorderable. */
    | 'below-hero'
    /** A section inside the media detail view, below the built-in metadata. */
    | 'detail'
    /**
     * A section on the viewer's own settings → connections page. Where a
     * watch-sync or scrobble connector puts its "link my account" UI: the
     * per-user credential store has existed for a while with nowhere for a
     * user to actually populate it.
     */
    | 'settings-user'
    /**
     * A region inside the video player. See `playerRegion`.
     *
     * Structurally contained: your DOM sits BELOW the host controls layer, so
     * you cannot cover pause or seek however you style yourself; the container
     * is `pointer-events: none` and you opt individual elements back in; and
     * playback state reaches you only through `ctx.playback` — never the video
     * element, the hls instance, or a stream URL.
     */
    | 'player';

export interface FeatureWidget {
    /** Stable id; host widget id becomes `plugin:<featureId>:<id>`. */
    id: string;
    /** Display label (TOC + home widget config). */
    title: string;
    /**
     * Path (relative to the feature's route base `/api/plugins/<featureId>`) of
     * the ESM module the host fetches + mounts. Must be served by one of this
     * feature's own `routes`. e.g. `/widget.js`.
     */
    entry: string;
    /**
     * Surface to mount on:
     *   - `'home'` (default) — the reorderable/hideable home widget grid.
     *   - `'below-hero'` — a fixed full-width banner slot directly under the home
     *     hero, above the grid. Not draggable; not in the widget-config editor
     *     (control it via the plugin's own settings). Good for announcements.
     */
    placement?: WidgetPlacement;
    /** Whether the widget is visible by default (admins can reorder/hide). 'home' grid only. */
    defaultVisible?: boolean;
    /**
     * `detail` placement only: the media types this widget mounts for. Omit to
     * mount on all of them.
     *
     * Uses the PUBLIC vocabulary — `series`, not the `tv` the database stores —
     * because that is what every surface outside the database speaks.
     */
    forMediaTypes?: ReadonlyArray<
        'movie' | 'series' | 'season' | 'episode' | 'audiobook' | 'album' | 'artist' | 'track'
    >;
    /**
     * `player` placement only. `panel` is a host-toggled drawer the viewer
     * opens deliberately — nothing of yours renders until they do, so an
     * installed player plugin costs nothing during ordinary playback. Defaults
     * to `panel`; `top-right` is a passive HUD region for a widget that only
     * displays.
     */
    playerRegion?: 'panel' | 'top-right';
    /**
     * Space the host reserves, in pixels, while your module is being fetched
     * and mounted — so the page does not shove content around when you appear.
     * Released once `mount()` settles; an empty host collapses on its own.
     */
    minHeightPx?: number;
    /**
     * Have the host draw its own card frame around your mount element, with
     * `title` as the header.
     *
     * The cheapest way to look like part of the app: whatever you render
     * inside, the outermost frame is the host's and matches every native card.
     * Defaults to false so existing widgets, which draw their own, are
     * unchanged.
     */
    chrome?: boolean;
}

/**
 * Read-only playback state for a `player`-placement widget.
 *
 * This is the WHOLE surface, and the omissions are the contract: no video
 * element, no hls instance, no stream URL (those carry session material), no
 * player store. Position and item id are enough for every overlay worth
 * building.
 */
export interface PlaybackSnapshot {
    /** Internal id of what is playing, when known. */
    mediaItemId: string | null;
    mediaType: string | null;
    positionSeconds: number;
    durationSeconds: number;
    paused: boolean;
    isLive: boolean;
}

/**
 * What the host passes to your widget module's `mount()`.
 *
 * A widget module is an ESM file served by one of your own feature routes,
 * exporting `mount(element, context)`. Return a cleanup function (or an object
 * with `destroy()`) and the host calls it when the widget goes away.
 *
 * Be clear-eyed about what this is: your code runs in the host document, so it
 * can already reach `document`, `fetch` with the viewer's cookies, and
 * `localStorage` — `capabilities.browserUi` is a disclosure, not a sandbox.
 * What this context defines is what the host actively PROVIDES and commits to
 * keeping stable, so you never have to reach into host markup and fossilize it.
 */
export interface WidgetMountContext {
    /** Your own route base, `/api/plugins/<featureId>`. */
    apiBase: string;
    /**
     * Resolved values of the documented theme tokens. You can also just use
     * `var(--color-surface-900)` in CSS — your DOM inherits them. This bag is
     * for when you need the value in JavaScript (a canvas, a chart library).
     */
    theme: Record<string, string>;
    /** The viewer, or null. `userId` is the data key; `username` is display. */
    user: PluginUser | null;
    /** Which surface this instance mounted on. */
    surface: WidgetPlacement;
    /**
     * `player` placement: read-only playback state.
     *
     * `getSnapshot()` is cheap and safe to poll. `subscribe()` delivers at most
     * ~2Hz plus edges (play, pause, seek, item change) and returns an
     * unsubscribe function; your callback is wrapped, and **three consecutive
     * throws disarm it for the rest of the session** — there is nobody at the
     * keyboard to fix a plugin mid-film.
     */
    playback?: {
        getSnapshot(): PlaybackSnapshot;
        subscribe(cb: (snapshot: PlaybackSnapshot) => void | PromiseLike<unknown>): () => void;
    };
    /**
     * `detail` placement: the item currently in view.
     *
     * The host REMOUNTS your widget when this changes (the detail view can
     * re-target in place, e.g. clicking a similar title), so you never have to
     * diff it — treat every mount as a fresh item.
     */
    item?: {
        /** Internal UUID. The only stable key; store this, never the title. */
        id: string;
        /** Public vocabulary: 'movie' | 'series' | 'episode' | … */
        mediaType: string;
        title: string;
        year: number | null;
        /** External ids the host already resolved. Never session material. */
        externalIds: { tmdb?: string; imdb?: string; tvdb?: string };
    };
}

/** The shape a widget's entry module must export. */
export interface WidgetModule {
    mount(
        element: HTMLElement,
        context: WidgetMountContext,
    ): void | (() => void) | { destroy?(): void };
}

/**
 * A page the plugin owns, served at `/p/<featureId>[/<pageId>]` inside the
 * normal app shell — sidebar, theme and all.
 *
 * Use this when a widget is the wrong shape: a management UI, a dashboard, a
 * report. Your data still comes from your own feature routes, so a page adds
 * no new server surface.
 */
export interface FeaturePage {
    /** Slug. `index` serves `/p/<featureId>`; anything else adds `/<id>`. */
    id: string;
    /** Shown as the page heading and, if you declare `nav`, in the sidebar. */
    title: string;
    /** ESM entry served by one of your own routes. Same contract as a widget. */
    entry: string;
    /**
     * Who may open it. ENFORCED SERVER-SIDE, and a denied viewer gets a 404
     * rather than a 403 — a 403 would confirm the page exists, telling them
     * which plugins are installed.
     */
    access?: { adminOnly?: boolean; groups?: string[] };
    /**
     * Add a sidebar entry pointing at this page. Omit for pages reached only
     * from your own UI.
     */
    nav?: {
        /** Icon name from the host's navigation icon set. Unknown names fall back. */
        icon?: string;
        /** Existing sidebar section id to nest under; omit for top level. */
        section?: string;
        displayOrder?: number;
    };
}

export interface FeatureDefinition {
    id: string;
    /**
     * Your plugin's version, e.g. `'1.2.0'`.
     *
     * Optional only for backward compatibility — DECLARE IT. It is what the
     * admin UI shows an operator, and without it there is nothing to show: a
     * drop-in has no manifest, and the host will not invent a number. Every
     * other contract family already requires this.
     */
    version?: string;
    /**
     * Capability declarations. `browserUi` is REQUIRED to register `widgets`
     * (it executes plugin-authored JS in the host page — a disclosure flag, not
     * a sandbox; see plugins/CLAUDE.md trust boundary). `database` grants raw
     * `ctx.sql`.
     */
    capabilities?: {
        database?: boolean;
        browserUi?: boolean;
    };
    routes: FeatureRoute[];
    /** UI widgets contributed to the dashboard. Requires `capabilities.browserUi`. */
    widgets?: FeatureWidget[];
    /**
     * Pages this plugin owns, at `/p/<id>`. Requires `capabilities.browserUi` —
     * a page runs your JavaScript in the host document exactly as a widget does.
     */
    pages?: FeaturePage[];
    settings?: SettingsConfig;
    onStartup?(ctx: PluginContext): Promise<void>;

    /**
     * Contribute a row of media to the home page.
     *
     * Return IDS, not items — the host resolves them through the viewer's own
     * access path, so you cannot surface media this viewer is not allowed to
     * see, and you do not have to think about library scope or age ratings at
     * all. The host renders the row with its own section renderer, so it looks
     * native and works on every client with no JavaScript of yours in the page.
     *
     * Budget: 500ms, at most 3 sections, 30 items each. A section whose every
     * item is hidden from this viewer is dropped rather than shown empty. Cache
     * your own work in `ctx.cache` — the host does not cache this for you.
     */
    homeSections?(
        ctx: PluginContext,
    ): Promise<Array<{ id: string; title: string; mediaItemIds: string[] }>>;

    /**
     * Contribute badges to media cards — a quality flag, an external rating, a
     * "requested by" marker.
     *
     * A DATA hook, not a UI mount point, and deliberately so: your badges are
     * merged server-side, so they appear on every client including the mobile
     * and TV apps, with no browser code of yours running anywhere.
     *
     * Called ONCE per batch of cards, never per card. Return only the ids you
     * have something to say about; ids the host did not ask about are ignored.
     *
     * This is the hottest read path in the app, so the rules are strict and
     * silent: you get **50ms**, at most **3 badges per item** survive across
     * all plugins, each badge is validated against the host's own shape, and a
     * throw or an overrun costs you your badges and nothing else. Do your
     * lookups against `ctx.cache` or your own table — not a network call.
     */
    decorateCards?(
        ctx: PluginContext,
        refs: Array<{ mediaItemId: string; mediaType: string }>,
    ): Promise<
        | Record<string, Array<{ text: string; color: string; icon?: string; title?: string }>>
        | ReadonlyMap<string, Array<{ text: string; color: string; icon?: string; title?: string }>>
    >;
}

// ---------------------------------------------------------------------------
// Auth provider definition
//
// The most dangerous contract in the system, and deliberately the narrowest.
//
// An auth provider is a CREDENTIAL VERIFIER AND CLAIMS SOURCE, invoked only
// during an explicit login attempt on a dedicated route. It returns a verdict;
// the HOST maps identity, decides provisioning, builds permissions, mints the
// session and sets the cookie. There is no per-request hook of any kind — a
// provider that hangs can break its own login button and nothing else.
//
// Installing one changes NOTHING. A provider stays inert until an operator
// names it in an environment allowlist, which puts "who can log in" back at
// deploy-time trust rather than install-time. That is the condition under
// which this contract is defensible at all.
// ---------------------------------------------------------------------------

/** A stable claim about one person, as the external system knows them. */
export interface AuthProviderIdentity {
    /**
     * Provider-stable, immutable subject key — an LDAP entryUUID, a Discord or
     * Telegram user id.
     *
     * NEVER a display name, NEVER an email, and never reused for a different
     * person. This is what the host keys its identity ledger on, so a subject
     * that gets recycled hands the new holder the previous one's account.
     */
    subject: string;
    /**
     * Preferred username. A PROVISIONING HINT ONLY — the host never looks a
     * user up by it. Usernames are mutable and reusable; the subject is not.
     */
    username?: string;
    displayName?: string;
    email?: string;
    /** Set true only if YOU verified it. The host treats absent as false. */
    emailVerified?: boolean;
    /**
     * Groups as the external system reports them. The host maps these to
     * permissions — and STRIPS any admin-conferring group unless the operator
     * separately granted this provider the right to assert admin.
     */
    groups?: string[];
}

/**
 * The answer to a login attempt.
 *
 * Note what cannot be expressed: there is no user id. A provider cannot say
 * "log this person in as user X" — only "these are the claims I verified".
 */
export type AuthProviderVerdict =
    | { ok: true; identity: AuthProviderIdentity }
    | {
          ok: false;
          /**
           * `invalid_credentials` — a normal failed login; counts toward the
           * per-username lockout.
           * `unavailable` — your backend is down. Also a generic failure to the
           * user, but it does NOT consume that account's lockout budget: an
           * outage is not an attack on that account.
           */
          reason: 'invalid_credentials' | 'unavailable';
      };

export interface AuthProviderDefinition {
    id: string;
    /** Shown on the host-rendered login button. */
    name: string;
    version: string;
    /**
     * `database` and `browserUi` are REFUSED for this contract. Identity
     * mapping is the host's job, so no raw SQL rationale exists; and no
     * third-party JavaScript renders on the pre-auth login page, ever — a
     * plugin that could script `/login` could harvest the native password
     * field.
     */
    capabilities?: { http?: boolean; cache?: boolean; allowedDomains?: string[] };

    /**
     * Credentials kind (LDAP and similar).
     *
     * Receives the raw password, which is inherent to being a bind verifier —
     * declare `allowedDomains` so the host can bound where it may travel. The
     * host has already bounded the inputs (username ≤128, password ≤1024) and
     * passes them verbatim: escaping for your protocol, including LDAP filter
     * and DN escaping, is YOUR responsibility.
     *
     * 10s budget. A throw, a timeout or a malformed verdict all resolve to
     * `unavailable` — this contract fails CLOSED, unlike `authorizePlayback`,
     * because an auth check that fails open is an authentication bypass.
     */
    verifyCredentials?(
        ctx: PluginContext,
        input: { username: string; password: string; clientIp: string },
    ): Promise<AuthProviderVerdict>;

    /**
     * Redirect kind (Discord, Telegram and similar).
     *
     * The HOST owns the transaction: it generates `state`, binds it to the
     * browser with an HttpOnly cookie and enforces single use. You return an
     * absolute https URL to send the browser to, plus any opaque data you need
     * echoed back. You get no cookie access and no ability to choose a redirect
     * target other than the URL you return.
     */
    beginLogin?(
        ctx: PluginContext,
        input: { callbackUrl: string; state: string },
    ): Promise<{ redirectUrl: string; txData?: string }>;
    completeLogin?(
        ctx: PluginContext,
        input: { params: Record<string, string>; state: string; txData?: string },
    ): Promise<AuthProviderVerdict>;

    settings?: SettingsConfig;
}

// ---------------------------------------------------------------------------
// Lyrics provider definition
//
// Same acquisition shape as subtitles: the host already knows how to store and
// serve lyrics for a track, so a provider's job is to find them and hand them
// over. Until now lyrics came from exactly one hardcoded source, and adding a
// second meant editing core.
// ---------------------------------------------------------------------------

/** What the host is looking for. */
export interface LyricsSearchQuery {
    /** Internal track UUID — the stable key. */
    trackId: string;
    title: string;
    artist: string | null;
    album: string | null;
    /** Track length in seconds, when known. Services match on it. */
    durationSeconds?: number | null;
}

export interface LyricsResult {
    /** Unsynced lyrics. At least one of `plain` / `synced` must be present. */
    plain?: string | null;
    /** Synced lyrics in LRC format. Preferred by the host when both exist. */
    synced?: string | null;
}

export interface LyricsProviderDefinition {
    id: string;
    name?: string;
    version?: string;
    description?: string;
    capabilities?: {
        http?: boolean;
        cache?: boolean;
        database?: boolean;
        allowedDomains?: string[];
    };
    settings?: SettingsConfig;

    /** False keeps this provider out of every lookup (e.g. no API key). */
    isConfigured?(ctx: PluginContext): boolean | Promise<boolean>;

    /**
     * Find lyrics for a track. Return `null` when you have none — that is a
     * normal outcome, not an error. Throwing is for genuine failures; the host
     * isolates it so one provider cannot break a lookup for the others.
     */
    fetchLyrics(
        ctx: PluginContext,
        query: LyricsSearchQuery,
        signal?: AbortSignal,
    ): Promise<LyricsResult | null>;
}

// ---------------------------------------------------------------------------
// Subtitle provider definition
//
// For plugins that FETCH subtitles from an external service (OpenSubtitles and
// friends). Deliberately an acquisition contract, not a serving one: the host
// already knows how to serve an external subtitle file, so a provider's job
// ends at handing over the bytes. What it downloads is persisted as an external
// subtitle for the media file and served by the normal path from then on.
// ---------------------------------------------------------------------------

/** What the host is looking for. Populate as much as your service supports. */
export interface SubtitleSearchQuery {
    /** Internal media item UUID — a stable key, safe to cache against. */
    mediaItemId: string;
    mediaType: SdkMediaType;
    title: string;
    year?: number;
    /** Present for episodes. */
    season?: number;
    episode?: number;
    /** Series title when `mediaType` is 'episode'. */
    seriesTitle?: string;
    /** ISO 639-1 language codes the viewer wants, most-wanted first. */
    languages: string[];
    /** External ids the host knows (`imdb`, `tmdb`, `tvdb`), when available. */
    externalIds?: Record<string, string>;
    /** Basename of the media file — many services match on release name. */
    fileName?: string;
    /** Size in bytes, for services that match on an exact file hash. */
    fileSize?: number;
}

/** One subtitle a provider is offering. */
export interface SubtitleCandidate {
    /**
     * Provider-scoped identifier, handed straight back to `download()`. Opaque
     * to the host — put whatever you need in it.
     */
    id: string;
    /** ISO 639-1 code. */
    language: string;
    format: 'srt' | 'ass' | 'ssa' | 'vtt' | 'sub';
    /** Forced/foreign-parts-only track. */
    isForced?: boolean;
    /** Includes hearing-impaired cues. */
    isSDH?: boolean;
    /** Release this was timed against — shown to the user when choosing. */
    releaseName?: string;
    /** Popularity and quality hints; used for ranking when present. */
    downloadCount?: number;
    rating?: number;
    /**
     * True when this matched the file exactly (a movie-hash hit rather than a
     * title search).
     *
     * The host ranks the viewer's LANGUAGE preference first and this second, so
     * a hash match wins between two candidates in the same language — where it
     * is the difference between subtitles that stay in sync and subtitles that
     * drift — but never promotes a language the viewer did not ask for. Keep
     * returning title-search results in preferred languages.
     */
    hashMatch?: boolean;
    /** Optional free-form detail for the picker UI. */
    uploader?: string;
    comment?: string;
}

/** The actual subtitle content. */
export interface SubtitleDownload {
    content: string | Uint8Array;
    format: 'srt' | 'ass' | 'ssa' | 'vtt' | 'sub';
    /** Overrides the candidate's language if the file turned out different. */
    language?: string;
}

export interface SubtitleProviderDefinition {
    id: string;
    name?: string;
    version?: string;
    description?: string;
    author?: string;
    capabilities?: {
        http?: boolean;
        cache?: boolean;
        database?: boolean;
        allowedDomains?: string[];
    };
    settings?: SettingsConfig;

    /** False keeps the provider out of every search (e.g. no API key yet). */
    isConfigured?(ctx: PluginContext): boolean | Promise<boolean>;

    /**
     * Find candidates. Return an empty array when nothing matches — throwing is
     * for genuine failures (the host isolates a throw so one broken provider
     * cannot take a search down, but it will be logged).
     */
    search(
        ctx: PluginContext,
        query: SubtitleSearchQuery,
        signal?: AbortSignal,
    ): Promise<SubtitleCandidate[]>;

    /** Fetch one candidate's content by the `id` you returned from `search`. */
    download(
        ctx: PluginContext,
        candidateId: string,
        signal?: AbortSignal,
    ): Promise<SubtitleDownload>;
}

// ---------------------------------------------------------------------------
// Integration definition
// ---------------------------------------------------------------------------

export interface IntegrationDefinition {
    id: string;
    /**
     * Your plugin's version, e.g. `'1.2.0'`.
     *
     * Optional only for backward compatibility — DECLARE IT. It is what the
     * admin UI shows an operator, and without it there is nothing to show: a
     * drop-in has no manifest, and the host will not invent a number. Every
     * other contract family already requires this.
     */
    version?: string;
    capabilities: {
        http?: boolean;
        database?: boolean;
        allowedDomains?: string[];
        /**
         * Enables the inbound webhook endpoint for this integration at
         * `POST /api/plugin-webhooks/<id>`. REQUIRED for `handleWebhook` to be
         * reachable, and only half the gate: the endpoint stays 404 until the
         * operator also sets this integration's `webhookSecret` secret, which
         * the caller must present. See `handleWebhook`.
         */
        webhook?: boolean;
    };

    /**
     * Host event types this integration wants delivered to `sendNotification`.
     * Use `'*'` for every type. Omit to receive nothing — delivery is opt-in,
     * so declaring `sendNotification` alone never starts traffic.
     *
     * Published today:
     *   `org.lumastra.task.run.started` / `.completed` / `.failed` /
     *   `.cancelled` / `.cancelling` / `.progress` / `.stage.completed`,
     *   `org.lumastra.task.cost.threshold.exceeded`,
     *   `org.lumastra.media.item.added` (one event per item that became
     *   playable, NOT the operator webhook's batched form),
     *   `org.lumastra.playback.started` / `.paused` / `.resumed` / `.stopped`.
     *
     * Playback events say who is watching what, right now — which is the point
     * for a presence or scrobbling plugin, and why they are opt-in per type and
     * visible on the plugin's admin card.
     */
    subscribes?: string[];

    /**
     * Handle an inbound HTTP webhook posted to
     * `POST /api/plugin-webhooks/<id>`.
     *
     * Reachable only when `capabilities.webhook` is true AND the integration
     * has a `webhookSecret` secret set, which the caller must send as
     * `X-Plugin-Webhook-Secret` (compared in constant time). The endpoint is
     * unauthenticated otherwise — that secret IS the authentication, because
     * the senders are external systems with no session.
     *
     * `payload` is the parsed JSON body, or the raw string when the body is not
     * JSON. A returned value is serialised as the JSON response body; return
     * nothing for `204`.
     */
    handleWebhook?(ctx: PluginContext, payload: unknown): Promise<unknown>;

    /**
     * Veto a stream before it starts.
     *
     * Called before the host opens its session transaction, alongside (not
     * instead of) the host's own stream policy. Return `{ allow: false, reason }`
     * to refuse; the reason is shown to the user.
     *
     * **Fails open.** A throw, a hang past ~2s, or a malformed answer is ignored
     * and playback proceeds. That is deliberate: a policy that stops being
     * enforced is a bad afternoon, whereas a media server that refuses every
     * stream because a plugin broke is an outage. If you need hard enforcement,
     * your gate has to be reliable enough to provide it.
     *
     * Keep it fast — it sits between the user pressing play and playback
     * starting. Anything slow (a network round-trip to a licence server) should
     * be cached, not awaited here.
     */
    authorizePlayback?(
        ctx: PluginContext,
        request: {
            userId: string;
            username: string;
            mediaId: string;
            /** `direct`, `remux` or `transcode` — what the client asked for. */
            playMethod: string;
            deviceId?: string;
            ipAddress?: string;
        },
    ): Promise<{ allow: boolean; reason?: string }>;

    /**
     * Receive a host event. Called once per event for each type named in
     * `subscribes`.
     *
     * Delivery is in-process, at-most-once, and time-boxed: there is no durable
     * queue, no retry, and no cross-replica fan-out (unlike operator webhooks).
     * A throw is logged and isolated — it never fails the task run or scan that
     * emitted the event — but it also means the event is simply gone. Persist
     * anything you must not lose.
     */
    sendNotification?(ctx: PluginContext, event: NotificationEvent): Promise<void>;

    settings?: SettingsConfig;
}

// ---------------------------------------------------------------------------
// Media source definition
//
// For library integrations that scan/sync media items into the media_items
// table (e.g. Kavita, Audiobookshelf, file-system-scan). These expose a
// mandatory scan/fullSync/getStatus surface plus optional filesystem-watcher
// slots (all-or-nothing: declare all 4 watcher methods or none).
// ---------------------------------------------------------------------------

export interface ScanResult {
    added: number;
    updated: number;
    removed: number;
    unmatched: number;
    skipped: number;
    durationMs: number;
    errors: string[];
    /**
     * Files added WITHOUT asking the metadata provider (its key was rejected,
     * or it is not configured). Optional — sources without metadata matching
     * omit it.
     */
    metadataUnavailable?: number;
    /** Why `metadataUnavailable` is non-zero: 'auth' = key rejected. */
    metadataProviderError?: 'auth' | 'unavailable';
    /** Provider id behind `metadataProviderError`, when known. */
    metadataProviderId?: string;
}

export interface SyncResult {
    added: number;
    updated: number;
    removed: number;
    durationMs: number;
    errors: string[];
}

export interface MediaSourceStatus {
    lastScanAt?: Date;
    lastFullSyncAt?: Date;
    itemCount: number;
    isScanning: boolean;
    lastError?: string;
}

export interface WatcherStatus {
    active: boolean;
    paths: number;
    lastEventAt?: Date;
    lastEventFile?: string;
    leaderElsewhere?: boolean;
    leaderHeartbeatAt?: string;
    leaderError?: string;
    /** `partial` while some directories are not being watched (watch limit, unreadable dirs). */
    coverage?: 'full' | 'partial';
    /** Why live updates are incomplete: `watch_limit`, `network_shares`, `unreadable_dirs`. */
    limitations?: string[];
    /** Native watcher with network roots: reconcile interval in seconds; 0 = disabled. */
    networkReconcileSecs?: number;
}

export interface MediaSourceSourceConfig {
    supportsIncrementalScan: boolean;
    defaultScanIntervalHours: number;
    /** True if the plugin implements the watcher methods (startWatching/stopWatching/etc.) */
    supportsWatching?: boolean;
}

/**
 * A library the host can ingest from.
 *
 * ⚠️ THE HOST DOES NOT CALL `scan()` FOR YOU.
 *
 * Registering a media source records the definition and makes it configurable;
 * it does not put it on a schedule. There is no generic scanner that walks
 * registered sources — every builtin media source ships a PAIRED TASK that
 * calls its own `scan()`, and a plugin must do the same:
 *
 * ```js
 * export default definePlugin({
 *     mediaSources: [{ id: 'my-source', scan, fullSync, getStatus }],
 *     tasks: [{
 *         id: 'my-source-scan',
 *         schedule: { every: '6h' },
 *         async execute(ctx) {
 *             return { success: true, itemsProcessed: (await scan(ctx, {})).imported };
 *         },
 *     }],
 * });
 * ```
 *
 * Ship only the media source and nothing will ever run. This is stated here
 * because the contract's shape — `scan`, `fullSync`, `getStatus`,
 * `startWatching` — reads exactly like something the host drives, and it is
 * the reverse: the host provides the ingest primitives, your task provides the
 * cadence.
 */
export interface MediaSourceDefinition {
    id: string;
    name?: string;
    version?: string;
    description?: string;
    author?: string;
    capabilities?: {
        http?: boolean;
        cache?: boolean;
        database?: boolean;
        allowedDomains?: string[];
    };
    settings?: { fields: SettingField[] };

    isConfigured?(ctx: PluginContext): boolean | Promise<boolean>;
    isAvailable?(ctx: PluginContext): boolean | Promise<boolean>;
    isEnabled?(ctx: PluginContext): boolean | Promise<boolean>;

    sourceConfig: MediaSourceSourceConfig;

    // Required core operations
    scan(ctx: PluginContext, opts: { libraryPathId?: string }): Promise<ScanResult>;
    fullSync(ctx: PluginContext): Promise<SyncResult>;
    getStatus(ctx: PluginContext): Promise<MediaSourceStatus>;

    // Optional filesystem-watcher slots — all-or-nothing.
    // Future: Jellyfin or Audiobookshelf could implement these with event subscriptions.
    startWatching?(ctx: PluginContext): Promise<void>;
    stopWatching?(ctx: PluginContext): Promise<void>;
    getWatcherStatus?(ctx: PluginContext): Promise<WatcherStatus>;
    updateWatcherTargets?(ctx: PluginContext): Promise<void>;
}

// ---------------------------------------------------------------------------
// External service definition
//
// For API-key-only services with no method surface beyond settings and
// availability (e.g. OpenAI, Voyage AI, Azure OpenAI, Anthropic). These
// are not metadata providers, not integrations (no webhook/notification
// surface), and not tasks — they are ambient credentials that other tasks
// reference. The registry surfaces them in the admin UI for settings/key
// management.
// ---------------------------------------------------------------------------

export interface ExternalServiceDefinition {
    id: string;
    name?: string;
    version?: string;
    description?: string;
    author?: string;
    /** Capability hints for the admin UI (e.g. `{ http: true }`). */
    capabilities?: {
        http?: boolean;
        cache?: boolean;
        database?: boolean;
        allowedDomains?: string[];
    };
    settings?: { fields: SettingField[] };
    /**
     * True if the operator has supplied the credentials/config required to
     * use the service. Checked at startup and surfaced in the admin UI.
     */
    isConfigured?(ctx: PluginContext): boolean | Promise<boolean>;
    /**
     * True if the service is reachable AND configured. Defaults to
     * `isConfigured` when omitted (most API-key-only services cannot be
     * pinged without making a real API call).
     */
    isAvailable?(ctx: PluginContext): boolean | Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Multi-contract plugin aggregate
//
// TaskDefinition is generic-contravariant in TInput. To allow a typed
// TaskDefinition<MyInput, R> to be stored in a TaskDefinition[] array,
// callers can use `as unknown as AnyTaskDefinition` or use definePlugin().
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTaskDefinition = TaskDefinition<any, any, any>;

/**
 * A multi-contract plugin: one bundle registering several contracts at once.
 *
 * Every family the SDK can define is representable here — a plugin that ships
 * a watch-sync plus its backfill task plus a settings surface is ONE install,
 * not three.
 *
 * **Id namespacing.** The registry rejects one id claimed by two different
 * contract kinds, so the contracts in a bundle must not all share a name. The
 * host requires every id to be the plugin's manifest `name` or to start with
 * `<name>-`, which both prevents cross-plugin id squatting and gives each
 * contract a distinct id (e.g. `trakt` + `trakt-backfill`).
 */
export interface PluginDefinition {
    tasks?: AnyTaskDefinition[];
    providers?: ProviderDefinition[];
    trickplayProviders?: TrickplayProviderDefinition[];
    watchSyncs?: WatchSyncDefinition[];
    features?: FeatureDefinition[];
    integrations?: IntegrationDefinition[];
    mediaSources?: MediaSourceDefinition[];
    externalServices?: ExternalServiceDefinition[];
    subtitleProviders?: SubtitleProviderDefinition[];
    lyricsProviders?: LyricsProviderDefinition[];
    authProviders?: AuthProviderDefinition[];
}

// ---------------------------------------------------------------------------
// Run schema (wire/storage)
// ---------------------------------------------------------------------------

export const StageSchema = z.object({
    id: z.string(),
    label: z.string(),
    state: z.enum(['waiting', 'active', 'completed', 'failed', 'skipped']),
    processed: z.number().int().nonnegative().optional(),
    total: z.number().int().nonnegative().optional(),
    currentItem: z.string().optional(),
    startedAt: z.string().datetime().optional(),
    completedAt: z.string().datetime().optional(),
    etaMs: z.number().finite().nonnegative().optional(),
});

export const TriggerSchema = z.object({
    // Locked to TRIGGER_KINDS via the readonly tuple cast so the wire schema,
    // the runtime list, the `TriggerKind` union, and `TaskContext.mode` can
    // never drift independently.
    kind: z.enum(TRIGGER_KINDS as readonly [TriggerKind, ...TriggerKind[]]),
    by: z.string().optional(),
    sourceRoute: z.string().optional(),
    /**
     * Set on a run the host started to continue a run a worker restart
     * interrupted (`resumeAfterRestart`). `count` is this run's position in
     * the chain (1 = first resume); `rootRunId` is the run the operator
     * started; `previousRunId` the run this one continues.
     */
    resume: z
        .object({
            rootRunId: z.string(),
            previousRunId: z.string(),
            count: z.number().int().min(1),
            max: z.number().int().min(1),
        })
        .optional(),
});

export const ActorSchema = z.object({
    type: z.enum(['user', 'service', 'system', 'webhook']),
    id: z.string().optional(),
    via: z.enum(['ui', 'pat', 'cron', 'webhook', 'in-process']).optional(),
});

export const RunStateSchema = z.enum([
    'pending',
    'active',
    'cancelling',
    'completed',
    'failed',
    'cancelled',
]);

/** Bounded, redacted count metadata safe to include in REST runs and SSE events. */
export const RunCountSummarySchema = z.object({
    count: z
        .number()
        .int()
        .safe()
        .nonnegative()
        .max(1_000_000_000)
        .describe('Reported processed count in the stated unit'),
    unit: z.enum(['items', 'frames']).describe('Library items or generated preview frames'),
    continuation: z
        .object({
            kind: z
                .literal('source-check')
                .describe('Source versions await a check in a later pass'),
            remainingSources: z
                .number()
                .int()
                .safe()
                .positive()
                .max(1_000_000)
                .describe(
                    'Source versions remaining to check, without implying queued regeneration',
                ),
        })
        .optional(),
});
export type RunCountSummary = z.infer<typeof RunCountSummarySchema>;

export const RunSchema = z.object({
    id: z.string(),
    taskId: z.string(),
    parentRunId: z.string().optional(),
    label: z.string(),

    state: RunStateSchema,

    input: z.unknown(),
    scope: z
        .object({
            libraryGroupId: z.string().optional(),
            userId: z.string().optional(),
            // Subject correlation: which domain object this run acts upon.
            // `subjectType` is a single-member enum today on purpose —
            // consumers match type AND id together so a future subject kind
            // (library group, user, plugin) cannot collide with a media-item
            // id in the same field. Adding a member later is backward
            // compatible.
            subjectType: z.enum(['mediaItem']).optional(),
            subjectId: z.string().optional(),
        })
        .optional(),

    trigger: TriggerSchema,

    startedAt: z.string().datetime(),
    executionStartedAt: z
        .string()
        .datetime()
        .optional()
        .describe('Actual worker admission time, when recorded; startedAt is enqueue time'),
    admissionObservation: z
        .enum(['active', 'waiting', 'playback-deferred'])
        .optional()
        .describe(
            'Current confirmed runtime observation; absent means only recorded state is known',
        ),
    completedAt: z.string().datetime().optional(),
    heartbeatAt: z.string().datetime().optional(),

    stages: z.array(StageSchema),

    result: z.unknown().optional(),
    countSummary: RunCountSummarySchema.optional().describe(
        'Bounded processed count and validated continuation when available',
    ),
    error: z
        .object({
            message: z.string(),
            kind: z.enum(['transient', 'permanent', 'fatal']).optional(),
            stack: z.string().optional(),
        })
        .optional(),

    costBreakdown: z.record(z.string(), z.number()).optional(),
    ownerInstanceId: z.string().optional(),
    actor: ActorSchema,
});

export type Run = z.infer<typeof RunSchema>;

/**
 * The wire contract for run lifecycle CloudEvents (`org.lumastra.task.run.
 * started|completed|failed|cancelled`).
 *
 * Deliberately NOT `RunSchema`. Lifecycle events are broadcast on a pubsub
 * channel readable by any `runs:read` token and are retained in a 200-frame
 * replay buffer, so this projection omits:
 *   - `result` — uncapped in size; a large result would evict real
 *     transitions from the replay buffer.
 *   - `error.stack` — contains internal file paths (the REST surface strips
 *     it for the same reason).
 *   - `input` — the largest remaining unbounded field, and unused by clients.
 */
export const RunEventSchema = RunSchema.omit({
    input: true,
    result: true,
    error: true,
}).extend({
    countSummary: RunCountSummarySchema.optional().describe(
        'Bounded processed count and validated continuation when available',
    ),
    error: z
        .object({
            message: z.string(),
            kind: z.enum(['transient', 'permanent', 'fatal']).optional(),
        })
        .optional(),
});

export type RunEvent = z.infer<typeof RunEventSchema>;
export type RunState = z.infer<typeof RunStateSchema>;
export type Stage = z.infer<typeof StageSchema>;
export type Trigger = z.infer<typeof TriggerSchema>;
export type Actor = z.infer<typeof ActorSchema>;
