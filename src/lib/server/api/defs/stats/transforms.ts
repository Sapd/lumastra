// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/stats/transforms.ts — ranked-metric response transforms.
 *
 * Converts raw service output for `top-titles`, `genres`, and `keywords`
 * into the §8.5/{items,page} + §8.6/MediaSummary envelope expected by v1.
 *
 * Rules:
 *  - `top-titles`: flattened list of §8.6 MediaSummary handles (type:'series',
 *    not 'tv'); sort order is watch-count DESC within each type, then merged
 *    as movies first, shows second (stable, deterministic).
 *  - `genres`: {items, page} envelope; items are plain genre stat objects.
 *  - `keywords`: {items, page} envelope; items are plain keyword stat objects.
 *
 * These transforms run at the def layer, not the service layer, so the service
 * methods remain unchanged and re-usable by non-API consumers.
 *
 * `toPublicStats` is the v1 serializer: it converts the INTERNAL service output
 * (what the shared stats cache stores and the web endpoints serve) to the public
 * DTOs in `$lib/schemas/public-personal-stats.ts` (millisecond units, no
 * `*Formatted` strings, `*At` timestamps, camelCase metric keys).
 */

import { paginate } from '$lib/server/api/problem.js';
import type {
    TopTitlesStats,
    GenreStats,
    KeywordStats,
    OverviewStats,
    WatchTimeStats,
    PeakHoursStats,
    CompletionStats,
    DeviceStats,
    QualityStats,
    RatingStats,
    TasteProfileStats,
    FunRecords,
    PersonalStatsType,
} from '$lib/types/personal-stats.js';
import { MINIMUM_DATA_REQUIREMENTS } from '$lib/types/personal-stats.js';
import { apiBase, type ApiSurface } from '$lib/shared/api-urls.js';
import { Logger } from '$lib/server/utils/logger.js';
import {
    PUBLIC_METRIC_BY_INTERNAL_TYPE,
    PUBLIC_STATS_METRICS,
    INTERNAL_TYPE_BY_PUBLIC_METRIC,
    PublicPersonalStatsMetricSchema,
    PublicStatsMetricsSchema,
    type PublicPersonalStatsMetric,
    type PublicStatsMetrics,
    type PublicStatsUnavailable,
    type PublicStatsUnavailableReason,
} from '$lib/schemas/public-personal-stats.js';

const logger = Logger.for('PersonalStats');

/** Public metrics whose schema mismatch was already logged by this process. */
const loggedInvalidMetrics = new Set<PublicPersonalStatsMetric>();

/** Seconds (possibly fractional) to integer milliseconds. */
function secondsToMs(seconds: number): number {
    return Math.round(seconds * 1000);
}

// ---------------------------------------------------------------------------
// §8.6 MediaSummary handle (minimal — id/type/ids/title/year/images)
// ---------------------------------------------------------------------------

interface MediaSummaryHandle {
    id: string;
    /** Canonical public type discriminator. */
    type: 'movie' | 'series';
    ids: { internal: string };
    title: string;
    year?: number;
    images: {
        poster: { href: string };
        backdrop: { href: string };
    };
    /** Additional stats fields surfaced as siblings (non-standard extension). */
    watchCount: number;
    totalWatchTimeMs: number;
}

function buildHandle(
    item: {
        internalId?: string;
        title: string;
        mediaType: 'movie' | 'series';
        year?: number;
        watchCount: number;
        totalWatchSeconds: number;
    },
    surface: ApiSurface,
): MediaSummaryHandle | null {
    if (!item.internalId) return null;

    // `item.mediaType` is ALREADY the canonical public discriminator (see
    // TopTitleItemSchema: `'movie' | 'series'`, not the raw 'tv' storage
    // token) — it needs no further conversion here.
    const type = item.mediaType;
    const base = `${apiBase(surface)}/media/${item.internalId}/images`;

    return {
        id: item.internalId,
        type,
        ids: { internal: item.internalId },
        title: item.title,
        year: item.year,
        images: {
            poster: { href: `${base}/poster` },
            backdrop: { href: `${base}/backdrop` },
        },
        watchCount: item.watchCount,
        totalWatchTimeMs: secondsToMs(item.totalWatchSeconds),
    };
}

