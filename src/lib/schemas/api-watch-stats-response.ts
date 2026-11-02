// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Watch stats response schema (`GET /api/watch-stats`).
 *
 * Split out of `$lib/schemas/api-admin-responses` (2026-09-25, fix round 1)
 * so `$lib/api/watch-stats`'s `getWatchStats()` — reached from every rail
 * page via `PopularMediaStats.svelte` (mounted on `/browse`) — doesn't have
 * to import that whole, much heavier schema file just for this one response
 * shape. This whole section (all the per-`type` stats row/summary shapes
 * that feed the `WatchStatsStatsSchema` union, plus the separate
 * `MediaStatRowSchema` used only for `PopularMediaStats.svelte`'s type cast)
 * was self-contained within `api-admin-responses.ts` — nothing else in that
 * file referenced any of these symbols — so it moves as one block.
 * Re-exported from `api-admin-responses.ts` so existing importers (including
 * the server-only `src/lib/server/api/defs/admin/watch-stats.ts`) are
 * unaffected.
 */

import { z } from 'zod';
import { ImageSetSchema } from './api-image-descriptor.js';
import { publicMovieSeriesSchema } from './common.js';

/**
 * Media stat row (used by popular media stats widget)
 */
export const MediaStatRowSchema = z
    .object({
        /** Media ID */
        id: z.string().optional().describe('Media ID'),
        /** Title */
        title: z.string().optional().describe('Title'),
        /** Overview */
        overview: z.string().optional().describe('Overview'),
        /** Year */
        year: z.number().optional().describe('Year'),
        /** Rating */
        rating: z.number().optional().describe('Rating'),
        /** Average completion rate */
        avgCompletionRate: z.number().optional().describe('Avg completion rate'),
        /** Unique viewers */
        uniqueViewers: z.number().optional().describe('Unique viewers'),
        /** Average rating */
        avgRating: z.number().optional().describe('Average rating'),
        /** Total play time */
        totalPlayTime: z.number().optional().describe('Total play time'),
        /** Last watched date */
        lastWatched: z.string().optional().describe('Last watched'),
        /** Genres */
        genres: z.array(z.string()).optional().describe('Genres'),
        /** Episode count */
        episodeCount: z.number().optional().describe('Episode count'),
        /** Total watched episodes */
        totalWatchedEpisodes: z.number().optional().describe('Total watched episodes'),
        /** External IDs */
        externalIds: z
            .object({
                tmdb: z.string().optional(),
                imdb: z.string().optional(),
            })
            .optional()
            .describe('External IDs'),
    })
    .meta({ id: 'MediaStatRow', description: 'Media stat row' });

export type MediaStatRow = z.infer<typeof MediaStatRowSchema>;

/**
 * Top-user / active-user leaderboard row (admin stats).
 *
 * `name` is de-PII'd: the backend resolves the raw forward-auth user_id to the
 * user's display_name / username (brainstorm #3), falling back to the raw id
 * only when no users row matches. `avatarUrl` is present when the user has an
 * uploaded avatar.
 */
export const TopUserRowSchema = z
    .object({
        /** Internal user identifier (UUID held as text in watch_history). */
        id: z.string().describe('User id'),
        /** Resolved display name (display_name → username → raw id fallback). */
        name: z.string().describe('User display name'),
        /** Avatar URL when the user has an uploaded avatar. */
        images: ImageSetSchema.optional().describe('User avatar artwork'),
        /** Number of watch sessions. */
        sessions: z.number().describe('Sessions'),
        /** Total watch minutes. */
        minutes: z.number().describe('Total minutes'),
        /** Total watch hours (rounded). */
        hours: z.number().describe('Total hours'),
        /** Average session length in minutes. */
        avgSessionLength: z.number().describe('Average session length (minutes)'),
        /** Human-formatted total play time (e.g. "12h" or "45m"). */
        totalPlayTime: z.string().describe('Formatted total play time'),
        /** ISO timestamp of the user's most recent session. */
        lastActive: z.string().describe('Last active (ISO)'),
    })
    .meta({ id: 'TopUserRow', description: 'Top-user leaderboard row' });

export type TopUserRow = z.infer<typeof TopUserRowSchema>;

/**
 * `cold-content` row — never-watched prune candidate (movie or series).
 *
 * Catalog titles owning library files with ZERO qualifying watch_history
 * sessions in the timeframe, oldest-added first. TV is resolved at the series
 * level; `sizeBytes` sums the title's media files (series = episode subtree).
 */
export const ColdContentRowSchema = z
    .object({
        /** Display title. */
        title: z.string().describe('Title'),
        /** Catalog media type (series resolved to 'tv'). */
        mediaType: publicMovieSeriesSchema,
        /** Release / first-air year. */
        year: z.number().nullable().describe('Year'),
        /** Internal media UUID. */
        internalId: z.string().describe('Internal media UUID'),
        /** Poster image URL (/api/image/catalog/{uuid}/poster). */
        posterUrl: z.string().describe('Poster URL'),
        /** ISO timestamp the title was added to the library. */
        addedAt: z.string().describe('Added-at (ISO)'),
        /** Whole days since the title was added. */
        ageDays: z.number().describe('Age in days'),
        /** Total on-disk size in bytes (series = sum over episode files). */
        sizeBytes: z.number().describe('Total file size (bytes)'),
        /** Qualifying watch sessions within the timeframe (0 = never watched). */
        watchCount: z.number().describe('Watch sessions in the timeframe'),
        /**
         * `skyline` sort only: true when the title is on the Pareto frontier of
         * (least-watched, biggest) — an optimal space-reclaim prune pick. Absent
         * / false in the default `cold` sort.
         */
        isSkyline: z.boolean().optional().describe('On the least-watched×biggest Pareto frontier'),
    })
    .meta({ id: 'ColdContentRow', description: 'Least-watched / prune-candidate row' });

export type ColdContentRow = z.infer<typeof ColdContentRowSchema>;

/**
 * `completion-leaderboard` row — worst average completion per title.
 *
 * Per title (movies direct; episodes resolved to series), over the timeframe
 * with the min-session floor and a minimum session count: average
 * completion_percentage, session count, and abandon rate (% of sessions stopped
 * under 20%). Worst average surfaces first.
 */
export const CompletionLeaderboardRowSchema = z
    .object({
        /** Display title. */
        title: z.string().describe('Title'),
        /** Title media type (episodes resolved to 'tv'). */
        mediaType: publicMovieSeriesSchema,
        /** Release / first-air year. */
        year: z.number().nullable().describe('Year'),
        /** Internal media UUID (absent if the title could not be resolved). */
        internalId: z.string().optional().describe('Internal media UUID'),
        /** Poster image URL (absent if the title could not be resolved). */
        posterUrl: z.string().optional().describe('Poster URL'),
        /** Average completion percentage across qualifying sessions (0–100). */
        avgCompletion: z.number().describe('Average completion %'),
        /** Number of qualifying sessions. */
        sessions: z.number().describe('Session count'),
        /** Percentage of sessions stopped under 20% completion (0–100). */
        abandonRate: z.number().describe('Abandon rate %'),
    })
    .meta({ id: 'CompletionLeaderboardRow', description: 'Per-title completion leaderboard row' });

export type CompletionLeaderboardRow = z.infer<typeof CompletionLeaderboardRowSchema>;

/**
 * `dormant-users` row — churn / at-risk user (inverse of active-users).
 *
 * Users whose most-recent qualifying session is older than the dormancy
 * threshold (30 days), oldest-first, de-PII'd, soft-deleted excluded.
 */
export const DormantUserRowSchema = z
    .object({
        /** Internal user identifier (UUID held as text in watch_history). */
        id: z.string().describe('User id'),
        /** Resolved display name (display_name → username → raw id fallback). */
        name: z.string().describe('User display name'),
        /** Avatar URL when the user has an uploaded avatar. */
        images: ImageSetSchema.optional().describe('User avatar artwork'),
        /** ISO timestamp of the user's most recent qualifying session. */
        lastActive: z.string().describe('Last active (ISO)'),
        /** Whole days since that session. */
        daysSinceActive: z.number().describe('Days since last active'),
        /** Lifetime qualifying-session count (all-time). */
        lifetimeSessions: z.number().describe('Lifetime sessions'),
    })
    .meta({ id: 'DormantUserRow', description: 'Dormant / at-risk user row' });

export type DormantUserRow = z.infer<typeof DormantUserRowSchema>;

/** A single labelled segment of a device-mix breakdown. */
export const DeviceMixSegmentSchema = z
    .object({
        /** Segment label (e.g. client name, '1080p', codec, or 'Unknown'). */
        label: z.string().describe('Segment label'),
        /** Qualifying sessions in this segment. */
        sessions: z.number().describe('Session count'),
        /** Summed actual watch time (seconds) for this segment — time-weighted metric. */
        watchSeconds: z.number().describe('Summed actual watch time in seconds'),
        /** Share of this dimension's total sessions (0–100, rounded). */
        percentage: z.number().describe('Percentage of dimension total'),
    })
    .meta({ id: 'DeviceMixSegment', description: 'Device-mix breakdown segment' });

export type DeviceMixSegment = z.infer<typeof DeviceMixSegmentSchema>;

/**
 * `device-mix` stats — four independent breakdowns over watch_history's
 * captured client / device / resolution / codec columns, each sorted desc by
 * session count.
 */
export const DeviceMixStatsSchema = z
    .object({
        /** Breakdown by client_name. */
        byClient: z.array(DeviceMixSegmentSchema).describe('By client name'),
        /** Breakdown by device_name. */
        byDevice: z.array(DeviceMixSegmentSchema).describe('By device name'),
        /** Breakdown by resolution tier (SD/720p/1080p/4K/Unknown). */
        byResolution: z.array(DeviceMixSegmentSchema).describe('By resolution tier'),
        /** Breakdown by video codec. */
        byCodec: z.array(DeviceMixSegmentSchema).describe('By video codec'),
        /** Total qualifying sessions in the window. */
        totalSessions: z.number().describe('Total sessions'),
        /** Total qualifying watch time (seconds) in the window. */
        totalWatchSeconds: z.number().describe('Total watch time in seconds'),
    })
    .meta({ id: 'DeviceMixStats', description: 'Device / client / resolution / codec mix' });

export type DeviceMixStats = z.infer<typeof DeviceMixStatsSchema>;

// ---------------------------------------------------------------------------
// Per-type stats shapes — one schema per fetchAdminStats branch.
// Used to build the WatchStatsStatsSchema union below.
// ---------------------------------------------------------------------------

/** `movies` / `tvshows` — top media leaderboard row. */
const TopMediaRowSchema = z.object({
    title: z.string().describe('Title'),
    year: z.number().nullable().describe('Release year'),
    uniqueViewers: z.number().describe('Unique viewers'),
    totalPlayTime: z.number().describe('Total play time (minutes)'),
    externalIds: z
        .object({
            internal: z.string().optional(),
            tmdb: z.string().optional(),
            imdb: z.string().optional(),
        })
        .optional()
        .describe('External IDs'),
});

/** `activity` — watch-history day-of-week + hour-of-day breakdown. */
const ActivityStatsSchema = z.object({
    dayOfWeek: z.array(
        z.object({
            day: z.string(),
            count: z.number().int(),
            minutes: z.number(),
            percentage: z.number(),
        }),
    ),
    hourOfDay: z.array(
        z.object({
            hour: z.number(),
            count: z.number().int(),
            minutes: z.number(),
            percentage: z.number(),
        }),
    ),
    totalSessions: z.number(),
    totalMinutes: z.number(),
    avgMinutesPerUser: z.number(),
});

/** `genre-breakdown` — watch time by genre. */
const GenreBreakdownRowSchema = z.object({
    name: z.string().describe('Genre name'),
    count: z.number().int().describe('Watch sessions'),
    totalMinutes: z.number().describe('Total watch minutes'),
    percentage: z.number().describe('Share of total (0–100)'),
});

/** `content-freshness` — recent vs older vs unknown bucketed watch time. */
const ContentFreshnessStatsSchema = z.object({
    recentContent: z.object({
        items: z.number(),
        totalHours: z.number(),
        percentage: z.number(),
    }),
    olderContent: z.object({
        items: z.number(),
        totalHours: z.number(),
        percentage: z.number(),
    }),
    unknownContent: z.object({
        items: z.number(),
        totalHours: z.number(),
        percentage: z.number(),
    }),
});

/** `day-hours` — hourly breakdown for a specific day of week. */
const DayHourRowSchema = z.object({
    hour: z.number().describe('Hour of day (0–23)'),
    count: z.number().int().describe('Session count'),
    minutes: z.number().describe('Watch minutes'),
    percentage: z.number().describe('Share of day total (0–100)'),
});

/** `summary` — fleet-level totals. */
const WatchSummarySchema = z.object({
    totalWatchTime: z.number().describe('Total watch time (minutes)'),
    totalWatchTimeFormatted: z.string().describe('Human-formatted total watch time'),
    totalSessions: z.number().describe('Total sessions'),
    uniqueItems: z.number().describe('Unique items watched'),
    uniqueUsers: z.number().describe('Unique users with qualifying sessions'),
    user: z.string().describe('Username context (admin surface)'),
});

/**
 * Discriminated union of all possible stats payloads keyed by the `type` query
 * param.  Each branch carries its own shape; the outer `stats` field of
 * WatchStatsResponseSchema is typed as this union.
 *
 * Array variants (movies, tvshows, top-users, active-users, genre-breakdown,
 * day-hours, cold-content, completion-leaderboard, dormant-users) are z.array(…).
 * Object variants (activity, content-freshness, device-mix, summary) are z.object(…).
 */
export const WatchStatsStatsSchema = z.union([
    // movies / tvshows
    z.array(TopMediaRowSchema),
    // top-users / active-users
    z.array(TopUserRowSchema),
    // genre-breakdown
    z.array(GenreBreakdownRowSchema),
    // day-hours
    z.array(DayHourRowSchema),
    // cold-content
    z.array(ColdContentRowSchema),
    // completion-leaderboard
    z.array(CompletionLeaderboardRowSchema),
    // dormant-users
    z.array(DormantUserRowSchema),
    // activity
    ActivityStatsSchema,
    // content-freshness
    ContentFreshnessStatsSchema,
    // device-mix
    DeviceMixStatsSchema,
    // summary (default)
    WatchSummarySchema,
]);

export type WatchStatsStats = z.infer<typeof WatchStatsStatsSchema>;

/**
 * Watch stats response (for movies/tvshows/tvshows-completion types)
 *
 * Server returns bare { stats, day? } — no legacy `success` wrapper.
 */
export const WatchStatsResponseSchema = z
    .object({
        /** Stats data (polymorphic: shape depends on the `type` query param) */
        stats: WatchStatsStatsSchema.describe('Stats data'),
        /** Day key returned for day-hours type only */
        day: z.string().optional().describe('Day'),
    })
    .meta({ id: 'WatchStatsResponse', description: 'Watch stats response' });

export type WatchStatsResponse = z.infer<typeof WatchStatsResponseSchema>;
