// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';

import { SSR_SEED_MAX_AGE_MS, isSeedFresh, isSessionSeedFresh } from './ssr-seed';

describe('isSeedFresh', () => {
    const NOW = 1_800_000_000_000;

    it('trusts a seed from a genuine SSR render (milliseconds old)', () => {
        expect(isSeedFresh(NOW - 5, NOW)).toBe(true);
    });

    it('trusts a seed that is old but still within the reconciliation window', () => {
        expect(isSeedFresh(NOW - (SSR_SEED_MAX_AGE_MS - 1), NOW)).toBe(true);
    });

    it('rejects a seed at exactly the max age', () => {
        expect(isSeedFresh(NOW - SSR_SEED_MAX_AGE_MS, NOW)).toBe(false);
    });

    // The reported prod bug: a service-worker-cached app shell replayed days
    // later still embeds the streams/progress that were live when it was written.
    it('rejects a days-old seed replayed from a cached app shell', () => {
        const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
        expect(isSeedFresh(NOW - threeDaysMs, NOW)).toBe(false);
    });

    it('rejects a missing, null or zero timestamp', () => {
        expect(isSeedFresh(null, NOW)).toBe(false);
        expect(isSeedFresh(undefined, NOW)).toBe(false);
        expect(isSeedFresh(0, NOW)).toBe(false);
    });

    it('tolerates a future timestamp from replica clock skew', () => {
        expect(isSeedFresh(NOW + 2_000, NOW)).toBe(true);
    });

    it('exposes the sessions alias as the same predicate', () => {
        expect(isSessionSeedFresh).toBe(isSeedFresh);
    });
});