/**
 * Convert `top-titles` service output to `{items, page}` with MediaSummary handles.
 *
 * Movies appear first (already sorted by watch-count in the service), followed by
 * shows — callers that want a unified interleaved list can sort client-side by
 * `watchCount`. The service returns at most 10 movies + 10 shows; `limit`/`offset`
 * page that merged list like `genres` and `keywords`.
 */
export function transformTopTitles(
    stats: TopTitlesStats,
    surface: ApiSurface,
    limit: number,
    offset: number,
) {
    const movieItems = stats.movies
        .map((m) => buildHandle(m, surface))
        .filter((h): h is MediaSummaryHandle => h !== null);

    const showItems = stats.shows
        .map((s) => buildHandle(s, surface))
        .filter((h): h is MediaSummaryHandle => h !== null);

    const all = [...movieItems, ...showItems];
    const slice = all.slice(offset, offset + limit);
    const hasMore = offset + limit < all.length;

    return paginate(slice, { limit, offset, hasMore, total: all.length });
}

/**
 * Convert `genres` service output to `{items, page}`, paged client-side via the
 * `limit` and `offset` arguments. Seconds become `totalMs`; `totalFormatted` is dropped.
 */
export function transformGenres(stats: GenreStats, limit: number, offset: number) {
    const all = stats.genres;
    const slice = all.slice(offset, offset + limit);
    const hasMore = offset + limit < all.length;

    // Preserve enrichment fields (topGenre, diversityScore) in a meta block.
    return {
        ...paginate(
            slice.map((g) => ({
                genreId: g.genreId,
                genreName: g.genreName,
                totalMs: secondsToMs(g.totalSeconds),
                percentage: g.percentage,
                contentCount: g.contentCount,
            })),
            { limit, offset, hasMore, total: all.length },
        ),
        meta: {
            topGenre: stats.topGenre,
            diversityScore: stats.diversityScore,
        },
    };
}

/**
 * Convert `keywords` service output to `{items, page}`.
 */
export function transformKeywords(stats: KeywordStats, limit: number, offset: number) {
    const all = stats.keywords;
    const slice = all.slice(offset, offset + limit);
    const hasMore = offset + limit < all.length;

    return {
        ...paginate(slice, { limit, offset, hasMore, total: all.length }),
        meta: {
            totalKeywordsTracked: stats.totalKeywordsTracked,
        },
    };
}

// ---------------------------------------------------------------------------
// Public (v1) serializer
// ---------------------------------------------------------------------------

function toOverview(s: OverviewStats): NonNullable<PublicStatsMetrics['overview']> {
    return {
        totalWatchTimeMs: secondsToMs(s.totalWatchTimeSeconds),
        totalSessions: s.totalSessions,
        uniqueContent: s.uniqueContent,
        completedCount: s.completedCount,
        abandonedCount: s.abandonedCount,
        avgCompletionPercentage: s.avgCompletionPercentage,
        moviesWatched: s.moviesWatched,
        episodesWatched: s.episodesWatched,
        firstWatchAt: s.firstWatchDate,
        lastWatchAt: s.lastWatchDate,
    };
}

function toWatchTime(s: WatchTimeStats): NonNullable<PublicStatsMetrics['watchTime']> {
    return {
        periods: s.periods.map((p) => ({
            period: p.period,
            watchTimeMs: secondsToMs(p.watchTimeSeconds),
            sessionCount: p.sessionCount,
        })),
        totalWatchTimeMs: secondsToMs(s.totalWatchTimeSeconds),
        avgPerPeriodMs: secondsToMs(s.avgPerPeriod),
        trend: s.trend,
        trendPercentage: s.trendPercentage,
    };
}

function toPeakHours(s: PeakHoursStats): NonNullable<PublicStatsMetrics['peakHours']> {
    return {
        cells: s.cells.map((c) => ({
            dayOfWeek: c.dayOfWeek,
            hour: c.hour,
            sessionCount: c.sessionCount,
            totalMs: secondsToMs(c.totalSeconds),
            intensity: c.intensity,
        })),
        peakDay: s.peakDay,
        peakHour: s.peakHour,
        nightOwlScore: s.nightOwlScore,
        weekendWarriorScore: s.weekendWarriorScore,
    };
}

function toCompletion(s: CompletionStats): NonNullable<PublicStatsMetrics['completion']> {
    return {
        overallCompletionRate: s.overallCompletionRate,
        buckets: s.buckets,
        movieCompletionRate: s.movieCompletionRate,
        episodeCompletionRate: s.episodeCompletionRate,
        abandonedContent: s.abandonedContent.map(({ lastWatched, ...rest }) => ({
            ...rest,
            lastWatchedAt: lastWatched,
        })),
        avgDropOffPoint: s.avgDropOffPoint,
    };
}

