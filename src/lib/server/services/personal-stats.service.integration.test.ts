// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Personal stats against real Postgres — the numbers /my-stats showed wrong on
 * prod (2026-09-27), each pinned at the SQL they come from:
 *
 * - the watch-time stat threw on every period (unquoted date_trunc unit), so
 *   the chart never rendered;
 * - counts were per SESSION: a film resumed in three sittings read as two
 *   abandonments, and titles the watch state marks watched were "abandoned";
 * - genres stored as bare ids read as genre 0 ("Unknown 98 %"), each title was
 *   counted once per provider row, and episodes had no genres;
 * - wall-clock watch time of a player left open (5 h 38 m on a 55-min episode)
 *   inflated totals and won "longest session";
 * - release-format tags, music-track ratings, versioned device names and
 *   resolution-less sessions ("SD") skewed their panels;
 * - the typical viewing window split a night's viewing at midnight.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../tests/integration/helpers/cleanup.js';
import { ensureTestUser } from '../../../../tests/integration/fixtures/user.fixtures.js';
import { toUserId, type UserId } from '$lib/shared/user-id.js';

let sql: postgres.Sql;

const { mockGetTestSql } = vi.hoisted(() => ({ mockGetTestSql: vi.fn() }));

vi.mock('../database/connection.js', async (importActual) => {
    const actual = await importActual<typeof import('../database/connection.js')>();
    return { ...actual, getDb: () => mockGetTestSql() };
});

import { personalStatsService } from './personal-stats.service.js';
import { unrestrictedAccess } from '../database/queries/builders/media-access-boundary.js';

let userId: UserId;

async function mediaItem(opts: {
    title: string;
    mediaType: 'movie' | 'tv' | 'season' | 'episode' | 'track';
    parentId?: string;
}): Promise<string> {
    const id = randomUUID();
    await sql`
        INSERT INTO media_items (id, title, media_type, status, has_files, parent_id)
        VALUES (${id}::uuid, ${opts.title}, ${opts.mediaType}, 'active', true, ${opts.parentId ?? null})
    `;
    return id;
}

async function session(opts: {
    mediaId: string;
    mediaType?: 'movie' | 'episode';
    title?: string;
    seriesName?: string;
    completion?: number;
    status?: 'completed' | 'abandoned';
    seconds?: number;
    runtimeSeconds?: number | null;
    startedAt?: Date;
    clientName?: string;
    deviceName?: string;
    resolutionWidth?: number | null;
}): Promise<void> {
    await sql`
        INSERT INTO watch_history (
            user_id, media_id, media_type, title, series_name,
            session_start_time, completion_percentage, actual_watch_time_seconds,
            total_runtime_seconds, status, client_name, device_name, resolution_width
        ) VALUES (
            ${userId}::uuid, ${opts.mediaId}::uuid, ${opts.mediaType ?? 'movie'},
            ${opts.title ?? 'Title'}, ${opts.seriesName ?? null},
            ${opts.startedAt ?? new Date(Date.now() - 3600_000)}, ${opts.completion ?? 50},
            ${opts.seconds ?? 1800}, ${opts.runtimeSeconds ?? null},
            ${opts.status ?? 'abandoned'}, ${opts.clientName ?? 'Client'},
            ${opts.deviceName ?? 'Device'}, ${opts.resolutionWidth ?? null}
        )
    `;
}

/** `daysAgo` days back at hh:mm Europe/Berlin wall time (the app's stats zone). */
function berlinTime(daysAgo: number, hh: number, mm = 0): Date {
    const day = new Date(Date.now() - daysAgo * 86_400_000);
    const utcGuess = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hh, mm);
    // Berlin's UTC offset on that day (CET +1 / CEST +2), read back through Intl.
    const berlinHour = Number(
        new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Europe/Berlin',
            hour: '2-digit',
            hourCycle: 'h23',
        }).format(new Date(utcGuess)),
    );
    const offsetHours = (berlinHour - hh + 24) % 24;
    return new Date(utcGuess - offsetHours * 3_600_000);
}

beforeAll(() => {
    sql = getTestDb() as unknown as postgres.Sql;
    mockGetTestSql.mockReturnValue(sql);
});

