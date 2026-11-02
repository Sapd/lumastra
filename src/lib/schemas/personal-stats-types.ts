// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Personal Statistics Zod Schemas
 *
 * SINGLE SOURCE OF TRUTH for personal stats API response types.
 * These schemas define the contract for the /my-stats feature.
 *
 * Usage:
 * - Server: Validate responses before sending
 * - Client: Runtime type validation
 * - OpenAPI: Auto-generate documentation
 * - TypeScript: Infer types for type safety
 *
 * Convention:
 * - Use .optional() for optional fields (NOT .nullable())
 * - Add .meta({ description: '...' }) for OpenAPI docs
 * - Export both schema and inferred type
 */

import { z } from 'zod';

// =============================================================================
// API Types
// =============================================================================

/**
 * Personal statistics type discriminator
 */
export const PersonalStatsTypeSchema = z
    .enum([
        'overview',
        'watch-time',
        'peak-hours',
        'completion',
        'genres',
        'keywords',
        'devices',
        'quality',
        'ratings',
        'taste-profile',
        'records',
        'top-titles',
    ])
    .describe('Personal statistics type')
    .meta({ id: 'PersonalStatsType' });

export type PersonalStatsType = z.infer<typeof PersonalStatsTypeSchema>;

/**
 * Time period for statistics aggregation.
 * `year:YYYY` is the "wrapped"/year-in-review preset: the full calendar year
 * given (Jan 1 – Dec 31 local time). Treated as a window by the service layer,
 * not a new engine. Four-digit years 2000-2099 are accepted.
 */
export const StatsPeriodSchema = z
    .union([
        z.enum(['7d', '30d', '90d', 'all']),
        z
            .string()
            .regex(/^year:20\d{2}$/, 'Must be one of 7d|30d|90d|all or year:YYYY (2000–2099)'),
    ])
    .describe('Statistics time period')
    .meta({ id: 'StatsPeriod' });

export type StatsPeriod = z.infer<typeof StatsPeriodSchema>;

// =============================================================================
// Overview Stats
// =============================================================================

/**
 * High-level overview statistics
 */
export const OverviewStatsSchema = z
    .object({
        /** Total watch time in seconds */
        totalWatchTimeSeconds: z.number().describe('Total watch time in seconds'),
        /** Human-readable total watch time */
        totalWatchTimeFormatted: z.string().describe('Formatted total watch time'),
        /** Total number of viewing sessions */
        totalSessions: z.number().describe('Total number of sessions'),
        /** Number of unique content items watched */
        uniqueContent: z.number().describe('Unique content count'),
        /**
         * Distinct titles finished — a session reached the end (>= 90 %), the
         * recorder marked it completed, or the watch state says watched. Counted
         * per TITLE, not per session: resuming a film in three sittings is one
         * finished title, not two abandoned sessions and a completed one.
         */
        completedCount: z.number().describe('Finished titles (distinct)'),
        /** Distinct titles started in the period and not finished */
        abandonedCount: z.number().describe('Started-but-unfinished titles (distinct)'),
        /** Average of each title's furthest progress (percent) */
        avgCompletionPercentage: z.number().describe('Average furthest progress per title'),
        /** Distinct movies watched */
        moviesWatched: z.number().describe('Distinct movies watched'),
        /** Distinct episodes watched */
        episodesWatched: z.number().describe('Distinct episodes watched'),
        /** First watch date (ISO string) */
        firstWatchDate: z.string().optional().describe('First watch date'),
        /** Last watch date (ISO string) */
        lastWatchDate: z.string().optional().describe('Last watch date'),
    })
    .meta({ id: 'OverviewStats', description: 'Overview statistics summary' });

export type OverviewStats = z.infer<typeof OverviewStatsSchema>;

// =============================================================================
// Watch Time Stats
// =============================================================================

/**
 * Watch time data for a single period
 */
