// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Jellyfin Watch Sync.
 *
 * Syncs watch state between Lumastra and Jellyfin using lazy ID resolution.
 *
 * Configuration:
 * - SYNC_WRITEBACK_MINUTES: Override push interval (default: 5m)
 * - Gated by FEATURE_JELLYFIN_SYNC (requires JELLYFINURL + JELLYFINAPIKEY).
 *   The gate is enforced inside `isAvailable(ctx)` so the engine
 *   short-circuits push and pull when the feature flag is off.
 */

// NOTE: This watch-sync uses `jellyfinUserService.getAxiosInstance()` directly
// rather than `ctx.http`. Jellyfin is a built-in integration where the Axios
// instance carries the admin auth header + base URL set up at boot. Routing
// through ctx.http would require threading auth per-request and break the
// pattern shared with the rest of the Jellyfin code. This is an intentional
// exemption from the External-call discipline rule that applies to other
// plugins. If a future refactor centralizes Jellyfin auth, this should be
// reconsidered.

import { joinUpstreamUrl } from '$lib/shared/upstream-url.js';
import { buildJellyfinAuthHeaders } from '$lib/server/jellyfin/auth-headers.js';
import { defineWatchSync, TaskError } from '@sapd/lumastra-plugin-sdk';
import type {
    PluginContext,
    ResumePositionItem,
    WatchSyncDefinition,
    WatchSyncPullOptions,
    WatchSyncPullResult,
    WatchSyncPushResult,
    WatchSyncResolveItem,
    WatchSyncResolvedId,
    WatchStateChange,
    WatchStatePullItem,
} from '@sapd/lumastra-plugin-sdk';
import { features } from '$lib/server/config.js';
import { circuitBreaker } from '$lib/server/jellyfin/base-client.js';
import { withJellyfinRetry } from '$lib/server/jellyfin/retry.js';
import type { JellyfinSession } from '$lib/server/jellyfin/types/jellyfin.types.js';
import { resolveJellyfinUserIdByUserId } from '$lib/server/services/jellyfin-user-id-resolver.js';
import { toUserId } from '$lib/shared/user-id.js';
import { registerWatchSyncWithAutoTasks } from '../../index.js';
import { isMovie, isEpisode } from '$lib/server/utils/media-types.js';
import { encodePathSegment, isSafePathSegment } from '$lib/server/utils/upstream-path';
import { normalizeJellyfinId } from '$lib/server/utils/jellyfin-id.js';
// =============================================================================
// Jellyfin API client helper
// =============================================================================

interface JellyfinApi {
    axiosInstance: {
        get: <T>(url: string, config?: unknown) => Promise<{ data: T }>;
        post: <T>(url: string, data?: unknown, config?: unknown) => Promise<{ data: T }>;
        delete: <T>(url: string, config?: unknown) => Promise<{ data: T }>;
    };
    basePath: string;
    accessToken: string;
}

async function getJellyfinApi(): Promise<JellyfinApi | null> {
    const { jellyfinUserService } = await import('$lib/server/jellyfin/user.service.js');
    const axiosInstance = jellyfinUserService.getAxiosInstance();
    const basePath = jellyfinUserService.getBaseUrl();
    const accessToken = jellyfinUserService.getApiToken();
    if (!axiosInstance || !basePath || !accessToken) return null;
    return {
        axiosInstance: axiosInstance as JellyfinApi['axiosInstance'],
        basePath,
        accessToken,
    };
}

/** Current setter since 10.9; older/custom servers may expose only the legacy alias. */
async function writeUserData(
    api: JellyfinApi,
    userId: string,
    itemId: string,
    ticks: number,
    signal?: AbortSignal,
): Promise<void> {
    const body = { PlaybackPositionTicks: ticks };
    try {
        await api.axiosInstance.post(
            joinUpstreamUrl(
                api.basePath,
                `/UserItems/${encodePathSegment(itemId)}/UserData?userId=${encodePathSegment(userId)}`,
            ),
            body,
            requestOptions(api, signal),
        );
    } catch (error) {
        const status = (error as { response?: { status?: number } }).response?.status;
        if (status !== 404 && status !== 405) throw error;
        await api.axiosInstance.post(
            joinUpstreamUrl(
                api.basePath,
                `/Users/${encodePathSegment(userId)}/Items/${encodePathSegment(itemId)}/UserData`,
            ),
            body,
            requestOptions(api, signal),
        );
    }
}

/** Jellyfin may report dashed GUIDs; links are stored dashless. Leave non-GUID ids alone. */
function guidId(id: string): string {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
        ? normalizeJellyfinId(id)
        : id;
}

/**
 * A 404 on a file-paired item may mean Jellyfin gave the file a new id (rename,
 * re-add). Confirm the id is really gone, then drop the pairing and make the
 * next inventory due so the record is retried against the new id instead of
 * against a dead one forever. ID-based links are never touched.
 */
async function dropStaleFileLink(
    api: JellyfinApi,
    ctx: PluginContext,
    mediaId: string,
    jellyfinItemId: string,
    signal?: AbortSignal,
): Promise<boolean> {
    try {
        const response = await api.axiosInstance.get<{ Items?: Array<{ Id: string }> }>(
            joinUpstreamUrl(api.basePath, `/Items`),
            requestOptions(api, signal, {
                params: { Ids: jellyfinItemId, EnableImages: false, EnableUserData: false },
            }),
        );
        const items = response.data?.Items;
        if (!Array.isArray(items)) return false;
        const id = normalizeJellyfinId(jellyfinItemId);
        if (items.some((item) => normalizeJellyfinId(item.Id) === id)) return false;
        const { invalidateStaleFileLink } =
            await import('$lib/server/database/queries/jellyfin-file-pairing.queries.js');
        return await invalidateStaleFileLink(ctx.sql, mediaId, id);
    } catch {
        return false;
    }
}

/** What Jellyfin currently holds for one user and item, or null when it cannot be read. */
async function readUpstreamPosition(
    api: JellyfinApi,
    userId: string,
    itemId: string,
    signal?: AbortSignal,
): Promise<{ positionMs: number; lastPlayedAtMs: number | null } | null> {
    try {
        const response = await api.axiosInstance.get<JellyfinPullItemsResponse>(
            joinUpstreamUrl(api.basePath, `/Users/${encodePathSegment(userId)}/Items`),
            requestOptions(api, signal, { params: { ids: itemId, enableUserData: true } }),
        );
        const data = response.data?.Items?.find(
            (item) => guidId(item.Id) === guidId(itemId),
        )?.UserData;
        if (!data) return null;
        const lastPlayed = data.LastPlayedDate ? Date.parse(data.LastPlayedDate) : NaN;
        return {
            positionMs: Math.floor((data.PlaybackPositionTicks ?? 0) / TICKS_PER_MS),
            lastPlayedAtMs: Number.isNaN(lastPlayed) ? null : lastPlayed,
        };
    } catch {
        // Unreadable is not a reason to hold a delivery back; the write below
        // reports its own failure.
        return null;
    }
}

/** Positions closer than this are the same position (Jellyfin's tick precision drifts). */
const SAME_POSITION_TOLERANCE_MS = 1000;

function authHeaders(token: string): { headers: { Authorization: string } } {
    return { headers: buildJellyfinAuthHeaders({ token }) };
}

// =============================================================================
// Jellyfin response shapes
// =============================================================================

interface JellyfinUserRow {
    Id: string;
    Name: string;
}

interface JellyfinPullItem {
    Id: string;
    Type?: string;
    Name?: string;
    SeriesId?: string;
    SeriesName?: string;
    ParentIndexNumber?: number;
    IndexNumber?: number;
    ProviderIds?: { Tmdb?: string; Imdb?: string; Tvdb?: string };
    SeriesProviderIds?: { Tmdb?: string; Imdb?: string };
    UserData?: {
        Played?: boolean;
        PlaybackPositionTicks?: number;
        PlayCount?: number;
        LastPlayedDate?: string;
    };
    RunTimeTicks?: number;
}

