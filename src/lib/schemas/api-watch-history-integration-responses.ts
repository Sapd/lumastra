// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

/**
 * Wire shape of GET /api/v1/integrations/watch-history — one user's watch history for
 * an external recommender (e.g. a chat bot). Read-only, one user per call, no
 * file paths, IPs, devices or other users' data. Item ids are Lumastra media ids, so a
 * caller can deep-link (`/watch/<id>`) or look the item up on /api/v1.
 */

const count = z.number().int().min(0);

export const WatchHistoryQuerySchema = z.object({
    user: z
        .string()
        .trim()
        .min(1)
        .max(255)
        .refine((v) => !v.includes('\u0000'), 'Must not contain NUL')
        .describe('Lumastra username (case-insensitive) or user UUID'),
    limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(200)
        .default(50)
        .describe('Page size of recentlyWatched (1-200, default 50)'),
    cursor: z
        .string()
        .max(512)
        .optional()
        .describe('Opaque cursor from page.nextCursor of the previous response'),
    days: z.coerce
        .number()
        .int()
        .min(1)
        .max(3650)
        .default(180)
        .describe('Window for topGenres and the windowed stats (1-3650, default 180)'),
});
export type WatchHistoryQuery = z.infer<typeof WatchHistoryQuerySchema>;

export const WatchHistoryItemTypeSchema = z
    .enum(['movie', 'episode', 'audiobook'])
    .meta({ id: 'WatchHistoryItemType' });

export const WatchHistoryItemSchema = z
    .object({
        id: z
            .string()
            .describe('Lumastra media id of the watched item (movie, episode, audiobook)'),
        type: WatchHistoryItemTypeSchema,
        title: z.string().describe('Item title; for an episode the episode title'),
        year: z.number().int().nullable().describe('Release year (series year for an episode)'),
        genres: z.array(z.string()).describe('Genre names; an episode carries its series genres'),
        series: z
            .object({
                id: z.string().describe('Lumastra media id of the series'),
                title: z.string(),
                year: z.number().int().nullable(),
            })
            .nullable()
            .describe('Present for episodes only'),
        seasonNumber: z.number().int().nullable(),
        episodeNumber: z.number().int().nullable(),
        lastWatchedAt: z
            .string()
            .nullable()
            .describe(
                'ISO timestamp of the last watch/progress event. null = unknown: the item was imported or bulk-synced without a trustworthy date (e.g. the 2026-03-31 Jellyfin import); such items sort after every dated one',
            ),
        progressPercent: z
            .number()
            .min(0)
            .max(100)
            .nullable()
            .describe('0-100; 100 when completed; null when the runtime is unknown'),
        completed: z.boolean().describe('Marked watched / finished'),
    })
    .meta({ id: 'WatchHistoryItem', description: 'One watched or started item' });
export type WatchHistoryItem = z.infer<typeof WatchHistoryItemSchema>;

export const WatchHistoryGenreSchema = z
    .object({
        name: z.string(),
        titles: count.describe(
            'Distinct movies/series/audiobooks in the window carrying the genre',
        ),
    })
    .meta({ id: 'WatchHistoryGenre' });

export const WatchHistoryResponseSchema = z
    .object({
        generatedAt: z.string().describe('ISO timestamp the payload was built (cached up to 60 s)'),
        user: z
            .object({
                id: z.string().describe('Lumastra user UUID'),
                username: z.string(),
                displayName: z.string().nullable(),
            })
            .describe('The user the history belongs to'),
        recentlyWatched: z
            .object({
                items: z.array(WatchHistoryItemSchema),
                page: z.object({
                    limit: z.number().int(),
                    nextCursor: z
                        .string()
                        .optional()
                        .describe(
                            'Pass as ?cursor= to fetch the next page; absent on the last page',
                        ),
                    hasMore: z.boolean(),
                }),
            })
            .describe(
                'Movies, episodes and audiobooks the user watched or started, newest first; items with an unknown date last',
            ),
        continueWatching: z
            .array(WatchHistoryItemSchema)
            .describe(
                "The user's Continue Watching row (same rules as the app), max 20; not paginated",
            ),
        topGenres: z
            .object({
                days: z.number().int(),
                genres: z.array(WatchHistoryGenreSchema).describe('Top 10, most titles first'),
            })
            .describe('Genres of titles watched in the last `days` days (undated items excluded)'),
        stats: z
            .object({
                moviesWatched: count,
                episodesWatched: count,
                seriesWatched: count.describe('Series with at least one watched episode'),
                audiobooksFinished: count,
                inProgress: count.describe('Started but not finished'),
                activeInWindow: count.describe(
                    'Items watched or progressed in the last `days` days',
                ),
                undated: count.describe('Items whose last watch date is unknown'),
                tracksPlayedInWindow: count.describe('Music plays in the last `days` days'),
            })
            .describe('Counts over the whole history unless stated otherwise'),
    })
    .meta({ id: 'WatchHistoryIntegration', description: "One user's watch history" });
export type WatchHistoryResponse = z.infer<typeof WatchHistoryResponseSchema>;