export const WatchTimePeriodSchema = z
    .object({
        /** ISO date string for the period */
        period: z.string().describe('Period date (ISO string)'),
        /** Total watch time in seconds for this period */
        watchTimeSeconds: z.number().describe('Watch time in seconds'),
        /** Human-readable watch time */
        watchTimeFormatted: z.string().describe('Formatted watch time'),
        /** Number of sessions in this period */
        sessionCount: z.number().describe('Session count'),
    })
    .meta({
        id: 'WatchTimePeriod',
        description: 'Watch time data for a single period',
    });

export type WatchTimePeriod = z.infer<typeof WatchTimePeriodSchema>;

/**
 * Watch time trend direction
 */
export const WatchTimeTrendSchema = z
    .enum(['up', 'down', 'stable'])
    .describe('Watch time trend direction')
    .meta({ id: 'WatchTimeTrend' });

export type WatchTimeTrend = z.infer<typeof WatchTimeTrendSchema>;

/**
 * Watch time statistics over time
 */
export const WatchTimeStatsSchema = z
    .object({
        /** Time periods with watch time data */
        periods: z.array(WatchTimePeriodSchema).describe('Watch time periods'),
        /** Total watch time in seconds across all periods */
        totalWatchTimeSeconds: z.number().describe('Total watch time in seconds'),
        /** Average watch time per period */
        avgPerPeriod: z.number().describe('Average per period'),
        /** Overall trend direction */
        trend: WatchTimeTrendSchema,
        /** Trend percentage change */
        trendPercentage: z.number().describe('Trend percentage change'),
    })
    .meta({
        id: 'WatchTimeStats',
        description: 'Watch time statistics over time',
    });

export type WatchTimeStats = z.infer<typeof WatchTimeStatsSchema>;

// =============================================================================
// Peak Hours Heatmap
// =============================================================================

/**
 * Single cell in the peak hours heatmap
 */
export const PeakHourCellSchema = z
    .object({
        /** Day of week (0 = Sunday, 6 = Saturday) */
        dayOfWeek: z.number().int().min(0).max(6).describe('Day of week (0-6)'),
        /** Hour of day (0-23) */
        hour: z.number().int().min(0).max(23).describe('Hour of day (0-23)'),
        /** Number of sessions in this time slot */
        sessionCount: z.number().describe('Session count'),
        /** Total watch time in seconds for this slot */
        totalSeconds: z.number().describe('Total seconds'),
        /** Normalized intensity for color (0-1) */
        intensity: z.number().min(0).max(1).describe('Normalized intensity (0-1)'),
    })
    .meta({ id: 'PeakHourCell', description: 'Peak hours heatmap cell' });

export type PeakHourCell = z.infer<typeof PeakHourCellSchema>;

/**
 * Peak hours heatmap statistics
 */
export const PeakHoursStatsSchema = z
    .object({
        /** Heatmap cells for all day/hour combinations */
        cells: z.array(PeakHourCellSchema).describe('Heatmap cells'),
        /** Peak day of week (e.g., "Saturday") */
        peakDay: z.string().describe('Peak day of week'),
        /** Peak hour of day (0-23) */
        peakHour: z.number().int().min(0).max(23).describe('Peak hour (0-23)'),
        /** Percentage of sessions between midnight and 4am */
        nightOwlScore: z.number().describe('Night owl score (% midnight-4am)'),
        /** Percentage of sessions on weekends */
        weekendWarriorScore: z.number().describe('Weekend warrior score (%)'),
    })
    .meta({
        id: 'PeakHoursStats',
        description: 'Peak hours heatmap statistics',
    });

export type PeakHoursStats = z.infer<typeof PeakHoursStatsSchema>;

// =============================================================================
// Completion Stats
// =============================================================================

/**
 * Completion rate bucket
 */