interface JellyfinItemRow {
    Id: string;
    Type?: string;
    IndexNumber?: number;
    UserData?: {
        Played?: boolean;
        PlaybackPositionTicks?: number;
        PlayCount?: number;
        LastPlayedDate?: string;
    };
    RunTimeTicks?: number;
    ProviderIds?: Record<string, string>;
}

interface JellyfinItemsResponse {
    Items?: JellyfinItemRow[];
    TotalRecordCount?: number;
}

interface JellyfinPullItemsResponse {
    Items?: JellyfinPullItem[];
    TotalRecordCount?: number;
}

// =============================================================================
// ID resolution helpers
// =============================================================================

/**
 * Distinguish a legitimate "item genuinely absent" 404 from a genuine
 * transport/server error (network failure, timeout, 5xx, auth error).
 *
 * A 404 means Jellyfin definitively doesn't have the item → resolve to null so
 * the engine can terminally drain it. ANY OTHER error (no response = network /
 * timeout, or a 5xx / 401 / 403) is transient/operational and MUST propagate so
 * the caller retries rather than silently treating the item as absent and
 * dropping the watch-state change forever. Bare-catch-to-null made a Jellyfin
 * 500/timeout indistinguishable from a real 404 — this classifier is the fix.
 */
function isNotFoundError(err: unknown): boolean {
    const status = (err as { response?: { status?: number } })?.response?.status;
    return status === 404;
}

/**
 * Resolve a movie or series TMDB ID to a Jellyfin item ID.
 */
async function resolveMovieOrSeries(
    api: JellyfinApi,
    tmdbId: string,
    jellyfinType: 'Movie' | 'Series',
): Promise<string | null> {
    try {
        const response = await api.axiosInstance.get<JellyfinItemsResponse>(
            joinUpstreamUrl(api.basePath, `/Items`),
            {
                ...authHeaders(api.accessToken),
                params: {
                    AnyProviderIdEquals: `tmdb.${tmdbId}`,
                    IncludeItemTypes: jellyfinType,
                    Recursive: true,
                    Fields: 'ProviderIds',
                },
            },
        );
        const items = (response.data.Items ?? []).filter(
            (item) => item.ProviderIds?.Tmdb === tmdbId,
        );
        return items.length === 1 ? items[0].Id : null;
    } catch (err) {
        // A 404 = genuinely absent → null. Anything else is transient and must
        // reject so resolveIds surfaces it and the page retries.
        if (isNotFoundError(err)) return null;
        throw err;
    }
}

/**
 * Resolve an IMDB ID to a Jellyfin item ID (fallback).
 *
 * `jellyfinType` mirrors `resolveMovieOrSeries`'s `IncludeItemTypes` filter —
 * without it, a bare `AnyProviderIdEquals=imdb.<id>` query can return a
 * cross-media-type collision (e.g. an IMDB ID shared between a movie and an
 * unrelated item Jellyfin also tagged with it), breaking the file's
 * composite-key discipline. Callers always know the expected type from their
 * own resolution context (movie/series lookup, or episode fallback), so it's
 * threaded through rather than inferred.
 */
async function resolveByImdb(
    api: JellyfinApi,
    imdbId: string,
    jellyfinType: 'Movie' | 'Series' | 'Episode',
): Promise<string | null> {
    try {
        const response = await api.axiosInstance.get<JellyfinItemsResponse>(
            joinUpstreamUrl(api.basePath, `/Items`),
            {
                ...authHeaders(api.accessToken),
                params: {
                    AnyProviderIdEquals: `imdb.${imdbId}`,
                    IncludeItemTypes: jellyfinType,
                    Recursive: true,
                    Fields: 'ProviderIds',
                },
            },
        );
        const items = (response.data.Items ?? []).filter(
            (item) => item.ProviderIds?.Imdb?.toLowerCase() === imdbId.toLowerCase(),
        );
        return items.length === 1 ? items[0].Id : null;
    } catch (err) {
        if (isNotFoundError(err)) return null;
        throw err;
    }
}

/**
 * Resolve an episode to a Jellyfin item ID via its series TMDB ID.
 * Resolves the series first, then walks the episode list to find the exact episode.
 */
async function resolveEpisode(
    api: JellyfinApi,
    item: WatchSyncResolveItem,
): Promise<string | null> {
    const { seriesTmdbId, tmdbId, imdbId, seasonNumber, episodeNumber } = item;

    if (seasonNumber == null || episodeNumber == null) return null;

    // Use seriesTmdbId when available (preferred — it's always the series ID)
    const seriesLookupId = seriesTmdbId ?? tmdbId;

    if (!seriesLookupId) {
        if (imdbId) return resolveByImdb(api, imdbId, 'Episode');
        return null;
    }

    // Resolve the parent series to a Jellyfin series ID
    const seriesId = await resolveMovieOrSeries(api, seriesLookupId, 'Series');
    if (!seriesId) {
        if (imdbId) return resolveByImdb(api, imdbId, 'Episode');
        return null;
    }

    // Fetch episodes for the season and find the matching episode by IndexNumber
    try {
        const response = await api.axiosInstance.get<JellyfinItemsResponse>(
            joinUpstreamUrl(api.basePath, `/Shows/${encodePathSegment(seriesId)}/Episodes`),
            {
                ...authHeaders(api.accessToken),
                params: {
                    Season: seasonNumber,
                    Fields: 'ProviderIds',
                },
            },
        );
        const episodes = response.data.Items ?? [];
        const match = episodes.find((ep) => ep.IndexNumber === episodeNumber);
        return match?.Id ?? null;
    } catch (err) {
        // 404 = the series has no such episode list → null. A transient error
        // (5xx / timeout / network) must reject so the item is retried, not
        // silently treated as absent.
        if (isNotFoundError(err)) return null;
        throw err;
    }
}

// =============================================================================
// Pull helpers
// =============================================================================

const TICKS_PER_MS = 10_000;
const PAGE_SIZE = 200;
const SERIES_CONCURRENCY = 5;

/**
 * Position-fraction ceiling (of `RunTimeTicks`) above which a PAUSED active
 * session is treated as "left open after natural completion" rather than a
 * genuine rewatch — see the merge guard in `pullForUser` below.
 */
const PAUSED_NEAR_END_FRACTION = 0.9;

function ticksToMs(ticks: number | undefined | null): number {
    if (!ticks || ticks < 0) return 0;
    return Math.floor(ticks / TICKS_PER_MS);
}

/**
 * Merge shared axios options (auth header, optional abort signal) into the
 * per-request config. Centralised so every request path picks up new wiring
 * (signal, timeouts, etc.) without visual drift.
 */
function requestOptions(
    api: JellyfinApi,
    signal?: AbortSignal,
    extra?: Record<string, unknown>,
): Record<string, unknown> {
    return {
        ...authHeaders(api.accessToken),
        ...(signal ? { signal } : {}),
        ...(extra ?? {}),
    };
}

/**
 * Known limitation (S1 — pull-side deletion propagation):
 *
 * This function uses Jellyfin's `filters=IsPlayed` query, so items the user
 * UNWATCHED on Jellyfin after they were imported do NOT appear in the result
 * set. The pull cycle therefore never downgrades Lumastra's `is_watched=true`
 * back to `false` when the provider no longer reports the item.
 *
 * A bounded reconciliation pass (re-fetching the last N rows with
 * `synced_from_provider='jellyfin' AND is_watched=true` and checking
 * `UserData.Played===false`) is the correct fix, but it's scoped to a future
 * wave to keep this diff focused on write-side correctness. Users who rely on
 * Jellyfin unwatch as the source of truth should mark unwatched in Lumastra
 * until that reconciliation pass ships.
 */
