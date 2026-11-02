// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared media-resolution for the watch-sync pull path.
 *
 * Given a batch of items pulled from a provider (Jellyfin/Plex/MAL), resolve
 * each to an internal Lumastra media UUID using three strategies, in priority
 * order:
 *
 *   0. `internalMediaId` — the plugin already knows the UUID (e.g. MAL reverse
 *      lookup). Used directly, but ONLY if that media_items row exists (a
 *      phantom UUID falls through so it gets buffered, not FK-failed).
 *   1. `(TMDB id, media_type)` composite — TMDB ids are NOT unique across media
 *      types (424 = both "Schindler's List" (movie) and "Torchwood" (tv)).
 *   1b. `(IMDB id, media_type)` composite — for items Jellyfin knows only by
 *      IMDB id (TMDB unmatched); same composite-key discipline.
 *   2. provider-id cache — `external_ids` rows written by previous push/pull.
 *   3. episode drill-down — series TMDB id + season/episode number, with the
 *      resolved provider id cached back via `upsertExternalId` for a fast path
 *      next time.
 *
 * Extracted from `watch-sync-engine.service.ts` so the live pull AND the
 * pending-resolution drain ({@link ./watch-sync-pending-drain.service}) share
 * ONE implementation — otherwise the two resolvers would silently drift and a
 * buffered item could resolve differently than a freshly-pulled one.
 *
 * The returned map is keyed by `providerId` (the provider's own item id, unique
 * per pulled item), so callers look resolution up per item without re-deriving
 * the composite keys.
 */

import type postgres from 'postgres';
import type { MediaType } from '../providers/provider-types.js';
import { Logger } from '../utils/logger.js';
import { createCatalogService } from './catalog.service.js';
import { isEpisode } from '../utils/media-types.js';

const logger = Logger.for('WatchSyncResolution');

/** The minimal item shape resolution needs — a subset of WatchStatePullItem. */
export interface ResolvableItem {
    providerId: string;
    mediaType: string;
    tmdbId: string | null;
    imdbId?: string | null;
    seriesTmdbId?: string | null;
    seasonNumber?: number | null;
    episodeNumber?: number | null;
    internalMediaId?: string | null;
}

export interface ResolutionOutcome {
    /** providerId → internal media UUID, for every item that resolved. */
    resolved: Map<string, string>;
    /** How many episodes resolved via the strategy-3 drill-down (for metrics). */
    seriesResolved: number;
}

// Normalise every TV spelling → 'tv' so rows stored under either convention
// collide on the same composite key (parity with `mi.media_type IN ('tv','series')`).
//
// `ResolvableItem.mediaType` is PROVIDER vocabulary by contract (SDK: "Media type
// as reported by the provider"), so this mapping must stay TOTAL for every TV
// spelling in the wild — MDBList, Trakt and Simkl all say 'show'. A spelling that
// falls through fails closed: the composite key never matches a DB row, the item
// buffers in `watch_state_pending_resolution` forever, and no error surfaces. The
// same partial-mapping shape (`isSeries('show')` → false → 'movie') silently wrote
// series ratings onto unrelated movies in mdblist-sync; keep this set exhaustive.
const TV_SPELLINGS = new Set(['series', 'show', 'tvshow', 'tv_show', 'tvshows']);
const normaliseTypeForKey = (t: string): string => (TV_SPELLINGS.has(t.toLowerCase()) ? 'tv' : t);

interface IdRow {
    media_id: string;
    external_id: string;
    media_type: string;
}

/**
 * Resolve a batch of pulled items to internal media UUIDs. Pure reads except
 * for the strategy-3 episode external-id cache write (idempotent upsert).
 */
