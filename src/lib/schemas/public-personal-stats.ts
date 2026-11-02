// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Public (v1) personal statistics schemas.
 *
 * Response contract of `GET /api/v1/me/stats` and `GET /api/v1/stats/users/{id}`.
 * Derived from the internal schemas in `personal-stats-types.ts` (which the web
 * stats pages and `/api/my-stats/*` keep using) but following the API unit rules
 * (docs/superpowers/specs/2026-10-16-api-rework-common-rules.md, "Units and naming"):
 *
 * - time spans are integer milliseconds (`*Ms`), never seconds
 * - pre-formatted `*Formatted` strings are dropped (clients format)
 * - points in time are ISO 8601 UTC strings named `*At`
 * - bitrates are bits per second (`*Bps`)
 * - metric names are camelCase
 *
 * The serializer that converts the internal (cached) service output to these
 * shapes is `toPublicStats` in `$lib/server/api/defs/stats/transforms.ts`.
 */

import { z } from 'zod';
import { PageBlockSchema } from './pagination.js';
import { WatchTimeTrendSchema } from './personal-stats-types.js';
import type { PersonalStatsType } from './personal-stats-types.js';

// =============================================================================
// Metric names
// =============================================================================

/** Public metric names, in canonical (response and `unavailable`) order. */
export const PUBLIC_STATS_METRICS = [
    'overview',
    'watchTime',
    'peakHours',
    'completion',
    'genres',
    'keywords',
    'devices',
    'quality',
    'ratings',
    'tasteProfile',
    'records',
    'topTitles',
] as const;

export const PublicPersonalStatsMetricSchema = z
    .enum(PUBLIC_STATS_METRICS)
    .describe('Personal statistics metric name')
    .meta({ id: 'PublicPersonalStatsMetric' });

export type PublicPersonalStatsMetric = z.infer<typeof PublicPersonalStatsMetricSchema>;

/** The one mapping between the public camelCase name and the internal kebab-case type. */
export const INTERNAL_TYPE_BY_PUBLIC_METRIC: Record<PublicPersonalStatsMetric, PersonalStatsType> =
    {
        overview: 'overview',
        watchTime: 'watch-time',
        peakHours: 'peak-hours',
        completion: 'completion',
        genres: 'genres',
        keywords: 'keywords',
        devices: 'devices',
        quality: 'quality',
        ratings: 'ratings',
        tasteProfile: 'taste-profile',
        records: 'records',
        topTitles: 'top-titles',
    };

export const PUBLIC_METRIC_BY_INTERNAL_TYPE: Record<PersonalStatsType, PublicPersonalStatsMetric> =
    {
        overview: 'overview',
        'watch-time': 'watchTime',
        'peak-hours': 'peakHours',
        completion: 'completion',
        genres: 'genres',
        keywords: 'keywords',
        devices: 'devices',
        quality: 'quality',
        ratings: 'ratings',
        'taste-profile': 'tasteProfile',
        records: 'records',
        'top-titles': 'topTitles',
    };

// =============================================================================
// Metric DTOs
// =============================================================================

export const PublicStatsOverviewSchema = z
    .object({
        totalWatchTimeMs: z.number().int().describe('Total watch time in milliseconds'),
        totalSessions: z.number().describe('Total number of viewing sessions'),
        uniqueContent: z.number().describe('Unique content items watched'),
        completedCount: z.number().describe('Distinct titles finished'),
        abandonedCount: z.number().describe('Distinct titles started and not finished'),
        avgCompletionPercentage: z.number().describe("Average of each title's furthest progress"),
        moviesWatched: z.number().describe('Distinct movies watched'),
        episodesWatched: z.number().describe('Distinct episodes watched'),
        firstWatchAt: z.string().optional().describe('First watch (ISO 8601 UTC)'),
        lastWatchAt: z.string().optional().describe('Last watch (ISO 8601 UTC)'),
    })
    .meta({ id: 'PublicStatsOverview', description: 'Overview statistics' });

export const PublicStatsWatchTimePeriodSchema = z
    .object({
        period: z
            .string()
            .describe(
                'Start of the bucket as an ISO 8601 timestamp. Buckets are days for period=7d and ' +
                    'weeks otherwise, aligned to the server time zone.',
            ),
        watchTimeMs: z.number().int().describe('Watch time in this bucket in milliseconds'),
        sessionCount: z.number().describe('Sessions in this bucket'),
    })
    .meta({ id: 'PublicStatsWatchTimePeriod', description: 'Watch time of one bucket' });

