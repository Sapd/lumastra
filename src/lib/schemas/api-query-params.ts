// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Zod schemas for API route query parameters.
 *
 * All URL search params arrive as strings; use z.coerce.number() / z.coerce.boolean()
 * so the middleware can transparently convert before the handler runs.
 */
import { z } from 'zod';
import { mediaTypeSchema } from './common';

// ── Shared helpers ────────────────────────────────────────────────────────────

const coercedInt = (fallback: number, min = 1, max = 500) =>
    z.coerce.number().int().min(min).max(max).optional().default(fallback);

const booleanParam = z
    .string()
    .optional()
    .transform((v) => v === 'true');

// ── For-You: recently-added ───────────────────────────────────────────────────

export const ForYouRecentlyAddedQuerySchema = z.object({
    limit: coercedInt(20, 1, 100),
});
export type ForYouRecentlyAddedQuery = z.infer<typeof ForYouRecentlyAddedQuerySchema>;

// ── For-You: watching ─────────────────────────────────────────────────────────

export const ForYouWatchingQuerySchema = z.object({
    limit: coercedInt(10, 1, 100),
    mergeSort: booleanParam,
    includeNewEpisodes: booleanParam,
});
export type ForYouWatchingQuery = z.infer<typeof ForYouWatchingQuerySchema>;

// ── Mood Recommendations ──────────────────────────────────────────────────────

export const MoodRecommendationsQuerySchema = z.object({
    mood: z.string().optional(),
    type: mediaTypeSchema.optional(),
    limit: coercedInt(12, 1, 100),
    // trending defaults to true; set trending=false to opt out
    trending: z
        .string()
        .optional()
        .transform((v) => v !== 'false'),
    mode: z.enum(['keyword', 'vector']).optional().default('keyword'),
    moodWeight: z.coerce.number().min(0).max(1).optional().default(0.6),
    userWeight: z.coerce.number().min(0).max(1).optional().default(0.4),
});
export type MoodRecommendationsQuery = z.infer<typeof MoodRecommendationsQuerySchema>;

// ── Watch Stats ───────────────────────────────────────────────────────────────

export const WatchStatsQuerySchema = z.object({
    type: z
        .enum([
            'movies',
            'tvshows',
            'activity',
            'top-users',
            'active-users',
            'genre-breakdown',
            'content-freshness',
            'day-hours',
            'cold-content',
            'completion-leaderboard',
            'dormant-users',
            'device-mix',
            'summary',
        ])
        .optional()
        .default('summary'),
    timeframe: z.enum(['AllTime', 'LastWeek', 'LastMonth']).optional().default('AllTime'),
    // Max raised to 200 to back the per-section "Load more" on
    // /admin/library/insights (10-row pages, grown in place). 200 caps a
    // worst-case fetch.
    limit: coercedInt(10, 1, 200),
    day: z.string().optional(),
    // cold-content ordering: 'cold' (least-watched first) | 'skyline' (biggest
    // space-wasters first, Pareto frontier of least-watched × biggest). Ignored
    // by every other stats type.
    sort: z.enum(['cold', 'skyline']).optional().default('cold'),
});
export type WatchStatsQuery = z.infer<typeof WatchStatsQuerySchema>;

// ── Trending ──────────────────────────────────────────────────────────────────

export const TrendingQuerySchema = z.object({
    limit: coercedInt(20, 1, 100),
    type: z.enum(['movies', 'tv', 'all']).optional().default('all'),
    source: z.enum(['tmdb', 'jellyfin', 'hybrid', 'mdblist']).optional().default('hybrid'),
    list: z.enum(['watched', 'popular']).optional().default('watched'),
});
export type TrendingQuery = z.infer<typeof TrendingQuerySchema>;

// ── Upcoming ──────────────────────────────────────────────────────────────────

export const UpcomingQuerySchema = z.object({
    limit: coercedInt(10, 1, 100),
});
export type UpcomingQuery = z.infer<typeof UpcomingQuerySchema>;

// ── Activity Feed ─────────────────────────────────────────────────────────────

export const ActivityFeedQuerySchema = z.object({
    limit: coercedInt(50, 1, 500),
    offset: z.coerce.number().int().min(0).optional().default(0),
    activityType: z
        .enum(['started', 'finished', 'abandoned', 'watchlist_add', 'watchlist_remove', 'rating'])
        .optional(),
    userId: z.string().uuid().optional(),
    search: z.string().trim().max(200).optional(),
    days: z.coerce.number().int().min(1).max(3650).optional().default(30),
});
export type ActivityFeedQuery = z.infer<typeof ActivityFeedQuerySchema>;

// ── Media Similar ─────────────────────────────────────────────────────────────

export const MediaSimilarQuerySchema = z.object({
    limit: coercedInt(20, 1, 100),
    minSimilarity: z.coerce.number().min(0).max(1).optional().default(0.5),
});
export type MediaSimilarQuery = z.infer<typeof MediaSimilarQuerySchema>;

// ── Recommendations ───────────────────────────────────────────────────────────

export const RecommendationsQuerySchema = z.object({
    type: z.enum(['ai', 'nextup', 'continue', 'watching', 'movies', 'series']).optional(),
    limit: coercedInt(10, 1, 100),
    watchedBased: booleanParam,
    withoutRatingInfluence: booleanParam,
    hideWatched: booleanParam,
    exclude: z.string().optional(),
    mediaType: mediaTypeSchema.optional(),
    validate: booleanParam,
});
export type RecommendationsQuery = z.infer<typeof RecommendationsQuerySchema>;

// ── v1/runs ───────────────────────────────────────────────────────────────────

export const V1RunsQuerySchema = z.object({
    state: z.string().optional(),
    taskId: z.string().optional(),
    parentRunId: z.string().optional(),
    libraryGroupId: z.string().optional(),
    /** Only return runs acting on this subject (see `StartRunOpts.subject`). */
    subjectId: z.string().optional(),
    limit: coercedInt(50, 1, 200),
    cursor: z.string().optional(),
    groupBy: z.enum(['task']).optional(),
    /** Only return runs started at or after this ISO timestamp. */
    since: z.string().datetime().optional(),
});
export type V1RunsQuery = z.infer<typeof V1RunsQuerySchema>;

// ── Public: stream-session ────────────────────────────────────────────────────

export const StreamSessionQuerySchema = z.object({
    token: z.string().min(1),
});
export type StreamSessionQuery = z.infer<typeof StreamSessionQuerySchema>;