export const CompletionBucketSchema = z
    .object({
        /** Bucket label (e.g., "0-10%", "90-100%") */
        bucket: z.string().describe('Bucket label'),
        /** Number of items in this bucket */
        count: z.number().int().describe('Item count'),
        /** Percentage of total items */
        percentage: z.number().describe('Percentage of total'),
    })
    .meta({ id: 'CompletionBucket', description: 'Completion rate bucket' });

export type CompletionBucket = z.infer<typeof CompletionBucketSchema>;

/**
 * Abandoned content item
 */
export const AbandonedContentSchema = z
    .object({
        /** Content title */
        title: z.string().describe('Content title'),
        /** Series name if episode */
        seriesName: z.string().optional().describe('Series name'),
        /** Season number, for an episode */
        seasonNumber: z.number().optional().describe('Season number (episodes)'),
        /** Episode number, for an episode */
        episodeNumber: z.number().optional().describe('Episode number (episodes)'),
        /** Furthest progress reached across all sessions (percent) */
        maxCompletion: z.number().optional().describe('Furthest progress reached (percent)'),
        /** Media type */
        mediaType: z.string().describe('Media type'),
        /** Number of times started */
        timesStarted: z.number().describe('Times started'),
        /** Number of times completed */
        timesCompleted: z.number().describe('Times completed'),
        /** Number of times abandoned */
        timesAbandoned: z.number().describe('Times abandoned'),
        /** Abandon rate (0-1) */
        abandonRate: z.number().describe('Abandon rate'),
        /** Last watched date (ISO string); omitted when unknown */
        lastWatched: z.string().optional().describe('Last watched date'),
    })
    .meta({ id: 'AbandonedContent', description: 'Abandoned content item' });

export type AbandonedContent = z.infer<typeof AbandonedContentSchema>;

/**
 * Completion statistics
 */
export const CompletionStatsSchema = z
    .object({
        /** Overall completion rate (0-100) */
        overallCompletionRate: z.number().describe('Overall completion rate'),
        /** Completion rate buckets */
        buckets: z.array(CompletionBucketSchema).describe('Completion buckets'),
        /** Movie-specific completion rate */
        movieCompletionRate: z.number().describe('Movie completion rate'),
        /** Episode-specific completion rate */
        episodeCompletionRate: z.number().describe('Episode completion rate'),
        /** List of most abandoned content */
        abandonedContent: z.array(AbandonedContentSchema).describe('Abandoned content'),
        /** Average drop-off point percentage */
        avgDropOffPoint: z.number().describe('Average drop-off point'),
    })
    .meta({ id: 'CompletionStats', description: 'Completion statistics' });

export type CompletionStats = z.infer<typeof CompletionStatsSchema>;

// =============================================================================
// Genre Stats
// =============================================================================

/**
 * Genre watch statistics
 */
export const GenreStatSchema = z
    .object({
        /** Genre ID */
        genreId: z.number().describe('Genre ID'),
        /** Genre name */
        genreName: z.string().describe('Genre name'),
        /** Total watch time in seconds */
        totalSeconds: z.number().describe('Total seconds'),
        /** Human-readable watch time */
        totalFormatted: z.string().describe('Formatted total time'),
        /** Percentage of total watch time */
        percentage: z.number().describe('Percentage of total'),
        /** Number of content items in this genre */
        contentCount: z.number().describe('Content count'),
    })
    .meta({ id: 'GenreStat', description: 'Genre watch statistics' });

export type GenreStat = z.infer<typeof GenreStatSchema>;

/**
 * Genre statistics summary
 */
export const GenreStatsSchema = z
    .object({
        /** List of genre statistics */
        genres: z.array(GenreStatSchema).describe('Genre statistics'),
        /** Top genre name */
        topGenre: z.string().describe('Top genre'),
        /** Genre diversity score (0-100) */
        diversityScore: z.number().describe('Diversity score (0-100)'),
    })
    .meta({ id: 'GenreStats', description: 'Genre statistics summary' });

export type GenreStats = z.infer<typeof GenreStatsSchema>;

// =============================================================================
// MDB Keyword Stats
// =============================================================================