export const PublicStatsWatchTimeSchema = z
    .object({
        periods: z
            .array(PublicStatsWatchTimePeriodSchema)
            .describe('Buckets in chronological order'),
        totalWatchTimeMs: z.number().int().describe('Total watch time in milliseconds'),
        avgPerPeriodMs: z.number().int().describe('Average watch time per bucket in milliseconds'),
        trend: WatchTimeTrendSchema,
        trendPercentage: z.number().describe('Change of the newest bucket against the one before'),
    })
    .meta({ id: 'PublicStatsWatchTime', description: 'Watch time over time' });

export const PublicStatsPeakHourCellSchema = z
    .object({
        dayOfWeek: z.number().int().min(0).max(6).describe('Day of week (0 = Sunday)'),
        hour: z.number().int().min(0).max(23).describe('Hour of day (0-23, server time zone)'),
        sessionCount: z.number().describe('Sessions in this slot'),
        totalMs: z.number().int().describe('Watch time in this slot in milliseconds'),
        intensity: z.number().min(0).max(1).describe('Normalized intensity (0-1)'),
    })
    .meta({ id: 'PublicStatsPeakHourCell', description: 'Peak hours heatmap cell' });

export const PublicStatsPeakHoursSchema = z
    .object({
        cells: z.array(PublicStatsPeakHourCellSchema).describe('Heatmap cells'),
        peakDay: z.string().describe('Peak day of week, e.g. "Saturday"'),
        peakHour: z.number().int().min(0).max(23).describe('Peak hour (0-23)'),
        nightOwlScore: z.number().describe('Percent of sessions between midnight and 4am'),
        weekendWarriorScore: z.number().describe('Percent of sessions on weekends'),
    })
    .meta({ id: 'PublicStatsPeakHours', description: 'Peak hours statistics' });

export const PublicStatsCompletionBucketSchema = z
    .object({
        bucket: z.string().describe('Bucket label, e.g. "90-100%"'),
        count: z.number().int().describe('Items in this bucket'),
        percentage: z.number().describe('Percent of all items'),
    })
    .meta({ id: 'PublicStatsCompletionBucket', description: 'Completion rate bucket' });

export const PublicStatsAbandonedContentSchema = z
    .object({
        title: z.string(),
        seriesName: z.string().optional(),
        seasonNumber: z.number().optional(),
        episodeNumber: z.number().optional(),
        maxCompletion: z.number().optional().describe('Furthest progress reached (percent)'),
        mediaType: z.string(),
        timesStarted: z.number(),
        timesCompleted: z.number(),
        timesAbandoned: z.number(),
        abandonRate: z.number().describe('Abandon rate (0-1)'),
        lastWatchedAt: z.string().optional().describe('Last watched (ISO 8601 UTC)'),
    })
    .meta({
        id: 'PublicStatsAbandonedContent',
        description: 'A title that was started, not finished',
    });

export const PublicStatsCompletionSchema = z
    .object({
        overallCompletionRate: z.number().describe('Overall completion rate (0-100)'),
        buckets: z.array(PublicStatsCompletionBucketSchema),
        movieCompletionRate: z.number(),
        episodeCompletionRate: z.number(),
        abandonedContent: z.array(PublicStatsAbandonedContentSchema),
        avgDropOffPoint: z.number().describe('Average drop-off point (percent)'),
    })
    .meta({ id: 'PublicStatsCompletion', description: 'Completion statistics' });

export const PublicStatsGenreSchema = z
    .object({
        genreId: z.number(),
        genreName: z.string(),
        totalMs: z.number().int().describe('Watch time in milliseconds'),
        percentage: z.number().describe('Percent of total watch time'),
        contentCount: z.number().describe('Content items in this genre'),
    })
    .meta({ id: 'PublicStatsGenre', description: 'Genre watch statistics' });

export const PublicStatsGenresSchema = z
    .object({
        items: z.array(PublicStatsGenreSchema).describe('Page of genres, most watched first'),
        page: PageBlockSchema,
        meta: z.object({
            topGenre: z.string(),
            diversityScore: z.number().describe('Genre diversity score (0-100)'),
        }),
    })
    .meta({ id: 'PublicStatsGenres', description: 'Genre statistics (paged by limit/offset)' });

export const PublicStatsKeywordSchema = z
    .object({
        keyword: z.string(),
        count: z.number().int().describe('Content items with this keyword'),
        percentage: z.number().describe('Percent of total content'),
    })
    .meta({ id: 'PublicStatsKeyword', description: 'Keyword statistics' });

export const PublicStatsKeywordsSchema = z
    .object({
        items: z.array(PublicStatsKeywordSchema).describe('Page of keywords'),
        page: PageBlockSchema,
        meta: z.object({
            totalKeywordsTracked: z.number().describe('Unique keywords tracked'),
        }),
    })
    .meta({ id: 'PublicStatsKeywords', description: 'Keyword statistics (paged by limit/offset)' });

