// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MDBList metadata provider — native defineProvider migration (Wave 3).
 *
 * MDBList aggregates ratings from multiple sources (Rotten Tomatoes, Metacritic,
 * Letterboxd, Trakt, MAL, MDBList itself) and streaming service availability.
 * It is a batch-first provider: it does not support title search. Real-time
 * lookups by IMDB ID go through `detail`; bulk enrichment goes through
 * `batchLookup` (used by the mdblist-sync task).
 *
 * rateLimitPerMinute: 60 → rateLimit: { rps: 60/60 = 1 }
 *
 * SDK shape notes:
 *   - search: not declared — mdblist has no title search API surface, so
 *     omitting `search` is the contract-correct way to express "unsupported".
 *     `invokeProviderSearch` returns `[]` for absent search.
 *   - detail(ctx, id): single-item lookup by IMDB ID or TMDB composite key.
 *   - batchLookup(ctx, ids): POST /tmdb/{type} batch endpoint (up to 200 IDs
 *     per request). Accepts a mix of IMDB ids (`tt…`) and TMDB composite ids
 *     (`tmdb:{id}:movie` / `tmdb:{id}:tv|show`). Preserves input order and
 *     yields `null` placeholders for ids the API did not resolve.
 *   - childList: not applicable.
 */

import { defineProvider } from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../../registry.js';
import { config } from '../../../../config.js';
import { encodePathSegment } from '$lib/server/utils/upstream-path';
// ---------------------------------------------------------------------------
// 429 cool-down — process-local memoisation
// ---------------------------------------------------------------------------
//
// MDBList enforces a per-API-key rate limit and returns 429 with no
// `Retry-After` header. Without backoff, stage-sweep re-enqueues the
// 8k+ pending items every 30s, the task fires, hammers the API, gets
// 429 on every chunk, and returns "0 found, 0 updated" — burning the
// allowance without making progress.
//
// Set a module-scoped cool-down when a 429 lands. All subsequent
// `batchLookup` calls in the same worker process short-circuit until the
// cool-down expires. Worker restart clears it (which is fine — we WANT
// to retry after a fresh process). Cross-replica drift is acceptable:
// each replica independently learns the limit and backs off.
//
// Default cool-down 1h matches MDBList's documented daily rate-limit
// reset granularity. If the API ever ships a `Retry-After` header we
// honour it.
let mdblistRateLimitCooldownUntilMs = 0;
const MDBLIST_DEFAULT_COOLDOWN_MS = 60 * 60 * 1000;

function setMdblistCooldown(retryAfterSeconds: number | null): void {
    const seconds =
        Number.isFinite(retryAfterSeconds) && retryAfterSeconds! > 0
            ? Math.min(retryAfterSeconds!, 6 * 60 * 60)
            : MDBLIST_DEFAULT_COOLDOWN_MS / 1000;
    mdblistRateLimitCooldownUntilMs = Date.now() + seconds * 1000;
}

function mdblistCooldownRemainingMs(): number {
    return Math.max(0, mdblistRateLimitCooldownUntilMs - Date.now());
}

// ---------------------------------------------------------------------------
// Cancellation detection
// ---------------------------------------------------------------------------
//
// Mirrors the pattern used by the task runner's cancellation check
// (`run-wrapper.ts`): an aborted `ctx.http` call must propagate immediately
// rather than being folded into the "chunk failed" bucket — a cancelled run
// is not an MDBList outage, and swallowing the abort would let the loop keep
// making (doomed) network calls after the caller already gave up.
function isCancellationError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const e = err as Error & { code?: string };
    return (
        e.name === 'AbortError' ||
        e.name === 'CancelError' ||
        e.code === 'CANCELLED' ||
        /cancel/i.test(e.message ?? '')
    );
}

// One-time warning so a future caller that passes a bare IMDB id for a
// non-movie item (batchLookup has no per-id media-type context to detect
// this — see the parse block below) at least gets a log breadcrumb instead
// of silent mis-typing. Today's only caller (mdblist-sync.ts) always sends
// TMDB composite ids, so this path is presently unreachable — kept as a
// guard against a future regression, not a live bug.
let warnedBareImdbAssumption = false;

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

