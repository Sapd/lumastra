// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Episode Test Fixtures
 *
 * Provides factory functions for creating test series, seasons, and episodes.
 */

import type { Sql } from 'postgres';
import { createAndInsertTestTvShow, SAMPLE_TV_SHOWS } from './media.fixtures.js';
import { ensureTestUser } from './user.fixtures.js';
import { normalizeJellyfinId } from '../../../src/lib/server/utils/jellyfin-id.js';

// =============================================================================
// Types
// =============================================================================

export interface TestJellyfinEpisode {
    jellyfin_id: string;
    series_jellyfin_id: string;
    series_id?: string; // Alternative field name
    media_items_id?: string; // UUID in media_items table (set after insert)
    season_number: number;
    episode_number: number;
    title: string;
    overview: string | null;
    runtime_seconds: number | null;
    runtime_ticks: number | null; // Computed: runtime_seconds * 10,000,000
    air_date: Date | null; // Maps to premiere_date in DB
}

export interface TestJellyfinSeason {
    jellyfin_id: string;
    series_jellyfin_id: string;
    season_number: number;
    episode_count: number;
}

export interface TestSeriesWithEpisodes {
    seriesId: string;
    seriesJellyfinId: string;
    tmdbId: number;
    seasons: Array<{
        seasonNumber: number;
        jellyfinId: string;
        episodes: TestJellyfinEpisode[];
    }>;
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Generate a Jellyfin-style ID.
 */
function generateJellyfinId(_prefix: string = 'jf'): string {
    const hex = () => Math.random().toString(16).substring(2, 10);
    return `${hex()}${hex()}${hex()}${hex()}`.substring(0, 32);
}

/**
 * Create a test episode.
 */
export function createTestEpisode(
    seriesJellyfinId: string,
    seasonNumber: number,
    episodeNumber: number,
    options: {
        jellyfinId?: string;
        title?: string;
        overview?: string;
        runtimeSeconds?: number;
    } = {},
): TestJellyfinEpisode {
    const jellyfinId = options.jellyfinId || generateJellyfinId('ep');
    const runtimeSeconds = options.runtimeSeconds ?? 45 * 60; // Default 45 min

    return {
        jellyfin_id: jellyfinId,
        series_jellyfin_id: seriesJellyfinId,
        series_id: seriesJellyfinId, // Both field names for compatibility
        season_number: seasonNumber,
        episode_number: episodeNumber,
        title: options.title || `Episode ${episodeNumber}`,
        overview: options.overview ?? `Test episode S${seasonNumber}E${episodeNumber}`,
        runtime_seconds: runtimeSeconds,
        runtime_ticks: runtimeSeconds ? runtimeSeconds * 10_000_000 : null,
        air_date: new Date(),
    };
}

/**
 * Create a test season with episodes.
 */
export function createTestSeason(
    seriesJellyfinId: string,
    seasonNumber: number,
    episodeCount: number,
    options: {
        seasonJellyfinId?: string;
        episodeRuntimeSeconds?: number;
    } = {},
): {
    season: TestJellyfinSeason;
    episodes: TestJellyfinEpisode[];
} {
    const seasonJellyfinId = options.seasonJellyfinId || generateJellyfinId('season');

    const season: TestJellyfinSeason = {
        jellyfin_id: seasonJellyfinId,
        series_jellyfin_id: seriesJellyfinId,
        season_number: seasonNumber,
        episode_count: episodeCount,
    };

    const episodes: TestJellyfinEpisode[] = [];
    for (let ep = 1; ep <= episodeCount; ep++) {
        episodes.push(
            createTestEpisode(seriesJellyfinId, seasonNumber, ep, {
                runtimeSeconds: options.episodeRuntimeSeconds,
            }),
        );
    }

    return { season, episodes };
}

/**
 * Create a complete test series structure with seasons and episodes.
 */
export function createTestSeriesStructure(
    seriesJellyfinId: string,
    config: {
        seasonCount: number;
        episodesPerSeason: number;
        episodeRuntimeSeconds?: number;
    },
): {
    seasons: TestJellyfinSeason[];
    episodes: TestJellyfinEpisode[];
} {
    const seasons: TestJellyfinSeason[] = [];
    const episodes: TestJellyfinEpisode[] = [];

    for (let s = 1; s <= config.seasonCount; s++) {
        const { season, episodes: seasonEpisodes } = createTestSeason(
            seriesJellyfinId,
            s,
            config.episodesPerSeason,
            { episodeRuntimeSeconds: config.episodeRuntimeSeconds },
        );
        seasons.push(season);
        episodes.push(...seasonEpisodes);
    }

    return { seasons, episodes };
}

// =============================================================================
// Insert Functions
// =============================================================================

/**
 * Insert a test episode into the database.
 */
export async function insertTestEpisode(
    sql: Sql,
    episode: TestJellyfinEpisode,
    seasonMediaItemId: string,
): Promise<string> {
    const episodeId = crypto.randomUUID();

    // Insert episode into media_items
    await sql`
        INSERT INTO media_items (id, title, media_type, parent_id, season_number, episode_number, overview, runtime_seconds, premiere_date, status)
        VALUES (
            ${episodeId}::uuid,
            ${episode.title},
            'episode',
            ${seasonMediaItemId}::uuid,
            ${episode.season_number},
            ${episode.episode_number},
            ${episode.overview},
            ${episode.runtime_seconds},
            ${episode.air_date},
            'active'
        )
    `;

    // Insert Jellyfin external ID (direct SQL acceptable in test fixtures)
    // Normalize to dashless format to match query-side normalization.
    // eslint-disable-next-line no-restricted-syntax
    await sql`
        INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
        VALUES (${episodeId}::uuid, 'jellyfin', ${normalizeJellyfinId(episode.jellyfin_id)}, 'episode', false)
    `;

    return episodeId;
}

/**
 * Insert multiple test episodes.
 */
export async function insertTestEpisodes(
    sql: Sql,
    episodes: TestJellyfinEpisode[],
    seasonMediaItemId: string,
): Promise<void> {
    for (const episode of episodes) {
        await insertTestEpisode(sql, episode, seasonMediaItemId);
    }
}

/**
 * Insert a test season into the database.
 */
export async function insertTestSeason(
    sql: Sql,
    season: TestJellyfinSeason,
    seriesMediaItemId: string,
): Promise<string> {
    const seasonId = crypto.randomUUID();

    // Insert season into media_items
    await sql`
        INSERT INTO media_items (id, title, media_type, parent_id, season_number, status)
        VALUES (
            ${seasonId}::uuid,
            ${'Season ' + season.season_number},
            'season',
            ${seriesMediaItemId}::uuid,
            ${season.season_number},
            'active'
        )
    `;

    // Insert Jellyfin external ID for the season (direct SQL acceptable in test fixtures)
    // Normalize to dashless format to match query-side normalization.
    // eslint-disable-next-line no-restricted-syntax
    await sql`
        INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
        VALUES (${seasonId}::uuid, 'jellyfin', ${normalizeJellyfinId(season.jellyfin_id)}, 'season', false)
    `;

    return seasonId;
}

/**
 * Insert multiple test seasons.
 */
export async function insertTestSeasons(
    sql: Sql,
    seasons: TestJellyfinSeason[],
    seriesMediaItemId: string,
): Promise<Map<number, string>> {
    const seasonIds = new Map<number, string>();
    for (const season of seasons) {
        const seasonId = await insertTestSeason(sql, season, seriesMediaItemId);
        seasonIds.set(season.season_number, seasonId);
    }
    return seasonIds;
}

// =============================================================================
// Convenience Functions
// =============================================================================

/**
 * Create and insert a complete test series with seasons and episodes.
 */
export async function createAndInsertTestSeries(
    sql: Sql,
    options: {
        title?: string;
        tmdbId?: number;
        seasonCount?: number;
        episodesPerSeason?: number;
        episodeRuntimeSeconds?: number;
    } = {},
): Promise<TestSeriesWithEpisodes> {
    const sample = SAMPLE_TV_SHOWS[Math.floor(Math.random() * SAMPLE_TV_SHOWS.length)];
    const seasonCount = options.seasonCount ?? sample.seasons;
    const episodesPerSeason = options.episodesPerSeason ?? sample.episodes_per_season;

    // Generate unique jellyfin ID to avoid conflicts between tests
    const uniqueJellyfinId = `jf-series-${crypto.randomUUID().slice(0, 12)}`;

    // Create the TV show in media_items
    const { id: seriesId, tmdbId } = await createAndInsertTestTvShow(sql, {
        title: options.title || sample.title,
        // Unique per call: a bare sample id collides (external_ids unique key) when a test
        // inserts two series and the random sample picks the same show (1 in 3).
        tmdbId: options.tmdbId || sample.tmdb_id + 1 + Math.floor(Math.random() * 900000),
        jellyfinId: uniqueJellyfinId,
    });

    const seriesJellyfinId = uniqueJellyfinId;

    // Create seasons and episodes
    const { seasons, episodes } = createTestSeriesStructure(seriesJellyfinId, {
        seasonCount,
        episodesPerSeason,
        episodeRuntimeSeconds: options.episodeRuntimeSeconds,
    });

    // Insert into database using media_items hierarchy
    const seasonIds = await insertTestSeasons(sql, seasons, seriesId);

    // Insert episodes under their season media_items
    for (const season of seasons) {
        const seasonMediaItemId = seasonIds.get(season.season_number)!;
        const seasonEpisodes = episodes.filter((ep) => ep.season_number === season.season_number);
        for (const ep of seasonEpisodes) {
            await insertTestEpisode(sql, ep, seasonMediaItemId);
        }
    }

    // Build result structure
    const result: TestSeriesWithEpisodes = {
        seriesId,
        seriesJellyfinId,
        tmdbId,
        seasons: seasons.map((season) => ({
            seasonNumber: season.season_number,
            jellyfinId: season.jellyfin_id,
            episodes: episodes.filter((ep) => ep.season_number === season.season_number),
        })),
    };

    return result;
}

/**
 * Create test watch status for episodes.
 */
export async function insertTestEpisodeWatchStatus(
    sql: Sql,
    userId: string,
    episodeJellyfinId: string,
    options: {
        isWatched?: boolean;
        playbackPositionTicks?: number;
        runtimeTicks?: number;
    } = {},
): Promise<void> {
    const isWatched = options.isWatched ?? true;
    const runtimeTicks = options.runtimeTicks ?? 45 * 60 * 10_000_000;
    const playbackPositionTicks = options.playbackPositionTicks ?? (isWatched ? runtimeTicks : 0);

    // Convert ticks to ms
    const resumePositionMs = playbackPositionTicks ? (playbackPositionTicks / 10000) >>> 0 : 0;
    const runtimeMs = runtimeTicks ? (runtimeTicks / 10000) >>> 0 : null;

    await ensureTestUser(sql, userId);
    // Resolve Jellyfin ID → media_items UUID
    const [row] = await sql<{ media_id: string }[]>`
        SELECT media_id FROM external_ids
        WHERE provider = 'jellyfin' AND external_id = ${episodeJellyfinId} AND media_type = 'episode'
        LIMIT 1
    `;

    if (!row) {
        throw new Error(
            `Test fixture error: episode ${episodeJellyfinId} not found in external_ids`,
        );
    }

    // Migration 12.44.0 renamed user_watch_state → user_media_state and
    // dropped the standalone `updated_at` column (the derived row has
    // last_event_at / last_watched_at instead).
    await sql`
        INSERT INTO user_media_state (
            user_id, media_id, is_watched,
            resume_position_ms, runtime_ms, last_watched_at, last_event_at
        )
        VALUES (
            ${userId},
            ${row.media_id}::uuid,
            ${isWatched},
            ${resumePositionMs},
            ${runtimeMs},
            ${isWatched ? new Date() : null},
            NOW()
        )
        ON CONFLICT (user_id, media_id) DO UPDATE SET
            is_watched = EXCLUDED.is_watched,
            resume_position_ms = EXCLUDED.resume_position_ms,
            runtime_ms = EXCLUDED.runtime_ms,
            last_watched_at = EXCLUDED.last_watched_at,
            last_event_at = NOW()
    `;
}

/**
 * Mark multiple episodes as watched.
 */
export async function markEpisodesWatched(
    sql: Sql,
    userId: string,
    episodeJellyfinIds: string[],
    runtimeTicks?: number,
): Promise<void> {
    for (const episodeId of episodeJellyfinIds) {
        await insertTestEpisodeWatchStatus(sql, userId, episodeId, {
            isWatched: true,
            runtimeTicks,
        });
    }
}

/**
 * Turn a fixture series into a standalone-install series: drop every Jellyfin
 * external id of the series, its seasons and its episodes. Use it to prove a
 * code path works without Jellyfin (the fixtures above always add Jellyfin ids).
 */
export async function stripJellyfinIds(sql: Sql, seriesId: string): Promise<void> {
    await sql`
        DELETE FROM external_ids
        WHERE provider = 'jellyfin'
          AND media_id IN (
              SELECT ${seriesId}::uuid
              UNION ALL
              SELECT id FROM media_items WHERE parent_id = ${seriesId}::uuid
              UNION ALL
              SELECT ep.id FROM media_items ep
              JOIN media_items season ON season.id = ep.parent_id
              WHERE season.parent_id = ${seriesId}::uuid
          )
    `;
}
