// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * MAL Anime ID Enrichment — native defineTask implementation.
 *
 * Maps individual TMDB-numbered anime episodes to the MyAnimeList list-entry
 * IDs they belong to. MAL splits multi-cour anime into separate entries linked
 * by "sequel" relations: TMDB Voyage to Orion Season 3 = 22 episodes, but on
 * MAL that's Part 1 (12 episodes) + Part 2 (10 episodes) as two separate list
 * entries. Pushing 22/22 to Part 1 corrupts the user's list.
 *
 * Algorithm per anime series:
 *   1. Read the series-level MAL ID (from external_ids, written by the
 *      Fribb sync plugin).
 *   2. Walk MAL's `related_anime[].relation_type === 'sequel'` chain to
 *      collect the entry list and each entry's `num_episodes`.
 *   3. Slice the TMDB-ordered episode list (`flattenSeriesEpisodesRaw`)
 *      across the chain — first N1 episodes -> entry #1, next N2 episodes
 *      -> entry #2, and so on.
 *   4. Write per-episode rows to `media_external_groupings`, then prune any
 *      stale rows for episodes no longer in the chain.
 *
 * Coverage relies on the Fribb plugin running first; series without a stored
 * MAL ID are reported as `ineligible` in the backlog and skipped here.
 *
 * Modes:
 *   - catchup: process one slice (50 series) per scheduled weekly tick
 *   - manual:  drain all stale/never-enriched series until empty or budget hit
 *   - force:   wipe all rows written by this plugin, then drain as manual
 *
 * Auth: borrows a working MAL OAuth token from any user who has linked their
 * MAL account via the external `mal-watch-sync` plugin (looked up by
 * plugin_user_credentials.plugin_id). No app credentials, no run.
 *
 * Configuration:
 * - DISABLE_MAL_ANIME_ENRICHMENT: Set to 'true' to disable this task entirely.
 *   Checked at execute() entry so manual triggers are also blocked.
 */

import { z } from 'zod';
import { toUserId, type UserId } from '$lib/shared/user-id';
import { defineTask, TaskError } from '@sapd/lumastra-plugin-sdk';
import type { BacklogStage, TaskContext, HttpClient } from '@sapd/lumastra-plugin-sdk';
import { config } from '$lib/server/config.js';
import type postgres from 'postgres';
import {
    upsertCompletedRow,
    upsertSkippedPermanentRow,
    markSkippedTransientBatch,
    deferTransientRetryBatch,
} from '../../../database/queries/stage-state.queries.js';
import {
    listMalBorrowerCredentials,
    markMalAuthFailed,
} from '../../../database/queries/mal-credentials.queries.js';
import { getAuthoritativeStageIds } from '$lib/server/config.js';
import { parseRetryAfterHeader } from '$lib/server/utils/http-retry.js';
import { registry } from '../../registry.js';
import { withApiCallSpend } from '../../api-call-spend.js';

// ============================================================================
// Constants
// ============================================================================

const PROVIDER = 'mal';
const SOURCE = 'mal-anime-id-enrichment';
/** Stage skip reason while `DISABLE_MAL_ANIME_ENRICHMENT` is set (reclaimed when cleared). */
export const MAL_ENRICHMENT_DISABLED_REASON = 'mal-anime-enrichment-disabled';
const MAL_API_BASE = 'https://api.myanimelist.net/v2';
const MAL_TOKEN_URL = 'https://myanimelist.net/v1/oauth2/token';
const MAL_MIN_GAP_MS = 750;
const MAX_SEQUEL_DEPTH = 50;
const MAX_BORROWER_TRIES = 5;
const MAX_5XX_RETRIES = 2;
// BUG 6 fix: a 429 is not a transient infra blip like a 5xx — it's MAL
// explicitly telling us to slow down, usually with a `Retry-After` header.
// The old code let 429s fall through the "only 5xx retried" branch straight
// to a permanent per-item failure, even though the fixed 750ms throttle gap
// kept firing at the *rejected* rate the whole time. Small, separate budget
// from MAX_5XX_RETRIES so a 429 storm can't multiply with 5xx retries into
// an unbounded stall.
const MAX_429_RETRIES = 3;
// Fallback wait when MAL sends 429 without a parseable Retry-After header.
const DEFAULT_429_BACKOFF_MS = 5000;
// Hard cap on any single Retry-After-driven wait (shared with
// parseRetryAfterHeader's own 60s cap; kept explicit here for the
// no-header fallback path too).
const RETRY_AFTER_CAP_MS = 60_000;
// 2026-05-24: bumped 50→1000. Original 50/week was "drip-feed" sizing for
// a catalog that grows slowly. With 8k+ pending on real-world libraries it
// would take ≈3 years to drain. 1000 items × 750ms MAL_MIN_GAP_MS = 12.5 min
// per run, well within the 24h schedule. Combined with the schedule drop
// from 168h→24h yields 1000/day = 8-day drain on an 8k backlog. MAL's API
// quota isn't a tighter ceiling than the per-call gap, so this is safe.
const SLICE_SIZE = 1000;
const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
// BUG 1 fix: a series with zero episodes yet (drained before series-sync
// populated its episodes) is not a permanent "not eligible" case — it's a
// timing race. No pipeline event fires for "episodes were added to a
// series" that this stage subscribes to (`invalidatedBy` only covers
// identity.*), so there is no event-driven recovery path. Retry on a fixed
// 24h backoff (matches this task's own schedule cadence — no point
// retrying faster than the task itself runs) instead of tombstoning
// permanently via skipped_permanent.
const EMPTY_WRITES_RETRY_MS = 24 * 60 * 60 * 1000;
// BUG 2 fix: a still-airing chain entry (num_episodes<=0) means MAL hasn't
// finished publishing episode counts for that cour yet. There is no MAL
// webhook/event we subscribe to for "airing finished" — the only way to
// find out is to re-poll. Airing seasons typically resolve within days, so
// re-check weekly rather than hammering MAL (or worse, being stuck forever
// behind a permanent 'completed' stage row that can never re-run).
const AIRING_RETRY_MS = 7 * 24 * 60 * 60 * 1000;

// A per-item error (MAL 5xx, exhausted 429 retries, a timeout) leaves the
// coverage row's status alone, so without a deferral it keeps its place at the
// head of the backlog and every run re-walks it first — and a full page of
// failing rows starves everything behind it. Push it back instead.
const ERROR_RETRY_MS = 6 * 60 * 60 * 1000;

// ============================================================================
// Types
// ============================================================================

interface BorrowerAuth {
    userId: UserId;
    accessToken: string;
    refreshToken: string | null;
}

interface MalRelatedAnime {
    node?: { id?: number };
    relation_type?: string;
}

interface MalAnimeInfo {
    id?: number;
    num_episodes?: number;
    media_type?: string;
    related_anime?: MalRelatedAnime[];
}

interface ChainEntry {
    malId: string;
    numEpisodes: number;
}

type EnrichStatus = 'complete' | 'partial-airing' | 'skip-fresh' | 'skip-empty-writes' | 'no-chain';

interface EnrichResult {
    wrote: number;
    deleted: number;
    status: EnrichStatus;
}

// ============================================================================
// MAL throttle (global, promise-chained)
// ============================================================================

const MAX_THROTTLE_QUEUE_DEPTH = 100;

