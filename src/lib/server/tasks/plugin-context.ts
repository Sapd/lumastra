// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Plugin context for non-task callers.
 *
 * The task runner builds a full `TaskContext` per run; services and route
 * handlers that need to invoke a provider outside of a queued run use the
 * helpers in this file instead.
 *
 * Two layers:
 *
 *   1. `buildPluginContext(pluginId)` — constructs an SDK-shaped
 *      `PluginContext` from host singletons (sql, valkey, plugin_settings,
 *      plugin_secrets). Use this when a caller needs to share one context
 *      across multiple provider calls (e.g., a metadata-sync run that hits
 *      a single provider several times).
 *
 *   2. `invokeProviderSearch / Detail / ChildList` — convenience wrappers
 *      that look up the provider definition, build a one-shot context, and
 *      invoke the SDK method. Use these for ad-hoc lookups where the caller
 *      doesn't need a long-lived context. This is the surface external (OSS)
 *      consumers should reach for — `PluginContext` construction stays an
 *      implementation detail of the host.
 *
 * Both layers fall back gracefully when the DB isn't configured (test
 * harnesses, degraded boot): they hand the provider a tagged-template sql
 * stub that throws on use. Providers that don't touch sql still work.
 */

import type postgres from 'postgres';
import type {
    Logger as PluginLogger,
    PluginContext,
    PluginUser,
    ProviderDefinition,
    ProviderDiscoverParams,
    ProviderDiscoverResult,
    ProviderExternalIdSource,
    ProviderResolveExternalIdResult,
    ProviderTrendingParams,
    ProviderPopularParams,
    ProviderTopRatedParams,
    TaskContext,
} from '@sapd/lumastra-plugin-sdk';
import { registry as defaultRegistry, type TaskRegistry } from './registry.js';
import { PluginSecrets } from './secrets.js';
import { buildAiSurface } from './plugin-ai-surface.js';
import type { UserContext } from '$lib/server/types.js';
import { getTaskDb } from '$lib/server/database/connection.js';
import { Logger, type LoggerInstance } from '$lib/server/utils/logger.js';
import {
    buildCatalogStore,
    buildHttpClient,
    buildMediaFilesStore,
    buildMediaItemsStore,
    buildMediaResolution,
    buildNamespacedCache,
    buildRealtime,
    buildUnavailableSqlStub,
    buildUserCredentialStore,
    type HttpClientRateLimitBinding,
} from './context-primitives.js';
import { buildPlaylistStore, buildMediaSegmentStore } from './plugin-stores.js';

const log = Logger.for('PluginContext');

// Module-level: a never-aborting signal shared across all default contexts.
// Equivalent to a fresh AbortController().signal but saves one allocation
// per buildPluginContext() call. The signal is intentionally never aborted
// — callers that need cancellation should pass options.signal explicitly.
const NEVER_ABORT_SIGNAL: AbortSignal = new AbortController().signal;

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Module-level cache for `PluginSecrets` instances keyed by sql handle.
 * Avoids reconstructing the secrets store (which has cold-path cost: master
 * key derivation, retention-policy lookup) for every invocation. Invalidated
 * implicitly when `getDb()` returns a new sql handle (e.g., reconnect).
 */
let cachedSecrets: { sql: postgres.Sql; store: PluginSecrets } | null = null;

function getSecretsStore(sql: postgres.Sql): PluginSecrets {
    if (cachedSecrets && cachedSecrets.sql === sql) return cachedSecrets.store;
    const store = new PluginSecrets(sql);
    cachedSecrets = { sql, store };
    return store;
}

async function loadPluginSettings(
    sql: postgres.Sql | null,
    pluginId: string,
): Promise<Record<string, unknown>> {
    if (!sql) return {};
    try {
        const rows = await sql<{ key: string; value: unknown }[]>`
            SELECT key, value FROM plugin_settings WHERE plugin_id = ${pluginId}
        `;
        const out: Record<string, unknown> = {};
        for (const r of rows) {
            out[r.key] = r.value;
        }
        return out;
    } catch (err) {
        log.warn('loadPluginSettings failed', {
            pluginId,
            err: err instanceof Error ? err.message : String(err),
        });
        return {};
    }
}

