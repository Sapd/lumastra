// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for stripLrcTimestamps — the pure LRC stripping helper exported
 * from lyrics-ingestion-backfill.ts.
 *
 * Tests cover: standard LRC, enhanced LRC word-level timing, metadata tags,
 * empty lines, and plain text passthrough.
 *
 * Also covers the drain loop's no-progress circuit + in-run failed-track
 * exclusion (see the constants/comment block in lyrics-ingestion-backfill.ts):
 * `fetchPendingLyricsTracks` has no offset/exclude parameter and re-selects
 * 'failed' rows, so a down embedding provider would otherwise hot-loop the
 * same batch until the 8h hard timeout.
 */

import { describe, test, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as LyricsQueries from '$lib/server/database/queries/lyrics-search.queries.js';

// ---------------------------------------------------------------------------
// Mocks (hoist-safe) — only used by the execute()-driving tests below;
// stripLrcTimestamps is a pure function and is unaffected by these.
// ---------------------------------------------------------------------------

vi.mock('../../registry.js', () => ({
    registry: { registerTask: vi.fn() },
}));

const configMock = vi.hoisted(() => ({
    features: { lyricsSearch: true },
}));
vi.mock('$lib/server/config.js', () => ({ features: configMock.features }));

const loggerMock = vi.hoisted(() => ({
    inst: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child: vi.fn() },
}));
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: vi.fn(() => loggerMock.inst) },
}));

vi.mock('$lib/server/utils/contained-fs.js', () => ({
    // No .lrc sidecar ever present — forces the DB-lyrics fallback path.
    readContainedFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
}));

vi.mock('../../../ai/embedding-fetch-context.js', () => ({
    runWithEmbeddingFetch: vi.fn(async (_fetch: unknown, fn: () => unknown) => fn()),
}));

const voyageMock = vi.hoisted(() => ({
    isVoyageAvailable: vi.fn(() => true),
    generateVoyageEmbedding: vi.fn<(text: string) => Promise<number[]>>(),
}));
vi.mock('../../../ai/voyage.js', () => voyageMock);

const lyricsQueriesMock = vi.hoisted(() => ({
    fetchPendingLyricsTracks: vi.fn<typeof LyricsQueries.fetchPendingLyricsTracks>(),
    upsertLyricsEmbedding: vi
        .fn<typeof LyricsQueries.upsertLyricsEmbedding>()
        .mockResolvedValue(undefined),
    upsertLyricsEmbeddingState: vi
        .fn<typeof LyricsQueries.upsertLyricsEmbeddingState>()
        .mockResolvedValue(undefined),
    LYRICS_SOURCE_LRC_SIDECAR: 'lrc-sidecar',
    LYRICS_SOURCE_DB_FETCH: 'db-fetch',
}));
vi.mock('../../../database/queries/lyrics-search.queries.js', () => lyricsQueriesMock);

import { stripLrcTimestamps, lyricsIngestionBackfillTask } from './lyrics-ingestion-backfill.js';
import type { PendingLyricsTrackRow } from '$lib/server/database/queries/lyrics-search.queries.js';

describe('stripLrcTimestamps', () => {
    test('strips standard LRC timestamps', () => {
        const lrc = '[00:15.30]First line of lyrics\n[00:30.45]Second line of lyrics';
        const result = stripLrcTimestamps(lrc);
        expect(result).toBe('First line of lyrics\nSecond line of lyrics');
    });

    test('strips enhanced LRC word-level timestamps', () => {
        // Enhanced LRC: word-level <mm:ss.xx> tags are stripped but the
        // surrounding spaces in the original text are preserved as-is.
        // Input: "[00:15.30]<00:15.30>Word <00:15.60>by <00:15.90>word"
        // After stripping all bracket/angle-bracket tags:
        //   "Word by word"  (spaces between words from original text remain)
        const lrc = '[00:15.30]<00:15.30>Word <00:15.60>by <00:15.90>word';
        const result = stripLrcTimestamps(lrc);
        expect(result).toBe('Word by word');
    });

    test('strips LRC metadata tags (ar, al, ti, by, re)', () => {
        const lrc =
            '[ar:Artist Name]\n[al:Album Name]\n[ti:Track Title]\n[00:01.00]First lyric line';
        const result = stripLrcTimestamps(lrc);
        // Metadata tags produce empty lines which are filtered out.
        expect(result).toBe('First lyric line');
    });

    test('removes empty lines', () => {
        const lrc = '[00:01.00]Line one\n\n[00:02.00]Line two\n\n';
        const result = stripLrcTimestamps(lrc);
        expect(result).toBe('Line one\nLine two');
    });

    test('returns empty string for all-empty LRC', () => {
        const lrc = '[00:01.00]\n[00:02.00]\n';
        const result = stripLrcTimestamps(lrc);
        expect(result).toBe('');
    });

    test('passes through plain text with no tags', () => {
        const plain = 'Just plain text lyrics\nSecond line';
        const result = stripLrcTimestamps(plain);
        expect(result).toBe(plain);
    });

    test('handles empty string', () => {
        expect(stripLrcTimestamps('')).toBe('');
    });

    test('trims leading and trailing whitespace from each line', () => {
        const lrc = '[00:01.00]  Leading space\n[00:02.00]Trailing space   ';
        const result = stripLrcTimestamps(lrc);
        expect(result).toBe('Leading space\nTrailing space');
    });

    test('handles multi-timestamp lines (repeat chorus marker)', () => {
        const lrc = '[00:10.00][01:30.00][02:50.00]Repeated chorus line';
        const result = stripLrcTimestamps(lrc);
        // All three timestamp tags are stripped; empty segments filtered.
        expect(result).toBe('Repeated chorus line');
    });
});