function toDevices(s: DeviceStats): NonNullable<PublicStatsMetrics['devices']> {
    return {
        devices: s.devices.map((d) => ({
            clientName: d.clientName,
            deviceName: d.deviceName,
            sessionCount: d.sessionCount,
            totalMs: secondsToMs(d.totalSeconds),
            percentage: d.percentage,
            formFactor: d.formFactor,
        })),
        primaryDevice: s.primaryDevice,
        deviceCount: s.deviceCount,
    };
}

function toQuality(s: QualityStats): NonNullable<PublicStatsMetrics['quality']> {
    return {
        totalSessions: s.totalSessions,
        resolution: s.resolution,
        avgBitrateBps:
            s.avgBitrateKbps === undefined ? undefined : Math.round(s.avgBitrateKbps * 1000),
    };
}

function toRatings(s: RatingStats): NonNullable<PublicStatsMetrics['ratings']> {
    return {
        totalRatings: s.totalRatings,
        avgRating: s.avgRating,
        medianRating: s.medianRating,
        distribution: s.distribution,
        firstRatingAt: s.firstRatingDate,
        lastRatingAt: s.lastRatingDate,
        ratingFrequency: s.ratingFrequency,
    };
}

function toTasteProfile(s: TasteProfileStats): NonNullable<PublicStatsMetrics['tasteProfile']> {
    return {
        hasProfile: s.hasProfile,
        totalRatings: s.totalRatings,
        availabilityPreference: s.availabilityPreference,
        qualityWeight: s.qualityWeight,
        popularityWeight: s.popularityWeight,
        recencyWeight: s.recencyWeight,
        lastActivityAt: s.lastActivity,
        profileAge: s.profileAge,
        insights: s.insights,
    };
}

function toRecords(s: FunRecords): NonNullable<PublicStatsMetrics['records']> {
    const rewatch = (r: FunRecords['mostRewatchedMovies'][number]) => ({
        id: r.internalId,
        title: r.title,
        seriesName: r.seriesName,
        timesStarted: r.timesStarted,
        timesCompleted: r.timesCompleted,
    });
    return {
        longestSession: s.longestSession && {
            title: s.longestSession.title,
            seriesName: s.longestSession.seriesName,
            mediaType: s.longestSession.mediaType,
            durationMs: secondsToMs(s.longestSession.durationSeconds),
            startedAt: s.longestSession.date,
            clientName: s.longestSession.clientName,
            deviceName: s.longestSession.deviceName,
        },
        mostRewatchedMovies: s.mostRewatchedMovies.map(rewatch),
        mostRewatchedSeries: s.mostRewatchedSeries.map(rewatch),
        nightOwlScore: s.nightOwlScore,
        bingeScore: s.bingeScore,
        totalBingeDays: s.totalBingeDays,
        typicalViewingWindow: s.typicalViewingWindow,
        longestStreak: s.longestStreak,
        currentStreak: s.currentStreak,
    };
}

export interface ToPublicStatsOptions {
    /** Page size for genres, keywords and topTitles. */
    limit: number;
    /** Page offset for genres, keywords and topTitles. */
    offset: number;
    surface: ApiSurface;
}

export interface ToPublicStatsResult {
    metrics: PublicStatsMetrics;
    /** Internal types whose cached/computed value could not be converted. */
    failed: PersonalStatsType[];
}

/** Convert one internal metric value to its public DTO (throws on an unexpected shape). */
function convertMetric(
    name: PublicPersonalStatsMetric,
    value: unknown,
    opts: ToPublicStatsOptions,
): unknown {
    switch (name) {
        case 'overview':
            return toOverview(value as OverviewStats);
        case 'watchTime':
            return toWatchTime(value as WatchTimeStats);
        case 'peakHours':
            return toPeakHours(value as PeakHoursStats);
        case 'completion':
            return toCompletion(value as CompletionStats);
        case 'genres':
            return transformGenres(value as GenreStats, opts.limit, opts.offset);
        case 'keywords':
            return transformKeywords(value as KeywordStats, opts.limit, opts.offset);
        case 'devices':
            return toDevices(value as DeviceStats);
        case 'quality':
            return toQuality(value as QualityStats);
        case 'ratings':
            return toRatings(value as RatingStats);
        case 'tasteProfile':
            return toTasteProfile(value as TasteProfileStats);
        case 'records':
            return toRecords(value as FunRecords);
        case 'topTitles':
            return transformTopTitles(
                value as TopTitlesStats,
                opts.surface,
                opts.limit,
                opts.offset,
            );
    }
}