/**
 * Bridge a host `LoggerInstance` to the SDK's `Logger` shape.
 *
 * The shapes differ in two ways:
 *   - `error(msg, meta?)` vs `error(msg, error?, data?)` — the SDK passes
 *     the meta object in the second slot; we forward it as `data`.
 *   - `child(bindings: Record)` vs `child(context: string)` — we flatten
 *     the bindings into a `k=v,k=v` tag. Nested `.child()` calls work
 *     because the adapter is recursive.
 */
export function adaptLogger(base: LoggerInstance): PluginLogger {
    return {
        info: (msg, meta) => base.info(msg, meta),
        warn: (msg, meta) => base.warn(msg, meta),
        error: (msg, meta) => base.error(msg, undefined, meta),
        debug: (msg, meta) => base.debug(msg, meta),
        child: (bindings) => {
            const tag = Object.entries(bindings)
                .map(([k, v]) => `${k}=${String(v)}`)
                .join(',');
            // Skip the noop child() that would just append a trailing colon to
            // the LoggerInstance context (base.child('') → 'parent:').
            return adaptLogger(tag ? base.child(tag) : base);
        },
    };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build a `PluginContext` for the given plugin id. The context exposes:
 *
 *   - `sql`              — Postgres handle gated on `capabilities.database: true`.
 *                          Plugins that do not declare the capability receive a
 *                          throwing stub (same shape, permanent error on any access).
 *                          Mirrors the gate in `sandbox-entry.ts`.
 *   - `logger`           — scoped logger tagged with the plugin id.
 *   - `http`             — logging fetch wrapper (no per-request rate limiting).
 *   - `cache`            — Valkey-backed namespaced cache.
 *   - `settings()`       — async loader from the `plugin_settings` table.
 *   - `secrets.get / getUser` — `PluginSecrets` accessor (audit-logged).
 *
 * Caller takes ownership of the returned object. There is no `dispose`
 * because none of the resources hold long-lived handles — the cache uses
 * the shared Valkey client, settings is one-shot per call, secrets is
 * memoized per sql handle.
 */
export function buildPluginContext(
    pluginId: string,
    options?: {
        signal?: AbortSignal;
        registry?: TaskRegistry;
        /**
         * Override the sql handle the context (and ALL its sub-stores —
         * `catalog`, `mediaItems`, `mediaFiles`, `secrets`) is bound to.
         *
         * Use this when the caller is already inside a transaction (e.g.
         * `withAdvisoryLock`) and needs the plugin's reads/writes to land
         * on the same `tx` so they're observed under the same lock and
         * committed atomically. Spread-overriding `ctx.sql` after the fact
         * is NOT sufficient — the sub-stores close over the original sql
         * handle at construction time and would silently escape the
         * transaction.
         */
        sql?: postgres.Sql;
        /**
         * The authenticated viewer, when building a context for an HTTP request
         * (feature-route dispatcher). Threaded into `ctx.user` and used to scope
         * `ctx.media` / `ctx.ai`. Omit for task-run / boot contexts.
         */
        user?: PluginUser | null;
        /**
         * Whether the viewer has live-TV permission. The dispatcher supplies
         * this from `locals.user.hasLiveTvPermission`; `checkMediaAccess` does
         * NOT gate live TV, so `ctx.media` needs it separately. Default false.
         */
        userLiveTv?: boolean;
        /**
         * The raw host `UserContext` passed straight through to
         * `checkMediaAccess` for the access decision in `ctx.media`. REQUIRED
         * for a sound decision — `ctx.media` resolution fails closed (denies)
         * when it is absent (see `MediaResolutionViewer.raw`). Omit only for
         * task-run / boot contexts that never build `ctx.media`.
         */
        userRaw?: UserContext;
        /**
         * Shallow-merged on top of the `plugin_settings` row returned by
         * `ctx.settings()`. Lets a per-call caller pin a setting without
         * persisting it — e.g. the provider-invocation wrappers thread a
         * per-library `TMDB_LANGUAGE` so metadata localizes to the library's
         * configured language. Keys present here win over the stored row.
         */
        settingsOverride?: Record<string, unknown>;
    },
): PluginContext {
    // Capture sql once so all sub-stores agree on which handle they're
    // bound to for the lifetime of this context. The `options.sql` override
    // wins when present; otherwise we resolve the global handle. If the DB
    // becomes available after the context is built, callers should request
    // a fresh context — they shouldn't see ctx.sql throw while ctx.settings()
    // returns real data from a different handle.
    const sqlHandle = options?.sql ?? getTaskDb();
    const logger = adaptLogger(Logger.for('Provider').child(pluginId));
    const signal = options?.signal ?? NEVER_ABORT_SIGNAL;

    // Resolve the provider rate-limit (if any) so the HttpClient enforces
    // what the provider declared. For non-provider pluginIds (tasks, ad-hoc
    // ids) registry.getProvider returns undefined → no throttling, matching
    // the pre-enforcement behaviour for the curated-lists-sync style
    // "raw HTTP, no rate limit" callers.
    const registry = options?.registry ?? defaultRegistry;
    const providerDef = registry.getProvider(pluginId);
    const rateLimitBinding: HttpClientRateLimitBinding | undefined = providerDef?.rateLimit
        ? {
              providerId: pluginId,
              rateLimit: { rps: providerDef.rateLimit.rps },
          }
        : undefined;
    const allowedDomains = providerDef?.capabilities?.allowedDomains;

    // Resolve the `database` capability across all definition kinds. Mirrors
    // the gate applied in the worker isolation sandbox (sandbox-entry.ts —
    // `const gatedSql = caps.database ? sql : prim.buildUnavailableSqlStub()`).
    //
    // Use `.some()` rather than a `??` chain: an explicit `database: false` on
    // one definition must not short-circuit and mask a `true` on another when an
    // id happens to be registered under multiple kinds.
    //
    // EVERY contract kind must be listed. The `!isKnownPlugin` escape below
    // grants the real handle to ids the framework does not recognise (internal
    // boot/admin callers predate this gate), so a kind missing from this lookup
    // is not a partial gate — it is no gate at all for that kind, and the
    // capabilities the admin UI shows the operator become untrue.
    const pluginDefs = [
        registry.getTask(pluginId),
        providerDef,
        registry.getTrickplay(pluginId),
        registry.getWatchSync(pluginId),
        registry.getMediaSource(pluginId),
        registry.getFeature(pluginId),
        registry.getIntegration(pluginId),
        registry.getSubtitleProvider(pluginId),
        registry.getLyricsProvider(pluginId),
        registry.getAuthProvider(pluginId),
        registry.getExternalService(pluginId),
    ];
    const isKnownPlugin = pluginDefs.some((d) => d != null);
    // Read across a heterogeneous union: the auth-provider contract has no
    // `database` in its capabilities type at all, because that contract refuses
    // it outright. Absent therefore reads as false, which is the right answer.
    const declaresDatabase = pluginDefs.some(
        (d) => (d?.capabilities as { database?: boolean } | undefined)?.database === true,
    );

    // Grant the real handle when: the plugin DECLARES `database`; OR the caller
    // explicitly passed `options.sql` (a deliberate framework grant — e.g. a tx
    // handle from the retry path); OR the id is NOT a registered plugin (internal
    // boot / admin / test contexts that predate the gate). The gate targets
    // declared plugins pulling the ambient DB handle without opting in — not the
    // framework's own internal callers. Otherwise: a throwing stub.
    const dbGranted = declaresDatabase || options?.sql != null || !isKnownPlugin;

    const sql = dbGranted
        ? (sqlHandle ?? buildUnavailableSqlStub())
        : buildUnavailableSqlStub(
              `ctx.sql is not available for plugin "${pluginId}": ` +
                  `add \`database: true\` to its capabilities declaration.`,
              'permanent',
          );

    const secretsStore = getSecretsStore(sqlHandle ?? buildUnavailableSqlStub());

    return {
        sql,
        logger,
        http: buildHttpClient(logger, signal, rateLimitBinding, allowedDomains),
        cache: buildNamespacedCache(pluginId),
        signal,
        settings: options?.settingsOverride
            ? async () => ({
                  ...(await loadPluginSettings(sqlHandle, pluginId)),
                  ...options.settingsOverride,
              })
            : () => loadPluginSettings(sqlHandle, pluginId),
        secrets: {
            get: (key: string) => secretsStore.get(pluginId, key),
            getOptional: (key: string) => secretsStore.getOptional(pluginId, key),
            getUser: (userId: string, key: string) => secretsStore.getUser(pluginId, userId, key),
        },
        userCredentials: buildUserCredentialStore(pluginId, secretsStore),
        catalog: buildCatalogStore(sql),
        playlists: buildPlaylistStore(sql, pluginId),
        mediaSegments: buildMediaSegmentStore(sql, pluginId),
        mediaItems: buildMediaItemsStore(sql),
        mediaFiles: buildMediaFilesStore(sql),
        user: options?.user ?? null,
        realtime: buildRealtime(pluginId),
        media: options?.user
            ? buildMediaResolution(sql, {
                  username: options.user.username,
                  groups: options.user.groups,
                  isAdmin: options.user.isAdmin,
                  // hasLiveTvPermission + raw UserContext are supplied by the
                  // dispatcher via options.user when available; default false.
                  hasLiveTvPermission: options.userLiveTv ?? false,
                  raw: options.userRaw,
              })
            : undefined,
    };
}

/**
 * Async sibling of {@link buildPluginContext} that additionally wires the
 * optional `ctx.ai` surface.
 *
 * `buildPluginContext` is synchronous, but the `ai` bridge requires an async
 * loader (it dynamic-imports the proprietary assistant service). Request-scoped
 * callers — the feature-route dispatcher — use this so a feature plugin can call
 * `ctx.ai?.ask(...)`. In OSS builds (proprietary module absent) `ai` is
 * `undefined`, exactly as if it were never offered.
 */
export async function buildRequestPluginContext(
    pluginId: string,
    options: {
        user: PluginUser;
        userLiveTv?: boolean;
        userRaw?: UserContext;
        signal?: AbortSignal;
    },
): Promise<PluginContext> {
    const base = buildPluginContext(pluginId, {
        user: options.user,
        userLiveTv: options.userLiveTv,
        userRaw: options.userRaw,
        signal: options.signal,
    });
    const ai = await buildAiSurface(base.sql, options.user);
    return { ...base, ai };
}

/**
 * Build a reduced-surface `TaskContext` for admin routes that invoke task
 * lifecycle/backlog hooks (e.g. `onConfigChange`, `backlog.stages`) outside
 * a real run.
 *
 * Why this exists: hand-rolled `{ runId, sql, ... } as unknown as TaskContext`
 * literals silently miss every new SDK field. The retry endpoint hit exactly
 * this bug — its hand-rolled stub was missing `catalog`/`mediaItems`/
 * `mediaFiles`/`userCredentials`, so any retry handler that touched those
 * threw a `TypeError`. Centralizing the field shape here means a new SDK
 * field is one edit, not N grep-and-patch passes.
 *
 * Semantics versus `buildPluginContext`:
 *   - `sql`, `logger`, `cache`, `http`, `secrets`, `catalog`, `mediaItems`,
 *     `mediaFiles`, `userCredentials` — REAL surfaces, inherited from
 *     `buildPluginContext(pluginId)`. An admin route that needs a secret or
 *     external-id write works the same as a normal task run.
 *   - `runId`, `attemptNumber`, `input`, `scope`, `mode` — run-bound fields
 *     defaulted to admin-route placeholders (`runId: 'admin'`, empty input
 *     and scope, `mode: 'in-process'`).
 *   - `reportProgress`, `reportFailure`, `spend`, `drain` — noop. Admin
 *     calls don't have a cost ledger or progress sink.
 *   - `dep(name)` — returns a fetch that rejects. Per-dependency rate
 *     limiting is a runtime-only concern; admin routes shouldn't be hitting
 *     external APIs through the rate limiter at all.
 *   - `settings()` — defaults to `buildPluginContext`'s loader (reads the
 *     `plugin_settings` table). Callers can pass `opts.settings` to
 *     substitute the in-flight admin values (e.g. the body of a config-save
 *     request that hasn't been persisted yet).
 */
export function buildAdminContextStub(
    pluginId: string,
    opts?: {
        /** Override the sql handle (e.g. to bind to a transaction). */
        sql?: postgres.Sql;
        signal?: AbortSignal;
        /** Override `settings()` — e.g. return the in-flight admin form data. */
        settings?: () => Promise<Record<string, unknown>>;
    },
): TaskContext<unknown> {
    // Reject empty pluginId — downstream the empty string would become the
    // cache namespace and the logger tag, leading to cross-stub cache
    // collisions and untraceable logs.
    if (!pluginId) {
        throw new Error('buildAdminContextStub requires a non-empty pluginId');
    }

    // Forward `opts.sql` into `buildPluginContext` so EVERY sub-store
    // (`catalog`, `mediaItems`, `mediaFiles`, `secrets`) is bound to the
    // caller's tx, not the global handle. Overriding only the top-level
    // `sql` on the returned object would leave the sub-stores escaping the
    // caller's transaction.
    const base = buildPluginContext(pluginId, { sql: opts?.sql, signal: opts?.signal });

    return {
        runId: 'admin',
        attemptNumber: 0,
        // `{}` (not `undefined`) so plugin lifecycle hooks declared with a
        // non-unknown TInput don't crash on `ctx.input.someField` access —
        // they observe an empty bag of fields, same as if the hook fired
        // from a run with no input data.
        input: {} as unknown,
        scope: {},
        mode: 'in-process',

        sql: base.sql,
        logger: base.logger,
        signal: base.signal,
        abortSignal: base.signal,

        http: base.http,
        cache: base.cache,

        dep: (() => ({
            fetch: () =>
                Promise.reject(
                    new Error(`dep().fetch is not available in admin context (plugin ${pluginId})`),
                ),
        })) as unknown as TaskContext<unknown>['dep'],
        settings: opts?.settings ?? base.settings,
        secrets: base.secrets,
        userCredentials: base.userCredentials,
        catalog: base.catalog,
        playlists: base.playlists,
        mediaSegments: base.mediaSegments,
        mediaItems: base.mediaItems,
        mediaFiles: base.mediaFiles,

        reportProgress: () => undefined,
        reportFailure: async () => undefined,
        reportSuccess: async () => undefined,
        spend: () => undefined,
        drain: (async () => ({
            drained: 0,
            remaining: 0,
        })) as unknown as TaskContext<unknown>['drain'],
    } as TaskContext<unknown>;
}

// ── Provider invocation helpers ────────────────────────────────────────────────
//
// These are the public surface non-task callers should use. They hide
// `PluginContext` construction so OSS consumers never need to import the SDK
// type or know which host singletons back it.

function resolveProvider<TParams, TItem>(
    providerId: string,
    registry: TaskRegistry,
): ProviderDefinition<TParams, TItem> {
    const def = registry.getProvider(providerId) as ProviderDefinition<TParams, TItem> | undefined;
    if (!def) {
        throw new Error(`Provider not found in registry: ${providerId}`);
    }
    return def;
}

/**
 * Invoke a provider's `search(ctx, params)` by id. Builds a fresh
 * `PluginContext` for this call.
 *
 * Returns `[]` if the provider doesn't declare `search` — callers can
 * treat "not supported" the same as "no results".
 *
 * Pass `opts.signal` to propagate cancellation from scanner sweeps or
 * request handlers. Pass `opts.registry` to override the default registry
 * (useful in tests).
 */
export async function invokeProviderSearch<TParams = unknown, TItem = unknown>(
    providerId: string,
    params: TParams,
    opts?: { signal?: AbortSignal; registry?: TaskRegistry },
): Promise<TItem[]> {
    const registry = opts?.registry ?? defaultRegistry;
    const def = resolveProvider<TParams, TItem>(providerId, registry);
    if (!def.search) return [];
    const ctx = buildPluginContext(providerId, {
        signal: opts?.signal,
        registry,
    });
    return def.search(ctx, params);
}

/**
 * Invoke a provider's `detail(ctx, id)` by id. Builds a fresh
 * `PluginContext` for this call.
 *
 * The id string format is provider-specific — see each native provider's
 * docblock (`tasks/builtin/native/providers/<id>.ts`) for the encoding.
 *
 * Pass `opts.signal` to propagate cancellation. Pass `opts.registry` to
 * override the default registry (useful in tests).
 */
export async function invokeProviderDetail<TItem = unknown>(
    providerId: string,
    id: string,
    opts?: { signal?: AbortSignal; registry?: TaskRegistry; language?: string },
): Promise<TItem> {
    const registry = opts?.registry ?? defaultRegistry;
    const def = resolveProvider<unknown, TItem>(providerId, registry);
    const ctx = buildPluginContext(providerId, {
        signal: opts?.signal,
        registry,
        // Per-library metadata language pinned into ctx.settings() so providers
        // that read a TMDB_LANGUAGE setting localize this detail call.
        settingsOverride: opts?.language ? { TMDB_LANGUAGE: opts.language } : undefined,
    });
    return def.detail(ctx, id);
}

/**
 * Invoke a provider's optional `childList(ctx, parentId)` by id. Returns
 * an empty array if the provider doesn't declare childList — callers can
 * treat "not supported" the same as "no children".
 *
 * Pass `opts.signal` to propagate cancellation. Pass `opts.registry` to
 * override the default registry (useful in tests).
 */
export async function invokeProviderChildList<TItem = unknown>(
    providerId: string,
    parentId: string,
    opts?: { signal?: AbortSignal; registry?: TaskRegistry; language?: string },
): Promise<TItem[]> {
    const registry = opts?.registry ?? defaultRegistry;
    const def = resolveProvider<unknown, TItem>(providerId, registry);
    if (!def.childList) return [];
    const ctx = buildPluginContext(providerId, {
        signal: opts?.signal,
        registry,
        // Per-library metadata language — localizes season/episode children.
        settingsOverride: opts?.language ? { TMDB_LANGUAGE: opts.language } : undefined,
    });
    return def.childList(ctx, parentId);
}

/**
 * Invoke a provider's optional `batchLookup(ctx, ids)` by id.
 *
 * Returns an array of the same length as `ids`, with `null` for any id the
 * provider did not resolve (preserving input order so callers can correlate
 * by index). If the provider does not declare `batchLookup`, returns an
 * array of `null` placeholders — callers can treat "not supported" the same
 * as "all misses" without a separate capability check (mirrors the
 * `invokeProviderChildList` / `invokeProviderSearch` convention).
 *
 * Pass `opts.signal` to propagate cancellation. Pass `opts.registry` to
 * override the default registry (useful in tests).
 */
export async function invokeProviderBatchLookup<TItem = unknown>(
    providerId: string,
    ids: string[],
    opts?: { signal?: AbortSignal; registry?: TaskRegistry },
): Promise<Array<TItem | null>> {
    const registry = opts?.registry ?? defaultRegistry;
    const def = resolveProvider<unknown, TItem>(providerId, registry);
    if (!def.batchLookup) return ids.map(() => null);
    const ctx = buildPluginContext(providerId, {
        signal: opts?.signal,
        registry,
    });
    return def.batchLookup(ctx, ids);
}

/**
 * Invoke a provider's optional `discover(ctx, params)` by id.
 *
 * Returns an empty array if the provider does not declare `discover` —
 * callers can treat "not supported" the same as "no results". Mirrors the
 * `invokeProviderSearch` / `invokeProviderChildList` convention.
 *
 * Pass `opts.signal` to propagate cancellation. Pass `opts.registry` to
 * override the default registry (useful in tests).
 */
export async function invokeProviderDiscover(
    providerId: string,
    params: ProviderDiscoverParams,
    opts?: { signal?: AbortSignal; registry?: TaskRegistry },
): Promise<ProviderDiscoverResult[]> {
    const registry = opts?.registry ?? defaultRegistry;
    const def = resolveProvider<unknown, unknown>(providerId, registry);
    if (typeof def.discover !== 'function') return [];
    const ctx = buildPluginContext(providerId, {
        signal: opts?.signal,
        registry,
    });
    return def.discover(ctx, params);
}

/**
 * Invoke a provider's optional `getTrending(ctx, params)` by id.
 *
 * Returns an empty array if the provider does not declare `getTrending`.
 *
 * Pass `opts.signal` to propagate cancellation. Pass `opts.registry` to
 * override the default registry (useful in tests).
 */
export async function invokeProviderTrending(
    providerId: string,
    params: ProviderTrendingParams,
    opts?: { signal?: AbortSignal; registry?: TaskRegistry },
): Promise<ProviderDiscoverResult[]> {
    const registry = opts?.registry ?? defaultRegistry;
    const def = resolveProvider<unknown, unknown>(providerId, registry);
    if (typeof def.getTrending !== 'function') return [];
    const ctx = buildPluginContext(providerId, {
        signal: opts?.signal,
        registry,
    });
    return def.getTrending(ctx, params);
}

/**
 * Invoke a provider's optional `getPopular(ctx, params)` by id.
 *
 * Returns an empty array if the provider does not declare `getPopular`.
 *
 * Pass `opts.signal` to propagate cancellation. Pass `opts.registry` to
 * override the default registry (useful in tests).
 */
export async function invokeProviderPopular(
    providerId: string,
    params: ProviderPopularParams,
    opts?: { signal?: AbortSignal; registry?: TaskRegistry },
): Promise<ProviderDiscoverResult[]> {
    const registry = opts?.registry ?? defaultRegistry;
    const def = resolveProvider<unknown, unknown>(providerId, registry);
    if (typeof def.getPopular !== 'function') return [];
    const ctx = buildPluginContext(providerId, {
        signal: opts?.signal,
        registry,
    });
    return def.getPopular(ctx, params);
}

/**
 * Invoke a provider's optional `getTopRated(ctx, params)` by id.
 *
 * Returns an empty array if the provider does not declare `getTopRated`.
 *
 * Pass `opts.signal` to propagate cancellation. Pass `opts.registry` to
 * override the default registry (useful in tests).
 */
export async function invokeProviderTopRated(
    providerId: string,
    params: ProviderTopRatedParams,
    opts?: { signal?: AbortSignal; registry?: TaskRegistry },
): Promise<ProviderDiscoverResult[]> {
    const registry = opts?.registry ?? defaultRegistry;
    const def = resolveProvider<unknown, unknown>(providerId, registry);
    if (typeof def.getTopRated !== 'function') return [];
    const ctx = buildPluginContext(providerId, {
        signal: opts?.signal,
        registry,
    });
    return def.getTopRated(ctx, params);
}

/**
 * Check whether a provider considers itself configured (e.g., API key
 * present). Wraps `isConfigured(ctx)` with the same context-build path.
 *
 * Pass `opts.registry` to override the default registry (useful in tests).
 * Signal is not forwarded — `isConfigured` is a synchronous-style check
 * that reads settings and is expected to complete quickly.
 */
export async function isProviderConfigured(
    providerId: string,
    opts?: { signal?: AbortSignal; registry?: TaskRegistry },
): Promise<boolean> {
    const registry = opts?.registry ?? defaultRegistry;
    const def = resolveProvider(providerId, registry);
    const ctx = buildPluginContext(providerId, {
        signal: opts?.signal,
        registry,
    });
    return def.isConfigured(ctx);
}

/**
 * Invoke a provider's optional `getPersonDetail(ctx, personId, language)` by id.
 *
 * Returns `null` when:
 *   - the provider does not declare `getPersonDetail` (capability absent — no-op);
 *   - the provider returns null/undefined; or
 *   - the provider throws (treated as a miss so callers can fall back).
 *
 * Pass `opts.signal` to propagate cancellation. Pass `opts.registry` to
 * override the default registry (useful in tests).
 */
export async function invokeProviderGetPersonDetail(
    providerId: string,
    personId: number,
    opts?: { signal?: AbortSignal; registry?: TaskRegistry; language?: string },
): Promise<unknown | null> {
    const registry = opts?.registry ?? defaultRegistry;
    const def = resolveProvider<unknown, unknown>(providerId, registry);
    if (typeof def.getPersonDetail !== 'function') return null;
    const ctx = buildPluginContext(providerId, {
        signal: opts?.signal,
        registry,
    });
    try {
        return (await def.getPersonDetail(ctx, personId, opts?.language)) ?? null;
    } catch (err) {
        log.debug('getPersonDetail threw — treating as miss', {
            providerId,
            personId,
            err: err instanceof Error ? err.message : String(err),
        });
        return null;
    }
}

/**
 * Return all registered providers sorted by `metadata.priority` descending.
 *
 * Replaces the legacy `registry.getEnabledMetadataProviderPlugins()` call
 * pattern. Providers without `metadata.priority` get effective priority 0
 * (sorted last). Consumers that iterate providers to find the first one
 * that returns a non-null detail should use this order so the
 * highest-priority provider wins ties.
 *
 * Note: this does NOT filter by `isConfigured()` — that requires a
 * `PluginContext` per provider and async invocation. Callers that need
 * "is the provider actually usable" should pair this with
 * `isProviderConfigured(id)` or skip on individual call failure.
 */
export function getProvidersByPriority(
    registry: TaskRegistry = defaultRegistry,
): ProviderDefinition[] {
    return [...registry.getAllProviders()].sort(
        (a, b) => (b.metadata?.priority ?? 0) - (a.metadata?.priority ?? 0),
    );
}

/**
 * Invoke a provider's optional `resolveExternalId(ctx, externalId, source, mediaType)` by id.
 *
 * Returns `null` when:
 *   - the provider does not declare `resolveExternalId` (capability absent — no-op);
 *   - the provider returns null (miss, unavailable, or unrecognised source); or
 *   - the provider throws (treated as a miss so callers fall through to Phase 2).
 *
 * Pass `opts.registry` to override the default registry (useful in tests).
 * Pass `opts.signal` to propagate cancellation.
 */
export async function invokeProviderResolveExternalId(
    providerId: string,
    externalId: string,
    source: ProviderExternalIdSource,
    mediaType: 'movie' | 'tv',
    opts?: { signal?: AbortSignal; registry?: TaskRegistry },
): Promise<ProviderResolveExternalIdResult | null> {
    const registry = opts?.registry ?? defaultRegistry;
    const def = resolveProvider<unknown, unknown>(providerId, registry);
    if (typeof def.resolveExternalId !== 'function') return null;
    const ctx = buildPluginContext(providerId, {
        signal: opts?.signal,
        registry,
    });
    try {
        return await def.resolveExternalId(ctx, externalId, source, mediaType);
    } catch (err) {
        log.debug('resolveExternalId threw — treating as miss', {
            providerId,
            externalId,
            source,
            err: err instanceof Error ? err.message : String(err),
        });
        return null;
    }
}
