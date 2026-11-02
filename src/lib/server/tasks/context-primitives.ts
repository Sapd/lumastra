// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared host-side primitives for building SDK contexts.
 *
 * These builders construct the concrete implementations of SDK capability
 * surfaces (`HttpClient`, `NamespacedCache`, etc.) backed by host singletons
 * (Valkey, global fetch, the plugin_settings DB table).
 *
 * Two callers compose these primitives into context shapes:
 *   - `runner.ts` → builds a `TaskContext` for in-flight task runs.
 *   - `plugin-context.ts` → builds a `PluginContext` for non-task callers
 *     (services, route handlers) that need to invoke a provider outside of
 *     a queued run.
 *
 * Keep this module side-effect free: no top-level singletons, no boot calls.
 * Builders accept everything they need as arguments so a stale capture in one
 * caller can't break the other.
 */

import type postgres from 'postgres';
import { namespacedCacheKeyPrefix } from './cache-namespace.js';
import {
    TaskError,
    type CatalogStore,
    type HttpClient,
    type Logger as PluginLogger,
    type MediaFilesStore,
    type MediaItemsStore,
    type MediaItemSummary,
    type MediaRef,
    type MediaType,
    type NamespacedCache,
    type ResolvedMediaChip,
    type UserCredentialStore,
} from '@sapd/lumastra-plugin-sdk';
import { assertPublicHttpUrl, safeFetch } from './url-safety.js';
import { getValkeyClient, publishMessage } from '$lib/server/cache/valkey.js';
import { acquireHttpToken, type HttpRateLimitCfg } from './http-rate-limit.js';
import { type ValkeyLike, errMessage } from './valkey-types.js';
import type { PluginSecrets } from './secrets.js';
import { CatalogService } from '$lib/server/services/catalog.service.js';
import { findMediaIdByProviderExternalId } from '$lib/server/database/queries/external-ids.queries.js';
import {
    getMediaItemSummaryById,
    getMediaNavContext,
    searchMediaItemSummaries,
    type MediaItemSummaryRow,
} from '$lib/server/database/queries/media-lookup.queries.js';
import type { UserContext } from '$lib/server/types.js';
import { findMediaFileWithLinkByPath } from '$lib/server/database/queries/media-files.queries.js';
import {
    INTERNAL_MEDIA_TYPES,
    toInternalMediaType,
    toProviderMediaType,
    type MediaTypeInternal,
    type MediaTypeProvider,
} from '$lib/shared/media-type-domain';

/**
 * Optional rate-limit binding for `buildHttpClient`. When present, every
 * `get` / `post` call acquires one token from the per-`providerId` budget
 * before issuing the request via `acquireHttpToken` (`http-rate-limit.ts`).
 * That budget has two layers: a process-singleton local `TokenBucket` (so all
 * `buildHttpClient` calls for the same `providerId` in one replica share a
 * single budget without a Valkey round-trip), PLUS a cross-replica Valkey
 * shared bucket (`shared-rate-bucket.ts`) that enforces the rps ceiling across
 * every replica — so N replicas can't multiply the provider's allowed rate.
 * When Valkey is unreachable, enforcement degrades to per-replica (the local
 * bucket alone). See `acquireHttpToken`'s header for the full two-stage detail.
 *
 * Omit `rateLimit` for tasks / callers that don't have a declared
 * per-provider limit — they get unthrottled `fetch` exactly as before.
 */
export interface HttpClientRateLimitBinding {
    providerId: string;
    rateLimit: HttpRateLimitCfg;
}

