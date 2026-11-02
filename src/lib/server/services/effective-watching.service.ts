// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Effective Watching — composition primitive for the home Continue Watching
 * strip. Wraps durable rows + live session overlay + synthetic next-up
 * injection + smart-sort + suspicion annotation behind one call.
 *
 * Why this exists: the route handler used to inline ~500 lines of
 * orchestration that happened in slightly different ways depending on the
 * caller (home strip vs per-series next-episode), which produced silent
 * parity drift. Pushing the orchestration into a primitive gives both
 * callers the same answer for the same user.
 *
 * Live overlay is run with a configurable hard budget so SSR callers can
 * fail-open: durable state always renders, the overlay layers on when
 * `SessionReadModel` is fast, otherwise the SSE patches it after hydration.
 */
import { getDb } from '$lib/server/database/index.js';
import type { UserId } from '$lib/shared/user-id.js';
import { detectBulkMarkWindows } from '$lib/server/database/queries/user-media-events.queries.js';
import { findNextSequentialEpisode } from '$lib/server/database/queries/episode-search.queries.js';
import type {
    ContinueWatchingRow,
    NextUpRow,
} from '$lib/server/database/queries/watch-state.queries.js';
import { watchManager } from '$lib/server/services/watch-manager.service.js';
import { getSessionReadModel } from '$lib/server/services/session-read-model.service.js';
import { getNewEpisodesForUser } from '$lib/server/services/new-episodes.service.js';
import { getActiveFlagTargets } from '$lib/server/database/queries/user-media-flags.queries.js';
import { applyLiveOverlay } from '$lib/server/utils/live-watching-overlay.js';
import type { AgeRatingFilterParams } from '$lib/server/database/queries/builders/age-rating.builder.js';
import { filterAccessibleMediaIds } from '$lib/server/utils/media-access-batch.js';
import { availableAudiobookIds } from '$lib/server/database/queries/audiobook-library.queries.js';
import { restrictedAccess } from '$lib/server/database/queries/builders/media-access-boundary.js';
import type { ResolvedMetadataLanguages } from '$lib/server/utils/metadata-language-resolve.js';
import {
    createSequentialNextUpItem,
    upsertSequentialNextUp,
    type WatchingItemWithSort,
} from '$lib/server/utils/live-next-up-fallback.js';
import {
    markSuspiciousItems,
    type ContinueWatchingItem,
} from '$lib/server/utils/section-builder.js';
import { withBudget } from '$lib/server/utils/with-budget.js';
import { createExternalIds } from '$lib/utils/external-ids.js';
import { isEpisode } from '$lib/server/utils/media-types.js';
import { getCatalogPosterUrl, getCatalogThumbUrl } from '$lib/utils/image-utils.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('EffectiveWatching');

// ─── Public types ─────────────────────────────────────────────────────────────

export interface EffectiveWatchingInput {
    /** Display/Jellyfin-matching handle (logging, session-read-model, new-episodes). */
    username: string;
    /** Stable users.id UUID — the user-data key for watch-state/flags/suspicion reads. */
    userId: UserId;
    /** Per-section item limit. When mergeSort=true, also caps the merged list. */
    limit: number;
    /** Include "new episodes for actively watched series" in the next-up bucket. */
    includeNewEpisodes?: boolean;
    /**
     * When true, all items are sorted together and capped at `limit`, then
     * split by itemType. tvOS uses this. Web uses independent per-section
     * sorting (false).
     */
    mergeSort?: boolean;
    /**
     * Hard timeout for the live-session overlay step (ms). On timeout the
     * function falls back to durable-only rendering and sets
     * `liveOverlayApplied=false`. SSR callers pass a small value (~50);
     * background/API callers can leave it unset to wait indefinitely.
     */
    liveOverlayBudgetMs?: number;
    /**
     * Skip the bulk-mark suspicion detection step. SSR callers may set this
     * to keep the hot path tight; SSE-driven re-fetches can recompute it.
     */
    skipSuspicion?: boolean;
    /**
     * Override `getDb()` — exists for testability. Production callers leave
     * this unset.
     */
    sql?: ReturnType<typeof getDb>;
    /** Override `Date.now()` for deterministic tests. */
    nowMs?: number;
    /**
     * Caller access boundary. Continue Watching / Next Up are derived from
     * historical watch state and would otherwise replay metadata for media
     * the user no longer has access to (policy change after viewing). When
     * provided, items are filtered against this boundary before serialization.
     * Omit only on internal callers that genuinely don't need the filter
     * (e.g. background reconciliation); request-scoped callers must pass it.
     */
    access?: {
        deniedGroupIds: string[] | null;
        ageRating: AgeRatingFilterParams | null;
    };
    /**
     * Per-user metadata-language overlay (multilingual-media-metadata spec §5).
     * When set (and a non-primary language resolves), the returned CW + Next Up
     * items get their title/overview swapped to the viewer's preferred-language
     * translation — the same overlay the media modal applies — keyed on each
     * item's own media_id. Omit (or pass the no-overlay result) on installs
     * without additional languages so this path stays a zero-query no-op.
     */
    langs?: ResolvedMetadataLanguages;
}

