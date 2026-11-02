// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MyAnimeList Watch Sync Plugin
 *
 * Syncs anime watch state between Lumastra and MyAnimeList.
 * Drop this directory into $PLUGINS_EXTERNAL_DIR (default: /app/plugins) to load.
 *
 * OAuth: deployment registers one MAL app (MAL_CLIENT_ID + MAL_CLIENT_SECRET);
 * each user authorizes their own MAL account against it. Per-user access/refresh
 * tokens live in plugin_user_credentials.
 */

// =============================================================================
// Configuration
// =============================================================================

const MAL_API_BASE = 'https://api.myanimelist.net/v2';
const MAL_TOKEN_URL = 'https://myanimelist.net/v1/oauth2/token';
// MAL's documented limit is ~3 req/s but their edge starts returning 504s well
// below that under sustained load (especially the search endpoint). Serialise
// every MAL call through a global gap so batches can't burst past this.
const MAL_MIN_GAP_MS = 750;
const PULL_PAGE_SIZE = 100;
// searchMalAnime's push-acceptance bar (bestScore >= 2.5) is deliberately
// loose — a mediocre match pushed once and re-evaluated next cycle is a
// self-correcting mistake. Persisting a match into external_ids as a durable
// identity mapping is not: a wrong id becomes the trusted, cached answer for
// every future episode of that series AND makes mal-anime-id-enrichment treat
// the series as already correctly resolved. Require a much stronger signal
// (title similarity alone already tops out at 5) before writing it back.
const MAL_ID_PERSIST_MIN_SCORE = 5;

// =============================================================================
// Redirect-guarded outbound transport (C22 fix-plan finding)
// =============================================================================
//
// This plugin declares `capabilities: { http: true }` and routes every GET
// through `ctx.http.get` — the SDK's own SSRF-guarded client
// (`tasks/context-primitives.ts`'s `buildHttpClient`, backed by
// `tasks/url-safety.ts`'s `safeFetch`). `HttpClient` exposes only
// `get(url, opts)` / `post(url, body, opts)`, and `updateMalAnimeStatusForUser`
// needs PATCH (MAL's `/anime/{id}/my_list_status` list-status write) — the
// ONE call shape `ctx.http` genuinely cannot express, so it alone keeps a
// LOCAL, minimal redirect guard below (`guardedFetch`). C22 fix round 1
// review: the trakt-watch-sync sibling plugin had an identical local guard
// for EVERY call, not just its one non-GET/POST method — checked against its
// actual method usage (grep confirms every method in that file is GET or
// POST), that theory did not hold, so it deleted its copy in favour of
// `ctx.http` entirely. MAL's PATCH is the genuine, narrow exception.
//
// The review also caught this guard diverging from the shared
// `fetch-utils.ts` implementation on day one (no header-stripping on a
// 301/302/303 method downgrade, no 307/308 unresendable-stream refusal, no
// timeout, a plain `Error` instead of a distinguishable type) — fixed below,
// restoring parity on all four axes plus the same-host scheme-upgrade/
// downgrade policy (fix-plan ledger, Task 11). This file cannot IMPORT
// `fetch-utils.ts` (a plugin loads via a standalone `import()` from
// `$PLUGINS_*_DIR`, isolated from `$lib/server/...`), so it stays a
// hand-copied twin — `guarded-fetch-divergence.test.js` runs the SAME
// scenario table against both implementations and fails if they disagree.
const MAL_GUARDED_FETCH_TIMEOUT_MS = 30_000;
const MAL_GUARDED_FETCH_MAX_REDIRECTS = 5;

/** Mirrors fetch-utils.ts's FetchRedirectError shape (name + reason) without importing it. */
class MalRedirectError extends Error {
    constructor(host, reason = 'cross-origin') {
        super(
            reason === 'cross-origin'
                ? `refusing to follow cross-host or scheme-downgrade redirect to ${host}`
                : reason === 'unresendable-body'
                  ? `refusing to follow redirect to ${host}: request body cannot be resent (streamed body)`
                  : `redirect limit (${MAL_GUARDED_FETCH_MAX_REDIRECTS}) exceeded while following redirects from ${host}`,
        );
        this.name = 'MalRedirectError';
        this.reason = reason;
    }
}

class MalFetchTimeoutError extends Error {
    constructor(url, timeoutMs) {
        super(`Request to ${url} timed out after ${timeoutMs}ms`);
        this.name = 'MalFetchTimeoutError';
    }
}

/** Strip body-describing headers that no longer apply once the body is dropped. */
function malStripBodyHeaders(headers) {
    const h = new Headers(headers);
    h.delete('content-type');
    h.delete('content-length');
    return h;
}

/**
 * Same-host redirect policy (fix-plan ledger, Task 11 standing policy):
 * scheme/port may change in the safe direction only (http -> https), never
 * downgraded (https -> http); cross-host is always refused. Mirrors
 * fetch-utils.ts's `isAllowedRedirectTarget`.
 */
function malIsAllowedRedirectTarget(next, original) {
    if (next.hostname !== original.hostname) return false;
    if (next.protocol === original.protocol) return true;
    return original.protocol === 'http:' && next.protocol === 'https:';
}

/**
 * `fetch()` drop-in used ONLY for `updateMalAnimeStatusForUser`'s PATCH call
 * — every other request in this file goes through `ctx.http.get`. Mirrors
 * `fetch-utils.ts`'s `fetchWithTimeout`/`followRedirectsWithGuard`: a
 * hop-limited, same-host-only (scheme may upgrade, never downgrade) redirect
 * loop with RFC 7231 §6.4 method/body downgrade handling and a timeout.
 * @param {string} url
 * @param {RequestInit} [options]
 * @returns {Promise<Response>}
 */
async function guardedFetch(url, options = {}) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), MAL_GUARDED_FETCH_TIMEOUT_MS);
    const callerSignal = options.signal;
    const signal = callerSignal
        ? AbortSignal.any([controller.signal, callerSignal])
        : controller.signal;

    try {
        let currentUrl = url;
        const originalUrl = new URL(url);
        let method = options.method ?? 'GET';
        let body = options.body;
        let headers = options.headers;

        for (let hop = 0; hop <= MAL_GUARDED_FETCH_MAX_REDIRECTS; hop++) {
            const response = await fetch(currentUrl, {
                ...options,
                method,
                body,
                headers,
                signal,
                redirect: 'manual',
            });

            if (response.status < 300 || response.status >= 400) return response;
            const location = response.headers.get('location');
            if (!location) return response;

            await response.body?.cancel().catch(() => {});

            if (hop === MAL_GUARDED_FETCH_MAX_REDIRECTS) {
                throw new MalRedirectError(new URL(currentUrl).host, 'redirect-limit-exceeded');
            }

            const nextUrl = new URL(location, currentUrl);
            if (!malIsAllowedRedirectTarget(nextUrl, originalUrl)) {
                throw new MalRedirectError(nextUrl.host);
            }

            if (response.status === 303) {
                method = 'GET';
                body = undefined;
                headers = malStripBodyHeaders(headers);
            } else if (response.status === 301 || response.status === 302) {
                if (method !== 'GET' && method !== 'HEAD') {
                    method = 'GET';
                    body = undefined;
                    headers = malStripBodyHeaders(headers);
                }
            } else if (response.status === 307 || response.status === 308) {
                if (body instanceof ReadableStream) {
                    throw new MalRedirectError(nextUrl.host, 'unresendable-body');
                }
            }
            currentUrl = nextUrl.toString();
        }
        throw new Error('guardedFetch: exhausted redirect chain');
    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            if (callerSignal?.aborted) throw error;
            throw new MalFetchTimeoutError(url, MAL_GUARDED_FETCH_TIMEOUT_MS);
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
}

/** @type {import('postgres').Sql | null} */
let sql = null;

/** @type {any} */
let log = null;

/** @type {import('@sapd/lumastra-plugin-sdk').UserCredentialStore | null} */
let userCredentials = null;

/** @type {import('@sapd/lumastra-plugin-sdk').HttpClient | null} */
let http = null;

