// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `GET /Items/Latest` (+ legacy `/Users/{userId}/Items/Latest`), Jellyfin's
 * UserLibraryController.GetLatestMedia:
 *
 * - `IncludeItemTypes` picks movies / episodes / series; types Lumastra's
 *   Latest does not list (music, books, …) yield nothing.
 * - `IsPlayed`; when absent the user's `HidePlayedInLatest` applies, which
 *   `/j` always reports as true — so watched items drop out, like Jellyfin.
 * - `GroupItems=true` (default): newly added episodes are grouped like
 *   BaseItemRepository.GetLatestTvShowItems — the episode itself when only one
 *   landed, its season when several landed in one season of a multi-season
 *   series, else the series. `GroupItems=false` lists episodes one by one.
 * - Rows carry the user's real data (watched state, progress, favourite), and
 *   series/seasons their episode counts.
 * - `Fields` is accepted; `/j` always sends a superset of what it names.
 */

import { json, type RequestEvent } from '@sveltejs/kit';
import type postgres from 'postgres';
import { getDb } from '$lib/server/database';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import type { UserId } from '$lib/shared/user-id';
import { getParam, getJfToken } from './utils';
import { buildJellyfinAccessContext } from './access-context';
import { mapRowToMediaItem, serializeBaseItems } from './serializers/base-item';
import { applyJellyfinContentLanguage } from './content-language';
import { applyFolderUserData } from './folder-user-data';
import { enrichItemsWithMediaSources, dropFilelessPlayables } from './media-source-enrichment';
import { enrichItemsWithProviderIds } from './provider-ids-enrichment';
import { enrichItemsWithMusicArtists } from './music-artists-enrichment';
import { enrichItemsWithImages } from './image-enrichment';
import { parseDtoOptions, shapeItems } from './dto-options';
import { enrichItemsForList } from './item-details-enrichment';
import { USER_ROOT_FOLDER_ID } from './constants';
import { isSeries } from '$lib/server/utils/media-types.js';
import {
    browseMediaItems,
    getLatestItems,
    mapJellyfinTypes,
} from '$lib/server/database/queries/jellyfin-browse.queries';
import {
    getLatestSeriesGroups,
    RECENT_ADDITION_WINDOW_HOURS,
    type LatestSeriesGroup,
} from '$lib/server/database/queries/jellyfin-latest-groups.queries';
import {
    getFolderEpisodeCounts,
    type FolderEpisodeCounts,
} from '$lib/server/database/queries/jellyfin-folder-counts.queries';
import type { MediaAccessBoundary } from '$lib/server/database/queries/builders/media-access-boundary';

const logger = Logger.for('JellyfinCompat:Latest');

const MAX_LIMIT = 100;

export interface LatestQuery {
    limit: number;
    parentId: string | null;
    groupItems: boolean;
    /** DB media types to rank; empty = the client asked only for types Latest has none of. */
    mediaTypes: string[];
    /** Rank series and expand them into their newly added episodes (vs. list the series). */
    expandSeries: boolean;
    isPlayed: boolean | null;
    enableUserData: boolean;
}

function bool(value: string | null): boolean | null {
    const v = value?.trim().toLowerCase();
    return v === 'true' ? true : v === 'false' ? false : null;
}

/** `/j` reports `HidePlayedInLatest: true` for every user (serializers/user.ts). */
const HIDE_PLAYED_IN_LATEST = true;

export function parseLatestQuery(url: URL): LatestQuery {
    const rawLimit = parseInt(getParam(url, 'Limit') ?? '20', 10);
    const limit = Math.min(Math.max(0, isNaN(rawLimit) ? 20 : rawLimit), MAX_LIMIT);
    const rawParent = getParam(url, 'ParentId');
    const parentId =
        rawParent && rawParent.replace(/-/g, '').toLowerCase() !== USER_ROOT_FOLDER_ID
            ? rawParent
            : null;
    const groupItems = bool(getParam(url, 'GroupItems')) !== false;
    const include = getParam(url, 'IncludeItemTypes');
    const requested = include ? new Set(mapJellyfinTypes(include)) : null;
    const wantsMovie = !requested || requested.has('movie');
    const wantsEpisode = !requested || requested.has('episode');
    const wantsSeries = requested?.has('tv') ?? false;

    const mediaTypes: string[] = [];
    if (wantsMovie) mediaTypes.push('movie');
    if (groupItems) {
        if (wantsEpisode || wantsSeries) mediaTypes.push('tv');
    } else {
        if (wantsEpisode) mediaTypes.push('episode');
        if (wantsSeries) mediaTypes.push('tv');
    }
    const isPlayedParam = bool(getParam(url, 'IsPlayed'));
    return {
        limit,
        parentId,
        groupItems,
        mediaTypes,
        expandSeries: groupItems && wantsEpisode,
        isPlayed: isPlayedParam ?? (HIDE_PLAYED_IN_LATEST ? false : null),
        enableUserData: bool(getParam(url, 'EnableUserData')) !== false,
    };
}