/**
 * Build a logging `HttpClient` over global `fetch`. Mirrors the runner's
 * builder verbatim — extracted so non-task callers get the same behavior
 * (request timing logs, error logging).
 *
 * `defaultSignal` is merged into every request automatically. Callers that
 * pass an explicit `signal` in `opts` win via `AbortSignal.any` (Node 20+);
 * on older runtimes the caller-supplied signal is used directly and the
 * default is ignored (safe: the context signal still aborts the owning task).
 *
 * `rateLimit` is optional. When supplied, every request waits for a token
 * from the shared per-provider bucket before invoking fetch. If the merged
 * signal aborts during the wait, the wait throws and no request is made.
 * Without `rateLimit`, this client issues requests immediately (matching the
 * pre-enforcement behaviour relied on by curated-lists-sync and other tasks
 * that hit arbitrary URLs without a declared budget).
 *
 * `allowedDomains` is optional. When non-empty, every outbound URL is checked
 * against the list before the request is issued. Rules:
 *   - Exact match: `'api.tmdb.org'` matches only `api.tmdb.org`.
 *   - Subdomain suffix: `'.tmdb.org'` matches `api.tmdb.org`, `image.tmdb.org`, etc.
 * The SSRF syntactic guard (`assertPublicHttpUrl`) is applied as a cheap early
 * reject, and the actual network call goes through `safeFetch`, which resolves
 * DNS and pins the connection to the validated address at every redirect hop —
 * closing the DNS-rebinding window an allowlisted-but-attacker-controlled
 * hostname would otherwise leave open. `safeFetch`'s `validateHop` option also
 * re-applies the SAME allowedDomains check to every redirect hop (not just the
 * initial URL) — otherwise a 3xx from an allowlisted host could pivot the
 * request to any public host, defeating the allowlist entirely. When
 * `allowedDomains` is absent or empty, no allowlist check is performed
 * (existing plugins keep working).
 *
 * Every request also carries a default request timeout
 * (`PLUGIN_HTTP_TIMEOUT_MS`) so a malicious or unresponsive endpoint cannot
 * TCP-park a worker indefinitely. The timeout signal is merged with the
 * caller's signal and the host `defaultSignal`; whichever fires first aborts.
 */
/**
 * Default request timeout for `ctx.http` calls. A plugin fetching an
 * attacker-influenced or simply unresponsive endpoint must not be able to
 * TCP-park a worker forever — that wedges the heartbeat and lock renewal for
 * every run sharing the worker. 30s is generous for legitimate API/image
 * fetches while still bounding the worst case. Override with the
 * `LUMASTRA_PLUGIN_HTTP_TIMEOUT_MS` env var (matches the direct-`process.env`
 * convention the rest of the tasks subtree uses for tunables).
 */
const PLUGIN_HTTP_TIMEOUT_MS = (() => {
    const raw = process.env.LUMASTRA_PLUGIN_HTTP_TIMEOUT_MS?.trim();
    if (!raw) return 30_000;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 30_000;
})();

