// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Regression: the lyrics drain loop must back off and STOP after a few rounds
 * that made zero progress — it must not hot-loop the same slice until the 6h
 * hard timeout when LRCLIB is down.
 *
 * The drain always re-fetches from offset 0 and relies on resolveLyrics()
 * writing a marker to make a track ineligible. When LRCLIB is unreachable,
 * resolveLyrics() throws for every track (no marker written), so the same slice
 * is re-selected forever. This mirrors the fix already shipped in
 * sonic-embedding-backfill.ts (NO_PROGRESS_BACKOFF_MS / MAX_NO_PROGRESS_ROUNDS).
 *
 * We drive an INEXHAUSTIBLE eligibility slice (always returns a row) so that
 * WITHOUT the circuit the loop would never terminate. The only way `execute`
 * returns is the no-progress break — so a finite resolveLyrics call count is
 * the proof the circuit fired.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type postgres from 'postgres';
import type * as MusicQueries from '$lib/server/database/queries/music.queries.js';
import type * as LyricsService from '$lib/server/services/music/lyrics.service.js';

// ---------------------------------------------------------------------------
// Mocks (hoist-safe)
// ---------------------------------------------------------------------------

vi.mock('$lib/server/tasks/registry.js', () => ({
    registry: { registerTask: vi.fn() },
    TaskRegistry: vi.fn(),
}));

const configMock = vi.hoisted(() => ({
    features: { musicLyricsFetch: true, autoLyrics: true, saveLyricsToDisk: false },
}));
vi.mock('$lib/server/config.js', () => ({ features: configMock.features }));

const musicQueriesMock = vi.hoisted(() => ({
    trackDetail: null as Awaited<ReturnType<typeof MusicQueries.getTrackDetail>>,
}));
vi.mock('$lib/server/database/queries/music.queries.js', () => ({
    getTrackDetail: vi
        .fn<typeof MusicQueries.getTrackDetail>()
        .mockImplementation(async () => musicQueriesMock.trackDetail),
}));

const lyricsMock = vi.hoisted(() => ({
    resolveLyrics: vi.fn<typeof LyricsService.resolveLyrics>(),
}));
vi.mock('$lib/server/services/music/lyrics.service.js', () => ({
    resolveLyrics: lyricsMock.resolveLyrics,
}));

// Stable module-logger instance so we can assert on the no-progress warn.
const loggerMock = vi.hoisted(() => ({
    inst: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child: vi.fn() },
}));
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: vi.fn(() => loggerMock.inst) },
}));

import { lyricsLrcLibFetchTask } from '../lyrics-lrclib-fetch.js';
import type { TrackDetailRow } from '$lib/server/database/queries/music.queries.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTrack(): TrackDetailRow {
    return {
        id: 'track-1',
        title: 'Test Track',
        sort_order: 1,
        runtime_seconds: 200,
        custom_poster_url: null,
        custom_metadata: {},
        parent_id: 'album-1',
        album_id: 'album-1',
        album_title: 'Album',
        album_custom_poster_url: null,
        album_custom_metadata: {},
        album_year: 2024,
        artist_id: 'artist-1',
        artist_title: 'Artist',
        created_at: '2026-06-20T00:00:00.000Z',
        file_path: '/music/Artist/Album/01 - Track.flac',
    } as TrackDetailRow;
}

/**
 * sql double whose eligibility slice never empties (LRCLIB-down scenario) but
 * whose COUNT query returns a fixed total. Distinguishes the two queries by the
 * COUNT(*) marker in the SQL text.
 */
function makeInexhaustibleSql(): postgres.Sql {
    const tag = (strings: TemplateStringsArray): Promise<unknown[]> => {
        const q = strings.join('?');
        if (q.includes('COUNT(*)')) return Promise.resolve([{ count: 1 }]);
        return Promise.resolve([{ id: 'track-1' }]);
    };
    return tag as unknown as postgres.Sql;
}

/** sql double whose slice empties after `rounds` non-empty fetches. */
function makeFiniteSql(rounds: number): postgres.Sql {
    let served = 0;
    const tag = (strings: TemplateStringsArray): Promise<unknown[]> => {
        const q = strings.join('?');
        if (q.includes('COUNT(*)')) return Promise.resolve([{ count: rounds }]);
        if (served >= rounds) return Promise.resolve([]);
        served++;
        return Promise.resolve([{ id: 'track-1' }]);
    };
    return tag as unknown as postgres.Sql;
}

function makeCtx(sql: postgres.Sql) {
    const ac = new AbortController();
    return {
        sql: sql as unknown as Parameters<typeof lyricsLrcLibFetchTask.execute>[0]['sql'],
        logger: {
            info: vi.fn(),
            warn: vi.fn(),
            debug: vi.fn(),
            error: vi.fn(),
            child: vi.fn(),
        } as unknown as Parameters<typeof lyricsLrcLibFetchTask.execute>[0]['logger'],
        signal: ac.signal,
        abortSignal: ac.signal,
        runId: 'test-run',
        input: {},
        reportProgress: vi.fn(),
    } as unknown as Parameters<typeof lyricsLrcLibFetchTask.execute>[0];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('lyrics-lrclib-fetch: no-progress circuit', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        configMock.features.musicLyricsFetch = true;
        configMock.features.autoLyrics = true;
        musicQueriesMock.trackDetail = makeTrack();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('breaks after MAX_NO_PROGRESS_ROUNDS when LRCLIB is down (every fetch throws)', async () => {
        // resolveLyrics throws → errors++ with no marker → the slice stays
        // eligible forever. The inexhaustible sql means only the circuit can
        // stop the loop.
        lyricsMock.resolveLyrics.mockRejectedValue(new Error('LRCLIB unreachable'));

        const ctx = makeCtx(makeInexhaustibleSql());
        const promise = lyricsLrcLibFetchTask.execute(ctx);
        // Drive fake time past all the backoff sleeps (4 × 5s + rate limits).
        await vi.advanceTimersByTimeAsync(120_000);
        const result = await promise;

        // One track processed per round; the circuit broke the loop after a
        // bounded number of fruitless rounds (would otherwise be unbounded).
        expect(lyricsMock.resolveLyrics).toHaveBeenCalledTimes(4);
        expect(result.result!.errors).toBe(4);
        expect(result.success).toBe(true);

        const warnedNoProgress = loggerMock.inst.warn.mock.calls.some((c) =>
            String(c[0]).toLowerCase().includes('no progress'),
        );
        expect(warnedNoProgress).toBe(true);
    });

    it('does NOT trip the circuit while real progress is being made', async () => {
        // Every round writes lyrics (a marker) → progress each round resets the
        // counter. The loop ends only when the slice empties.
        lyricsMock.resolveLyrics.mockResolvedValue({
            plain: 'la la la',
            synced: null,
            source: 'lrclib',
            fetchedAt: '2026-06-20T00:00:00.000Z',
        });

        const ctx = makeCtx(makeFiniteSql(3));
        const promise = lyricsLrcLibFetchTask.execute(ctx);
        await vi.advanceTimersByTimeAsync(30_000);
        const result = await promise;

        expect(lyricsMock.resolveLyrics).toHaveBeenCalledTimes(3);
        expect(result.result!.fetched).toBe(3);
        const warnedNoProgress = loggerMock.inst.warn.mock.calls.some((c) =>
            String(c[0]).toLowerCase().includes('no progress'),
        );
        expect(warnedNoProgress).toBe(false);
    });
});
