// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { cacheTtlUntilExpiry } from './token-cache-ttl.js';

describe('cacheTtlUntilExpiry', () => {
    const now = Date.parse('2026-10-06T12:00:00Z');
    const ttl = 30 * 60 * 1000;

    it('uses the default TTL for a token without expiry', () => {
        expect(cacheTtlUntilExpiry(null, ttl, now)).toBe(ttl);
    });

    it('caps the TTL at the token expiry', () => {
        expect(cacheTtlUntilExpiry(new Date(now + 60_000), ttl, now)).toBe(60_000);
    });

    it('keeps the default TTL when the expiry is further out', () => {
        expect(cacheTtlUntilExpiry(new Date(now + 2 * ttl), ttl, now)).toBe(ttl);
    });

    it('never returns a negative TTL for an already expired token', () => {
        expect(cacheTtlUntilExpiry(new Date(now - 1000), ttl, now)).toBe(0);
    });

    it('accepts an ISO string and treats garbage as already expired', () => {
        expect(cacheTtlUntilExpiry('2026-10-06T12:00:10Z', ttl, now)).toBe(10_000);
        expect(cacheTtlUntilExpiry('not a date', ttl, now)).toBe(0);
    });
});