export function buildHttpClient(
    logger: PluginLogger,
    defaultSignal?: AbortSignal,
    rateLimit?: HttpClientRateLimitBinding,
    allowedDomains?: string[],
): HttpClient {
    /**
     * Merge the host `defaultSignal`, the caller's `opts.signal`, and a
     * per-request timeout signal into a single AbortSignal. Whichever fires
     * first aborts the request. The timeout guarantees no request can hang
     * indefinitely even when neither other signal ever fires.
     */
    function mergeSignal(opts?: RequestInit): AbortSignal {
        const timeoutSignal = AbortSignal.timeout(PLUGIN_HTTP_TIMEOUT_MS);
        const parts: AbortSignal[] = [timeoutSignal];
        if (defaultSignal) parts.push(defaultSignal);
        if (opts?.signal) parts.push(opts.signal);
        // AbortSignal.any is available in Node 20+ — the primary runtime. On
        // older Node we manually merge so no input signal is silently dropped
        // (which would let host-side cancel OR the timeout escape through the
        // rate-limit gate AND fetch).
        if (typeof AbortSignal.any === 'function') {
            return AbortSignal.any(parts);
        }
        const ctrl = new AbortController();
        const onAbort = (): void => ctrl.abort();
        if (parts.some((s) => s.aborted)) ctrl.abort();
        else {
            for (const s of parts) s.addEventListener('abort', onAbort, { once: true });
        }
        return ctrl.signal;
    }

    async function gate(signal: AbortSignal | undefined): Promise<void> {
        if (!rateLimit) return;
        await acquireHttpToken(rateLimit.providerId, rateLimit.rateLimit, signal);
    }

    /**
     * Suffix-anchored allowlist match, shared by the up-front `checkUrl` gate
     * and the per-redirect-hop validator below — one function, two call
     * sites, so the matching rule can never drift between "first request"
     * and "where a 3xx took us".
     *
     * Rules:
     *   - Exact match: `'api.tmdb.org'` matches only `api.tmdb.org`.
     *   - Subdomain suffix: `'.tmdb.org'` matches `api.tmdb.org`, `image.tmdb.org`, etc.
     */
    function isDomainAllowed(hostname: string, domains: string[]): boolean {
        return domains.some((rule) => {
            if (rule.startsWith('.')) {
                return hostname.endsWith(rule.toLowerCase());
            }
            return hostname === rule.toLowerCase();
        });
    }

    /**
     * Enforce the per-plugin domain allowlist and the SSRF syntactic guard.
     *
     * The allowlist is enforced first (cheap, no I/O). The SSRF guard is always
     * applied so that a plugin with `allowedDomains: ['evil.com']` cannot reach
     * private IPs if that hostname were to resolve to one at the parse level.
     * Full DNS-resolution SSRF hardening (DNS-rebinding) is not applied here
     * because it requires async DNS lookups on every request — that overhead is
     * reserved for the webhook outbox path which hits admin-supplied URLs.
     *
     * This only validates the INITIAL request URL. `safeFetch`'s `validateHop`
     * option (wired up below via `validateAllowedDomainHop`) re-applies the
     * same allowlist to every redirect hop — without it, a 3xx response from
     * an allowlisted host could pivot the request to any public host and
     * defeat this plugin's isolation boundary.
     */
    function checkUrl(url: string): void {
        // SSRF syntactic guard — rejects non-http(s), private IP literals,
        // loopback, link-local, etc. regardless of allowedDomains setting.
        assertPublicHttpUrl(url);

        if (!allowedDomains || allowedDomains.length === 0) return;

        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            // assertPublicHttpUrl already validated the URL; this branch is
            // unreachable in practice but keeps the type-flow consistent.
            throw new Error(`Plugin http: invalid URL: ${url}`);
        }
        const hostname = parsed.hostname.toLowerCase();

        if (!isDomainAllowed(hostname, allowedDomains)) {
            throw new Error(
                `Plugin http: domain '${hostname}' is not in the declared allowedDomains list`,
            );
        }
    }

    /**
     * `safeFetch` `validateHop` callback — re-enforces the same allowlist on
     * every redirect hop (including the first, which `checkUrl` already
     * covers; re-checking it here is cheap and keeps this function correct
     * standalone). No-op when the plugin declared no `allowedDomains`.
     */
    function validateAllowedDomainHop(url: URL): void {
        if (!allowedDomains || allowedDomains.length === 0) return;
        const hostname = url.hostname.toLowerCase();
        if (!isDomainAllowed(hostname, allowedDomains)) {
            throw new Error(
                `Plugin http: redirect to domain '${hostname}' is not in the declared allowedDomains list`,
            );
        }
    }

    return {
        async get(url, opts) {
            checkUrl(url);
            const signal = mergeSignal(opts);
            await gate(signal);
            const start = Date.now();
            try {
                // safeFetch resolves DNS + pins the connection to the validated
                // address (DNS-rebinding defense), re-validating at each redirect.
                // validateHop re-applies allowedDomains to every hop, not just
                // the first (see validateAllowedDomainHop's doc comment).
                const res = await safeFetch(
                    url,
                    {
                        ...opts,
                        method: 'GET',
                        signal,
                    },
                    { validateHop: validateAllowedDomainHop },
                );
                logger.debug('http.get', {
                    url,
                    status: res.status,
                    ms: Date.now() - start,
                });
                return res;
            } catch (err) {
                logger.warn('http.get failed', { url, err: errMessage(err) });
                throw err;
            }
        },
        async post(url, body, opts) {
            checkUrl(url);
            const signal = mergeSignal(opts);
            await gate(signal);
            const start = Date.now();
            const init: RequestInit = {
                ...opts,
                method: 'POST',
                body: body == null ? null : typeof body === 'string' ? body : JSON.stringify(body),
                headers: {
                    'Content-Type': 'application/json',
                    ...(opts?.headers ?? {}),
                },
                signal,
            };
            try {
                const res = await safeFetch(url, init, { validateHop: validateAllowedDomainHop });
                logger.debug('http.post', {
                    url,
                    status: res.status,
                    ms: Date.now() - start,
                });
                return res;
            } catch (err) {
                logger.warn('http.post failed', { url, err: errMessage(err) });
                throw err;
            }
        },
    };
}

