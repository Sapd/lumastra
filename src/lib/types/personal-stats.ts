// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Personal Statistics Types
 *
 * Types are re-exported from Zod schemas in '$lib/schemas/personal-stats-types'.
 * The schema file is the SINGLE SOURCE OF TRUTH for personal stats API response types.
 */

// Re-export all types from schemas
export type {
    PersonalStatsType,
    StatsPeriod,
    OverviewStats,
    WatchTimePeriod,
    WatchTimeTrend,
    WatchTimeStats,
    PeakHourCell,
    PeakHoursStats,
    CompletionBucket,
    AbandonedContent,
    CompletionStats,
    GenreStat,
    GenreStats,
    KeywordStat,
    KeywordStats,
    DeviceStat,
    DeviceStats,
    ResolutionBreakdown,
    QualityStats,
    RatingDistribution,
    RatingStats,
    TasteProfileStats,
    SessionRecord,
    RewatchRecord,
    FunRecords,
    TopTitleItem,
    TopTitlesStats,
    PersonalStatsResponse,
} from '$lib/schemas/personal-stats-types';

// =============================================================================
// Minimum Data Requirements
// =============================================================================

/**
 * Minimum number of data points required to display each stats type.
 * Used for feature gating in the UI.
 */
export const MINIMUM_DATA_REQUIREMENTS = {
    overview: 1,
    'watch-time': 3,
    'peak-hours': 10,
    completion: 5,
    genres: 5,
    keywords: 5,
    devices: 1,
    quality: 1,
    ratings: 3,
    'taste-profile': 5,
    records: 1,
    'top-titles': 3,
} as const;