/**
 * Keyword watch statistics
 */
export const KeywordStatSchema = z
    .object({
        /** Keyword text */
        keyword: z.string().describe('Keyword'),
        /** Number of content items with this keyword */
        count: z.number().int().describe('Content count'),
        /** Percentage of total content */
        percentage: z.number().describe('Percentage of total'),
    })
    .meta({ id: 'KeywordStat', description: 'Keyword watch statistics' });

export type KeywordStat = z.infer<typeof KeywordStatSchema>;

/**
 * Keyword statistics summary
 */
export const KeywordStatsSchema = z
    .object({
        /** List of keyword statistics */
        keywords: z.array(KeywordStatSchema).describe('Keyword statistics'),
        /** Total number of unique keywords tracked */
        totalKeywordsTracked: z.number().describe('Total keywords tracked'),
    })
    .meta({ id: 'KeywordStats', description: 'Keyword statistics summary' });

export type KeywordStats = z.infer<typeof KeywordStatsSchema>;

// =============================================================================
// Device Stats
// =============================================================================

/**
 * Device usage statistics
 */
export const DeviceStatSchema = z
    .object({
        /** Client application name */
        clientName: z.string().describe('Client application name'),
        /** Device name */
        deviceName: z.string().describe('Device name'),
        /** Number of sessions on this device */
        sessionCount: z.number().describe('Session count'),
        /** Total watch time in seconds */
        totalSeconds: z.number().describe('Total seconds'),
        /** Human-readable watch time */
        totalFormatted: z.string().describe('Formatted total time'),
        /** Percentage of total watch time */
        percentage: z.number().describe('Percentage of total'),
        /** Device class derived from the client and device names */
        formFactor: z
            .enum(['mobile', 'tablet', 'tv', 'desktop', 'unknown'])
            .optional()
            .describe('Device class: mobile / tablet / tv / desktop / unknown'),
    })
    .meta({ id: 'DeviceStat', description: 'Device usage statistics' });

export type DeviceStat = z.infer<typeof DeviceStatSchema>;

/**
 * Device statistics summary
 */
export const DeviceStatsSchema = z
    .object({
        /** List of device statistics */
        devices: z.array(DeviceStatSchema).describe('Device statistics'),
        /** Primary device name */
        primaryDevice: z.string().describe('Primary device'),
        /** Number of unique devices */
        deviceCount: z.number().describe('Device count'),
    })
    .meta({ id: 'DeviceStats', description: 'Device statistics summary' });

export type DeviceStats = z.infer<typeof DeviceStatsSchema>;

// =============================================================================
// Quality Stats
// =============================================================================

/**
 * Resolution breakdown
 */
export const ResolutionBreakdownSchema = z
    .object({
        /** Number of 4K UHD sessions */
        uhd4k: z.number().describe('4K UHD session count'),
        /** Number of 1080p HD sessions */
        hd1080: z.number().describe('1080p HD session count'),
        /** Number of 720p HD sessions */
        hd720: z.number().describe('720p HD session count'),
        /** Number of SD sessions (a recorded width below 1280) */
        sd: z.number().describe('SD session count'),
        /**
         * Sessions with no recorded resolution (external players, older rows).
         * These used to be counted as SD, which made SD look like the most
         * common quality.
         */
        unknown: z.number().optional().describe('Sessions with no recorded resolution'),
    })
    .meta({ id: 'ResolutionBreakdown', description: 'Resolution breakdown' });

export type ResolutionBreakdown = z.infer<typeof ResolutionBreakdownSchema>;

/**
 * Quality statistics
 */
