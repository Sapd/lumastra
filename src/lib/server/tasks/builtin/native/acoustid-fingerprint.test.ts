// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * acoustid-fingerprint execute() flow with the DB and the AcoustID client
 * mocked. The SQL predicates themselves are covered by
 * `__tests__/acoustid-fingerprint.integration.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockContext, mockLogger } from '@sapd/lumastra-plugin-sdk-testing';
import type { TaskContext } from '@sapd/lumastra-plugin-sdk';

vi.mock('../../registry.js', () => ({ registry: { registerTask: vi.fn() } }));

const a = vi.hoisted(() => ({
    fpcalc: true,
    key: 'KEY' as string | undefined,
    transcodes: 0,
    fingerprint: vi.fn(),
    lookup: vi.fn(),
}));

vi.mock('$lib/server/providers/implementations/musicbrainz/acoustid.js', async (importOriginal) => {
    const actual =
        await importOriginal<
            typeof import('$lib/server/providers/implementations/musicbrainz/acoustid.js')
        >();
    return {
        ...actual,
        isFpcalcAvailable: () => a.fpcalc,
        resolveAcoustIdApiKey: async () => a.key,
        generateFingerprint: a.fingerprint,
        lookupAcoustIdBatch: a.lookup,
    };
});

vi.mock('../../../database/queries/acoustid-fingerprint.queries.js', async (importOriginal) => {
    const actual =
        await importOriginal<
            typeof import('../../../database/queries/acoustid-fingerprint.queries.js')
        >();
    return {
        ...actual,
        findAcoustIdBacklog: vi.fn(),
        countAcoustIdRemaining: vi.fn().mockResolvedValue(0),
        applyAcoustIdMatch: vi.fn().mockResolvedValue({ recordingMbidSet: true }),
        clearOwnAcoustIdMatch: vi.fn(),
        markAcoustIdMatched: vi.fn(),
        markAcoustIdSkipped: vi.fn(),
        markAcoustIdTransientFailure: vi.fn(),
        loadAlbumMatchEvidence: vi.fn().mockResolvedValue([]),
        insertExternalIdIfAbsent: vi.fn().mockResolvedValue(true),
        reopenAlbumEnrichmentForPoster: vi.fn(),
        getAcoustIdStageCounts: vi.fn().mockResolvedValue([]),
    };
});

vi.mock('../../../database/queries/transcode-jobs.queries.js', () => ({
    countLiveVideoTranscodes: async () => a.transcodes,
}));

import * as q from '../../../database/queries/acoustid-fingerprint.queries.js';
import {
    AcoustIdKeyRejectedError,
    AcoustIdRequestRejectedError,
    AcoustIdTransientError,
    ACOUSTID_BATCH_SIZE,
} from '$lib/server/providers/implementations/musicbrainz/acoustid.js';
import { acoustIdFingerprintTask, decideAlbumArtistMbids } from './acoustid-fingerprint.js';
import type { AlbumMatchEvidence } from '../../../database/queries/acoustid-fingerprint.queries.js';

const backlog = vi.mocked(q.findAcoustIdBacklog);

/** Tagged-template sql fake: every query that reaches it is mocked elsewhere. */
function fakeSql() {
    const fn = vi.fn(async () => []);
    return fn as unknown as TaskContext['sql'];
}

function track(id: string, extra: Partial<q.AcoustIdBacklogRow> = {}): q.AcoustIdBacklogRow {
    return {
        id,
        title: `Song ${id}`,
        album_id: 'album-1',
        album_title: 'Album',
        file_path: `/m/${id}.flac`,
        has_tag_mbid: false,
        ...extra,
    };
}

function rec(id: string, title: string) {
    return {
        id,
        title,
        artists: [{ id: 'artist-mbid', name: 'Band' }],
        releasegroups: [{ id: 'rg-mbid', title: 'Album' }],
    };
}

/** Feed the backlog slices, then empty. */
function feed(...slices: q.AcoustIdBacklogRow[][]) {
    backlog.mockReset();
    for (const s of slices) backlog.mockResolvedValueOnce(s);
    backlog.mockResolvedValue([]);
}

async function run(input: Record<string, unknown> = {}, sql = fakeSql()) {
    const ctx = mockContext({
        input,
        sql,
        logger: mockLogger(),
        signal: new AbortController().signal,
    });
    return acoustIdFingerprintTask.execute(ctx as never);
}

describe('acoustid-fingerprint task', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        a.fpcalc = true;
        a.key = 'KEY';
        a.transcodes = 0;
        a.fingerprint.mockImplementation(async (p: string) => ({
            ok: true,
            fingerprint: `FP:${p}`,
            duration: 200,
        }));
        feed();
    });

    it('does no work at all without an API key', async () => {
        a.key = undefined;
        feed([track('t1')]);
        const r = await run();
        expect(r.success).toBe(true);
        expect(r.stopReason).toBe('skipped');
        expect(backlog).not.toHaveBeenCalled();
        expect(a.fingerprint).not.toHaveBeenCalled();
        expect(a.lookup).not.toHaveBeenCalled();
    });

    it('does no work without fpcalc', async () => {
        a.fpcalc = false;
        const r = await run();
        expect(r.stopReason).toBe('skipped');
        expect(backlog).not.toHaveBeenCalled();
    });

    it('records matched / no-match / ambiguous / rejected per track', async () => {
        feed([track('t1'), track('t2'), track('t3'), track('t4')]);
        a.lookup.mockResolvedValueOnce([
            [{ id: 'x', score: 0.97, recordings: [rec('rec-1', 'Song t1')] }],
            [],
            [{ id: 'y', score: 0.99, recordings: [rec('r-a', 'Same'), rec('r-b', 'Same')] }],
            null,
        ]);
        // t4 was left out of the batch reply: retried alone once, still undecodable.
        a.lookup.mockResolvedValueOnce([null]);

        const r = await run();
        expect(r.success).toBe(true);
        expect(r.result).toMatchObject({
            fingerprinted: 4,
            matched: 1,
            noMatch: 1,
            ambiguous: 1,
            rejected: 1,
            errors: 0,
        });
        expect(q.applyAcoustIdMatch).toHaveBeenCalledWith(
            expect.anything(),
            't1',
            expect.objectContaining({ recording_mbid: 'rec-1', score: 0.97 }),
        );
        expect(q.markAcoustIdMatched).toHaveBeenCalledWith(expect.anything(), 't1', 1);
        expect(q.markAcoustIdSkipped).toHaveBeenCalledWith(
            expect.anything(),
            ['t2'],
            'acoustid-no-match',
            1,
        );
        expect(q.markAcoustIdSkipped).toHaveBeenCalledWith(
            expect.anything(),
            ['t3'],
            'acoustid-ambiguous',
            1,
        );
        expect(q.markAcoustIdSkipped).toHaveBeenCalledWith(
            expect.anything(),
            ['t4'],
            'acoustid-rejected',
            1,
        );
        // Re-looked-up tracks that no longer match lose an earlier fingerprint answer.
        expect(q.clearOwnAcoustIdMatch).toHaveBeenCalledWith(expect.anything(), ['t2', 't3', 't4']);
        // One request for the whole slice, plus the single retry for t4.
        expect(a.lookup).toHaveBeenCalledTimes(2);
        expect(a.lookup.mock.calls[0][0]).toHaveLength(4);
        // The matched track's album is offered for album/artist linking.
        expect(q.loadAlbumMatchEvidence).toHaveBeenCalledWith(expect.anything(), ['album-1']);
    });

    it('asks the backlog for at most one batch per request', async () => {
        feed([track('t1')]);
        a.lookup.mockResolvedValue([[]]);
        await run();
        expect(backlog).toHaveBeenCalledWith(expect.anything(), ACOUSTID_BATCH_SIZE);
    });

    it('skips tracks whose tags already carry an MBID without fingerprinting them', async () => {
        feed([track('t1', { has_tag_mbid: true }), track('t2')]);
        a.lookup.mockResolvedValueOnce([[]]);
        const r = await run();
        expect(q.markAcoustIdSkipped).toHaveBeenCalledWith(
            expect.anything(),
            ['t1'],
            'recording-mbid-from-tags',
            1,
        );
        expect(a.fingerprint).toHaveBeenCalledTimes(1);
        expect(a.fingerprint).toHaveBeenCalledWith('/m/t2.flac', expect.anything());
        expect(r.result).toMatchObject({ hasTagMbid: 1, noMatch: 1 });
    });

    it('marks an unreadable file permanent and a vanished file transient', async () => {
        feed([track('bad'), track('gone')]);
        a.fingerprint.mockImplementation(async (p: string) =>
            p.includes('bad')
                ? { ok: false, reason: 'fpcalc-failed', detail: 'ERROR: Could not decode' }
                : { ok: false, reason: 'file-missing', detail: 'Could not open the input file' },
        );
        const r = await run();
        expect(q.markAcoustIdSkipped).toHaveBeenCalledWith(
            expect.anything(),
            ['bad'],
            'fingerprint-failed',
            1,
        );
        expect(q.markAcoustIdTransientFailure).toHaveBeenCalledWith(
            expect.anything(),
            ['gone'],
            expect.objectContaining({ code: 'file_unreadable' }),
            expect.any(Number),
            5,
        );
        expect(a.lookup).not.toHaveBeenCalled();
        expect(r.result).toMatchObject({ fingerprintFailed: 1, errors: 1 });
    });

    it('backs off the batch on an outage and stops after three in a row', async () => {
        feed([track('t1')], [track('t2')], [track('t3')], [track('t4')]);
        a.lookup.mockRejectedValue(new AcoustIdTransientError('503'));
        const r = await run();
        expect(r.success).toBe(true);
        expect(r.result).toMatchObject({ errors: 3, stopReason: 'acoustid-unavailable' });
        expect(q.markAcoustIdTransientFailure).toHaveBeenCalledTimes(3);
        expect(q.markAcoustIdTransientFailure).toHaveBeenCalledWith(
            expect.anything(),
            ['t1'],
            expect.objectContaining({ code: 'acoustid_unavailable' }),
            60 * 60 * 1000,
            5,
            // An outage does not spend the tracks' attempts.
            { countAttempt: false },
        );
        expect(q.markAcoustIdSkipped).not.toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            'acoustid-no-match',
            expect.anything(),
        );
    });

    it('fails the run on a rejected key without touching any row', async () => {
        feed([track('t1')]);
        a.lookup.mockRejectedValue(new AcoustIdKeyRejectedError('invalid API key'));
        await expect(run()).rejects.toThrow(/invalid API key/);
        expect(q.markAcoustIdTransientFailure).not.toHaveBeenCalled();
        expect(q.markAcoustIdSkipped).not.toHaveBeenCalled();
        expect(q.markAcoustIdMatched).not.toHaveBeenCalled();
    });

    it('isolates one bad fingerprint when the server rejects the whole batch', async () => {
        feed([track('t1'), track('t2')]);
        a.lookup
            .mockRejectedValueOnce(new AcoustIdRequestRejectedError('invalid fingerprint', 3))
            .mockResolvedValueOnce([
                [{ id: 'x', score: 0.95, recordings: [rec('rec-1', 'Song t1')] }],
            ])
            .mockRejectedValueOnce(new AcoustIdRequestRejectedError('invalid fingerprint', 3));
        const r = await run();
        expect(a.lookup).toHaveBeenCalledTimes(3);
        expect(r.result).toMatchObject({ matched: 1, rejected: 1 });
    });

    it('stops a catchup run at its track budget; a manual run keeps draining', async () => {
        // CATCHUP_TRACK_BUDGET is 600; one track per slice keeps the arithmetic plain.
        const many = Array.from({ length: 610 }, (_, i) => [track(`t${i}`)]);
        a.lookup.mockResolvedValue([[]]);
        feed(...many);
        const catchup = await run();
        expect(catchup.itemsProcessed).toBe(600);
        expect((catchup.result as { stopReason?: string }).stopReason).toBe('budget');
        feed(...many);
        const manual = await run({ mode: 'manual' });
        expect(manual.itemsProcessed).toBe(610);
    });

    it('runs at full speed with no live video transcode (music / direct play / remux)', async () => {
        a.transcodes = 0;
        vi.useFakeTimers();
        try {
            feed([track('t1')], [track('t2')], [track('t3')]);
            a.lookup.mockResolvedValue([[]]);
            const p = run();
            await vi.advanceTimersByTimeAsync(10);
            await p;
            expect(a.fingerprint).toHaveBeenCalledTimes(3);
        } finally {
            vi.useRealTimers();
        }
    });

    it('slows to one batch per 30 s while a video transcode runs, never stops', async () => {
        a.transcodes = 1;
        vi.useFakeTimers();
        try {
            feed([track('t1')], [track('t2')]);
            a.lookup.mockResolvedValue([[]]);
            const p = run();
            await vi.advanceTimersByTimeAsync(10);
            // First batch goes straight away; the second waits out the interval.
            expect(a.fingerprint).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(29_000);
            expect(a.fingerprint).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(2_000);
            await p;
            expect(a.fingerprint).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('decideAlbumArtistMbids', () => {
    const m = (
        rgs: Array<[string, string]>,
        artists: Array<[string, string]> = [['A1', 'Band']],
    ) => ({
        score: 0.95,
        artist_mbids: artists.map(([id]) => id),
        artist_names: artists.map(([, n]) => n),
        release_groups: rgs.map(([id, title]) => ({ id, title })),
    });
    const ev = (over: Partial<AlbumMatchEvidence>): AlbumMatchEvidence => ({
        album_id: 'al',
        album_title: 'Album',
        artist_id: 'ar',
        artist_title: 'Band',
        track_count: 3,
        album_has_rg: false,
        artist_has_mbid: false,
        album_has_poster: false,
        matches: [],
        ...over,
    });

    it('picks the release group shared by every matched track and titled like the album', () => {
        const d = decideAlbumArtistMbids(
            ev({
                matches: [
                    m([
                        ['RG', 'Album'],
                        ['C1', 'Best Of'],
                    ]),
                    m([
                        ['RG', 'Album (Deluxe Edition)'],
                        ['C2', 'Other'],
                    ]),
                ],
            }),
        );
        expect(d.releaseGroupMbid).toBe('RG');
        expect(d.artistMbid).toBe('A1');
    });

    it('declines with too few matched tracks', () => {
        const d = decideAlbumArtistMbids(
            ev({ track_count: 5, matches: [m([['RG', 'Album']]), m([['RG', 'Album']])] }),
        );
        expect(d.releaseGroupMbid).toBeNull();
        expect(
            decideAlbumArtistMbids(ev({ matches: [m([['RG', 'Album']])] })).releaseGroupMbid,
        ).toBeNull();
    });

    it('accepts one match for a single-track album', () => {
        expect(
            decideAlbumArtistMbids(ev({ track_count: 1, matches: [m([['RG', 'Album']])] }))
                .releaseGroupMbid,
        ).toBe('RG');
    });

    it('declines when the shared release group is not titled like the album', () => {
        const d = decideAlbumArtistMbids(
            ev({
                album_title: 'Latin Grooves',
                matches: [m([['RG', 'Maccary Bay']]), m([['RG', 'Maccary Bay']])],
            }),
        );
        expect(d.releaseGroupMbid).toBeNull();
    });

    it('declines when tracks do not share a release group', () => {
        const d = decideAlbumArtistMbids(
            ev({ matches: [m([['RG1', 'Album']]), m([['RG2', 'Album']])] }),
        );
        expect(d.releaseGroupMbid).toBeNull();
    });

    it('declines the artist when the credited ids disagree or the name differs', () => {
        expect(
            decideAlbumArtistMbids(
                ev({
                    matches: [
                        m([['RG', 'Album']], [['A1', 'Band']]),
                        m([['RG', 'Album']], [['A2', 'Band']]),
                    ],
                }),
            ).artistMbid,
        ).toBeNull();
        expect(
            decideAlbumArtistMbids(
                ev({
                    matches: [
                        m([['RG', 'Album']], [['A1', 'Someone']]),
                        m([['RG', 'Album']], [['A1', 'Someone']]),
                    ],
                }),
            ).artistMbid,
        ).toBeNull();
    });

    it('finds the album artist among several credited artists', () => {
        const d = decideAlbumArtistMbids(
            ev({
                matches: [
                    m(
                        [['RG', 'Album']],
                        [
                            ['F1', 'Guest'],
                            ['A1', 'Band'],
                        ],
                    ),
                    m([['RG', 'Album']], [['A1', 'Band']]),
                ],
            }),
        );
        expect(d.artistMbid).toBe('A1');
    });
});
