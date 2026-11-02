// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { liveStartFixture } from '$lib/utils/livetv-start.fixture.js';
import { LiveTvHeartbeat } from './livetv-heartbeat.js';

describe('LiveTvHeartbeat', () => {
    let fetchSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.useFakeTimers();
        fetchSpy = vi
            .fn()
            .mockImplementation(() => Promise.resolve(new Response(null, { status: 204 })));
        global.fetch = fetchSpy as unknown as typeof fetch;
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('sends first heartbeat immediately on construction', () => {
        const heartbeat = new LiveTvHeartbeat(liveStartFixture('ch1'), 10_000);

        // Immediate heartbeat on construction
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(fetchSpy).toHaveBeenCalledWith(
            '/api/livetv/playback-sessions/ch1/keepalive',
            expect.objectContaining({
                method: 'POST',
            }),
        );

        // After 10s, second heartbeat fires
        vi.advanceTimersByTime(10_000);
        expect(fetchSpy).toHaveBeenCalledTimes(2);

        void heartbeat.destroy();
    });

    it('sends heartbeat every interval (plus initial)', () => {
        const heartbeat = new LiveTvHeartbeat(liveStartFixture('ch1'), 5_000);

        // 1 immediate + 3 interval = 4 total at 15s
        vi.advanceTimersByTime(15_000);
        expect(fetchSpy).toHaveBeenCalledTimes(4);

        void heartbeat.destroy();
    });

    it('destroy stops interval and sends leave', async () => {
        const heartbeat = new LiveTvHeartbeat(liveStartFixture('ch1'), 10_000);

        // 1 immediate heartbeat
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        await heartbeat.destroy();

        // Verify leave was called (heartbeat + leave = 2)
        expect(fetchSpy).toHaveBeenCalledWith(
            '/api/livetv/playback-sessions/ch1',
            expect.objectContaining({
                method: 'DELETE',
            }),
        );

        // No more heartbeats after destroy
        fetchSpy.mockClear();
        vi.advanceTimersByTime(20_000);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('destroyViaBeacon stops interval and uses sendBeacon', () => {
        const beaconSpy = vi.fn().mockReturnValue(true);
        Object.defineProperty(navigator, 'sendBeacon', {
            value: beaconSpy,
            writable: true,
            configurable: true,
        });

        const heartbeat = new LiveTvHeartbeat(liveStartFixture('ch1'), 10_000);
        heartbeat.destroyViaBeacon();

        expect(beaconSpy).toHaveBeenCalledWith('/api/livetv/playback-sessions/ch1/leave');

        // No more heartbeats after destroy
        fetchSpy.mockClear();
        vi.advanceTimersByTime(20_000);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('heartbeat failure is non-fatal', () => {
        fetchSpy.mockRejectedValue(new Error('Network error'));

        const heartbeat = new LiveTvHeartbeat(liveStartFixture('ch1'), 5_000);

        // Immediate call fires (and fails silently)
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        // Still alive — interval heartbeats keep firing
        vi.advanceTimersByTime(10_000);
        expect(fetchSpy).toHaveBeenCalledTimes(3); // 1 immediate + 2 interval

        void heartbeat.destroy();
    });

    // Story 5.2: Consecutive failure tracking

    it('does not fire onHeartbeatLost for 1-2 consecutive failures', async () => {
        const onLost = vi.fn();
        fetchSpy.mockRejectedValue(new Error('Network error'));

        const heartbeat = new LiveTvHeartbeat(liveStartFixture('ch1'), 5_000, onLost);

        // 1 immediate failure
        await vi.advanceTimersByTimeAsync(0);
        expect(onLost).not.toHaveBeenCalled();

        // 2nd failure (at 5s)
        await vi.advanceTimersByTimeAsync(5_000);
        expect(onLost).not.toHaveBeenCalled();

        void heartbeat.destroy();
    });

    it('fires onHeartbeatLost after 3 consecutive failures', async () => {
        const onLost = vi.fn();
        fetchSpy.mockRejectedValue(new Error('Network error'));

        const heartbeat = new LiveTvHeartbeat(liveStartFixture('ch1'), 5_000, onLost);

        // 1 immediate + 2 interval = 3 failures
        await vi.advanceTimersByTimeAsync(0); // immediate
        await vi.advanceTimersByTimeAsync(5_000); // 2nd
        await vi.advanceTimersByTimeAsync(5_000); // 3rd

        expect(onLost).toHaveBeenCalledTimes(1);

        void heartbeat.destroy();
    });

    it('resets failure counter on success', async () => {
        const onLost = vi.fn();
        // Fail first 2, then succeed, then fail 1
        let callCount = 0;
        fetchSpy.mockImplementation(() => {
            callCount++;
            if (callCount <= 2 || callCount === 4) {
                return Promise.reject(new Error('fail'));
            }
            return Promise.resolve(new Response(null, { status: 204 }));
        });

        const heartbeat = new LiveTvHeartbeat(liveStartFixture('ch1'), 5_000, onLost);

        // 1st call: fail
        await vi.advanceTimersByTimeAsync(0);
        // 2nd call: fail
        await vi.advanceTimersByTimeAsync(5_000);
        // 3rd call: success — resets counter
        await vi.advanceTimersByTimeAsync(5_000);
        // 4th call: fail — only 1 failure since reset
        await vi.advanceTimersByTimeAsync(5_000);

        expect(onLost).not.toHaveBeenCalled();

        void heartbeat.destroy();
    });

    it('fires onHeartbeatLost only once per threshold crossing', async () => {
        const onLost = vi.fn();
        fetchSpy.mockRejectedValue(new Error('Network error'));

        const heartbeat = new LiveTvHeartbeat(liveStartFixture('ch1'), 5_000, onLost);

        // 6 consecutive failures (2x threshold)
        await vi.advanceTimersByTimeAsync(0); // 1
        await vi.advanceTimersByTimeAsync(5_000); // 2
        await vi.advanceTimersByTimeAsync(5_000); // 3 → fires
        await vi.advanceTimersByTimeAsync(5_000); // 4
        await vi.advanceTimersByTimeAsync(5_000); // 5
        await vi.advanceTimersByTimeAsync(5_000); // 6

        expect(onLost).toHaveBeenCalledTimes(1);

        void heartbeat.destroy();
    });
    it.each(['evicted', 'superseded', 'left', 'expired'])(
        'stops on %s without polling or resurrecting the session',
        async (reason) => {
            fetchSpy.mockResolvedValueOnce(
                new Response(
                    JSON.stringify({
                        code: 'gone',
                        error: 'playback_session_ended',
                        reason,
                    }),
                    { status: 410 },
                ),
            );
            const onLost = vi.fn();
            const onKicked = vi.fn();
            const heartbeat = new LiveTvHeartbeat(
                liveStartFixture('session-old'),
                7_000,
                onLost,
                undefined,
                onKicked,
            );
            await vi.advanceTimersByTimeAsync(0);
            await vi.advanceTimersByTimeAsync(28_000);
            expect(fetchSpy).toHaveBeenCalledTimes(1);
            expect(onKicked).toHaveBeenCalledTimes(reason === 'evicted' ? 1 : 0);
            expect(onLost).toHaveBeenCalledTimes(reason !== 'evicted' ? 1 : 0);
            await heartbeat.destroy();
        },
    );

    describe('410 with reason failed', () => {
        const failedBody = {
            code: 'channel_offline',
            error: 'playback_session_ended',
            reason: 'failed',
            retryable: false,
        };

        it('reports the typed failure, not a takeover and not a lost heartbeat', async () => {
            fetchSpy.mockResolvedValueOnce(
                new Response(JSON.stringify(failedBody), { status: 410 }),
            );
            const onLost = vi.fn();
            const onKicked = vi.fn();
            const onFailed = vi.fn();
            const heartbeat = new LiveTvHeartbeat(
                liveStartFixture('session-old'),
                7_000,
                onLost,
                undefined,
                onKicked,
                onFailed,
            );
            await vi.advanceTimersByTimeAsync(0);
            await vi.advanceTimersByTimeAsync(28_000);
            expect(fetchSpy).toHaveBeenCalledTimes(1);
            expect(onFailed).toHaveBeenCalledWith({
                kind: 'failure',
                code: 'channel_offline',
                retryable: false,
            });
            expect(onKicked).not.toHaveBeenCalled();
            expect(onLost).not.toHaveBeenCalled();
            await heartbeat.destroy();
        });

        it('passes undefined when the body carries no taxonomy code', async () => {
            fetchSpy.mockResolvedValueOnce(
                new Response(JSON.stringify({ ...failedBody, code: 'gone' }), { status: 410 }),
            );
            const onFailed = vi.fn();
            const heartbeat = new LiveTvHeartbeat(
                liveStartFixture('s'),
                7_000,
                undefined,
                undefined,
                undefined,
                onFailed,
            );
            await vi.advanceTimersByTimeAsync(0);
            expect(onFailed).toHaveBeenCalledWith(undefined);
            await heartbeat.destroy();
        });

        it('without a failed handler it ends like any other non-takeover end', async () => {
            fetchSpy.mockResolvedValueOnce(
                new Response(JSON.stringify(failedBody), { status: 410 }),
            );
            const onLost = vi.fn();
            const onKicked = vi.fn();
            const heartbeat = new LiveTvHeartbeat(
                liveStartFixture('s'),
                7_000,
                onLost,
                undefined,
                onKicked,
            );
            await vi.advanceTimersByTimeAsync(0);
            expect(onLost).toHaveBeenCalledTimes(1);
            expect(onKicked).not.toHaveBeenCalled();
            await heartbeat.destroy();
        });
    });

    it.each(['session_not_found', 'session_expired'])(
        'reports %s through the expired path',
        async (reason) => {
            fetchSpy.mockResolvedValueOnce(
                new Response(JSON.stringify({ reason }), { status: 404 }),
            );
            const onLost = vi.fn();
            const onKicked = vi.fn();
            const heartbeat = new LiveTvHeartbeat(
                liveStartFixture('session-old'),
                7_000,
                onLost,
                undefined,
                onKicked,
            );
            await vi.advanceTimersByTimeAsync(0);
            expect(onLost).toHaveBeenCalledTimes(1);
            expect(onKicked).not.toHaveBeenCalled();
            await heartbeat.destroy();
        },
    );

    it('a delayed old-session leave cannot target the new session', async () => {
        const old = new LiveTvHeartbeat(liveStartFixture('session-old'), 7_000);
        const current = new LiveTvHeartbeat(liveStartFixture('session-new'), 7_000);
        await old.destroy();
        expect(fetchSpy).toHaveBeenCalledWith(
            '/api/livetv/playback-sessions/session-old',
            expect.objectContaining({ method: 'DELETE' }),
        );
        fetchSpy.mockClear();
        await vi.advanceTimersByTimeAsync(7_000);
        expect(fetchSpy).toHaveBeenCalledWith(
            '/api/livetv/playback-sessions/session-new/keepalive',
            expect.objectContaining({ method: 'POST' }),
        );
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        await current.destroy();
    });
});
