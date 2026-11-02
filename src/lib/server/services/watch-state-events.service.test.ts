// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { watchStateEvents, type WatchStateEvent } from './watch-state-events.service';
vi.mock('./notification-events.service.js', () => ({ publishUserEvent: vi.fn(async () => {}) }));
vi.mock('./watched-cache.service.js', () => ({
    invalidateAllWatchedCaches: vi.fn(async () => {}),
}));
import { publishUserEvent } from './notification-events.service.js';
import { invalidateAllWatchedCaches } from './watched-cache.service.js';
import { toUserId } from '$lib/shared/user-id.js';

// Fixed valid users.id UUIDs for branded-UserId channels (mig 16.46.0). Each
// distinct user keeps a stable UUID so subscribe/emit channels match.
const ALICE = toUserId('11111111-1111-4111-8111-111111111111');
const BOB = toUserId('22222222-2222-4222-8222-222222222222');
const GHOST = toUserId('33333333-3333-4333-8333-333333333333');
const U = toUserId('44444444-4444-4444-8444-444444444444');

describe('WatchStateEventEmitter', () => {
    beforeEach(() => {
        vi.useFakeTimers({ now: new Date('2026-04-27T12:00:00Z') });
        // Singleton — clear coalescing state and listeners between cases so the
        // 1-second window from a prior test doesn't suppress the first emit of
        // the next.
        watchStateEvents.__resetForTests();
        vi.clearAllMocks();
    });

    afterEach(async () => {
        await vi.runAllTimersAsync();
        watchStateEvents.__resetForTests();
        vi.useRealTimers();
    });

    it('publishes a coalesced cross-pod watch event after clearing caches, with no local listeners', async () => {
        for (let i = 0; i < 20; i++) {
            watchStateEvents.emit(ALICE, {
                type: 'watch_state_set_changed',
                mediaId: `episode-${i}`,
                reason: 'sync_import',
            });
        }
        expect(publishUserEvent).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1000);
        await vi.waitFor(() => expect(publishUserEvent).toHaveBeenCalledOnce());
        expect(publishUserEvent).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: ALICE,
                kind: 'watch_state_set_changed',
                persist: false,
            }),
        );
        expect(invalidateAllWatchedCaches).toHaveBeenCalledExactlyOnceWith(ALICE);
        expect(vi.mocked(invalidateAllWatchedCaches).mock.invocationCallOrder[0]).toBeLessThan(
            vi.mocked(publishUserEvent).mock.invocationCallOrder[0],
        );
        // A later committed chunk still schedules a final catch-up. The
        // coalescing window must not discard it after the first publication.
        watchStateEvents.emit(ALICE, {
            type: 'watch_state_set_changed', mediaId: 'final-episode', reason: 'sync_import',
        });
        await vi.advanceTimersByTimeAsync(1000);
        await vi.waitFor(() => expect(publishUserEvent).toHaveBeenCalledTimes(2));
    });

    it('delivers events only to subscribers of that username', () => {
        const aEvents: WatchStateEvent[] = [];
        const bEvents: WatchStateEvent[] = [];
        const unsubA = watchStateEvents.subscribe(ALICE, (e) => aEvents.push(e));
        const unsubB = watchStateEvents.subscribe(BOB, (e) => bEvents.push(e));
        watchStateEvents.emit(ALICE, {
            type: 'watch_state_set_changed',
            mediaId: 'x',
            reason: 'mark_watched',
        });
        expect(aEvents.length).toBe(1);
        expect(bEvents.length).toBe(0);
        unsubA();
        unsubB();
    });

    it('cleans up empty listener sets on unsubscribe', () => {
        const unsub = watchStateEvents.subscribe(U, () => {});
        unsub();
        // No throw when emitting to a username with no listeners.
        watchStateEvents.emit(U, {
            type: 'watch_state_set_changed',
            mediaId: 'x',
            reason: 'mark_watched',
        });
    });

    it('coalesces watch_state_set_changed bursts to 1 emit per username per second', () => {
        const events: WatchStateEvent[] = [];
        const unsub = watchStateEvents.subscribe(ALICE, (e) => events.push(e));

        // Burst of 5 events within the same window — only the first wins.
        for (let i = 0; i < 5; i++) {
            watchStateEvents.emit(ALICE, {
                type: 'watch_state_set_changed',
                mediaId: `ep-${i}`,
                reason: 'mark_season_watched',
            });
        }
        expect(events.length).toBe(1);

        // After the window elapses, the next emit goes through.
        vi.advanceTimersByTime(1100);
        watchStateEvents.emit(ALICE, {
            type: 'watch_state_set_changed',
            mediaId: 'ep-late',
            reason: 'mark_watched',
        });
        expect(events.length).toBe(2);

        unsub();
    });

    it('coalesces session_changed bursts to 1 emit per username per second', () => {
        const events: WatchStateEvent[] = [];
        const unsub = watchStateEvents.subscribe(ALICE, (e) => events.push(e));

        watchStateEvents.emit(ALICE, {
            type: 'session_changed',
            sessionId: 's1',
            status: 'ACTIVE',
            mediaId: 'm1',
        });
        watchStateEvents.emit(ALICE, {
            type: 'session_changed',
            sessionId: 's1',
            status: 'PAUSED',
            mediaId: 'm1',
        });
        expect(events.length).toBe(1);

        vi.advanceTimersByTime(1100);
        watchStateEvents.emit(ALICE, {
            type: 'session_changed',
            sessionId: 's1',
            status: 'COMPLETED',
            mediaId: 'm1',
        });
        expect(events.length).toBe(2);

        unsub();
    });

    it('coalesces independently per (username, eventType) — different types do not block each other', () => {
        const events: WatchStateEvent[] = [];
        const unsub = watchStateEvents.subscribe(ALICE, (e) => events.push(e));

        watchStateEvents.emit(ALICE, {
            type: 'watch_state_set_changed',
            mediaId: 'x',
            reason: 'mark_watched',
        });
        watchStateEvents.emit(ALICE, {
            type: 'session_changed',
            sessionId: 's1',
            status: 'ACTIVE',
            mediaId: 'm1',
        });

        // Different event types — both should be delivered in the same window.
        expect(events.length).toBe(2);

        unsub();
    });

    it('coalesces independently per username — different users do not block each other', () => {
        const aEvents: WatchStateEvent[] = [];
        const bEvents: WatchStateEvent[] = [];
        const unsubA = watchStateEvents.subscribe(ALICE, (e) => aEvents.push(e));
        const unsubB = watchStateEvents.subscribe(BOB, (e) => bEvents.push(e));

        watchStateEvents.emit(ALICE, {
            type: 'watch_state_set_changed',
            mediaId: 'x',
            reason: 'mark_watched',
        });
        watchStateEvents.emit(BOB, {
            type: 'watch_state_set_changed',
            mediaId: 'x',
            reason: 'mark_watched',
        });

        expect(aEvents.length).toBe(1);
        expect(bEvents.length).toBe(1);

        unsubA();
        unsubB();
    });

    it('does not burn the coalescing window when no listeners exist', () => {
        // Emit with no subscriber — must not record a lastEmitAt entry.
        watchStateEvents.emit(GHOST, {
            type: 'watch_state_set_changed',
            mediaId: 'x',
            reason: 'mark_watched',
        });

        // Now subscribe and emit within the same clock instant — must deliver.
        const events: WatchStateEvent[] = [];
        const unsub = watchStateEvents.subscribe(GHOST, (e) => events.push(e));
        watchStateEvents.emit(GHOST, {
            type: 'watch_state_set_changed',
            mediaId: 'y',
            reason: 'mark_watched',
        });
        expect(events.length).toBe(1);
        unsub();
    });

    it('force-passes an event when wall clock goes backward', () => {
        const events: WatchStateEvent[] = [];
        const unsub = watchStateEvents.subscribe(ALICE, (e) => events.push(e));

        // First emit establishes lastEmitAt anchor.
        watchStateEvents.emit(ALICE, {
            type: 'session_changed',
            sessionId: 's1',
            status: 'ACTIVE',
            mediaId: 'm1',
        });
        expect(events.length).toBe(1);

        // Simulate clock going backward by 2 seconds.
        vi.setSystemTime(new Date('2026-04-27T11:59:58Z'));

        // Second emit — clock is behind the anchor; must NOT suppress.
        watchStateEvents.emit(ALICE, {
            type: 'session_changed',
            sessionId: 's1',
            status: 'PAUSED',
            mediaId: 'm1',
        });
        expect(events.length).toBe(2);

        unsub();
    });

    it('resumes normal coalescing after a backward-clock event', () => {
        const events: WatchStateEvent[] = [];
        const unsub = watchStateEvents.subscribe(ALICE, (e) => events.push(e));

        // Initial emit — sets anchor.
        watchStateEvents.emit(ALICE, {
            type: 'session_changed',
            sessionId: 's1',
            status: 'ACTIVE',
            mediaId: 'm1',
        });

        // Clock goes backward — resets anchor to the backward time.
        vi.setSystemTime(new Date('2026-04-27T11:59:58Z'));
        watchStateEvents.emit(ALICE, {
            type: 'session_changed',
            sessionId: 's1',
            status: 'PAUSED',
            mediaId: 'm1',
        });
        expect(events.length).toBe(2);

        // Now a third emit at the same backward time — within window, must coalesce.
        watchStateEvents.emit(ALICE, {
            type: 'session_changed',
            sessionId: 's1',
            status: 'COMPLETED',
            mediaId: 'm1',
        });
        expect(events.length).toBe(2);

        unsub();
    });
});