/**
 * Build a Valkey-backed `NamespacedCache` for a plugin/provider id. Keys are
 * prefixed with `plugin:${id}:` so different plugins can use the same logical
 * key without collision.
 *
 * Best-effort: cache-layer errors are swallowed (returns null on get / no-op
 * on set/del). Callers that need durability should write through to Postgres.
 */
export function buildNamespacedCache(pluginId: string): NamespacedCache {
    // Shared with the admin read/reset paths that reach these keys directly —
    // see `namespacedCacheKeyPrefix`'s docstring on why this must not be
    // duplicated as a string literal anywhere.
    const prefix = namespacedCacheKeyPrefix(pluginId);
    return {
        async get<T>(key: string): Promise<T | null> {
            try {
                const client = getValkeyClient();
                if (!client) return null;
                const raw = await (client as unknown as ValkeyLike).customCommand([
                    'GET',
                    `${prefix}${key}`,
                ]);
                if (typeof raw !== 'string') return null;
                try {
                    return JSON.parse(raw) as T;
                } catch {
                    // Returning `raw as T` historically gave callers a string
                    // when they expected an object — downstream code paths
                    // explode with TypeError ("X is not a function" on a
                    // string). Returning null is a contract change but the
                    // string-fallback was unsound; null is honest and
                    // matches the "no value" semantics callers handle.
                    return null;
                }
            } catch {
                return null;
            }
        },
        async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
            try {
                const client = getValkeyClient();
                if (!client) return;
                const serialized = typeof value === 'string' ? value : JSON.stringify(value);
                const cmd = ttlMs
                    ? ['SET', `${prefix}${key}`, serialized, 'PX', String(ttlMs)]
                    : ['SET', `${prefix}${key}`, serialized];
                await (client as unknown as ValkeyLike).customCommand(cmd);
            } catch {
                // best-effort
            }
        },
        async del(key: string): Promise<void> {
            try {
                const client = getValkeyClient();
                if (!client) return;
                await (client as unknown as ValkeyLike).customCommand(['DEL', `${prefix}${key}`]);
            } catch {
                // best-effort
            }
        },
    };
}

/**
 * Build the `ctx.realtime` surface for a plugin. `publish(topic, payload)`
 * fans out over the existing Valkey pub/sub to a PER-PLUGIN channel
 * (`plugin:rt:<pluginId>`), with the topic demuxed inside the payload (mirrors
 * cancel-channel.ts). Namespacing is the isolation boundary — a plugin can
 * never publish to `task:*` or another plugin's channel.
 */
export function buildRealtime(pluginId: string): {
    publish(topic: string, payload: unknown): Promise<void>;
} {
    const channel = `plugin:rt:${pluginId}`;
    return {
        async publish(topic: string, payload: unknown): Promise<void> {
            // `payload` is plugin-controlled and typed `unknown`. A BigInt or a
            // circular reference makes JSON.stringify throw synchronously; without
            // this guard that surfaces as an opaque TypeError rejection in the task
            // runner. Convert it to a typed, attributable error instead (mirrors
            // cancel-channel.ts, which keeps its publish failures controlled).
            let message: string;
            try {
                message = JSON.stringify({ pluginId, topic, payload, ts: Date.now() });
            } catch (err) {
                throw new PluginRealtimeError(
                    `realtime.publish payload for plugin '${pluginId}' (topic '${topic}') is not JSON-serializable: ${errMessage(err)}`,
                );
            }
            await publishMessage(channel, message);
        },
    };
}