/** @type {import('@sapd/lumastra-plugin-sdk').CatalogStore | null} */
let catalog = null;

/**
 * Read the deployment-wide MAL OAuth app credentials from the env.
 * @returns {{clientId: string, clientSecret: string} | null}
 */
function getAppCredentials() {
    const clientId = process.env.MAL_CLIENT_ID || '';
    const clientSecret = process.env.MAL_CLIENT_SECRET || '';
    if (!clientId || !clientSecret) return null;
    return { clientId, clientSecret };
}

// =============================================================================
// Per-User Credential Helpers
// =============================================================================

/**
 * Get stored credentials for a Lumastra user via the SDK's per-user store.
 *
 * Reads three separate keys (access_token, refresh_token, provider_username)
 * because the new credential store is key/value-scalar — no joined row.
 * `ctx.userCredentials.get()` returns expired values too, which is what we
 * want here (the caller refreshes on 401).
 *
 * @param {string} userId - Lumastra username
 * @returns {Promise<{accessToken: string, refreshToken: string|null, providerUsername: string|null} | null>}
 */
async function getUserCredentials(userId) {
    if (!userCredentials) return null;
    const accessToken = await userCredentials.get(userId, 'access_token');
    if (!accessToken) return null;
    const [refreshToken, providerUsername] = await Promise.all([
        userCredentials.get(userId, 'refresh_token'),
        userCredentials.get(userId, 'provider_username'),
    ]);
    return { accessToken, refreshToken, providerUsername };
}

/**
 * Get all users who have linked their MAL account.
 * @returns {Promise<Array<{userId: string, accessToken: string, refreshToken: string|null, providerUsername: string|null}>>}
 */
async function getAllLinkedUsers() {
    if (!userCredentials) return [];
    // listUsersWithKey('access_token') is the correct membership test —
    // a user is "linked" iff they have an access_token row. listLinkedUsers()
    // would include partially-deleted rows where only refresh_token remains.
    const linkedUserIds = await userCredentials.listUsersWithKey('access_token');
    const users = await Promise.all(
        linkedUserIds.map(async (userId) => {
            const creds = await getUserCredentials(userId);
            return creds ? { userId, ...creds } : null;
        }),
    );
    return /** @type {Array<{userId: string, accessToken: string, refreshToken: string|null, providerUsername: string|null}>} */ (
        users.filter((u) => u !== null)
    );
}

/**
 * Update stored tokens after a refresh. Writes through the SDK's encrypted
 * per-user store, scoped automatically to PLUGIN_ID.
 *
 * @param {string} userId
 * @param {string} accessToken
 * @param {string} [refreshToken]
 * @param {Date} [expiresAt]
 */
async function updateStoredTokens(userId, accessToken, refreshToken, expiresAt) {
    if (!userCredentials) return;
    await userCredentials.set(
        userId,
        'access_token',
        accessToken,
        expiresAt ? { expiresAt } : undefined,
    );
    if (refreshToken !== undefined) {
        await userCredentials.set(userId, 'refresh_token', refreshToken);
    }
    if ((await userCredentials.get(userId, 'auth_failed')) === 'true') {
        await userCredentials.delete(userId, 'auth_failed');
    }
}

// =============================================================================
// MAL API Helpers (per-user)
// =============================================================================

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Global MAL request throttle. Every fetch to MAL_API_BASE or MAL_TOKEN_URL
// awaits this to enforce a single global minimum gap between requests across
// all concurrent operations (push, pull, resolveIds, sequel-walk, refresh).
// Promise-chained so callers queue in arrival order rather than racing on
// the lastAt timestamp.
let throttleChain = Promise.resolve();
let throttleLastAt = 0;

function malThrottle() {
    const next = throttleChain.then(async () => {
        const now = Date.now();
        const wait = throttleLastAt + MAL_MIN_GAP_MS - now;
        if (wait > 0) {
            await delay(wait);
        }
        throttleLastAt = Date.now();
    });
    // Don't let one rejection break the chain — wrap so subsequent waiters
    // still get scheduled.
    throttleChain = next.catch(() => {});
    return next;
}

/**
 * Refresh OAuth2 access token for a specific user.
 * @param {string} userId - Lumastra username
 * @param {string} currentRefreshToken
 * @returns {Promise<{accessToken: string, refreshToken: string} | null>}
 */
async function refreshUserToken(userId, currentRefreshToken) {
    if (!currentRefreshToken?.trim()) return null;
    const app = getAppCredentials();
    if (!app) {
        if (log)
            log.error('Cannot refresh MAL token: MAL_CLIENT_ID/SECRET not configured', { userId });
        return null;
    }

    try {
        const body = new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: currentRefreshToken,
            client_id: app.clientId,
            client_secret: app.clientSecret,
        });

        await malThrottle();
        // A plain POST with a string body — ctx.http.post expresses this
        // fully (http.post passes a string body through unchanged and lets
        // opts.headers override its default Content-Type).
        const resp = await http.post(MAL_TOKEN_URL, body.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });

        if (!resp.ok) {
            if (log)
                log.error('MAL token refresh failed', {
                    userId,
                    status: resp.status,
                });
            // OAuth invalid_grant (or an explicit refresh-token equivalent) is
            // the only evidence that relinking can fix this user's connection.
            // An outage, invalid_client or unreadable response stays retryable.
            const failure = await resp.json().catch(() => null);
            if (
                (resp.status === 400 || resp.status === 401) &&
                ['invalid_grant', 'invalid_refresh_token', 'refresh_token_revoked'].includes(
                    failure?.error,
                )
            ) {
                await userCredentials.set(userId, 'auth_failed', 'true', {
                    ifKeyExists: 'access_token',
                });
            }
            return null;
        }

        const data = await resp.json();
        if (!data.access_token) {
            if (log) log.error('MAL refresh returned no access_token', { userId });
            return null;
        }
        const newAccessToken = data.access_token;
        const newRefreshToken = data.refresh_token || currentRefreshToken;
        const expiresAt = data.expires_in
            ? new Date(Date.now() + data.expires_in * 1000)
            : undefined;

        // Persist refreshed tokens
        // Note: concurrent pushWatchState calls for the same user may race here,
        // causing one call to write stale tokens. Optimistic locking is overkill
        // for the current single-replica usage pattern.
        await updateStoredTokens(userId, newAccessToken, newRefreshToken, expiresAt);

        if (log) log.info('MAL token refreshed', { userId });
        return { accessToken: newAccessToken, refreshToken: newRefreshToken };
    } catch (err) {
        if (log)
            log.error('MAL token refresh error', {
                userId,
                error: err instanceof Error ? err.message : 'unknown error',
            });
        return null;
    }
}

/**
 * Make an authenticated MAL API request for a specific user.
 * Retries once on 401 after refreshing the token.
 * @param {string} path
 * @param {string} userId - Lumastra username (for token lookup/refresh)
 * @param {string} accessToken
 * @param {string|null} refreshToken
 * @param {RequestInit} [options]
 * @returns {Promise<Response>}
 */