afterAll(async () => {
    await closeTestDb();
});

beforeEach(async () => {
    await truncateTables(sql, [
        ...TEST_TABLES.media,
        ...TEST_TABLES.watchStatus,
        ...TEST_TABLES.userData,
        'provider_metadata',
    ]);
    userId = toUserId(randomUUID());
    await ensureTestUser(sql, userId);
});

describe('personal stats (Integration)', () => {
    it('computes the watch-time series (the stat used to throw on every period)', async () => {
        const movie = await mediaItem({ title: 'A Film', mediaType: 'movie' });
        await session({ mediaId: movie, seconds: 3000 });
        for (const period of ['7d', 'all'] as const) {
            const stats = await personalStatsService.getWatchTimeStats(userId, period);
            expect(stats.periods.length).toBeGreaterThan(0);
            expect(stats.totalWatchTimeSeconds).toBe(3000);
        }
    });

    it('counts finished and unfinished per title, honouring the watch state', async () => {
        // Resumed in three sittings, finished in the last one.
        const resumed = await mediaItem({ title: 'Resumed', mediaType: 'movie' });
        await session({ mediaId: resumed, completion: 30 });
        await session({ mediaId: resumed, completion: 60 });
        await session({ mediaId: resumed, completion: 100, status: 'completed' });
        // Sessions stop at 40 %, but the watch state says watched (finished
        // elsewhere, e.g. another client).
        const elsewhere = await mediaItem({ title: 'Finished Elsewhere', mediaType: 'movie' });
        await session({ mediaId: elsewhere, completion: 40 });
        await sql`
            INSERT INTO user_media_state (user_id, media_id, is_watched, watch_count)
            VALUES (${userId}::uuid, ${elsewhere}::uuid, true, 1)
        `;
        // Reached the end credits (>= 90 %) without the recorder saying completed.
        const credits = await mediaItem({ title: 'Credits', mediaType: 'movie' });
        await session({ mediaId: credits, completion: 93 });
        // Really unfinished.
        const dropped = await mediaItem({ title: 'Dropped', mediaType: 'movie' });
        await session({ mediaId: dropped, completion: 20 });

        const overview = await personalStatsService.getOverviewStats(userId, 'all');
        expect(overview.totalSessions).toBe(6);
        expect(overview.moviesWatched).toBe(4);
        expect(overview.completedCount).toBe(3);
        expect(overview.abandonedCount).toBe(1);

        const completion = await personalStatsService.getCompletionStats(
            userId,
            'all',
            unrestrictedAccess(),
        );
        // Three titles at 100, one at 20.
        expect(completion.overallCompletionRate).toBe(80);
        expect(completion.avgDropOffPoint).toBe(20);
        expect(completion.buckets.map((b) => [b.bucket, b.count])).toEqual([
            ['10-25%', 1],
            ['90-100%', 3],
        ]);
    });

    it('lists a title as frequently abandoned only when it was never finished', async () => {
        const series = await mediaItem({ title: 'Show', mediaType: 'tv' });
        const season = await mediaItem({
            title: 'Season 1',
            mediaType: 'season',
            parentId: series,
        });
        const episode = await mediaItem({ title: 'Pilot', mediaType: 'episode', parentId: season });
        await sql`UPDATE media_items SET season_number = 1, episode_number = 2 WHERE id = ${episode}::uuid`;
        for (const pct of [10, 35]) {
            await sql`
                INSERT INTO watch_history (user_id, media_id, media_type, title, series_name,
                    season_number, episode_number, session_start_time, completion_percentage,
                    actual_watch_time_seconds, status)
                VALUES (${userId}::uuid, ${episode}::uuid, 'episode', 'Pilot', 'Show', 1, 2,
                    NOW() - interval '2 hours', ${pct}, 600, 'abandoned')
            `;
        }
        // Started twice, but the watch state says watched: not abandoned.
        const watched = await mediaItem({ title: 'Watched Anyway', mediaType: 'movie' });
        await session({ mediaId: watched, completion: 20 });
        await session({ mediaId: watched, completion: 40 });
        await sql`
            INSERT INTO user_media_state (user_id, media_id, is_watched, watch_count)
            VALUES (${userId}::uuid, ${watched}::uuid, true, 1)
        `;

        const { abandonedContent } = await personalStatsService.getCompletionStats(
            userId,
            'all',
            unrestrictedAccess(),
        );
        expect(abandonedContent).toHaveLength(1);
        expect(abandonedContent[0]).toMatchObject({
            title: 'Pilot',
            seriesName: 'Show',
            seasonNumber: 1,
            episodeNumber: 2,
            maxCompletion: 35,
            timesStarted: 2,
        });
    });

    it('caps watch time at the runtime and skips a player left open for "longest session"', async () => {
        const episode = await mediaItem({ title: 'Left Open', mediaType: 'movie' });
        // 5 h 38 m wall clock on a 55-min title, playhead never moved.
        await session({ mediaId: episode, seconds: 20_329, runtimeSeconds: 3300, completion: 0 });
        const film = await mediaItem({ title: 'Real Sitting', mediaType: 'movie' });
        await session({ mediaId: film, seconds: 5400, runtimeSeconds: 6000, completion: 90 });

        const overview = await personalStatsService.getOverviewStats(userId, 'all');
        expect(overview.totalWatchTimeSeconds).toBe(3300 + 5400);

        const records = await personalStatsService.getFunRecords(
            userId,
            'all',
            unrestrictedAccess(),
        );
        expect(records.longestSession?.title).toBe('Real Sitting');
        expect(records.longestSession?.durationSeconds).toBe(5400);
    });

    it('reads bare and object genre ids once per title and gives episodes their series genres', async () => {
        const movie = await mediaItem({ title: 'Crime Film', mediaType: 'movie' });
        // Two provider rows for one title — bare ids in one, objects in the other.
        await sql`
            INSERT INTO provider_metadata (media_id, provider, metadata) VALUES
                (${movie}::uuid, 'tmdb', ${sql.json({ genres: [80, 18] })}),
                (${movie}::uuid, 'aggregated', ${sql.json({
                    genres: [
                        { id: 80, name: 'Crime' },
                        { id: 18, name: 'Drama' },
                    ],
                })})
        `;
        await session({ mediaId: movie, seconds: 4000 });
        const series = await mediaItem({ title: 'Comedy Show', mediaType: 'tv' });
        const season = await mediaItem({ title: 'S1', mediaType: 'season', parentId: series });
        const episode = await mediaItem({ title: 'Ep', mediaType: 'episode', parentId: season });
        await sql`
            INSERT INTO provider_metadata (media_id, provider, metadata)
            VALUES (${series}::uuid, 'tmdb', ${sql.json({ genres: [35] })})
        `;
        await session({ mediaId: episode, mediaType: 'episode', seconds: 2000 });

        const genres = await personalStatsService.getGenreStats(userId, 'all');
        const byName = Object.fromEntries(genres.genres.map((g) => [g.genreName, g.totalSeconds]));
        // The film's 4000 s split across its two genres, counted once (not per
        // provider row); the episode's 2000 s go to its series' genre.
        expect(byName).toEqual({ Crime: 2000, Drama: 2000, Comedy: 2000 });
        expect(genres.genres.some((g) => g.genreName === 'Unknown')).toBe(false);
        expect(genres.genres.reduce((s, g) => s + g.percentage, 0)).toBeGreaterThanOrEqual(99);
        // Three equal shares: perfectly even.
        expect(genres.diversityScore).toBe(100);
    });

    it('leaves release-format tags out of the keyword list', async () => {
        const movie = await mediaItem({ title: 'Tagged', mediaType: 'movie' });
        await sql`
            INSERT INTO provider_metadata (media_id, provider, metadata)
            VALUES (${movie}::uuid, 'mdblist', ${sql.json({ mdblist_keywords: ['has-trailer', 'dvd', '4k-ultra-hd', 'certified-fresh', 'heist'] })})
        `;
        await session({ mediaId: movie });
        const { keywords } = await personalStatsService.getKeywordStats(userId, 'all');
        expect(keywords.map((k) => k.keyword)).toEqual(['heist']);
    });

    it('merges device rows that differ only by version and classifies them', async () => {
        const movie = await mediaItem({ title: 'Any', mediaType: 'movie' });
        const chrome = (v: number): string =>
            `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.`;
        await session({ mediaId: movie, clientName: 'Lumastra Web', deviceName: chrome(149) });
        await session({ mediaId: movie, clientName: 'Lumastra Web', deviceName: chrome(150) });
        await session({
            mediaId: movie,
            clientName: 'Infuse-Direct 8.4.4',
            deviceName: 'Apple TV',
        });
        await session({
            mediaId: movie,
            clientName: 'Infuse-Direct 8.4.3',
            deviceName: 'Apple TV',
        });

        const stats = await personalStatsService.getDeviceStats(userId, 'all');
        const rows = stats.devices.map((d) => [
            d.clientName,
            d.deviceName,
            d.formFactor,
            d.sessionCount,
        ]);
        expect(rows).toEqual(
            expect.arrayContaining([
                ['Lumastra Web', 'Chrome on macOS', 'desktop', 2],
                ['Infuse-Direct', 'Apple TV', 'tv', 2],
            ]),
        );
        expect(stats.deviceCount).toBe(2);
    });

    it('counts sessions without a resolution as unknown, not SD', async () => {
        const movie = await mediaItem({ title: 'Any', mediaType: 'movie' });
        await session({ mediaId: movie, resolutionWidth: null });
        await session({ mediaId: movie, resolutionWidth: 720 });
        await session({ mediaId: movie, resolutionWidth: 1920 });
        const quality = await personalStatsService.getQualityStats(userId, 'all');
        expect(quality.resolution).toMatchObject({ sd: 1, hd1080: 1, unknown: 1 });
    });

    it('rates movies and shows only, not music tracks', async () => {
        const movie = await mediaItem({ title: 'Rated Film', mediaType: 'movie' });
        const track = await mediaItem({ title: 'A Song', mediaType: 'track' });
        await sql`
            INSERT INTO user_ratings (user_id, media_id, rating) VALUES
                (${userId}::uuid, ${movie}::uuid, 8),
                (${userId}::uuid, ${track}::uuid, 6)
        `;
        const ratings = await personalStatsService.getRatingStats(userId);
        expect(ratings.totalRatings).toBe(1);
        expect(ratings.distribution.map((d) => d.rating)).toEqual([8]);
    });

    it('keeps a night of viewing together in the typical viewing window', async () => {
        const movie = await mediaItem({ title: 'Night', mediaType: 'movie' });
        // Evenings, some running past midnight — none in the morning.
        const starts: Array<[number, number]> = [
            [21, 0],
            [21, 30],
            [22, 0],
            [22, 30],
            [23, 0],
            [23, 30],
            [0, 15],
            [0, 45],
            [20, 30],
            [21, 15],
        ];
        for (const [i, [hh, mm]] of starts.entries()) {
            await session({ mediaId: movie, startedAt: berlinTime(i + 1, hh, mm) });
        }
        const { typicalViewingWindow } = await personalStatsService.getFunRecords(
            userId,
            'all',
            unrestrictedAccess(),
        );
        // A midnight-based day put the 00:15 session first ("00:xx – 23:xx");
        // the evening window must start in the evening and end after midnight.
        expect(typicalViewingWindow?.start.slice(0, 2)).toMatch(/^(20|21)$/);
        expect(typicalViewingWindow?.end.slice(0, 2)).toBe('00');
    });

    it('counts a rewatch only for a movie finished twice', async () => {
        const halves = await mediaItem({ title: 'Watched In Halves', mediaType: 'movie' });
        await session({ mediaId: halves, completion: 55 });
        await session({ mediaId: halves, completion: 100, status: 'completed' });
        const twice = await mediaItem({ title: 'Seen Twice', mediaType: 'movie' });
        await session({ mediaId: twice, completion: 100, status: 'completed' });
        await session({ mediaId: twice, completion: 95 });
        const records = await personalStatsService.getFunRecords(
            userId,
            'all',
            unrestrictedAccess(),
        );
        expect(records.mostRewatchedMovies.map((m) => m.title)).toEqual(['Seen Twice']);
    });
});