/**
 * Whether a Jellyfin `LastPlayedDate` is at or after the pull cursor.
 *
 * Compares INSTANTS, not strings. Jellyfin serialises .NET ticks — seven fractional
 * digits ("...T19:12:49.1234567Z") — while the cursor comes from Date#toISOString(),
 * which has three ("...T19:12:49.123Z"). A lexicographic `played > since` therefore
 * compares the item's fourth fraction digit against the cursor's 'Z', and every digit
 * sorts below 'Z' — so an item played LATER within the same millisecond reads as
 * older. At the call site that item is not merely dropped: it also ends the paged
 * walk, so the rest of that page and every later page go with it.
 *
 * Boundary items (equal once truncated to milliseconds) are ADMITTED rather than
 * excluded. The import is idempotent, so re-admitting the previous cycle's newest item
 * costs one redundant upsert, whereas excluding it risks permanently losing a real play
 * that landed in that same millisecond. Same conservative bias as items with no date.
 *
 * An unparseable date on either side admits the item, for the same reason: never let a
 * malformed value silently truncate the walk.
 */
export function isAtOrAfterCursor(played: string, since: string): boolean {
    const playedMs = Date.parse(played);
    const sinceMs = Date.parse(since);
    if (Number.isNaN(playedMs) || Number.isNaN(sinceMs)) return true;
    return playedMs >= sinceMs;
}

/**
 * What an incremental pull should do with one item, given the cursor.
 *
 *  - `take` — at or newer than the cursor; import it.
 *  - `skip` — no LastPlayedDate; ignore it, but keep walking.
 *  - `stop` — older than the cursor. Items are sorted DESC, so everything after
 *    it is older too: end the paged walk.
 *
 * Exported so the rule is testable — the walk it drives is a private pager, and a
 * rule that lives only inside a loop is a rule nothing can check.
 */
export function classifyPulledItem(
    played: string | undefined | null,
    since: string,
): 'take' | 'skip' | 'stop' {
    if (!played) return 'skip';
    return isAtOrAfterCursor(played, since) ? 'take' : 'stop';
}

/**
 * What the last complete walk of one account's played list (per item type) saw.
 *
 * The cursor is a LastPlayedDate. Marking a title played in Jellyfin keeps its
 * earlier LastPlayedDate, and a title that is already behind the cursor is never
 * reached by the incremental walk, so the new flag was lost for good (day-1 test
 * 2026-10-31: a film marked played stayed unplayed here). The number of played
 * titles does change, so a changed count - or an hour without a complete walk, or
 * a process that has not walked yet - widens the next walk to the whole list.
 *
 * Kept in memory on purpose: a restart or a second worker only costs an extra full
 * walk, never a missed one, and nothing here has to survive a failed import.
 */
const playedWalks = new Map<string, { total: number; fullAt: number }>();
/** Jellyfin account id by lower-cased login name, for forgetting walks of failed imports. */
const walkAccounts = new Map<string, string>();

function forgetPlayedWalks(userId: string): void {
    for (const key of [...playedWalks.keys()])
        if (key.startsWith(`${userId}:`)) playedWalks.delete(key);
}
const FULL_WALK_INTERVAL_MS = 60 * 60 * 1000;

async function fetchAllPlayedItems(
    api: JellyfinApi,
    userId: string,
    itemType: 'Movie' | 'Episode',
    extraFields: string | undefined,
    signal: AbortSignal | undefined,
    /**
     * ISO timestamp of the newest item we've already imported for this
     * user. When set, pagination short-circuits as soon as we hit an
     * item with `LastPlayedDate <= since`, since the result is sorted
     * DESC by DatePlayed. Pulls older than this cursor have already
     * been ingested.
     */
    since: string | null,
): Promise<JellyfinPullItem[]> {
    const allItems: JellyfinPullItem[] = [];
    let startIndex = 0;
    // Whether the cursor may end the walk. Decided on the first page, which
    // carries the played total.
    let useCursor = since !== null;
    let playedTotal = 0;
    const walkKey = `${userId}:${itemType}`;

    pages: while (true) {
        if (signal?.aborted) {
            throw signal.reason ?? new DOMException('Aborted', 'AbortError');
        }
        const fields = `UserData,ProviderIds,RunTimeTicks${extraFields ? ',' + extraFields : ''}`;
        const resp = await withJellyfinRetry(
            () =>
                api.axiosInstance.get<JellyfinPullItemsResponse>(
                    joinUpstreamUrl(api.basePath, `/Users/${encodePathSegment(userId)}/Items`),
                    requestOptions(api, signal, {
                        params: {
                            includeItemTypes: itemType,
                            recursive: true,
                            fields,
                            filters: 'IsPlayed',
                            startIndex,
                            limit: PAGE_SIZE,
                            sortBy: 'DatePlayed',
                            sortOrder: 'Descending',
                        },
                    }),
                ),
            { signal },
        );

        const items = resp.data?.Items ?? [];

        if (startIndex === 0) {
            playedTotal = resp.data?.TotalRecordCount ?? 0;
            const last = playedWalks.get(walkKey);
            if (
                useCursor &&
                (!last ||
                    last.total !== playedTotal ||
                    Date.now() - last.fullAt > FULL_WALK_INTERVAL_MS)
            )
                useCursor = false;
        }

        if (since && useCursor) {
            // Items are sorted DESC by LastPlayedDate. Walk forwards and collect
            // anything at-or-newer than the cursor; break out entirely as soon as we
            // see one below it.
            //
            // Items with NO LastPlayedDate are SKIPPED on an incremental pull. They
            // used to be admitted unconditionally, on the reasoning that
            // re-processing beats silently dropping. The cost of that was not
            // theoretical: Jellyfin sorts the undated block FIRST, so every cycle
            // walked it and re-admitted the same items forever — 818 of them per
            // pull on prod, 12 pulls an hour, ~9,800 items/hour, flat overnight with
            // nobody watching. They produced ZERO watch_history writes in an hour,
            // which is the measurement that settles it: they were already imported
            // and carried nothing new.
            //
            // The reasoning is not just empirical. `since` is a LastPlayedDate
            // cursor, so on an incremental pull an item with no LastPlayedDate at all
            // carries no evidence of a play newer than the cursor — there is nothing
            // for it to be newer THAN. The full pull below (`since` null) still takes
            // every undated item, so they are imported once and are never dropped;
            // clearing the cursor re-imports them.
            for (const item of items) {
                const verdict = classifyPulledItem(item.UserData?.LastPlayedDate, since);
                if (verdict === 'take') allItems.push(item);
                else if (verdict === 'stop') break pages;
            }
            // Whole page admitted — keep paging until we cross the cursor
            // or hit the end.
        } else {
            allItems.push(...items);
        }

        const total = resp.data?.TotalRecordCount ?? 0;
        if (items.length < PAGE_SIZE || allItems.length >= total) {
            break;
        }
        startIndex += PAGE_SIZE;
    }

    if (useCursor) {
        const last = playedWalks.get(walkKey);
        if (last) playedWalks.set(walkKey, { ...last, total: playedTotal });
    } else {
        playedWalks.set(walkKey, { total: playedTotal, fullAt: Date.now() });
    }
    return allItems;
}