export async function resolvePulledItems(
    sql: postgres.Sql,
    providerName: string,
    items: ResolvableItem[],
): Promise<ResolutionOutcome> {
    const resolved = new Map<string, string>();
    let seriesResolved = 0;

    if (items.length === 0) return { resolved, seriesResolved };

    // Strategy 0: plugin-supplied internal UUID (e.g. a future MAL pull). Only
    // trust it if the media_items row actually EXISTS — otherwise the item would
    // "resolve" to a phantom UUID and the downstream event write would fail the
    // FK and roll back the whole batch. A missing target falls through to the
    // other strategies, and if still unresolved it is buffered (carrying the
    // internal id) so the drain resolves it once the media is ingested.
    const internalIds = items
        .map((i) => i.internalMediaId)
        .filter((id): id is string => id != null);
    const existingInternalIds = new Set<string>();
    if (internalIds.length > 0) {
        // eslint-disable-next-line callback-safety/no-unscoped-media-items -- system id-resolution for the user's OWN watch import; existence check on a known UUID set, returns no user-facing rows
        const rows = await sql<Array<{ id: string }>>`
            SELECT id FROM media_items WHERE id = ANY(${[...new Set(internalIds)]}::uuid[])
        `.catch(() => [] as Array<{ id: string }>);
        for (const row of rows) existingInternalIds.add(row.id);
    }

    // Strategy 1: (TMDB id, media_type) composite.
    const tmdbIds = items.map((i) => i.tmdbId).filter((id): id is string => id != null);
    const tmdbRows =
        tmdbIds.length > 0
            ? // eslint-disable-next-line callback-safety/no-unscoped-media-items -- system id-resolution for importing the user's OWN watch history; maps (tmdb id → internal media id), returns no user-facing rows, so no access scoping applies
              await sql<IdRow[]>`
                    SELECT ei.media_id, ei.external_id, mi.media_type
                    FROM external_ids ei
                    JOIN media_items mi ON mi.id = ei.media_id
                    WHERE ei.provider = 'tmdb'
                        AND ei.external_id = ANY(${[...new Set(tmdbIds)]})
                `.catch(() => [] as IdRow[])
            : [];
    const tmdbIdMap = new Map<string, string>();
    for (const row of tmdbRows) {
        tmdbIdMap.set(`${row.external_id}:${normaliseTypeForKey(row.media_type)}`, row.media_id);
    }

    // Strategy 1b: (IMDB id, media_type) composite. Jellyfin reports IMDB ids
    // for many items TMDB hasn't matched; without this they'd never resolve on
    // pull (the push side already falls back to IMDB). Keyed the same way as
    // TMDB so a shared id across media types can't cross-map.
    const imdbIds = items.map((i) => i.imdbId).filter((id): id is string => id != null);
    const imdbRows =
        imdbIds.length > 0
            ? // eslint-disable-next-line callback-safety/no-unscoped-media-items -- system id-resolution for importing the user's OWN watch history; maps (imdb id → internal media id), returns no user-facing rows, so no access scoping applies
              await sql<IdRow[]>`
                    SELECT ei.media_id, ei.external_id, mi.media_type
                    FROM external_ids ei
                    JOIN media_items mi ON mi.id = ei.media_id
                    WHERE ei.provider = 'imdb'
                        AND ei.external_id = ANY(${[...new Set(imdbIds)]})
                `.catch(() => [] as IdRow[])
            : [];
    const imdbIdMap = new Map<string, string>();
    for (const row of imdbRows) {
        imdbIdMap.set(`${row.external_id}:${normaliseTypeForKey(row.media_type)}`, row.media_id);
    }

    // Strategy 2: provider-id cache, keyed by (external_id, media_type).
    // Jellyfin may report dashed GUIDs; links are stored dashless (see normalizeJellyfinId).
    const normaliseProviderId = (id: string): string =>
        providerName === 'jellyfin' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)
            ? id.replaceAll('-', '').toLowerCase()
            : id;
    const providerIds = [...new Set(items.map((i) => normaliseProviderId(i.providerId)))];
    const providerIdRows =
        providerIds.length > 0
            ? // eslint-disable-next-line callback-safety/no-unscoped-media-items -- system id-resolution for importing the user's OWN watch history; maps (provider id → internal media id), returns no user-facing rows, so no access scoping applies
              await sql<IdRow[]>`
                    SELECT ei.media_id, ei.external_id, mi.media_type
                    FROM external_ids ei
                    JOIN media_items mi ON mi.id = ei.media_id
                    WHERE ei.provider = ${providerName}
                        AND ei.external_id = ANY(${providerIds})
                `.catch(() => [] as IdRow[])
            : [];
    const providerIdMap = new Map<string, string>();
    for (const row of providerIdRows) {
        providerIdMap.set(
            `${row.external_id}:${normaliseTypeForKey(row.media_type)}`,
            row.media_id,
        );
    }

    // Strategy 3: episode drill-down via series TMDB id + S/E number.
    const episodesNeedingResolution = items.filter(
        (i) =>
            isEpisode(i.mediaType) &&
            !(i.tmdbId && tmdbIdMap.has(`${i.tmdbId}:${normaliseTypeForKey(i.mediaType)}`)) &&
            !(i.imdbId && imdbIdMap.has(`${i.imdbId}:${normaliseTypeForKey(i.mediaType)}`)) &&
            !providerIdMap.has(
                `${normaliseProviderId(i.providerId)}:${normaliseTypeForKey(i.mediaType)}`,
            ) &&
            i.seriesTmdbId != null &&
            i.seasonNumber != null &&
            i.episodeNumber != null,
    );

    const seriesTmdbIds = [
        ...new Set(
            episodesNeedingResolution
                .map((i) => i.seriesTmdbId)
                .filter((id): id is string => id != null),
        ),
    ];

    const seriesMediaIdMap = new Map<string, string>();
    if (seriesTmdbIds.length > 0) {
        // eslint-disable-next-line callback-safety/no-unscoped-media-items -- system id-resolution for importing the user's OWN watch history; maps (series tmdb id → series media id), returns no user-facing rows, so no access scoping applies
        const seriesRows = await sql<IdRow[]>`
            SELECT ei.media_id, ei.external_id, mi.media_type FROM external_ids ei
            JOIN media_items mi ON mi.id = ei.media_id
            WHERE ei.provider = 'tmdb'
                AND ei.external_id = ANY(${seriesTmdbIds})
                AND mi.media_type IN ('tv', 'series')
        `.catch(() => [] as IdRow[]);
        for (const row of seriesRows) {
            seriesMediaIdMap.set(
                `${row.external_id}:${normaliseTypeForKey(row.media_type)}`,
                row.media_id,
            );
        }
    }

    const episodeResolutionMap = new Map<string, string>();
    if (episodesNeedingResolution.length > 0) {
        const resolvePromises = episodesNeedingResolution.map(async (item) => {
            const seriesMediaId = item.seriesTmdbId
                ? seriesMediaIdMap.get(`${item.seriesTmdbId}:${normaliseTypeForKey('tv')}`)
                : undefined;
            if (!seriesMediaId) return;

            // Primary: series → season → episode (correct hierarchy)
            // eslint-disable-next-line callback-safety/no-unscoped-media-items -- system id-resolution for importing the user's OWN watch history; drills series→season→episode to an internal id, returns no user-facing rows, so no access scoping applies
            let epRows = await sql<Array<{ id: string }>>`
                SELECT ep.id FROM media_items ep
                JOIN media_items season
                    ON ep.parent_id = season.id
                    AND season.media_type = 'season'
                WHERE season.parent_id = ${seriesMediaId}::uuid
                    AND ep.season_number = ${item.seasonNumber!}
                    AND ep.episode_number = ${item.episodeNumber!}
                    AND ep.media_type = 'episode'
                LIMIT 1
            `.catch(() => [] as Array<{ id: string }>);

            // Fallback: orphaned episodes parented directly to series
            if (epRows.length === 0) {
                // eslint-disable-next-line callback-safety/no-unscoped-media-items -- system id-resolution for importing the user's OWN watch history; orphaned-episode fallback lookup to an internal id, returns no user-facing rows, so no access scoping applies
                epRows = await sql<Array<{ id: string }>>`
                    SELECT id FROM media_items
                    WHERE parent_id = ${seriesMediaId}::uuid
                        AND season_number = ${item.seasonNumber!}
                        AND episode_number = ${item.episodeNumber!}
                        AND media_type = 'episode'
                    LIMIT 1
                `.catch(() => [] as Array<{ id: string }>);
                if (epRows.length > 0) {
                    logger.warn('Episode resolved via direct parent (orphaned, no season row)', {
                        seriesMediaId,
                        season: item.seasonNumber,
                        episode: item.episodeNumber,
                    });
                }
            }

            const epId = epRows[0]?.id;
            if (epId) {
                episodeResolutionMap.set(item.providerId, epId);
                seriesResolved++;
                // Cache provider id → media_id so future lookups hit Strategy 2.
                // CatalogService enforces composite-key integrity.
                try {
                    await createCatalogService(sql).upsertExternalId(epId, {
                        provider: providerName,
                        id: item.providerId,
                        mediaType: 'episode',
                        source: 'watch-sync',
                    });
                } catch (err: unknown) {
                    logger.warn('Failed to cache episode external ID', {
                        error: String(err),
                        episodeId: epId,
                        providerId: item.providerId,
                    });
                }
            }
        });
        await Promise.allSettled(resolvePromises);
    }

    // Compose per-item resolution in the documented priority order.
    for (const item of items) {
        const internalId =
            (item.internalMediaId && existingInternalIds.has(item.internalMediaId)
                ? item.internalMediaId
                : undefined) ??
            (item.tmdbId
                ? tmdbIdMap.get(`${item.tmdbId}:${normaliseTypeForKey(item.mediaType)}`)
                : undefined) ??
            (item.imdbId
                ? imdbIdMap.get(`${item.imdbId}:${normaliseTypeForKey(item.mediaType)}`)
                : undefined) ??
            providerIdMap.get(
                `${normaliseProviderId(item.providerId)}:${normaliseTypeForKey(item.mediaType)}`,
            ) ??
            episodeResolutionMap.get(item.providerId);

        if (internalId) resolved.set(item.providerId, internalId);
    }

    // Write-back: cache any provider UUID that was NOT already in external_ids
    // (Strategy 2 hit) and wasn't already written by the Strategy 3 episode
    // drill-down above. This is the critical path for movies — the session
    // ingestion poller looks up `provider = <providerName>` in external_ids, so
    // without this write, movies resolved via TMDB (Strategy 1) would always
    // show as `no_media_match` in the admin live-sessions panel.
    // upsertExternalId reports whether it wrote; this call site is a cache warm-up
    // and does not act on the answer, so the result is deliberately discarded.
    const writeBackPromises: Promise<unknown>[] = [];
    for (const item of items) {
        const internalId = resolved.get(item.providerId);
        if (!internalId) continue;
        // Already in external_ids — no new mapping to store.
        if (
            providerIdMap.has(
                `${normaliseProviderId(item.providerId)}:${normaliseTypeForKey(item.mediaType)}`,
            )
        )
            continue;
        // Episodes resolved via Strategy 3 already wrote their mapping above.
        if (isEpisode(item.mediaType) && episodeResolutionMap.has(item.providerId)) continue;

        const mediaType = normaliseTypeForKey(item.mediaType) as MediaType;
        writeBackPromises.push(
            createCatalogService(sql)
                .upsertExternalId(internalId, {
                    provider: providerName,
                    id: item.providerId,
                    mediaType,
                    source: 'watch-sync',
                })
                .catch((err: unknown) => {
                    logger.warn('Failed to cache provider external ID', {
                        error: String(err),
                        internalId,
                        providerId: item.providerId,
                        mediaType: item.mediaType,
                    });
                }),
        );
    }
    await Promise.allSettled(writeBackPromises);

    return { resolved, seriesResolved };
}

