// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    evaluateReconnect,
    initialInstabilityState,
    SSE_INSTABILITY_WARN_COOLDOWN_MS,
    SSE_INSTABILITY_WINDOW_MS,
    type InstabilityState,
} from './instability';

// The SSE stream drops every ~30-60s from edge idle timeouts and self-heals in
// under a second. These lock in that a single clean blip stays silent, but
// sustained instability (repeated drops, or one long outage) warns exactly once
// per cooldown.

describe('evaluateReconnect', () => {
    it('does NOT warn on a single clean blip (one outage, recovers on attempt 1)', () => {
        const { state, warn } = evaluateReconnect(initialInstabilityState(), 1, 1_000);
        expect(warn).toBe(false);
        expect(state.outageStarts).toHaveLength(1);
        expect(state.lastWarnAt).toBe(0);
    });

    it('warns on a second distinct outage within the window', () => {
        let state = initialInstabilityState();

        // First outage — silent.
        let r = evaluateReconnect(state, 1, 1_000);
        state = r.state;
        expect(r.warn).toBe(false);

        // Second outage 40s later — repeated drops → warn.
        r = evaluateReconnect(state, 1, 41_000);
        state = r.state;
        expect(r.warn).toBe(true);
        expect(state.lastWarnAt).toBe(41_000);
    });

    it('warns on a single long outage (still failing at attempt 3) even with no prior drop', () => {
        let state = initialInstabilityState();
        // Same outage, escalating attempts. Attempt 1 & 2 stay silent...
        state = evaluateReconnect(state, 1, 1_000).state;
        expect(evaluateReconnect(state, 2, 2_000).warn).toBe(false);
        state = evaluateReconnect(state, 2, 2_000).state;
        // ...attempt 3 (~3s+ down) warns.
        const r = evaluateReconnect(state, 3, 4_000);
        expect(r.warn).toBe(true);
    });

    it('suppresses repeat warnings inside the cooldown window', () => {
        let state = initialInstabilityState();
        state = evaluateReconnect(state, 1, 1_000).state; // outage 1, silent
        let r = evaluateReconnect(state, 1, 41_000); // outage 2 → warn
        state = r.state;
        expect(r.warn).toBe(true);

        // Another outage well within the cooldown → no second toast.
        r = evaluateReconnect(state, 1, 41_000 + SSE_INSTABILITY_WARN_COOLDOWN_MS - 1);
        state = r.state;
        expect(r.warn).toBe(false);
        expect(state.lastWarnAt).toBe(41_000); // unchanged

        // Once past the cooldown, a fresh sustained outage warns again.
        const later = 41_000 + SSE_INSTABILITY_WARN_COOLDOWN_MS + 1;
        // Seed a second in-window outage so it counts as repeated, then warn.
        state = evaluateReconnect(state, 1, later - 10).state;
        r = evaluateReconnect(state, 1, later);
        expect(r.warn).toBe(true);
    });

    it('prunes outages that fall outside the rolling window (old blips do not accumulate)', () => {
        let state: InstabilityState = initialInstabilityState();
        state = evaluateReconnect(state, 1, 1_000).state;

        // A lone outage long after the first: the old one is pruned, so this is
        // treated as a first (single) outage again → silent, count back to 1.
        const far = 1_000 + SSE_INSTABILITY_WINDOW_MS + 5_000;
        const r = evaluateReconnect(state, 1, far);
        expect(r.warn).toBe(false);
        expect(r.state.outageStarts).toEqual([far]);
    });

    it('retries of the same outage (attempt > 1) do not add extra outage markers', () => {
        let state = initialInstabilityState();
        state = evaluateReconnect(state, 1, 1_000).state;
        const before = state.outageStarts.length;
        state = evaluateReconnect(state, 2, 2_000).state;
        expect(state.outageStarts).toHaveLength(before);
    });
});
