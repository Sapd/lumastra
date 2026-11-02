// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Request-gate contract for the `period` param on GET /api/v1/me/stats (#41)
 * and GET /api/v1/stats/users/{id} (#42).
 *
 * Both gates converge on the canonical `StatsPeriodSchema` — the FULL grammar
 * (enum 7d|30d|90d|all ∪ `year:YYYY`, 2000-2099). This pins that legitimate
 * `year:YYYY` traffic is STILL accepted: a blind tighten to the documented
 * 4-value enum would have rejected it.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('$lib/server/config.js', () => ({
    features: { personalStats: true, social: true },
    config: {},
    isUnavailableMediaVisible: () => true,
}));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: vi.fn(() => ({})) }));
vi.mock('$lib/server/cache/index.js', () => ({
    CACHE_NAMESPACES: { personalStats: 'personalStats' },
    cacheManager: { for: vi.fn() },
    buildVersionedCacheKey: (v: string, ...parts: (string | number)[]): string =>
        `${v}:${parts.join(':')}`,
}));
vi.mock('$lib/server/services/personal-stats.service.js', () => ({
    accessFingerprint: vi.fn(() => ''),
    personalStatsService: {},
}));

const { def: meDef } = await import('./me.js');
const { def: usersDef } = await import('./users-id.js');

const gates = [
    ['stats/me', meDef.request!.query!],
    ['stats/users/{id}', usersDef.request!.query!],
] as const;

describe.each(gates)('%s — period gate', (_name, query) => {
    it('accepts the documented enum values', () => {
        for (const period of ['7d', '30d', '90d', 'all']) {
            expect(query.safeParse({ period }).success, period).toBe(true);
        }
    });

    it('STILL accepts year:YYYY (2000-2099)', () => {
        expect(query.safeParse({ period: 'year:2000' }).success).toBe(true);
        expect(query.safeParse({ period: 'year:2026' }).success).toBe(true);
        expect(query.safeParse({ period: 'year:2099' }).success).toBe(true);
    });

    it('rejects out-of-range years and junk', () => {
        expect(query.safeParse({ period: 'year:1999' }).success).toBe(false);
        expect(query.safeParse({ period: 'year:2100' }).success).toBe(false);
        expect(query.safeParse({ period: 'yesterday' }).success).toBe(false);
    });

    it('leaves period optional', () => {
        expect(query.safeParse({}).success).toBe(true);
    });
});
