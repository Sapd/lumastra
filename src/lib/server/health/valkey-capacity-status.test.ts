// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { valkeyCapacityStatus } from './valkey-capacity-status.js';

describe('valkeyCapacityStatus', () => {
    it('passes the shipped single-instance setup: noeviction, no maxmemory', () => {
        expect(valkeyCapacityStatus(null, 'noeviction', ['cache', 'tasks'])).toEqual({
            status: 'pass',
        });
    });

    it.each(['volatile-lru', 'volatile-ttl', 'allkeys-lru', 'allkeys-lfu'])(
        'warns when the instance holding tasks runs %s',
        (policy) => {
            const res = valkeyCapacityStatus(null, policy, ['cache', 'tasks']);
            expect(res.status).toBe('warn');
            expect(res.reason).toContain(policy);
            expect(valkeyCapacityStatus(10, policy, ['tasks']).status).toBe('warn');
        },
    );

    it('lets a cache-only instance evict', () => {
        expect(valkeyCapacityStatus(50, 'allkeys-lru', ['cache'])).toEqual({ status: 'pass' });
        expect(valkeyCapacityStatus(null, 'volatile-lru', ['cache'])).toEqual({ status: 'pass' });
    });

    it('keeps the usage thresholds, and capacity failures outrank the policy warning', () => {
        expect(valkeyCapacityStatus(75, 'noeviction', ['tasks']).status).toBe('warn');
        expect(valkeyCapacityStatus(85, 'allkeys-lru', ['cache', 'tasks'])).toMatchObject({
            status: 'fail',
            reason: 'capacity critical (>80% of maxmemory)',
        });
        expect(valkeyCapacityStatus(99, 'noeviction', ['tasks']).reason).toContain('>95%');
    });

    it('does not warn when the policy is unknown', () => {
        expect(valkeyCapacityStatus(null, null, ['cache', 'tasks'])).toEqual({ status: 'pass' });
    });
});
