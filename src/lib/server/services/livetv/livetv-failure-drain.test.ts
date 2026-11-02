// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The drain is the only path from the proxy's Valkey queue into Postgres, so its
 * failure modes are silent by construction: a malformed head entry that is retried
 * forever wedges the queue and every later event stops being persisted, with nothing
 * in the UI to show for it.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const { lPopCount, recordLiveTvFailureEvent, getDb, applyFailureEventToHealth } = vi.hoisted(
    () => ({
        lPopCount: vi.fn(),
        recordLiveTvFailureEvent: vi.fn(),
        getDb: vi.fn(),
        applyFailureEventToHealth: vi.fn(),
    }),
);
vi.mock('./channel-health.service.js', () => ({ applyFailureEventToHealth }));

vi.mock('../../cache/valkey.js', () => ({ lPopCount }));
vi.mock('../../database/connection.js', () => ({ getDb }));
vi.mock('../../database/queries/livetv-failure-events.queries.js', () => ({
    recordLiveTvFailureEvent,
}));
vi.mock('../../config.js', () => ({ config: { LIVETV_SOURCE: 'standalone' } }));
vi.mock('../../utils/logger.js', () => ({
    Logger: { for: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));

import { drainLiveTvFailureEvents } from './livetv-failure-drain.js';

const VALID = JSON.stringify({
    eventUid: 'uid-1',
    channelId: 'ch-1',
    occurredAt: '2026-08-06T10:00:00.000Z',
    source: 'ingest',
    outcome: 'crashed',
    exitCode: 1,
    signal: null,
    rungId: null,
    stderrTail: 'Server returned 404 Not Found',
    probe: { success: false },
    decision: null,
});

/** A stand-in for the real list: LPOP is atomic and REMOVES what it returns. */
function fakeQueue(entries: string[]): (key: string, count: number) => Promise<string[]> {
    const list = [...entries];
    return async (_key, count) => {
        // Yield once so two concurrent drains genuinely interleave.
        await Promise.resolve();
        return list.splice(0, count);
    };
}

describe('drainLiveTvFailureEvents', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getDb.mockReturnValue({});
        recordLiveTvFailureEvent.mockResolvedValue(true);
        applyFailureEventToHealth.mockResolvedValue(undefined);
    });

    test('persists the event with the stderr the proxy captured', async () => {
        lPopCount.mockResolvedValue([VALID]);

        expect(await drainLiveTvFailureEvents()).toBe(1);
        expect(recordLiveTvFailureEvent).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                eventUid: 'uid-1',
                channelId: 'ch-1',
                source: 'ingest',
                stderrTail: 'Server returned 404 Not Found',
            }),
        );
    });

    test('counts an event against feed health only when its row was inserted', async () => {
        lPopCount.mockResolvedValue([VALID]);

        recordLiveTvFailureEvent.mockResolvedValueOnce(true);
        expect(await drainLiveTvFailureEvents()).toBe(1);
        expect(applyFailureEventToHealth).toHaveBeenCalledTimes(1);

        // The same event uid again (a retried push): ON CONFLICT DO NOTHING inserted nothing.
        recordLiveTvFailureEvent.mockResolvedValueOnce(false);
        expect(await drainLiveTvFailureEvents()).toBe(0);
        expect(applyFailureEventToHealth).toHaveBeenCalledTimes(1);
    });

    test('consumes the batch so the same events are not re-read forever', async () => {
        lPopCount.mockImplementation(fakeQueue([VALID, VALID]));

        expect(await drainLiveTvFailureEvents()).toBe(2);
        expect(await drainLiveTvFailureEvents()).toBe(0);
    });

    test('two concurrent passes lose nothing', async () => {
        // The routine trigger: the Live TV settings page drains on load while the 60s
        // timer is mid-pass. A read-then-trim-by-position consumer would have the
        // second trim delete a slice nobody ever read.
        const entries = Array.from({ length: 5 }, (_, i) =>
            JSON.stringify({ ...JSON.parse(VALID), eventUid: `uid-${i}` }),
        );
        lPopCount.mockImplementation(fakeQueue(entries));

        const [a, b] = await Promise.all([drainLiveTvFailureEvents(), drainLiveTvFailureEvents()]);

        expect(a + b).toBe(5);
        const seen = recordLiveTvFailureEvent.mock.calls.map(
            (c) => (c[1] as { eventUid: string }).eventUid,
        );
        expect([...seen].sort()).toEqual(['uid-0', 'uid-1', 'uid-2', 'uid-3', 'uid-4']);
    });

    test('drops a malformed entry instead of wedging the queue behind it', async () => {
        lPopCount.mockImplementation(
            fakeQueue(['not json at all', JSON.stringify({ source: 'ingest' }), VALID]),
        );

        expect(await drainLiveTvFailureEvents()).toBe(1);
        expect(recordLiveTvFailureEvent).toHaveBeenCalledTimes(1);
        // All three are consumed — including the two that were never persistable.
        expect(await drainLiveTvFailureEvents()).toBe(0);
    });

    test('an unreachable cache is not an error the caller has to handle', async () => {
        lPopCount.mockRejectedValue(new Error('valkey down'));

        await expect(drainLiveTvFailureEvents()).resolves.toBe(0);
    });

    test('does nothing when there is no database', async () => {
        getDb.mockReturnValue(null);

        expect(await drainLiveTvFailureEvents()).toBe(0);
        expect(lPopCount).not.toHaveBeenCalled();
    });
});