export const QualityStatsSchema = z
    .object({
        /** Total number of sessions */
        totalSessions: z.number().describe('Total session count'),
        /**
         * Number of transcoded sessions.
         * Not yet implemented: the play_method / transcode columns were dropped
         * from watch_history (migration 11.85.0), so this is omitted rather than
         * fabricated. The UI hides the tile when absent.
         */
        transcodedSessions: z
            .number()
            .optional()
            .describe('Transcoded session count (not yet implemented — no backing data)'),
        /** Percentage of sessions transcoded (not yet implemented — no backing data) */
        transcodePercentage: z
            .number()
            .optional()
            .describe('Transcode percentage (not yet implemented — no backing data)'),
        /** Percentage of sessions direct played (not yet implemented — no backing data) */
        directPlayPercentage: z
            .number()
            .optional()
            .describe('Direct play percentage (not yet implemented — no backing data)'),
        /** Resolution breakdown */
        resolution: ResolutionBreakdownSchema,
        /**
         * Number of HDR sessions.
         * Not yet implemented: the video_range column was dropped from
         * watch_history (migration 11.85.0). Omitted rather than reported as 0.
         */
        hdrCount: z
            .number()
            .optional()
            .describe('HDR session count (not yet implemented — no backing data)'),
        /** Number of SDR sessions (not yet implemented — no backing data) */
        sdrCount: z
            .number()
            .optional()
            .describe('SDR session count (not yet implemented — no backing data)'),
        /** Average bitrate in kbps */
        avgBitrateKbps: z.number().optional().describe('Average bitrate (kbps)'),
    })
    .meta({ id: 'QualityStats', description: 'Quality statistics' });

export type QualityStats = z.infer<typeof QualityStatsSchema>;

// =============================================================================
// Rating Stats
// =============================================================================

/**
 * Rating distribution bucket
 */
export const RatingDistributionSchema = z
    .object({
        /** Rating value (1-10) */
        rating: z.number().int().min(1).max(10).describe('Rating value (1-10)'),
        /** Total count for this rating */
        count: z.number().int().describe('Total count'),
        /** Number of movies with this rating */
        movieCount: z.number().describe('Movie count'),
        /** Number of TV shows with this rating */
        tvCount: z.number().describe('TV show count'),
    })
    .meta({
        id: 'RatingDistribution',
        description: 'Rating distribution bucket',
    });

export type RatingDistribution = z.infer<typeof RatingDistributionSchema>;

/**
 * Rating statistics
 */
export const RatingStatsSchema = z
    .object({
        /** Total number of ratings */
        totalRatings: z.number().describe('Total rating count'),
        /** Average rating */
        avgRating: z.number().describe('Average rating'),
        /** Median rating */
        medianRating: z.number().describe('Median rating'),
        /** Rating distribution buckets */
        distribution: z.array(RatingDistributionSchema).describe('Rating distribution'),
        /** First rating date (ISO string) */
        firstRatingDate: z.string().optional().describe('First rating date'),
        /** Last rating date (ISO string) */
        lastRatingDate: z.string().optional().describe('Last rating date'),
        /** Average ratings per month */
        ratingFrequency: z.number().describe('Ratings per month'),
    })
    .meta({ id: 'RatingStats', description: 'Rating statistics' });

export type RatingStats = z.infer<typeof RatingStatsSchema>;

// =============================================================================
// Taste Profile Stats (AI)
// =============================================================================

/**
 * AI taste profile statistics
 */
export const TasteProfileStatsSchema = z
    .object({
        /** Whether user has an AI taste profile */
        hasProfile: z.boolean().describe('Has taste profile'),
        /** Total number of ratings used for profile */
        totalRatings: z.number().describe('Total rating count'),
        /** Availability preference (0-1) */
        availabilityPreference: z.number().describe('Availability preference (0-1)'),
        /** Quality weight in recommendations */
        qualityWeight: z.number().describe('Quality weight'),
        /** Popularity weight in recommendations */
        popularityWeight: z.number().describe('Popularity weight'),
        /** Recency weight in recommendations */
        recencyWeight: z.number().describe('Recency weight'),
        /** Last profile activity date (ISO string) */
        lastActivity: z.string().optional().describe('Last activity date'),
        /** Profile age in days */
        profileAge: z.number().describe('Profile age (days)'),
        /** AI-generated insights about taste */
        insights: z.array(z.string()).describe('AI insights'),
    })
    .meta({
        id: 'TasteProfileStats',
        description: 'AI taste profile statistics',
    });