/**
 * Thrown by `ctx.realtime.publish` when a plugin supplies a payload that cannot
 * be JSON-serialized (e.g. a BigInt or a circular reference). Surfacing a typed
 * error keeps a single plugin's bad payload from appearing as an opaque
 * `TypeError` rejection inside the task runner.
 */
export class PluginRealtimeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PluginRealtimeError';
    }
}

/**
 * Build a `UserCredentialStore` bound to one (pluginId, secretsStore) pair.
 *
 * All methods delegate to `PluginSecrets` and inject the captured pluginId,
 * so plugins can never read or write outside their own credential namespace.
 *
 * `get()` uses `getUserRaw()` — it returns the value regardless of
 * `expires_at` (so plugins can inspect/refresh expired tokens) and does NOT
 * write to `plugin_secret_access_log` (per-cycle loops over linked users
 * would otherwise burn one audit row per credential read). For audit-logged
 * fail-on-expiry reads, plugins still have `ctx.secrets.getUser`.
 */
export function buildUserCredentialStore(
    pluginId: string,
    secretsStore: PluginSecrets,
): UserCredentialStore {
    return {
        get: (userId, key) => secretsStore.getUserRaw(pluginId, userId, key),
        set: (userId, key, value, opts) =>
            secretsStore.setUser(pluginId, userId, key, value, opts?.expiresAt, opts?.ifKeyExists),
        delete: (userId, key) => secretsStore.deleteUser(pluginId, userId, key),
        listKeys: (userId) => secretsStore.listUserKeys(pluginId, userId),
        listLinkedUsers: () => secretsStore.listLinkedUserIds(pluginId),
        listUsersWithKey: (key) => secretsStore.listUserIdsWithKey(pluginId, key),
    };
}

// ── Catalog / media-item convenience stores ─────────────────────────────────
//
// These wrap host services and query modules behind the SDK's "paved road"
// interfaces (`CatalogStore`, `MediaItemsStore`, `MediaFilesStore`). Each
// factory closes over a `sql` handle so the returned store can never touch
// a different connection than the one the caller already validated.

/**
 * Normalize a plugin-supplied media type onto the canonical lowercase value
 * stored in `media_items.media_type`.
 *
 * Parsing is delegated to {@link toInternalMediaType} — the one owner of the
 * vocabulary — so this SDK boundary accepts exactly the same inputs as the rest
 * of the app (UPPERCASE, PascalCase, lowercase, plus the documented aliases
 * `'series'` → `'tv'` and `'song'` → `'track'`).
 *
 * Being lenient about *case* while rejecting *unknown values* is the point:
 * cosmetic case mistakes are the host's problem to fix, but an unrecognised
 * media type is a plugin bug. This used to end in `return lower as
 * InternalMediaType`, which let anything through to the DB and surfaced as an
 * opaque column-level CHECK violation on insert. Failing here names the caller's
 * actual mistake, and lists the accepted values.
 */
function normalizeMediaType(value: string): MediaTypeInternal {
    if (value.trim() === '') {
        throw new TaskError({
            message: 'mediaType cannot be empty or whitespace',
            kind: 'permanent',
        });
    }
    const internal = toInternalMediaType(value);
    if (internal === null) {
        throw new TaskError({
            message:
                `mediaType ${JSON.stringify(value)} is not a known media type. ` +
                `Expected one of: ${INTERNAL_MEDIA_TYPES.join(', ')}.`,
            kind: 'permanent',
        });
    }
    return internal;
}

/**
 * Same parse as {@link normalizeMediaType}, then narrowed to the vocabulary an
 * `external_ids` composite key can actually carry ({@link MediaTypeProvider}).
 *
 * `external_ids.media_type` is part of the primary key `(provider, external_id,
 * media_type)`, and only provider-identifiable types belong in it — writing a
 * `home_video`, `tvchannel` or `music` row there creates a key nothing will ever
 * look up. The plugin gets a permanent error naming its mistake instead of a
 * silent no-op row.
 */