/**
 * MDBList single-item lookup result. Mirrors the shape returned by
 * GET https://api.mdblist.com/?i={imdbId} or ?t={tmdbId}&m={type}.
 *
 * Fields are typed as optional — the API omits absent ratings rather than
 * returning null. Callers should guard each field individually.
 */
export interface MdblistItem {
    title?: string;
    year?: number;
    released?: string;
    description?: string;
    runtime?: number;
    score?: number;
    score_average?: number;
    type?: 'movie' | 'show';
    ids?: {
        imdb?: string;
        trakt?: number;
        tmdb?: number;
        tvdb?: number;
        mal?: number;
    };
    ratings?: Array<{
        source: string;
        value: number | null;
        score: number | null;
        votes: number | null;
        url?: string | null;
    }>;
    genres?: Array<{ id: number; title: string }>;
    streams?: Array<{ id: number; name: string }>;
    language?: string;
    status?: string;
    poster?: string;
    backdrop?: string;
    [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const MDBLIST_BASE = 'https://api.mdblist.com';

/** The MDBList API key — the host setting (settings.json, else env). */
function resolveApiKey(): string {
    const key = config.MDBLIST_API_KEY?.trim();
    if (key) return key;
    throw new Error('MDBLIST_API_KEY is not configured');
}

// ---------------------------------------------------------------------------
// Provider definition
// ---------------------------------------------------------------------------

export const mdblistProvider = defineProvider<never, MdblistItem>({
    id: 'mdblist-metadata-provider',
    name: 'MDBList',
    version: '1.0.0',

    capabilities: { http: true, cache: true },

    rateLimit: { rps: 1 }, // 60/min

    metadata: {
        priority: 20,
        cacheTtlHours: 24,
        fieldAuthorities: {
            rt_critic_score: 20,
            rt_audience_score: 20,
            metacritic_score: 20,
            letterboxd_rating: 20,
            trakt_score: 20,
            mal_score: 20,
            streaming_services: 20,
            mdblist_score: 20,
        },
    },

    // No settings of its own: MDBLIST_API_KEY is a host setting (Settings →
    // Providers → Connections). A plugin-secret copy used to take precedence,
    // so the key on the connections form could be silently ignored.

    // It used to answer from the plugin secret only (the host key counted just
    // when the secrets store threw), so a key set on the connections form
    // still showed "Not configured".
    async isConfigured(): Promise<boolean> {
        return !!config.MDBLIST_API_KEY?.trim();
    },

    /**
     * Look up a single item by ID.
     *
     * Accepted id formats:
     *   "tt1234567"           → IMDB ID  → GET /?i=tt1234567&apikey=…
     *   "tmdb:12345:movie"    → TMDB ID  → GET /?t=12345&m=movie&apikey=…
     *   "tmdb:12345:show"     → TMDB ID  → GET /?t=12345&m=show&apikey=…
     *   "tmdb:12345:tv"       → TMDB ID  → GET /?t=12345&m=show&apikey=…  (tv alias)
     *
     * Returns the raw MDBList API response including aggregated ratings from
     * RT, Metacritic, Letterboxd, Trakt, MAL, and streaming availability.
     */
    async detail(ctx, id): Promise<MdblistItem> {
        if (!ctx.http)
            throw new Error('http capability required but not provided to mdblist detail()');

        const apiKey = resolveApiKey();

        let url: string;
        if (id.startsWith('tt')) {
            url = `${MDBLIST_BASE}/?i=${encodeURIComponent(id)}&apikey=${encodeURIComponent(apiKey)}`;
        } else if (id.startsWith('tmdb:')) {
            const parts = id.split(':');
            if (parts.length !== 3) {
                throw new Error(
                    `mdblist detail(): invalid tmdb composite id "${id}" — ` +
                        'expected "tmdb:{id}:{movie|show|tv}"',
                );
            }
            const [, tmdbId, rawType] = parts;
            const mType = rawType === 'tv' ? 'show' : rawType;
            url = `${MDBLIST_BASE}/?t=${encodeURIComponent(tmdbId)}&m=${encodeURIComponent(mType)}&apikey=${encodeURIComponent(apiKey)}`;
        } else {
            throw new Error(
                `mdblist detail(): unrecognised id format "${id}" — ` +
                    'use an IMDB ID (tt…) or a TMDB composite ID ("tmdb:{id}:{movie|show}")',
            );
        }

        // Honour the in-process cool-down set by a prior 429.
        const cooldownRemaining = mdblistCooldownRemainingMs();
        if (cooldownRemaining > 0) {
            const mins = Math.ceil(cooldownRemaining / 60000);
            const human = mins >= 60 ? `~${Math.floor(mins / 60)}h ${mins % 60}m` : `~${mins} min`;
            throw new Error(
                `MDBList rate-limit cool-down active (free-tier quota) — will retry in ${human}`,
            );
        }

        const response = await ctx.http.get(url);
        if (!response.ok) {
            if (response.status === 429) {
                const retryAfter = Number(
                    response.headers?.get?.('retry-after') ??
                        response.headers?.get?.('Retry-After') ??
                        NaN,
                );
                setMdblistCooldown(Number.isFinite(retryAfter) ? retryAfter : null);
                throw new Error('mdblist rate limit exceeded (HTTP 429)');
            }
            throw new Error(
                `mdblist detail() request failed: ${response.status} ${response.statusText}`,
            );
        }

        const data = (await response.json()) as MdblistItem;
        return data;
    },

    /**
     * Bulk lookup against the mdblist batch endpoint
     * (`POST /{idType}/{mediaType}` with up to 200 ids per request).
     *
     * Accepted id formats (same as `detail`):
     *   "tt1234567"           → IMDB ID  → POST /imdb/{movie|show}
     *   "tmdb:12345:movie"    → TMDB ID  → POST /tmdb/movie
     *   "tmdb:12345:show"     → TMDB ID  → POST /tmdb/show
     *   "tmdb:12345:tv"       → TMDB ID  → POST /tmdb/show  (tv alias)
     *
     * Ids are grouped by `(idType, mediaType)` into POST batches of at most
     * 200 entries (the upstream cap). Results are correlated back to input
     * positions via the response item's `ids.tmdb` / `ids.imdb` field; any
     * input id the API did not resolve yields `null` in the same slot, so
     * callers can correlate strictly by index.
     */
    async batchLookup(ctx, ids): Promise<Array<MdblistItem | null>> {
        if (!ctx.http)
            throw new Error('http capability required but not provided to mdblist batchLookup()');

        const results: Array<MdblistItem | null> = new Array(ids.length).fill(null);
        if (ids.length === 0) return results;

        // Short-circuit if a previous call landed a 429 and we're still in
        // the cool-down window. Mirrors `detail()`'s cooldown handling
        // (throws rather than returning null-filled results) — a silent
        // null-fill here is indistinguishable from "MDBList has no data for
        // any of these items", which tombstones the whole backlog as
        // no-data-upstream instead of surfacing the known outage. Throwing
        // makes the cooldown visible to the caller's outage detector
        // (`processedViaFallback` in mdblist-sync.ts) instead of masking it.
        const cooldownRemaining = mdblistCooldownRemainingMs();
        if (cooldownRemaining > 0) {
            const mins = Math.ceil(cooldownRemaining / 60000);
            const human = mins >= 60 ? `~${Math.floor(mins / 60)}h ${mins % 60}m` : `~${mins} min`;
            ctx.logger.warn(
                'MDBList batchLookup skipped — rate-limit cool-down active (free-tier quota); ' +
                    'resumes automatically, no action needed',
                {
                    idCount: ids.length,
                    retryInMinutes: mins,
                },
            );
            throw new Error(
                `MDBList rate-limit cool-down active (free-tier quota) — will retry in ${human}`,
            );
        }

        const apiKey = resolveApiKey();

        // Parse each input id into (groupKey, lookupKey, originalIndex).
        // groupKey selects the upstream endpoint; lookupKey correlates the
        // response item back to the input slot.
        type ParsedId = {
            originalIndex: number;
            idType: 'tmdb' | 'imdb';
            mediaType: 'movie' | 'show';
            // Value sent to the API: bare TMDB numeric string OR IMDB tt…
            apiId: string;
            // Composite lookup key used against the response map.
            // For TMDB: `${apiId}:${mediaType}`. For IMDB: the tt… string.
            lookupKey: string;
        };

        const parsed: ParsedId[] = [];
        for (let i = 0; i < ids.length; i++) {
            const id = ids[i];
            if (id.startsWith('tt')) {
                // IMDB endpoint requires media type; default to movie when
                // unknown (callers that need type-aware IMDB lookup should
                // use the tmdb composite encoding instead). batchLookup has
                // no per-id media-type context to detect a bare tt-id that
                // actually refers to a show — log once so a future caller
                // relying on this path for non-movie ids notices the
                // mis-typing risk instead of silently getting movie-shaped
                // (or absent) data back.
                if (!warnedBareImdbAssumption) {
                    warnedBareImdbAssumption = true;
                    ctx.logger.warn(
                        'mdblist batchLookup: bare IMDB id assumed movie — pass a ' +
                            '"tmdb:{id}:{movie|show}" composite id for type-aware lookup',
                        { sampleId: id },
                    );
                }
                const imdbMediaType = 'movie' as const;
                parsed.push({
                    originalIndex: i,
                    idType: 'imdb',
                    mediaType: imdbMediaType,
                    apiId: id,
                    // Include mediaType in lookupKey so the correlation map is
                    // composite-key-safe: prevents collision if the same IMDB tt-ID
                    // ever appears for both a movie and a show group in the same batch.
                    lookupKey: `${id}:${imdbMediaType}`,
                });
            } else if (id.startsWith('tmdb:')) {
                const parts = id.split(':');
                if (parts.length !== 3) {
                    // Leave the slot as null and continue — one bad id should
                    // not poison the whole batch.
                    ctx.logger.warn('mdblist batchLookup: invalid tmdb composite id', { id });
                    continue;
                }
                const [, tmdbId, rawType] = parts;
                // Strict validation — empty tmdbId or unknown mediaType would
                // otherwise produce a bad URL ($BASE/tmdb/whatever) that fails
                // the whole grouped chunk on 404.
                if (!tmdbId || !/^\d+$/.test(tmdbId)) {
                    ctx.logger.warn('mdblist batchLookup: tmdb id must be numeric', { id });
                    continue;
                }
                // eslint-disable-next-line callback-safety/no-bare-media-type-comparison -- MDBList's input vocabulary uses the external 'show' alias.
                if (rawType !== 'movie' && rawType !== 'tv' && rawType !== 'show') {
                    ctx.logger.warn('mdblist batchLookup: unknown media type', {
                        id,
                        rawType,
                    });
                    continue;
                }
                const mType: 'movie' | 'show' = rawType === 'tv' ? 'show' : rawType;
                parsed.push({
                    originalIndex: i,
                    idType: 'tmdb',
                    mediaType: mType,
                    apiId: tmdbId,
                    lookupKey: `${tmdbId}:${mType}`,
                });
            } else {
                ctx.logger.warn('mdblist batchLookup: unrecognised id format', {
                    id,
                });
            }
        }

        if (parsed.length === 0) return results;

        // Group by (idType, mediaType). Within each group, chunk into ≤200.
        const groups = new Map<string, ParsedId[]>();
        for (const p of parsed) {
            const key = `${p.idType}/${p.mediaType}`;
            const arr = groups.get(key);
            if (arr) arr.push(p);
            else groups.set(key, [p]);
        }

        const CHUNK_SIZE = 200;

        // Per-chunk outcome tracking. A single failed chunk (5xx, network)
        // still null-fills its slots and lets earlier successful chunks'
        // results survive — that lenient behavior is preserved for PARTIAL
        // failures. But if every attempted chunk fails (zero successful HTTP
        // responses across the whole call), that's a total outage, not "no
        // data for any of these items" — throw so the caller's outage
        // detector (mdblist-sync.ts's `processedViaFallback` guard) can tell
        // the difference instead of the backlog being permanently
        // tombstoned as no-data-upstream.
        let attemptedChunks = 0;
        let successfulChunks = 0;
        let lastFailureDetail: string | undefined;
        let rateLimited = false;

        outer: for (const [groupKey, members] of groups) {
            const [idType, mediaType] = groupKey.split('/') as ['tmdb' | 'imdb', 'movie' | 'show'];

            for (let offset = 0; offset < members.length; offset += CHUNK_SIZE) {
                const chunk = members.slice(offset, offset + CHUNK_SIZE);
                const url = `${MDBLIST_BASE}/${encodePathSegment(idType)}/${encodePathSegment(mediaType)}?apikey=${encodeURIComponent(apiKey)}`;

                attemptedChunks++;
                let items: MdblistItem[];
                try {
                    const response = await ctx.http.post(url, {
                        ids: chunk.map((c) => c.apiId),
                        append_to_response: ['review', 'keyword'],
                    });

                    if (!response.ok) {
                        ctx.logger.warn('mdblist batchLookup chunk failed', {
                            idType,
                            mediaType,
                            status: response.status,
                            statusText: response.statusText,
                            idCount: chunk.length,
                        });
                        lastFailureDetail = `HTTP ${response.status} ${response.statusText}`;
                        if (response.status === 429) {
                            // Trip the cool-down so this run's remaining
                            // chunks AND subsequent runs short-circuit
                            // until the rate limit window passes. Without
                            // this, the loop continues hitting 429 on
                            // every chunk, burning quota on every retry.
                            const retryAfter = Number(
                                response.headers?.get?.('retry-after') ??
                                    response.headers?.get?.('Retry-After') ??
                                    NaN,
                            );
                            setMdblistCooldown(Number.isFinite(retryAfter) ? retryAfter : null);
                            ctx.logger.warn('mdblist 429 — engaging rate-limit cool-down', {
                                cooldownMs: mdblistCooldownRemainingMs(),
                                retryAfterHeader: retryAfter,
                            });
                            rateLimited = true;
                            // Stop attempting further chunks this call (respect
                            // the rate limit) — fall through to the outcome
                            // check below rather than returning immediately,
                            // so a total outage still throws.
                            break outer;
                        }
                        continue;
                    }

                    items = ((await response.json()) as MdblistItem[]) ?? [];
                    successfulChunks++;
                } catch (err) {
                    // A cancelled run must propagate immediately — it is not
                    // an MDBList outage, and continuing would make further
                    // (doomed) network calls after the caller gave up.
                    if (isCancellationError(err)) throw err;
                    lastFailureDetail = err instanceof Error ? err.message : String(err);
                    ctx.logger.warn('mdblist batchLookup chunk threw', {
                        idType,
                        mediaType,
                        idCount: chunk.length,
                        err: lastFailureDetail,
                    });
                    continue;
                }

                // Build a lookup keyed the same way as the chunk members'
                // lookupKey so correlation is O(chunk).
                const byLookupKey = new Map<string, MdblistItem>();
                for (const item of items) {
                    if (idType === 'tmdb') {
                        const tmdbId = item.ids?.tmdb;
                        if (tmdbId != null) {
                            byLookupKey.set(`${tmdbId}:${mediaType}`, item);
                        }
                    } else {
                        // Composite key mirrors the lookupKey built at parse time:
                        // `${imdbId}:${mediaType}`. The group mediaType is always
                        // 'movie' for bare tt-IDs (see parse block above), so
                        // both sides are consistent.
                        const imdbId = item.ids?.imdb;
                        if (imdbId) byLookupKey.set(`${imdbId}:${mediaType}`, item);
                    }
                }

                for (const member of chunk) {
                    const hit = byLookupKey.get(member.lookupKey);
                    if (hit) results[member.originalIndex] = hit;
                }
            }
        }

        if (attemptedChunks > 0 && successfulChunks === 0) {
            throw new Error(
                `mdblist batchLookup: total outage — all ${attemptedChunks} chunk(s) failed` +
                    (rateLimited ? ' (rate-limited)' : '') +
                    (lastFailureDetail ? `; last error: ${lastFailureDetail}` : ''),
            );
        }

        return results;
    },
});

// Self-register so loadBuiltins() import is sufficient.
registry.registerProvider(mdblistProvider);
