// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The idempotency contract of `reportPlayEnd`.
 *
 * These assertions are the whole point of the eventId feature, and every one
 * of them would pass vacuously against the previous implementation ordering,
 * so they are worth stating explicitly: the listen-event insert is the CLAIM,
 * and a claim that loses must suppress the non-idempotent counter work that
 * follows it.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const mockInsertListenEvent = vi.fn();
const mockIsRecordedListenEvent = vi.fn().mockResolvedValue(false);
const mockRecordPlayEnd = vi.fn();
const mockRecordTrackSkip = vi.fn();
const mockRecordTrackComplete = vi.fn();

vi.mock('$lib/server/database/queries/music-tracking.queries.js', () => ({
    claimMusicPlayStart: vi.fn().mockResolvedValue(true),
    recordPlayStart: vi.fn(),
    recordPlayEnd: (...a: unknown[]) => mockRecordPlayEnd(...a),
    recordPlayEndNoTiming: vi.fn(),
    isRecordedListenEvent: (...a: unknown[]) => mockIsRecordedListenEvent(...a),
    insertListenEvent: (...a: unknown[]) => mockInsertListenEvent(...a),
}));
vi.mock('$lib/server/database/queries/music-interactions.queries.js', () => ({
    recordTrackLike: vi.fn(),
    recordTrackDislike: vi.fn(),
    recordTrackSkip: (...a: unknown[]) => mockRecordTrackSkip(...a),
    recordTrackComplete: (...a: unknown[]) => mockRecordTrackComplete(...a),
    clearTrackLike: vi.fn(),
    clearTrackDislike: vi.fn(),
}));
// reportPlayEnd now wraps the claim + counters in `withTx`, which dispatches
// to `sql.begin` for a top-level Sql handle (see with-tx.ts / the
// with-advisory-lock.test.ts precedent for this mock shape). `begin` just
// invokes the callback with a `tx` handle — the mocked query functions below
// don't care which sql object they're called with.
const mockTx = {} as never;
const mockBegin = vi.fn((cb: (tx: unknown) => unknown) => cb(mockTx));
vi.mock('./database.service.js', () => ({
    aiDbService: { getSql: () => Promise.resolve({ begin: mockBegin }) },
}));
const mockOnRatingCacheChanged = vi.fn();
vi.mock('$lib/server/cache', () => ({
    cacheInvalidation: {
        onRatingCacheChanged: (...a: unknown[]) => mockOnRatingCacheChanged(...a),
    },
}));
// Partial mock: the transitive import chain (media-files.queries →
// context-primitives) subscribes to a Valkey channel at module scope, so the
// real module's other exports must stay reachable.
vi.mock('$lib/server/cache/valkey.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/cache/valkey.js')>()),
    setIfNotExists: vi.fn(() => Promise.resolve(true)),
    getValkeyClient: vi.fn(() => null),
    subscribeToChannel: vi.fn(() => Promise.resolve()),
}));
vi.mock('$lib/server/middleware/media-access.js', () => ({ checkMediaAccess: vi.fn(() => true) }));

const { musicInteractionManager } = await import('./music-interaction-manager.service.js');

const USER = 'u1' as never;
const TRACK = '11111111-2222-3333-4444-555555555555';
const STARTED = '2026-08-21T12:00:00.000Z';
const EVENT_ID = '99999999-8888-4777-a666-555555555555';

beforeEach(() => {
    vi.clearAllMocks();
    mockIsRecordedListenEvent.mockResolvedValue(false);
    mockInsertListenEvent.mockResolvedValue({ inserted: true });
    mockBegin.mockImplementation((cb: (tx: unknown) => unknown) => cb(mockTx));
});