function normalizeProviderMediaType(value: string): MediaTypeProvider {
    const internal = normalizeMediaType(value);
    const provider = toProviderMediaType(internal);
    if (provider === null) {
        throw new TaskError({
            message:
                `mediaType ${JSON.stringify(value)} cannot be used as an external-ID media ` +
                `type — only provider-identifiable types may appear in an external_ids key.`,
            kind: 'permanent',
        });
    }
    return provider;
}

function summaryRowToDto(row: MediaItemSummaryRow): MediaItemSummary {
    // library_added_at falls back to created_at — both are NOT NULL on the
    // base schema, but the column type allows null after the migration so we
    // model it as nullable in the SDK and prefer the more specific column.
    const addedAt = row.library_added_at ?? row.created_at;
    return {
        id: row.id,
        title: row.title,
        year: row.year,
        mediaType: row.media_type as MediaType,
        overview: row.overview,
        libraryAddedAt: addedAt ? new Date(addedAt).toISOString() : null,
    };
}

/**
 * Build the SDK `ctx.catalog` surface bound to a sql handle.
 *
 * - `upsertExternalId` delegates to `CatalogService.upsertExternalId`. That
 *   path is transactional, handles stale-mapping cleanup, fires the
 *   `MediaLifecycleService.afterExternalIdChanged` hook, and is the canonical
 *   write surface per memory `bug_catalog_withTx_reserved_sql.md`.
 * - `findByExternalId` reads via the provider-agnostic
 *   `findMediaIdByProviderExternalId` query — composite-key-safe by
 *   construction (mediaType filter is mandatory in the type).
 *
 * The plugin can never construct a `CatalogService` itself, so confidentiality
 * of the `skipLifecycleHooks` knob is preserved.
 */
export function buildCatalogStore(sql: postgres.Sql): CatalogStore {
    const service = new CatalogService(sql);
    return {
        async upsertExternalId(params): Promise<void> {
            const mediaType = normalizeProviderMediaType(params.mediaType);
            await service.upsertExternalId(params.mediaItemId, {
                provider: params.provider,
                id: params.externalId,
                mediaType,
                source: 'plugin',
            });
        },
        async findByExternalId(params): Promise<{ mediaItemId: string } | null> {
            const mediaType = normalizeProviderMediaType(params.mediaType);
            const mediaId = await findMediaIdByProviderExternalId(sql, {
                provider: params.provider,
                externalId: params.externalId,
                mediaType,
            });
            return mediaId ? { mediaItemId: mediaId } : null;
        },
    };
}

/**
 * Build the SDK `ctx.mediaItems` surface bound to a sql handle.
 *
 * Delegates to `getMediaItemSummaryById` / `searchMediaItemSummaries` so the
 * narrow `MediaItemSummary` projection is enforced at the query layer — the
 * store can never accidentally leak a wider row shape.
 */
export function buildMediaItemsStore(sql: postgres.Sql): MediaItemsStore {
    return {
        async getById(id): Promise<MediaItemSummary | null> {
            const row = await getMediaItemSummaryById(sql, id);
            return row ? summaryRowToDto(row) : null;
        },
        async search(query, opts): Promise<MediaItemSummary[]> {
            const rows = await searchMediaItemSummaries(sql, query, {
                limit: opts?.limit,
                mediaType: opts?.mediaType ? normalizeMediaType(opts.mediaType) : undefined,
            });
            return rows.map(summaryRowToDto);
        },
    };
}

