// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/media/[id]/health/season/[seasonNumber]/index.ts
 *
 * GET /api/admin/media/[id]/health/season/[seasonNumber]
 *
 * Detailed health for a specific season: local vs provider episode count,
 * episodes-with-chapters data, episode-group scores.
 *
 * Auth: admin.  Surface: internal-only.
 *
 * Response: { season, localCount, providerCount, match, episodesWithChapters,
 *             episodesWithChapterData, episodeGroups, missingCount }
 * 503 dependency_unavailable when DB is down.
 */

import { adminMediaId } from '$lib/server/utils/admin-media-id.js';
import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { getTmdbId } from '$lib/server/database/queries/external-ids.queries.js';
import { tmdbApi } from '$lib/server/providers/implementations/tmdb/index.js';
import { Logger } from '$lib/server/utils/logger.js';
import { AsyncSemaphore } from '$lib/server/utils/async-semaphore.js';

const tmdbSemaphore = new AsyncSemaphore(5);
const logger = Logger.for('SeasonHealthApi');

// ---------------------------------------------------------------------------
// Response schema
// ---------------------------------------------------------------------------

const EpisodeGroupScoreSchema = z.object({
    groupId: z.string(),
    groupName: z.string(),
    groupType: z.string(),
    episodeCount: z.number().int(),
    countScore: z.number().int(),
    structureScore: z.number().int(),
    chapterScore: z.number().int(),
    chapterNameMatch: z.number().nullable(),
});

const EpisodeChapterDataSchema = z.object({
    episodeNumber: z.number().int(),
    chapterCount: z.number().int(),
});

export const SeasonHealthResponseSchema = z.object({
    season: z.object({
        seasonNumber: z.number().int(),
        title: z.string(),
        seasonId: z.string(),
    }),
    localCount: z.number().int(),
    providerCount: z.number().int(),
    match: z.boolean(),
    episodesWithChapters: z.number().int(),
    episodesWithChapterData: z.array(EpisodeChapterDataSchema),
    episodeGroups: z.array(EpisodeGroupScoreSchema),
    missingCount: z.number().int().nonnegative(),
});