async function malApiForUser(path, userId, accessToken, refreshToken, options = {}) {
    if (path.startsWith('http') && !path.startsWith(MAL_API_BASE)) {
        throw new Error('Invalid MAL API URL');
    }
    const url = path.startsWith('http') ? path : `${MAL_API_BASE}${path}`;

    const headers = {
        Authorization: `Bearer ${accessToken}`,
        ...options.headers,
    };

    // Every call in this file is GET or PATCH. GET routes through ctx.http
    // (the SDK's guarded client); PATCH is the one shape `ctx.http.get`/
    // `.post` cannot express, so it alone uses the local `guardedFetch` —
    // see the file-header comment above `guardedFetch` for why.
    const isPatch = options.method === 'PATCH';
    const doFetch = () =>
        isPatch
            ? guardedFetch(url, { ...options, headers })
            : http.get(url, { headers, signal: options.signal });

    // Retry on 5xx (MAL's edge returns 504 under load even on healthy
    // requests). Two retries with exponential backoff before bubbling up
    // — the throttle below ensures we don't burst into the next try.
    const MAX_5XX_RETRIES = 2;
    let resp;
    for (let attempt = 0; attempt <= MAX_5XX_RETRIES; attempt++) {
        await malThrottle();
        resp = await doFetch();
        if (resp.status >= 500 && resp.status < 600 && attempt < MAX_5XX_RETRIES) {
            const backoffMs = 2000 * Math.pow(2, attempt);
            if (log)
                log.info('MAL API transient 5xx, retrying', {
                    path,
                    status: resp.status,
                    attempt: attempt + 1,
                    backoffMs,
                });
            await delay(backoffMs);
            continue;
        }
        break;
    }

    if (resp.status === 401 && refreshToken) {
        const refreshed = await refreshUserToken(userId, refreshToken);
        if (refreshed) {
            headers.Authorization = `Bearer ${refreshed.accessToken}`;
            await malThrottle();
            resp = await doFetch();
            if (resp.status === 401) {
                if (log)
                    log.warn('MAL API still 401 after token refresh, credential may be invalid', {
                        userId,
                        path,
                    });
            }
        }
    }

    return resp;
}

/**
 * MAL API GET + JSON parse for a user.
 */
async function malGetForUser(path, userId, accessToken, refreshToken) {
    const resp = await malApiForUser(path, userId, accessToken, refreshToken);
    if (!resp.ok) {
        throw new Error(`MAL API ${path}: ${resp.status} ${resp.statusText}`);
    }
    return resp.json();
}

/**
 * Update anime list status on MAL for a user.
 */
async function updateMalAnimeStatusForUser(animeId, params, userId, accessToken, refreshToken) {
    if (!/^\d+$/.test(String(animeId))) throw new Error('Invalid animeId');
    const body = new URLSearchParams();
    if (params.status) body.set('status', params.status);
    if (params.num_watched_episodes != null) {
        body.set('num_watched_episodes', String(params.num_watched_episodes));
    }

    const resp = await malApiForUser(
        `/anime/${animeId}/my_list_status`,
        userId,
        accessToken,
        refreshToken,
        {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
        },
    );

    return resp.ok;
}

// =============================================================================
// ID Resolution: Title search on MAL
// =============================================================================

function normalizeTitle(str) {
    return str
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function titleSimilarity(a, b) {
    const na = normalizeTitle(a);
    const nb = normalizeTitle(b);
    if (na === nb) return 1.0;

    const wordsA = new Set(na.split(' '));
    const wordsB = new Set(nb.split(' '));
    const intersection = [...wordsA].filter((w) => wordsB.has(w));
    const union = new Set([...wordsA, ...wordsB]);
    if (union.size === 0) return 0;
    return intersection.length / union.size;
}

/**
 * Search MAL for an anime by title. Uses the first linked user's token.
 *
 * IMPORTANT: returning null means "MAL has no match for this title". A
 * transient error (5xx after retries, network blip) MUST throw so the
 * engine retries next cycle instead of falsely draining the queue item
 * as terminally unresolvable.
 *
 * @param {string} title
 * @param {number} [year]
 * @param {string} [mediaType]
 * @param {{accessToken: string, refreshToken: string|null, userId: string}} auth
 * @returns {Promise<{id: string, score: number} | null>}
 */
async function searchMalAnime(title, year, mediaType, auth) {
    if (!title?.trim()) return null;

    const query = encodeURIComponent(title.slice(0, 64));
    const fields = 'alternative_titles,start_date,media_type,num_episodes';
    const limit = 25;

    const data = await malGetForUser(
        `/anime?q=${query}&limit=${limit}&fields=${fields}`,
        auth.userId,
        auth.accessToken,
        auth.refreshToken,
    );
    {
        const results = data?.data || [];
        if (results.length === 0) return null;

        let bestScore = -1;
        let bestId = null;

        for (const entry of results) {
            const node = entry.node;
            if (!node) continue;

            let score = 0;

            const titles = [
                node.title,
                ...(node.alternative_titles?.synonyms || []),
                node.alternative_titles?.en || '',
                node.alternative_titles?.ja || '',
            ].filter(Boolean);

            if (titles.length === 0) continue;

            const maxTitleScore = Math.max(...titles.map((t) => titleSimilarity(title, t)));
            score += maxTitleScore * 5;

            if (year && node.start_date) {
                const malYear = parseInt(node.start_date.slice(0, 4), 10);
                if (malYear === year) score += 3;
                else if (Math.abs(malYear - year) === 1) score += 1;
            }

            if (mediaType) {
                const malType = node.media_type;
                if (mediaType === 'movie' && malType === 'movie') score += 2;
                if ((mediaType === 'tv' || mediaType === 'episode') && malType === 'tv') score += 2;
            }

            if (score > bestScore) {
                bestScore = score;
                bestId = String(node.id);
            }
        }

        if (bestScore < 2.5) {
            if (log) {
                log.debug('MAL search: no confident match', {
                    title,
                    bestScore,
                    topResult: results[0]?.node?.title,
                });
            }
            return null;
        }

        return bestId === null ? null : { id: bestId, score: bestScore };
    }
}

// =============================================================================
// Sequel Chain Traversal (multi-season anime)
// =============================================================================

/**
 * Fetch anime details from MAL including related anime and episode count.
 *
 * Returns null only on 404 (anime no longer exists on MAL — terminal).
 * Transient errors (5xx after retries, network) throw so the caller can
 * distinguish "no such anime" from "MAL was flaky for a moment".
 *
 * @param {number|string} animeId
 * @param {{accessToken: string, refreshToken: string|null, userId: string}} auth
 * @returns {Promise<{id: number, num_episodes: number, related_anime: Array<{node: {id: number}, relation_type: string}>} | null>}
 */
async function getAnimeInfo(animeId, auth) {
    try {
        const data = await malGetForUser(
            `/anime/${animeId}?fields=related_anime,num_episodes,media_type`,
            auth.userId,
            auth.accessToken,
            auth.refreshToken,
        );
        return data || null;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/\b404\b/.test(msg)) {
            if (log) log.warn('MAL anime not found (404)', { animeId });
            return null;
        }
        throw err;
    }
}

/**
 * Find the sequel of a MAL anime entry.
 * @param {object} animeInfo - MAL anime details with related_anime field
 * @returns {number|null} - MAL anime ID of the sequel, or null
 */
function getAnimeSequel(animeInfo) {
    if (!animeInfo?.related_anime) return null;
    const sequel = animeInfo.related_anime.find((r) => r.relation_type === 'sequel');
    return sequel?.node?.id ?? null;
}

/**
 * Walk the sequel chain from a base MAL anime ID to find the correct season entry.
 * For season 3, walks the sequel chain 2 times (season - 1).
 *
 * `reachedSeason` reports how far we actually walked. Caller MUST check
 * `reachedSeason === seasonNumber` before using `malId` — if MAL's sequel
 * chain is shorter than the user's library structure (or hits MAX depth),
 * we'd otherwise silently push S5 progress to S3's MAL entry.
 *
 * @param {string} baseMalId - MAL ID of season 1
 * @param {number} seasonNumber - Target season number (1-based)
 * @param {{accessToken: string, refreshToken: string|null, userId: string}} auth
 * @returns {Promise<{malId: string, numEpisodes: number, reachedSeason: number}>}
 */
async function walkSequelChain(baseMalId, seasonNumber, auth) {
    const MAX_SEQUEL_DEPTH = 50;
    let currentId = baseMalId;
    let reachedSeason = 1; // baseMalId == season 1

    for (let s = 1; s < seasonNumber; s++) {
        if (s > MAX_SEQUEL_DEPTH) {
            if (log)
                log.warn('Sequel chain exceeded max depth', {
                    baseMalId,
                    seasonNumber,
                    depth: s,
                });
            break;
        }
        const info = await getAnimeInfo(currentId, auth);
        if (!info) break;

        const sequelId = getAnimeSequel(info);
        if (!sequelId) {
            if (log)
                log.debug('Sequel chain ended early', {
                    currentId,
                    targetSeason: seasonNumber,
                    reachedSeason: s,
                });
            break;
        }
        currentId = String(sequelId);
        reachedSeason = s + 1;
    }

    // Always fetch num_episodes of the final entry we landed on
    const finalInfo = await getAnimeInfo(currentId, auth);
    if (!finalInfo) {
        if (log) log.warn('Sequel chain ended with no info', { malId: currentId });
        return { malId: currentId, numEpisodes: 0, reachedSeason };
    }
    const numEpisodes = finalInfo.num_episodes || 0;

    return { malId: currentId, numEpisodes, reachedSeason };
}