/**
 * Viewer for media resolution. A superset of `PluginUser` — also carries the
 * live-TV permission the host computed (checkMediaAccess does NOT gate live TV).
 *
 * `raw` is the host `UserContext`, and it is REQUIRED for the access decision.
 * `checkMediaAccess` → `toLibraryAccessUser` reads `.userGroups` / `.isAdmin`
 * and the age gate reads `.isAgeRestricted` / `.maxAgeRating` — fields that do
 * NOT exist on the synthetic `MediaResolutionViewer` shape (which carries
 * `.groups`). Passing the synthetic viewer instead of `raw` would silently
 * resolve to an empty-group, non-age-restricted user and bypass BOTH the
 * library-group gate and the age gate. `resolveOne` fails closed (denies) when
 * `raw` is absent rather than granting access against the wrong shape.
 */
export interface MediaResolutionViewer {
    username: string;
    groups: string[];
    isAdmin: boolean;
    hasLiveTvPermission: boolean;
    /**
     * The host `UserContext`, passed straight through to `checkMediaAccess`.
     * REQUIRED for a sound access decision — see the interface doc. Typed
     * optional only because callers build the viewer incrementally; an absent
     * `raw` makes every resolution fail closed.
     */
    raw?: UserContext;
}

/**
 * Build the host deep-link for an allowed chip.
 *
 * - `tvchannel` opens the live-TV destination, not the modal.
 * - `episode` / `season` must open the PARENT SERIES modal with the season/
 *   episode preselected (consumption contract in `modal-url-sync.ts`):
 *   `?modal=<series-uuid>&season=N[&episode=N]`. Opening `?modal=<episode-uuid>`
 *   directly would surface a bare episode at the wrong place. The `nav` context
 *   (series UUID + numbers) is resolved by the caller via `getMediaNavContext`.
 * - everything else uses `?modal=<uuid>`.
 */
function openHrefFor(
    id: string,
    mediaType: string,
    nav?: { seriesId: string | null; seasonNumber: number | null; episodeNumber: number | null },
): string {
    if (mediaType === 'tvchannel') return `/livetv?channel=${encodeURIComponent(id)}`;

    if (mediaType === 'episode' || mediaType === 'season') {
        // Fall back to the item's own id if the series couldn't be resolved
        // (orphaned row) — better a bare-item modal than a broken link.
        const seriesId = nav?.seriesId ?? id;
        const params = new URLSearchParams({ modal: seriesId });
        if (nav?.seasonNumber != null) params.set('season', String(nav.seasonNumber));
        if (mediaType === 'episode' && nav?.episodeNumber != null) {
            params.set('episode', String(nav.episodeNumber));
        }
        return `?${params.toString()}`;
    }

    return `?modal=${encodeURIComponent(id)}`;
}

/**
 * Build `ctx.media` for one request viewer. `resolveForViewer` returns an
 * access-checked chip per ref: allowed → title/year/openHref; denied/missing →
 * `{ allowed: false }` (no leak). `tvchannel` additionally requires live-TV
 * permission.
 */
