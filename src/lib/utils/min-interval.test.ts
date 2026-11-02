// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMinInterval } from './min-interval';

describe('createMinInterval', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('runs the first call immediately', () => {
        const fn = vi.fn();
        createMinInterval(1000).run(fn);
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('suppresses calls inside the window', () => {
        const fn = vi.fn();
        const gate = createMinInterval(1000);
        gate.run(fn);
        vi.advanceTimersByTime(300);
        gate.run(fn);
        gate.run(fn);
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('runs a trailing call once the window closes, so the last event is never lost', () => {
        const fn = vi.fn();
        const gate = createMinInterval(1000);
        gate.run(fn);
        vi.advanceTimersByTime(300);
        gate.run(fn);
        expect(fn).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(700);
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it('allows a call again after the window with no pending work', () => {
        const fn = vi.fn();
        const gate = createMinInterval(1000);
        gate.run(fn);
        vi.advanceTimersByTime(1500);
        gate.run(fn);
        expect(fn).toHaveBeenCalledTimes(2);
    });

    describe('cancel', () => {
        it('stops a pending trailing call from firing', () => {
            const fn = vi.fn();
            const gate = createMinInterval(1000);
            gate.run(fn);
            vi.advanceTimersByTime(300);
            gate.run(fn); // queues a trailing call
            expect(fn).toHaveBeenCalledTimes(1);

            gate.cancel();
            vi.advanceTimersByTime(700);

            // The exact bug this closes: a pending trailing call firing after
            // teardown (unmount/navigation) — the spurious refetch adf2c9cfe
            // removed.
            expect(fn).toHaveBeenCalledTimes(1);
        });

        it('is a harmless no-op when nothing is pending', () => {
            const fn = vi.fn();
            const gate = createMinInterval(1000);
            expect(() => gate.cancel()).not.toThrow();
            gate.run(fn);
            expect(fn).toHaveBeenCalledTimes(1);
        });

        it('leaves the gate usable afterwards — a later run still fires leading-edge', () => {
            const fn = vi.fn();
            const gate = createMinInterval(1000);
            gate.run(fn);
            vi.advanceTimersByTime(300);
            gate.run(fn); // queued trailing call
            gate.cancel();

            vi.advanceTimersByTime(1000);
            gate.run(fn);
            expect(fn).toHaveBeenCalledTimes(2); // initial leading + this leading
        });
    });

    describe('error containment', () => {
        it('contains a throwing LEADING call — no caller-provided boundary required', () => {
            // gateFocusRefresh's leading edge runs from a raw
            // visibilitychange/focus/pageshow listener with no surrounding
            // try/catch, unlike gateWatchStateInvalidate's leading edge (which
            // runs inside userEvents.dispatch()'s per-callback try/catch). The
            // gate itself must not depend on which kind of caller it has.
            const throwing = vi.fn(() => {
                throw new Error('boom');
            });
            const gate = createMinInterval(1000);

            expect(() => gate.run(throwing)).not.toThrow();
            expect(throwing).toHaveBeenCalledTimes(1);
        });

        it('still gates correctly after a throwing leading call', () => {
            const throwing = vi.fn(() => {
                throw new Error('boom');
            });
            const fn = vi.fn();
            const gate = createMinInterval(1000);

            gate.run(throwing);
            vi.advanceTimersByTime(300);
            gate.run(fn);
            expect(fn).not.toHaveBeenCalled(); // suppressed inside the window

            vi.advanceTimersByTime(700);
            expect(fn).toHaveBeenCalledTimes(1); // trailing catch-up still runs
        });

        it('contains a throwing TRAILING call (pre-existing guarantee, still holds)', () => {
            const throwing = vi.fn(() => {
                throw new Error('boom');
            });
            const gate = createMinInterval(1000);
            gate.run(() => {});
            vi.advanceTimersByTime(300);
            gate.run(throwing);

            expect(() => vi.advanceTimersByTime(700)).not.toThrow();
            expect(throwing).toHaveBeenCalledTimes(1);
        });
    });
});
