// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the batched play-end path.
 *
 * The contracts under test are the ones a green-but-broken implementation
 * would silently violate: that ONE bad event cannot take its batch-mates
 * down, that a duplicate is a success rather than a re-count, that the
 * acceptance window is actually enforced (and not merely documented), and
 * that an inaccessible track is refused.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const mockCheckMediaAccess = vi.fn();
const mockReportPlayEnd = vi.fn();
const mockFindPlaybackDurationMs = vi.fn();

vi.mock('$lib/server/database/queries/media-items.queries.js', () => ({
    findPlaybackDurationMs: (...args: unknown[]) => mockFindPlaybackDurationMs(...args),
}));

vi.mock('$lib/server/database/queries/media-type-cache.queries.js', () => ({
    getMediaType: vi.fn().mockResolvedValue('track'),
}));
vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: (...args: unknown[]) => mockCheckMediaAccess(...args),
}));
vi.mock('$lib/server/services/music-interaction-manager.service.js', () => ({
    musicInteractionManager: {
        reportPlayEnd: (...args: unknown[]) => mockReportPlayEnd(...args),
    },
}));

const { classifyStartedAt, processPlayEndBatch, processReplayBatch } =
    await import('./play-end-batch.service.js');
const { MUSIC_PLAY_EVENT_MAX_AGE_MS, MUSIC_PLAY_EVENT_MAX_SKEW_MS } =
    await import('$lib/schemas/music-play-events.js');

const NOW = Date.parse('2026-08-21T12:00:00.000Z');
const TRACK = '11111111-2222-4333-8444-555555555555';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sql = {} as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const user = { userId: 'u1', username: 'u', isAdmin: false, isAgeRestricted: false } as any;

function evt(over: Record<string, unknown> = {}) {
    return {
        eventId: '99999999-8888-4777-a666-555555555555',
        trackId: TRACK,
        listenedMs: 1000,
        startedAt: new Date(NOW - 60_000).toISOString(),
        wasSkipped: false,
        ...over,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    mockCheckMediaAccess.mockResolvedValue(true);
    mockFindPlaybackDurationMs.mockReset();
    mockFindPlaybackDurationMs.mockResolvedValue(null);
    mockReportPlayEnd.mockResolvedValue({ duplicate: false });
});

describe('classifyStartedAt', () => {
    test('accepts a timestamp inside the window', () => {
        expect(classifyStartedAt(new Date(NOW - 1000).toISOString(), NOW)).toBeNull();
    });

    test('rejects one past the age cap, accepts one just inside it', () => {
        const justInside = new Date(NOW - MUSIC_PLAY_EVENT_MAX_AGE_MS + 60_000).toISOString();
        const justOutside = new Date(NOW - MUSIC_PLAY_EVENT_MAX_AGE_MS - 60_000).toISOString();
        expect(classifyStartedAt(justInside, NOW)).toBeNull();
        expect(classifyStartedAt(justOutside, NOW)).toBe('too_old');
    });

    test('tolerates clock skew but rejects beyond it', () => {
        const withinSkew = new Date(NOW + MUSIC_PLAY_EVENT_MAX_SKEW_MS - 1000).toISOString();
        const beyondSkew = new Date(NOW + MUSIC_PLAY_EVENT_MAX_SKEW_MS + 60_000).toISOString();
        expect(classifyStartedAt(withinSkew, NOW)).toBeNull();
        expect(classifyStartedAt(beyondSkew, NOW)).toBe('too_far_future');
    });

    test('treats an unparseable timestamp as a shape problem', () => {
        expect(classifyStartedAt('not-a-date', NOW)).toBe('invalid');
    });
});