/**
 * Fetch anime details with list status in a single API call (for idempotency + status checks).
 *
 * Returns `{listStatus: null, numEpisodes: 0}` only on 404 (anime no longer
 * exists on MAL — terminal). Transient errors throw so the caller doesn't
 * push with stale defaults — sending status='watching' when the anime was
 * actually completed is observable corruption.
 *
 * @param {string} animeId - MAL anime ID
 * @param {{accessToken: string, refreshToken: string|null, userId: string}} auth
 * @returns {Promise<{listStatus: {status: string, num_episodes_watched: number} | null, numEpisodes: number}>}
 */
async function getMalAnimeWithListStatus(animeId, auth) {
    try {
        const data = await malGetForUser(
            `/anime/${animeId}?fields=my_list_status,num_episodes`,
            auth.userId,
            auth.accessToken,
            auth.refreshToken,
        );
        return {
            listStatus: data?.my_list_status || null,
            numEpisodes: data?.num_episodes || 0,
        };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/\b404\b/.test(msg)) {
            if (log)
                log.warn('MAL anime not found (404) on list-status fetch', {
                    animeId,
                });
            return { listStatus: null, numEpisodes: 0 };
        }
        throw err;
    }
}

// =============================================================================
// Context wiring — populate module-level sql/log on first SDK call.
// =============================================================================
//
// Internal helpers in this file use module-level `sql` and `log` to avoid
// threading ctx through ~1100 LOC of MAL API/DB code. Each SDK method below
// calls `initFromCtx(ctx)` first to keep them populated.

function initFromCtx(ctx) {
    if (!ctx || !ctx.sql) {
        throw new Error(
            'mal-watch-sync: PluginContext.sql missing — declare `capabilities: { database: true }`.',
        );
    }
    if (!ctx.userCredentials) {
        throw new Error(
            'mal-watch-sync: PluginContext.userCredentials missing — host SDK out of date.',
        );
    }
    if (!ctx.catalog) {
        throw new Error('mal-watch-sync: PluginContext.catalog missing — host SDK out of date.');
    }
    if (!ctx.http) {
        throw new Error(
            'mal-watch-sync: PluginContext.http missing — declare `capabilities: { http: true }`.',
        );
    }
    if (!sql) sql = ctx.sql;
    if (!log) log = ctx.logger;
    if (!userCredentials) userCredentials = ctx.userCredentials;
    if (!http) http = ctx.http;
    if (!catalog) catalog = ctx.catalog;
}

// =============================================================================
// Plugin Export — SDK WatchSyncDefinition shape.
// =============================================================================

