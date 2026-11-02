// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * toPublicStats / toPublicUnavailable / parsePublicInclude: the v1 serializer for
 * GET /me/stats and /stats/users/{id}. Pure functions, no mocks needed.
 */

import { describe, it, expect } from 'vitest';
import {
    toPublicStats,
    toPublicUnavailable,
    parsePublicInclude,
    transformTopTitles,
} from './transforms.js';
import { PublicStatsMetricsSchema } from '$lib/schemas/public-personal-stats.js';
import type {
    OverviewStats,
    WatchTimeStats,
    PeakHoursStats,
    CompletionStats,
    GenreStats,
    KeywordStats,
    DeviceStats,
    QualityStats,
    RatingStats,
    TasteProfileStats,
    FunRecords,
    TopTitlesStats,
    PersonalStatsType,
} from '$lib/schemas/personal-stats-types.js';

const ID_A = '00000000-0000-4000-a000-00000000000a';
const ID_B = '00000000-0000-4000-a000-00000000000b';

const overview: OverviewStats = {
    totalWatchTimeSeconds: 3600.4,
    totalWatchTimeFormatted: '1h',
    totalSessions: 4,
    uniqueContent: 3,
    completedCount: 2,
    abandonedCount: 1,
    avgCompletionPercentage: 80,
    moviesWatched: 2,
    episodesWatched: 1,
    firstWatchDate: '2026-01-01T00:00:00.000Z',
    lastWatchDate: '2026-02-01T00:00:00.000Z',
};
const watchTime: WatchTimeStats = {
    periods: [
        {
            period: '2026-01-05T00:00:00.000Z',
            watchTimeSeconds: 60,
            watchTimeFormatted: '1m',
            sessionCount: 1,
        },
    ],
    totalWatchTimeSeconds: 60,
    avgPerPeriod: 60,
    trend: 'stable',
    trendPercentage: 0,
};
const peakHours: PeakHoursStats = {
    cells: [{ dayOfWeek: 1, hour: 20, sessionCount: 2, totalSeconds: 7200, intensity: 1 }],
    peakDay: 'Monday',
    peakHour: 20,
    nightOwlScore: 10,
    weekendWarriorScore: 20,
};
const completion: CompletionStats = {
    overallCompletionRate: 70,
    buckets: [{ bucket: '90-100%', count: 2, percentage: 66 }],
    movieCompletionRate: 80,
    episodeCompletionRate: 50,
    abandonedContent: [
        {
            title: 'T',
            mediaType: 'movie',
            timesStarted: 2,
            timesCompleted: 0,
            timesAbandoned: 2,
            abandonRate: 1,
            lastWatched: '2026-02-01T10:00:00.000Z',
        },
    ],
    avgDropOffPoint: 40,
};
const genres: GenreStats = {
    genres: [
        {
            genreId: 1,
            genreName: 'A',
            totalSeconds: 10,
            totalFormatted: '10s',
            percentage: 50,
            contentCount: 1,
        },
        {
            genreId: 2,
            genreName: 'B',
            totalSeconds: 5,
            totalFormatted: '5s',
            percentage: 25,
            contentCount: 1,
        },
        {
            genreId: 3,
            genreName: 'C',
            totalSeconds: 5,
            totalFormatted: '5s',
            percentage: 25,
            contentCount: 1,
        },
    ],
    topGenre: 'A',
    diversityScore: 42,
};
const keywords: KeywordStats = {
    keywords: [{ keyword: 'k', count: 2, percentage: 10 }],
    totalKeywordsTracked: 1,
};
const devices: DeviceStats = {
    devices: [
        {
            clientName: 'web',
            deviceName: 'laptop',
            sessionCount: 3,
            totalSeconds: 120,
            totalFormatted: '2m',
            percentage: 100,
            formFactor: 'desktop',
        },
    ],
    primaryDevice: 'laptop',
    deviceCount: 1,
};
const quality: QualityStats = {
    totalSessions: 4,
    resolution: { uhd4k: 1, hd1080: 2, hd720: 0, sd: 1 },
    avgBitrateKbps: 8000,
};
const ratings: RatingStats = {
    totalRatings: 3,
    avgRating: 7,
    medianRating: 7,
    distribution: [{ rating: 7, count: 3, movieCount: 2, tvCount: 1 }],
    firstRatingDate: '2026-01-02T00:00:00.000Z',
    lastRatingDate: '2026-01-03T00:00:00.000Z',
    ratingFrequency: 1,
};
const tasteProfile: TasteProfileStats = {
    hasProfile: true,
    totalRatings: 5,
    availabilityPreference: 0.5,
    qualityWeight: 0.5,
    popularityWeight: 0.5,
    recencyWeight: 0.5,
    lastActivity: '2026-01-04T00:00:00.000Z',
    profileAge: 12,
    insights: ['x'],
};
const records: FunRecords = {
    longestSession: {
        title: 'Long',
        mediaType: 'movie',
        durationSeconds: 7200,
        durationFormatted: '2h',
        date: '2026-01-06T20:00:00.000Z',
    },
    mostRewatchedMovies: [
        {
            title: 'M',
            timesStarted: 3,
            timesCompleted: 3,
            totalWatchTimeFormatted: '6h',
            internalId: ID_A,
            posterUrl: '/api/image/catalog/x/poster',
        },
    ],
    mostRewatchedSeries: [],
    nightOwlScore: 1,
    bingeScore: 2,
    totalBingeDays: 3,
    longestStreak: 4,
    currentStreak: 5,
};
const topTitles: TopTitlesStats = {
    movies: [
        {
            internalId: ID_A,
            title: 'Movie',
            mediaType: 'movie',
            watchCount: 5,
            totalWatchSeconds: 100,
        },
    ],
    shows: [
        {
            internalId: ID_B,
            title: 'Show',
            mediaType: 'series',
            watchCount: 3,
            totalWatchSeconds: 0.5,
        },
    ],
};

