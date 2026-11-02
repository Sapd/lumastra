// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the pure watch-sync pull change-detection gates.
 *
 * These reproduce (in isolation, no DB) the prod loop bug: a pull's
 * change-detection compared against Lumastra's derived state instead of
 * the sync source's OWN last-reported snapshot, so a permanent
 * divergence between the two re-appended the same event every cycle
 * forever. See `watch-sync-source-gate.ts` for the full writeup.
 */

import { describe, it, expect } from 'vitest';
import {
    shouldEmitSourceUnwatch,
    shouldEmitSourceWatch,
    decideSourceProgressEvent,
} from './watch-sync-source-gate.js';

describe('shouldEmitSourceUnwatch', () => {
    it('fires on a genuine first-time watched -> unwatched transition', () => {
        // currentlyWatched=true (some source previously marked it watched),
        // this source has never reported a decisive state before.
        expect(shouldEmitSourceUnwatch(true, null)).toBe(true);
    });

    it('fires when the source previously reported watched/completed', () => {
        expect(shouldEmitSourceUnwatch(true, 'mark_watched')).toBe(true);
        expect(shouldEmitSourceUnwatch(true, 'completed')).toBe(true);
    });

    it('does NOT fire once the source has already reported unwatched (convergence)', () => {
        // This is the churn repro: currentlyWatched stays pinned true forever
        // (a higher-priority source), but this source already told us once.
        expect(shouldEmitSourceUnwatch(true, 'mark_unwatched')).toBe(false);
    });

    it('never fires for an item that was never watched, regardless of prior source reports', () => {
        // No "watched" state exists in Lumastra to unwatch — firing here
        // would be a spurious first-pull mark_unwatched on every never-
        // watched item ever pulled.
        expect(shouldEmitSourceUnwatch(false, null)).toBe(false);
        expect(shouldEmitSourceUnwatch(false, 'mark_watched')).toBe(false);
        expect(shouldEmitSourceUnwatch(false, 'mark_unwatched')).toBe(false);
    });
});

describe('shouldEmitSourceWatch', () => {
    it('emits the first watched report for an item not watched here', () => {
        expect(shouldEmitSourceWatch(false, null)).toBe(true);
        expect(shouldEmitSourceWatch(false, 'mark_unwatched')).toBe(true);
    });

    it('does not repeat a watched report the same source already made', () => {
        // Derived state stays unwatched because a higher-priority source
        // outranks this one — repeating the mark changes nothing.
        expect(shouldEmitSourceWatch(false, 'mark_watched')).toBe(false);
    });

    it('never emits for an item already watched here', () => {
        expect(shouldEmitSourceWatch(true, null)).toBe(false);
        expect(shouldEmitSourceWatch(true, 'mark_unwatched')).toBe(false);
    });
});

describe('decideSourceProgressEvent', () => {
    const TOLERANCE = 1000;

    it('does NOT emit when the reported position is unchanged from the source baseline (convergence)', () => {
        // The exact loop repro: Jellyfin reports 1387330 again; the source's
        // own last-reported position is already 1387330 -> skip.
        const decision = decideSourceProgressEvent(1_387_330, 1_387_330, false, TOLERANCE);
        expect(decision.emit).toBe(false);
    });

    it('emits on a genuine forward move past tolerance', () => {
        const decision = decideSourceProgressEvent(505_000, 500_000, false, TOLERANCE);
        expect(decision).toEqual({ emit: true, positionMs: 505_000 });
    });

    it('does not flap on sub-tolerance jitter', () => {
        const decision = decideSourceProgressEvent(500_500, 500_000, false, TOLERANCE);
        expect(decision.emit).toBe(false);
    });

    it('emits exactly at the tolerance boundary', () => {
        const decision = decideSourceProgressEvent(501_000, 500_000, false, TOLERANCE);
        expect(decision).toEqual({ emit: true, positionMs: 501_000 });
    });

    it('emits a clear-to-zero event when the source baseline was nonzero', () => {
        const decision = decideSourceProgressEvent(0, 500_000, false, TOLERANCE);
        expect(decision).toEqual({ emit: true, positionMs: 0 });
    });

    it('does not emit clear-to-zero when the source baseline was already zero', () => {
        const decision = decideSourceProgressEvent(0, 0, false, TOLERANCE);
        expect(decision.emit).toBe(false);
    });

    it('never emits when treatAsWatched is true, even for a large delta', () => {
        // The prod repro: is_watched=true in Lumastra, but this source
        // still reports a stale resume position (e.g. 300000ms) every
        // cycle. Must not re-open the item as in-progress.
        const decision = decideSourceProgressEvent(300_000, 0, true, TOLERANCE);
        expect(decision.emit).toBe(false);
    });

    it('never emits a clear-to-zero when treatAsWatched is true', () => {
        const decision = decideSourceProgressEvent(0, 500_000, true, TOLERANCE);
        expect(decision.emit).toBe(false);
    });

    it('does not emit for a zero position with no prior baseline and not watched', () => {
        const decision = decideSourceProgressEvent(0, 0, false, TOLERANCE);
        expect(decision.emit).toBe(false);
    });

    it('respects a custom tolerance', () => {
        expect(decideSourceProgressEvent(100, 0, false, 50).emit).toBe(true);
        expect(decideSourceProgressEvent(40, 0, false, 50).emit).toBe(false);
    });
});
