// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Trend reporting for aggregate alerts.
 *
 * The incident behind this: a coverage-gap alert sat CRITICAL for 23 hours while
 * its own remediation was visibly succeeding. The threshold was static and set
 * below the install's real steady state, and the alert had no memory of its own
 * previous value — so nothing anywhere could say "this is draining".
 */

import { describe, it, expect } from 'vitest';
import { trendFor } from './reconcile.js';

describe('trendFor', () => {
    it('reports nothing for a scalar alert', () => {
        // Circuits and schedules carry no count. There is no trend to report and
        // inventing one would be a claim about a comparison never made.
        expect(trendFor(null, null, null)).toBeUndefined();
        expect(trendFor(undefined, 5, 5)).toBeUndefined();
    });

    /**
     * The case worth being strict about. On the first tick of an incident there
     * is no previous value, and returning `flat` would be indistinguishable from
     * a genuinely unchanging backlog — an operator would read "flat" as evidence
     * that it had been measured twice. Same class of lie as a signpost page
     * implying it ran a check.
     */
    it('reports nothing on the first tick, rather than a fabricated "flat"', () => {
        expect(trendFor(40, null, null)).toBeUndefined();
        expect(trendFor(40, 40, null)).toBeUndefined();
        expect(trendFor(40, null, 40)).toBeUndefined();
    });

    it('reads direction from the previous tick', () => {
        expect(trendFor(380, 412, 1204)?.direction).toBe('falling');
        expect(trendFor(412, 380, 1204)?.direction).toBe('rising');
        expect(trendFor(380, 380, 1204)?.direction).toBe('flat');
    });

    it('reads sinceFirst from the count the incident opened with', () => {
        expect(trendFor(380, 412, 1204)?.sinceFirst).toBe('better');
        expect(trendFor(1500, 1400, 1204)?.sinceFirst).toBe('worse');
        expect(trendFor(1204, 1300, 1204)?.sinceFirst).toBe('same');
    });

    /**
     * The two fields exist separately because they disagree, and the
     * disagreement is the useful part: a draining backlog ticks upward
     * sometimes, and an operator shown only the instantaneous direction would
     * read a recovery as a regression — which is how the 23-hour CRITICAL
     * survived as long as it did.
     */
    it('lets an upward tick inside an overall recovery say both things at once', () => {
        const t = trendFor(400, 380, 1204);
        expect(t?.direction).toBe('rising');
        expect(t?.sinceFirst).toBe('better');
    });

    it('carries the raw numbers so the operator can judge the scale themselves', () => {
        expect(trendFor(380, 412, 1204)).toEqual({
            direction: 'falling',
            current: 380,
            previous: 412,
            first: 1204,
            sinceFirst: 'better',
        });
    });

    it('handles zero without treating it as absent', () => {
        // `0` is falsy; a truthiness check anywhere in this path would drop the
        // trend at exactly the moment it says the problem is over.
        expect(trendFor(0, 12, 1204)).toEqual({
            direction: 'falling',
            current: 0,
            previous: 12,
            first: 1204,
            sinceFirst: 'better',
        });
    });
});
