// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watchUserIdle } from './user-idle.js';

// Prod 2026-09-25: a VISIBLE but unattended home tab rotated the hero for 30
// hours — 5,995 preview-session POSTs, ~25k segment fetches. `document.hidden`
// never flips for a window that is merely not being looked at, so the hero
// needs an input-based idle signal.
describe('watchUserIdle', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('reports idle after the timeout with no input, and active again on input', () => {
        const states: boolean[] = [];
        const stop = watchUserIdle(60_000, (idle) => states.push(idle));

        vi.advanceTimersByTime(59_000);
        expect(states).toEqual([]);
        vi.advanceTimersByTime(2_000);
        expect(states).toEqual([true]);

        window.dispatchEvent(new Event('pointermove'));
        expect(states).toEqual([true, false]);
        stop();
    });

    it('input before the timeout restarts the countdown', () => {
        const states: boolean[] = [];
        const stop = watchUserIdle(60_000, (idle) => states.push(idle));
        vi.advanceTimersByTime(50_000);
        window.dispatchEvent(new Event('keydown'));
        vi.advanceTimersByTime(50_000);
        expect(states).toEqual([]);
        vi.advanceTimersByTime(11_000);
        expect(states).toEqual([true]);
        stop();
    });

    it('stops reporting after the returned cleanup runs', () => {
        const states: boolean[] = [];
        const stop = watchUserIdle(60_000, (idle) => states.push(idle));
        stop();
        vi.advanceTimersByTime(120_000);
        window.dispatchEvent(new Event('pointermove'));
        expect(states).toEqual([]);
    });
});
