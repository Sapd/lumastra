// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Data assembly for the "Quick picks" tab on Settings → Music (admin IA
 * redesign, spec §3.6: music + alchemy + quick-picks are tabs on ONE page).
 * Extracted from the former standalone `/admin/music-quick-picks` route's
 * `+page.server.ts` load so the merged page's server load can compose it
 * alongside the settings-framework load without duplicating the query/cache
 * logic.
 */
import { aiDbService } from '$lib/server/services/database.service.js';
import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache';
import { getUserTasteClusters } from '$lib/server/services/music/taste-clusters.service.js';
import { Logger } from '$lib/server/utils/logger.js';
import { features } from '$lib/server/config.js';
import { isUserId } from '$lib/shared/user-id';

const logger = Logger.for('AdminMusicQuickPicks');

export interface BucketStat {
    bucket: string;
    count: number;
}

export interface UserOption {
    userId: string;
    playedCount: number;
}

/**
 * Admin-facing cluster view. Intentionally omits the raw centroid vector
 * (~12KB of floats each) — only size + sample track identifiers cross the
 * wire.
 */
export interface ClusterDisplay {
    size: number;
    sampleTrackIds: string[];
    sampleTracks: { id: string; title: string; artist: string | null }[];
}

export interface MusicQuickPicksData {
    featureClusteringEnabled: boolean;
    today: string;
    todayStats: BucketStat[];
    weekStats: BucketStat[];
    musicUsers: UserOption[];
    selectedUserId: string | null;
    selectedUserClusters: ClusterDisplay[] | null;
    selectedUserFallback: boolean;
}

const ALL_BUCKETS = [
    'heavy-rotation',
    'recently-heard',
    'hot-this-week',
    'popular-hits',
    'taste-similar',
    'sonic-taste',
    'sonic-discovery',
    'new-discovery',
    'highly-rated',
    'forgotten-favourites',
    'unplayed-from-loved-albums',
    'co-album',
    'deep-cuts',
    'random',
] as const;

function todayKey(): string {
    return new Date().toISOString().slice(0, 10);
}

function dateKey(daysAgo: number): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - daysAgo);
    return d.toISOString().slice(0, 10);
}

async function loadBucketStats(keys: string[]): Promise<Record<string, number>> {
    const cache = cacheManager.for(CACHE_NAMESPACES.musicQuickPicksStats);
    const totals: Record<string, number> = {};
    for (const bucket of ALL_BUCKETS) totals[bucket] = 0;
    for (const day of keys) {
        try {
            const dayStats = await cache.get<Record<string, number>>(`bucket-counts:${day}`);
            if (!dayStats) continue;
            for (const [bucket, count] of Object.entries(dayStats)) {
                totals[bucket] = (totals[bucket] ?? 0) + count;
            }
        } catch (err) {
            logger.debug('failed to load bucket stats for day', {
                day,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    return totals;
}

/** Loads the Quick Picks tab's data. `selectedUserId` mirrors the `?userId=` query param. */
export async function loadMusicQuickPicksData(
    selectedUserId: string | null,
): Promise<MusicQuickPicksData> {
    const sql = await aiDbService.getSql();

    if (!sql) {
        return {
            featureClusteringEnabled: features.musicClustering,
            today: todayKey(),
            todayStats: [],
            weekStats: [],
            musicUsers: [],
            selectedUserId,
            selectedUserClusters: null,
            selectedUserFallback: false,
        };
    }

    const today = todayKey();
    const weekKeys = Array.from({ length: 7 }, (_, i) => dateKey(i));

    // Each subquery is wrapped so an admin page load never 500s because one
    // of the three inputs (cache or DB) had a transient hiccup; the page
    // just renders with that section empty.
    const [todayMap, weekMap, userRows] = await Promise.all([
        loadBucketStats([today]).catch((err: unknown) => {
            logger.warn('admin: today bucket stats failed', {
                error: err instanceof Error ? err.message : String(err),
            });
            return {} as Record<string, number>;
        }),
        loadBucketStats(weekKeys).catch((err: unknown) => {
            logger.warn('admin: week bucket stats failed', {
                error: err instanceof Error ? err.message : String(err),
            });
            return {} as Record<string, number>;
        }),
        sql<{ user_id: string; played_count: number }[]>`
            SELECT user_id, COUNT(*)::int AS played_count
            FROM user_music_state
            WHERE play_count > 0
            GROUP BY user_id
            ORDER BY COUNT(*) DESC
            LIMIT 50
        `.catch((err: unknown) => {
            logger.warn('admin: music users query failed', {
                error: err instanceof Error ? err.message : String(err),
            });
            return [] as { user_id: string; played_count: number }[];
        }),
    ]);

    const todayStats: BucketStat[] = ALL_BUCKETS.map((b) => ({
        bucket: b,
        count: todayMap[b] ?? 0,
    }));
    const weekStats: BucketStat[] = ALL_BUCKETS.map((b) => ({
        bucket: b,
        count: weekMap[b] ?? 0,
    }));

    const musicUsers: UserOption[] = userRows.map((r) => ({
        userId: r.user_id,
        playedCount: r.played_count,
    }));

    let selectedUserClusters: ClusterDisplay[] | null = null;
    let selectedUserFallback = false;

    // The ?userId query param carries a users.id UUID (the value of the
    // musicUsers selector, mig 16.46.0). Validate the brand before keying.
    // toUserId THROWS on a non-UUID: a hand-edited or stale ?userId= used to
    // 500 the whole Music settings page.
    const selectedUid = isUserId(selectedUserId) ? selectedUserId : undefined;
    if (selectedUid) {
        try {
            const clusters = await getUserTasteClusters(sql, selectedUid);
            if (!clusters || clusters.length === 0) {
                selectedUserFallback = true;
            } else {
                // Hydrate sample track IDs into titles/artists for display.
                const allSampleIds = clusters.flatMap((c) => c.sampleTrackIds);
                const trackInfo =
                    allSampleIds.length > 0
                        ? await sql<
                              {
                                  id: string;
                                  title: string;
                                  artist: string | null;
                              }[]
                          >`
                            SELECT track.id, track.title,
                                   COALESCE(NULLIF(artist.title, 'Unknown Artist'), artist.title) AS artist
                            FROM media_items track
                            LEFT JOIN media_items album ON album.id = track.parent_id AND album.media_type = 'album'
                            LEFT JOIN media_items artist ON artist.id = album.parent_id AND artist.media_type = 'artist'
                            WHERE track.id = ANY(${allSampleIds})
                              AND track.media_type = 'track'
                          `
                        : [];
                const trackById = new Map(trackInfo.map((t) => [t.id, t]));
                selectedUserClusters = clusters.map((c) => ({
                    size: c.size,
                    sampleTrackIds: c.sampleTrackIds,
                    sampleTracks: c.sampleTrackIds
                        .map((id) => trackById.get(id))
                        .filter(
                            (
                                t,
                            ): t is {
                                id: string;
                                title: string;
                                artist: string | null;
                            } => Boolean(t),
                        ),
                }));
            }
        } catch (err) {
            logger.warn('admin: failed to load clusters for user', {
                userId: selectedUserId,
                error: err instanceof Error ? err.message : String(err),
            });
            selectedUserFallback = true;
        }
    } else if (selectedUserId) {
        // Not a user id at all: fall back instead of "Loading clusters…" forever.
        selectedUserFallback = true;
    }

    return {
        featureClusteringEnabled: features.musicClustering,
        today,
        todayStats,
        weekStats,
        musicUsers,
        selectedUserId,
        selectedUserClusters,
        selectedUserFallback,
    };
}