export interface EffectiveWatchingResult {
    continueWatching: ContinueWatchingItem[];
    /** Next Up items, deduped against CW, including any included new-episodes. */
    nextUp: ContinueWatchingItem[];
    /** True when the live overlay ran to completion within budget. */
    liveOverlayApplied: boolean;
    /** True when bulk-mark suspicion was applied to either bucket. */
    suspicionApplied: boolean;
    /** True when both raw database prefixes ended before their requested limits. */
    sourceExhausted: boolean;
}

// ─── Internal helpers (lifted from the route handler verbatim) ────────────────

function continueWatchingRowToItem(row: ContinueWatchingRow): WatchingItemWithSort {
    const runtimeMs = row.runtime_ms ? Number(row.runtime_ms) : 0;
    const positionMs = Number(row.resume_position_ms);

    return {
        id: row.media_id,
        title: row.title,
        overview: row.overview ?? undefined,
        customMetadata: row.custom_metadata ?? undefined,
        mediaType: row.media_type,
        seriesName: row.series_name ?? undefined,
        seasonNumber: row.season_number ?? undefined,
        episodeNumber: row.episode_number ?? undefined,
        watchProgress: runtimeMs > 0 ? Math.min((positionMs / runtimeMs) * 100, 100) : 0,
        duration: runtimeMs > 0 ? Math.round(runtimeMs / 1000) : undefined,
        // Episodes only ever have their own artwork under the 'thumb' image type
        // (still_path / locally extracted frame) — 'poster' inherits season/series
        // art instead. Movies have no 'thumb' of their own, so keep 'poster' there.
        imageUrl: isEpisode(row.media_type)
            ? getCatalogThumbUrl(row.media_id, { size: 'thumb' })
            : getCatalogPosterUrl(row.media_id, { size: 'thumb' }),
        externalIds: createExternalIds({
            tmdb: row.tmdb_id || null,
            imdb: row.imdb_id || null,
            internal: row.media_id,
        }),
        hasFiles: row.has_files,
        seriesId: row.series_id ?? undefined,
        resumeRatio: runtimeMs > 0 ? positionMs / runtimeMs : undefined,
        updatedAt: row.last_event_at ?? undefined,
        lastEventSource: row.last_event_source ?? undefined,
        source: 'continue-watching',
        // sort_date is pre-computed in SQL (P2): GREATEST(last_event_at,
        // premiere_date, season-MAX(last_watched_at)). Always populated
        // (epoch fallback). No second roundtrip needed.
        sortDate: new Date(row.sort_date),
        itemType: 'continue',
    };
}

function nextUpRowToItem(row: NextUpRow): WatchingItemWithSort {
    return {
        id: row.media_id,
        title: row.title,
        overview: row.overview ?? undefined,
        mediaType: 'episode',
        seriesName: row.series_name ?? undefined,
        seasonNumber: row.season_number,
        episodeNumber: row.episode_number,
        watchProgress: 0,
        duration: row.runtime_seconds ? row.runtime_seconds : undefined,
        // Next Up rows are always episodes — see continueWatchingRowToItem above.
        imageUrl: getCatalogThumbUrl(row.media_id, { size: 'thumb' }),
        externalIds: createExternalIds({
            tmdb: row.series_tmdb_id || null,
            imdb: row.series_imdb_id || null,
            internal: row.media_id,
        }),
        hasFiles: row.has_files,
        seriesId: row.series_id ?? undefined,
        updatedAt: row.last_watched_at ?? undefined,
        lastEventSource: row.last_event_source ?? undefined,
        // Carry the backdrop blurhash through so the SSR home hero's first
        // slide can paint a LQIP placeholder for returning users (personalized
        // path). Already SELECTed by getNextUpFromDb — no extra query.
        backdropBlurhash: row.backdrop_blurhash ?? undefined,
        source: 'next-up',
        // sort_date is pre-computed in SQL (P2): GREATEST(last_watched_at,
        // premiere_date). Always populated (epoch fallback).
        sortDate: new Date(row.sort_date),
        itemType: 'nextup',
    };
}

/**
 * Resolve which of the given Continue-Watching rows currently have a fresh,
 * actively-playing live session. Reuses the canonical live overlay so the
 * "playing now" determination matches the Continue-Watching strip exactly
 * (same freshness gating + session→row matching). Returns the set of playing
 * media_ids (internal ids). Never throws — a Valkey/session read failure
 * degrades to "nothing playing" so callers simply omit the badge.
 *
 * Used by the hero's `/api/recommendations?type=continue` path, which fetches
 * RAW CW rows (no overlay) yet needs the live playing flag to light up the
 * "Playing now" hero treatment consistently with the CW carousel.
 */