export type TasteProfileStats = z.infer<typeof TasteProfileStatsSchema>;

// =============================================================================
// Fun Records
// =============================================================================

/**
 * Individual session record
 */
export const SessionRecordSchema = z
    .object({
        /** Content title */
        title: z.string().describe('Content title'),
        /** Series name if episode */
        seriesName: z.string().optional().describe('Series name'),
        /** Media type */
        mediaType: z.string().describe('Media type'),
        /** Session duration in seconds */
        durationSeconds: z.number().describe('Duration in seconds'),
        /** Human-readable duration */
        durationFormatted: z.string().describe('Formatted duration'),
        /** Session date (ISO string) */
        date: z.string().describe('Session date'),
        /** Client application name */
        clientName: z.string().optional().describe('Client name'),
        /** Device name */
        deviceName: z.string().optional().describe('Device name'),
    })
    .meta({ id: 'SessionRecord', description: 'Individual session record' });

export type SessionRecord = z.infer<typeof SessionRecordSchema>;

/**
 * Rewatch record
 */
export const RewatchRecordSchema = z
    .object({
        /** Content title */
        title: z.string().describe('Content title'),
        /** Series name if applicable */
        seriesName: z.string().optional().describe('Series name'),
        /** Number of times started */
        timesStarted: z.number().describe('Times started'),
        /** Number of times completed */
        timesCompleted: z.number().describe('Times completed'),
        /** Total watch time (human-readable) */
        totalWatchTimeFormatted: z.string().describe('Total watch time'),
        /** Internal media UUID (movie row, or resolved series row) for poster art. */
        internalId: z.string().optional().describe('Internal media id'),
        /** Poster image URL. */
        posterUrl: z.string().optional().describe('Poster URL'),
    })
    .meta({ id: 'RewatchRecord', description: 'Rewatch record' });

export type RewatchRecord = z.infer<typeof RewatchRecordSchema>;

/**
 * Fun records and achievements
 */
export const FunRecordsSchema = z
    .object({
        /** Longest single viewing session */
        longestSession: SessionRecordSchema.optional().describe('Longest session'),
        /** Most rewatched movies */
        mostRewatchedMovies: z.array(RewatchRecordSchema).describe('Most rewatched movies'),
        /** Most rewatched series */
        mostRewatchedSeries: z.array(RewatchRecordSchema).describe('Most rewatched series'),
        /** Night owl score (% sessions midnight-4am) */
        nightOwlScore: z.number().describe('Night owl score'),
        /** Binge score (number of 3+ hour same-series sessions) */
        bingeScore: z.number().describe('Binge score'),
        /** Total number of binge days */
        totalBingeDays: z.number().describe('Total binge days'),
        /**
         * Typical viewing window — the 10th–90th percentile band of session
         * start-of-day times (HH:MM), plus the median. Replaces raw earliest/latest,
         * which saturate to ~00:00/23:59 once a user has enough sessions.
         */
        typicalViewingWindow: z
            .object({
                /** 10th-percentile start time (HH:MM). */
                start: z.string().describe('Window start (HH:MM)'),
                /** 90th-percentile end time (HH:MM). */
                end: z.string().describe('Window end (HH:MM)'),
                /** Median start time (HH:MM). */
                median: z.string().describe('Median start (HH:MM)'),
            })
            .optional()
            .describe('Typical viewing window (p10–p90 of start time)'),
        /** Longest consecutive days watching */
        longestStreak: z.number().describe('Longest streak (days)'),
        /** Current consecutive days watching */
        currentStreak: z.number().describe('Current streak (days)'),
    })
    .meta({ id: 'FunRecords', description: 'Fun records and achievements' });