describe('reportPlayEnd idempotency', () => {
    test('a retry of the same terminal session report is duplicate', async () => {
        await expect(
            musicInteractionManager.reportPlayEnd(
                USER,
                TRACK,
                1000,
                STARTED,
                200000,
                true,
                undefined,
                EVENT_ID,
            ),
        ).resolves.toEqual({ duplicate: false });
        mockIsRecordedListenEvent.mockResolvedValueOnce(true);
        await expect(
            musicInteractionManager.reportPlayEnd(
                USER,
                TRACK,
                1000,
                STARTED,
                200000,
                true,
                undefined,
                EVENT_ID,
            ),
        ).resolves.toEqual({ duplicate: true });
        expect(mockRecordPlayEnd).toHaveBeenCalledTimes(1);
        expect(mockRecordTrackSkip).toHaveBeenCalledTimes(1);
    });
    test('a won claim records the event and moves the counters', async () => {
        const out = await musicInteractionManager.reportPlayEnd(
            USER,
            TRACK,
            200_000,
            STARTED,
            210_000,
            false,
            undefined,
            EVENT_ID,
        );
        expect(out).toEqual({ duplicate: false });
        expect(mockRecordPlayEnd).toHaveBeenCalledTimes(1);
        // 200s of a 210s track is past the completion threshold.
        expect(mockRecordTrackComplete).toHaveBeenCalledTimes(1);
    });

    test('a lost claim moves NO counters — this is the double-count guard', async () => {
        mockInsertListenEvent.mockResolvedValue({ inserted: false });
        const out = await musicInteractionManager.reportPlayEnd(
            USER,
            TRACK,
            200_000,
            STARTED,
            210_000,
            false,
            undefined,
            EVENT_ID,
        );
        expect(out).toEqual({ duplicate: true });
        expect(mockRecordPlayEnd).not.toHaveBeenCalled();
        expect(mockRecordTrackComplete).not.toHaveBeenCalled();
        expect(mockRecordTrackSkip).not.toHaveBeenCalled();
    });

    test('a lost claim suppresses the skip signal too', async () => {
        mockInsertListenEvent.mockResolvedValue({ inserted: false });
        await musicInteractionManager.reportPlayEnd(
            USER,
            TRACK,
            3_000,
            STARTED,
            210_000,
            true,
            undefined,
            EVENT_ID,
        );
        expect(mockRecordTrackSkip).not.toHaveBeenCalled();
    });

    test('the eventId reaches the insert, which is what makes the claim possible', async () => {
        await musicInteractionManager.reportPlayEnd(
            USER,
            TRACK,
            1_000,
            STARTED,
            undefined,
            false,
            undefined,
            EVENT_ID,
        );
        expect(mockInsertListenEvent).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ eventId: EVENT_ID }),
        );
    });

    test('a legacy caller sends no eventId and keeps its at-least-once behaviour', async () => {
        await musicInteractionManager.reportPlayEnd(USER, TRACK, 1_000, STARTED);
        expect(mockInsertListenEvent).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ eventId: null }),
        );
        // No eventId means the partial unique index cannot apply, so the
        // insert always wins and the counters always move.
        expect(mockRecordPlayEnd).toHaveBeenCalledTimes(1);
    });

    test('the event is claimed BEFORE the aggregate is touched', async () => {
        const order: string[] = [];
        mockInsertListenEvent.mockImplementation(() => {
            order.push('insert');
            return Promise.resolve({ inserted: true });
        });
        mockRecordPlayEnd.mockImplementation(() => {
            order.push('aggregate');
            return Promise.resolve();
        });
        await musicInteractionManager.reportPlayEnd(
            USER,
            TRACK,
            1_000,
            STARTED,
            undefined,
            false,
            undefined,
            EVENT_ID,
        );
        expect(order).toEqual(['insert', 'aggregate']);
    });

    // The claim and its counter writes previously ran as separate awaits on
    // the same connection with no transaction — a mid-report failure (SIGTERM,
    // statement timeout) left a committed event row with no aggregate bump,
    // and a client retry was told `duplicate`/`retryable:false`, permanently
    // losing that listen's counters. Wrapping both in `withTx` fixes this:
    // these two tests pin (a) that the writes actually go through the
    // transaction's `tx` handle rather than the plain connection, and (b)
    // that a failure inside the transaction aborts the whole report instead
    // of leaving a partial write behind.
    test('the claim and its counters run through the transaction handle, not the plain connection', async () => {
        await musicInteractionManager.reportPlayEnd(
            USER,
            TRACK,
            200_000,
            STARTED,
            210_000,
            false,
            undefined,
            EVENT_ID,
        );
        expect(mockBegin).toHaveBeenCalledTimes(1);
        expect(mockInsertListenEvent).toHaveBeenCalledWith(mockTx, expect.anything());
        expect(mockRecordPlayEnd).toHaveBeenCalledWith(
            mockTx,
            USER,
            TRACK,
            200_000,
            false,
            true,
            false,
            // The REAL listen time, not now. An offline flush arrives hours
            // late, and stamping a first-ever row with the flush time
            // reorders every recency-ranked surface around when the device
            // happened to reconnect.
            expect.any(Date),
        );
        expect(mockRecordTrackComplete).toHaveBeenCalledWith(mockTx, USER, TRACK);
    });

    test('a mid-transaction failure aborts the whole report and never invalidates the cache', async () => {
        mockRecordPlayEnd.mockRejectedValueOnce(new Error('connection lost mid-report'));

        await expect(
            musicInteractionManager.reportPlayEnd(
                USER,
                TRACK,
                200_000,
                STARTED,
                210_000,
                false,
                undefined,
                EVENT_ID,
            ),
        ).rejects.toThrow('connection lost mid-report');

        // No cache invalidation for a report that never actually landed —
        // there is nothing for the cache to catch up on.
        expect(mockOnRatingCacheChanged).not.toHaveBeenCalled();
    });
});