export type SeasonHealthResponse = z.infer<typeof SeasonHealthResponseSchema>;

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    handlers: {
        GET: async (event) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const { seasonNumber: seasonNumberParam } = event.params;
            const internalId = adminMediaId(event);

            if (!internalId) return ApiProblem.notFound('Media item not found');

            // Digits only: parseInt took '1abc' as season 1, and a value past
            // int4 range reached the query and 500'd.
            if (!/^\d{1,4}$/.test(seasonNumberParam ?? '')) {
                return ApiProblem.validationFailed('Invalid season number');
            }
            const seasonNum = Number(seasonNumberParam);

            const [seasonItem] = await sql<{ id: string; title: string; season_number: number }[]>`
                SELECT id, title, season_number
                FROM media_items
                WHERE parent_id = ${internalId}
                  AND media_type = 'season'
                  AND season_number = ${seasonNum}
            `;

            if (!seasonItem) {
                return ApiProblem.notFound(`Season ${seasonNum} not found`);
            }

            const [localCount] = await sql<{ count: string }[]>`
                SELECT COUNT(*) as count
                FROM media_items
                WHERE parent_id = ${seasonItem.id} AND media_type = 'episode'
            `;

            const tmdbId = await getTmdbId.get(sql, { mediaId: internalId });

            let providerEpisodeCount = 0;
            const episodeGroups: z.infer<typeof EpisodeGroupScoreSchema>[] = [];

            const chapters = await sql<
                { media_item_id: string; episode_number: number; chapter_count: string }[]
            >`
                SELECT
                    mi.id AS media_item_id,
                    mi.episode_number,
                    COUNT(ec.id) AS chapter_count
                FROM episode_chapters ec
                JOIN media_file_items mfi ON mfi.file_id = ec.file_id
                JOIN media_items mi ON mi.id = mfi.media_item_id
                WHERE mi.parent_id = ${seasonItem.id} AND mi.media_type = 'episode'
                GROUP BY mi.id, mi.episode_number
                ORDER BY mi.episode_number
            `;

            const chaptersByEpisode = new Map<number, number>();
            for (const ch of chapters) {
                chaptersByEpisode.set(ch.episode_number, parseInt(ch.chapter_count, 10));
            }
            const localEpisodeCount = parseInt(localCount.count, 10);

            if (tmdbId && tmdbApi.isAvailable()) {
                try {
                    const seasons = await tmdbApi.getTVShowSeasons(tmdbId);
                    const seasonInfo = seasons.find((s) => s.seasonNumber === seasonNum);
                    providerEpisodeCount = seasonInfo?.episodeCount ?? 0;
                } catch (err) {
                    logger.warn('Failed to fetch TMDB season', { tmdbId, seasonNum, error: err });
                }

                try {
                    const groups = await tmdbApi.getEpisodeGroups(tmdbId);
                    const groupDetails = await Promise.all(
                        groups.map((group) =>
                            tmdbSemaphore.withPermit(() =>
                                tmdbApi.getEpisodeGroupDetails(group.id).then(
                                    (details) => ({ group, details }),
                                    () => ({ group, details: null }),
                                ),
                            ),
                        ),
                    );

                    for (const { group, details } of groupDetails) {
                        if (!details) continue;
                        const seasonGroupEpisodes: Array<{ episodeNumber: number; name?: string }> =
                            [];
                        for (const grp of details.groups ?? []) {
                            const epsInSeason =
                                grp.episodes?.filter(
                                    (ep: { season_number: number }) =>
                                        ep.season_number === seasonNum,
                                ) ?? [];
                            for (const ep of epsInSeason) {
                                seasonGroupEpisodes.push({
                                    episodeNumber: ep.episode_number,
                                    name: ep.name,
                                });
                            }
                        }
                        if (seasonGroupEpisodes.length === 0) continue;

                        const countScore = Math.min(
                            1,
                            localEpisodeCount / seasonGroupEpisodes.length,
                        );
                        const episodesWithChaptersInGroup = seasonGroupEpisodes.filter((ep) =>
                            chaptersByEpisode.has(ep.episodeNumber),
                        ).length;
                        const structureScore =
                            episodesWithChaptersInGroup / seasonGroupEpisodes.length;

                        let totalChapters = 0;
                        let episodesWithChaptersCount = 0;
                        for (const ep of seasonGroupEpisodes) {
                            const chapterCount = chaptersByEpisode.get(ep.episodeNumber);
                            if (chapterCount && chapterCount > 0) {
                                totalChapters += chapterCount;
                                episodesWithChaptersCount++;
                            }
                        }
                        const chapterScore =
                            episodesWithChaptersCount > 0
                                ? totalChapters / episodesWithChaptersCount / 10
                                : 0;

                        episodeGroups.push({
                            groupId: group.id,
                            groupName: group.name,
                            groupType: String(details.type),
                            episodeCount: seasonGroupEpisodes.length,
                            countScore: Math.round(countScore * 100),
                            structureScore: Math.round(structureScore * 100),
                            chapterScore: Math.round(chapterScore * 100),
                            chapterNameMatch: null,
                        });
                    }
                } catch (e) {
                    logger.debug('Episode groups unavailable for season health check', {
                        error: e,
                    });
                }
            }

            const episodesWithChapterData = chapters.map((ch) => ({
                episodeNumber: ch.episode_number,
                chapterCount: parseInt(ch.chapter_count, 10),
            }));

            return json(
                SeasonHealthResponseSchema.parse({
                    season: {
                        seasonNumber: seasonNum,
                        title: seasonItem.title,
                        seasonId: seasonItem.id,
                    },
                    localCount: localEpisodeCount,
                    providerCount: providerEpisodeCount,
                    match: localEpisodeCount === providerEpisodeCount,
                    episodesWithChapters: chapters.length,
                    episodesWithChapterData,
                    episodeGroups,
                    missingCount: Math.max(0, providerEpisodeCount - localEpisodeCount),
                }),
            );
        },
    },
});