async function buildSeriesTmdbMap(
    api: JellyfinApi,
    userId: string,
    episodes: JellyfinPullItem[],
    logger: PluginContext['logger'],
    signal?: AbortSignal,
): Promise<Map<string, string>> {
    const seriesTmdbMap = new Map<string, string>();
    const seriesIds = new Set<string>();

    for (const ep of episodes) {
        if (ep.SeriesId) seriesIds.add(ep.SeriesId);
    }

    const seriesIdArray = [...seriesIds];
    let genuineErrors = 0;
    let firstError: unknown;
    for (let i = 0; i < seriesIdArray.length; i += SERIES_CONCURRENCY) {
        if (signal?.aborted) break;
        const chunk = seriesIdArray.slice(i, i + SERIES_CONCURRENCY);
        await Promise.allSettled(
            chunk.map(async (sid) => {
                try {
                    const resp = await api.axiosInstance.get<{
                        ProviderIds?: { Tmdb?: string };
                    }>(
                        joinUpstreamUrl(
                            api.basePath,
                            `/Users/${encodePathSegment(userId)}/Items/${encodePathSegment(sid)}`,
                        ),
                        requestOptions(api, signal, {
                            params: { fields: 'ProviderIds' },
                        }),
                    );
                    const tmdb = resp.data?.ProviderIds?.Tmdb;
                    if (tmdb) seriesTmdbMap.set(sid, tmdb);
                } catch (err) {
                    // 404 = series genuinely gone → skip silently. A genuine
                    // error (5xx / timeout / network) must NOT be swallowed as
                    // "not found": rethrow so allSettled records it, then
                    // surface the count so an operator can see that some
                    // episodes are missing their series TMDB id because of a
                    // transport failure, not because the series was deleted.
                    if (isNotFoundError(err)) return;
                    throw err;
                }
            }),
        ).then((results) => {
            for (const r of results) {
                if (r.status === 'rejected') {
                    genuineErrors++;
                    if (firstError === undefined) firstError = r.reason;
                }
            }
        });
    }

    if (genuineErrors > 0) {
        logger.warn('buildSeriesTmdbMap: some series TMDB lookups failed (transport error)', {
            genuineErrors,
            totalSeries: seriesIdArray.length,
            firstError: firstError instanceof Error ? firstError.message : String(firstError),
        });
    }

    // Total outage guard: if EVERY series lookup failed with a genuine transport
    // error (not a 404, which is swallowed as benign), the pull would otherwise
    // "succeed" with zero episodes resolved — hiding the outage. Throw a transient
    // TaskError so the run surfaces the failure and retries. Partial success
    // (some series resolved) stays success — only the total-failure case throws.
    if (genuineErrors === seriesIdArray.length && seriesIdArray.length > 0) {
        throw new TaskError({
            message:
                `jellyfin pull: every series TMDB lookup failed (${genuineErrors}/` +
                `${seriesIdArray.length}) — treating as a transient Jellyfin outage.`,
            kind: 'transient',
        });
    }

    return seriesTmdbMap;
}

/**
 * Parse Jellyfin's ISO 8601 LastPlayedDate into a Date. Returns null for
 * missing / unparseable values so the DB can fall back to NOW().
 */
