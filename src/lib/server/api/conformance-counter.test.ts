// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    hGetAll: vi.fn(),
    hIncrBy: vi.fn(),
    hSetNX: vi.fn(),
    hSet: vi.fn(),
    expire: vi.fn(),
    inc: vi.fn(),
}));
vi.mock('$lib/server/cache/valkey.js', () => mocks);
vi.mock('$lib/server/tasks/metrics.js', () => ({
    apiResponseConformanceTotal: { inc: mocks.inc },
}));

beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-16T23:59:55Z'));
    mocks.hGetAll.mockResolvedValue({});
    mocks.hIncrBy.mockResolvedValue(1);
    mocks.hSetNX.mockResolvedValue(true);
    mocks.hSet.mockResolvedValue(1);
    mocks.expire.mockResolvedValue(true);
});
afterEach(() => {
    vi.useRealTimers();
});

describe('buffered conformance counter', () => {
    it('batches hits, caps first samples, preserves UTC event day and exports boot totals', async () => {
        const { countConformance } = await import('./conformance-counter.js');
        const samples = ['a', 'b', 'c', 'd', 'e', 'f'];
        for (let i = 0; i < 100; i++)
            countConformance('GET', '/api/items/[id]', 'stripped', samples);
        expect(mocks.hIncrBy).not.toHaveBeenCalled();
        expect(mocks.inc).toHaveBeenCalledTimes(100);
        await vi.advanceTimersByTimeAsync(5_000);
        countConformance('GET', '/api/items/[id]', 'stripped', ['next-day']);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(mocks.hIncrBy.mock.calls).toEqual([
            ['apiconf:2026-10-16', 'GET /api/items/[id]|stripped', 100],
            ['apiconf:2026-10-17', 'GET /api/items/[id]|stripped', 1],
        ]);
        expect(mocks.hSetNX).toHaveBeenCalledWith(
            'apiconf:s:2026-10-16',
            'GET /api/items/[id]|stripped',
            JSON.stringify(samples.slice(0, 5)),
        );
        expect(mocks.expire).toHaveBeenCalledWith('apiconf:2026-10-16', 8 * 86_400);
        expect(mocks.expire).toHaveBeenCalledWith('apiconf:s:2026-10-16', 8 * 86_400);
        expect(mocks.expire).toHaveBeenCalledWith('apiconf:f:2026-10-16', 8 * 86_400);
        expect(mocks.expire).toHaveBeenCalledWith('apiconf:l:2026-10-16', 8 * 86_400);
        // First hit is kept (HSETNX), the last hit and its build are overwritten (HSET).
        expect(mocks.hSetNX).toHaveBeenCalledWith(
            'apiconf:f:2026-10-16',
            'GET /api/items/[id]|stripped',
            String(Date.parse('2026-10-16T23:59:55Z')),
        );
        expect(mocks.hSet).toHaveBeenCalledWith(
            'apiconf:l:2026-10-16',
            'GET /api/items/[id]|stripped',
            `${Date.parse('2026-10-16T23:59:55Z')}|`,
        );
        countConformance('GET', '/api/items/[id]', 'stripped', ['later']);
        await vi.advanceTimersByTimeAsync(9_999);
        expect(mocks.hIncrBy).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(mocks.hIncrBy).toHaveBeenCalledTimes(3);
    });

    it('ignores missing route ids and survives failed writes', async () => {
        const { countConformance } = await import('./conformance-counter.js');
        countConformance('GET', null, 'mismatch', []);
        expect(mocks.inc).not.toHaveBeenCalled();
        mocks.hIncrBy.mockRejectedValue(new Error('offline'));
        expect(() =>
            countConformance('GET', '/api/items/[id]', 'mismatch', ['id:invalid_type']),
        ).not.toThrow();
        await vi.advanceTimersByTimeAsync(10_000);
        // Expiry still runs after failed increments; the next batch still works.
        expect(mocks.expire).toHaveBeenCalledTimes(4);
        countConformance('GET', '/api/items/[id]', 'mismatch', []);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(mocks.hIncrBy).toHaveBeenCalledTimes(2);
    });

    it('sums days, caps samples, sorts and ignores corrupt entries', async () => {
        const { readConformance } = await import('./conformance-counter.js');
        mocks.hGetAll.mockImplementation(async (key: string) =>
            key.includes(':f:') || key.includes(':l:')
                ? {}
                : key.includes(':s:')
                  ? {
                        'GET /api/a/[id]|stripped': '["a","b","c","d","e","f"]',
                        'POST /api/b|mismatch': 'broken',
                    }
                  : {
                        'GET /api/a/[id]|stripped': '3',
                        'POST /api/b|mismatch': '2',
                        bad: '4',
                        'GET /bad|mismatch': '-1',
                    },
        );
        expect(await readConformance(2)).toEqual([
            {
                method: 'GET',
                route: '/api/a/[id]',
                kind: 'stripped',
                count: 6,
                samples: ['a', 'b', 'c', 'd', 'e'],
            },
            { method: 'POST', route: '/api/b', kind: 'mismatch', count: 4, samples: [] },
        ]);
    });

    it('reports first/last seen across days and filters by since', async () => {
        const { readConformance } = await import('./conformance-counter.js');
        const t = (iso: string) => String(Date.parse(iso));
        mocks.hGetAll.mockImplementation(async (key: string) => {
            const day = key.slice(-10);
            const base = { 'GET /api/a|mismatch': '2', 'GET /api/old|stripped': '9' };
            if (key.startsWith('apiconf:f:'))
                return day === '2026-10-16'
                    ? { 'GET /api/a|mismatch': t('2026-10-16T08:00:00Z') }
                    : { 'GET /api/a|mismatch': t('2026-10-15T20:00:00Z') };
            if (key.startsWith('apiconf:l:'))
                return day === '2026-10-16'
                    ? { 'GET /api/a|mismatch': `${t('2026-10-16T09:30:00Z')}|abc1234` }
                    : { 'GET /api/a|mismatch': `${t('2026-10-15T23:00:00Z')}|old0000` };
            if (key.startsWith('apiconf:s:')) return {};
            return base;
        });
        const now = new Date('2026-10-16T12:00:00Z');
        const all = await readConformance(2, now);
        const a = all.find((i) => i.route === '/api/a')!;
        expect(a).toMatchObject({
            count: 4,
            firstSeenAt: '2026-10-15T20:00:00.000Z',
            lastSeenAt: '2026-10-16T09:30:00.000Z',
            lastBuild: 'abc1234',
        });
        // A count recorded before timestamps existed has none, and `since` drops it.
        expect(all.find((i) => i.route === '/api/old')?.lastSeenAt).toBeUndefined();
        const afterDeploy = await readConformance(2, now, new Date('2026-10-16T09:00:00Z'));
        expect(afterDeploy.map((i) => i.route)).toEqual(['/api/a']);
        expect(await readConformance(2, now, new Date('2026-10-16T10:00:00Z'))).toEqual([]);
    });

    it('clamps days and tolerates unavailable Valkey', async () => {
        const { readConformance } = await import('./conformance-counter.js');
        mocks.hGetAll.mockRejectedValue(new Error('offline'));
        expect(await readConformance(99)).toEqual([]);
        expect(mocks.hGetAll).toHaveBeenCalledTimes(32);
    });
});