export async function resolvePlayingMediaIds(
    username: string,
    userId: UserId,
    rows: ContinueWatchingRow[],
): Promise<Set<string>> {
    const playing = new Set<string>();
    if (rows.length === 0) return playing;
    try {
        const items = rows.map(continueWatchingRowToItem);
        const activeSessions = await getSessionReadModel().getActiveSessionsForUser(userId);
        const overlay = applyLiveOverlay({
            username,
            continueWatching: items,
            nextUp: [],
            activeSessions,
        });
        for (const item of overlay.continueWatching) {
            if (item.livePlaybackState === 'playing' && item.id) {
                playing.add(item.id);
            }
        }
    } catch {
        // Live session read failed — treat as nothing playing. The durable CW
        // rows (and thus the resume affordance) are unaffected.
    }
    return playing;
}

/**
 * Newest first, then by media id. Equal dates are common (a season's episodes
 * share a premiere date, a bulk mark stamps one instant), and without a total
 * order the result follows the input order, which the live overlay rebuilds on
 * every call.
 */
function compareBySortDate(a: WatchingItemWithSort, b: WatchingItemWithSort): number {
    const byDate = b.sortDate.getTime() - a.sortDate.getTime();
    if (byDate !== 0) return byDate;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function stripSortFields(items: WatchingItemWithSort[]): ContinueWatchingItem[] {
    return items.map(
        ({
            sortDate: _sortDate,
            itemType: _itemType,
            preserveSortDate: _preserveSortDate,
            ...rest
        }) => rest,
    );
}

type AccessBoundary = NonNullable<EffectiveWatchingInput['access']>;

/**
 * Returns true when the caller's access boundary actually restricts anything.
 * An admin / unrestricted user has both fields null, in which case every
 * media id is allowed and the (potentially large) batch query is skipped.
 */
function accessRestricts(access: AccessBoundary | undefined): access is AccessBoundary {
    return Boolean(access && (access.deniedGroupIds || access.ageRating));
}

/**
 * Resolve which of `mediaIds` the user is permitted to see under the caller's
 * access boundary (library-group denial + age cap). This is the single
 * allow-list the whole composition must funnel injected items through — base
 * CW/NU rows, synthetic next-up episodes, and injected new-episode banners —
 * so no path bypasses the boundary.
 *
 * Thin wrapper over `filterAccessibleMediaIds` that adds a fail-closed
 * try/catch. The library rule is therefore the shared, container-aware one:
 * a leaf is judged by its OWN files (no files at all = visible, the
 * discovery-ghost fail-open), a `tv`/`season`/`artist`/`album` row by its
 * DESCENDANTS' files plus its own `library_group_id`. Age access is satisfied
 * when the row is unrated-and-allowed OR within the user's cap.
 *
 * @param sql      DB handle (caller-provided or getDb()).
 * @param access   Restricting access boundary (callers gate with accessRestricts()).
 * @param mediaIds Internal media_items UUIDs to test. Non-UUID / empty ids are dropped.
 * @returns Set of allowed UUIDs. On query failure returns an empty set
 *          (fail-closed) so a transient DB error never leaks restricted media.
 */
async function resolveAllowedMediaIds(
    sql: ReturnType<typeof getDb>,
    access: AccessBoundary,
    mediaIds: Iterable<string>,
): Promise<Set<string>> {
    const ids = Array.from(new Set(mediaIds)).filter(
        (id): id is string => typeof id === 'string' && id.length > 0,
    );
    if (ids.length === 0 || !sql) return new Set();

    try {
        // Delegates to the shared batch gate rather than re-inlining the two
        // predicates. That matters here: the call at the bottom of this file
        // passes SERIES uuids, and the copy that used to live here asked
        // whether the SERIES row owned a non-denied file. No `tv` row owns a
        // media_file_items row at all (0 of 6,570 on production, 2026-09-15),
        // so its `NOT EXISTS (own files)` arm was unconditionally TRUE and the
        // library axis was a no-op for precisely those ids.
        //
        // `restrictedAccess` normalises the same way the inlined ternaries did:
        // an empty denied list collapses to unrestricted-library, a null
        // maxAgeRating to unrestricted-age. Callers gate on accessRestricts(),
        // so at least one axis restricts and the helper's both-unrestricted
        // fast path (which skips the incidental existence check) is unreachable.
        return await filterAccessibleMediaIds(
            sql,
            ids,
            restrictedAccess({
                deniedGroupIds: access.deniedGroupIds ?? [],
                maxAgeRating: access.ageRating?.maxAgeRating ?? null,
                allowUnrated: access.ageRating?.allowUnrated ?? true,
            }),
        );
    } catch (error) {
        // Fail closed: a boundary query that errored must not allow restricted
        // media to surface. Returning an empty set drops every tested id.
        logger.warn('Access allow-list query failed; dropping tested items', {
            error: (error as Error).message,
            count: ids.length,
        });
        return new Set();
    }
}

/**
 * Resolve which of `seriesIds` (TV series UUIDs) the user may see under the
 * age cap. Used to gate synthetic next-up against the SERIES-level age_rating
 * rather than the episode row (episode rows almost always carry a null
 * age_rating, so an episode-level check is effectively a no-op). Library-group
 * denial is handled by the episode-id allow-list; here we only add the
 * series-age dimension. Returns the set of allowed series UUIDs; on failure
 * returns an empty set (fail-closed).
 */
async function resolveAgeAllowedSeriesIds(
    sql: ReturnType<typeof getDb>,
    age: AgeRatingFilterParams,
    seriesIds: Iterable<string>,
): Promise<Set<string>> {
    const ids = Array.from(new Set(seriesIds)).filter(
        (id): id is string => typeof id === 'string' && id.length > 0,
    );
    if (ids.length === 0 || !sql || age.maxAgeRating === null) return new Set(ids);
    try {
        const rows = await sql<{ id: string }[]>`
            SELECT mi.id::text
            FROM media_items mi
            WHERE mi.id = ANY(${ids}::uuid[])
              AND (
                  (mi.age_rating IS NULL AND ${age.allowUnrated}::boolean)
                  OR mi.age_rating <= ${age.maxAgeRating}
              )
        `;
        return new Set(rows.map((r) => r.id));
    } catch (error) {
        logger.warn('Series age allow-list query failed; dropping synthetic next-up', {
            error: (error as Error).message,
            count: ids.length,
        });
        return new Set();
    }
}

// ─── Main entry point ────────────────────────────────────────────────────────

export async function effectiveWatchingFor(
    input: EffectiveWatchingInput,
): Promise<EffectiveWatchingResult> {
    const {
        username,
        userId,
        limit,
        includeNewEpisodes = false,
        mergeSort = false,
        liveOverlayBudgetMs,
        skipSuspicion = false,
        sql: providedSql,
        nowMs,
        access,
        langs,
    } = input;

    const sql = providedSql ?? getDb();
    const now = nowMs ?? Date.now();
    const nowIso = new Date(now).toISOString();

    // Fetch CW + NU base rows in parallel. mergeSort needs over-fetch so the
    // post-merge slice still has `limit` items per bucket on average.
    const fetchLimit = mergeSort ? limit * 2 : limit;

    // When an access boundary applies, the CW query must NOT collapse to one
    // row per series: the boundary is enforced below per media_id, and a
    // collapsed representative that fails the check would take its whole series
    // with it instead of falling back to an accessible sibling episode. Ask for
    // the per-episode shape and let the downstream fold choose from whatever
    // survives — over-fetching to offset the collapse we gave up.
    const collapsePerSeries = !accessRestricts(access);
    const cwFetchLimit = collapsePerSeries ? fetchLimit : fetchLimit * 4;

    const [continueWatchingRows, nextUpRows] = await Promise.all([
        watchManager.getContinueWatching(userId, cwFetchLimit, collapsePerSeries),
        watchManager.getNextUp(userId, fetchLimit),
    ]);
    const sourceExhausted =
        continueWatchingRows.length < cwFetchLimit && nextUpRows.length < fetchLimit;

    let continueWatching: WatchingItemWithSort[] =
        continueWatchingRows.map(continueWatchingRowToItem);
    let nextUp: WatchingItemWithSort[] = nextUpRows.map(nextUpRowToItem);

    // Apply caller's access boundary to CW/NU. The base queries return rows
    // from historical watch state; if the user's policy changed after the
    // row was written they would otherwise see metadata they cannot reach
    // through browse/search. Single batch query against media_items —
    // restricted users typically have small CW/NU lists so this is cheap.
    if (accessRestricts(access) && sql) {
        const allIds = [...continueWatching.map((i) => i.id), ...nextUp.map((i) => i.id)];
        if (allIds.length > 0) {
            const allowed = await resolveAllowedMediaIds(sql, access, allIds);
            continueWatching = continueWatching.filter((i) => allowed.has(i.id));
            nextUp = nextUp.filter((i) => allowed.has(i.id));
        }
    }

    // Snapshot the access-vetted next-up media ids. Anything appearing in
    // next-up after the live overlay that is NOT in this set is a synthetic
    // injection (findNextSequentialEpisode bypasses the boundary), so it must
    // be re-vetted through the allow-list before it can surface (H1).
    const accessVettedNextUpIds = new Set(nextUp.map((i) => i.id));
    const accessVettedContinueWatchingIds = new Set(continueWatching.map((i) => i.id));

    // ── Live overlay + synthetic next-up (with budget) ────────────────────
    let overlayRepresentedMediaIds = new Set<string>();
    let liveOverlayApplied = false;

    const overlayPromise = (async () => {
        const activeSessions = await getSessionReadModel().getActiveSessionsForUser(userId);
        const overlay = applyLiveOverlay({
            username,
            continueWatching,
            nextUp,
            activeSessions,
            nowIso,
        });

        // A row the overlay did not touch keeps the SQL `sort_date` it came in
        // with (GREATEST(last_event_at, premiere_date, season max watched)).
        // Re-deriving it from `updatedAt` (= last_event_at alone) made the order
        // depend on whether the overlay finished inside its budget: the SSR
        // paint (budget miss, durable sort_date) and the next poll (overlay
        // applied, last_event_at) ranked the same rows differently, so cards
        // swapped places while the page stayed open. Only a row with a live
        // session is "now" and sorts by its fresh `updatedAt`.
        const durableSortDateById = new Map(continueWatching.map((row) => [row.id, row.sortDate]));
        const overlayCw = overlay.continueWatching.map((item): WatchingItemWithSort => {
            const durableSortDate =
                item.livePlaybackState === undefined ? durableSortDateById.get(item.id) : undefined;
            return {
                ...item,
                sortDate:
                    durableSortDate ?? (item.updatedAt ? new Date(item.updatedAt) : new Date(0)),
                itemType: 'continue',
            };
        });

        // Synthetic next-up: each suppressed anchor (live-past-completion OR
        // durable-past-completion) gets the next sequential episode pushed
        // into next-up so the UI doesn't briefly show nothing while the
        // durable plane catches up. Movies have no successor — skipped.
        // Anchors are independent — fan out the next-episode lookups so
        // overlay latency stays roughly constant when several series are in
        // flight simultaneously.
        let injectedNu = nextUp;
        if (sql && overlay.suppressedAnchors.length > 0) {
            const seriesAnchors = overlay.suppressedAnchors.filter(
                (a) => typeof a.seriesId === 'string' && a.seriesId.length > 0,
            );
            // allSettled, not all: one stale series query must not disable
            // synthetic next-up for every other in-flight binge.
            const settled = await Promise.allSettled(
                seriesAnchors.map((anchor) =>
                    findNextSequentialEpisode(sql, anchor.seriesId!, anchor.mediaId, {
                        playableOnly: true,
                    }).then((next) => ({ anchor, next })),
                ),
            );
            const nextEpisodes: Array<{
                anchor: (typeof seriesAnchors)[number];
                next: Awaited<ReturnType<typeof findNextSequentialEpisode>>;
            }> = [];
            for (const r of settled) {
                if (r.status === 'fulfilled') {
                    nextEpisodes.push(r.value);
                } else {
                    logger.debug('Synthetic-next-up lookup failed', {
                        error: (r.reason as Error)?.message,
                    });
                }
            }
            for (const { anchor, next: nextEpisode } of nextEpisodes) {
                if (!nextEpisode || nextEpisode.has_files !== true || !anchor.seriesId) continue;
                const durableMatch = anchor.durableMatch;
                const liveItemShim: ContinueWatchingItem = {
                    id: anchor.mediaId,
                    title: durableMatch?.title ?? '',
                    mediaType: anchor.mediaType,
                    externalIds: createExternalIds({
                        internal: anchor.mediaId,
                    }),
                    seriesId: anchor.seriesId,
                    seriesName: durableMatch?.seriesName,
                    watchProgress: 100,
                    lastEventSource: anchor.lastEventSource,
                };
                injectedNu = upsertSequentialNextUp(
                    injectedNu,
                    createSequentialNextUpItem(nextEpisode, liveItemShim, anchor.seriesId, nowIso),
                );
            }
        }

        return {
            cw: overlayCw,
            nu: injectedNu,
            representedMediaIds: overlay.representedMediaIds,
            representedSeriesIds: overlay.representedSeriesIds,
        };
    })();

    const overlayResult = await withBudget(overlayPromise, liveOverlayBudgetMs);

    if (overlayResult) {
        continueWatching = overlayResult.cw;
        nextUp = overlayResult.nu;
        overlayRepresentedMediaIds = overlayResult.representedMediaIds;
        liveOverlayApplied = true;
    } else if (liveOverlayBudgetMs !== undefined) {
        logger.debug('Live overlay exceeded budget — falling back to durable', {
            budgetMs: liveOverlayBudgetMs,
            username,
        });
    } else {
        // Untimed overlay errored. The catch in the original handler swallowed
        // these so we keep parity here.
        logger.debug('Live overlay failed; rendering durable-only', {
            username,
        });
    }

    // A still-active session may inject a CW row that the base access filter
    // removed. Recheck injected rows against the same live boundary.
    if (accessRestricts(access) && sql) {
        const injectedIds = continueWatching
            .filter((item) => !accessVettedContinueWatchingIds.has(item.id))
            .map((item) => item.id);
        if (injectedIds.length > 0) {
            const allowed = await resolveAllowedMediaIds(sql, access, injectedIds);
            continueWatching = continueWatching.filter(
                (item) => accessVettedContinueWatchingIds.has(item.id) || allowed.has(item.id),
            );
        }
    }

    // Source removal also applies to unrestricted users. Both the durable row
    // cache and a session's hasFiles snapshot may predate that removal.
    const audiobookIds = continueWatching
        .filter((item) => item.mediaType === 'audiobook')
        .map((item) => item.id);
    if (audiobookIds.length > 0) {
        const available = sql
            ? await availableAudiobookIds(
                  sql,
                  audiobookIds,
                  restrictedAccess({
                      deniedGroupIds: access?.deniedGroupIds ?? [],
                      maxAgeRating: access?.ageRating?.maxAgeRating ?? null,
                      allowUnrated: access?.ageRating?.allowUnrated ?? true,
                  }),
              )
            : new Set<string>();
        continueWatching = continueWatching.filter(
            (item) => item.mediaType !== 'audiobook' || available.has(item.id),
        );
    }

    // ── Re-vet synthetic next-up against the access boundary (H1) ─────────
    // findNextSequentialEpisode bypasses the allow-list, so an episode injected
    // for a series in a denied library group or above the user's age cap could
    // otherwise surface. Any next-up media id that was NOT in the access-vetted
    // base set is synthetic and must pass BOTH dimensions:
    //   • library-group: evaluated at the EPISODE level (the episode's own
    //     files determine reachability). Age is intentionally excluded from
    //     this check — episode rows almost always carry a null age_rating, so
    //     an episode-level age test would spuriously drop within-cap episodes.
    //   • age: evaluated at the SERIES level (N8(b)), which is where the
    //     rating actually lives.
    // Non-synthetic rows already passed the base filter and are kept.
    if (accessRestricts(access) && sql) {
        const syntheticItems = nextUp.filter((i) => !accessVettedNextUpIds.has(i.id));
        if (syntheticItems.length > 0) {
            // Library-group-only boundary for the episode-id check (drop age).
            const libraryOnly: AccessBoundary = {
                deniedGroupIds: access.deniedGroupIds,
                ageRating: null,
            };
            const [libAllowedEpisodeIds, ageAllowedSeriesIds] = await Promise.all([
                access.deniedGroupIds && access.deniedGroupIds.length > 0
                    ? resolveAllowedMediaIds(
                          sql,
                          libraryOnly,
                          syntheticItems.map((i) => i.id),
                      )
                    : Promise.resolve<Set<string> | null>(null),
                access.ageRating
                    ? resolveAgeAllowedSeriesIds(
                          sql,
                          access.ageRating,
                          syntheticItems
                              .map((i) => i.seriesId)
                              .filter((id): id is string => typeof id === 'string'),
                      )
                    : Promise.resolve<Set<string> | null>(null),
            ]);
            nextUp = nextUp.filter((item) => {
                if (accessVettedNextUpIds.has(item.id)) return true;
                if (libAllowedEpisodeIds && !libAllowedEpisodeIds.has(item.id)) return false;
                if (
                    ageAllowedSeriesIds &&
                    item.seriesId &&
                    !ageAllowedSeriesIds.has(item.seriesId)
                ) {
                    return false;
                }
                // Synthetic item with a denied library group but no resolvable
                // episode allow-set (shouldn't happen — gated above) or a
                // synthetic item with no seriesId under an age cap: drop it
                // (fail-closed) since we cannot prove series-age compliance.
                if (ageAllowedSeriesIds && !item.seriesId) return false;
                return true;
            });
        }
    }

    // ── Dedup next-up against the live-overlay representation set ─────────
    //
    // Only the SAME-EPISODE case is dropped here. The series-level drop that
    // used to live alongside it deleted a series' Next Up row whenever ANY
    // Continue Watching row survived for that series — which meant a stale
    // backlog resume (say S04E05) silently deleted the correct S07E20 Next Up
    // before `resolveSeriesAnchor` ever saw the pair, so the arbitration rules
    // were unreachable and the user was shown the three-seasons-old episode.
    //
    // It was also nondeterministic: `overlayRepresentedSeriesIds` is only
    // populated when the live overlay completes within its budget, so the same
    // user could get a different rail on consecutive loads depending on
    // session-read latency. The overlay-timeout path already exercises the
    // no-series-filter behaviour in production today.
    //
    // Per-series arbitration is `buildMergedWatchingSection`'s job, and all
    // three consumers of this service go through it — none renders nextUp as a
    // standalone rail. Let the pair reach the arbiter.
    const filteredNextUp = nextUp.filter((item) => {
        const internalId =
            item.externalIds && 'internal' in item.externalIds
                ? (item.externalIds as Record<string, string | undefined>).internal
                : undefined;
        const mediaId = internalId ?? item.id;
        if (mediaId && overlayRepresentedMediaIds.has(mediaId)) return false;
        return true;
    });

    // ── Optional new-episodes fetch ───────────────────────────────────────
    const newEpisodes: WatchingItemWithSort[] = [];
    if (includeNewEpisodes && sql) {
        try {
            // P3: server-side anti-join for the new-episode banner. The
            // pre-P3 client tracked dismissals in an in-memory SvelteSet
            // that was lost on every reload; the flag table makes
            // dismissals persistent and cross-device. Failure here is
            // non-fatal — we'd rather show a recently-dismissed banner
            // than fail the whole strip.
            let dismissedSeriesIds: ReadonlySet<string> | undefined;
            try {
                const ids = await getActiveFlagTargets(sql, {
                    userId,
                    flagType: 'new_episode_alert_dismissed',
                });
                dismissedSeriesIds = new Set(ids);
            } catch (error) {
                logger.debug('Failed to load new_episode_alert_dismissed flags', {
                    error: (error as Error).message,
                });
            }

            const newEpisodesData = await getNewEpisodesForUser(sql, username, {
                limit: mergeSort ? limit * 2 : limit,
                dismissedSeriesIds,
            });

            const existingIds = new Set([
                ...continueWatching.map((item) => item.id),
                ...filteredNextUp.map((item) => item.id),
            ]);
            // Episode-key dedup must only consider episodes — movies have
            // undefined season/episode and would all collide on
            // 'undefined|SundefinedEundefined', shadowing legitimate new
            // episodes that happen to be loaded after a movie in the strip.
            //
            // Keyed by the internal series UUID (seriesId, else externalIds.internal)
            // so each series gets a stable, distinct key.
            const episodeOnly = (item: WatchingItemWithSort) => isEpisode(item.mediaType);
            const seriesKeyOf = (item: WatchingItemWithSort): string => {
                if (item.seriesId) return item.seriesId;
                const internal =
                    item.externalIds && 'internal' in item.externalIds
                        ? (item.externalIds as Record<string, string | undefined>).internal
                        : undefined;
                return internal ?? item.id;
            };
            const existingEpisodeKeys = new Set(
                [...continueWatching, ...filteredNextUp]
                    .filter(episodeOnly)
                    .map(
                        (item) =>
                            `${seriesKeyOf(item)}|S${item.seasonNumber}E${item.episodeNumber}`,
                    ),
            );

            for (const ep of newEpisodesData) {
                if (existingIds.has(ep.episodeId)) {
                    continue;
                }
                // New-episode items are keyed by the internal series UUID, the
                // same key synthetic next-up items carry.
                const episodeKey = `${ep.seriesId}|S${ep.seasonNumber}E${ep.episodeNumber}`;
                if (existingEpisodeKeys.has(episodeKey)) continue;

                newEpisodes.push({
                    id: ep.episodeId,
                    title: ep.episodeTitle,
                    mediaType: 'episode',
                    seriesName: ep.seriesName,
                    seasonNumber: ep.seasonNumber,
                    episodeNumber: ep.episodeNumber,
                    watchProgress: 0,
                    duration: ep.runtimeSeconds,
                    imageUrl: ep.posterUrl,
                    externalIds: ep.externalIds || {},
                    hasFiles: true,
                    seriesId: ep.seriesId,
                    sortDate: ep.airDate,
                    itemType: 'new-episode',
                });

                existingIds.add(ep.episodeId);
                existingEpisodeKeys.add(episodeKey);
            }

            // ── Access-boundary vetting for injected new-episodes (M1) ────
            // getNewEpisodesForUser applies no library/age filter, so its
            // items would otherwise bypass the boundary. Vet
            // each item by its internal SERIES UUID (externalIds.internal):
            // the allow-list covers the denied-library-group dimension (series
            // files) and the series-level age cap. Items without a resolvable
            // internal UUID are dropped under restriction (fail-closed) — we
            // cannot prove they are reachable.
            if (accessRestricts(access) && newEpisodes.length > 0) {
                const seriesIdOf = (item: WatchingItemWithSort): string | undefined =>
                    item.externalIds && 'internal' in item.externalIds
                        ? (item.externalIds as Record<string, string | undefined>).internal
                        : undefined;
                const allowedSeriesIds = await resolveAllowedMediaIds(
                    sql,
                    access,
                    newEpisodes
                        .map(seriesIdOf)
                        .filter((id): id is string => typeof id === 'string'),
                );
                for (let i = newEpisodes.length - 1; i >= 0; i--) {
                    const sid = seriesIdOf(newEpisodes[i]);
                    if (!sid || !allowedSeriesIds.has(sid)) {
                        newEpisodes.splice(i, 1);
                    }
                }
            }
        } catch (error) {
            logger.warn('Failed to fetch new episodes; rendering without', {}, error as Error);
        }
    }

    // Smart-sort dates are pre-computed in the CW/NU SQL queries themselves
    // (see ContinueWatchingRow.sort_date / NextUpRow.sort_date). No enrichment
    // roundtrip needed. New-episode items keep their air-date sort, and items
    // injected by the synthetic next-up path carry preserveSortDate so the
    // `nowIso` they use isn't recomputed.
    const allItems: WatchingItemWithSort[] = [
        ...continueWatching,
        ...filteredNextUp,
        ...newEpisodes,
    ];

    // ── Final sort + slice ────────────────────────────────────────────────
    let sortedContinueWatching: WatchingItemWithSort[];
    let sortedNextUp: WatchingItemWithSort[];

    if (mergeSort) {
        allItems.sort(compareBySortDate);
        // Budget the slice by DISTINCT SERIES, not by row.
        // `buildMergedWatchingSection` renders at most one card per series, so
        // a CW row and an NU row for the same show would otherwise consume two
        // of `limit` slots and then collapse into one card — pushing a series
        // that would have rendered off the end. Same starvation shape the
        // SQL-side collapse fixes, one layer up.
        //
        // Both members of a pair are KEPT once their series holds a slot: the
        // CW/NU pair is exactly what `resolveSeriesAnchor` arbitrates over, and
        // dropping either one here would silently decide the anchor by sort
        // date instead — reintroducing the series-level pre-filter this commit
        // series removed. Items without a seriesId (movies) each take a slot.
        const slotKeys = new Set<string>();
        const sortedItems: WatchingItemWithSort[] = [];
        for (const item of allItems) {
            const key = item.seriesId ?? `media:${item.id}`;
            if (!slotKeys.has(key)) {
                if (slotKeys.size >= limit) continue;
                slotKeys.add(key);
            }
            sortedItems.push(item);
        }
        sortedContinueWatching = sortedItems.filter((item) => item.itemType === 'continue');
        sortedNextUp = sortedItems.filter(
            (item) => item.itemType === 'nextup' || item.itemType === 'new-episode',
        );
    } else {
        const cwSorted = [...continueWatching].sort(compareBySortDate);
        const nextUpAndNew = [...filteredNextUp, ...newEpisodes].sort(compareBySortDate);
        sortedContinueWatching = cwSorted.slice(0, limit);
        sortedNextUp = nextUpAndNew.slice(0, limit);
    }

    // ── Suspicion annotation ──────────────────────────────────────────────
    let suspicionApplied = false;
    let suspiciousCw: ContinueWatchingItem[] = stripSortFields(sortedContinueWatching);
    let suspiciousNu: ContinueWatchingItem[] = stripSortFields(sortedNextUp);

    if (!skipSuspicion && sql) {
        try {
            const bulkWindows = await detectBulkMarkWindows.all(sql, {
                userId,
                windowMs: 10_000,
                minEventCount: 50,
            });
            if (bulkWindows.length > 0) {
                suspiciousCw = markSuspiciousItems(suspiciousCw, bulkWindows);
                suspiciousNu = markSuspiciousItems(suspiciousNu, bulkWindows);
                suspicionApplied = true;
            }
        } catch (error) {
            logger.debug('Bulk-mark suspicion detection failed', {
                error: (error as Error).message,
            });
        }
    }

    // ── Per-user metadata-language overlay (multilingual-media-metadata §5) ──
    // Swap in the viewer's preferred-language title/overview, keyed on each
    // item's own media_id — the SAME overlay the media modal applies, so the
    // home hero + Continue Watching strip stop showing original-language titles
    // to a viewer who selected another language. Gated by the caller passing
    // `langs` (only when the feature is on AND a non-primary language resolves),
    // so feature-off installs pay ZERO here. At most 2 batched, indexed lookups
    // on media_item_translations; non-UUID ids (Sonarr new-episode / synthetic
    // rows) are skipped by the guard. Applied last so every field mutated above
    // is the base copy this overlay replaces.
    if (langs && (langs.titleLang || langs.textLang) && sql) {
        const localizable = [...suspiciousCw, ...suspiciousNu];
        if (localizable.length > 0) {
            try {
                const [{ applyTranslationOverlay }, { UUID_RE }] = await Promise.all([
                    import('$lib/server/utils/translation-overlay.js'),
                    import('$lib/utils/id-patterns.js'),
                ]);
                await applyTranslationOverlay(sql, localizable, langs, {
                    id: (it) => {
                        const internal =
                            it.externalIds && 'internal' in it.externalIds
                                ? (it.externalIds as Record<string, string | undefined>).internal
                                : undefined;
                        const id = internal ?? it.id;
                        return id && UUID_RE.test(id) ? id : null;
                    },
                    setTitle: (it, v) => {
                        it.title = v;
                    },
                    setOverview: (it, v) => {
                        it.overview = v;
                    },
                });
                // Pass 2 — the parent-series NAME, keyed by the SERIES id
                // (`seriesId` is the internal series UUID in this shape, see
                // ContinueWatchingItem). The SSR home hero renders
                // `seriesName ?? title` as its H1, so without this the headline
                // stays in the primary language while the subtitle below it is
                // translated. Only setTitle: the series' own overview must not
                // replace the episode synopsis.
                await applyTranslationOverlay(sql, localizable, langs, {
                    id: (it) => (it.seriesId && UUID_RE.test(it.seriesId) ? it.seriesId : null),
                    setTitle: (it, v) => {
                        it.seriesName = v;
                    },
                });
            } catch (error) {
                logger.debug('Watching translation overlay failed; serving primary language', {
                    error: (error as Error).message,
                });
            }
        }
    }

    return {
        continueWatching: suspiciousCw,
        nextUp: suspiciousNu,
        liveOverlayApplied,
        suspicionApplied,
        sourceExhausted,
    };
}