let throttleChain: Promise<void> = Promise.resolve();
let throttleLastAt = 0;
let throttleQueueDepth = 0;

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Abort-aware sleep for the 429 Retry-After wait (BUG 6). A plain `delay()`
 * would keep a slice — and the run's abort/cancel path — blocked for up to
 * `RETRY_AFTER_CAP_MS` even after the operator cancels the run. Rejects
 * immediately (or as soon as the signal fires) instead of resolving, so a
 * cancel during the wait surfaces as an abort to the caller rather than
 * silently finishing the sleep.
 */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
            return;
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = (): void => {
            clearTimeout(timer);
            reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

function malThrottle(): Promise<void> {
    if (throttleQueueDepth >= MAX_THROTTLE_QUEUE_DEPTH) {
        return Promise.reject(
            new Error(
                `MAL throttle queue depth exceeded ${MAX_THROTTLE_QUEUE_DEPTH}; dropping request`,
            ),
        );
    }
    throttleQueueDepth++;
    const next = throttleChain
        .then(async () => {
            const now = Date.now();
            const wait = throttleLastAt + MAL_MIN_GAP_MS - now;
            if (wait > 0) await delay(wait);
            throttleLastAt = Date.now();
        })
        .finally(() => {
            throttleQueueDepth--;
        });
    throttleChain = next.catch(() => {
        /* swallow */
    });
    return next;
}

// ============================================================================
// MAL OAuth helpers
// ============================================================================

interface AppCreds {
    clientId: string;
    clientSecret: string;
}

function getAppCredentials(): AppCreds | null {
    const clientId = config.MAL_CLIENT_ID;
    const clientSecret = config.MAL_CLIENT_SECRET;
    if (!clientId || !clientSecret) return null;
    return { clientId, clientSecret };
}

interface RefreshResult {
    accessToken: string;
    refreshToken: string;
}

// Per-userId in-flight refresh deduper. MAL OAuth treats refresh_tokens as
// single-use — replaying the same refresh_token concurrently invalidates
// every attempt after the first. Two in-flight 401s for the same borrower
// inside one worker would otherwise both call refreshUserToken with the same
// pre-refresh refresh_token; this Map collapses them to a single network call.
const refreshLocks = new Map<string, Promise<RefreshResult | null>>();

async function refreshUserToken(
    sql: postgres.Sql,
    userId: UserId,
    refreshToken: string,
    logger: TaskContext['logger'],
    http: HttpClient,
): Promise<RefreshResult | null> {
    const existing = refreshLocks.get(userId);
    if (existing) return existing;

    const promise = refreshUserTokenInner(sql, userId, refreshToken, logger, http).finally(() => {
        // Clear *after* completion so concurrent callers waiting on the
        // same Promise resolve to the same result, but a subsequent 401
        // (e.g., after the new token also expires) triggers a fresh call.
        refreshLocks.delete(userId);
    });
    refreshLocks.set(userId, promise);
    return promise;
}

async function refreshUserTokenInner(
    sql: postgres.Sql,
    userId: UserId,
    refreshToken: string,
    logger: TaskContext['logger'],
    http: HttpClient,
): Promise<RefreshResult | null> {
    if (!refreshToken.trim()) return null;
    const app = getAppCredentials();
    if (!app) {
        logger.warn('Cannot refresh MAL token: MAL_CLIENT_ID/SECRET not configured', {
            userId,
        });
        return null;
    }

    const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: app.clientId,
        client_secret: app.clientSecret,
    });

    try {
        await malThrottle();
        const resp = await http.post(MAL_TOKEN_URL, body.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });
        if (!resp.ok) {
            logger.warn('MAL token refresh failed', {
                userId,
                status: resp.status,
            });
            const failure: unknown = await resp.json().catch(() => null);
            if (
                (resp.status === 400 || resp.status === 401) &&
                typeof failure === 'object' &&
                failure !== null &&
                'error' in failure &&
                typeof failure.error === 'string' &&
                ['invalid_grant', 'invalid_refresh_token', 'refresh_token_revoked'].includes(
                    failure.error,
                )
            ) {
                await markMalAuthFailed(sql, userId);
            }
            return null;
        }
        const data = (await resp.json()) as {
            access_token?: string;
            refresh_token?: string;
            expires_in?: number;
        };
        if (!data.access_token) {
            logger.warn('MAL refresh returned no access_token', { userId });
            return null;
        }
        const newAccessToken = data.access_token;
        const newRefreshToken = data.refresh_token ?? refreshToken;
        // expires_in of 0 or negative means already expired; treat as null so
        // the next request triggers a fresh refresh rather than using an expired token.
        const expiresAt =
            data.expires_in && data.expires_in > 0
                ? new Date(Date.now() + data.expires_in * 1000)
                : null;

        const { updateMalTokens } =
            await import('../../../database/queries/mal-credentials.queries.js');
        await updateMalTokens(sql, userId, newAccessToken, newRefreshToken, expiresAt);

        return { accessToken: newAccessToken, refreshToken: newRefreshToken };
    } catch (err) {
        logger.warn('MAL token refresh error', {
            userId,
            error: err instanceof Error ? err.message : String(err),
        });
        return null;
    }
}

async function malApiForUser(
    sql: postgres.Sql,
    path: string,
    auth: BorrowerAuth,
    logger: TaskContext['logger'],
    http: HttpClient,
    signal?: AbortSignal,
): Promise<Response> {
    const url = path.startsWith('http') ? path : `${MAL_API_BASE}${path}`;
    if (path.startsWith('http') && !url.startsWith(MAL_API_BASE)) {
        throw new Error('Invalid MAL API URL');
    }

    let resp: Response | undefined;
    // BUG 6 fix: 429 and 5xx are tracked with independent attempt budgets
    // (and independent backoff strategies — Retry-After-driven vs.
    // exponential) so a burst of one kind can't silently eat the other's
    // retry allowance. The fixed MAL_MIN_GAP_MS throttle alone does NOT
    // back off on 429 — it keeps firing at the same (rejected) rate, so
    // without this a rate-limited borrower would fail every item in the
    // slice at the throttle's full pace instead of actually waiting out
    // the limiter.
    let fiveXxAttempt = 0;
    let rateLimitAttempt = 0;
    for (;;) {
        await malThrottle();
        resp = await http.get(url, {
            headers: { Authorization: `Bearer ${auth.accessToken}` },
        });

        if (resp.status === 429 && rateLimitAttempt < MAX_429_RETRIES) {
            rateLimitAttempt++;
            const headerWaitMs = parseRetryAfterHeader(resp.headers?.get?.('retry-after'));
            const waitMs = Math.min(headerWaitMs ?? DEFAULT_429_BACKOFF_MS, RETRY_AFTER_CAP_MS);
            logger.info('MAL API rate limited (429), honoring Retry-After before retry', {
                path,
                waitMs,
                fromHeader: headerWaitMs !== null,
                attempt: rateLimitAttempt,
                budget: MAX_429_RETRIES,
            });
            await abortableDelay(waitMs, signal);
            continue;
        }

        if (resp.status >= 500 && resp.status < 600 && fiveXxAttempt < MAX_5XX_RETRIES) {
            fiveXxAttempt++;
            const backoffMs = 2000 * Math.pow(2, fiveXxAttempt - 1);
            logger.info('MAL API transient 5xx, retrying', {
                path,
                status: resp.status,
                attempt: fiveXxAttempt,
                backoffMs,
            });
            await delay(backoffMs);
            continue;
        }
        break;
    }

    if (!resp) {
        throw new Error('MAL API call produced no response');
    }

    if (resp.status === 401 && auth.refreshToken) {
        const refreshed = await refreshUserToken(sql, auth.userId, auth.refreshToken, logger, http);
        if (refreshed) {
            auth.accessToken = refreshed.accessToken;
            auth.refreshToken = refreshed.refreshToken;
            await malThrottle();
            resp = await http.get(url, {
                headers: { Authorization: `Bearer ${auth.accessToken}` },
            });
            if (resp.status === 401) {
                logger.warn('MAL API still 401 after token refresh — credential may be invalid', {
                    userId: auth.userId,
                    path,
                });
            }
        }
    }

    return resp;
}