const FULL: Record<PersonalStatsType, unknown> = {
    overview,
    'watch-time': watchTime,
    'peak-hours': peakHours,
    completion,
    genres,
    keywords,
    devices,
    quality,
    ratings,
    'taste-profile': tasteProfile,
    records,
    'top-titles': topTitles,
};

const opts = { limit: 30, offset: 0, surface: 'v1' as const };

describe('toPublicStats', () => {
    it('produces output that satisfies the published metrics schema', () => {
        const { metrics, failed } = toPublicStats(FULL, opts);
        expect(failed).toEqual([]);
        expect(PublicStatsMetricsSchema.safeParse(metrics).success).toBe(true);
        expect(Object.keys(metrics)).toEqual([
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
        ]);
    });

    it('converts seconds to integer milliseconds', () => {
        const { metrics } = toPublicStats(FULL, opts);
        expect(metrics.overview?.totalWatchTimeMs).toBe(3_600_400);
        expect(metrics.watchTime?.totalWatchTimeMs).toBe(60_000);
        expect(metrics.watchTime?.avgPerPeriodMs).toBe(60_000);
        expect(metrics.watchTime?.periods[0]?.watchTimeMs).toBe(60_000);
        expect(metrics.peakHours?.cells[0]?.totalMs).toBe(7_200_000);
        expect(metrics.genres?.items[0]?.totalMs).toBe(10_000);
        expect(metrics.devices?.devices[0]?.totalMs).toBe(120_000);
        expect(metrics.records?.longestSession?.durationMs).toBe(7_200_000);
        expect(metrics.topTitles?.items[1]?.totalWatchTimeMs).toBe(500);
        expect(metrics.quality?.avgBitrateBps).toBe(8_000_000);
    });

    it('renames dates to *At and drops every *Formatted/*Seconds/*Date field', () => {
        const { metrics } = toPublicStats(FULL, opts);
        expect(metrics.overview?.firstWatchAt).toBe('2026-01-01T00:00:00.000Z');
        expect(metrics.completion?.abandonedContent[0]?.lastWatchedAt).toBe(
            '2026-02-01T10:00:00.000Z',
        );
        expect(metrics.ratings?.lastRatingAt).toBe('2026-01-03T00:00:00.000Z');
        expect(metrics.tasteProfile?.lastActivityAt).toBe('2026-01-04T00:00:00.000Z');
        expect(metrics.records?.longestSession?.startedAt).toBe('2026-01-06T20:00:00.000Z');
        expect(metrics.records?.mostRewatchedMovies[0]?.id).toBe(ID_A);

        const keys: string[] = [];
        JSON.stringify(metrics, (k, v) => {
            keys.push(k);
            return v;
        });
        const banned = keys.filter((k) =>
            /Formatted$|Seconds$|Kbps$|Date$|^date$|^lastWatched$/.test(k),
        );
        expect(banned).toEqual([]);
    });

    it('pages genres, keywords and topTitles by limit/offset', () => {
        const { metrics } = toPublicStats(FULL, { ...opts, limit: 1, offset: 1 });
        expect(metrics.genres?.items.map((g) => g.genreName)).toEqual(['B']);
        expect(metrics.genres?.page).toEqual({ limit: 1, offset: 1, hasMore: true, total: 3 });
        expect(metrics.keywords?.items).toEqual([]);
        expect(metrics.topTitles?.items.map((t) => t.title)).toEqual(['Show']);
        expect(metrics.topTitles?.page).toEqual({ limit: 1, offset: 1, hasMore: false, total: 2 });
    });

    it('transformTopTitles starts with movies and reports hasMore', () => {
        const page = transformTopTitles(topTitles, 'v1', 1, 0);
        expect(page.items.map((t) => t.title)).toEqual(['Movie']);
        expect(page.page.hasMore).toBe(true);
    });

    it('only converts present metrics', () => {
        const { metrics } = toPublicStats({ overview }, opts);
        expect(Object.keys(metrics)).toEqual(['overview']);
    });

    it('reports a metric it cannot convert as failed instead of throwing', () => {
        const { metrics, failed } = toPublicStats({ overview, 'watch-time': null }, opts);
        expect(metrics.overview).toBeDefined();
        expect(metrics.watchTime).toBeUndefined();
        expect(failed).toEqual(['watch-time']);
    });

    it('reports a metric failed instead of emitting NaN that breaks its schema', () => {
        const { metrics, failed } = toPublicStats(
            { ...FULL, overview: { ...overview, totalSessions: Number.NaN } },
            opts,
        );
        expect(metrics.overview).toBeUndefined();
        expect(failed).toEqual(['overview']);
        expect(metrics.devices).toBeDefined();
    });
});