export const PublicStatsDeviceSchema = z
    .object({
        clientName: z.string(),
        deviceName: z.string(),
        sessionCount: z.number(),
        totalMs: z.number().int().describe('Watch time in milliseconds'),
        percentage: z.number().describe('Percent of total watch time'),
        formFactor: z.enum(['mobile', 'tablet', 'tv', 'desktop', 'unknown']).optional(),
    })
    .meta({ id: 'PublicStatsDevice', description: 'Device usage statistics' });

export const PublicStatsDevicesSchema = z
    .object({
        devices: z.array(PublicStatsDeviceSchema),
        primaryDevice: z.string(),
        deviceCount: z.number(),
    })
    .meta({ id: 'PublicStatsDevices', description: 'Device statistics' });

export const PublicStatsResolutionSchema = z
    .object({
        uhd4k: z.number().describe('4K UHD sessions'),
        hd1080: z.number().describe('1080p sessions'),
        hd720: z.number().describe('720p sessions'),
        sd: z.number().describe('SD sessions'),
        unknown: z.number().optional().describe('Sessions with no recorded resolution'),
    })
    .meta({ id: 'PublicStatsResolution', description: 'Sessions per resolution class' });

export const PublicStatsQualitySchema = z
    .object({
        totalSessions: z.number(),
        resolution: PublicStatsResolutionSchema,
        avgBitrateBps: z.number().int().optional().describe('Average bitrate in bits per second'),
    })
    .meta({ id: 'PublicStatsQuality', description: 'Playback quality statistics' });

export const PublicStatsRatingDistributionSchema = z
    .object({
        rating: z.number().int().min(1).max(10),
        count: z.number().int(),
        movieCount: z.number(),
        tvCount: z.number(),
    })
    .meta({ id: 'PublicStatsRatingDistribution', description: 'Ratings per value' });

export const PublicStatsRatingsSchema = z
    .object({
        totalRatings: z.number(),
        avgRating: z.number(),
        medianRating: z.number(),
        distribution: z.array(PublicStatsRatingDistributionSchema),
        firstRatingAt: z.string().optional().describe('First rating (ISO 8601 UTC)'),
        lastRatingAt: z.string().optional().describe('Last rating (ISO 8601 UTC)'),
        ratingFrequency: z.number().describe('Ratings per month'),
    })
    .meta({ id: 'PublicStatsRatings', description: 'Rating statistics' });

export const PublicStatsTasteProfileSchema = z
    .object({
        hasProfile: z.boolean(),
        totalRatings: z.number(),
        availabilityPreference: z.number().describe('Availability preference (0-1)'),
        qualityWeight: z.number(),
        popularityWeight: z.number(),
        recencyWeight: z.number(),
        lastActivityAt: z.string().optional().describe('Last profile activity (ISO 8601 UTC)'),
        profileAge: z.number().describe('Profile age in days'),
        insights: z.array(z.string()),
    })
    .meta({ id: 'PublicStatsTasteProfile', description: 'Taste profile statistics' });

export const PublicStatsSessionRecordSchema = z
    .object({
        title: z.string(),
        seriesName: z.string().optional(),
        mediaType: z.string(),
        durationMs: z.number().int().describe('Session duration in milliseconds'),
        startedAt: z.string().describe('Session start (ISO 8601 UTC)'),
        clientName: z.string().optional(),
        deviceName: z.string().optional(),
    })
    .meta({ id: 'PublicStatsSessionRecord', description: 'A single viewing session' });

export const PublicStatsRewatchRecordSchema = z
    .object({
        id: z.string().optional().describe('Lumastra media id (movie or series), when resolved'),
        title: z.string(),
        seriesName: z.string().optional(),
        timesStarted: z.number(),
        timesCompleted: z.number(),
    })
    .meta({ id: 'PublicStatsRewatchRecord', description: 'A rewatched title' });

export const PublicStatsRecordsSchema = z
    .object({
        longestSession: PublicStatsSessionRecordSchema.optional(),
        mostRewatchedMovies: z.array(PublicStatsRewatchRecordSchema),
        mostRewatchedSeries: z.array(PublicStatsRewatchRecordSchema),
        nightOwlScore: z.number(),
        bingeScore: z.number().describe('Number of 3+ hour same-series sessions'),
        totalBingeDays: z.number(),
        typicalViewingWindow: z
            .object({
                start: z.string().describe('10th percentile of session start time (HH:MM)'),
                end: z.string().describe('90th percentile of session start time (HH:MM)'),
                median: z.string().describe('Median session start time (HH:MM)'),
            })
            .optional(),
        longestStreak: z.number().describe('Longest run of consecutive days (days)'),
        currentStreak: z.number().describe('Current run of consecutive days (days)'),
    })
    .meta({ id: 'PublicStatsRecords', description: 'Fun records and achievements' });