/** An episode that shares a combined file with a resolved episode, after it. */
export interface CombinedFileSibling {
    mediaId: string;
    /** Length of the sibling's window in the file, when both offsets are known. */
    runtimeMs: number | null;
}

/**
 * The episodes that follow each given episode inside the combined multi-episode
 * file it plays from (`S28E12-13`, `S01E01-02-03`).
 *
 * A provider lists a combined file as ONE item (Jellyfin: IndexNumber 12,
 * IndexNumberEnd 13), so its Played flag resolves to the first episode only and
 * the rest stayed unwatched here. Watching the item means watching the file, so
 * a pulled watched mark covers every later episode on it — the same
 * forward-only rule the native player applies when playback passes a sibling's
 * window (watch-manager.service.ts). Only default files count, as in
 * getFileSiblingEpisodes: a combined file kept as an alternate version says
 * nothing about what was watched. Siblings in another season are a mislinked
 * file, not a combined one, and are left alone.
 *
 * Only a watched mark spreads. An unwatched provider item does not unmark the
 * siblings: a resume position on the file belongs to the anchor, and the
 * native player never unmarks a sibling either.
 */
export async function getLaterCombinedFileEpisodes(
    sql: postgres.Sql,
    episodeIds: readonly string[],
): Promise<Map<string, CombinedFileSibling[]>> {
    const byEpisode = new Map<string, CombinedFileSibling[]>();
    if (episodeIds.length === 0) return byEpisode;
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- system expansion of the user's OWN pulled watch marks to the episodes sharing the same file; returns no user-facing rows
    const rows = await sql<
        Array<{ episode_id: string; sibling_id: string; runtime_ms: string | null }>
    >`
        SELECT anchor.media_item_id AS episode_id,
               sib.media_item_id AS sibling_id,
               (sib.end_offset_ms - sib.start_offset_ms) AS runtime_ms
        FROM media_file_items anchor
        JOIN media_items anchor_ep ON anchor_ep.id = anchor.media_item_id
            AND anchor_ep.media_type = 'episode'
        JOIN media_file_items sib ON sib.file_id = anchor.file_id
            AND sib.is_default = true
            AND sib.media_item_id <> anchor.media_item_id
        JOIN media_items sib_ep ON sib_ep.id = sib.media_item_id
            AND sib_ep.media_type = 'episode'
            AND sib_ep.status = 'active'
        WHERE anchor.media_item_id = ANY(${[...new Set(episodeIds)]}::uuid[])
          AND anchor.is_default = true
          AND sib_ep.parent_id = anchor_ep.parent_id
          AND sib_ep.episode_number > anchor_ep.episode_number
        ORDER BY anchor.media_item_id, sib_ep.episode_number
    `;
    for (const row of rows) {
        const runtimeMs = row.runtime_ms === null ? null : Number(row.runtime_ms);
        const list = byEpisode.get(row.episode_id) ?? [];
        list.push({
            mediaId: row.sibling_id,
            runtimeMs:
                runtimeMs !== null && Number.isFinite(runtimeMs) && runtimeMs > 0
                    ? runtimeMs
                    : null,
        });
        byEpisode.set(row.episode_id, list);
    }
    return byEpisode;
}