describe('processPlayEndBatch', () => {
    test('an access lookup outage rejects only that item, then continues', async () => {
        mockCheckMediaAccess.mockRejectedValueOnce(new Error('database unavailable'));
        const { results } = await processPlayEndBatch(sql, user, [evt(), evt()], NOW);
        expect(results[0]).toMatchObject({
            status: 'rejected',
            reason: 'write_failed',
            retryable: true,
        });
        expect(results[1].status).toBe('recorded');
    });
    test('uses the durable claim regardless of the per-item startReported hint', async () => {
        await processPlayEndBatch(
            sql,
            user,
            [evt({ startReported: true }), evt({ startReported: false }), evt()],
            NOW,
        );
        expect(mockReportPlayEnd.mock.calls.map((call) => call[8])).toEqual([true, true, true]);
    });
    test('missing eventId is a permanent per-item rejection', async () => {
        const { results } = await processPlayEndBatch(
            sql,
            user,
            [evt({ eventId: undefined })],
            NOW,
        );
        expect(results[0]).toMatchObject({
            status: 'rejected',
            reason: 'invalid',
            retryable: false,
        });
    });
    test('one malformed event does not stop its batch-mates', async () => {
        const { results, summary } = await processPlayEndBatch(
            sql,
            user,
            [evt(), { trackId: TRACK }, evt()],
            NOW,
        );
        expect(results.map((r) => r.status)).toEqual(['recorded', 'rejected', 'recorded']);
        expect(results[1].reason).toBe('invalid');
        expect(summary).toEqual({ recorded: 2, duplicate: 0, rejected: 1 });
        // The two good events really were written.
        expect(mockReportPlayEnd).toHaveBeenCalledTimes(2);
    });

    test('results carry the submission index so a client can attribute them', async () => {
        const { results } = await processPlayEndBatch(sql, user, [evt(), evt(), evt()], NOW);
        expect(results.map((r) => r.index)).toEqual([0, 1, 2]);
    });

    test('a duplicate is a terminal success, not a rejection and not a re-count', async () => {
        mockReportPlayEnd.mockResolvedValueOnce({ duplicate: true });
        const { results, summary } = await processPlayEndBatch(sql, user, [evt()], NOW);
        expect(results[0].status).toBe('duplicate');
        expect(results[0].retryable).toBe(false);
        expect(summary.duplicate).toBe(1);
    });

    test('an out-of-window event is rejected and never reaches the writer', async () => {
        const stale = evt({
            startedAt: new Date(NOW - MUSIC_PLAY_EVENT_MAX_AGE_MS - 1000).toISOString(),
        });
        const { results } = await processPlayEndBatch(sql, user, [stale], NOW);
        expect(results[0].status).toBe('rejected');
        expect(results[0].reason).toBe('too_old');
        expect(results[0].retryable).toBe(false); // only gets older
        expect(mockReportPlayEnd).not.toHaveBeenCalled();
    });

    test('a future-dated event is retryable — the server clock catches up', async () => {
        const future = evt({
            startedAt: new Date(NOW + MUSIC_PLAY_EVENT_MAX_SKEW_MS + 60_000).toISOString(),
        });
        const { results } = await processPlayEndBatch(sql, user, [future], NOW);
        expect(results[0].reason).toBe('too_far_future');
        expect(results[0].retryable).toBe(true);
    });

    test('an inaccessible track is refused as not_found and never written', async () => {
        mockCheckMediaAccess.mockResolvedValue(false);
        const { results } = await processPlayEndBatch(sql, user, [evt()], NOW);
        expect(results[0].status).toBe('rejected');
        expect(results[0].reason).toBe('not_found');
        expect(mockReportPlayEnd).not.toHaveBeenCalled();
    });

    test('the access decision is memoised per track within one batch', async () => {
        await processPlayEndBatch(sql, user, [evt(), evt(), evt()], NOW);
        expect(mockCheckMediaAccess).toHaveBeenCalledTimes(1);
    });

    test('a non-UUID trackId is rejected before it can reach a Postgres cast', async () => {
        const { results } = await processPlayEndBatch(sql, user, [evt({ trackId: 'nope' })], NOW);
        expect(results[0].reason).toBe('invalid');
        expect(results[0].details[0].field).toBe('trackId');
        expect(mockReportPlayEnd).not.toHaveBeenCalled();
    });

    test('an FK violation becomes not_found for that event alone', async () => {
        mockReportPlayEnd
            .mockRejectedValueOnce(Object.assign(new Error('fk'), { code: '23503' }))
            .mockResolvedValueOnce({ duplicate: false });
        const { results, summary } = await processPlayEndBatch(sql, user, [evt(), evt()], NOW);
        expect(results[0].reason).toBe('not_found');
        expect(results[1].status).toBe('recorded');
        expect(summary).toEqual({ recorded: 1, duplicate: 0, rejected: 1 });
    });

    test('an unexpected write error is retryable, not silently permanent', async () => {
        mockReportPlayEnd.mockRejectedValueOnce(new Error('connection reset'));
        const { results } = await processPlayEndBatch(sql, user, [evt()], NOW);
        expect(results[0].reason).toBe('write_failed');
        expect(results[0].retryable).toBe(true);
    });

    test('a rejected event still reports its eventId when one was supplied', async () => {
        const id = '99999999-8888-4777-a666-555555555555';
        mockCheckMediaAccess.mockResolvedValue(false);
        const { results } = await processPlayEndBatch(sql, user, [evt({ eventId: id })], NOW);
        expect(results[0].eventId).toBe(id);
    });

    test('a malformed eventId is rejected rather than silently dropped', async () => {
        // Silently ignoring a bad key would hand the client a 'recorded' for
        // an event it believes is now idempotent — the next retry would
        // double-count. The variant nibble here is invalid on purpose.
        const { results } = await processPlayEndBatch(
            sql,
            user,
            [evt({ eventId: '99999999-8888-7777-6666-555555555555' })],
            NOW,
        );
        expect(results[0].status).toBe('rejected');
        expect(results[0].reason).toBe('invalid');
        expect(results[0].details.some((d) => d.field === 'eventId')).toBe(true);
        expect(mockReportPlayEnd).not.toHaveBeenCalled();
    });

    test('the eventId is forwarded to the writer so idempotency can apply', async () => {
        const id = '99999999-8888-4777-a666-555555555555';
        await processPlayEndBatch(sql, user, [evt({ eventId: id })], NOW);
        expect(mockReportPlayEnd).toHaveBeenCalledWith(
            'u1',
            TRACK,
            1000,
            expect.any(String),
            undefined,
            false,
            undefined,
            id,
            // Omitted startReported defaults to false for this item.
            true,
            undefined,
            expect.objectContaining({ id: undefined }),
        );
    });
});

