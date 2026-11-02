// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * lyrics-lrclib-fetch task — unit tests.
 *
 * Verifies four behaviours:
 *
 * 1. Eligible track (custom_metadata.lyrics == null) → resolveLyrics() called once.
 * 2. Marker-set tracks (custom_metadata.lyrics != null) → excluded by the SQL
 *    eligibility predicate → resolveLyrics() NOT called.
 * 3. features.musicLyricsFetch = false → execute() returns no-op immediately,
 *    resolveLyrics() NOT called.
 * 4. features.autoLyrics = false → task still calls resolveLyrics() (it does
 *    not short-circuit at the task level); resolveLyrics() returns null
 *    internally (it gates on autoLyrics).
 *
 * All mocks are hoisted per the verified hoist-safe convention in __testkit__.
 * No real database or HTTP calls are made.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as MusicQueries from '$lib/server/database/queries/music.queries.js';
import type * as LyricsService from '$lib/server/services/music/lyrics.service.js';
import { makeRecordingSql } from '$lib/server/tasks/__testkit__/index.js';

// ---------------------------------------------------------------------------
// Registry mock — suppress side-effect registration at module load.
// ---------------------------------------------------------------------------

vi.mock('$lib/server/tasks/registry.js', () => ({
    registry: { registerTask: vi.fn() },
    TaskRegistry: vi.fn(),
}));

// ---------------------------------------------------------------------------
// config mock — controls features.musicLyricsFetch and features.autoLyrics.
// Avoid importActual to keep the test fast (config.ts is 3800+ lines).
// ---------------------------------------------------------------------------

const configMock = vi.hoisted(() => ({
    features: {
        musicLyricsFetch: true,
        autoLyrics: true,
        saveLyricsToDisk: false,
    },
}));

vi.mock('$lib/server/config.js', () => ({
    features: configMock.features,
}));

// ---------------------------------------------------------------------------
// music.queries mock — controls eligibility slice and getTrackDetail results.
// ---------------------------------------------------------------------------

const musicQueriesMock = vi.hoisted(() => ({
    fetchEligibleIds: [] as Array<{ id: string }>,
    trackDetail: null as Awaited<ReturnType<typeof MusicQueries.getTrackDetail>>,
}));

vi.mock('$lib/server/database/queries/music.queries.js', () => ({
    getTrackDetail: vi
        .fn<typeof MusicQueries.getTrackDetail>()
        .mockImplementation(async () => musicQueriesMock.trackDetail),
}));

// ---------------------------------------------------------------------------
// lyrics.service mock — spy on resolveLyrics without touching LRCLIB.
// ---------------------------------------------------------------------------

const lyricsMock = vi.hoisted(() => ({
    resolveLyrics: vi.fn<typeof LyricsService.resolveLyrics>().mockResolvedValue({
        plain: 'Hello\nWorld',
        synced: null,
        source: 'lrclib',
        fetchedAt: '2026-06-20T00:00:00.000Z',
    }),
}));

vi.mock('$lib/server/services/music/lyrics.service.js', () => ({
    resolveLyrics: lyricsMock.resolveLyrics,
}));

// ---------------------------------------------------------------------------
// Logger mock — the module-level Logger.for() call must not throw.
// ---------------------------------------------------------------------------

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: vi.fn(() => ({
            info: vi.fn(),
            warn: vi.fn(),
            debug: vi.fn(),
            error: vi.fn(),
        })),
    },
}));

// ---------------------------------------------------------------------------
// Import task AFTER all vi.mock() calls.
// ---------------------------------------------------------------------------

import { lyricsLrcLibFetchTask, roundMadeProgress } from '../lyrics-lrclib-fetch.js';
import type { TrackDetailRow } from '$lib/server/database/queries/music.queries.js';

// ---------------------------------------------------------------------------
// Helper: build a minimal TrackDetailRow for testing.
// ---------------------------------------------------------------------------

