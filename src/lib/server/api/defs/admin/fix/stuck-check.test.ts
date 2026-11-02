// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Verdict precedence for `/admin/fix/stuck`.
 *
 * This is the part of the diagnostic most likely to be got wrong later, and it
 * is the part that decides where an operator spends the next hour: naming
 * `stalled` when the real answer is "you paused that task last week" sends
 * someone hunting for a bug that does not exist, and naming `paused` when no
 * worker is running hides the actual cause behind a symptom.
 */

import { describe, it, expect } from 'vitest';
import { decideVerdict } from './stuck-check.js';

const base = {
    inFlight: 100,
    completedInWindow: 0,
    workerAvailable: true,
    pausedTaskCount: 0,
};

describe('decideVerdict', () => {
    /**
     * Checked before everything else. An idle instance with a paused task is
     * not experiencing a problem, and reporting one would invent a cause for a
     * symptom the operator does not have.
     */
    it('reports idle when nothing is queued, whatever else is true', () => {
        expect(decideVerdict({ ...base, inFlight: 0 })).toBe('idle');
        expect(decideVerdict({ ...base, inFlight: 0, workerAvailable: false })).toBe('idle');
        expect(decideVerdict({ ...base, inFlight: 0, pausedTaskCount: 3 })).toBe('idle');
    });

    /**
     * The reassurance case, and it is gated on measurement rather than on depth.
     * A 14,000-item backlog that is draining is working exactly as designed.
     */
    it('reports moving as soon as anything completed in the window', () => {
        expect(decideVerdict({ ...base, completedInWindow: 1 })).toBe('moving');
        expect(decideVerdict({ ...base, inFlight: 14_000, completedInWindow: 300 })).toBe('moving');
    });

    /**
     * Throughput outranks a missing worker: if things are completing, a worker
     * is evidently running whatever the probe said, and the operator should not
     * be sent to debug a worker that is visibly doing its job.
     */
    it('prefers observed throughput over a probe that claims no worker', () => {
        expect(decideVerdict({ ...base, completedInWindow: 5, workerAvailable: false })).toBe(
            'moving',
        );
    });

    it('reports no-worker when work is queued and nothing can pick it up', () => {
        expect(decideVerdict({ ...base, workerAvailable: false })).toBe('no-worker');
    });

    /**
     * A missing worker outranks a paused task: with no worker, resuming the task
     * changes nothing, so naming the pause would send the operator to a control
     * that cannot help them.
     */
    it('reports no-worker ahead of paused when both are true', () => {
        expect(decideVerdict({ ...base, workerAvailable: false, pausedTaskCount: 2 })).toBe(
            'no-worker',
        );
    });

    it('reports paused when a task is switched off and nothing is completing', () => {
        expect(decideVerdict({ ...base, pausedTaskCount: 1 })).toBe('paused');
    });

    /**
     * The residual case, deliberately last: queued, a worker is alive, nothing
     * is paused, and still nothing moves. Nothing measured explains it, and the
     * copy says so rather than guessing.
     */
    it('reports stalled only once no other measured cause explains the silence', () => {
        expect(decideVerdict(base)).toBe('stalled');
    });
});