/**
 * Convert internal stats service output (keyed by internal kebab-case type) to the
 * public v1 `metrics` object. Pure: the shared cache keeps the internal shape.
 *
 * A metric whose value cannot be converted (unexpected cached shape), or whose
 * converted value does not match its published schema (NaN, a missing field),
 * is reported in `failed` instead of being emitted or failing the whole response.
 */
export function toPublicStats(
    internal: Partial<Record<PersonalStatsType, unknown>>,
    opts: ToPublicStatsOptions,
): ToPublicStatsResult {
    const metrics: Record<string, unknown> = {};
    const failed: PersonalStatsType[] = [];

    for (const name of PUBLIC_STATS_METRICS) {
        const type = INTERNAL_TYPE_BY_PUBLIC_METRIC[name];
        const value = internal[type];
        if (value === undefined) continue;
        let converted: unknown;
        try {
            converted = convertMetric(name, value, opts);
        } catch {
            failed.push(type);
            continue;
        }
        const check = PublicStatsMetricsSchema.shape[name].safeParse(converted);
        if (!check.success || converted === undefined) {
            if (!loggedInvalidMetrics.has(name)) {
                loggedInvalidMetrics.add(name);
                logger.warn(
                    'Personal stats metric does not match its public schema; reported failed',
                    {
                        metric: name,
                        issues: check.success ? 'undefined' : check.error.issues.slice(0, 5),
                    },
                );
            }
            failed.push(type);
            continue;
        }
        metrics[name] = converted;
    }
    return { metrics: metrics as PublicStatsMetrics, failed };
}

/** An internal metric that is not in the response, and why. */
export interface UnavailableMetric {
    type: PersonalStatsType;
    reason: PublicStatsUnavailableReason;
}

/**
 * Build the public `unavailable` array in canonical metric order (the fan-out
 * completes in arbitrary order). `insufficient_data` entries carry the session
 * requirement and, unless `includeSessionCount` is false (another user's stats:
 * their session count is not the viewer's to see), the user's session count.
 */
export function toPublicUnavailable(
    entries: UnavailableMetric[],
    sessionCount: number,
    { includeSessionCount = true }: { includeSessionCount?: boolean } = {},
): PublicStatsUnavailable[] {
    const order = (e: UnavailableMetric): number =>
        PUBLIC_STATS_METRICS.indexOf(PUBLIC_METRIC_BY_INTERNAL_TYPE[e.type]);
    return [...entries]
        .sort((a, b) => order(a) - order(b))
        .map((e) =>
            e.reason === 'insufficient_data'
                ? {
                      metric: PUBLIC_METRIC_BY_INTERNAL_TYPE[e.type],
                      reason: e.reason,
                      requiredSessions: MINIMUM_DATA_REQUIREMENTS[e.type],
                      ...(includeSessionCount ? { sessionCount } : {}),
                  }
                : { metric: PUBLIC_METRIC_BY_INTERNAL_TYPE[e.type], reason: e.reason },
        );
}

/**
 * Parse the `?include=` list of camelCase public metric names into internal types.
 * Omitted/empty means every metric. Anything else (including the old kebab-case
 * names) is reported in `invalid`.
 */
export function parsePublicInclude(raw: string | null): {
    metrics: PersonalStatsType[];
    invalid: string[];
} {
    const all = PUBLIC_STATS_METRICS.map((m) => INTERNAL_TYPE_BY_PUBLIC_METRIC[m]);
    if (!raw) return { metrics: all, invalid: [] };
    const parts = raw
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
    const wanted = new Set<PersonalStatsType>();
    const invalid: string[] = [];
    for (const part of parts) {
        const parsed = PublicPersonalStatsMetricSchema.safeParse(part);
        if (parsed.success) wanted.add(INTERNAL_TYPE_BY_PUBLIC_METRIC[parsed.data]);
        else invalid.push(part);
    }
    // Canonical order, deduplicated.
    const metrics = all.filter((t) => wanted.has(t));
    return { metrics: metrics.length > 0 ? metrics : all, invalid };
}