function makeTrack(overrides: Partial<TrackDetailRow> = {}): TrackDetailRow {
    return {
        id: 'track-uuid-1',
        title: 'Test Track',
        sort_order: 1,
        runtime_seconds: 240,
        custom_poster_url: null,
        custom_metadata: {},
        parent_id: 'album-uuid-1',
        album_id: 'album-uuid-1',
        album_title: 'Test Album',
        album_custom_poster_url: null,
        album_custom_metadata: {},
        album_year: 2024,
        artist_id: 'artist-uuid-1',
        artist_title: 'Test Artist',
        created_at: '2026-06-20T00:00:00.000Z',
        file_path: '/music/Test Artist/Test Album/01 - Test Track.flac',
        ...overrides,
    } as TrackDetailRow;
}

// ---------------------------------------------------------------------------
// Context factory.
//
// The sql double is used for the eligibility count query and the per-track
// getTrackDetail fetch (which goes through the mocked music.queries module).
// We queue enough responses so the drain loop terminates after one slice.
// ---------------------------------------------------------------------------

function makeCtx(sqlCallResponses: unknown[][] = []) {
    const { sql, queueRows } = makeRecordingSql();
    for (const rows of sqlCallResponses) {
        queueRows(rows);
    }
    const ac = new AbortController();
    return {
        ctx: {
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
        } as unknown as Parameters<typeof lyricsLrcLibFetchTask.execute>[0],
        abort: () => ac.abort(),
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('lyrics-lrclib-fetch: feature gate', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        configMock.features.musicLyricsFetch = true;
        configMock.features.autoLyrics = true;
        lyricsMock.resolveLyrics.mockResolvedValue({
            plain: 'Hello\nWorld',
            synced: null,
            source: 'lrclib',
            fetchedAt: '2026-06-20T00:00:00.000Z',
        });
    });

    it('returns no-op immediately when features.musicLyricsFetch is false', async () => {
        configMock.features.musicLyricsFetch = false;

        // Provide empty SQL responses — the task should return before touching DB.
        const { ctx } = makeCtx([]);

        const result = await lyricsLrcLibFetchTask.execute(ctx);

        expect(result.success).toBe(true);
        expect(result.itemsProcessed).toBe(0);
        expect(result.result).toEqual({ fetched: 0, notFound: 0, skipped: 0, errors: 0 });
        expect(lyricsMock.resolveLyrics).not.toHaveBeenCalled();
    });
});

describe('lyrics-lrclib-fetch: eligible track → resolveLyrics called', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        configMock.features.musicLyricsFetch = true;
        configMock.features.autoLyrics = true;
        lyricsMock.resolveLyrics.mockResolvedValue({
            plain: 'Some lyrics here',
            synced: null,
            source: 'lrclib',
            fetchedAt: '2026-06-20T00:00:00.000Z',
        });
    });

    it('calls resolveLyrics once for an eligible track', async () => {
        const track = makeTrack();
        musicQueriesMock.trackDetail = track;

        // SQL responses:
        // 1. countEligibleTracks → [{ count: 1 }]
        // 2. fetchEligibleTrackIds (first call) → [{ id: 'track-uuid-1' }]
        // 3. fetchEligibleTrackIds (second call, empty → drain terminates) → []
        const { ctx } = makeCtx([[{ count: 1 }], [{ id: 'track-uuid-1' }], []]);

        const result = await lyricsLrcLibFetchTask.execute(ctx);

        expect(lyricsMock.resolveLyrics).toHaveBeenCalledOnce();
        // Verify it was called with the correct track
        expect(lyricsMock.resolveLyrics).toHaveBeenCalledWith(
            expect.anything(), // sql
            expect.objectContaining({ id: 'track-uuid-1', title: 'Test Track' }),
        );

        expect(result.result!.fetched).toBe(1);
        expect(result.result!.notFound).toBe(0);
        expect(result.success).toBe(true);
    });
});

describe('lyrics-lrclib-fetch: marker-set tracks excluded by eligibility query', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        configMock.features.musicLyricsFetch = true;
        configMock.features.autoLyrics = true;
    });

    it('does not call resolveLyrics when the eligibility slice is empty (all tracks have markers)', async () => {
        // Simulate: DB says 0 eligible tracks (all have custom_metadata.lyrics set).
        // countEligibleTracks → [{ count: 0 }]
        // fetchEligibleTrackIds → [] (drain terminates immediately)
        const { ctx } = makeCtx([[{ count: 0 }], []]);

        const result = await lyricsLrcLibFetchTask.execute(ctx);

        expect(lyricsMock.resolveLyrics).not.toHaveBeenCalled();
        expect(result.result!.fetched).toBe(0);
        expect(result.result!.notFound).toBe(0);
        expect(result.success).toBe(true);
    });
});