describe('toPublicUnavailable', () => {
    it('orders by canonical metric order regardless of completion order', () => {
        const out = toPublicUnavailable(
            [
                { type: 'top-titles', reason: 'failed' },
                { type: 'peak-hours', reason: 'insufficient_data' },
                { type: 'overview', reason: 'failed' },
                { type: 'completion', reason: 'access_unavailable' },
            ],
            2,
        );
        expect(out.map((u) => u.metric)).toEqual([
            'overview',
            'peakHours',
            'completion',
            'topTitles',
        ]);
    });

    it('adds requiredSessions/sessionCount only for insufficient_data', () => {
        const out = toPublicUnavailable(
            [
                { type: 'peak-hours', reason: 'insufficient_data' },
                { type: 'records', reason: 'access_unavailable' },
                { type: 'devices', reason: 'failed' },
            ],
            4,
        );
        expect(out).toEqual([
            {
                metric: 'peakHours',
                reason: 'insufficient_data',
                requiredSessions: 10,
                sessionCount: 4,
            },
            { metric: 'devices', reason: 'failed' },
            { metric: 'records', reason: 'access_unavailable' },
        ]);
    });
    it("omits another user's sessionCount when includeSessionCount is false", () => {
        const out = toPublicUnavailable([{ type: 'peak-hours', reason: 'insufficient_data' }], 4, {
            includeSessionCount: false,
        });
        expect(out).toEqual([
            { metric: 'peakHours', reason: 'insufficient_data', requiredSessions: 10 },
        ]);
    });
});

describe('parsePublicInclude', () => {
    it('returns every metric when include is omitted', () => {
        const { metrics, invalid } = parsePublicInclude(null);
        expect(metrics).toHaveLength(12);
        expect(invalid).toEqual([]);
    });

    it('maps camelCase names to internal types in canonical order, deduplicated', () => {
        const { metrics, invalid } = parsePublicInclude('topTitles, watchTime,overview,watchTime');
        expect(metrics).toEqual(['overview', 'watch-time', 'top-titles']);
        expect(invalid).toEqual([]);
    });

    it('rejects the old kebab-case names and unknown names', () => {
        const { invalid } = parsePublicInclude('watch-time,top-titles,bogus,overview');
        expect(invalid).toEqual(['watch-time', 'top-titles', 'bogus']);
    });
});
