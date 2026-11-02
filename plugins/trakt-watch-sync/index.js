// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Trakt Watch Sync Plugin
 *
 * Bidirectional watched-history sync between Lumastra and Trakt.
 * OAuth: deployment registers one Trakt app (TRAKT_CLIENT_ID + TRAKT_CLIENT_SECRET);
 * each user authorizes their own Trakt account. Per-user tokens live in
 * plugin_user_credentials under plugin_id 'trakt-watch-sync'.
 *
 * INVARIANT: providerId is always Trakt's own numeric id (ids.trakt), never a
 * TMDB id — pull, resolveIds, and push all use the Trakt id space.
 */

const TRAKT_API_BASE = 'https://api.trakt.tv';
const TRAKT_TOKEN_URL = 'https://api.trakt.tv/oauth/token';
// Cloudflare in front of api.trakt.tv rejects User-Agent-less requests with 403.
const TRAKT_USER_AGENT = 'Lumastra/1.0';
const TRAKT_MIN_GAP_MS = 350;
const PULL_PAGE_LIMIT = 100;
const MAX_PULL_PAGES = 1000;

// =============================================================================
// Redirect-guarded outbound transport (C22 fix-plan finding)
// =============================================================================
//
// This plugin declares `capabilities: { http: true }` and routes EVERY
// outbound call through the SDK's own SSRF-guarded client (`ctx.http` —
// `tasks/context-primitives.ts`'s `buildHttpClient`, backed by
// `tasks/url-safety.ts`'s `safeFetch`: DNS-pinning, per-hop redirect
// re-validation, syntactic SSRF gate). `HttpClient` exposes `get(url, opts)`
// and `post(url, body, opts)`, and every Trakt call in this file is one of
// those two — `get(url, opts)` takes a full `RequestInit` for `opts`, so a
// per-call header override (bearer token, User-Agent) fits it exactly; grep
// confirms every `method:` in this file is `'POST'` (token refresh,
// `/sync/history`) and everything else is a plain GET. C22 fix round 1
// review: this file previously carried its OWN hand-rolled `guardedFetch`
// (same-origin-only redirect loop) on the theory that `ctx.http` couldn't
// express its call shapes — that theory did not hold once actually checked
// against this file's real method usage, so the duplicate is deleted in
// favour of the shared, already-guarded, already-tested SDK client. (MAL's
// sibling plugin keeps a minimal local guard, but only for the one call
// `ctx.http` genuinely cannot express — a PATCH; see mal-watch-sync/index.js.)

/** @type {import('postgres').Sql | null} */
let sql = null;

/** @type {any} */
let log = null;

/** @type {import('@sapd/lumastra-plugin-sdk').UserCredentialStore | null} */
let userCredentials = null;

/** @type {import('@sapd/lumastra-plugin-sdk').HttpClient | null} */
let http = null;

function getAppCredentials() {
    const clientId = process.env.TRAKT_CLIENT_ID || '';
    const clientSecret = process.env.TRAKT_CLIENT_SECRET || '';
    if (!clientId || !clientSecret) return null;
    return { clientId, clientSecret };
}

