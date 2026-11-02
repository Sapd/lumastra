// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GaplessAdvanceScheduler, type GaplessAdvanceOps } from './gapless-advance';

/**
 * A fake pair of decks whose outgoing clock the test drives by hand.
 *
 * Everything the scheduler decides is a function of (position, duration, rate),
 * so a controllable clock is the whole instrument — no audio needed.
 */
function makeOps(overrides: Partial<GaplessAdvanceOps> = {}): {
    ops: GaplessAdvanceOps;
    state: { positionMs: number; durationMs: number; rate: number };
    log: string[];
} {
    const state = { positionMs: 0, durationMs: 10_000, rate: 1 };
    const log: string[] = [];
    const ops: GaplessAdvanceOps = {
        getOutgoingTimeMs: () => state.positionMs,
        getOutgoingDurationMs: () => state.durationMs,
        getPlaybackRate: () => state.rate,
        prepareIncoming: async () => {
            log.push('prepare');
        },
        playIncomingSilent: async () => {
            log.push('play');
            return true;
        },
        commitSwap: (delaySec) => {
            log.push(`commit:${Math.round(delaySec * 1000)}`);
        },
        abortSwap: () => {
            log.push('abort');
        },
        ...overrides,
    };
    return { ops, state, log };
}

describe('GaplessAdvanceScheduler', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('refuses to schedule when the outgoing duration is unknown', () => {
        const { ops } = makeOps({ getOutgoingDurationMs: () => 0 });
        const scheduler = new GaplessAdvanceScheduler();
        expect(scheduler.start(ops, { onCommitted: vi.fn() })).toBe(false);
        expect(scheduler.isScheduled).toBe(false);
    });

    it('refuses to schedule when the boundary is already inside the lead', () => {
        const { ops, state } = makeOps();
        state.positionMs = 9_900; // 100 ms left, lead is 150 ms
        const scheduler = new GaplessAdvanceScheduler();
        expect(scheduler.start(ops, { leadMs: 150, onCommitted: vi.fn() })).toBe(false);
    });

    it('prepares at the prewarm point and arms at the lead point', async () => {
        const { ops, state, log } = makeOps();
        const scheduler = new GaplessAdvanceScheduler();
        expect(scheduler.start(ops, { leadMs: 150, prewarmMs: 2_000, onCommitted: vi.fn() })).toBe(
            true,
        );

        state.positionMs = 5_000; // 5 s left — before prewarm
        await vi.advanceTimersByTimeAsync(30);
        expect(log).toEqual([]);

        state.positionMs = 8_500; // 1.5 s left — inside prewarm
        await vi.advanceTimersByTimeAsync(30);
        expect(log).toEqual(['prepare']);

        state.positionMs = 9_900; // 100 ms left — inside lead
        await vi.advanceTimersByTimeAsync(30);
        expect(log).toEqual(['prepare', 'play', 'commit:100']);
    });

    it('converts remaining media time to wall time using the playback rate', async () => {
        // The whole point of re-applying rate across a boundary: at 2x, 1.5 s of
        // remaining audio is only 750 ms of wall clock, so the arm point moves.
        const { ops, state, log } = makeOps();
        state.rate = 2;
        const scheduler = new GaplessAdvanceScheduler();
        scheduler.start(ops, { leadMs: 200, prewarmMs: 1_000, onCommitted: vi.fn() });

        state.positionMs = 8_200; // 1.8 s of audio = 900 ms wall — inside prewarm
        await vi.advanceTimersByTimeAsync(30);
        expect(log).toEqual(['prepare']);

        state.positionMs = 9_700; // 300 ms of audio = 150 ms wall — inside lead
        await vi.advanceTimersByTimeAsync(30);
        expect(log).toEqual(['prepare', 'play', 'commit:150']);
    });

    it('fires onCommitted only after the swap deadline has elapsed', async () => {
        const { ops, state } = makeOps();
        const onCommitted = vi.fn();
        const scheduler = new GaplessAdvanceScheduler();
        scheduler.start(ops, { leadMs: 150, prewarmMs: 1_000, onCommitted });

        state.positionMs = 9_500;
        await vi.advanceTimersByTimeAsync(30);
        state.positionMs = 9_900;
        await vi.advanceTimersByTimeAsync(30);
        expect(onCommitted).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(120);
        expect(onCommitted).toHaveBeenCalledTimes(1);
        expect(scheduler.isScheduled).toBe(false);
    });

    it('cancel before preparation does not touch the incoming deck', async () => {
        const { ops, log } = makeOps();
        const scheduler = new GaplessAdvanceScheduler();
        scheduler.start(ops, { onCommitted: vi.fn() });
        scheduler.cancel();
        await vi.advanceTimersByTimeAsync(100);
        // No abort: nothing was prepared, and aborting unconditionally would
        // silence a deck a later play() had since taken over.
        expect(log).toEqual([]);
    });

    it('cancel after preparation releases the incoming deck', async () => {
        const { ops, state, log } = makeOps();
        const scheduler = new GaplessAdvanceScheduler();
        scheduler.start(ops, { leadMs: 150, prewarmMs: 2_000, onCommitted: vi.fn() });
        state.positionMs = 8_500;
        await vi.advanceTimersByTimeAsync(30);
        expect(log).toEqual(['prepare']);

        scheduler.cancel();
        expect(log).toEqual(['prepare', 'abort']);
    });

    it('does not commit when the incoming deck refuses to play', async () => {
        const onCommitted = vi.fn();
        const { ops, state, log } = makeOps({
            playIncomingSilent: async () => {
                log.push('play-refused');
                return false;
            },
        });
        const scheduler = new GaplessAdvanceScheduler();
        scheduler.start(ops, { leadMs: 150, prewarmMs: 1_000, onCommitted });

        state.positionMs = 9_500;
        await vi.advanceTimersByTimeAsync(30);
        state.positionMs = 9_900;
        await vi.advanceTimersByTimeAsync(200);

        expect(log).toContain('play-refused');
        expect(log).not.toContain('commit:100');
        expect(onCommitted).not.toHaveBeenCalled();
    });

    it('bails instead of half-committing when the arm point was missed', async () => {
        // A backgrounded tab can stall the poll past the lead entirely. The
        // honest outcome is the cold-start path, not a swap into a deck that
        // has not started.
        const { ops, state, log } = makeOps();
        const onCommitted = vi.fn();
        const scheduler = new GaplessAdvanceScheduler();
        scheduler.start(ops, { leadMs: 150, prewarmMs: 2_000, onCommitted });

        state.positionMs = 8_500;
        await vi.advanceTimersByTimeAsync(30);
        state.positionMs = 9_995; // 5 ms left — below the armable floor
        await vi.advanceTimersByTimeAsync(30);

        expect(log).toEqual(['prepare', 'abort']);
        expect(onCommitted).not.toHaveBeenCalled();
    });

    it('gives up quietly when the outgoing duration disappears mid-flight', async () => {
        const state = { positionMs: 0, durationMs: 10_000, rate: 1 };
        const { ops } = makeOps({
            getOutgoingTimeMs: () => state.positionMs,
            getOutgoingDurationMs: () => state.durationMs,
        });
        const onCommitted = vi.fn();
        const scheduler = new GaplessAdvanceScheduler();
        scheduler.start(ops, { onCommitted });

        state.durationMs = 0; // src swapped underneath us
        await vi.advanceTimersByTimeAsync(30);

        expect(scheduler.isScheduled).toBe(false);
        expect(onCommitted).not.toHaveBeenCalled();
    });

    describe('giving up must be announced', () => {
        // A backend suppresses the outgoing deck's `ended` while an advance is in
        // flight. A scheduler that abandons one silently leaves that suppression
        // latched forever, and the real boundary is swallowed — the book stops at
        // the end of a file with nothing in the log. Every self-cancel path must
        // therefore reach onCancelled.

        it('announces a preparation that threw', async () => {
            const onCancelled = vi.fn();
            const { ops, state } = makeOps({
                prepareIncoming: async () => {
                    throw new Error('404');
                },
            });
            const scheduler = new GaplessAdvanceScheduler();
            scheduler.start(ops, { prewarmMs: 2_000, onCommitted: vi.fn(), onCancelled });

            state.positionMs = 8_500;
            await vi.advanceTimersByTimeAsync(30);

            expect(onCancelled).toHaveBeenCalledTimes(1);
            expect(scheduler.isScheduled).toBe(false);
        });

        it('announces an incoming deck that refused to play', async () => {
            const onCancelled = vi.fn();
            const { ops, state } = makeOps({ playIncomingSilent: async () => false });
            const scheduler = new GaplessAdvanceScheduler();
            scheduler.start(ops, {
                leadMs: 150,
                prewarmMs: 2_000,
                onCommitted: vi.fn(),
                onCancelled,
            });

            state.positionMs = 8_500;
            await vi.advanceTimersByTimeAsync(30);
            state.positionMs = 9_900;
            await vi.advanceTimersByTimeAsync(30);

            expect(onCancelled).toHaveBeenCalledTimes(1);
        });

        it('announces a missed arm point', async () => {
            const onCancelled = vi.fn();
            const { ops, state } = makeOps();
            const scheduler = new GaplessAdvanceScheduler();
            scheduler.start(ops, {
                leadMs: 150,
                prewarmMs: 2_000,
                onCommitted: vi.fn(),
                onCancelled,
            });

            state.positionMs = 8_500;
            await vi.advanceTimersByTimeAsync(30);
            state.positionMs = 9_995;
            await vi.advanceTimersByTimeAsync(30);

            expect(onCancelled).toHaveBeenCalledTimes(1);
        });

        it('announces a duration that vanished mid-flight', async () => {
            const onCancelled = vi.fn();
            const { ops, state } = makeOps();
            const scheduler = new GaplessAdvanceScheduler();
            scheduler.start(ops, { onCommitted: vi.fn(), onCancelled });

            state.durationMs = 0;
            await vi.advanceTimersByTimeAsync(30);

            expect(onCancelled).toHaveBeenCalledTimes(1);
        });

        it('stays silent for an EXTERNAL cancel — that caller already knows', async () => {
            const onCancelled = vi.fn();
            const { ops, state } = makeOps();
            const scheduler = new GaplessAdvanceScheduler();
            scheduler.start(ops, { prewarmMs: 2_000, onCommitted: vi.fn(), onCancelled });
            state.positionMs = 8_500;
            await vi.advanceTimersByTimeAsync(30);

            scheduler.cancel();

            expect(onCancelled).not.toHaveBeenCalled();
        });
    });

    it('aborts the swap even after commitSwap has already been scheduled', async () => {
        // By this point the backend has put a drop-to-zero on the OUTGOING deck
        // at a future audio-clock time. abortSwap is the only chance to clear
        // it; without the call, that drop fires anyway and the book goes silent
        // at a boundary that never happened.
        const { ops, state, log } = makeOps();
        const scheduler = new GaplessAdvanceScheduler();
        scheduler.start(ops, { leadMs: 150, prewarmMs: 2_000, onCommitted: vi.fn() });

        state.positionMs = 8_500;
        await vi.advanceTimersByTimeAsync(30);
        state.positionMs = 9_900;
        await vi.advanceTimersByTimeAsync(30);
        expect(log).toContain('commit:100');

        scheduler.cancel();

        expect(log.at(-1)).toBe('abort');
    });

    it('does not arm while the incoming deck is still being prepared', async () => {
        // prepareIncoming() seeks the incoming deck to its start offset. Arming
        // before that resolves starts the deck from wherever it happened to be —
        // on a slow connection, from the wrong place entirely.
        let releasePrepare: (() => void) | null = null;
        const { ops, state, log } = makeOps({
            prepareIncoming: () =>
                new Promise<void>((resolve) => {
                    log.push('prepare-start');
                    releasePrepare = resolve;
                }),
        });
        const scheduler = new GaplessAdvanceScheduler();
        scheduler.start(ops, { leadMs: 150, prewarmMs: 3_000, onCommitted: vi.fn() });

        state.positionMs = 8_000;
        await vi.advanceTimersByTimeAsync(30);
        expect(log).toEqual(['prepare-start']);

        state.positionMs = 9_900; // inside the lead, but preparation is still open
        await vi.advanceTimersByTimeAsync(30);
        expect(log).not.toContain('play');

        releasePrepare!();
        await vi.advanceTimersByTimeAsync(30);
        expect(log).toContain('play');
    });

    it('re-measures the deadline after awaiting play() rather than reusing the arm value', async () => {
        // Awaiting play() costs real time; on a slow decode that is most of the
        // lead. Committing against the stale value would swap late.
        const state = { positionMs: 9_900, durationMs: 10_000, rate: 1 };
        const log: string[] = [];
        const ops: GaplessAdvanceOps = {
            getOutgoingTimeMs: () => state.positionMs,
            getOutgoingDurationMs: () => state.durationMs,
            getPlaybackRate: () => state.rate,
            prepareIncoming: async () => {},
            playIncomingSilent: async () => {
                state.positionMs = 9_960; // 60 ms consumed while awaiting play()
                return true;
            },
            commitSwap: (delaySec) => log.push(`commit:${Math.round(delaySec * 1000)}`),
            abortSwap: () => {},
        };

        const scheduler = new GaplessAdvanceScheduler();
        // Start with room, then jump into the lead so prepare and arm both run.
        state.positionMs = 5_000;
        scheduler.start(ops, { leadMs: 150, prewarmMs: 2_000, onCommitted: vi.fn() });
        state.positionMs = 8_500;
        await vi.advanceTimersByTimeAsync(30);
        state.positionMs = 9_900;
        await vi.advanceTimersByTimeAsync(30);

        expect(log).toEqual(['commit:40']);
    });
});