// ---------------------------------------------------------------------------
// execute() — no-progress circuit + in-run failed-track exclusion
// ---------------------------------------------------------------------------

function makeTrack(id: string, lyrics: string): PendingLyricsTrackRow {
    return {
        media_item_id: id,
        file_path: `/music/${id}.flac`,
        db_plain_lyrics: lyrics,
        db_synced_lyrics: null,
    } as PendingLyricsTrackRow;
}

function makeCtx() {
    const ac = new AbortController();
    return {
        sql: {} as never,
        signal: ac.signal,
        abortSignal: ac.signal,
        runId: 'test-run',
        input: {},
        logger: loggerMock.inst,
        reportProgress: vi.fn(),
        dep: vi.fn(() => ({ fetch: vi.fn() })),
    } as unknown as Parameters<typeof lyricsIngestionBackfillTask.execute>[0];
}

describe('lyrics-ingestion-backfill: triggers', () => {
    // It is the ONLY writer of media_lyrics_embeddings. When it was manual-only,
    // enabling lyrics search produced an empty index until an operator found and
    // ran this task — on the reference install it never ran at all (0 rows with
    // ~30k tracks carrying fetched lyrics). The schedule is what makes the
    // feature work out of the box.
    it('runs on a schedule, not manual-only', () => {
        expect(lyricsIngestionBackfillTask.manualOnly).toBeFalsy();
        expect(lyricsIngestionBackfillTask.schedule).toMatchObject({
            every: '6h',
            runOnStartup: false,
        });
    });
});

describe('lyrics-ingestion-backfill: no-progress circuit', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        configMock.features.lyricsSearch = true;
        voyageMock.isVoyageAvailable.mockReturnValue(true);
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('throws a transient TaskError when the embedding provider is down for every track (total failure)', async () => {
        // fetchPendingLyricsTracks has no offset param — a real down provider
        // would cause it to keep re-selecting the SAME 'failed' rows forever.
        // Simulate that here: every call returns the identical two tracks.
        const tracks = [makeTrack('t1', 'la la la'), makeTrack('t2', 'na na na')];
        lyricsQueriesMock.fetchPendingLyricsTracks.mockResolvedValue(tracks);
        voyageMock.generateVoyageEmbedding.mockRejectedValue(new Error('provider unreachable'));

        const promise = lyricsIngestionBackfillTask.execute(makeCtx());
        // Attach the rejection expectation BEFORE advancing fake timers so the
        // rejection (which fires mid-advance) is never briefly "unhandled".
        const expectation = expect(promise).rejects.toThrow(/no forward progress/i);
        await vi.advanceTimersByTimeAsync(5_000);
        await expectation;

        // Round 1 attempts both tracks (2 embed calls); round 2's fetch returns
        // the same batch, but BOTH ids are now excluded by the in-run Set, so
        // the loop stops immediately instead of re-attempting them — proving
        // the exclusion, not just the round-count backoff, is what fires here.
        expect(voyageMock.generateVoyageEmbedding).toHaveBeenCalledTimes(2);
        expect(lyricsQueriesMock.fetchPendingLyricsTracks).toHaveBeenCalledTimes(2);
    });

    it('excludes a track that failed earlier this run from later rounds, but still makes progress on new tracks', async () => {
        const trackA = makeTrack('a-always-fails', 'BAD_LYRICS_MARKER');
        const trackB = makeTrack('b-succeeds', 'good lyrics for b');
        const trackC = makeTrack('c-succeeds', 'good lyrics for c');

        lyricsQueriesMock.fetchPendingLyricsTracks
            .mockResolvedValueOnce([trackA, trackB])
            // Round 2: the DB still returns trackA (its status is 'failed', not
            // excluded by the query) alongside a newly-eligible trackC.
            .mockResolvedValueOnce([trackA, trackC])
            .mockResolvedValueOnce([]);

        voyageMock.generateVoyageEmbedding.mockImplementation(async (text: string) => {
            if (text.includes('BAD_LYRICS_MARKER')) throw new Error('embedding failed');
            return [0.1, 0.2, 0.3];
        });

        const promise = lyricsIngestionBackfillTask.execute(makeCtx());
        await vi.advanceTimersByTimeAsync(5_000);
        const result = await promise;

        // trackA attempted once per round it appears in (round 1 only — round 2
        // excludes it), trackB once, trackC once = 3 total calls, NOT 4.
        expect(voyageMock.generateVoyageEmbedding).toHaveBeenCalledTimes(3);
        expect(result.success).toBe(true);
        expect(result.result).toMatchObject({ embedded: 2, failed: 1, noLyrics: 0 });
    });

    it('does NOT trip the circuit while real progress is being made every round', async () => {
        lyricsQueriesMock.fetchPendingLyricsTracks
            .mockResolvedValueOnce([makeTrack('t1', 'lyrics one')])
            .mockResolvedValueOnce([makeTrack('t2', 'lyrics two')])
            .mockResolvedValueOnce([]);
        voyageMock.generateVoyageEmbedding.mockResolvedValue([0.1, 0.2]);

        const promise = lyricsIngestionBackfillTask.execute(makeCtx());
        await vi.advanceTimersByTimeAsync(5_000);
        const result = await promise;

        expect(result.success).toBe(true);
        expect(result.result).toMatchObject({ embedded: 2, failed: 0 });
        const warnedNoProgress = loggerMock.inst.warn.mock.calls.some((c) =>
            String(c[0]).toLowerCase().includes('no forward progress'),
        );
        expect(warnedNoProgress).toBe(false);
    });
});