/** @type {import('@sapd/lumastra-plugin-sdk').WatchSyncDefinition} */
const malWatchSync = {
    id: 'mal-watch-sync',
    name: 'MyAnimeList Watch Sync',
    version: '2.0.0',
    capabilities: { database: true, http: true },
    providerName: 'mal',

    settings: {
        fields: [],
    },

    // =========================================================================
    // isAvailable — app is configured and at least one user has linked
    // =========================================================================
    async isAvailable(ctx) {
        initFromCtx(ctx);
        if (!getAppCredentials()) return false;
        const users = await getAllLinkedUsers();
        if (users.length === 0) return false;

        // Verify at least one token works
        const first = users[0];
        try {
            const resp = await malApiForUser(
                '/users/@me',
                first.userId,
                first.accessToken,
                first.refreshToken,
            );
            return resp.ok;
        } catch {
            return false;
        }
    },

    // =========================================================================
    // resolveIds — map internal UUIDs to MAL anime IDs
    // =========================================================================
    async resolveIds(ctx, items) {
        initFromCtx(ctx);
        if (items.length === 0) return [];

        // Filter to anime only — avoids burning MAL API calls on live-action,
        // documentaries, etc. that the engine offers up indiscriminately.
        // An item counts as anime if it (or its parent series for episodes)
        // has a non-empty anime_genres array in provider_metadata.
        if (sql) {
            try {
                const inputIds = items
                    .map((i) => i.mediaId)
                    .filter((id) =>
                        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id),
                    );
                if (inputIds.length === 0) return [];

                // anime_genres is sometimes JSON null (scalar) instead of an
                // array. PostgreSQL does NOT guarantee left-to-right
                // evaluation of WHERE conjuncts, so a bare jsonb_array_length
                // call throws on scalars. CASE forces the type guard to run
                // before the length call.
                const animeRows = await sql`
                    WITH targets AS (
                        SELECT mi.id AS query_id, mi.id AS check_id
                        FROM media_items mi
                        WHERE mi.id = ANY(${inputIds}::uuid[])
                        UNION ALL
                        SELECT ep.id AS query_id, series.id AS check_id
                        FROM media_items ep
                        JOIN media_items season ON season.id = ep.parent_id
                        JOIN media_items series ON series.id = season.parent_id
                        WHERE ep.id = ANY(${inputIds}::uuid[])
                          AND ep.media_type = 'episode'
                    )
                    -- (a) anime_genres present on the item or its parent series.
                    SELECT DISTINCT t.query_id::text AS query_id
                    FROM targets t
                    JOIN provider_metadata pm ON pm.media_id = t.check_id
                    WHERE CASE
                        WHEN jsonb_typeof(pm.metadata->'anime_genres') = 'array'
                            THEN jsonb_array_length(pm.metadata->'anime_genres')
                        ELSE 0
                    END > 0
                    -- (b) already carries a MAL id (item or series). A stored MAL
                    -- external_id is a stronger anime signal than anime_genres —
                    -- which is populated by a separate enrichment pass that can lag
                    -- or be absent for older/differently-imported titles. Without
                    -- this branch, an enriched series whose provider_metadata never
                    -- got anime_genres has every watched episode dropped here and
                    -- drained as "no provider id (gave up)". Resolves via the cached
                    -- external_id/grouping path below — zero MAL API calls.
                    UNION
                    SELECT DISTINCT t.query_id::text AS query_id
                    FROM targets t
                    JOIN external_ids ei ON ei.media_id = t.check_id AND ei.provider = 'mal'
                    -- (c) already has a per-item MAL grouping (episode-level mapping
                    -- written by mal-anime-id-enrichment even when the series row's
                    -- metadata lacks anime_genres).
                    UNION
                    SELECT DISTINCT g.media_id::text AS query_id
                    FROM media_external_groupings g
                    WHERE g.media_id = ANY(${inputIds}::uuid[]) AND g.provider = 'mal'
                    -- (d) TMDB's own curated 'anime' keyword, OR (Animation genre
                    -- id 16 + Japan as a production country) — on the item or its
                    -- parent series. anime_genres (a) depends on mdblist-sync
                    -- having run for this item at least once — a show mdblist has
                    -- no data for yet (still airing, very recently added) stays
                    -- permanently unclassified there. tmdb-metadata-sync already
                    -- populates keywords/genres/production_countries for every
                    -- catalog item, so this resolves anime that (a)-(c) all miss
                    -- without waiting on — or depending on — a separate provider
                    -- ever succeeding.
                    --
                    -- Uses production_countries (ISO codes, e.g. ["JP"]), NOT
                    -- TMDB's top-level origin_country field — this codebase
                    -- never parses or persists that field (it only models
                    -- origin_country as a per-company field on
                    -- TMDBProductionCompany, which is a different thing). Verify
                    -- against a real provider_metadata row before changing which
                    -- key this reads.
                    UNION
                    SELECT DISTINCT t.query_id::text AS query_id
                    FROM targets t
                    JOIN provider_metadata pm_tmdb
                        ON pm_tmdb.media_id = t.check_id AND pm_tmdb.provider = 'tmdb'
                    WHERE pm_tmdb.metadata->'keywords' ? 'anime'
                       OR (
                            pm_tmdb.metadata->'production_countries' ? 'JP'
                            AND pm_tmdb.metadata->'genres' @> '16'::jsonb
                       )
                `;
                const animeIds = new Set(animeRows.map((r) => r.query_id));
                const filtered = items.filter((i) => animeIds.has(i.mediaId));

                if (log) {
                    log.info('Filtered to anime items for MAL resolveIds', {
                        input: items.length,
                        anime: filtered.length,
                        skipped: items.length - filtered.length,
                    });
                }

                if (filtered.length === 0) return [];
                items = filtered;
            } catch (err) {
                if (log)
                    log.warn('Anime filter failed, proceeding with all items', {
                        error: String(err),
                    });
            }
        }

        // Use a linked user's token for MAL search (ID resolution is global).
        // Try each user until one succeeds (handles expired/revoked tokens).
        const users = await getAllLinkedUsers();
        if (users.length === 0) return [];
        let auth = null;
        for (const user of users) {
            try {
                const resp = await malApiForUser(
                    '/users/@me',
                    user.userId,
                    user.accessToken,
                    user.refreshToken,
                );
                if (resp.ok) {
                    auth = user;
                    break;
                }
            } catch {
                // try next user
            }
        }
        if (!auth) {
            if (log) log.warn('No linked MAL user has a working token for resolveIds');
            return [];
        }

        // Serial loop — every MAL fetch goes through the global throttle
        // anyway, so parallel chunks would just race for the same gap.
        const resolved = [];
        for (const item of items) {
            if (
                !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
                    item.mediaId,
                )
            )
                continue;

            let searchTitle = item.title;
            let searchType = item.mediaType;
            let seasonNumber = 1;
            let seriesId = null;

            if (item.mediaType === 'episode' && sql) {
                let resolvedFromParent = false;
                try {
                    // Walk up: episode → season → series
                    const parentRows = await sql`
                        SELECT
                            series.id AS series_id,
                            series.title AS series_title,
                            series.media_type AS series_type,
                            season.season_number
                        FROM media_items ep
                        LEFT JOIN media_items season ON season.id = ep.parent_id
                        LEFT JOIN media_items series ON series.id = season.parent_id
                        WHERE ep.id = ${item.mediaId}::uuid
                    `;
                    const seriesType = parentRows[0]?.series_type?.toLowerCase();
                    if (parentRows.length > 0 && (seriesType === 'tv' || seriesType === 'series')) {
                        seriesId = parentRows[0].series_id;
                        searchTitle = parentRows[0].series_title;
                        seasonNumber = parentRows[0].season_number || 1;
                        resolvedFromParent = true;
                    }
                } catch {
                    // Fall back to skip — don't search MAL with episode-level title
                }
                searchType = 'tv';
                if (!resolvedFromParent) {
                    if (log)
                        log.debug('Episode parent walk yielded no series, skipping', {
                            mediaId: item.mediaId,
                        });
                    continue;
                }
            }

            if (!searchTitle) continue;

            // Effective mapping check (admin-override wins, then most recent).
            // Source-priority precedence MUST live in SQL — never in JS.
            if (sql) {
                try {
                    const mappingRows = await sql`
                        SELECT DISTINCT ON (media_id) group_external_id
                        FROM media_external_groupings
                        WHERE media_id = ${item.mediaId}::uuid
                          AND provider = 'mal'
                        ORDER BY
                            media_id,
                            CASE source WHEN 'admin-override' THEN 0 ELSE 1 END,
                            created_at DESC
                    `;
                    if (mappingRows.length > 0 && mappingRows[0].group_external_id) {
                        resolved.push({
                            mediaId: item.mediaId,
                            providerId: mappingRows[0].group_external_id,
                        });
                        continue; // skip walkSequelChain entirely
                    }
                } catch (err) {
                    if (log)
                        log.debug('Effective mapping lookup failed, falling back', {
                            mediaId: item.mediaId,
                            error: String(err),
                        });
                }
            }

            // Partial-airing guard: if the series has been enriched but this
            // episode has no mapping, it's in the un-mapped airing tail
            // (chain stopped at num_episodes=0). Skip rather than fall through
            // to walkSequelChain — guessing a malAnimeId here would route
            // pushWatchState through the watermark-gated grouping count, which
            // returns 0 because the episode has no row in media_external_groupings,
            // resulting in an under-reported push to that MAL entry.
            // Episode is left for the next enrichment cycle (when MAL finalizes
            // num_episodes for that entry) to map and push correctly.
            if (sql && seriesId) {
                try {
                    const watermarkRows = await sql`
                        SELECT enriched_episode_count, flattened_episode_count
                        FROM series_grouping_state
                        WHERE series_id = ${seriesId}::uuid
                          AND provider = 'mal'
                          AND source = 'mal-anime-id-enrichment'
                        LIMIT 1
                    `;
                    if (watermarkRows.length > 0) {
                        // Series has been enriched (or attempted). The episode has
                        // no mapping — either it's the airing tail (enriched < flat)
                        // or admin removed an override. In both cases, walking sequels
                        // is unsafe; the push side would mis-count.
                        if (log) {
                            log.debug(
                                'Episode has no MAL mapping but series is enriched — skipping (likely airing tail)',
                                {
                                    mediaId: item.mediaId,
                                    seriesId,
                                    enriched: watermarkRows[0].enriched_episode_count,
                                    flat: watermarkRows[0].flattened_episode_count,
                                },
                            );
                        }
                        continue;
                    }
                } catch (err) {
                    if (log)
                        log.debug('Watermark lookup failed, falling back to legacy resolution', {
                            mediaId: item.mediaId,
                            error: String(err),
                        });
                }
            }

            // Prefer the MAL ID already stored by the Fribb sync plugin over a
            // live MAL title search. The stored ID is exact; search can mismatch
            // on disambiguation (e.g. franchise entries, alternative titles).
            // Look up on the series root for episodes, on the item itself otherwise.
            let baseMalId = null;
            const lookupId = seriesId ?? item.mediaId;
            if (sql) {
                try {
                    const storedRows = await sql`
                        SELECT external_id FROM external_ids
                        WHERE media_id = ${lookupId}::uuid
                          AND provider = 'mal'
                        LIMIT 1
                    `;
                    if (storedRows.length > 0) baseMalId = storedRows[0].external_id;
                } catch {
                    // fall through to API search
                }
            }

            // Set only when baseMalId came from a live search this call (not
            // from storedRows above) — gates the persistence decision below.
            let liveSearchScore = null;

            if (!baseMalId) {
                let year = undefined;
                if (sql) {
                    try {
                        const dateRows = await sql`
                            SELECT premiere_date FROM media_items WHERE id = ${item.mediaId}::uuid
                        `;
                        if (dateRows[0]?.premiere_date) {
                            year = new Date(dateRows[0].premiere_date).getFullYear();
                        }
                    } catch {
                        // no year
                    }
                }
                // Don't catch here — transient errors propagate to the engine so
                // the page is retried next cycle rather than silently marking pushed.
                const searchResult = await searchMalAnime(searchTitle, year, searchType, auth);
                baseMalId = searchResult?.id ?? null;
                liveSearchScore = searchResult?.score ?? null;
            }

            if (!baseMalId) continue;

            const shouldPersist =
                liveSearchScore !== null && liveSearchScore >= MAL_ID_PERSIST_MIN_SCORE;

            /**
             * Best-effort: persist a freshly-resolved id so the next episode of
             * this series reuses it (the storedRows lookup above) instead of
             * re-searching MAL every push cycle. A write failure must not drop
             * the push this cycle is actually here to do — `catalog` is a
             * required part of every real PluginContext (initFromCtx() throws
             * if it's missing), so this try/catch is a write-failure guard,
             * not a capability check.
             *
             * Deliberately NOT this plugin's route to satisfying
             * mal-anime-id-enrichment's own eligibility check — that stage
             * ALSO requires `anime_genres` (written only by mdblist-sync),
             * which this write does nothing to supply. A series resolved only
             * through this fallback stays outside that stage's proper
             * sequel-chain/episode-count mapping until mdblist-sync (or an
             * admin override) separately gives it an anime_genres marker.
             */
            const persistResolvedId = async (malId) => {
                try {
                    await catalog.upsertExternalId({
                        provider: 'mal',
                        externalId: malId,
                        mediaType: searchType,
                        mediaItemId: lookupId,
                    });
                } catch (err) {
                    if (log) {
                        log.warn('Failed to persist resolved MAL id', {
                            mediaId: lookupId,
                            malId,
                            error: String(err),
                        });
                    }
                }
            };

            if (item.mediaType === 'episode' && seasonNumber > 1) {
                const { malId: seasonMalId, reachedSeason } = await walkSequelChain(
                    baseMalId,
                    seasonNumber,
                    auth,
                );
                if (reachedSeason !== seasonNumber) {
                    // Pushing S5 progress to S3's MAL entry would silently
                    // corrupt the user's list. Skip rather than mismap.
                    if (log) {
                        log.warn(
                            'Sequel walk fell short — skipping item to avoid wrong-season push',
                            {
                                mediaId: item.mediaId,
                                requested: seasonNumber,
                                reached: reachedSeason,
                            },
                        );
                    }
                    continue;
                }
                // Only persist baseMalId (onto the SERIES ROOT via lookupId)
                // once the chain walk has actually confirmed it behaves like
                // season 1 of a chain that reaches `seasonNumber` — never
                // right after the search, before this check. A search can
                // score a LATER season's MAL entry highest for a later-season
                // episode (its air year matches that season's start_date, not
                // season 1's); persisting THAT guess onto the series root
                // would corrupt every other season's episodes via the
                // storedRows fast path above — including season-1 episodes,
                // which never re-walk the chain and would push straight onto
                // it.
                if (shouldPersist) await persistResolvedId(baseMalId);
                resolved.push({
                    mediaId: item.mediaId,
                    providerId: seasonMalId,
                });
            } else {
                if (shouldPersist) await persistResolvedId(baseMalId);
                resolved.push({ mediaId: item.mediaId, providerId: baseMalId });
            }
        }

        return resolved;
    },

    // =========================================================================
    // listLinkedUsers — Lumastra userIds who have linked their MAL account.
    // Membership test mirrors getAllLinkedUsers(): presence of an
    // access_token row, not listLinkedUsers() on the store (which would
    // include partially-deleted rows).
    // =========================================================================
    async listLinkedUsers(ctx) {
        initFromCtx(ctx);
        if (!userCredentials) return [];
        return userCredentials.listUsersWithKey('access_token');
    },

    // =========================================================================
    // pushWatchState — push watch state changes to MAL (per-user)
    // =========================================================================
    async pushWatchState(ctx, items) {
        initFromCtx(ctx);
        // Engine contract (WatchSyncPushResult): `successful` and
        // `drainedAsSkipped` are arrays of {username, mediaId} that the
        // engine maps over to mark backing events pushed. Without these
        // arrays the engine throws TypeError and the entire page is
        // reported as skipped — counters alone are not enough.
        const result = {
            succeeded: 0,
            failed: 0,
            skipped: 0,
            staleIds: [],
            errors: [],
            successful: [],
            drainedAsSkipped: [],
            failedItems: [],
        };

        if (log) {
            const userCounts = items.reduce((acc, i) => {
                acc[i.username || '?'] = (acc[i.username || '?'] || 0) + 1;
                return acc;
            }, {});
            log.info('pushWatchState invoked', {
                totalItems: items.length,
                byUser: userCounts,
            });
        }

        const recordSuccess = (groupItems) => {
            result.succeeded += groupItems.length;
            for (const i of groupItems) {
                result.successful.push({
                    username: i.username,
                    mediaId: i.mediaId,
                });
            }
        };
        const recordDrain = (groupItems) => {
            result.skipped += groupItems.length;
            for (const i of groupItems) {
                result.drainedAsSkipped.push({
                    username: i.username,
                    mediaId: i.mediaId,
                });
            }
        };
        // MAL failures are surfaced per group (per anime/movie), not per API
        // call, so `terminal` defaults false everywhere here: an `ok===false`
        // MAL API result is ambiguous (could be transient) and none of the
        // call sites below have enough signal to claim otherwise.
        const recordFailure = (groupItems, error, terminal) => {
            result.failed += groupItems.length;
            const msg = String(error).slice(0, 500);
            for (const i of groupItems) {
                result.failedItems.push({
                    username: i.username,
                    mediaId: i.mediaId,
                    error: msg,
                    terminal: Boolean(terminal),
                });
            }
        };

        // Group by username first, then by MAL anime ID
        /** @type {Map<string, typeof items>} */
        const byUser = new Map();
        for (const item of items) {
            if (!item.username) {
                recordFailure([item], 'missing username', false);
                continue;
            }
            const group = byUser.get(item.username) || [];
            group.push(item);
            byUser.set(item.username, group);
        }

        for (const [username, userItems] of byUser) {
            const creds = await getUserCredentials(username);
            if (!creds) {
                // Terminal: no credentials means no possible push. Drain so
                // the engine stops re-presenting these items each cycle.
                recordDrain(userItems);
                result.errors.push(`No MAL credentials for user: ${username}`);
                continue;
            }

            // Group user's items by MAL anime ID
            /** @type {Map<string, typeof userItems>} */
            const byAnimeId = new Map();
            for (const item of userItems) {
                const group = byAnimeId.get(item.providerId) || [];
                group.push(item);
                byAnimeId.set(item.providerId, group);
            }

            for (const [malAnimeId, groupItems] of byAnimeId) {
                try {
                    const mediaIds = groupItems.map((i) => i.mediaId);
                    if (mediaIds.length === 0) {
                        recordFailure(groupItems, 'no media ids in group', false);
                        continue;
                    }
                    let isMovie = false;

                    if (sql) {
                        const typeRows = await sql`
                            SELECT DISTINCT media_type FROM media_items
                            WHERE id = ANY(${mediaIds}::uuid[])
                        `;
                        isMovie = typeRows.some((r) => r.media_type === 'movie');
                    }

                    // Single API call: fetch current list status + num_episodes
                    const userAuth = {
                        userId: username,
                        accessToken: creds.accessToken,
                        refreshToken: creds.refreshToken,
                    };
                    const { listStatus: currentStatus, numEpisodes: numTotalEpisodes } =
                        await getMalAnimeWithListStatus(malAnimeId, userAuth);

                    if (isMovie) {
                        const isWatched = groupItems.some((i) => i.isWatched);
                        const status = isWatched ? 'completed' : 'plan_to_watch';

                        // Idempotency: skip if already completed on MAL
                        if (currentStatus?.status === 'completed' && isWatched) {
                            if (log)
                                log.debug('MAL movie already completed, skipping', { malAnimeId });
                            recordSuccess(groupItems);
                            continue;
                        }

                        const ok = await updateMalAnimeStatusForUser(
                            malAnimeId,
                            { status },
                            username,
                            creds.accessToken,
                            creds.refreshToken,
                        );

                        if (log)
                            log.info('MAL movie update result', {
                                username,
                                malAnimeId,
                                status,
                                ok,
                            });
                        if (ok) recordSuccess(groupItems);
                        else {
                            recordFailure(
                                groupItems,
                                `Failed to update movie ${malAnimeId}`,
                                false,
                            );
                            result.errors.push(`Failed to update movie ${malAnimeId}`);
                        }
                    } else {
                        let watchedCount = 0;

                        const repEpisodeId = groupItems[0]?.mediaId;

                        // Decide: grouping-aware count (multi-cour aware) or season-scoped fallback
                        let useGrouping = false;

                        if (repEpisodeId && sql) {
                            // Resolve series for the rep episode (walks ep → season → series)
                            const seriesRows = await sql`
                                SELECT series.id::text AS series_id
                                FROM media_items ep
                                JOIN media_items season ON season.id = ep.parent_id
                                JOIN media_items series ON series.id = season.parent_id
                                WHERE ep.id = ${repEpisodeId}::uuid
                                  AND ep.media_type = 'episode'
                            `;
                            const seriesId = seriesRows[0]?.series_id;

                            if (seriesId) {
                                // Watermark: trust grouping if enrichment has run for this series
                                const watermarkRows = await sql`
                                    SELECT 1
                                    FROM series_grouping_state
                                    WHERE series_id = ${seriesId}::uuid
                                      AND provider = 'mal'
                                      AND source = 'mal-anime-id-enrichment'
                                    LIMIT 1
                                `;
                                if (watermarkRows.length > 0) useGrouping = true;
                            }

                            // Admin overrides always trusted, watermark or not
                            if (!useGrouping) {
                                const adminRows = await sql`
                                    SELECT 1
                                    FROM media_external_groupings
                                    WHERE media_id = ${repEpisodeId}::uuid
                                      AND provider = 'mal'
                                      AND source = 'admin-override'
                                    LIMIT 1
                                `;
                                if (adminRows.length > 0) useGrouping = true;
                            }
                        }

                        if (useGrouping && sql) {
                            // Count user-watched episodes that map to THIS MAL entry via effective mapping.
                            // The DISTINCT ON precedence rule must live in SQL — same pattern as resolveIds.
                            const groupedRows = await sql`
                                WITH effective_mapping AS (
                                    SELECT DISTINCT ON (media_id)
                                        media_id, group_external_id
                                    FROM media_external_groupings
                                    WHERE provider = 'mal'
                                    ORDER BY
                                        media_id,
                                        CASE source WHEN 'admin-override' THEN 0 ELSE 1 END,
                                        created_at DESC
                                )
                                SELECT COUNT(*)::int AS count
                                FROM user_media_state ums
                                JOIN effective_mapping em ON em.media_id = ums.media_id
                                WHERE ums.user_id = ${username}
                                  AND ums.is_watched = true
                                  AND em.group_external_id = ${malAnimeId}
                            `;
                            watchedCount = groupedRows[0]?.count || 0;
                        } else if (sql && repEpisodeId) {
                            // Fallback: existing season-scoped count (covers: enrichment hasn't run yet,
                            // MAL num_episodes=0 cut the tail, single-cour seasons).
                            const scopeRows = await sql`
                                SELECT parent_id::text AS parent_id
                                FROM media_items
                                WHERE id = ${repEpisodeId}::uuid
                                  AND media_type = 'episode'
                            `;
                            const seasonId = scopeRows[0]?.parent_id;
                            if (seasonId) {
                                const countRows = await sql`
                                    SELECT COUNT(*)::int AS count
                                    FROM user_media_state ums
                                    JOIN media_items mi
                                        ON mi.id = ums.media_id
                                    WHERE ums.user_id = ${username}
                                      AND ums.is_watched = true
                                      AND mi.media_type = 'episode'
                                      AND mi.parent_id = ${seasonId}::uuid
                                `;
                                watchedCount = countRows[0]?.count || 0;
                            } else {
                                watchedCount = groupItems.filter((i) => i.isWatched).length;
                            }
                        } else {
                            watchedCount = groupItems.filter((i) => i.isWatched).length;
                        }

                        // Idempotency: skip if MAL already has >= our progress
                        if (currentStatus) {
                            const malWatched = currentStatus.num_episodes_watched || 0;
                            if (currentStatus.status === 'completed') {
                                if (log)
                                    log.debug('MAL anime already completed, skipping', {
                                        malAnimeId,
                                    });
                                recordSuccess(groupItems);
                                continue;
                            }
                            if (malWatched >= watchedCount) {
                                if (log)
                                    log.debug('MAL already has >= episodes, skipping', {
                                        malAnimeId,
                                        malWatched,
                                        ours: watchedCount,
                                    });
                                recordSuccess(groupItems);
                                continue;
                            }
                        }

                        // Determine status: only mark completed if num_episodes > 0 and we've watched all
                        let status;
                        if (numTotalEpisodes > 0 && watchedCount >= numTotalEpisodes) {
                            status = 'completed';
                        } else if (watchedCount > 0) {
                            status = 'watching';
                        } else {
                            status = 'plan_to_watch';
                        }

                        const ok = await updateMalAnimeStatusForUser(
                            malAnimeId,
                            { status, num_watched_episodes: watchedCount },
                            username,
                            creds.accessToken,
                            creds.refreshToken,
                        );

                        if (log)
                            log.info('MAL anime update result', {
                                username,
                                malAnimeId,
                                status,
                                watchedCount,
                                numTotalEpisodes,
                                ok,
                            });
                        if (ok) recordSuccess(groupItems);
                        else {
                            recordFailure(
                                groupItems,
                                `Failed to update anime ${malAnimeId} (ep: ${watchedCount})`,
                                false,
                            );
                            result.errors.push(
                                `Failed to update anime ${malAnimeId} (ep: ${watchedCount})`,
                            );
                        }
                    }
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    if (/\b404\b/.test(msg)) {
                        // Terminal: MAL doesn't recognise this anime ID
                        // anymore. Drain so it stops blocking the queue.
                        result.staleIds.push(malAnimeId);
                        recordDrain(groupItems);
                    } else {
                        recordFailure(groupItems, `anime ${malAnimeId}: ${msg}`, false);
                        result.errors.push(`anime ${malAnimeId}: ${msg}`);
                    }
                }
            }
        }

        return result;
    },

    // =========================================================================
    // pullWatchState — fetch MAL animelists for ALL linked users
    //
    // Honors `signal` for graceful shutdown. `cursors` is ignored: MAL's
    // animelist endpoint has no change-tracking parameter, so every pull
    // is a full re-sync of the watching/completed/on_hold buckets.
    // dropped/plan_to_watch are intentionally excluded — those statuses
    // shouldn't propagate as Lumastra watch state.
    // =========================================================================
    async pullWatchState(ctx, options = {}) {
        initFromCtx(ctx);
        const signal = options.signal ?? ctx.signal;
        const result = {
            items: [],
            errors: [],
        };

        const users = await getAllLinkedUsers();
        if (users.length === 0) {
            result.errors.push('No users have linked their MAL account');
            return result;
        }

        const scoped = options?.onlyUserIds
            ? users.filter((u) => options.onlyUserIds.includes(u.userId))
            : users;

        // Reverse mapping MAL anime id -> Lumastra episodes, loaded once per pull
        // run and shared by every user and list entry. Querying it per entry
        // re-ran the DISTINCT ON over every 'mal' grouping each time (prod:
        // 352k calls). Same rows and order as the per-entry query; a mapping
        // added mid-run is picked up by the next pull.
        // The promise is cached, success or failure: a failed load must not be
        // retried per entry (that is the per-entry storm this replaced), so
        // every entry of this run sees the same rejection and is skipped.
        let episodesByMalId = null;
        let mappingFailureReported = false;
        const loadEpisodesByMalId = () => (episodesByMalId ??= queryEpisodesByMalId());
        const queryEpisodesByMalId = async () => {
            const rows = await sql`
                WITH effective_mapping AS (
                    SELECT DISTINCT ON (media_id)
                        media_id, group_external_id
                    FROM media_external_groupings
                    WHERE provider = 'mal'
                    ORDER BY
                        media_id,
                        CASE source WHEN 'admin-override' THEN 0 ELSE 1 END,
                        created_at DESC
                )
                SELECT em.group_external_id,
                       mi.id::text AS media_id,
                       mi.season_number,
                       mi.episode_number
                FROM effective_mapping em
                JOIN media_items mi ON mi.id = em.media_id
                WHERE mi.media_type = 'episode'
                  AND mi.season_number IS NOT NULL
                  AND mi.season_number > 0
                ORDER BY em.group_external_id,
                         mi.season_number,
                         mi.episode_number NULLS LAST,
                         mi.id
            `;
            const map = new Map();
            for (const row of rows) {
                const list = map.get(row.group_external_id);
                const episode = {
                    media_id: row.media_id,
                    season_number: row.season_number,
                    episode_number: row.episode_number,
                };
                if (list) list.push(episode);
                else map.set(row.group_external_id, [episode]);
            }
            return map;
        };

        for (let i = 0; i < scoped.length; i++) {
            const user = scoped[i];
            if (signal?.aborted) break;
            const malUsername = user.providerUsername;
            if (!malUsername) {
                result.errors.push(
                    `User ${user.userId} has no MAL username stored — re-link MAL to repair`,
                );
                options?.onProgress?.({
                    processed: i + 1,
                    total: scoped.length,
                    currentUser: user.userId,
                });
                continue;
            }
            if (malUsername.length > 255) {
                result.errors.push(`User ${user.userId} MAL username exceeds 255 chars — skipping`);
                options?.onProgress?.({
                    processed: i + 1,
                    total: scoped.length,
                    currentUser: user.userId,
                });
                continue;
            }

            try {
                const statuses = ['watching', 'completed', 'on_hold'];

                for (const status of statuses) {
                    if (signal?.aborted) break;
                    let nextUrl =
                        `/users/${encodeURIComponent(malUsername)}/animelist` +
                        `?status=${status}&limit=${PULL_PAGE_SIZE}` +
                        `&fields=list_status,num_episodes,alternative_titles,media_type,start_date`;

                    while (nextUrl) {
                        if (signal?.aborted) break;
                        const data = await malGetForUser(
                            nextUrl,
                            user.userId,
                            user.accessToken,
                            user.refreshToken,
                        );
                        const entries = data?.data || [];

                        for (const entry of entries) {
                            const node = entry.node;
                            const listStatus = entry.list_status;
                            if (!node || !listStatus) continue;

                            const malAnimeId = String(node.id);
                            const MAX_ITEMS = 10000;
                            let numWatched = listStatus.num_episodes_watched || 0;
                            if (numWatched > MAX_ITEMS) numWatched = MAX_ITEMS;
                            const isCompleted = listStatus.status === 'completed';
                            const malMediaType = node.media_type;

                            if (malMediaType === 'movie') {
                                result.items.push({
                                    providerId: malAnimeId,
                                    tmdbId: null,
                                    imdbId: null,
                                    mediaType: 'movie',
                                    isWatched: isCompleted,
                                    resumePositionMs: 0,
                                    runtimeMs: 0,
                                    watchCount: isCompleted ? 1 : 0,
                                    providerUsername: user.userId,
                                    title: node.title,
                                });
                            } else {
                                // Reverse-lookup: which Lumastra episodes belong to
                                // this MAL list entry? Uses media_external_groupings
                                // populated by mal-anime-id-enrichment. Effective
                                // mapping (admin-override > else, then most recent)
                                // — same precedence rule as resolveIds/pushWatchState.
                                if (!sql) continue;

                                let episodeRows;
                                try {
                                    episodeRows =
                                        (await loadEpisodesByMalId()).get(malAnimeId) ?? [];
                                } catch (err) {
                                    // One report per run: every entry sees the
                                    // same cached failure.
                                    if (!mappingFailureReported) {
                                        mappingFailureReported = true;
                                        result.errors.push(
                                            `MAL episode mapping could not be loaded: ${String(err)}`,
                                        );
                                        if (log)
                                            log.warn(
                                                'Reverse mapping load failed; series entries skipped this run',
                                                {
                                                    error: String(err),
                                                },
                                            );
                                    }
                                    continue;
                                }

                                if (episodeRows.length === 0) {
                                    // Entry has no Lumastra mappings yet — series
                                    // not enriched, or the entry is the
                                    // un-mapped airing tail. Skip until the
                                    // enrichment plugin catches up. Logged at
                                    // debug because this is the steady-state for
                                    // backlog series, not an error.
                                    if (log)
                                        log.debug(
                                            'MAL entry has no mapped episodes yet, skipping',
                                            {
                                                malAnimeId,
                                                title: node.title,
                                                malWatched: numWatched,
                                            },
                                        );
                                    continue;
                                }

                                // How many episodes to mark watched?
                                //   - completed: all mapped episodes (MAL says
                                //     the user finished this entry)
                                //   - watching/on_hold: take the first N where
                                //     N = min(numWatched, mappedCount). MAL
                                //     tracks count, not which specific eps —
                                //     "first N in raw order" is the canonical
                                //     interpretation.
                                const emitCount = isCompleted
                                    ? episodeRows.length
                                    : Math.min(numWatched, episodeRows.length);
                                if (emitCount === 0) continue;

                                // MAL stores ONE updated_at per list entry, not
                                // per-episode. Spread that timestamp backwards
                                // by 1ms per earlier episode so Continue-Watching
                                // ordering uses the natural sequence (last
                                // emitted episode == latest watch). Falls back
                                // to engine NOW() if updated_at missing or
                                // malformed (Invalid Date).toISOString() throws
                                // RangeError downstream, which would abort the
                                // whole user batch.
                                const baseUpdatedAt = (() => {
                                    if (!listStatus.updated_at) return null;
                                    const d = new Date(listStatus.updated_at);
                                    return Number.isFinite(d.getTime()) ? d : null;
                                })();

                                for (let i = 0; i < emitCount; i++) {
                                    const lastWatchedAt = baseUpdatedAt
                                        ? new Date(baseUpdatedAt.getTime() - (emitCount - 1 - i))
                                        : null;
                                    result.items.push({
                                        // Pre-resolved — engine bypasses its
                                        // resolveIds chain when this is set.
                                        internalMediaId: episodeRows[i].media_id,
                                        providerId: malAnimeId,
                                        tmdbId: null,
                                        imdbId: null,
                                        mediaType: 'episode',
                                        isWatched: true,
                                        resumePositionMs: 0,
                                        runtimeMs: 0,
                                        watchCount: 1,
                                        providerUsername: user.userId,
                                        title: node.title,
                                        lastWatchedAt,
                                    });
                                }

                                if (log) {
                                    log.debug('Emitted MAL series entry as episodes', {
                                        userId: user.userId,
                                        malAnimeId,
                                        title: node.title,
                                        emitted: emitCount,
                                        mappedTotal: episodeRows.length,
                                        malWatched: numWatched,
                                        completed: isCompleted,
                                    });
                                }
                            }
                        }

                        nextUrl = data?.paging?.next || null;
                        if (nextUrl && nextUrl.startsWith('http')) {
                            if (!nextUrl.startsWith(MAL_API_BASE)) {
                                if (log)
                                    log.warn('Suspicious paging URL', {
                                        nextUrl,
                                    });
                                break;
                            }
                            nextUrl = nextUrl.replace(MAL_API_BASE, '');
                        }
                    }
                }

                if (log) {
                    log.info('MAL pull completed for user', {
                        userId: user.userId,
                        malUsername,
                        items: result.items.length,
                        aborted: Boolean(signal?.aborted),
                    });
                }
                options?.onProgress?.({
                    processed: i + 1,
                    total: scoped.length,
                    currentUser: user.userId,
                });
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                if (log)
                    log.error('MAL pull failed for user', {
                        userId: user.userId,
                        error: msg,
                    });
                result.errors.push(`${user.userId}: ${msg}`);
                options?.onProgress?.({
                    processed: i + 1,
                    total: scoped.length,
                    currentUser: user.userId,
                });
            }
        }

        return result;
    },

    // =========================================================================
    // resolveUserId — check if Lumastra user has linked MAL
    // =========================================================================
    async resolveUserId(ctx, username) {
        initFromCtx(ctx);
        const creds = await getUserCredentials(username);
        if (creds?.providerUsername) return creds.providerUsername;
        return null;
    },
};

export default malWatchSync;

// Exported ONLY for guarded-fetch-divergence.test.js, which runs the same
// scenario table against this local guard and the shared fetch-utils.ts
// implementation to catch the two silently drifting apart again. Not part
// of the plugin's SDK contract (the loader reads only the default export).
export { guardedFetch, MalRedirectError, MalFetchTimeoutError };