export const PublicStatsTopTitleSchema = z
    .object({
        id: z.string().describe('Lumastra media id'),
        type: z.enum(['movie', 'series']),
        ids: z.object({ internal: z.string() }),
        title: z.string(),
        year: z.number().optional(),
        images: z.object({
            poster: z.object({ href: z.string() }),
            backdrop: z.object({ href: z.string() }),
        }),
        watchCount: z.number().describe('Qualifying sessions (episode plays for series)'),
        totalWatchTimeMs: z.number().int().describe('Total watch time in milliseconds'),
    })
    .meta({ id: 'PublicStatsTopTitle', description: 'A most-watched title' });

export const PublicStatsTopTitlesSchema = z
    .object({
        items: z
            .array(PublicStatsTopTitleSchema)
            .describe('Most-watched movies first, then series'),
        page: PageBlockSchema,
    })
    .meta({
        id: 'PublicStatsTopTitles',
        description: 'Most-watched titles (paged by limit/offset)',
    });

// =============================================================================
// Response
// =============================================================================

export const PublicStatsMetricsSchema = z
    .object({
        overview: PublicStatsOverviewSchema.optional(),
        watchTime: PublicStatsWatchTimeSchema.optional(),
        peakHours: PublicStatsPeakHoursSchema.optional(),
        completion: PublicStatsCompletionSchema.optional(),
        genres: PublicStatsGenresSchema.optional(),
        keywords: PublicStatsKeywordsSchema.optional(),
        devices: PublicStatsDevicesSchema.optional(),
        quality: PublicStatsQualitySchema.optional(),
        ratings: PublicStatsRatingsSchema.optional(),
        tasteProfile: PublicStatsTasteProfileSchema.optional(),
        records: PublicStatsRecordsSchema.optional(),
        topTitles: PublicStatsTopTitlesSchema.optional(),
    })
    .meta({
        id: 'PublicStatsMetrics',
        description:
            'The computed metrics. A requested metric that is missing is in `unavailable`.',
    });

export type PublicStatsMetrics = z.infer<typeof PublicStatsMetricsSchema>;

export const PublicStatsUnavailableReasonSchema = z
    .enum(['insufficient_data', 'access_unavailable', 'failed'])
    .describe(
        '`insufficient_data`: the user has fewer sessions than the metric needs (see ' +
            '`requiredSessions` / `sessionCount`); retry after more viewing. ' +
            "`access_unavailable`: the caller's library access could not be determined, so a " +
            'metric that names titles was withheld rather than shown unfiltered. ' +
            '`failed`: computing the metric failed; retrying may succeed.',
    )
    .meta({ id: 'PublicStatsUnavailableReason' });

export type PublicStatsUnavailableReason = z.infer<typeof PublicStatsUnavailableReasonSchema>;

export const PublicStatsUnavailableSchema = z
    .object({
        metric: PublicPersonalStatsMetricSchema,
        reason: PublicStatsUnavailableReasonSchema,
        requiredSessions: z
            .number()
            .int()
            .optional()
            .describe('Sessions the metric needs (only for `insufficient_data`)'),
        sessionCount: z
            .number()
            .int()
            .optional()
            .describe('Sessions the user has (only for `insufficient_data`)'),
    })
    .meta({
        id: 'PublicStatsUnavailable',
        description: 'A requested metric that is not in `metrics`, with the reason.',
    });

export type PublicStatsUnavailable = z.infer<typeof PublicStatsUnavailableSchema>;

const periodField = z.string().meta({ description: '7d | 30d | 90d | all | year:YYYY' });
const unavailableField = z
    .array(PublicStatsUnavailableSchema)
    .meta({ description: 'Requested metrics that are omitted, in canonical metric order' });

export const PublicPersonalStatsResponseSchema = z
    .object({
        subject: z.object({ id: z.string(), username: z.string() }),
        period: periodField,
        metrics: PublicStatsMetricsSchema,
        unavailable: unavailableField,
    })
    .meta({ id: 'PublicPersonalStatsResponse' });

export const PublicSocialStatsResponseSchema = z
    .object({
        subject: z.object({
            id: z.string(),
            username: z.string(),
            displayName: z.string().optional(),
        }),
        period: periodField,
        metrics: PublicStatsMetricsSchema,
        unavailable: unavailableField,
    })
    .meta({ id: 'PublicSocialStatsResponse' });
