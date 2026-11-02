// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { ApiSurface } from '$lib/shared/api-urls.js';
import { resolveImageSets } from '$lib/server/services/image-descriptor/index.js';
import { toMusicTrack } from './track-projection';

/**
 * Stations Service
 *
 * Exposes the user's k-means taste clusters as playable "stations" — the
 * Quick Picks work computes clusters silently in the background; stations
 * make them a first-class UI surface (chips above Quick Picks).
 *
 * Each station:
 *  - is labeled by the dominant artist in that cluster's sample tracks
 *    (fallback: "Station N")
 *  - serves a 50-track queue on click, sampled from tracks nearest to the
 *    cluster's centroid and MMR-reranked for diversity
 *  - dedupes against recently-played tracks so the queue feels fresh
 *
 * @module services/music/stations
 */

import { createHash } from 'node:crypto';
import { warmMusicCollages } from './collage-warmup.js';
import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';
import type { MusicTrack } from '$lib/schemas/music';
import type { UserContext } from '$lib/server/types.js';
import { Logger } from '$lib/server/utils/logger.js';
import {
    filterAccessibleMediaIds,
    filterAccessibleRows,
} from '$lib/server/utils/media-access-batch.js';
import {
    buildSearchAccessContext,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import { features } from '$lib/server/config.js';
import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache/index.js';
import {
    getUserTasteClusters,
    getUserSonicTasteClusters,
    type TasteCluster,
} from './taste-clusters.service.js';
import {
    getTracksNearCentroid,
    getSonicTracksNearCentroid,
    type CentroidNeighborRow,
} from '$lib/server/database/queries/music-quick-picks.queries.js';
import { getRecentlyPlayed } from '$lib/server/database/queries/music.queries.js';
import { mmrRerank } from '$lib/utils/mmr.js';
import { cosineSimilarity, parseEmbedding } from '$lib/server/utils/embedding-utils.js';
import { collapseTitleVariants } from '$lib/server/database/queries/music-title-normalize.js';

const logger = Logger.for('StationsService');

const DEFAULT_QUEUE_LIMIT = 50;
const OVERFETCH_MULTIPLIER = 3;
const RECENT_PLAY_EXCLUDE = 40;
/**
 * Weight applied to an artist's sample-track count when ranking station
 * labels. Each additional sample track an artist contributes is worth this
 * many "plays" of representativeness, so a broadly-representative artist isn't
 * out-ranked by a single high-play-count one-off in the sample.
 */
const ARTIST_REPRESENTATIVENESS_WEIGHT = 3;

export interface StationSummary {
    /**
     * Opaque handle `<version>.<n>`. `version` identifies the clustering the
     * station came from, so the id keeps meaning the station the listener saw.
     */
    id: string;
    /** Human-readable label — dominant artist or "Station N" */
    label: string;
    /** Number of played tracks assigned to this cluster — UX signal only */
    playedTrackCount: number;
    /** Subtle tagline under the chip ("12 tracks you love + more") */
    tagline: string;
    /**
     * The cluster's sample tracks the caller may see, in cluster ranking order —
     * the input for the station's cover collage. Empty when none are visible.
     */
    coverTrackIds: string[];
}

/** Embedding space a clustering lives in; kNN must use the matching space. */
export type StationSpace = 'sonic' | 'metadata';

/** The part of a clustering a station handle needs to be played later. */
export interface StationSnapshot {
    space: StationSpace;
    centroids: number[][];
}

interface CurrentClustering {
    space: StationSpace;
    clusters: TasteCluster[];
}

/** Snapshots outlive the 6 h clustering cache so stored ids keep working. */
const SNAPSHOT_KEY_PREFIX = 'snapshot:';
const CENTROID_DECIMALS = 5;
const VERSION_HEX_CHARS = 12;
const STATION_ID_PATTERN = /^([0-9a-f]{12})\.(\d{1,3})$/;

function roundCentroid(centroid: readonly number[]): number[] {
    const scale = 10 ** CENTROID_DECIMALS;
    return centroid.map((x) => Math.round(x * scale) / scale + 0);
}

/**
 * Hash of a clustering: embedding space, plus every cluster's centroid
 * (rounded to {@link CENTROID_DECIMALS} decimals) and size. Equal clusterings
 * hash equal; any change to a centroid or size changes the version.
 */
export function computeStationsVersion(
    space: StationSpace,
    clusters: ReadonlyArray<{ centroid: readonly number[]; size: number }>,
): string {
    const canonical = JSON.stringify({
        space,
        clusters: clusters.map((c) => ({
            centroid: roundCentroid(c.centroid),
            size: c.size,
        })),
    });
    return createHash('sha256').update(canonical).digest('hex').slice(0, VERSION_HEX_CHARS);
}

export function formatStationId(version: string, n: number): string {
    return `${version}.${n}`;
}

/** Split a station id into its version and cluster position; null when malformed. */
export function parseStationId(id: string): { version: string; n: number } | null {
    const match = STATION_ID_PATTERN.exec(id);
    if (!match) return null;
    return { version: match[1], n: Number.parseInt(match[2], 10) };
}

async function loadCurrentClustering(
    sql: postgres.Sql,
    userId: UserId,
): Promise<CurrentClustering | null> {
    // Prefer sonic clusters (MSCLAP audio space) when available; fall back to
    // metadata clusters when sonic coverage is insufficient or the flag is off.
    // The space tracks which embedding space the centroids are in so the
    // matching kNN function is used — mixing centroids from different spaces
    // would produce nonsense similarity scores.
    if (features.musicClusters) {
        const sonic = await getUserSonicTasteClusters(sql, userId);
        if (sonic) return { space: 'sonic', clusters: sonic };
    }
    const metadata = await getUserTasteClusters(sql, userId);
    return metadata ? { space: 'metadata', clusters: metadata } : null;
}

function snapshotCache() {
    return cacheManager.for(CACHE_NAMESPACES.musicTasteStationSnapshots);
}

type SnapshotLookup =
    { state: 'hit'; snapshot: StationSnapshot } | { state: 'missing' } | { state: 'error' };

/** Reads a stored snapshot, telling a missing key apart from a failed cache read. */
async function lookupSnapshot(userId: UserId, version: string): Promise<SnapshotLookup> {
    try {
        const cached = await snapshotCache().get<StationSnapshot>(
            `${SNAPSHOT_KEY_PREFIX}${version}`,
            userId,
        );
        if (
            cached &&
            (cached.space === 'sonic' || cached.space === 'metadata') &&
            Array.isArray(cached.centroids)
        ) {
            return { state: 'hit', snapshot: cached };
        }
        return { state: 'missing' };
    } catch (err) {
        logger.warn('station snapshot read failed', {
            userId,
            error: err instanceof Error ? err.message : String(err),
        });
        return { state: 'error' };
    }
}

/**
 * Stores the snapshot only when the key is absent: listing stations must not
 * rewrite (and so re-extend) an existing entry. A failed read skips the write.
 */
async function storeSnapshot(
    userId: UserId,
    version: string,
    current: CurrentClustering,
): Promise<void> {
    const existing = await lookupSnapshot(userId, version);
    if (existing.state !== 'missing') return;
    const snapshot: StationSnapshot = {
        space: current.space,
        centroids: current.clusters.map((c) => roundCentroid(c.centroid)),
    };
    try {
        await snapshotCache().set(`${SNAPSHOT_KEY_PREFIX}${version}`, snapshot, undefined, userId);
    } catch (err) {
        logger.warn('station snapshot store failed', {
            userId,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

/**
 * List the user's available stations, labeled by dominant artist within
 * each cluster's sample tracks. Returns null when clustering is disabled or
 * the user doesn't have enough play history.
 *
 * Also stores the clustering snapshot the returned ids resolve against.
 */
export async function getUserStations(
    sql: postgres.Sql,
    userId: UserId,
    userCtx?: UserContext,
): Promise<StationSummary[] | null> {
    const current = await loadCurrentClustering(sql, userId);
    if (!current || current.clusters.length === 0) return null;
    const { clusters } = current;

    const version = computeStationsVersion(current.space, clusters);
    await storeSnapshot(userId, version, current);

    // Filter every cluster's samples in ONE access query, then hand the
    // filtered lists to label resolution (without userCtx, so it does not
    // re-filter per cluster) and to the cover collage.
    let visibleSamples = clusters.map((c) => c.sampleTrackIds);
    if (userCtx) {
        const boundary = searchAccessBoundary(await buildSearchAccessContext(sql, userCtx));
        const allowed = await filterAccessibleMediaIds(
            sql,
            [...new Set(clusters.flatMap((c) => c.sampleTrackIds))],
            boundary,
        );
        // Filtered in place, not rebuilt from the unordered Set: the sample
        // order is the cluster's own ranking.
        visibleSamples = clusters.map((c) => c.sampleTrackIds.filter((id) => allowed.has(id)));
    }

    warmMusicCollages(sql, visibleSamples);

    const labels = await Promise.all(
        clusters.map((c, i) =>
            resolveStationLabel(sql, userId, { ...c, sampleTrackIds: visibleSamples[i] }, i),
        ),
    );

    return clusters.map((cluster, i) => ({
        id: formatStationId(version, i),
        label: labels[i],
        playedTrackCount: cluster.size,
        tagline: `${cluster.size} tracks you love + more like them`,
        coverTrackIds: visibleSamples[i],
    }));
}

/**
 * Resolve a human-readable label for a station from the sample track IDs.
 *
 * Strategy: pick the artist whose tracks (within the cluster's 5-sample
 * set) have the highest combined play-count for the user. Using play-count
 * instead of raw occurrence frequency means clusters with varied sample
 * artists still get a meaningful label — the "dominant" artist is the one
 * this user engages with most, not just the one lucky enough to appear
 * twice in the 5-track sample.
 *
 * Falls back to "Station N" only if no artist can be resolved at all
 * (e.g. all sample tracks lack artist metadata).
 *
 * Exported (in addition to being used internally by {@link getUserStations})
 * so integration tests can exercise the label-resolution SQL directly without
 * needing a full k-means clustering fixture (`getUserStations` only calls
 * this after `MIN_PLAYS_FOR_CLUSTERING` real plays exist).
 */
export async function resolveStationLabel(
    sql: postgres.Sql,
    userId: UserId,
    cluster: TasteCluster,
    index: number,
    userCtx?: UserContext,
): Promise<string> {
    const fallback = `Station ${index + 1}`;
    if (cluster.sampleTrackIds.length === 0) return fallback;

    // Filter sample tracks by current access so restricted artist names don't leak.
    let sampleIds = cluster.sampleTrackIds;
    if (userCtx) {
        const boundary = searchAccessBoundary(await buildSearchAccessContext(sql, userCtx));
        // Filtered in place rather than rebuilt from the returned Set, which
        // is unordered — the sample order is the cluster's own ranking.
        const allowed = await filterAccessibleMediaIds(sql, sampleIds, boundary);
        sampleIds = sampleIds.filter((id) => allowed.has(id));
    }
    if (sampleIds.length === 0) return fallback;

    try {
        const rows = await sql<
            {
                artist_title: string;
                total_plays: number;
                track_count: number;
            }[]
        >`
            SELECT artist.title AS artist_title,
                   SUM(COALESCE(ums.play_count, 0))::int AS total_plays,
                   COUNT(*)::int AS track_count
            FROM media_items track
            LEFT JOIN user_music_state ums
              ON ums.track_id = track.id AND ums.user_id = ${userId}
            LEFT JOIN media_items album
              ON album.id = track.parent_id AND album.media_type = 'album'
            LEFT JOIN media_items artist
              ON artist.id = album.parent_id AND artist.media_type = 'artist'
            WHERE track.id = ANY(${sampleIds})
              AND track.media_type = 'track'
              AND artist.title IS NOT NULL
              AND artist.title != 'Unknown Artist'
              AND artist.is_various_artists = false
            GROUP BY artist.title
            -- Blend within-cluster representativeness (track_count, how much of
            -- the sample this artist actually covers) with engagement
            -- (total_plays). Without the track_count weight a single
            -- high-play-count sample track can out-rank an artist that
            -- genuinely dominates the cluster with several sample tracks.
            ORDER BY (COUNT(*)::float * ${ARTIST_REPRESENTATIVENESS_WEIGHT}
                      + SUM(COALESCE(ums.play_count, 0))::float) DESC,
                     COUNT(*) DESC,
                     SUM(COALESCE(ums.play_count, 0)) DESC,
                     artist.title ASC
            LIMIT 2
        `;
        if (rows.length === 0) return fallback;
        const top = rows[0].artist_title;
        // If a second artist is at least 40% as prominent as the first,
        // show both — "DJ Manian + R.I.O." is more descriptive than "DJ
        // Manian" for a 40/35 split cluster. Under the threshold it's
        // clearly dominated by one artist and the second is just noise.
        if (rows.length === 2) {
            const score = (r: { total_plays: number; track_count: number }) =>
                r.total_plays > 0 ? r.total_plays : r.track_count;
            const topScore = score(rows[0]);
            const secondScore = score(rows[1]);
            if (topScore > 0 && secondScore / topScore >= 0.4) {
                return `${top} + ${rows[1].artist_title}`;
            }
        }
        return top;
    } catch (err) {
        logger.debug('station label resolution failed', {
            userId: cluster.sampleTrackIds[0],
            error: err instanceof Error ? err.message : String(err),
        });
        return fallback;
    }
}

export type StationQueueResult =
    | { kind: 'ok'; tracks: MusicTrack[]; truncated: boolean }
    /** The id is not of the form `<version>.<n>`. */
    | { kind: 'invalid' }
    /** The id's clustering is gone and the current one differs: list stations again. */
    | { kind: 'expired' }
    /** The id's clustering is known but has no station at that position. */
    | { kind: 'not_found' }
    /** The snapshot store could not be read and the current clustering differs: transient. */
    | { kind: 'unavailable' };

/**
 * Resolve a station id to the centroid and embedding space it was listed
 * with. The stored snapshot wins; without one the id is accepted only when the
 * user's current clustering has the same version.
 */
async function resolveStationCentroid(
    sql: postgres.Sql,
    userId: UserId,
    parsed: { version: string; n: number },
): Promise<{ centroid: number[]; space: StationSpace } | 'expired' | 'not_found' | 'unavailable'> {
    const lookup = await lookupSnapshot(userId, parsed.version);
    let snapshot: StationSnapshot;
    if (lookup.state === 'hit') {
        // The kill switch must reach stored ids too: a sonic handle is dead while
        // sonic clusters are switched off.
        if (lookup.snapshot.space === 'sonic' && !features.musicClusters) return 'expired';
        snapshot = lookup.snapshot;
    } else {
        const current = await loadCurrentClustering(sql, userId);
        if (
            !current ||
            computeStationsVersion(current.space, current.clusters) !== parsed.version
        ) {
            // A failed read says nothing about whether the snapshot exists, so it
            // must not be reported as expired.
            return lookup.state === 'error' ? 'unavailable' : 'expired';
        }
        await storeSnapshot(userId, parsed.version, current);
        snapshot = { space: current.space, centroids: current.clusters.map((c) => c.centroid) };
    }
    const centroid = snapshot.centroids[parsed.n];
    if (!centroid) return 'not_found';
    return { centroid, space: snapshot.space };
}

/**
 * Build a play queue for a given station id: kNN on the station's centroid,
 * MMR for diversity, recently-played excluded so every queue feels fresh.
 */
export async function getStationQueue(
    sql: postgres.Sql,
    userId: UserId,
    stationId: string,
    limit: number = DEFAULT_QUEUE_LIMIT,
    userCtx?: UserContext,
    surface: ApiSurface = 'internal',
): Promise<StationQueueResult> {
    const parsed = parseStationId(stationId);
    if (!parsed) return { kind: 'invalid' };

    const resolved = await resolveStationCentroid(sql, userId, parsed);
    if (typeof resolved === 'string') return { kind: resolved };
    const { centroid, space } = resolved;
    const isSonic = space === 'sonic';

    const recent = await getRecentlyPlayed(sql, userId, RECENT_PLAY_EXCLUDE);
    const excludeIds = recent.map((t) => t.id);

    let candidates: CentroidNeighborRow[];
    try {
        candidates = isSonic
            ? await getSonicTracksNearCentroid(
                  sql,
                  userId,
                  centroid,
                  excludeIds,
                  limit * OVERFETCH_MULTIPLIER,
              )
            : await getTracksNearCentroid(
                  sql,
                  userId,
                  centroid,
                  excludeIds,
                  limit * OVERFETCH_MULTIPLIER,
              );
    } catch (err) {
        logger.warn('station queue kNN failed', {
            userId,
            stationId,
            isSonic,
            error: err instanceof Error ? err.message : String(err),
        });
        // Rethrow, never return an empty queue: callers read an empty queue as
        // "this station has nothing playable" (the v1 route answers 404), so a
        // swallowed DB failure told clients a station was permanently empty.
        throw err;
    }

    if (candidates.length === 0) return { kind: 'ok', tracks: [], truncated: false };

    // Filter candidates by caller's library + age access.
    //
    // One batch query, not a `checkMediaAccess` per candidate. The pool here
    // is `limit * OVERFETCH_MULTIPLIER`, so the old sequential loop cost 150
    // serial round trips at the documented max limit of 100.
    //
    // It was also gated on the caller having denied library groups, which
    // silently skipped the AGE check for everyone else: a user with an age
    // ceiling but no library restrictions got station queues filtered by
    // neither. `filterAccessibleRows` applies both axes, and short-circuits
    // without a query when the boundary restricts nothing.
    let accessibleCandidates = candidates;
    if (userCtx) {
        const boundary = searchAccessBoundary(await buildSearchAccessContext(sql, userCtx));
        accessibleCandidates = await filterAccessibleRows(sql, candidates, boundary);
    }

    if (accessibleCandidates.length === 0) return { kind: 'ok', tracks: [], truncated: false };

    // B2: collapse remix/edit/live variants of the same song down to one
    // (preferring the untagged original) before MMR — otherwise the kNN
    // pool can hand MMR both a track and its remix as if they were two
    // distinct picks. Artist key prefers artist_id (stable across name
    // variants); falls back to the lowercased artist name, then to '' when
    // a candidate carries no artist info at all — in that last case every
    // artist-less candidate shares the same key component, so grouping
    // effectively falls back to normalized title alone, as intended.
    const deduped = collapseTitleVariants(
        accessibleCandidates,
        (c) => c.title,
        (c) => c.artist_id ?? (c.artist_title ?? '').toLowerCase(),
    );

    const reranked = mmrRerank(deduped, {
        count: Math.min(limit, deduped.length),
        relevance: (c) => c.similarity ?? 0,
        similarity: (a, b) =>
            cosineSimilarity(parseEmbedding(a.embedding), parseEmbedding(b.embedding)),
    });

    const imageSets = await resolveImageSets(
        sql,
        surface,
        reranked.map((row) => ({ id: row.id, mediaType: 'track' })),
    );
    return {
        kind: 'ok',
        tracks: reranked.map((row) => toMusicTrack(row, imageSets.get(row.id) ?? {})),
        truncated: deduped.length > limit,
    };
}
