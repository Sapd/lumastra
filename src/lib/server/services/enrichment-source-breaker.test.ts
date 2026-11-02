// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { EnrichmentSourceBreaker } from './enrichment-source-breaker.js';

function clocked(opts: { threshold?: number; cooldownMs?: number } = {}) {
    let t = 0;
    const breaker = new EnrichmentSourceBreaker<'a' | 'b'>({ ...opts, now: () => t });
    return { breaker, advance: (ms: number) => (t += ms) };
}

describe('EnrichmentSourceBreaker', () => {
    it('opens after the threshold of consecutive failures', () => {
        const { breaker } = clocked({ threshold: 3 });
        breaker.recordFailure('a');
        breaker.recordFailure('a');
        expect(breaker.shouldSkip('a')).toBe(false);
        breaker.recordFailure('a');
        expect(breaker.shouldSkip('a')).toBe(true);
        expect(breaker.shouldSkip('b')).toBe(false);
    });

    it('an answer resets the failure streak', () => {
        const { breaker } = clocked({ threshold: 3 });
        breaker.recordFailure('a');
        breaker.recordFailure('a');
        breaker.recordAnswer('a');
        breaker.recordFailure('a');
        breaker.recordFailure('a');
        expect(breaker.shouldSkip('a')).toBe(false);
    });

    it('lets exactly one probe through after the cooldown', () => {
        const { breaker, advance } = clocked({ threshold: 1, cooldownMs: 1000 });
        breaker.recordFailure('a');
        advance(999);
        expect(breaker.shouldSkip('a')).toBe(true);
        advance(1);
        expect(breaker.shouldSkip('a')).toBe(false); // the probe
        // A probe that never reports back (an abort) does not open the gate.
        expect(breaker.shouldSkip('a')).toBe(true);
    });

    it('a failed probe re-opens for a full cooldown, an answered one closes', () => {
        const { breaker, advance } = clocked({ threshold: 1, cooldownMs: 1000 });
        breaker.recordFailure('a');
        advance(1000);
        expect(breaker.shouldSkip('a')).toBe(false);
        breaker.recordFailure('a');
        advance(500);
        expect(breaker.shouldSkip('a')).toBe(true);
        advance(500);
        expect(breaker.shouldSkip('a')).toBe(false);
        breaker.recordAnswer('a');
        expect(breaker.shouldSkip('a')).toBe(false);
        expect(breaker.openSources()).toEqual([]);
    });

    it('allOpen needs every source open and inside its cooldown', () => {
        const { breaker, advance } = clocked({ threshold: 1, cooldownMs: 1000 });
        expect(breaker.allOpen([])).toBe(false);
        breaker.recordFailure('a');
        expect(breaker.allOpen(['a', 'b'])).toBe(false);
        breaker.recordFailure('b');
        expect(breaker.allOpen(['a', 'b'])).toBe(true);
        advance(1000);
        expect(breaker.allOpen(['a', 'b'])).toBe(false);
    });
});
