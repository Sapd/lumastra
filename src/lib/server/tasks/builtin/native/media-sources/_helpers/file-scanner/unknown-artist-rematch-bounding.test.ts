// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Regression: `rematchUnknownArtistTracks` runs inside ONE advisory-locked
 * transaction (see the `withAdvisoryLock` caller in file-scanner.ts). An
 * unbounded serial loop over the entire "unknown artist" backlog held that lock
 * long enough to starve other scanners on a large music library, and never
 * checked the abort signal or reported progress.
 *
 * These tests assert the invocation is now BOUNDED and abort-aware:
 *   1. At most MAX_REMATCH_TRACKS_PER_RUN tracks are examined per call; the
 *      rest are left for the next scan (this pass is idempotent + self-healing).
 *   2. A heartbeat pulse is emitted per examined track.
 *   3. An already-aborted signal stops the pass before it touches any track.
 *   4. The per-run cap window ROTATES across scans: the tracks query orders by
 *      `rematch_attempted_at` (NULLS FIRST) and examined-but-unmatched tracks
 *      are stamped, so a rematchable track sitting past the first cap window is
 *      eventually examined instead of being starved behind an unrematchable
 *      prefix forever.
 *
 * Note (flagged): the advisory lock is still HELD across the (now bounded)
 * batch. Releasing it per-track was deliberately NOT done — the lock exists to
 * stop two replicas oscillating the same tracks, so releasing mid-batch would
 * reintroduce that race. Bounding the batch caps the lock-hold instead.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeRecordingSql } from '$lib/server/tasks/__testkit__/index.js';

// ---------------------------------------------------------------------------
// Mocks — the per-track body derives an artist name; force every derivation to
// "Unknown Artist" so each track hits the cheap `continue` path AFTER being
// counted. That keeps the test focused on the bounding/abort logic without
// exercising the re-parent write path.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
    parseAudioTags: vi.fn(async () => ({}) as Record<string, unknown>),
    // Default: every track stays "Unknown Artist" (cheap continue path). The
    // rotation test overrides this to resolve a real artist for one late track.
    deriveArtistName: vi.fn((_args: unknown) => 'Unknown Artist' as string),
    // Write-path doubles for the rotation test's single rematchable track.
    // Existing bounding tests never reach these (all tracks stay Unknown Artist).
    findOrCreateMusicArtist: vi.fn(async () => 'real-artist-id'),
    findOrCreateMusicAlbum: vi.fn(async () => 'real-album-id'),
}));
const parseAudioTags = mocks.parseAudioTags;

vi.mock('./audio-tag-parser.js', () => ({
    parseAudioTags: mocks.parseAudioTags,
    hasReplacementChar: vi.fn(() => false),
}));

// Partial mock — the module also exports VARIOUS_ARTISTS_LABEL (read at module
// eval time in audio-processor.ts), so keep the real exports and only force
// deriveArtistName so a track lands on the cheap "still Unknown Artist" continue
// path (or, in the rotation test, resolves a real artist).
vi.mock('../../../../../../utils/music-scanner-utils.js', async (importOriginal) => {
    const actual =
        await importOriginal<typeof import('../../../../../../utils/music-scanner-utils.js')>();
    return {
        ...actual,
        deriveArtistName: mocks.deriveArtistName,
    };
});

// The re-parent write path resolves the real artist/album ids. Stubbing these
// keeps the rotation test off a live DB; `insertScannedMediaItem` is imported by
// audio-processor.ts but never called on the rematch path, so a stub suffices.
vi.mock('../../../../../../database/queries/media-items.queries.js', () => ({
    findOrCreateMusicArtist: mocks.findOrCreateMusicArtist,
    findOrCreateMusicAlbum: mocks.findOrCreateMusicAlbum,
    insertScannedMediaItem: vi.fn(),
}));