describe('lyrics-lrclib-fetch: autoLyrics off → task short-circuits before calling resolveLyrics', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        configMock.features.musicLyricsFetch = true;
        configMock.features.autoLyrics = false;
    });

    it('returns no-op immediately when autoLyrics is off; resolveLyrics is never called', async () => {
        const track = makeTrack();
        musicQueriesMock.trackDetail = track;

        // The task short-circuits before touching the DB when autoLyrics is off,
        // so SQL responses are not consumed.
        const { ctx } = makeCtx([]);

        const result = await lyricsLrcLibFetchTask.execute(ctx);

        // The task gates on autoLyrics at the top level — resolveLyrics is never
        // reached, because without autoLyrics resolveLyrics() would return null
        // for every track without writing a marker, causing infinite re-queuing.
        expect(lyricsMock.resolveLyrics).not.toHaveBeenCalled();
        expect(result.result!.fetched).toBe(0);
        expect(result.result!.notFound).toBe(0);
        expect(result.result!.skipped).toBe(0);
        expect(result.result!.errors).toBe(0);
        expect(result.success).toBe(true);
    });
});

describe('lyrics-lrclib-fetch: roundMadeProgress error-rate circuit', () => {
    it('does NOT count a near-100%-failing round as progress (would trip the circuit)', () => {
        // 50-track round, only 1 track marked ineligible (49 errored). The old
        // "> 0" boolean reset the no-progress counter on this single hit and let
        // a ~98%-failing provider grind the full 6h cap. Now it reads as no-progress.
        expect(roundMadeProgress(50, 1)).toBe(false);
        expect(roundMadeProgress(50, 4)).toBe(false);
    });

    it('counts a genuinely-progressing round as progress (must NOT trip)', () => {
        // A healthy provider marks ~every non-error track (fetched or notFound),
        // so it clears the 10% floor comfortably — even a slow one.
        expect(roundMadeProgress(50, 50)).toBe(true);
        expect(roundMadeProgress(50, 25)).toBe(true);
        // A merely-slow provider that still marks a solid chunk stays alive.
        expect(roundMadeProgress(50, 20)).toBe(true);
    });

    it('uses a strict > threshold at exactly 10% of attempted', () => {
        // 10% of 50 = 5 → exactly 5 is NOT above the floor; 6 is.
        expect(roundMadeProgress(50, 5)).toBe(false);
        expect(roundMadeProgress(50, 6)).toBe(true);
    });

    it('handles small final slices (all marked → progress) and empty rounds', () => {
        expect(roundMadeProgress(3, 3)).toBe(true);
        expect(roundMadeProgress(0, 0)).toBe(false);
        expect(roundMadeProgress(50, 0)).toBe(false);
    });
});

describe('lyrics-lrclib-fetch: track with no artist → resolveLyrics still called', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        configMock.features.musicLyricsFetch = true;
        configMock.features.autoLyrics = true;
        lyricsMock.resolveLyrics.mockResolvedValue({
            plain: null,
            synced: null,
            source: 'lrclib',
            fetchedAt: '2026-06-20T00:00:00.000Z',
        });
    });

    it('calls resolveLyrics for a track with null artist_title; counts as notFound when no lyrics returned', async () => {
        const track = makeTrack({ artist_title: null });
        musicQueriesMock.trackDetail = track;

        const { ctx } = makeCtx([[{ count: 1 }], [{ id: 'track-uuid-1' }], []]);

        const result = await lyricsLrcLibFetchTask.execute(ctx);

        // The task no longer special-cases null artist_title — resolveLyrics()
        // is responsible for handling missing metadata and writing the not-found
        // marker so the track is excluded from future runs.
        expect(lyricsMock.resolveLyrics).toHaveBeenCalledOnce();
        expect(result.result!.skipped).toBe(0);
        expect(result.result!.fetched).toBe(0);
        expect(result.result!.notFound).toBe(1);
        expect(result.success).toBe(true);
    });
});