describe('processReplayBatch', () => {
    function replay(over: Record<string, unknown> = {}) {
        return {
            eventId: '99999999-8888-4777-a666-555555555555',
            kind: 'music',
            mediaId: TRACK,
            startedAt: new Date(NOW - 60000).toISOString(),
            endedAt: new Date(NOW).toISOString(),
            positionMs: 45000,
            listenedMs: 30000,
            durationMs: 60000,
            endReason: 'skip',
            startReported: true,
            ...over,
        };
    }
    test.each([null, 240000])(
        'accepts a three-minute listen without client timing when DB duration is %s',
        async (knownDuration) => {
            mockFindPlaybackDurationMs.mockResolvedValue(knownDuration);
            const item = replay({ endedAt: undefined, durationMs: undefined, listenedMs: 180000 });
            const { results, summary } = await processReplayBatch(sql, user, [item], NOW);
            expect(results[0]).toMatchObject({ status: 'recorded', retryable: false });
            expect(summary).toEqual({ recorded: 1, duplicate: 0, rejected: 0 });
            expect(mockReportPlayEnd).toHaveBeenCalledWith(
                user.userId,
                TRACK,
                180000,
                item.startedAt,
                knownDuration ?? undefined,
                true,
                undefined,
                item.eventId,
                true,
                undefined,
                { id: undefined, skipIfStartNear: true },
            );
        },
    );
    test('claims the play start on the live playbackSessionId when the replay carries it', async () => {
        const sessionId = '12345678-1234-4234-8234-123456789012';
        await processReplayBatch(sql, user, [replay({ playbackSessionId: sessionId })], NOW);
        expect(mockReportPlayEnd.mock.calls[0][9]).toBeUndefined();
        expect(mockReportPlayEnd.mock.calls[0][10]).toEqual({
            id: sessionId,
            skipIfStartNear: true,
        });
    });
    test.each([65000, 180000])(
        'clamps %s ms to the known duration when client timing is absent',
        async (listenedMs) => {
            mockFindPlaybackDurationMs.mockResolvedValue(60000);
            const item = replay({ endedAt: undefined, durationMs: undefined, listenedMs });
            const { results } = await processReplayBatch(sql, user, [item], NOW);
            expect(results[0].status).toBe('recorded');
            expect(mockReportPlayEnd).toHaveBeenCalledWith(
                user.userId,
                TRACK,
                60000,
                item.startedAt,
                60000,
                true,
                undefined,
                item.eventId,
                true,
                undefined,
                expect.objectContaining({ id: undefined }),
            );
        },
    );
    test.each([-1, 24 * 60 * 60 * 1000 + 1, 10 * 24 * 60 * 60 * 1000])(
        'rejects invalid listening time %s before looking up a duration or writing',
        async (listenedMs) => {
            const item = replay({ endedAt: undefined, durationMs: undefined, listenedMs });
            const { results } = await processReplayBatch(sql, user, [item], NOW);
            expect(results[0]).toMatchObject({
                status: 'rejected',
                reason: 'invalid',
                retryable: false,
            });
            expect(mockFindPlaybackDurationMs).not.toHaveBeenCalled();
            expect(mockReportPlayEnd).not.toHaveBeenCalled();
        },
    );
    test('accepts exactly 24 hours when no duration is known', async () => {
        const item = replay({
            endedAt: undefined,
            durationMs: undefined,
            listenedMs: 24 * 60 * 60 * 1000,
        });
        const { results } = await processReplayBatch(sql, user, [item], NOW);
        expect(results[0].status).toBe('recorded');
        expect(mockReportPlayEnd.mock.calls[0][2]).toBe(item.listenedMs);
    });
    test.each([{ endedAt: undefined }, { durationMs: undefined }])(
        'preserves the client timing bound when only one timing field is present: %j',
        async (timing) => {
            mockFindPlaybackDurationMs.mockResolvedValue(1000);
            const { results } = await processReplayBatch(
                sql,
                user,
                [
                    replay({ ...timing, listenedMs: 71000 }),
                    replay({ ...timing, listenedMs: 71001 }),
                ],
                NOW,
            );
            expect(results.map((result) => result.status)).toEqual(['recorded', 'rejected']);
            expect(results[1]).toMatchObject({ reason: 'invalid', retryable: false });
            expect(mockReportPlayEnd.mock.calls[0][2]).toBe(71000);
            expect(mockFindPlaybackDurationMs).not.toHaveBeenCalled();
        },
    );
    test('a duration lookup outage is retryable and does not stop the next item', async () => {
        mockFindPlaybackDurationMs.mockRejectedValueOnce(new Error('connection reset'));
        const item = replay({ endedAt: undefined, durationMs: undefined, listenedMs: 180000 });
        const { results, summary } = await processReplayBatch(sql, user, [item, item], NOW);
        expect(results[0]).toMatchObject({
            status: 'rejected',
            reason: 'write_failed',
            retryable: true,
        });
        expect(results[1].status).toBe('recorded');
        expect(summary).toEqual({ recorded: 1, duplicate: 0, rejected: 1 });
        expect(mockReportPlayEnd).toHaveBeenCalledTimes(1);
    });
    test('does not look up a duration for inaccessible media', async () => {
        mockCheckMediaAccess.mockResolvedValue(false);
        const item = replay({ endedAt: undefined, durationMs: undefined, listenedMs: 180000 });
        const { results } = await processReplayBatch(sql, user, [item], NOW);
        expect(results[0]).toMatchObject({ status: 'rejected', reason: 'not_found' });
        expect(mockFindPlaybackDurationMs).not.toHaveBeenCalled();
        expect(mockReportPlayEnd).not.toHaveBeenCalled();
    });
    test('maps the unified fields and summarizes recorded/duplicate/rejected outcomes', async () => {
        mockReportPlayEnd
            .mockResolvedValueOnce({ duplicate: false })
            .mockResolvedValueOnce({ duplicate: true });
        const batch = [replay(), replay(), replay({ kind: 'video' })];
        const result = await processReplayBatch(sql, user, batch, NOW);
        expect(result.summary).toEqual({ recorded: 1, duplicate: 1, rejected: 1 });
        expect(result.results.map((r) => [r.index, r.eventId, r.status])).toEqual([
            [0, batch[0].eventId, 'recorded'],
            [1, batch[1].eventId, 'duplicate'],
            [2, batch[2].eventId, 'rejected'],
        ]);
        expect(mockReportPlayEnd).toHaveBeenCalledWith(
            user.userId,
            TRACK,
            30000,
            batch[0].startedAt,
            60000,
            true,
            undefined,
            batch[0].eventId,
            true,
            undefined,
            expect.objectContaining({ id: undefined }),
        );
    });
    test.each([
        { kind: 'audiobook' },
        { mediaId: 'bad' },
        { endedAt: new Date(NOW - 60001).toISOString() },
        { listenedMs: 71001 },
    ])('rejects an invalid item and echoes its index and eventId: %j', async (over) => {
        const item = replay(over);
        const { results, summary } = await processReplayBatch(sql, user, [null, item], NOW);
        expect(results[1]).toMatchObject({
            index: 1,
            eventId: item.eventId,
            status: 'rejected',
            reason: 'invalid',
            retryable: false,
        });
        expect(summary).toEqual({ recorded: 0, duplicate: 0, rejected: 2 });
        expect(mockReportPlayEnd).not.toHaveBeenCalled();
    });
    test('uses wall time when it exceeds duration for the listening bound', async () => {
        const { results } = await processReplayBatch(
            sql,
            user,
            [replay({ durationMs: 1000, listenedMs: 70000 })],
            NOW,
        );
        expect(results[0].status).toBe('recorded');
    });
});