async function malGetForUser<T>(
    sql: postgres.Sql,
    path: string,
    auth: BorrowerAuth,
    logger: TaskContext['logger'],
    http: HttpClient,
    signal?: AbortSignal,
): Promise<T> {
    const resp = await malApiForUser(sql, path, auth, logger, http, signal);
    if (!resp.ok) {
        // BUG 8 fix: status is prefixed with `status=` and kept separate from
        // `path` so callers can regex-match the real HTTP status without
        // colliding with a MAL anime id embedded in the path (e.g. `/anime/404`,
        // `/anime/429`, `/anime/401` are all real, low, early-catalog MAL ids).
        // The old `MAL API ${path}: ${status} ${statusText}` format let a 403 on
        // anime id 404 match getAnimeInfo's `\b404\b` "not found" detection,
        // silently tombstoning a transient error as a permanent no-chain skip.
        throw new Error(
            `MAL API request failed: status=${resp.status} (${resp.statusText}) path=${path}`,
        );
    }
    return (await resp.json()) as T;
}

// ============================================================================
// Borrower account selection
// ============================================================================

async function getBorrowerAuth(
    sql: postgres.Sql,
    logger: TaskContext['logger'],
    http: HttpClient,
): Promise<BorrowerAuth | null> {
    const { listMalBorrowerCredentials } =
        await import('../../../database/queries/mal-credentials.queries.js');
    const candidates = await listMalBorrowerCredentials(sql, MAX_BORROWER_TRIES);

    for (const candidate of candidates) {
        const auth: BorrowerAuth = {
            userId: toUserId(candidate.userId),
            accessToken: candidate.accessToken,
            refreshToken: candidate.refreshToken,
        };
        try {
            const resp = await malApiForUser(sql, '/users/@me', auth, logger, http);
            if (resp.ok) return auth;
        } catch (err) {
            logger.debug('Borrower auth probe failed, trying next', {
                userId: auth.userId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    return null;
}

// ============================================================================
// MAL data helpers
// ============================================================================

async function getAnimeInfo(
    sql: postgres.Sql,
    animeId: string,
    auth: BorrowerAuth,
    logger: TaskContext['logger'],
    http: HttpClient,
    signal?: AbortSignal,
): Promise<MalAnimeInfo | null> {
    try {
        return await malGetForUser<MalAnimeInfo>(
            sql,
            `/anime/${animeId}?fields=related_anime,num_episodes,media_type`,
            auth,
            logger,
            http,
            signal,
        );
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // BUG 8 fix: match the `status=` field malGetForUser emits, not a bare
        // \b404\b that would also match a MAL anime id of literally "404".
        if (/status=404\b/.test(msg)) {
            logger.warn('MAL anime not found (404)', { animeId });
            return null;
        }
        throw err;
    }
}

function getAnimeSequel(info: MalAnimeInfo): string | null {
    const related = info.related_anime;
    if (!Array.isArray(related)) return null;
    for (const rel of related) {
        if (rel.relation_type === 'sequel' && rel.node?.id != null) {
            return String(rel.node.id);
        }
    }
    return null;
}

// ============================================================================
// Per-series enrichment
// ============================================================================

function chainSignatureOf(chain: ChainEntry[]): string {
    return JSON.stringify(chain.map((c) => [c.malId, c.numEpisodes]));
}

async function enrichSeries(
    sql: postgres.Sql,
    candidate: { seriesId: string; seriesMalId: string },
    auth: BorrowerAuth,
    logger: TaskContext['logger'],
    abortSignal: AbortSignal,
    http: HttpClient,
    useCoverageTable: boolean,
): Promise<EnrichResult> {
    const { seriesId, seriesMalId } = candidate;

    const { flattenSeriesEpisodesRaw } =
        await import('../../../database/queries/media-hierarchy.queries.js');
    const {
        upsertGroupings,
        deleteStaleGroupings,
        upsertSeriesGroupingState,
        getSeriesGroupingState,
    } = await import('../../../database/queries/media-external-groupings.queries.js');
    const { withTx } = await import('../../../database/with-tx.js');

    // Tombstone the coverage row on a DURABLE, genuinely-permanent no-result
    // path so the row leaves `pending` instead of being re-selected by the
    // coverage backlog every cycle (the residual wedge). Mirrors fribb's
    // inline tombstone: best-effort, only when the coverage table is the
    // source of truth, never fatal to the run. Transient paths (abort,
    // thrown error) intentionally do NOT call this so they retry.
    //
    // Only 'mal:no-chain' (the registered MAL id itself 404s) uses this —
    // see the module-level comment on `recoverWhenAdditionalReasons` for why
    // it must NOT be listed in the stage's event-independent heal, and why
    // that's still safe: correcting the id (delete+reinsert, update, or
    // clear+reassign) always fires an `identity.*` event this stage
    // subscribes to, which flips a `skipped_permanent` row back to
    // `pending` directly — no heal-list entry needed.
    const tombstone = async (reason: string): Promise<void> => {
        if (!useCoverageTable) return;
        try {
            await upsertSkippedPermanentRow(sql, {
                mediaItemId: seriesId,
                stageId: 'mal-anime-id-enrichment',
                processingVersion: 1,
                skippedReason: reason,
            });
        } catch (err) {
            logger.warn('Failed to write skipped_permanent stage row', {
                seriesId,
                reason,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    };

    // BUG 1 / BUG 2 fix: unlike `tombstone`, this writes a RETRYABLE
    // `skipped_transient` row (not skipped_permanent) with a backoff. Used
    // for durable-but-NOT-permanent no-result paths: the series has no
    // episodes YET (BUG 1) or MAL hasn't finished airing a cour YET (BUG 2).
    // Neither condition has a pipeline event to recover it — series-sync
    // populating episodes and MAL finishing a cour are both invisible to
    // this stage's `invalidatedBy: identity.*` — so an event-independent
    // backoff is the only mechanism that actually re-runs it.
    const transientSkip = async (reason: string, retryAfterMs: number): Promise<void> => {
        if (!useCoverageTable) return;
        try {
            await markSkippedTransientBatch(sql, {
                stageId: 'mal-anime-id-enrichment',
                mediaItemIds: [seriesId],
                skippedReason: reason,
                retryAfterMs,
            });
        } catch (err) {
            logger.warn('Failed to write skipped_transient stage row', {
                seriesId,
                reason,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    };

    const flat = await flattenSeriesEpisodesRaw(sql, seriesId);

    if (flat.length === 0) {
        // "No episodes YET" is only true if episodes can still arrive, i.e. some
        // file exists somewhere under this series. A discovery/catalog row with no
        // file anywhere in its subtree has no episodes and never will, so the 24h
        // retry below is an appointment it keeps forever: on prod, 270 of the 283
        // rows parked in skipped_transient were fileless, seasonless and
        // episodeless, re-walking a MAL sequel chain every single day.
        //
        // Tombstone those permanently instead. Recovery runs through the
        // event-INDEPENDENT heal, NOT through file.attached: that event carries the
        // EPISODE's id and invalidateByEvent does no ancestor fan-out, so it never
        // reaches this stage's row on the series. eligibility.sql requires a file in
        // the subtree and 'mal:no-files' is listed in recoverWhenAdditionalReasons,
        // so the heal reclaims the row exactly when episodes with files appear.
        const [{ has_file: subtreeHasFile } = { has_file: false }] = await sql<
            { has_file: boolean }[]
        >`
            -- Deliberately character-identical to the file-presence clause in this
            -- stage's eligibility.sql (see coversStages below); the pairing is asserted
            -- by mal-file-predicate-pairing.test.ts. These two must be exact
            -- complements: this one decides whether to tombstone 'mal:no-files', that
            -- one decides whether the heal may reclaim it. Any shape difference lets a
            -- row fall between them and never be enriched or revived.
            SELECT (
                EXISTS (SELECT 1 FROM media_file_items mfi WHERE mfi.media_item_id = ${seriesId})
                OR EXISTS (
                    SELECT 1 FROM media_items sea
                      JOIN media_file_items mfi ON mfi.media_item_id = sea.id
                     WHERE sea.parent_id = ${seriesId}
                )
                OR EXISTS (
                    SELECT 1 FROM media_items sea
                      JOIN media_items ep ON ep.parent_id = sea.id
                      JOIN media_file_items mfi ON mfi.media_item_id = ep.id
                     WHERE sea.parent_id = ${seriesId}
                )
            ) AS has_file
        `;
        if (!subtreeHasFile) {
            logger.debug('Series has no files anywhere in its subtree; tombstoning', {
                seriesId,
            });
            await tombstone('mal:no-files');
            return { wrote: 0, deleted: 0, status: 'skip-empty-writes' };
        }
        logger.debug('Series has no episodes yet; will retry once they appear', {
            seriesId,
        });
        await transientSkip('mal:empty-writes', EMPTY_WRITES_RETRY_MS);
        return { wrote: 0, deleted: 0, status: 'skip-empty-writes' };
    }

    const chain: ChainEntry[] = [];
    const seenIds = new Set<string>();
    let currentId = seriesMalId;
    seenIds.add(currentId);

    for (let depth = 0; depth < MAX_SEQUEL_DEPTH; depth++) {
        if (abortSignal.aborted) {
            return { wrote: 0, deleted: 0, status: 'no-chain' };
        }
        let info: MalAnimeInfo | null;
        try {
            info = await getAnimeInfo(sql, currentId, auth, logger, http, abortSignal);
        } catch (err) {
            // A 429 retry (BUG 6) sleeps via an abort-aware wait; if the run
            // was cancelled mid-wait it rejects instead of resolving. Treat
            // that the same as the pre-emptive abort check above rather than
            // letting it bubble up as a generic per-item error (which would
            // count against the outage-detection guard in execute()).
            if (abortSignal.aborted) {
                return { wrote: 0, deleted: 0, status: 'no-chain' };
            }
            throw err;
        }
        if (!info) {
            logger.warn('Anime info missing during chain walk', {
                seriesId,
                malId: currentId,
            });
            break;
        }
        const rawCount = info.num_episodes;
        const numEpisodes =
            typeof rawCount === 'number' && Number.isFinite(rawCount) && rawCount >= 0
                ? Math.floor(rawCount)
                : 0;
        chain.push({ malId: currentId, numEpisodes });
        const sequelId = getAnimeSequel(info);
        if (!sequelId || seenIds.has(sequelId)) break;
        currentId = sequelId;
        seenIds.add(currentId);
    }

    if (chain.length === 0) {
        await tombstone('mal:no-chain');
        return { wrote: 0, deleted: 0, status: 'no-chain' };
    }

    const signature = chainSignatureOf(chain);
    const existing = await getSeriesGroupingState(sql, seriesId, PROVIDER, SOURCE);
    if (
        existing &&
        existing.chainSignature === signature &&
        existing.flattenedEpisodeCount === flat.length &&
        Date.now() - existing.lastEnrichedAt.getTime() < STALE_AFTER_MS
    ) {
        logger.debug('Skipping series — chain signature unchanged', {
            seriesId,
            chainLength: chain.length,
            episodes: flat.length,
        });
        // Nothing changed since the last enrichment, so re-apply the disposition
        // that enrichment earned. Without this the coverage row stayed due: a
        // partial-airing series whose 7-day `skipped_transient` backoff expired
        // was re-selected, re-walked on MAL and skipped here without a write —
        // forever, until its state went 30-day stale. On prod 7 such rows were
        // re-walked ~18 times per run (every slice re-fetched them), 4-5k MAL
        // requests a day for zero enrichment.
        if (useCoverageTable) {
            try {
                if (existing.enrichedEpisodeCount < existing.flattenedEpisodeCount) {
                    await markSkippedTransientBatch(sql, {
                        stageId: 'mal-anime-id-enrichment',
                        mediaItemIds: [seriesId],
                        skippedReason: 'mal:partial-airing',
                        retryAfterMs: AIRING_RETRY_MS,
                    });
                } else {
                    await upsertCompletedRow(sql, {
                        mediaItemId: seriesId,
                        stageId: 'mal-anime-id-enrichment',
                        processingVersion: 1,
                    });
                }
            } catch (err) {
                logger.warn('Failed to re-disposition skip-fresh stage row', {
                    seriesId,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }
        return { wrote: 0, deleted: 0, status: 'skip-fresh' };
    }

    type GroupingRow = {
        mediaId: string;
        provider: string;
        groupExternalId: string;
        source: string;
    };
    const writes: GroupingRow[] = [];
    let cursor = 0;
    let abortedAtAiringEntry = false;

    for (const entry of chain) {
        if (entry.numEpisodes <= 0) {
            logger.warn('MAL entry has num_episodes=0 (likely airing) — stopping slice early', {
                seriesId,
                malId: entry.malId,
                episodesCovered: cursor,
                total: flat.length,
            });
            abortedAtAiringEntry = true;
            break;
        }
        const take = Math.min(entry.numEpisodes, flat.length - cursor);
        if (take <= 0) break;
        for (let i = 0; i < take; i++) {
            writes.push({
                mediaId: flat[cursor + i].episode_id,
                provider: PROVIDER,
                groupExternalId: entry.malId,
                source: SOURCE,
            });
        }
        cursor += take;
        if (cursor >= flat.length) break;
    }

    if (writes.length === 0) {
        logger.warn('Enrichment produced no mappings — leaving series for next cycle', {
            seriesId,
            baseMalId: seriesMalId,
            chainEntries: chain.length,
            abortedAtAiringEntry,
        });
        // BUG 2: this can be the FIRST chain entry aborting before a single
        // episode was mapped (still airing from cour start) — same
        // durable-but-not-permanent situation as the mid-chain abort below,
        // just with wrote===0. Use the airing-specific reason/backoff so it
        // gets re-checked on the airing timescale rather than the shorter
        // generic empty-writes one.
        if (abortedAtAiringEntry) {
            await transientSkip('mal:partial-airing', AIRING_RETRY_MS);
        } else {
            await transientSkip('mal:empty-writes', EMPTY_WRITES_RETRY_MS);
        }
        return { wrote: 0, deleted: 0, status: 'skip-empty-writes' };
    }

    const dedupedMap = new Map<string, GroupingRow>();
    for (const w of writes) dedupedMap.set(w.mediaId, w);
    const dedupedWrites = [...dedupedMap.values()];

    if (dedupedWrites.length !== writes.length) {
        logger.warn('Flatten returned duplicate episode IDs; deduped before upsert', {
            seriesId,
            original: writes.length,
            deduped: dedupedWrites.length,
        });
    }

    const keepIds = dedupedWrites.map((w) => w.mediaId);
    let deleted = 0;
    await withTx(sql, async (tx) => {
        // Partial writes are valid and always kept: the episodes MAL has
        // already resolved are correctly grouped even when a later cour in
        // the chain is still airing.
        await upsertGroupings(tx, dedupedWrites);
        deleted = await deleteStaleGroupings(tx, seriesId, PROVIDER, SOURCE, keepIds);
        await upsertSeriesGroupingState(tx, {
            seriesId,
            provider: PROVIDER,
            source: SOURCE,
            lastEnrichedAt: new Date(),
            chainSignature: signature,
            flattenedEpisodeCount: flat.length,
            enrichedEpisodeCount: dedupedWrites.length,
        });
        // BUG 2 fix: a still-airing cour means the mapping is INCOMPLETE by
        // design — the remaining episodes have no MAL entry yet. Marking the
        // stage `completed` here would freeze the chain permanently, since no
        // invalidation event exists for "MAL finished airing this cour" (only
        // identity.* events re-open a completed/skipped row, and the series'
        // MAL id isn't changing). Write a retryable `skipped_transient` with a
        // weekly backoff instead, so the coverage-table backlog re-selects
        // this series once the airing timescale has plausibly moved — while
        // still keeping this run's partial groupings above.
        if (abortedAtAiringEntry) {
            if (useCoverageTable) {
                await markSkippedTransientBatch(tx as unknown as postgres.Sql, {
                    stageId: 'mal-anime-id-enrichment',
                    mediaItemIds: [seriesId],
                    skippedReason: 'mal:partial-airing',
                    retryAfterMs: AIRING_RETRY_MS,
                });
            }
        } else {
            await upsertCompletedRow(tx as unknown as postgres.Sql, {
                mediaItemId: seriesId,
                stageId: 'mal-anime-id-enrichment',
                processingVersion: 1,
            });
        }
    });

    return {
        wrote: dedupedWrites.length,
        deleted,
        status: abortedAtAiringEntry ? 'partial-airing' : 'complete',
    };
}

// ============================================================================
// Task definition
// ============================================================================

const inputSchema = z.object({}).passthrough();

type MalAnimeIdEnrichmentInput = Record<string, unknown>;

interface MalAnimeIdEnrichmentResult {
    enriched: number;
    skipped: number;
    partialAiring: number;
    errors: number;
    message: string;
}

export const malAnimeIdEnrichmentTask = defineTask<
    MalAnimeIdEnrichmentInput,
    MalAnimeIdEnrichmentResult
>({
    id: 'mal-anime-id-enrichment',
    purpose: 'library',
    name: 'MAL Anime ID Enrichment',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',

    capabilities: { database: true, http: true },

    // 2026-05-24: dropped 168h → 24h to drain accumulated backlogs at a
    // useful pace (was ≈3 years for 8k items, now ≈8 days with SLICE_SIZE
    // also bumped 50→1000). Per-run cost ≈12.5 min minimum (1000 ×
    // MAL_MIN_GAP_MS=750ms); steady-state-empty runs cost ~1s for the
    // "nothing to do" check. Once an operator's catalog is drained they
    // can override via env back to weekly cadence.
    schedule: {
        every: '24h',
        runOnStartup: false,
    },

    // MODE-INDEPENDENT on purpose — see music-popularity.ts for the long form.
    // exclusiveWith has no key formula of its own: the orchestrator's SETNX
    // mutex key is `identityKey(taskId, identityFor(input))`, so it inherits
    // whatever this returns. While this was mode-suffixed, catchup, manual and
    // force each got their OWN key, and the guard below collapsed only same-mode
    // re-fires — never cross-mode overlap. That defeated the exact thing it was
    // added for (duplicate provider traffic), and once `force` gained a wipe it
    // also let the wipe delete rows a manual or catchup run was mid-write on.
    // Here the three modes are the same work at different depths, so
    // single-flight across all of them is the correct semantics.
    identityFor: () => 'global',
    scope: 'global',
    // Mass-enrichment — MAL ID lookups, API-bound.
    resourceClass: 'bulk',
    // Honours `{ mode: 'manual' }` — drains the whole backlog in one
    // run instead of the single batch a scheduled catchup cycle does.
    supportsFullRun: true,
    // Drops this provider's external groupings and series grouping state, then re-derives them.
    supportsForceRun: true,

    // Singleton guard: MAL lookups are rate-limited (MAL_MIN_GAP_MS) external
    // API calls. Without exclusiveWith, the scheduler's narrow double-fire
    // window (fast-completing run + failed scheduler_state advance) can spawn
    // a second concurrent 'global-catchup' sweep that doubles MAL traffic for
    // no extra coverage. identityFor is mode-independent, so this
    // covers every entry point. ttl exceeds the 60m hard timeout with margin.
    exclusiveWith: { scope: 'global', ttl: '70m' },

    inputSchema,

    coversStages: [
        {
            id: 'mal-anime-id-enrichment',
            appliesTo: ['series'] as const,
            // NOTE: file.attached does NOT revive a 'mal:no-files' tombstone, and an
            // earlier version of this comment claimed it did. The trigger emits that
            // event with the EPISODE's media_item_id, and invalidateByEvent has no
            // ancestor fan-out, so it never reaches this stage's row on the SERIES.
            // Revival is the event-INDEPENDENT heal instead: eligibility.sql requires
            // a file in the subtree and 'mal:no-files' is in
            // recoverWhenAdditionalReasons. It is kept in this list only for a file
            // attached directly to the series row, which is not the fileless case.
            invalidatedBy: [
                'identity.assigned',
                'identity.changed',
                'identity.cleared',
                'file.attached',
            ] as const,
            enqueueable: true,
            // H2 fix. Eligibility = an anime series (non-empty anime_genres) WITH a
            // MAL series-level external_id. This is the event-INDEPENDENT recovery
            // rail: a genuine anime series cataloged BEFORE mdblist-sync wrote its
            // anime_genres (12h cadence) — and tombstoned 'mal:not-anime' by the old
            // code with no event to ever recover it — is flipped back to `pending` by
            // the heal the instant anime_genres lands. `skipAutoDispose: true` because
            // disposal here is UPSTREAM-GATED: the `not-in-anime-catalog` predicate
            // below carries `requiresUpstreamRun:'mdblist-sync'` so it cannot tombstone
            // a series until mdblist-sync has actually run for it — the generic
            // `NOT(sql)` dispose cannot express that gate, so it is suppressed. (anime_
            // genres in the heal SQL means the heal only ever flips a row that is NOW
            // genuinely eligible, so it never oscillates with the predicate below.)
            //
            // The leading literal is `DISABLE_MAL_ANIME_ENRICHMENT` (live getter, read
            // per call): while the task is switched off nothing is eligible, and the
            // 'mal-anime-enrichment-enabled' predicate below parks the rows. Clearing the
            // flag lets the heal reclaim them (up to PER_STAGE_HEAL_QUIET_MS, 15 min,
            // later: stage-sweep's heal goes quiet after ticks that reclaim nothing).
            eligibility: {
                sql: (sql) => sql`
                    ${config.DISABLE_MAL_ANIME_ENRICHMENT ? sql`false` : sql`true`}
                    AND EXISTS (SELECT 1 FROM external_ids ei WHERE ei.media_id = mi.id AND ei.provider = 'mal')
                    AND EXISTS (
                        SELECT 1 FROM provider_metadata pm
                         WHERE pm.media_id = mi.id
                           AND jsonb_typeof(pm.metadata->'anime_genres') = 'array'
                           -- Test non-empty via inequality, NOT jsonb_array_length:
                           -- mdblist-sync writes anime_genres as JSON null (a scalar)
                           -- for every non-anime series (11k+ rows), and
                           -- jsonb_array_length(scalar) THROWS. Postgres does not
                           -- reliably short-circuit the typeof guard, so the throw
                           -- aborted this heal AND the not-in-anime disposition every
                           -- 60s tick — wedging 500+ non-anime series pending forever.
                           AND pm.metadata->'anime_genres' <> '[]'::jsonb
                           -- OFFSET 0 keeps this a per-row check. Without it the
                           -- planner turns the EXISTS into a semi-join that reads
                           -- anime_genres out of every provider_metadata row
                           -- (~450 ms on prod, 120k rows) to heal a few thousand
                           -- stage rows (~36 ms in total this way). An EXISTS
                           -- ignores how many rows come back, so it cannot change
                           -- the result.
                           OFFSET 0
                    )
                    -- Subtree must hold at least one FILE. A fileless discovery row
                    -- has no episodes to enrich and never will, so enriching it is
                    -- work that cannot succeed: enrichSeries() tombstones it
                    -- 'mal:no-files'. That tombstone is only safe to reclaim if
                    -- eligibility is FALSE while it holds — otherwise the heal flips
                    -- it back on the next tick with nothing changed, which is exactly
                    -- the hot-loop the 'mal:no-chain' note above warns about. With
                    -- this clause the pair is well-behaved: false while fileless, true
                    -- the moment a file lands anywhere beneath, so 'mal:no-files' can
                    -- be listed in recoverWhenAdditionalReasons below.
                    --
                    -- This is the ONLY working revival rail for that reason. The
                    -- obvious-looking one is not: file.attached is emitted with the
                    -- EPISODE's media_item_id (media_file_items_emit_event), and
                    -- invalidateByEvent flips rows matching that media_item_id only,
                    -- with no ancestor fan-out — but this stage's row lives on the
                    -- SERIES, so the event never reaches it.
                    --
                    AND (
                        -- Must be the EXACT complement of the tombstone check in
                        -- enrichSeries, and is kept character-identical to it (see
                        -- mal-file-predicate-pairing.test.ts, which compares the two
                        -- SQL texts). They drifted once: this clause covered only
                        -- season -> episode while the tombstone check was a RECURSIVE
                        -- walk that also counted the series row. A file attached
                        -- directly to a series then satisfied the tombstone check (so
                        -- the row was never tombstoned) but not this one (so it was
                        -- never enriched) — the series fell between them permanently,
                        -- and an already-tombstoned row in that shape could never be
                        -- revived. That complementarity is the entire safety argument
                        -- for listing 'mal:no-files' in recoverWhenAdditionalReasons.
                        --
                        -- Three EXISTS rather than a RECURSIVE CTE because this runs
                        -- per candidate row on the 60s sweep, and the hierarchy is
                        -- fixed at series -> season -> episode, so depth is bounded.
                        EXISTS (SELECT 1 FROM media_file_items mfi WHERE mfi.media_item_id = mi.id)
                        OR EXISTS (
                            SELECT 1 FROM media_items sea
                              JOIN media_file_items mfi ON mfi.media_item_id = sea.id
                             WHERE sea.parent_id = mi.id
                        )
                        OR EXISTS (
                            SELECT 1 FROM media_items sea
                              JOIN media_items ep ON ep.parent_id = sea.id
                              JOIN media_file_items mfi ON mfi.media_item_id = ep.id
                             WHERE sea.parent_id = mi.id
                        )
                    )
                `,
                // Both tombstone reasons are reclaimed by the event-INDEPENDENT heal:
                //  - 'mal:not-anime': anime_genres is written by mdblist-sync, which
                //    emits NO pipeline event, so an event can NEVER recover it — the
                //    heal is the only rail.
                //  - 'mal:no-series-mal-id' (H2 backstop): primarily recovered by the
                //    identity event (a newly-assigned MAL id fires
                //    invalidatedBy:['identity.assigned']), but that outbox event can be
                //    dead-lettered (MAX_ATTEMPTS exhausted) — which would strand a
                //    genuine anime series forever. Listing it here is a near-free
                //    backstop on THIS (bulk `elig.sql`) heal path: reEnrollMisSkippedStage
                //    flips only rows where eligibility.sql holds (EXISTS mal id AND
                //    anime_genres), so a row that still has no MAL id is never flipped,
                //    and the UPDATE's LIMIT counts flipped rows — not the cheap indexed
                //    skipped_reason scan. (The "burns heal budget" caveat applies to the
                //    per-row `appliesTo` path, which this stage does not use.)
                //
                // Deliberately NOT listed here (bug audit, see enrichSeries()):
                //  - 'mal:empty-writes': no longer tombstoned as skipped_permanent at
                //    all — enrichSeries() now writes it as a `skipped_transient` with a
                //    24h backoff (EMPTY_WRITES_RETRY_MS), since a series can have zero
                //    episodes purely because series-sync hasn't populated them yet, with
                //    no invalidation event for "episodes were added". A skipped_transient
                //    row is already retryable via the coverage-table backlog scan, so it
                //    doesn't need (and can't use — this heal list only reclaims
                //    `skipped_permanent`) an entry here.
                //  - 'mal:no-chain': this one STAYS skipped_permanent (the registered
                //    MAL id itself 404s — genuinely bad until corrected), but must NOT be
                //    added here. Unlike 'mal:no-series-mal-id', the eligibility.sql EXISTS
                //    clause is already TRUE at tombstone time (the mal id exists, it just
                //    points nowhere) — so listing it would let the heal flip it back to
                //    `pending` on the very next sweep tick with no underlying change,
                //    hot-looping a confirmed-404 id forever. Recovery instead relies
                //    entirely on the identity.* event path: correcting the id (delete
                //    +reinsert → identity.assigned, in-place update → identity.changed,
                //    or clear+reassign → identity.cleared then identity.assigned) always
                //    fires an event this stage subscribes to, and invalidateByEvent's
                //    resetStatuses already includes 'skipped_permanent' — so the row
                //    flips to pending exactly when the id actually changes, never before.
                //  - 'mal:no-files': safe to list ONLY because eligibility.sql now
                //    requires a file in the subtree (see above), so it is false at
                //    tombstone time and true exactly when episodes arrive. Without
                //    that clause this would hot-loop like 'mal:no-chain'.
                recoverWhenAdditionalReasons: [
                    'mal:not-anime',
                    'mal:no-series-mal-id',
                    'mal:no-files',
                    MAL_ENRICHMENT_DISABLED_REASON,
                ],
                skipAutoDispose: true,
            },
            terminalDisposition: [
                // Switched off by the operator (or a use-case preset). execute()
                // early-returns and the task is global-identity, so without this
                // every seeded series stayed `pending` forever: counted as backlog,
                // found by stage-sweep every tick, never enqueued. FIRST, so it
                // wins over the auth guard below — a guard drain is
                // `skipped_transient`, which is re-drained every 24h and never lets
                // a disabled stage settle. `skipped_permanent` is what a
                // switched-off task honestly is; the reason is in
                // recoverWhenAdditionalReasons, so the heal reclaims each row once
                // the flag is cleared and the row is eligible.
                //
                // Scoped to series that HAVE a MAL id and a non-empty anime_genres,
                // i.e. the ones only the switch keeps out. `skipAutoDispose` turns
                // off the gate re-label pass, so a non-anime series parked here
                // would read "disabled" forever after the switch is turned back on
                // (the heal never reclaims an ineligible row). Those fall through
                // to the rules below and get their real reason instead. A parked
                // series without files stays "disabled" until a file lands, then
                // the heal reclaims it like any 'mal:no-files' row.
                {
                    kind: 'predicate',
                    ruleId: 'mal-anime-enrichment-enabled',
                    disposeAs: 'skipped_permanent',
                    reason: MAL_ENRICHMENT_DISABLED_REASON,
                    excludes: (sql) =>
                        config.DISABLE_MAL_ANIME_ENRICHMENT
                            ? sql`EXISTS (SELECT 1 FROM external_ids ei WHERE ei.media_id = mi.id AND ei.provider = 'mal') AND EXISTS (SELECT 1 FROM provider_metadata pm WHERE pm.media_id = mi.id AND jsonb_typeof(pm.metadata->'anime_genres') = 'array' AND pm.metadata->'anime_genres' <> '[]'::jsonb)`
                            : sql`false`,
                },
                // GLOBAL precondition: no MAL borrower auth linked. The framework
                // drains the whole stage to skipped_transient (24h retry) so rows
                // re-enqueue once an admin links MAL — replaces the inline auth
                // drain that used to live in execute(). Cheap DB-presence check
                // only (no HTTP probe): a non-expired access_token credential row.
                {
                    kind: 'global-guard',
                    ruleId: 'mal-borrower-auth-linked',
                    reason: 'precondition-not-met:mal-user-link-required',
                    retryAfterMs: 24 * 60 * 60 * 1000,
                    guard: async (ctx) => {
                        const creds = await listMalBorrowerCredentials(ctx.sql, 1);
                        return creds.length > 0;
                    },
                },
                // SQL-expressible: a series with no MAL series-level external_id
                // can't seed the sequel-chain walk. Permanent until re-identified.
                {
                    kind: 'predicate',
                    ruleId: 'no-mal-series-id',
                    disposeAs: 'skipped_permanent',
                    reason: 'mal:no-series-mal-id',
                    excludes: (sql) =>
                        sql`NOT EXISTS (SELECT 1 FROM external_ids ei WHERE ei.media_id = mi.id AND ei.provider = 'mal')`,
                },
                // SQL-expressible: only anime series belong here. A series with no
                // non-empty anime_genres marker is out of scope — dispose permanent.
                // requiresUpstreamRun:'mdblist-sync' (H2): anime_genres is written by
                // mdblist-sync (12h cadence, runOnStartup:false), so this skip must NOT
                // fire until mdblist-sync has terminally run for the series — otherwise
                // a genuine anime cataloged before the first sync is wrongly tombstoned.
                // Paired with the `eligibility` heal rail above as the recovery backstop.
                {
                    kind: 'predicate',
                    ruleId: 'not-in-anime-catalog',
                    disposeAs: 'skipped_permanent',
                    reason: 'mal:not-anime',
                    // `<> '[]'::jsonb` (not jsonb_array_length) so a scalar
                    // anime_genres — mdblist writes JSON null for non-anime — can't
                    // throw "cannot get array length of a scalar" and abort the whole
                    // disposition UPDATE. See the matching note on `eligibility` above.
                    excludes: (sql) =>
                        sql`NOT EXISTS (SELECT 1 FROM provider_metadata pm WHERE pm.media_id = mi.id AND jsonb_typeof(pm.metadata->'anime_genres') = 'array' AND pm.metadata->'anime_genres' <> '[]'::jsonb)`,
                    requiresUpstreamRun: 'mdblist-sync',
                },
                // Remaining eligible candidates: the task guarantees a terminal
                // write per series (completed on success; skipped_permanent on the
                // durable no-chain / empty-writes paths). Invariant 2 observes it.
                {
                    kind: 'self-terminal',
                    ruleId: 'mal-writes-every-eligible-candidate',
                },
            ],
        },
    ],

    timeout: { hard: '60m', soft: '55m' },

    backlog: {
        unitLabel: 'series',
        sliceSize: 1,
        softBudget: '1s',
        idOf: (row): string => {
            const r = row as { id?: unknown } | null | undefined;
            return r && typeof r.id === 'string' ? r.id : String(r);
        },
        async stages(ctx: TaskContext): Promise<BacklogStage[]> {
            const { countEnrichmentBacklog } =
                await import('../../../database/queries/media-external-groupings.queries.js');
            const counts = await countEnrichmentBacklog(ctx.sql, PROVIDER, SOURCE);
            const stages: BacklogStage[] = [];
            // The coverage-table queue (media_item_stage_state pending rows for
            // this task's covered stage) is a SEPARATE population from the
            // enrichment-row counts below: it's what the catalog card's live
            // "N in backlog" number and lane-data's backlogRemaining count.
            // Without this row the drill-down reads "no backlog" while the
            // card shows hundreds queued — the exact contradiction an operator
            // can't resolve.
            const { countSweepBacklog } =
                await import('../../../database/queries/stage-sweep.queries.js');
            const queued = await countSweepBacklog(ctx.sql, 'mal-anime-id-enrichment');
            if (queued > 0) {
                stages.push({
                    id: 'queued',
                    label: 'Queued for enrichment check',
                    count: queued,
                });
            }
            if (counts.remaining > 0) {
                stages.push({
                    id: 'remaining',
                    label: 'Remaining',
                    count: counts.remaining,
                });
            }
            if (counts.ineligible > 0) {
                stages.push({
                    id: 'ineligible',
                    label: 'Ineligible',
                    count: counts.ineligible,
                });
            }
            return stages;
        },
        async wipe(ctx: TaskContext): Promise<void> {
            const { wipeEnrichmentRows } =
                await import('../../../database/queries/media-external-groupings.queries.js');
            await wipeEnrichmentRows(ctx.sql, PROVIDER, SOURCE);
        },
        async compute(): Promise<{ items: unknown[]; remainingHint?: number }> {
            return { items: [], remainingHint: 0 };
        },
    },

    async execute(ctx) {
        const { logger, signal } = ctx;
        if (!ctx.http) throw new Error('mal-anime-id-enrichment: http capability required');
        const http = ctx.http;

        if (config.DISABLE_MAL_ANIME_ENRICHMENT) {
            return {
                success: true,
                itemsProcessed: 0,
                result: {
                    enriched: 0,
                    skipped: 0,
                    partialAiring: 0,
                    errors: 0,
                    message: 'mal-anime-id-enrichment disabled via DISABLE_MAL_ANIME_ENRICHMENT',
                },
            };
        }

        const rawInput = (ctx.input as Record<string, unknown> | undefined) ?? {};
        const mode = typeof rawInput.mode === 'string' ? rawInput.mode : 'catchup';

        const {
            resolveDrainMode,
            drainBacklog,
            lazyBacklog,
            computeRemainingHint,
            formatStopReason,
            isAbortedStop,
        } = await import('../../../plugins/runtime/drain-backlog.js');

        const {
            getEnrichmentCandidates,
            countEnrichmentBacklog,
            wipeEnrichmentRows,
            findCoverageTableBacklog,
        } = await import('../../../database/queries/media-external-groupings.queries.js');

        type EnrichmentCandidate = Awaited<ReturnType<typeof getEnrichmentCandidates>>[number];

        const drainMode = resolveDrainMode(
            mode,
            logger as unknown as Parameters<typeof resolveDrainMode>[1],
        );
        const isForce = drainMode === 'force';
        const useCoverageTable = getAuthoritativeStageIds().has('mal-anime-id-enrichment');

        let enriched = 0;
        let skipped = 0;
        let partialAiring = 0;
        let errors = 0;
        let processed = 0;
        let afterId: string | undefined;
        let lastErrorMessage: string | undefined;
        // Series already handled this run. The coverage-table backlog has no
        // cursor: a row whose disposition did not move (a thrown per-item error,
        // a failed stage write) comes straight back in the next slice, and each
        // revisit costs a full MAL sequel-chain walk. Never walk a series twice
        // in one run; when a slice holds nothing new the drain ends.
        const visited = new Set<string>();

        const auth = await getBorrowerAuth(ctx.sql, logger, http);
        if (!auth) {
            // The stage's `global-guard` terminalDisposition
            // (`mal-borrower-auth-linked`) owns draining pending rows to
            // skipped_transient when no borrower token is linked — running at
            // stage-sweep time, before candidates are scanned. We must NOT
            // re-drain here or two writers would race the same rows. Just
            // no-op the run; stage-sweep handles the backlog.
            logger.warn(
                'No working MAL borrower token available — skipping run. ' +
                    'Ask any admin to link their MAL account via the ' +
                    'mal-watch-sync plugin. Pending stage rows are drained by ' +
                    'the stage global-guard.',
            );
            return {
                success: true,
                itemsProcessed: 0,
                result: {
                    enriched: 0,
                    skipped: 0,
                    partialAiring: 0,
                    errors: 0,
                    message:
                        'No MAL-linked user available; run skipped. Stage rows are ' +
                        'drained to skipped_transient by the stage global-guard and ' +
                        'will retry once a borrower token is available.',
                },
            };
        }

        const snapshot = lazyBacklog(() =>
            countEnrichmentBacklog(ctx.sql, PROVIDER, SOURCE).then((s) => s.remaining),
        );

        const drainCtx = {
            logger: logger as unknown as Parameters<typeof drainBacklog>[0]['logger'],
            abortSignal: signal,
        };

        // Record the drain's per-series MAL request volume (via enrichSeries) on
        // the cost page. The one-time borrower-auth probe above runs before this
        // scope, so its few cached-token calls are a minor, accepted undercount —
        // wrapping the early-return path isn't worth the restructure.
        const result = await withApiCallSpend(ctx, () =>
            drainBacklog<EnrichmentCandidate>(drainCtx, {
                mode: drainMode,
                // The drain's own default budget is 110 min, but this task is
                // killed by the run watchdog at timeout.hard (60m) — a manual
                // drain would be marked FAILED mid-slice instead of stopping
                // cleanly. Finish under that cap so the run ends as
                // stopReason 'budget' and the remainder rolls to the next catchup.
                softBudgetMs: 50 * 60 * 1000,
                sliceSize: SLICE_SIZE,
                onWipe: isForce ? () => wipeEnrichmentRows(ctx.sql, PROVIDER, SOURCE) : undefined,
                idOf: (row) => row.seriesId,
                fetchSlice: async (limit) => {
                    const items =
                        useCoverageTable && !isForce
                            ? await findCoverageTableBacklog(
                                  ctx.sql,
                                  'mal-anime-id-enrichment',
                                  PROVIDER,
                                  limit,
                              )
                            : await getEnrichmentCandidates(
                                  ctx.sql,
                                  PROVIDER,
                                  SOURCE,
                                  limit,
                                  afterId,
                              );
                    const fresh = items.filter((row) => !visited.has(row.seriesId));
                    for (const row of fresh) visited.add(row.seriesId);
                    const initial = await snapshot();
                    return {
                        items: fresh,
                        remainingHint: computeRemainingHint(initial, processed, fresh.length),
                    };
                },
                processSlice: async (slice, sliceSignal) => {
                    let producedThisSlice = 0;

                    for (const candidate of slice) {
                        if (sliceSignal.aborted) break;

                        try {
                            const r = await enrichSeries(
                                ctx.sql,
                                candidate,
                                auth,
                                logger,
                                sliceSignal,
                                http,
                                useCoverageTable,
                            );
                            switch (r.status) {
                                case 'complete':
                                    enriched++;
                                    producedThisSlice++;
                                    break;
                                case 'partial-airing':
                                    partialAiring++;
                                    enriched++;
                                    producedThisSlice++;
                                    break;
                                case 'skip-fresh':
                                    skipped++;
                                    break;
                                case 'skip-empty-writes':
                                    skipped++;
                                    break;
                                case 'no-chain':
                                    skipped++;
                                    break;
                            }
                        } catch (err) {
                            errors++;
                            lastErrorMessage = err instanceof Error ? err.message : String(err);
                            logger.warn('Failed to enrich series', {
                                seriesId: candidate.seriesId,
                                seriesMalId: candidate.seriesMalId,
                                error: lastErrorMessage,
                            });
                            if (useCoverageTable) {
                                await deferTransientRetryBatch(ctx.sql, {
                                    stageId: 'mal-anime-id-enrichment',
                                    mediaItemIds: [candidate.seriesId],
                                    retryAfterMs: ERROR_RETRY_MS,
                                }).catch((deferErr: unknown) => {
                                    logger.warn('Failed to defer errored stage row', {
                                        seriesId: candidate.seriesId,
                                        error:
                                            deferErr instanceof Error
                                                ? deferErr.message
                                                : String(deferErr),
                                    });
                                });
                            }
                        }
                    }

                    processed += slice.length;
                    afterId = slice[slice.length - 1]?.seriesId;
                    return { produced: producedThisSlice, advanced: slice.length };
                },
                onProgress: (p, t, meta) => {
                    ctx.reportProgress(p, t, meta?.currentItem);
                },
                phase: 'Enriching anime episodes with MAL groupings',
                heartbeat: {
                    getTotal: () => snapshot.peek(),
                    getProcessed: () => processed,
                    getStatus: () =>
                        `Enriching anime series... (${enriched} enriched, ${skipped} skipped, ${errors} errors)`,
                },
            }),
        );

        const noneProcessed = enriched + skipped + errors === 0;
        const suffix = formatStopReason(result.stopReason);
        const message = noneProcessed
            ? result.stopReason === 'drained' || result.stopReason === 'single-slice'
                ? 'No anime series need MAL grouping enrichment'
                : `No items processed${suffix}`
            : `Enriched ${enriched} series with MAL groupings ` +
              `(${skipped} skipped, ${partialAiring} partial-airing, ${errors} errors)${suffix}`;

        logger.info(message);

        // Monitoring-blindness guard: a total MAL API outage makes every
        // enrichSeries() attempt throw (non-404 5xx/network → errors++) while
        // enriched stays 0. That's an outage, not "nothing to do". A returned
        // success:false would be invisible — the runner records a returned result
        // as a COMPLETED run and reports SUCCESS to the circuit breaker. Throw a
        // transient TaskError instead so the run is marked failed, retried, and the
        // breaker can trip. Genuine no-work (enriched === 0, errors === 0 — series
        // skipped as fresh/no-chain/empty, or empty backlog) and partial success
        // (enriched > 0) stay success. Aborts are handled by the return below.
        //
        // BUG 7 fix: `skipped === 0` is required too. `skip-fresh` (the dominant
        // steady-state outcome once a catalog is caught up) only fires AFTER
        // enrichSeries successfully rebuilds the chain via a real MAL round-trip —
        // so skipped > 0 already proves MAL answered at least once this run. A
        // production run with 229 skip-fresh + 3 one-off per-item timeouts (out of
        // ~460 calls) was misclassified as "every MAL API attempt failed" and
        // tripped the circuit breaker, even though >98% of calls that run
        // succeeded. A genuine full outage makes the chain-walk's first call fail
        // for every candidate, so skipped stays 0 there — this tightening doesn't
        // weaken real-outage detection.
        if (!isAbortedStop(result.stopReason) && enriched === 0 && skipped === 0 && errors > 0) {
            // Distinguish the three operator-relevant causes hiding behind the
            // same generic "upstream outage" wording: MAL's rate limit (429,
            // self-healing — the per-request retry/backoff already exhausted
            // its budget), an expired/invalid user OAuth token (401 — needs the
            // user to re-link MAL), and a genuine MAL-side outage (5xx/network).
            // BUG 8 fix: match `status=` specifically — a bare \b429\b/\b401\b
            // would also match a MAL anime id of literally "429"/"401" embedded
            // in the message's request path, misreporting an unrelated error
            // (e.g. a genuine 403/500) as rate-limiting or an auth failure.
            const isRateLimited = lastErrorMessage != null && /status=429\b/.test(lastErrorMessage);
            const isAuthFailure = lastErrorMessage != null && /status=401\b/.test(lastErrorMessage);
            throw new TaskError({
                message: isRateLimited
                    ? `mal-anime-id-enrichment: rate limit reached (MyAnimeList API) — ` +
                      `resumes automatically once the quota window resets (${errors} item(s) deferred).`
                    : isAuthFailure
                      ? `mal-anime-id-enrichment: MyAnimeList authorization failed — the linked ` +
                        `account's token appears expired or invalid; re-link MAL to resume ` +
                        `(${errors} item(s) deferred).`
                      : `mal-anime-id-enrichment: upstream outage — 0 enriched with ` +
                        `${errors} error(s); every MAL API attempt failed.`,
                kind: 'transient',
            });
        }

        return {
            success:
                !isAbortedStop(result.stopReason) && (errors === 0 || enriched > 0 || skipped > 0),
            itemsProcessed: enriched,
            stopReason: isAbortedStop(result.stopReason) ? 'aborted' : undefined,
            result: {
                enriched,
                skipped,
                partialAiring,
                errors,
                message,
            },
        };
    },
});

registry.registerTask(malAnimeIdEnrichmentTask);