/**
 * GetLatestTvShowItems step 5: which item stands for a series' recent
 * additions. `counts` holds the series' visible season count (`childCount`)
 * and each season's episode total. Null = nothing to show for the series.
 */
export function chooseLatestRepresentative(
    group: LatestSeriesGroup | undefined,
    counts: ReadonlyMap<string, FolderEpisodeCounts>,
): string | null {
    if (!group || group.recentCount === 0) return null;
    if (group.seasonIds.length > 1) return group.seriesId;
    const seasonId = group.seasonIds[0];
    const episodesInSeason = counts.get(seasonId)?.totalCount ?? 0;
    const seasonsInSeries = counts.get(group.seriesId)?.childCount ?? 1;
    const multipleOrAll = group.recentCount > 1 || group.recentCount === episodesInSeason;
    if (!multipleOrAll) return group.newestEpisodeId;
    return seasonsInSeries > 1 ? seasonId : group.seriesId;
}

/** One Latest slot: the item to show, and the series to show if that row is not listable. */
export interface LatestSlot {
    id: string;
    fallbackId?: string;
}

/**
 * Ranked titles fetched per slot when grouping: a series' place depends on its
 * newest episode that passes the filters (not on its newest file overall), and
 * a series with no such episode drops out, so the ranking over-fetches like
 * Jellyfin's `Limit * 2` and the slots are re-sorted and trimmed.
 */
const GROUPED_OVERFETCH = 2;

/**
 * The slots the Latest row shows, in order: ranked movies / series, each ranked
 * series replaced by what stands for its new episodes when grouping. Returns
 * the folder counts it fetched so serialization can reuse them.
 */