import { rematchUnknownArtistTracks, MAX_REMATCH_TRACKS_PER_RUN } from './audio-processor.js';
import type { FileScannerContext } from './shared.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(
    sql: ReturnType<typeof makeRecordingSql>['sql'],
    signal?: AbortSignal,
): {
    ctx: FileScannerContext;
    onProgress: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
} {
    const onProgress = vi.fn();
    const info = vi.fn();
    const ctx = {
        sql,
        logger: { info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        abortSignal: signal,
        onProgress,
    } as unknown as FileScannerContext;
    return { ctx, onProgress, info };
}

function makeTrackRows(n: number): Array<Record<string, unknown>> {
    return Array.from({ length: n }, (_, i) => ({
        track_id: `t${i}`,
        album_id: `al${i}`,
        album_title: 'Some Album',
        album_year: 2024,
        file_path: `/music/VA/Album/${i} - Track.flac`,
    }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('rematchUnknownArtistTracks: per-run bounding', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // clearAllMocks wipes call history but NOT implementations; restore the
        // defaults so a prior test's override (e.g. the rotation test) can't leak.
        mocks.parseAudioTags.mockImplementation(async () => ({}));
        mocks.deriveArtistName.mockImplementation(() => 'Unknown Artist');
        mocks.findOrCreateMusicArtist.mockImplementation(async () => 'real-artist-id');
        mocks.findOrCreateMusicAlbum.mockImplementation(async () => 'real-album-id');
    });

    it('examines at most MAX_REMATCH_TRACKS_PER_RUN tracks per invocation', async () => {
        const rec = makeRecordingSql();
        // 1) unknown-artist list (one node), 2) its tracks (more than the cap).
        rec.queueRows([{ id: 'ua1', library_group_id: null }]);
        rec.queueRows(makeTrackRows(MAX_REMATCH_TRACKS_PER_RUN + 100));

        const { ctx, onProgress } = makeContext(rec.sql);
        const rematched = await rematchUnknownArtistTracks(rec.sql, ctx);

        // All tracks derive to "Unknown Artist" → none re-parented.
        expect(rematched).toBe(0);
        // The cap stopped us at exactly MAX_REMATCH_TRACKS_PER_RUN examined tracks.
        expect(parseAudioTags).toHaveBeenCalledTimes(MAX_REMATCH_TRACKS_PER_RUN);
        // One heartbeat pulse per examined track.
        expect(onProgress).toHaveBeenCalledTimes(MAX_REMATCH_TRACKS_PER_RUN);
    });

    it('processes the whole backlog when it fits under the cap', async () => {
        const rec = makeRecordingSql();
        rec.queueRows([{ id: 'ua1', library_group_id: null }]);
        rec.queueRows(makeTrackRows(5));

        const { ctx, onProgress } = makeContext(rec.sql);
        await rematchUnknownArtistTracks(rec.sql, ctx);

        expect(parseAudioTags).toHaveBeenCalledTimes(5);
        expect(onProgress).toHaveBeenCalledTimes(5);
    });

    it('loads maintenance evidence once for an album shared by many tracks', async () => {
        const rec = makeRecordingSql();
        rec.queueRows([{ id: 'ua1', library_group_id: null }]);
        rec.queueRows(makeTrackRows(50).map((track) => ({ ...track, album_id: 'one-album' })));
        const { ctx } = makeContext(rec.sql);
        await rematchUnknownArtistTracks(rec.sql, ctx);
        expect(rec.calls.filter((call) => call.query.includes('FOR UPDATE OF a'))).toHaveLength(1);
        expect(parseAudioTags).toHaveBeenCalledTimes(50);
    });

    it('stops before touching any track when already aborted', async () => {
        const rec = makeRecordingSql();
        rec.queueRows([{ id: 'ua1', library_group_id: null }]);
        rec.queueRows(makeTrackRows(50));

        const ac = new AbortController();
        ac.abort();
        const { ctx, onProgress } = makeContext(rec.sql, ac.signal);
        const rematched = await rematchUnknownArtistTracks(rec.sql, ctx);

        expect(rematched).toBe(0);
        expect(parseAudioTags).not.toHaveBeenCalled();
        expect(onProgress).not.toHaveBeenCalled();
        // Only the unknown-artist list query ran — the per-artist tracks query
        // was never reached.
        expect(rec.calls).toHaveLength(1);
    });
});

describe('rematchUnknownArtistTracks: cap-window rotation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.parseAudioTags.mockImplementation(async () => ({}));
        mocks.deriveArtistName.mockImplementation(() => 'Unknown Artist');
        mocks.findOrCreateMusicArtist.mockImplementation(async () => 'real-artist-id');
        mocks.findOrCreateMusicAlbum.mockImplementation(async () => 'real-album-id');
    });

    it('orders the tracks query least-recently-attempted first and stamps examined-but-unmatched tracks', async () => {
        const rec = makeRecordingSql();
        rec.queueRows([{ id: 'ua1', library_group_id: null }]);
        rec.queueRows(makeTrackRows(5));

        const { ctx } = makeContext(rec.sql);
        await rematchUnknownArtistTracks(rec.sql, ctx);

        // The per-artist tracks SELECT rotates the window: ordered by the attempt
        // column, never-attempted (NULL) rows first.
        const select = rec.calls.find((c) => c.query.includes('a.parent_id = ?'));
        expect(select).toBeDefined();
        expect(select!.query.toLowerCase()).toContain('rematch_attempted_at');
        expect(select!.query.toLowerCase()).toContain('nulls first');

        // Every examined-but-unmatched track is stamped so it sinks behind the
        // never-attempted tracks next scan — one marker UPDATE per track.
        const stamps = rec.calls.filter(
            (c) =>
                c.query.includes('UPDATE media_items') && c.query.includes('rematch_attempted_at'),
        );
        expect(stamps).toHaveLength(5);
    });

    it('eventually processes a rematchable track sitting past the first cap window (rotation across runs)', async () => {
        // Only the "LATE" track resolves to a real artist; all others stay Unknown.
        mocks.deriveArtistName.mockImplementation((args: unknown) =>
            (args as { filePath?: string }).filePath?.includes('/LATE/')
                ? 'Real Artist'
                : 'Unknown Artist',
        );

        // ── Run 1: the rematchable track sits AT the cap boundary (index === cap),
        // so the per-run cap stops before it is ever examined.
        const rec1 = makeRecordingSql();
        rec1.queueRows([{ id: 'ua1', library_group_id: null }]);
        const run1 = makeTrackRows(MAX_REMATCH_TRACKS_PER_RUN);
        run1.push({
            track_id: 'late',
            album_id: 'late-al',
            album_title: 'Late Album',
            album_year: 2024,
            file_path: '/music/LATE/track.flac',
        });
        rec1.queueRows(run1);

        const { ctx: ctx1 } = makeContext(rec1.sql);
        const rematched1 = await rematchUnknownArtistTracks(rec1.sql, ctx1);

        // Cap hit before the late track → not rematched this run…
        expect(rematched1).toBe(0);
        // …but the examined prefix was stamped, so on the next scan the DB's
        // `ORDER BY rematch_attempted_at NULLS FIRST` surfaces the never-stamped
        // late track first (one marker UPDATE per examined track).
        const stamps = rec1.calls.filter(
            (c) =>
                c.query.includes('UPDATE media_items') && c.query.includes('rematch_attempted_at'),
        );
        expect(stamps).toHaveLength(MAX_REMATCH_TRACKS_PER_RUN);

        // ── Run 2: model that reorder — the late (NULL-stamp) track now leads.
        const rec2 = makeRecordingSql();
        rec2.queueRows([{ id: 'ua1', library_group_id: null }]);
        rec2.queueRows([
            {
                track_id: 'late',
                album_id: 'late-al',
                album_title: 'Late Album',
                album_year: 2024,
                file_path: '/music/LATE/track.flac',
            },
            ...makeTrackRows(3),
        ]);

        const { ctx: ctx2 } = makeContext(rec2.sql);
        const rematched2 = await rematchUnknownArtistTracks(rec2.sql, ctx2);

        // The previously-starved track is now examined and rematched.
        expect(rematched2).toBe(1);
        expect(mocks.findOrCreateMusicArtist).toHaveBeenCalledWith(
            rec2.sql,
            expect.objectContaining({ name: 'Real Artist' }),
        );
    });
});