export function buildMediaResolution(
    sql: postgres.Sql,
    viewer: MediaResolutionViewer,
): {
    search(
        q: string,
        opts?: { limit?: number; mediaTypes?: MediaType[] },
    ): Promise<ResolvedMediaChip[]>;
    resolveForViewer(refs: MediaRef[]): Promise<ResolvedMediaChip[]>;
} {
    async function resolveOne(ref: MediaRef): Promise<ResolvedMediaChip> {
        const summary = await getMediaItemSummaryById(sql, ref.id);
        if (!summary) return { id: ref.id, mediaType: ref.mediaType, allowed: false };
        // Fail CLOSED when the host UserContext is absent. `checkMediaAccess` /
        // `toLibraryAccessUser` read `.userGroups` / `.isAdmin` / `.isAgeRestricted`
        // — fields the synthetic `MediaResolutionViewer` (carries `.groups`) does
        // NOT have. Substituting the viewer would resolve to an empty-group,
        // non-age-restricted user and silently bypass both the library-group and
        // age gates, leaking restricted content. Without a real UserContext we
        // cannot make a sound decision, so deny.
        if (!viewer.raw) return { id: ref.id, mediaType: ref.mediaType, allowed: false };
        // Lazy import: media-access pulls in `utils/api-responses` → `@sveltejs/kit`,
        // which is unresolvable in the tsx startup-migration boot context. This module
        // is statically reachable from the migration runner (migrate-schema →
        // connection → catalog.service → plugin-context → here), so a STATIC import
        // crashes boot. Loaded lazily it only resolves at request/plugin time.
        const { checkMediaAccess } = await import('$lib/server/middleware/media-access.js');
        const allowed = await checkMediaAccess(sql, ref.id, viewer.raw);
        if (!allowed) return { id: ref.id, mediaType: ref.mediaType, allowed: false };
        if (ref.mediaType === 'tvchannel' && !viewer.hasLiveTvPermission) {
            return { id: ref.id, mediaType: ref.mediaType, allowed: false };
        }
        // Episodes/seasons need the parent-series deep link with season/episode
        // preselected — resolve that context before building openHref.
        let nav:
            | { seriesId: string | null; seasonNumber: number | null; episodeNumber: number | null }
            | undefined;
        if (ref.mediaType === 'episode' || ref.mediaType === 'season') {
            const navRow = await getMediaNavContext(sql, ref.id);
            if (navRow) {
                nav = {
                    seriesId: navRow.series_id,
                    seasonNumber: navRow.season_number,
                    episodeNumber: navRow.episode_number,
                };
            }
        }
        return {
            id: ref.id,
            mediaType: ref.mediaType,
            allowed: true,
            title: summary.title,
            year: summary.year,
            openHref: openHrefFor(ref.id, ref.mediaType, nav),
        };
    }

    return {
        async resolveForViewer(refs: MediaRef[]): Promise<ResolvedMediaChip[]> {
            return Promise.all(refs.map(resolveOne));
        },
        async search(q, opts): Promise<ResolvedMediaChip[]> {
            const rows = await searchMediaItemSummaries(sql, q, { limit: opts?.limit });
            const filtered = opts?.mediaTypes
                ? rows.filter((r) => opts.mediaTypes!.includes(r.media_type as MediaType))
                : rows;
            const chips = await Promise.all(
                filtered.map((r) => resolveOne({ id: r.id, mediaType: r.media_type as MediaType })),
            );
            return chips.filter((c) => c.allowed);
        },
    };
}

/**
 * Build the SDK `ctx.mediaFiles` surface bound to a sql handle.
 *
 * Single method today — `findByPath` — but the factory shape leaves room for
 * the obvious follow-up (`findByPrefix`, `getLinkedItems`) without breaking
 * the consumer signature.
 */
export function buildMediaFilesStore(sql: postgres.Sql): MediaFilesStore {
    return {
        findByPath: (absolutePath) => findMediaFileWithLinkByPath(sql, absolutePath),
    };
}

/**
 * Tagged-template stub for `postgres.Sql` — invoking it OR accessing any
 * property (e.g. `sql.begin`, `sql.unsafe`) throws. Used when a context
 * builder is asked for a sql handle but the DB isn't configured. Callers
 * that don't touch `ctx.sql` still run; ones that do fail loudly with the
 * documented TaskError instead of a confusing "X is not a function" TypeError.
 *
 * Implementation: Proxy traps both `apply` and `get`. The `then` property
 * is special-cased to `undefined` so the stub doesn't accidentally appear
 * thenable to Promise consumers (they'd treat it as a settled promise).
 */
export function buildUnavailableSqlStub(
    message = 'sql handle unavailable',
    kind: 'fatal' | 'permanent' | 'transient' = 'fatal',
): postgres.Sql {
    const throwUnavailable = (): never => {
        throw new TaskError({ message, kind });
    };
    return new Proxy((() => undefined) as unknown as object, {
        apply: throwUnavailable,
        get(_t, prop) {
            // Don't pretend to be a thenable — Promise consumers check `.then`
            // synchronously and would treat the stub as a resolved promise.
            if (prop === 'then') return undefined;
            // Allow Symbol.toPrimitive / inspector paths to no-op without
            // throwing (otherwise logging the stub itself blows up).
            if (typeof prop === 'symbol') return undefined;
            return throwUnavailable();
        },
    }) as unknown as postgres.Sql;
}