function parseLastPlayed(raw: string | undefined | null): Date | null {
    if (!raw) return null;
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function pullItemFromMovie(item: JellyfinPullItem, providerUsername: string): WatchStatePullItem {
    const lastWatchedAt = parseLastPlayed(item.UserData?.LastPlayedDate);
    return {
        providerId: guidId(item.Id),
        tmdbId: item.ProviderIds?.Tmdb ?? null,
        imdbId: item.ProviderIds?.Imdb ?? null,
        mediaType: 'movie',
        isWatched: item.UserData?.Played ?? true,
        resumePositionMs: ticksToMs(item.UserData?.PlaybackPositionTicks),
        runtimeMs: ticksToMs(item.RunTimeTicks),
        watchCount: item.UserData?.PlayCount ?? 1,
        providerUsername,
        title: item.Name,
        lastWatchedAt,
        // Jellyfin doesn't expose "first played" separately — mirror last played
        // and let the DB-side LEAST() keep the earliest value already stored.
        firstWatchedAt: lastWatchedAt,
    };
}

function pullItemFromEpisode(
    item: JellyfinPullItem,
    seriesTmdbMap: Map<string, string>,
    providerUsername: string,
    defaultIsWatched: boolean,
): WatchStatePullItem {
    const seriesTmdbId =
        item.SeriesProviderIds?.Tmdb ??
        (item.SeriesId ? seriesTmdbMap.get(item.SeriesId) : undefined);
    const lastWatchedAt = parseLastPlayed(item.UserData?.LastPlayedDate);
    return {
        providerId: guidId(item.Id),
        // Jellyfin may expose an episode-level TMDB ID — keep it so Strategy 1
        // (TMDB composite resolution) can fast-path resolve this row.
        tmdbId: item.ProviderIds?.Tmdb ?? null,
        imdbId: item.ProviderIds?.Imdb ?? null,
        mediaType: 'episode',
        isWatched: item.UserData?.Played ?? defaultIsWatched,
        resumePositionMs: ticksToMs(item.UserData?.PlaybackPositionTicks),
        runtimeMs: ticksToMs(item.RunTimeTicks),
        watchCount: item.UserData?.PlayCount ?? (defaultIsWatched ? 1 : 0),
        providerUsername,
        seasonNumber: item.ParentIndexNumber,
        episodeNumber: item.IndexNumber,
        seriesTmdbId,
        title: item.Name,
        seriesTitle: item.SeriesName,
        lastWatchedAt,
        firstWatchedAt: lastWatchedAt,
    };
}

async function fetchActiveSessions(
    api: JellyfinApi,
    signal?: AbortSignal,
): Promise<JellyfinSession[]> {
    const response = await withJellyfinRetry(
        () =>
            api.axiosInstance.get<JellyfinSession[]>(
                joinUpstreamUrl(api.basePath, `/Sessions`),
                requestOptions(api, signal, {
                    params: {
                        activeWithinSeconds: 3600,
                    },
                }),
            ),
        { signal },
    );

    return Array.isArray(response.data) ? response.data : [];
}

function groupSessionsByUser(sessions: JellyfinSession[]): Map<string, JellyfinSession[]> {
    const grouped = new Map<string, JellyfinSession[]>();

    for (const session of sessions) {
        const keys = new Set<string>();
        if (session.UserId) keys.add(`id:${session.UserId}`);
        if (session.UserName) keys.add(`name:${session.UserName.toLowerCase()}`);

        for (const key of keys) {
            const existing = grouped.get(key) ?? [];
            existing.push(session);
            grouped.set(key, existing);
        }
    }

    return grouped;
}

function getSessionsForUser(
    sessionsByUser: Map<string, JellyfinSession[]>,
    userId: string,
    providerUsername: string,
): JellyfinSession[] {
    const unique = new Map<string, JellyfinSession>();

    for (const session of sessionsByUser.get(`id:${userId}`) ?? []) {
        unique.set(session.Id, session);
    }

    for (const session of sessionsByUser.get(`name:${providerUsername.toLowerCase()}`) ?? []) {
        unique.set(session.Id, session);
    }

    return [...unique.values()];
}

function pullItemFromSession(
    session: JellyfinSession,
    seriesTmdbMap: Map<string, string>,
    providerUsername: string,
): WatchStatePullItem | null {
    const nowPlayingItem = session.NowPlayingItem as JellyfinPullItem | undefined;
    const positionTicks = session.PlayState?.PositionTicks ?? 0;

    if (!nowPlayingItem?.Id || !nowPlayingItem.Type || positionTicks <= 0) {
        return null;
    }

    // eslint-disable-next-line callback-safety/no-bare-media-type-comparison -- Jellyfin's NowPlayingItem.Type uses its PascalCase vocabulary.
    if (nowPlayingItem.Type === 'Movie') {
        return {
            providerId: guidId(nowPlayingItem.Id),
            tmdbId: nowPlayingItem.ProviderIds?.Tmdb ?? null,
            imdbId: nowPlayingItem.ProviderIds?.Imdb ?? null,
            mediaType: 'movie',
            // Treat active provider playback as the current truth, even if
            // Jellyfin still reports the underlying item as played=true.
            isWatched: false,
            resumePositionMs: ticksToMs(positionTicks),
            runtimeMs: ticksToMs(nowPlayingItem.RunTimeTicks),
            watchCount: nowPlayingItem.UserData?.PlayCount ?? 1,
            providerUsername,
            title: nowPlayingItem.Name,
            lastWatchedAt: parseLastPlayed(nowPlayingItem.UserData?.LastPlayedDate),
            firstWatchedAt: parseLastPlayed(nowPlayingItem.UserData?.LastPlayedDate),
            isActiveSession: true,
        };
    }

    // eslint-disable-next-line callback-safety/no-bare-media-type-comparison -- Jellyfin's NowPlayingItem.Type uses its PascalCase vocabulary.
    if (nowPlayingItem.Type === 'Episode') {
        return {
            ...pullItemFromEpisode(nowPlayingItem, seriesTmdbMap, providerUsername, false),
            isWatched: false,
            resumePositionMs: ticksToMs(positionTicks),
            watchCount: nowPlayingItem.UserData?.PlayCount ?? 1,
            isActiveSession: true,
        };
    }

    return null;
}

async function pullForUser(
    ctx: PluginContext,
    api: JellyfinApi,
    user: JellyfinUserRow,
    result: WatchSyncPullResult,
    signal: AbortSignal | undefined,
    /**
     * Cursor map keyed by lumastra username (lowercase, matches
     * `watch_state_pull_log.user_id`). The plugin lowercases its
     * Jellyfin-side `Name` before lookup; we emit `newCursors` keyed
     * by the original-case `providerUsername` because the engine
     * reads `newCursors.get(providerUsername)` after the fact.
     */
    cursors: Map<string, string>,
    sessionsByUser: Map<string, JellyfinSession[]>,
): Promise<void> {
    const { Id: userId, Name: providerUsername } = user;
    walkAccounts.set(providerUsername.toLowerCase(), userId);
    const since = cursors.get(providerUsername.toLowerCase()) ?? null;
    // Set by ANY failed fetch below. The cursor must not advance past a window we
    // failed to read: each fetch is caught independently and execution continues,
    // so movies failing while episodes succeed would otherwise move the cursor to
    // the newest EPISODE date — putting the unread movie plays permanently behind
    // it. Re-import is idempotent, but only for items the next pull still asks
    // for, and it would never ask for those again.
    //
    // This was inert while the cursor map was mis-keyed (since was always null, so
    // every pull was full and nothing could fall behind). Fixing the key space is
    // exactly what arms it, so the two changes belong together.
    let fetchFailed = false;

    // Fetch played movies (paginated, short-circuit at cursor)
    let playedMovies: JellyfinPullItem[] = [];
    try {
        playedMovies = await fetchAllPlayedItems(api, userId, 'Movie', undefined, signal, since);
    } catch (err) {
        ctx.logger.warn('Failed to fetch played movies for Jellyfin user', {
            userId,
            error: String(err),
        });
        fetchFailed = true;
        result.errors.push(`Failed to fetch movies for user ${providerUsername}: ${String(err)}`);
    }

    if (signal?.aborted) return;

    // Fetch played episodes (paginated, short-circuit at cursor) with series/season/episode fields
    let playedEpisodes: JellyfinPullItem[] = [];
    try {
        playedEpisodes = await fetchAllPlayedItems(
            api,
            userId,
            'Episode',
            'SeriesId,ParentIndexNumber,IndexNumber',
            signal,
            since,
        );
    } catch (err) {
        ctx.logger.warn('Failed to fetch played episodes for Jellyfin user', {
            userId,
            error: String(err),
        });
        fetchFailed = true;
        result.errors.push(`Failed to fetch episodes for user ${providerUsername}: ${String(err)}`);
    }

    if (signal?.aborted) return;

    // Fetch resume items (in-progress, not fully watched) — no pagination needed
    let resumeItems: JellyfinPullItem[] = [];
    try {
        const resumeResp = await withJellyfinRetry(
            () =>
                api.axiosInstance.get<JellyfinPullItemsResponse>(
                    joinUpstreamUrl(
                        api.basePath,
                        `/Users/${encodePathSegment(userId)}/Items/Resume`,
                    ),
                    requestOptions(api, signal, {
                        params: {
                            includeItemTypes: 'Movie,Episode',
                            fields: 'UserData,ProviderIds,RunTimeTicks,SeriesId,ParentIndexNumber,IndexNumber',
                            limit: 100,
                        },
                    }),
                ),
            { signal },
        );
        resumeItems = resumeResp.data?.Items ?? [];
    } catch (err) {
        ctx.logger.warn('Failed to fetch resume items for Jellyfin user', {
            userId,
            error: String(err),
        });
        fetchFailed = true;
        result.errors.push(
            `Failed to fetch resume items for user ${providerUsername}: ${String(err)}`,
        );
    }

    if (signal?.aborted) return;

    const activeSessions = getSessionsForUser(sessionsByUser, userId, providerUsername);

    // Resolve series TMDB IDs for all episodes in one batch
    const allEpisodes = [
        ...playedEpisodes,
        // eslint-disable-next-line callback-safety/no-bare-media-type-comparison -- Jellyfin's resume item Type uses its PascalCase vocabulary.
        ...resumeItems.filter((i) => i.Type === 'Episode'),
        ...activeSessions
            .map((session) => session.NowPlayingItem as JellyfinPullItem | undefined)
            // eslint-disable-next-line callback-safety/no-bare-media-type-comparison -- Jellyfin's session item Type uses its PascalCase vocabulary.
            .filter((item): item is JellyfinPullItem => item?.Type === 'Episode'),
    ];
    const seriesTmdbMap = await buildSeriesTmdbMap(api, userId, allEpisodes, ctx.logger, signal);

    // Deduplicate: resume data takes priority (has position), keyed by Jellyfin item ID
    const seen = new Map<string, WatchStatePullItem>();

    for (const item of playedMovies) {
        seen.set(item.Id, pullItemFromMovie(item, providerUsername));
    }

    for (const item of playedEpisodes) {
        seen.set(item.Id, pullItemFromEpisode(item, seriesTmdbMap, providerUsername, true));
    }

    // Resume items add position data for in-progress items only.
    // Don't overwrite items already marked as watched — an item can appear in
    // both the played list (isWatched: true) and resume list (with a position
    // near the end). The played status should win.
    for (const item of resumeItems) {
        const existing = seen.get(item.Id);
        if (existing?.isWatched) continue; // Already marked watched — don't downgrade

        // eslint-disable-next-line callback-safety/no-bare-media-type-comparison -- Jellyfin's resume item Type uses its PascalCase vocabulary.
        if (item.Type === 'Movie') {
            seen.set(item.Id, pullItemFromMovie(item, providerUsername));
            // eslint-disable-next-line callback-safety/no-bare-media-type-comparison -- Jellyfin's resume item Type uses its PascalCase vocabulary.
        } else if (item.Type === 'Episode') {
            seen.set(item.Id, pullItemFromEpisode(item, seriesTmdbMap, providerUsername, false));
        }
    }

    // Jellyfin does not reliably expose rewatches via /Items/Resume. Active
    // /Sessions are authoritative for "what the user is currently watching",
    // so let them override both stale resume rows and played=true rows.
    //
    // Known false-positive shape (guarded below): a session left open after
    // natural completion — paused near the end, autoplay stopped, client
    // idle — still counts as "active" for up to `activeWithinSeconds: 3600`
    // in `fetchActiveSessions`. Without a guard, that session's
    // `isWatched: false` (see `pullItemFromSession`, which always reports
    // an active session as unwatched) would transiently flip an
    // already-`isWatched: true` row back to unwatched until the session
    // ages out — a visible "unwatched" flicker on something the user
    // finished.
    //
    // The session payload (`JellyfinSession.PlayState`, see
    // jellyfin.types.ts) carries `IsPaused: boolean` and `PositionTicks`;
    // `NowPlayingItem.RunTimeTicks` gives total duration. Together that's
    // enough to compute a position fraction and tell "paused right before
    // the credits" apart from "just started a genuine rewatch" — a
    // just-opened session at position 0 is excluded before we even get
    // here (`pullItemFromSession` returns null for `positionTicks <= 0`),
    // so every `pullItem` reaching this loop already has a positive
    // position.
    //
    // The guard is intentionally NARROW: it only withholds the override
    // when the session is PAUSED *and* sitting at >= 90% of runtime — the
    // exact shape described above. A PLAYING session past 90% is still
    // being actively watched in real time (not a stale leftover) and keeps
    // overriding, as does a PAUSED session below 90% (a plausible
    // rewatch-in-progress paused partway through), and a session with no
    // usable `RunTimeTicks` (fraction can't be computed — we don't guess,
    // so it falls through to the pre-existing override behavior). This
    // preserves the rewatch-detection contract everywhere except the one
    // documented false-revert case.
    for (const session of activeSessions) {
        const pullItem = pullItemFromSession(session, seriesTmdbMap, providerUsername);
        if (!pullItem) continue;

        const existing = seen.get(pullItem.providerId);
        if (
            existing &&
            existing.resumePositionMs >= pullItem.resumePositionMs &&
            existing.isWatched === false
        ) {
            continue;
        }

        if (existing?.isWatched === true) {
            const isPaused = session.PlayState?.IsPaused === true;
            const runtimeMs = pullItem.runtimeMs;
            const positionFraction = runtimeMs > 0 ? pullItem.resumePositionMs / runtimeMs : null;
            if (
                isPaused &&
                positionFraction !== null &&
                positionFraction >= PAUSED_NEAR_END_FRACTION
            ) {
                continue; // paused-near-end: keep the existing watched=true row
            }
        }

        seen.set(pullItem.providerId, pullItem);
    }

    result.items.push(...seen.values());

    // Advance the per-user cursor to the newest LastPlayedDate observed
    // in this batch. We compute over `seen.values()` so resume items
    // (which carry a LastPlayedDate from when the in-progress session
    // last touched them) also count.
    //
    // Monotonicity guard: only advance, never regress. Resume items
    // can carry a LastPlayedDate older than the existing cursor (a
    // user has been resuming a single movie for weeks while watching
    // newer things) — emitting that older date would silently rewind
    // the cursor and force the next cycle to re-fetch everything in
    // the gap. If `newest` doesn't strictly exceed `since`, we omit
    // newCursors entirely; the engine's COALESCE then keeps the
    // existing cursor.
    let newest: string | null = null;
    for (const it of seen.values()) {
        const ts = it.lastWatchedAt?.toISOString() ?? null;
        if (ts && (newest === null || ts > newest)) newest = ts;
    }
    if (fetchFailed) {
        // Hold the cursor: next cycle re-reads this window rather than skipping it.
        ctx.logger.warn('Holding watch-sync cursor — a fetch failed for this user', {
            providerUsername,
        });
    } else if (newest && result.newCursors && (since === null || newest > since)) {
        result.newCursors.set(providerUsername, newest);
    }
}

// =============================================================================
// Plugin definition (SDK)
// =============================================================================

export const jellyfinWatchSync: WatchSyncDefinition = defineWatchSync(
    {
        id: 'jellyfin-watch-sync',
        name: 'Jellyfin Watch Sync',
        version: '1.0.0',
        providerName: 'jellyfin',
        capabilities: { database: true, http: true },

        // -----------------------------------------------------------------
        // isAvailable
        //
        // The legacy plugin had a separate `isEnabled()` flag gated on
        // `features.jellyfinSync`. The new SDK has no per-plugin enabled
        // flag — the engine consults `isAvailable(ctx)` instead. We fold
        // the feature gate into the availability probe so a disabled
        // FEATURE_JELLYFIN_SYNC short-circuits push and pull just like
        // before.
        // -----------------------------------------------------------------
        async isAvailable(_ctx: PluginContext): Promise<boolean> {
            if (!features.jellyfinSync) return false;
            if (!circuitBreaker.shouldAllowRequest()) return false;
            const api = await getJellyfinApi();
            return api !== null;
        },

        pullImportFailed(_ctx: PluginContext, providerUsernames: string[]): void {
            // The walk read the list, but the engine could not import it: the next pull
            // must read the whole list again, not trust the cursor.
            for (const name of providerUsernames) {
                const userId = walkAccounts.get(name.toLowerCase());
                if (userId) forgetPlayedWalks(userId);
            }
        },

        async listLinkedUsers(ctx: PluginContext): Promise<string[]> {
            const api = await getJellyfinApi();
            if (!api) return [];
            const response = await withJellyfinRetry(
                () =>
                    api.axiosInstance.get<
                        Array<{
                            Id: string;
                            Name: string;
                            Policy?: { IsDisabled?: boolean };
                        }>
                    >(joinUpstreamUrl(api.basePath, `/Users`), {
                        ...authHeaders(api.accessToken),
                        signal: ctx.signal,
                    }),
                { signal: ctx.signal },
            );
            if (!Array.isArray(response.data)) throw new Error('Invalid Jellyfin users response');
            const { getLinkedJellyfinUsers } =
                await import('$lib/server/database/queries/jellyfin-file-pairing.queries.js');
            return getLinkedJellyfinUsers(
                ctx.sql,
                response.data.filter((user) => !user.Policy?.IsDisabled),
            );
        },

        // -----------------------------------------------------------------
        // resolveIds
        // -----------------------------------------------------------------
        async resolveIds(
            ctx: PluginContext,
            items: WatchSyncResolveItem[],
        ): Promise<WatchSyncResolvedId[]> {
            const api = await getJellyfinApi();
            if (!api) {
                return [];
            }

            // Process in chunks of 5 concurrent requests
            const RESOLVE_CONCURRENCY = 5;
            const resolved: WatchSyncResolvedId[] = [];
            // Accumulate rejections across ALL chunks — decided once after the
            // loop so an early rejection never discards later-resolved items.
            let rejectedCount = 0;
            let firstRejection: unknown;

            for (let i = 0; i < items.length; i += RESOLVE_CONCURRENCY) {
                const chunk = items.slice(i, i + RESOLVE_CONCURRENCY);
                const results = await Promise.allSettled(
                    chunk.map(async (item): Promise<WatchSyncResolvedId | null> => {
                        let providerId: string | null = null;

                        if (isEpisode(item.mediaType)) {
                            providerId = await resolveEpisode(api, item);
                        } else if (isMovie(item.mediaType)) {
                            if (item.tmdbId) {
                                providerId = await resolveMovieOrSeries(api, item.tmdbId, 'Movie');
                            }
                            if (!providerId && item.imdbId) {
                                providerId = await resolveByImdb(api, item.imdbId, 'Movie');
                            }
                        } else {
                            // tv / series
                            if (item.tmdbId) {
                                providerId = await resolveMovieOrSeries(api, item.tmdbId, 'Series');
                            }
                            if (!providerId && item.imdbId) {
                                providerId = await resolveByImdb(api, item.imdbId, 'Series');
                            }
                        }

                        if (!providerId) return null;
                        return { mediaId: item.mediaId, providerId };
                    }),
                );
                for (const result of results) {
                    if (result.status === 'fulfilled' && result.value) {
                        resolved.push(result.value);
                    } else if (result.status === 'rejected') {
                        rejectedCount++;
                        if (firstRejection === undefined) firstRejection = result.reason;
                    }
                }
                // Do NOT abort the whole page on the first rejection here. The old
                // code threw immediately, which discarded every item already
                // resolved in prior chunks AND aborted the run. Combined with the
                // circuit breaker excluding 4xx, a single deterministic 401/403
                // (revoked key) then re-threw on every cycle forever — head-of-
                // line-blocking ALL items. Instead, isolate per-item failures:
                // keep resolving remaining chunks and decide once, below.
            }

            // A rejected item means a GENUINE transport error (the helpers return
            // null for a real 404, which is `fulfilled` and never lands here).
            if (rejectedCount > 0) {
                const breakerOpen = circuitBreaker.getState().isOpen;
                ctx.logger.warn('resolveIds: some items failed to resolve (transport error)', {
                    rejectedCount,
                    resolvedCount: resolved.length,
                    totalItems: items.length,
                    breakerOpen,
                    firstRejection:
                        firstRejection instanceof Error
                            ? firstRejection.message
                            : String(firstRejection),
                });

                // Provider-wide outage: sustained 5xx/401/403 tripped the breaker
                // (401/403 now count — see base-client.ts). Abort the page by
                // throwing so the engine does NOT terminally drain the still-
                // unresolved backlog as "provider doesn't have them". isAvailable()
                // returns false next cycle, so the provider backs off cleanly and
                // the queued events are preserved for retry once the key is fixed.
                if (breakerOpen) {
                    throw firstRejection instanceof Error
                        ? firstRejection
                        : new Error(String(firstRejection));
                }

                // Otherwise: isolated per-item failures (e.g. a poison item that
                // deterministically errors while the breaker stays closed). Return
                // the items that DID resolve; the engine drains the unresolved ones
                // so one bad item can't head-of-line-block the rest of the queue.
                // Genuine transient errors on the OTHER items still surfaced above
                // and those items resolved fine when their request succeeded.
            }

            return resolved;
        },

        // -----------------------------------------------------------------
        // pushWatchState
        // -----------------------------------------------------------------
        async pushWatchState(
            ctx: PluginContext,
            items: WatchStateChange[],
            signal?: AbortSignal,
        ): Promise<WatchSyncPushResult> {
            const batchResult: WatchSyncPushResult = {
                succeeded: 0,
                failed: 0,
                skipped: 0,
                staleIds: [],
                errors: [],
                successful: [],
                drainedAsSkipped: [],
                failedItems: [],
            };

            const api = await getJellyfinApi();
            if (!api) {
                // Transient: Jellyfin may come back next cycle. Report as
                // failed so the engine leaves the events queued for retry.
                batchResult.failed = items.length;
                batchResult.errors.push('Jellyfin client not available');
                return batchResult;
            }

            // Group items by username and resolve Jellyfin user IDs
            const byUsername = new Map<string, WatchStateChange[]>();
            for (const item of items) {
                const existing = byUsername.get(item.username) ?? [];
                existing.push(item);
                byUsername.set(item.username, existing);
            }

            for (const [username, userItems] of byUsername) {
                if (signal?.aborted) break;
                // The map key (`WatchStateChange.username`) carries the
                // user_media_events.user_id UUID, not a login name — the SDK
                // field name is kept for cross-package compat; convert here.
                const jellyfinUserId = await resolveJellyfinUserIdByUserId(toUserId(username));
                if (!jellyfinUserId) {
                    batchResult.failed += userItems.length;
                    const reason = `No Jellyfin user ID for user: ${username}; retained for retry`;
                    batchResult.errors.push(reason);
                    for (const item of userItems) {
                        batchResult.failedItems!.push({
                            username: item.username,
                            mediaId: item.mediaId,
                            error: reason,
                            terminal: false,
                        });
                    }
                    continue;
                }

                for (const item of userItems) {
                    if (signal?.aborted) break;
                    if (!isSafePathSegment(item.providerId)) {
                        // Unusable id: it can never succeed, so drain this one
                        // item as skipped instead of retrying it every cycle.
                        batchResult.staleIds.push(item.providerId);
                        batchResult.drainedAsSkipped.push({
                            username: item.username,
                            mediaId: item.mediaId,
                        });
                        batchResult.skipped++;
                        const reason = `Invalid Jellyfin item id: ${item.providerId}`;
                        batchResult.errors.push(`${item.username}/${item.mediaId}: ${reason}`);
                        batchResult.failedItems!.push({
                            username: item.username,
                            mediaId: item.mediaId,
                            error: reason,
                            terminal: true,
                        });
                        continue;
                    }
                    try {
                        if (item.isWatched) {
                            // Mark as watched (sets Played=true on Jellyfin)
                            await api.axiosInstance.post(
                                joinUpstreamUrl(
                                    api.basePath,
                                    `/Users/${encodePathSegment(jellyfinUserId)}/PlayedItems/${encodePathSegment(item.providerId)}`,
                                ),
                                undefined,
                                requestOptions(api, signal),
                            );
                            // Best-effort: PlayedItems sets Played=true but does
                            // NOT reset PlaybackPositionTicks. Jellyfin's Resume
                            // ("Continue Watching") rail keys off position > 0
                            // independently of the Played flag, so a stale resume
                            // position keeps a watched item in Continue Watching
                            // with a progress bar. Zero it out — mirrors the
                            // unwatched companion write below and the inbound
                            // /j/UserPlayedItems compat handler. Non-fatal: the
                            // mark-played above already succeeded and defines the
                            // watched-state contract; log non-404 failures only.
                            await writeUserData(
                                api,
                                jellyfinUserId,
                                item.providerId,
                                0,
                                signal,
                            ).catch((posErr: unknown) => {
                                const status = (posErr as { response?: { status?: number } })
                                    ?.response?.status;
                                if (status !== 404) {
                                    ctx.logger.debug(
                                        'pushWatchState: failed to clear resume position after mark-watched',
                                        {
                                            username: item.username,
                                            mediaId: item.mediaId,
                                            error:
                                                posErr instanceof Error
                                                    ? posErr.message
                                                    : String(posErr),
                                        },
                                    );
                                }
                            });
                        } else {
                            await api.axiosInstance.delete(
                                joinUpstreamUrl(
                                    api.basePath,
                                    `/Users/${encodePathSegment(jellyfinUserId)}/PlayedItems/${encodePathSegment(item.providerId)}`,
                                ),
                                requestOptions(api, signal),
                            );
                            if (item.resumePositionMs > 0) {
                                await writeUserData(
                                    api,
                                    jellyfinUserId,
                                    item.providerId,
                                    item.resumePositionMs * TICKS_PER_MS,
                                    signal,
                                );
                            }
                        }
                        batchResult.succeeded++;
                        batchResult.successful.push({
                            username: item.username,
                            mediaId: item.mediaId,
                        });
                    } catch (error) {
                        const err = error as {
                            response?: { status?: number };
                            message?: string;
                        };
                        const staleLink =
                            err.response?.status === 404 &&
                            (await dropStaleFileLink(
                                api,
                                ctx,
                                item.mediaId,
                                item.providerId,
                                signal,
                            ));
                        if (staleLink) {
                            batchResult.failed++;
                            const reason =
                                'Jellyfin item no longer exists (file renamed?); pairing dropped, re-inventory scheduled; retained for retry';
                            batchResult.errors.push(`${username}/${item.providerId}: ${reason}`);
                            batchResult.failedItems!.push({
                                username: item.username,
                                mediaId: item.mediaId,
                                error: reason,
                                terminal: false,
                            });
                        } else if (err.response?.status === 404 && item.resumePositionMs === 0) {
                            // Terminal: remote doesn't have the item. The
                            // event will never succeed without re-import,
                            // so drain it as skipped — the engine marks
                            // the backing event pushed and the row stops
                            // blocking newer work. The stale provider ID
                            // is still tracked for operator diagnostics.
                            batchResult.staleIds.push(item.providerId);
                            batchResult.drainedAsSkipped.push({
                                username: item.username,
                                mediaId: item.mediaId,
                            });
                            batchResult.skipped++;
                            const reason = 'Jellyfin item not found (HTTP 404)';
                            batchResult.errors.push(`${username}/${item.providerId}: ${reason}`);
                            batchResult.failedItems!.push({
                                username: item.username,
                                mediaId: item.mediaId,
                                error: reason,
                                terminal: true,
                            });
                        } else {
                            // Transient: network error, 5xx, parse error.
                            // Leave queued; next cycle retries.
                            batchResult.failed++;
                            const msg = err.message ?? 'Unknown error';
                            batchResult.errors.push(`${username}/${item.providerId}: ${msg}`);
                            batchResult.failedItems!.push({
                                username: item.username,
                                mediaId: item.mediaId,
                                error: msg.slice(0, 500),
                                terminal: false,
                            });
                        }
                    }
                }
            }

            return batchResult;
        },

        // -----------------------------------------------------------------
        // pushResumePosition (optional in SDK)
        // -----------------------------------------------------------------
        async pushResumePosition(
            _ctx: PluginContext,
            items: ResumePositionItem[],
            signal?: AbortSignal,
        ): Promise<WatchSyncPushResult> {
            const result: WatchSyncPushResult = {
                succeeded: 0,
                failed: 0,
                skipped: 0,
                staleIds: [],
                errors: [],
                successful: [],
                drainedAsSkipped: [],
                failedItems: [],
            };
            const api = await getJellyfinApi();
            for (const item of items) {
                if (signal?.aborted) break;
                try {
                    if (!api) throw new Error('Jellyfin client not available');
                    const userId = await resolveJellyfinUserIdByUserId(toUserId(item.username));
                    if (!userId) throw new Error('No Jellyfin user mapping; retained for retry');
                    if (!isSafePathSegment(item.providerId))
                        throw new Error('Invalid Jellyfin item id; retained for re-pairing');
                    // The newest stop wins. Export and import run independently, so
                    // without this whichever ran first decided: a stop made in
                    // Jellyfin 0.4 s after the local one was overwritten by the
                    // older local position before the import ever saw it.
                    //
                    // Held back only for news the import has not seen (Jellyfin's
                    // LastPlayedDate later than the newest stop already imported) and
                    // never drained: the two hosts' clocks may disagree, so the verdict
                    // is settled by the import, and the retry after it delivers
                    // whatever is still ours. A date the import already saw was
                    // judged then; skew cannot block a later local stop.
                    if (item.eventAt) {
                        const held = await readUpstreamPosition(
                            api,
                            userId,
                            item.providerId,
                            signal,
                        );
                        if (
                            held?.lastPlayedAtMs != null &&
                            held.lastPlayedAtMs > Date.parse(item.eventAt) &&
                            held.lastPlayedAtMs >
                                (item.importedAt ? Date.parse(item.importedAt) : -Infinity) &&
                            Math.abs(held.positionMs - item.resumePositionMs) >=
                                SAME_POSITION_TOLERANCE_MS
                        ) {
                            // A hold, not a fault: nothing to report to the admin.
                            result.failedItems!.push({
                                username: item.username,
                                mediaId: item.mediaId,
                                error: 'Jellyfin holds a newer position; waiting for the import before retrying',
                                terminal: false,
                                deferred: true,
                            });
                            continue;
                        }
                    }
                    // A partial is a bookmark, not a played/unplayed operation.
                    // Do not synthesize Playing/Stopped: those mutate counts and
                    // use the authenticated session user, not the URL user.
                    await writeUserData(
                        api,
                        userId,
                        item.providerId,
                        item.resumePositionMs * TICKS_PER_MS,
                        signal,
                    );
                    result.succeeded++;
                    result.successful.push({ username: item.username, mediaId: item.mediaId });
                } catch (error) {
                    // Even 404 can mean an unsupported UserData route or a
                    // stale pairing. Never acknowledge undelivered progress.
                    const err = error as { response?: { status?: number }; message?: string };
                    const status = err.response?.status;
                    const staleLink =
                        status === 404 &&
                        api !== null &&
                        (await dropStaleFileLink(api, _ctx, item.mediaId, item.providerId, signal));
                    const reason = staleLink
                        ? 'Jellyfin item no longer exists (file renamed?); pairing dropped, re-inventory scheduled; retained for retry'
                        : `Jellyfin UserData${status ? ` HTTP ${status}` : ''}: ${err.message ?? String(error)}${status === 404 ? ' (item missing or UserData setter unsupported by server)' : ''}; retained for retry`;
                    result.failed++;
                    result.errors.push(reason);
                    result.failedItems!.push({
                        username: item.username,
                        mediaId: item.mediaId,
                        error: reason,
                        terminal: false,
                    });
                }
            }
            return result;
        },

        // -----------------------------------------------------------------
        // pullWatchState (optional in SDK)
        // -----------------------------------------------------------------
        async pullWatchState(
            ctx: PluginContext,
            opts?: WatchSyncPullOptions,
        ): Promise<WatchSyncPullResult> {
            const signal = opts?.signal;
            const cursors = opts?.cursors ?? new Map<string, string>();
            const result: WatchSyncPullResult = {
                items: [],
                errors: [],
                newCursors: new Map<string, string>(),
            };

            const api = await getJellyfinApi();
            if (!api) {
                throw new Error('Jellyfin client not available');
            }

            // Without a valid user list there is no account snapshot for this
            // run. Let the engine mark the provider as not pulled, preserving
            // the last good unlinked-user notice instead of publishing zero.
            const usersResponse = await withJellyfinRetry(
                () =>
                    api.axiosInstance.get<JellyfinUserRow[]>(
                        joinUpstreamUrl(api.basePath, `/Users`),
                        requestOptions(api, signal),
                    ),
                { signal },
            );
            if (!Array.isArray(usersResponse.data)) {
                throw new Error('Invalid Jellyfin users response');
            }
            const users = usersResponse.data;

            try {
                let sessionsByUser = new Map<string, JellyfinSession[]>();

                try {
                    sessionsByUser = groupSessionsByUser(await fetchActiveSessions(api, signal));
                } catch (err) {
                    ctx.logger.warn('Failed to fetch Jellyfin sessions for watch pull', {
                        error: String(err),
                    });
                    result.errors.push(`Failed to fetch active Jellyfin sessions: ${String(err)}`);
                }

                const knownUsernames = opts?.knownUsernames;
                const skippedUsernames: string[] = [];
                for (const user of users) {
                    if (signal?.aborted) break;
                    // Skip Jellyfin accounts with no matching Lumastra user
                    // before fetching their (potentially large) history — the
                    // engine discards their items anyway. When the set is
                    // absent (older engine / resolution failed) pull everyone.
                    if (knownUsernames && !knownUsernames.has((user.Name ?? '').toLowerCase())) {
                        // A nameless account cannot be linked, so there is nothing to tell the admin.
                        if (user.Name?.trim()) skippedUsernames.push(user.Name);
                        continue;
                    }
                    try {
                        await pullForUser(ctx, api, user, result, signal, cursors, sessionsByUser);
                    } catch (err) {
                        result.errors.push(`User ${user.Name}: ${(err as Error).message}`);
                    }
                }

                result.skippedUsernames = skippedUsernames;
                ctx.logger.info('Jellyfin pull completed', {
                    itemCount: result.items.length,
                    cursorAdvances: result.newCursors?.size ?? 0,
                    usersPulled: users.length - skippedUsernames.length,
                    skippedNoLumastraMatch: skippedUsernames.length,
                });
            } catch (error) {
                ctx.logger.error('Jellyfin pullWatchState failed', {
                    error: (error as Error).message,
                });
                result.errors.push((error as Error).message);
            }

            return result;
        },
    },
    // No pushEvery/pullEvery: defineWatchSync ignores them (the watch-sync
    // engine drives push/pull cadence) and warned about it on every module load
    // — once per boot plus once per isolated worker thread.
);

// Self-register at module load — matches the pattern used by native
// providers (see ../providers/jellyfin.ts:registry.registerProvider(...)).
// `registerWatchSyncWithAutoTasks` registers both the WatchSyncDefinition
// and the synthesized push/pull task stubs.
registerWatchSyncWithAutoTasks(jellyfinWatchSync);

export default jellyfinWatchSync;
