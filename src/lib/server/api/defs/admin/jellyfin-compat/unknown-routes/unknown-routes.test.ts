// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mockHGetAll = vi.fn();
vi.mock('$lib/server/cache/valkey.js', () => ({
    hGetAll: (...a: unknown[]) => mockHGetAll(...a),
}));

import { def } from './index.js';
import { readUnknownRoutes } from '$lib/server/compat/jellyfin-unknown-routes.js';

beforeEach(() => vi.clearAllMocks());

describe('readUnknownRoutes', () => {
    it('sums days, splits route|client and sorts by count desc', async () => {
        const now = new Date('2026-10-07T10:00:00Z');
        mockHGetAll.mockImplementation(async (key: string) =>
            key === 'jfunk:2026-10-07'
                ? { 'GET /A|Swiftfin 1.0': '2', 'GET /B|Finamp 0.9': '5' }
                : key === 'jfunk:2026-10-06'
                  ? { 'GET /A|Swiftfin 1.0': '4' }
                  : {},
        );
        const items = await readUnknownRoutes(2, now);
        expect(items).toEqual([
            { route: 'GET /A', client: 'Swiftfin 1.0', count: 6 },
            { route: 'GET /B', client: 'Finamp 0.9', count: 5 },
        ]);
        expect(mockHGetAll).toHaveBeenCalledTimes(2);
    });

    it('clamps days to 8 and survives reader errors', async () => {
        mockHGetAll.mockRejectedValue(new Error('down'));
        expect(await readUnknownRoutes(99)).toEqual([]);
        expect(mockHGetAll).toHaveBeenCalledTimes(8);
    });
});

describe('GET /admin/jellyfin-compat/unknown-routes', () => {
    it('is admin-only', () => {
        expect(def.auth).toEqual({ kind: 'admin' });
    });

    it('returns the aggregated items', async () => {
        mockHGetAll.mockResolvedValue({ 'GET /X|App 1': '3' });
        const res = (await def.handlers.GET!(
            {} as RequestEvent,
            {
                surface: 'internal',
                input: { body: undefined, params: undefined, query: { days: 1 } },
            } as never,
        )) as Response;
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            items: [{ route: 'GET /X', client: 'App 1', count: 3 }],
        });
    });

    it('rejects days > 8 in its query schema', () => {
        const q = def.request!.query!;
        expect(q.safeParse({ days: '9' }).success).toBe(false);
        expect(q.parse({}).days).toBe(7);
    });
});
