// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    computeBackoffDelay,
    triageNetworkStatus,
    triage410,
    decideRecovery,
    NATIVE_STALL_REBUILD_ATTEMPT,
    HLSJS_REBUILD_ATTEMPT,
    RECONNECT_TUNING,
} from './reconnect-policy';

describe('computeBackoffDelay', () => {
    const min = () => 0;
    const max = () => 1;

    it('grows exponentially from the base delay (min jitter)', () => {
        expect(computeBackoffDelay(0, min)).toBe(1200); // 1500 * 0.8
        expect(computeBackoffDelay(1, min)).toBe(2400); // 3000 * 0.8
        expect(computeBackoffDelay(2, min)).toBe(4800); // 6000 * 0.8
    });

    it('caps at maxDelayMs', () => {
        expect(computeBackoffDelay(3, min)).toBe(8000); // min(10000,12000)*0.8
        expect(computeBackoffDelay(20, min)).toBe(8000); // capped exp 10000 * 0.8
        expect(computeBackoffDelay(20, max)).toBe(10000); // capped exp 10000 * 1.0
    });

    it('returns a value within [exp*(1-jitter), exp] for any rng', () => {
        const exp = Math.min(RECONNECT_TUNING.maxDelayMs, RECONNECT_TUNING.baseDelayMs * 2 ** 1);
        const lo = exp * (1 - RECONNECT_TUNING.jitterRatio);
        const d = computeBackoffDelay(1, () => 0.5);
        expect(d).toBeGreaterThanOrEqual(Math.round(lo));
        expect(d).toBeLessThanOrEqual(exp);
    });

    it('treats negative attempts as attempt 0', () => {
        expect(computeBackoffDelay(-5, min)).toBe(computeBackoffDelay(0, min));
    });

    it('never exceeds maxDelayMs even with an out-of-range rng', () => {
        expect(computeBackoffDelay(0, () => 5)).toBeLessThanOrEqual(RECONNECT_TUNING.maxDelayMs);
        expect(computeBackoffDelay(0, () => -5)).toBeGreaterThanOrEqual(0);
    });
});

describe('triageNetworkStatus', () => {
    it('treats 401/403/404/429 as terminal', () => {
        expect(triageNetworkStatus(401)).toBe('terminal');
        expect(triageNetworkStatus(403)).toBe('terminal');
        expect(triageNetworkStatus(404)).toBe('terminal');
        // 429 = stream limit reached — retrying would just burn the recovery
        // budget against a capacity limit that won't clear on its own.
        expect(triageNetworkStatus(429)).toBe('terminal');
    });
    it('treats 5xx / 408 / undefined (connection-level) as recovering', () => {
        expect(triageNetworkStatus(500)).toBe('recovering');
        expect(triageNetworkStatus(503)).toBe('recovering');
        expect(triageNetworkStatus(408)).toBe('recovering');
        expect(triageNetworkStatus(undefined)).toBe('recovering');
    });
});

describe('triage410', () => {
    it('is terminal only when the server flags the session unrecoverable', () => {
        expect(triage410(true)).toBe('terminal');
        expect(triage410(false)).toBe('recovering');
    });
});

describe('decideRecovery', () => {
    it('nudges early hls.js attempts so a transient drop can clear via hls.startLoad()', () => {
        expect(decideRecovery({ isNativeEngine: false, attempt: 1 })).toBe('nudge');
        // Boundary: one below the escalation threshold still nudges.
        expect(decideRecovery({ isNativeEngine: false, attempt: HLSJS_REBUILD_ATTEMPT - 1 })).toBe(
            'nudge',
        );
    });

    it('escalates a persistent hls.js failure to a fresh-session rebuild (nudging cannot revive a dead pipeline)', () => {
        // Observed in the wild: buffer_starvation on Chrome/hls.js where
        // hls.startLoad() never restored playback and only a full page reload
        // (fresh PlaySessionId + MediaSource) recovered. After repeated failed
        // nudges the controller must do that rebuild itself.
        expect(decideRecovery({ isNativeEngine: false, attempt: HLSJS_REBUILD_ATTEMPT })).toBe(
            'rebuild',
        );
        expect(decideRecovery({ isNativeEngine: false, attempt: 9 })).toBe('rebuild');
    });

    it('nudges the FIRST native attempt so a transient rebuffer can clear itself', () => {
        expect(decideRecovery({ isNativeEngine: true, attempt: 1 })).toBe('nudge');
        // Boundary: one below the escalation threshold still nudges.
        expect(
            decideRecovery({
                isNativeEngine: true,
                attempt: NATIVE_STALL_REBUILD_ATTEMPT - 1,
            }),
        ).toBe('nudge');
    });

    it('escalates a persistent native stall to a fresh-session rebuild (Safari cannot re-fetch a dead session)', () => {
        expect(
            decideRecovery({ isNativeEngine: true, attempt: NATIVE_STALL_REBUILD_ATTEMPT }),
        ).toBe('rebuild');
        expect(decideRecovery({ isNativeEngine: true, attempt: 9 })).toBe('rebuild');
    });

    it('escalates native earlier than (or with) hls.js — the native nudge is a no-op', () => {
        expect(NATIVE_STALL_REBUILD_ATTEMPT).toBeLessThanOrEqual(HLSJS_REBUILD_ATTEMPT);
    });

    it('rebuilds from the FIRST attempt when the failure is manifest-stage — a nudge cannot reload a manifest', () => {
        // `hls.startLoad()` resumes level/fragment loading on a parsed
        // manifest. When the MANIFEST itself failed (503 from the gateway, say)
        // there is nothing to resume: the nudge sends no request at all, so the
        // first HLSJS_REBUILD_ATTEMPT-1 attempts would be pure waiting under a
        // "reconnecting" badge. Measured 2026-09-11 with a controlled 503.
        expect(decideRecovery({ isNativeEngine: false, attempt: 1, stage: 'manifest' })).toBe(
            'rebuild',
        );
        expect(decideRecovery({ isNativeEngine: true, attempt: 1, stage: 'manifest' })).toBe(
            'rebuild',
        );
        // Other stages keep the existing escalation ladder.
        expect(decideRecovery({ isNativeEngine: false, attempt: 1, stage: 'media-segment' })).toBe(
            'nudge',
        );
    });
});

describe('RECONNECT_TUNING.maxRecoverAttempts', () => {
    it('leaves room for at least one full rebuild on either engine before going terminal', () => {
        // If the budget were exhausted before the rebuild threshold, the
        // controller would go terminal having only ever nudged — the one
        // recovery that actually works would never run.
        expect(RECONNECT_TUNING.maxRecoverAttempts).toBeGreaterThan(HLSJS_REBUILD_ATTEMPT);
        expect(RECONNECT_TUNING.maxRecoverAttempts).toBeGreaterThan(NATIVE_STALL_REBUILD_ATTEMPT);
    });
});
