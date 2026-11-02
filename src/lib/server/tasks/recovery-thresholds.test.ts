// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    BOOT_STALE_HEARTBEAT_MS,
    RECONCILER_STALE_HEARTBEAT_MS,
    RECONCILER_STALE_PENDING_MS,
    CANCEL_GRACE_MS,
} from './recovery-thresholds.js';
import { LUMASTRA_RUN_STALL_FAIL_MS } from '$lib/server/config.js';

// The three independent stale-run reclaimers must stay ordered from most to
// least aggressive: boot (process provably gone) < reconciler background sweep
// < the runner's own watchdog (last line; gives a live worker the longest
// chance to self-terminate before any external reclaimer writes a terminal
// row). A future tuning pass that inverts this ordering — these have been
// re-tuned twice after preprod incidents — would let two reclaimers race a
// terminal write to the same run; this test is the tripwire.
describe('recovery thresholds ordering invariant', () => {
    it('boot < reconciler-active < watchdog-fail', () => {
        expect(BOOT_STALE_HEARTBEAT_MS).toBeLessThan(RECONCILER_STALE_HEARTBEAT_MS);
        expect(RECONCILER_STALE_HEARTBEAT_MS).toBeLessThan(LUMASTRA_RUN_STALL_FAIL_MS);
    });

    it('reconciler pending grace is shorter than its active grace', () => {
        // A pending row has no heartbeat to wait on, so it is reclaimed sooner
        // than an active run whose heartbeat merely lagged.
        expect(RECONCILER_STALE_PENDING_MS).toBeLessThan(RECONCILER_STALE_HEARTBEAT_MS);
    });

    it('all thresholds are positive, finite millisecond values', () => {
        for (const ms of [
            BOOT_STALE_HEARTBEAT_MS,
            RECONCILER_STALE_HEARTBEAT_MS,
            RECONCILER_STALE_PENDING_MS,
            LUMASTRA_RUN_STALL_FAIL_MS,
            CANCEL_GRACE_MS,
        ]) {
            expect(Number.isFinite(ms)).toBe(true);
            expect(ms).toBeGreaterThan(0);
        }
    });

    it('cancel-grace is bounded — well under the runner watchdog last line', () => {
        // The cancel-grace force-finalize is on a DIFFERENT clock (cancel-
        // requested, not heartbeat) so it is intentionally NOT part of the
        // heartbeat ordering invariant. But it must be a meaningful, bounded
        // value: long enough for a cooperative cancel to wind down, far below the
        // 2h wall-clock cap a wedged cancel would otherwise wait for.
        expect(CANCEL_GRACE_MS).toBeGreaterThanOrEqual(60_000);
        expect(CANCEL_GRACE_MS).toBeLessThan(LUMASTRA_RUN_STALL_FAIL_MS);
    });
});
