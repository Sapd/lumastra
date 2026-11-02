// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { nextProbePollDelayMs, PROBE_POLL_FAST_MS } from './probe-poll-policy.js';

// Prod 2026-09-25: one stuck player polled /probe-status 4,949 times in 83
// minutes (~1/s), every response `{"probing":false}`. The loop only stopped
// after it had SEEN a probe run and finish, so a stall with no probe at all
// (direct stream, mid-playback buffering) polled for as long as it buffered.
describe('nextProbePollDelayMs', () => {
    it('polls fast while a probe is running', () => {
        expect(nextProbePollDelayMs({ probing: true, probeSeen: true, idleResponses: 0 })).toBe(
            PROBE_POLL_FAST_MS,
        );
    });

    it('stops once a seen probe has finished', () => {
        expect(
            nextProbePollDelayMs({ probing: false, probeSeen: true, idleResponses: 1 }),
        ).toBeNull();
    });

    it('keeps polling fast for the first few idle answers (a probe may still be about to start)', () => {
        expect(nextProbePollDelayMs({ probing: false, probeSeen: false, idleResponses: 3 })).toBe(
            PROBE_POLL_FAST_MS,
        );
    });

    it('backs off when no probe has shown up', () => {
        const a = nextProbePollDelayMs({ probing: false, probeSeen: false, idleResponses: 10 });
        const b = nextProbePollDelayMs({ probing: false, probeSeen: false, idleResponses: 20 });
        expect(a).toBeGreaterThan(PROBE_POLL_FAST_MS);
        expect(b!).toBeGreaterThanOrEqual(a!);
    });

    it('gives up entirely after a long window with no probe — the prod 83-minute case', () => {
        // Sum the schedule the loop would follow and make sure it terminates
        // within a few minutes and a bounded number of requests.
        let idle = 0;
        let elapsed = 0;
        let delay: number | null = PROBE_POLL_FAST_MS;
        while (delay !== null && idle < 10_000) {
            elapsed += delay;
            idle++;
            delay = nextProbePollDelayMs({ probing: false, probeSeen: false, idleResponses: idle });
        }
        expect(delay).toBeNull();
        expect(idle).toBeLessThan(80);
        expect(elapsed).toBeLessThan(3 * 60_000);
    });
});