export async function resolveLatestIds(
    sql: postgres.Sql,
    q: LatestQuery,
    userId: UserId,
    access: MediaAccessBoundary,
): Promise<{ slots: LatestSlot[]; counts: Map<string, FolderEpisodeCounts> }> {
    const counts = new Map<string, FolderEpisodeCounts>();
    if (q.mediaTypes.length === 0 || q.limit === 0) return { slots: [], counts };
    const ranked = await getLatestItems(sql, {
        limit: q.expandSeries ? q.limit * GROUPED_OVERFETCH : q.limit,
        parentId: q.parentId,
        groupItems: q.groupItems,
        access,
        mediaTypes: q.mediaTypes,
        isPlayed: q.isPlayed,
        userId,
    });
    const rows = ranked.map((r) => ({
        id: String(r.id),
        type: String(r.media_type),
        added: new Date(r.latest_added as string | Date),
    }));
    if (!q.expandSeries) return { slots: rows.map((r) => ({ id: r.id })), counts };

    const seriesIds = rows.filter((r) => isSeries(r.type)).map((r) => r.id);
    // GetLatestTvShowItems' global cutoff: no ranked series' window reaches
    // further back than the oldest ranked series' newest file minus the window.
    const seriesAdded = rows.filter((r) => isSeries(r.type)).map((r) => r.added.getTime());
    const addedSince =
        seriesAdded.length > 0
            ? new Date(Math.min(...seriesAdded) - RECENT_ADDITION_WINDOW_HOURS * 3_600_000)
            : null;
    const groupsSince = (since: Date | null) =>
        getLatestSeriesGroups(sql, {
            seriesIds,
            userId,
            access,
            isPlayed: q.isPlayed,
            addedSince: since,
        });
    let groups = await groupsSince(addedSince);
    // The cutoff comes from each series' newest file overall, but a series is
    // placed by its newest episode that passes the filters (unwatched, visible),
    // which can be older than the cutoff. When that leaves the row short while
    // a ranked series found no group, read once more without the cutoff: the
    // common case keeps the fast path, the rest stays exact.
    const movieCount = rows.length - seriesIds.length;
    if (
        addedSince &&
        movieCount + groups.size < q.limit &&
        seriesIds.some((id) => !groups.has(id))
    ) {
        groups = await groupsSince(null);
    }
    const singleSeasonIds = [...groups.values()]
        .filter((g) => g.seasonIds.length === 1)
        .map((g) => g.seasonIds[0]);
    const fetched = await getFolderEpisodeCounts(sql, {
        folderIds: [...seriesIds, ...singleSeasonIds],
        userId,
        access,
    });
    for (const [k, v] of fetched) counts.set(k, v);

    const dated: { slot: LatestSlot; added: number; key: string }[] = [];
    for (const r of rows) {
        if (!isSeries(r.type)) {
            dated.push({ slot: { id: r.id }, added: r.added.getTime(), key: r.id });
            continue;
        }
        const group = groups.get(r.id);
        const chosen = chooseLatestRepresentative(group, counts);
        if (!chosen || !group) continue;
        // An episode / season row can be unlistable where its series is not
        // (age-limited users and unrated episode rows): keep the series then.
        dated.push({
            slot: chosen === r.id ? { id: r.id } : { id: chosen, fallbackId: r.id },
            added: group.newestAdded.getTime(),
            key: chosen,
        });
    }
    // GetLatestTvShowItems: newest first, ties by id descending.
    dated.sort((a, b) => b.added - a.added || (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
    return { slots: dated.slice(0, q.limit).map((d) => d.slot), counts };
}

export async function handleLatestRequest(event: RequestEvent): Promise<Response> {
    const { locals, url } = event;
    const sql = getDb();
    if (!sql) return ApiResponses.error('Database unavailable');

    const q = parseLatestQuery(url);
    const dto = parseDtoOptions(url);
    const user = locals.user;
    const access = await buildJellyfinAccessContext(sql, user);

    try {
        const { slots, counts } = await resolveLatestIds(sql, q, user.userId, access.boundary);
        if (slots.length === 0) return json([]);
        const ids = [
            ...new Set(slots.flatMap((s) => (s.fallbackId ? [s.id, s.fallbackId] : [s.id]))),
        ];

        // Re-read the chosen ids through the browse query: the same row shape
        // (user data, favourite, series/season names) as every /Items list.
        const { rows } = await browseMediaItems(sql, {
            mediaTypes: [],
            parentId: null,
            searchTerm: null,
            genres: [],
            years: [],
            nameStartsWith: null,
            isFavoriteFilter: false,
            isPlayedFilter: false,
            isUnplayedFilter: false,
            enableUserData: q.enableUserData,
            userId: user.userId,
            idList: ids,
            orderByIdList: true,
            sortBy: 'SortName',
            sortOrder: 'Ascending',
            limit: ids.length,
            startIndex: 0,
            access: access.boundary,
        });

        const byId = new Map(rows.map((r) => [String(r.id), r]));
        const picked: postgres.Row[] = [];
        const seen = new Set<string>();
        for (const slot of slots) {
            const row =
                byId.get(slot.id) ?? (slot.fallbackId ? byId.get(slot.fallbackId) : undefined);
            if (!row || seen.has(String(row.id))) continue;
            seen.add(String(row.id));
            picked.push(row);
        }

        const items = picked.map(mapRowToMediaItem);
        await applyJellyfinContentLanguage(sql, user.userId, items);
        await applyFolderUserData(sql, items, user.userId, access.boundary, counts);
        const serialized = serializeBaseItems(items);
        // Movies/Episodes need MediaSources/Container/Path or Infuse silently
        // drops them — same shape contract as the browse + search paths.
        // Then drop fileless playables: a single malformed episode would
        // otherwise break the whole array decode.
        const apiKey = getJfToken(locals as unknown as Record<string, unknown>);
        await enrichItemsWithMediaSources(sql, serialized, apiKey);
        await enrichItemsWithProviderIds(sql, serialized);
        await enrichItemsWithMusicArtists(sql, serialized);
        if (dto.enableImages) await enrichItemsWithImages(sql, serialized);
        await enrichItemsForList(sql, serialized, dto);
        const filtered = dropFilelessPlayables(serialized);
        shapeItems(filtered, dto);

        logger.info('Latest items', {
            parentId: q.parentId,
            count: filtered.length,
            limit: q.limit,
            groupItems: q.groupItems,
        });
        return json(filtered);
    } catch (error) {
        logger.error('Latest items query failed', error as Error);
        return ApiResponses.error('Failed to get latest items');
    }
}