export type FunRecords = z.infer<typeof FunRecordsSchema>;

/**
 * A single most-watched title (movie or show) for the Top Titles section.
 */
export const TopTitleItemSchema = z
    .object({
        /** Display title (series name for shows, movie title for movies) */
        title: z.string().describe('Title'),
        /** Canonical public media type discriminator ('series' for TV shows, not 'tv'). */
        mediaType: z.enum(['movie', 'series']).describe('Media type'),
        /** Release year, when known */
        year: z.number().optional().describe('Year'),
        /** Internal media_items UUID, when the title resolves to a catalog row */
        internalId: z.string().optional().describe('Internal UUID'),
        /** Pre-built poster URL (/api/image/catalog/{uuid}/poster) */
        posterUrl: z.string().optional().describe('Poster URL'),
        /** Number of qualifying sessions this user had (episode plays, for shows) */
        watchCount: z.number().describe('Watch count (sessions)'),
        /** Total watch time in seconds */
        totalWatchSeconds: z.number().describe('Total watch seconds'),
        /**
         * Total episodes in the series' library (has_files = true). Shows only.
         * Used to normalize watchCount into a "times through the series" ratio
         * (watchCount / episodeCount), so a long series does not out-rank a short
         * one purely by episode count. Omitted for movies.
         */
        episodeCount: z
            .number()
            .optional()
            .describe('Total library episodes (shows only, for completion ratio)'),
        /** Distinct episodes this user watched (shows only) */
        episodesWatched: z.number().optional().describe('Distinct episodes watched (shows only)'),
        /** Times the user reached the end of this movie (>= 90 %) */
        finishedCount: z
            .number()
            .optional()
            .describe('Times finished (movies only; a session reaching >= 90 %)'),
    })
    .meta({ id: 'TopTitleItem', description: 'A most-watched title' });

export type TopTitleItem = z.infer<typeof TopTitleItemSchema>;

/**
 * Top Titles statistics — the user's most-watched movies and shows.
 */
export const TopTitlesStatsSchema = z
    .object({
        movies: z.array(TopTitleItemSchema).describe('Most-watched movies'),
        shows: z.array(TopTitleItemSchema).describe('Most-watched shows'),
    })
    .meta({ id: 'TopTitlesStats', description: 'Most-watched titles' });

export type TopTitlesStats = z.infer<typeof TopTitlesStatsSchema>;

// =============================================================================
// Combined Response Type
// =============================================================================

/**
 * Personal statistics response - discriminated union of all stat types
 */
export const PersonalStatsResponseSchema = z
    .discriminatedUnion('type', [
        z.object({ type: z.literal('overview'), stats: OverviewStatsSchema }),
        z.object({
            type: z.literal('watch-time'),
            stats: WatchTimeStatsSchema,
        }),
        z.object({
            type: z.literal('peak-hours'),
            stats: PeakHoursStatsSchema,
        }),
        z.object({
            type: z.literal('completion'),
            stats: CompletionStatsSchema,
        }),
        z.object({ type: z.literal('genres'), stats: GenreStatsSchema }),
        z.object({ type: z.literal('keywords'), stats: KeywordStatsSchema }),
        z.object({ type: z.literal('devices'), stats: DeviceStatsSchema }),
        z.object({ type: z.literal('quality'), stats: QualityStatsSchema }),
        z.object({ type: z.literal('ratings'), stats: RatingStatsSchema }),
        z.object({
            type: z.literal('taste-profile'),
            stats: TasteProfileStatsSchema,
        }),
        z.object({ type: z.literal('records'), stats: FunRecordsSchema }),
        z.object({ type: z.literal('top-titles'), stats: TopTitlesStatsSchema }),
    ])
    .meta({
        id: 'PersonalStatsResponse',
        description: 'Personal statistics response',
    });

export type PersonalStatsResponse = z.infer<typeof PersonalStatsResponseSchema>;