function getRedirectUri() {
    // Match the host/port/path normalization used by the host's public URL getter.
    const base = (process.env.PUBLIC_BASE_URL || '').trim();
    const url = new URL(base);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || /[\s\\?#]/.test(base)) {
        throw new Error('Invalid Public Base URL');
    }
    return `${url.href.replace(/\/+$/, '')}/api/integrations/trakt/callback`;
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
 * Get all users who have linked their Trakt account.
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
            try {
                const creds = await getUserCredentials(userId);
                return creds ? { userId, ...creds } : null;
            } catch (err) {
                if (log)
                    log.warn('Trakt getAllLinkedUsers: failed to load credentials for user', {
                        userId,
                        error: err instanceof Error ? err.message : 'unknown',
                    });
                return null;
            }
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
// Trakt API Helpers (per-user)
// =============================================================================

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Global Trakt request throttle. Every fetch to TRAKT_API_BASE or
// TRAKT_TOKEN_URL awaits this to enforce a single global minimum gap between
// requests across all concurrent operations (push, pull, resolveIds, refresh).
// Promise-chained so callers queue in arrival order rather than racing on
// the lastAt timestamp.
let throttleChain = Promise.resolve();
let throttleLastAt = 0;

function traktThrottle() {
    const next = throttleChain.then(async () => {
        const now = Date.now();
        const wait = throttleLastAt + TRAKT_MIN_GAP_MS - now;
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

function traktHeaders(clientId, accessToken) {
    const h = {
        'Content-Type': 'application/json',
        // api.trakt.tv is fronted by Cloudflare, which 403s requests with no
        // User-Agent (Node's fetch/undici sends none by default). Required.
        'User-Agent': TRAKT_USER_AGENT,
        'trakt-api-version': '2',
        'trakt-api-key': clientId,
    };
    if (accessToken) h['Authorization'] = `Bearer ${accessToken}`;
    return h;
}

let warnedPublicBaseUrl = false;

/**
 * Refresh OAuth2 access token for a user. Trakt token bodies are JSON.
 * @returns {Promise<{accessToken: string, refreshToken: string} | null>}
 */
async function refreshUserToken(userId, currentRefreshToken) {
    if (!currentRefreshToken?.trim()) return null;
    const app = getAppCredentials();
    if (!app) {
        if (log)
            log.error('Cannot refresh Trakt token: TRAKT_CLIENT_ID/SECRET not configured', {
                userId,
            });
        return null;
    }
    // Deployment configuration is unrelated to this user's refresh token.
    // Check it outside the request catch so it is never logged as a refresh error.
    let redirectUri;
    try {
        redirectUri = getRedirectUri();
    } catch {
        if (!warnedPublicBaseUrl && log) {
            warnedPublicBaseUrl = true;
            log.warn('Trakt refresh paused: set or re-save PUBLIC_BASE_URL in Settings.');
        }
        return null;
    }
    try {
        await traktThrottle();
        // http.post JSON-encodes a non-string body itself and defaults
        // Content-Type to application/json — only the Trakt-specific
        // User-Agent needs adding via opts.headers.
        const resp = await http.post(
            TRAKT_TOKEN_URL,
            {
                grant_type: 'refresh_token',
                refresh_token: currentRefreshToken,
                client_id: app.clientId,
                client_secret: app.clientSecret,
                redirect_uri: redirectUri,
            },
            { headers: { 'User-Agent': TRAKT_USER_AGENT } },
        );
        if (!resp.ok) {
            if (log) log.error('Trakt token refresh failed', { userId, status: resp.status });
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
            if (log) log.error('Trakt refresh returned no access_token', { userId });
            return null;
        }
        const newAccessToken = data.access_token;
        const newRefreshToken = data.refresh_token || currentRefreshToken;
        const expiresAt = data.expires_in
            ? new Date(Date.now() + data.expires_in * 1000)
            : undefined;
        await updateStoredTokens(userId, newAccessToken, newRefreshToken, expiresAt);
        if (log) log.info('Trakt token refreshed', { userId });
        return { accessToken: newAccessToken, refreshToken: newRefreshToken };
    } catch (err) {
        if (log)
            log.error('Trakt token refresh error', {
                userId,
                error: err instanceof Error ? err.message : 'unknown',
            });
        return null;
    }
}

/**
 * Authenticated Trakt request for a user. Retries once on 401 (after refresh)
 * and on 429/5xx with backoff honoring Retry-After.
 * @returns {Promise<Response>}
 */
async function traktApiForUser(path, userId, accessToken, refreshToken, options = {}) {
    if (path.startsWith('http')) {
        let sameOrigin;
        try {
            sameOrigin = new URL(path).origin === new URL(TRAKT_API_BASE).origin;
        } catch {
            sameOrigin = false;
        }
        if (!sameOrigin) throw new Error('Invalid Trakt API URL');
    }
    const url = path.startsWith('http') ? path : `${TRAKT_API_BASE}${path}`;
    const app = getAppCredentials();
    if (!app) throw new Error('Trakt app credentials missing');

    let token = accessToken;
    for (let attempt = 0; attempt < 3; attempt++) {
        await traktThrottle();
        const headers = { ...traktHeaders(app.clientId, token), ...(options.headers || {}) };
        // Every call in this file is GET or POST (see the file-header note) —
        // route through the matching ctx.http method rather than a bespoke
        // fetch, so the redirect guard is the SDK's shared one.
        const resp =
            options.method === 'POST'
                ? await http.post(url, options.body, { headers })
                : await http.get(url, { headers });
        if (resp.status === 401 && refreshToken && attempt === 0) {
            const refreshed = await refreshUserToken(userId, refreshToken);
            if (refreshed) {
                token = refreshed.accessToken;
                continue;
            }
            return resp;
        }
        if ((resp.status === 429 || resp.status >= 500) && attempt < 2) {
            const retryAfter = Number(resp.headers.get('Retry-After')) || 2 ** attempt;
            await delay(Math.min(retryAfter, 10) * 1000);
            continue;
        }
        return resp;
    }
    throw new Error('Trakt request exhausted retries');
}

/**
 * Unauthenticated Trakt request (client-id only) — used by resolveIds search.
 * @returns {Promise<Response>}
 */
async function traktSearch(path) {
    const app = getAppCredentials();
    if (!app) throw new Error('Trakt app credentials missing');
    await traktThrottle();
    return http.get(`${TRAKT_API_BASE}${path}`, { headers: traktHeaders(app.clientId, null) });
}

// =============================================================================
// Context wiring — populate module-level sql/log on first SDK call.
// =============================================================================
//
// Internal helpers in this file use module-level `sql` and `log` to avoid
// threading ctx through every Trakt API/DB call. Each SDK method below calls
// `initFromCtx(ctx)` first to keep them populated.

function initFromCtx(ctx) {
    if (!ctx || !ctx.sql) {
        throw new Error(
            'trakt-watch-sync: PluginContext.sql missing — declare `capabilities: { database: true }`.',
        );
    }
    if (!ctx.userCredentials) {
        throw new Error(
            'trakt-watch-sync: PluginContext.userCredentials missing — host SDK out of date.',
        );
    }
    if (!ctx.http) {
        throw new Error(
            'trakt-watch-sync: PluginContext.http missing — declare `capabilities: { http: true }`.',
        );
    }
    if (!sql) sql = ctx.sql;
    if (!log) log = ctx.logger;
    if (!userCredentials) userCredentials = ctx.userCredentials;
    if (!http) http = ctx.http;
}

/**
 * Fetch a paginated Trakt history endpoint and push WatchStatePullItems into result.
 */
async function pullHistory(basePath, mediaType, user, providerUsername, result, signal) {
    let page = 1;
    let pageCount;
    do {
        if (signal?.aborted) break;
        const resp = await traktApiForUser(
            `${basePath}?page=${page}&limit=${PULL_PAGE_LIMIT}`,
            user.userId,
            user.accessToken,
            user.refreshToken,
        );
        if (!resp.ok) {
            result.errors.push(`${user.userId}: ${basePath} returned ${resp.status}`);
            return;
        }
        const rawPageCount = Number(resp.headers.get('X-Pagination-Page-Count')) || 1;
        if (rawPageCount > MAX_PULL_PAGES && log)
            log.warn('Trakt pagination truncated', {
                user: user.userId,
                rawPageCount,
                cap: MAX_PULL_PAGES,
            });
        pageCount = Math.min(rawPageCount, MAX_PULL_PAGES);
        const rows = await resp.json();
        if (!Array.isArray(rows)) {
            result.errors.push(`${user.userId}: ${basePath} returned a non-array body`);
            return;
        }
        for (const row of rows) {
            const lastWatchedAt = row.watched_at ? new Date(row.watched_at) : null;
            if (mediaType === 'movie') {
                const ids = row.movie?.ids;
                if (!ids?.trakt) continue;
                result.items.push({
                    providerId: String(ids.trakt),
                    tmdbId: ids.tmdb != null ? String(ids.tmdb) : null,
                    imdbId: ids.imdb ?? null,
                    mediaType: 'movie',
                    isWatched: true,
                    resumePositionMs: 0,
                    runtimeMs: 0,
                    watchCount: 1,
                    providerUsername,
                    title: row.movie?.title,
                    lastWatchedAt,
                });
            } else {
                const epIds = row.episode?.ids;
                if (!epIds?.trakt) continue;
                result.items.push({
                    providerId: String(epIds.trakt),
                    tmdbId: null,
                    imdbId: epIds?.imdb ?? null,
                    mediaType: 'episode',
                    isWatched: true,
                    resumePositionMs: 0,
                    runtimeMs: 0,
                    watchCount: 1,
                    providerUsername,
                    seasonNumber: row.episode?.season ?? undefined,
                    episodeNumber: row.episode?.number ?? undefined,
                    seriesTmdbId:
                        row.show?.ids?.tmdb != null ? String(row.show.ids.tmdb) : undefined,
                    title: row.show?.title,
                    lastWatchedAt,
                });
            }
        }
        page += 1;
    } while (page <= pageCount);
}

/**
 * Bulk-fetch the trakt ids of items a user has ALREADY watched on Trakt, via
 * the compact `extended=min` shape: `{ "<traktId>": ["<watchedAt>", ...] }`
 * (one request returns everything for that media kind — see
 * trakt/trakt-api#775; unlike the default paginated shape, `extended=min`
 * is not paginated). Used by pushWatchState to avoid re-adding items to the
 * (append-only) `/sync/history` — see its own "Add-only" comment.
 *
 * NOTE: `/sync/watched/shows` only reports season/episode NUMBERS, not
 * per-episode trakt ids (a long-standing, still-unresolved gap — see
 * trakt/trakt-api#756), so it cannot be matched against our episode
 * `providerId`s. The newer `/sync/watched/episodes` type (added alongside
 * the movies/shows pagination rollout) keyes directly by episode trakt id
 * and is what we need here.
 *
 * FAIL-CLOSED: this must DISTINGUISH "confirmed empty" (the fetch succeeded
 * and the user genuinely has nothing watched of this kind) from "lookup
 * failed" (non-OK response, thrown error incl. traktApiForUser's "exhausted
 * retries", or unparseable/unexpected body). It returns:
 *   - a real `Set<string>` (possibly empty) on success → caller filters/pushes
 *   - `null` on failure → caller MUST NOT push that kind this run (a blind
 *     push would create the exact duplicate plays this task prevents, under
 *     the failure conditions most likely in prod: rate limits, transient 5xx).
 * Never collapse failure into an empty Set.
 *
 * @param {string} username
 * @param {{accessToken: string, refreshToken: string|null}} creds
 * @param {'movies'|'episodes'} traktType
 * @returns {Promise<Set<string> | null>}
 */
async function fetchWatchedTraktIds(username, creds, traktType) {
    try {
        const resp = await traktApiForUser(
            `/sync/watched/${traktType}?extended=min`,
            username,
            creds.accessToken,
            creds.refreshToken,
        );
        if (!resp.ok) {
            if (log)
                log.warn(
                    'Trakt push idempotency lookup failed; deferring this kind (fail-closed)',
                    { username, traktType, status: resp.status },
                );
            return null;
        }
        // Clone before reading: `resp` here is a plain fetch Response like any
        // other traktApiForUser caller gets — cloning costs nothing and means
        // this lookup never disturbs a body some other consumer still needs.
        const body = await resp.clone().json();
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            if (log)
                log.warn(
                    'Trakt push idempotency lookup returned unexpected shape; deferring this kind (fail-closed)',
                    { username, traktType },
                );
            return null;
        }
        return new Set(Object.keys(body));
    } catch (err) {
        if (log)
            log.warn('Trakt push idempotency lookup error; deferring this kind (fail-closed)', {
                username,
                traktType,
                error: err instanceof Error ? err.message : String(err),
            });
        return null;
    }
}

// =============================================================================
// Plugin Export — SDK WatchSyncDefinition shape.
// =============================================================================

/** @type {import('@sapd/lumastra-plugin-sdk').WatchSyncDefinition} */
const traktWatchSync = {
    id: 'trakt-watch-sync',
    name: 'Trakt Watch Sync',
    version: '1.0.0',
    capabilities: { database: true, http: true },
    providerName: 'trakt',
    settings: { fields: [] },

    async isAvailable(ctx) {
        initFromCtx(ctx);
        if (!getAppCredentials()) return false;
        const users = await getAllLinkedUsers();
        if (users.length === 0) return false;
        const first = users[0];
        try {
            const resp = await traktApiForUser(
                '/users/settings',
                first.userId,
                first.accessToken,
                first.refreshToken,
            );
            return resp.ok;
        } catch {
            return false;
        }
    },

    async resolveIds(ctx, items) {
        initFromCtx(ctx);
        if (items.length === 0) return [];
        /** @type {Array<{mediaId: string, providerId: string}>} */
        const resolved = [];
        for (const item of items) {
            if (ctx.signal?.aborted) break;
            try {
                if (item.mediaType === 'movie') {
                    if (!item.tmdbId) continue;
                    const resp = await traktSearch(
                        `/search/tmdb/${encodeURIComponent(item.tmdbId)}?type=movie`,
                    );
                    if (!resp.ok) continue;
                    const rows = await resp.json();
                    const traktId = Array.isArray(rows)
                        ? rows.find((r) => r?.movie?.ids?.trakt)?.movie?.ids?.trakt
                        : null;
                    if (traktId)
                        resolved.push({ mediaId: item.mediaId, providerId: String(traktId) });
                } else if (item.mediaType === 'episode') {
                    if (
                        !item.seriesTmdbId ||
                        item.seasonNumber == null ||
                        item.episodeNumber == null
                    )
                        continue;
                    const showResp = await traktSearch(
                        `/search/tmdb/${encodeURIComponent(item.seriesTmdbId)}?type=show`,
                    );
                    if (!showResp.ok) continue;
                    const showRows = await showResp.json();
                    const showTraktId = Array.isArray(showRows)
                        ? showRows.find((r) => r?.show?.ids?.trakt)?.show?.ids?.trakt
                        : null;
                    if (!showTraktId) continue;
                    const epResp = await traktSearch(
                        `/shows/${showTraktId}/seasons/${item.seasonNumber}/episodes/${item.episodeNumber}`,
                    );
                    if (!epResp.ok) continue;
                    const ep = await epResp.json();
                    if (ep?.ids?.trakt)
                        resolved.push({ mediaId: item.mediaId, providerId: String(ep.ids.trakt) });
                }
            } catch (err) {
                if (log)
                    log.warn('Trakt resolveIds failed for item', {
                        mediaId: item.mediaId,
                        error: err instanceof Error ? err.message : 'unknown',
                    });
            }
        }
        return resolved;
    },

    async pullWatchState(ctx, options = {}) {
        initFromCtx(ctx);
        const signal = options?.signal ?? ctx.signal;
        /** @type {import('@sapd/lumastra-plugin-sdk').WatchSyncPullResult} */
        const result = { items: [], errors: [] };
        const users = await getAllLinkedUsers();
        if (users.length === 0) {
            result.errors.push('No users have linked their Trakt account');
            return result;
        }

        const scoped = options?.onlyUserIds
            ? users.filter((u) => options.onlyUserIds.includes(u.userId))
            : users;

        for (let i = 0; i < scoped.length; i++) {
            const user = scoped[i];
            if (signal?.aborted) break;
            // providerUsername MUST be the credential-store user key (user.userId),
            // exactly like MAL — the engine resolves it back to a Lumastra user.
            const providerUsername = user.userId;
            try {
                await pullHistory(
                    '/sync/history/movies',
                    'movie',
                    user,
                    providerUsername,
                    result,
                    signal,
                );
                await pullHistory(
                    '/sync/history/episodes',
                    'episode',
                    user,
                    providerUsername,
                    result,
                    signal,
                );
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                result.errors.push(`${user.userId}: ${msg}`);
            }
            options?.onProgress?.({
                processed: i + 1,
                total: scoped.length,
                currentUser: user.userId,
            });
        }
        return result;
    },

    // Lumastra userIds who have linked their Trakt account. Membership test
    // mirrors getAllLinkedUsers(): presence of an access_token row.
    async listLinkedUsers(ctx) {
        initFromCtx(ctx);
        if (!userCredentials) return [];
        return userCredentials.listUsersWithKey('access_token');
    },

    async pushWatchState(ctx, items, signal) {
        initFromCtx(ctx);
        /** @type {import('@sapd/lumastra-plugin-sdk').WatchSyncPushResult} */
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
        if (items.length === 0) return result;

        const recordDrain = (groupItems) => {
            for (const i of groupItems) {
                result.skipped += 1;
                result.drainedAsSkipped.push({ username: i.username, mediaId: i.mediaId });
            }
        };
        const recordSuccess = (groupItems) => {
            for (const i of groupItems) {
                result.succeeded += 1;
                result.successful.push({ username: i.username, mediaId: i.mediaId });
            }
        };
        const recordFailure = (groupItems, error, terminal) => {
            const msg = String(error).slice(0, 500);
            for (const i of groupItems) {
                result.failed += 1;
                result.failedItems.push({
                    username: i.username,
                    mediaId: i.mediaId,
                    error: msg,
                    terminal: Boolean(terminal),
                });
            }
        };

        // Add-only: unwatched changes are terminally drained (we never call
        // /sync/history/remove — see spec).
        const watched = items.filter((i) => i.isWatched);
        recordDrain(items.filter((i) => !i.isWatched));
        if (watched.length === 0) return result;

        // Determine movie vs episode per item. A lookup failure must not
        // abort the whole batch — degrade to defaulting everything to
        // `movies` and keep going.
        const typeByMedia = new Map();
        if (sql) {
            try {
                const ids = watched.map((i) => i.mediaId);
                const rows =
                    await sql`SELECT id::text AS id, media_type FROM media_items WHERE id = ANY(${ids}::uuid[])`;
                for (const r of rows) typeByMedia.set(r.id, r.media_type);
            } catch (err) {
                if (log)
                    log.warn('Trakt push: media_type lookup failed; defaulting to movies', {
                        error: err instanceof Error ? err.message : String(err),
                    });
            }
        }

        // Group by username → one POST per user.
        /** @type {Map<string, typeof watched>} */
        const byUser = new Map();
        for (const i of watched) {
            const arr = byUser.get(i.username) || [];
            arr.push(i);
            byUser.set(i.username, arr);
        }

        for (const [username, groupItems] of byUser) {
            if (signal?.aborted) break;
            let creds;
            try {
                creds = await getUserCredentials(username);
            } catch (err) {
                recordFailure(
                    groupItems,
                    `${username}: ${err instanceof Error ? err.message : 'unknown'}`,
                    false,
                );
                result.errors.push(
                    `${username}: ${err instanceof Error ? err.message : 'unknown'}`,
                );
                continue;
            }
            if (!creds) {
                recordDrain(groupItems);
                continue;
            }
            const movies = [];
            const episodes = [];
            const validItems = [];
            for (const i of groupItems) {
                const traktId = Number(i.providerId);
                if (!i.providerId || !Number.isFinite(traktId)) {
                    // Terminal: a non-numeric Trakt id never self-heals. Drain so the engine
                    // marks the backing events pushed (stops the per-cycle retry), and record
                    // the reason as a terminal failure for the activity feed.
                    recordDrain([i]);
                    result.failedItems.push({
                        username: i.username,
                        mediaId: i.mediaId,
                        error: `invalid Trakt id "${i.providerId}" for media ${i.mediaId}`.slice(
                            0,
                            500,
                        ),
                        terminal: true,
                    });
                    result.errors.push(
                        `${username}: invalid Trakt id "${i.providerId}" for media ${i.mediaId}`,
                    );
                    continue;
                }
                validItems.push(i);
                const entry = { ids: { trakt: traktId }, watched_at: 'released' };
                if (typeByMedia.get(i.mediaId) === 'episode') episodes.push(entry);
                else movies.push(entry);
            }
            if (validItems.length === 0) continue;

            // Idempotency: /sync/history is add-only (no /sync/history/remove
            // call — see the comment above), so POSTing an item Trakt already
            // has creates a permanent duplicate play on the user's real
            // account. Bulk-fetch the user's already-watched set ONCE per
            // media kind actually present in this batch and drain items
            // already present instead of re-adding them.
            //
            // FAIL-CLOSED: fetchWatchedTraktIds returns `null` when the lookup
            // itself failed (429 exhausted, 5xx, network error, shape drift) —
            // distinct from a real (possibly empty) Set on success. If a kind's
            // lookup failed we must NOT push that kind blind (it could dup on
            // Trakt); instead we defer those items as TRANSIENT failures
            // (terminal=false) so their events stay un-pushed and the engine
            // retries next cycle. Movies and episodes are independent: a
            // failure on one kind never blocks the other.
            const [watchedMovieIds, watchedEpisodeIds] = await Promise.all([
                movies.length > 0 ? fetchWatchedTraktIds(username, creds, 'movies') : new Set(),
                episodes.length > 0 ? fetchWatchedTraktIds(username, creds, 'episodes') : new Set(),
            ]);
            const pushMovies = [];
            const pushEpisodes = [];
            const pushItems = [];
            const alreadyWatched = [];
            const deferred = [];
            for (const i of validItems) {
                const isEpisode = typeByMedia.get(i.mediaId) === 'episode';
                const idSet = isEpisode ? watchedEpisodeIds : watchedMovieIds;
                if (idSet === null) {
                    // Lookup for this kind failed — defer (retryable), don't push.
                    deferred.push(i);
                    continue;
                }
                if (idSet.has(String(i.providerId))) {
                    alreadyWatched.push(i);
                    continue;
                }
                pushItems.push(i);
                (isEpisode ? pushEpisodes : pushMovies).push({
                    ids: { trakt: Number(i.providerId) },
                    watched_at: 'released',
                });
            }
            if (deferred.length > 0) {
                // Non-terminal: leave the backing events un-pushed so the next
                // cycle retries once Trakt is reachable again.
                recordFailure(
                    deferred,
                    `${username}: watched-set lookup failed; deferred to avoid duplicate push`,
                    false,
                );
                result.errors.push(
                    `${username}: watched-set lookup failed for ${deferred.length} item(s); deferred (will retry)`,
                );
            }
            if (alreadyWatched.length > 0) {
                recordDrain(alreadyWatched);
                if (log)
                    log.debug('Trakt push: skipped items already watched on Trakt', {
                        username,
                        count: alreadyWatched.length,
                    });
            }
            if (pushItems.length === 0) continue;

            try {
                // Pass `username` as the token-lookup key — exactly as MAL does
                // (`userAuth.userId = username`, mal index.js:1029). It is the
                // credential-store key that refreshUserToken/updateStoredTokens use.
                const resp = await traktApiForUser(
                    '/sync/history',
                    username,
                    creds.accessToken,
                    creds.refreshToken,
                    {
                        method: 'POST',
                        body: JSON.stringify({ movies: pushMovies, episodes: pushEpisodes }),
                    },
                );
                if (resp.ok) {
                    let body = null;
                    try {
                        body = await resp.json();
                    } catch {
                        /* ignore */
                    }
                    const notFound = new Set();
                    for (const arr of [body?.not_found?.movies, body?.not_found?.episodes]) {
                        if (Array.isArray(arr)) {
                            for (const e of arr) {
                                if (e?.ids?.trakt != null) notFound.add(String(e.ids.trakt));
                            }
                        }
                    }
                    const okItems = pushItems.filter((i) => !notFound.has(String(i.providerId)));
                    const badItems = pushItems.filter((i) => notFound.has(String(i.providerId)));
                    recordSuccess(okItems);
                    if (badItems.length > 0) {
                        for (const i of badItems) result.staleIds.push(String(i.providerId));
                        recordDrain(badItems);
                        result.errors.push(
                            `${username}: ${badItems.length} item(s) not found on Trakt (drained)`,
                        );
                    }
                } else {
                    recordFailure(pushItems, `/sync/history returned ${resp.status}`, false);
                    result.errors.push(`${username}: /sync/history returned ${resp.status}`);
                }
            } catch (err) {
                recordFailure(
                    pushItems,
                    `${err instanceof Error ? err.message : 'unknown'}`,
                    false,
                );
                result.errors.push(
                    `${username}: ${err instanceof Error ? err.message : 'unknown'}`,
                );
            }
        }
        return result;
    },
};

export default traktWatchSync;
