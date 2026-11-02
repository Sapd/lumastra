// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const read = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/api/conformance-counter.js', () => ({
    readConformance: read,
    CONFORMANCE_MAX_DAYS: 8,
}));
import { def } from './index.js';

beforeEach(() => {
    vi.clearAllMocks();
});

describe('GET admin api-conformance', () => {
    it('requires admin and is internal only', () => {
        expect(def.auth).toEqual({ kind: 'admin' });
        expect(def.docs?.visibility).toBe('internal');
    });
    it('validates days 1..8, since as ISO, and leaves days open for since to derive', () => {
        const query = def.request!.query!;
        expect(query.parse({})).toEqual({});
        expect(query.parse({ since: '2026-10-17T10:00:00Z' })).toEqual({
            since: '2026-10-17T10:00:00Z',
        });
        expect(query.safeParse({ since: 'yesterday' }).success).toBe(false);
        for (const days of ['0', '9', '1.5', 'no'])
            expect(query.safeParse({ days }).success).toBe(false);
        expect(query.parse({ days: '8' })).toEqual({ days: 8 });
    });
    it('returns totals and sorted reader items', async () => {
        const items = [
            { method: 'GET', route: '/api/a/[id]', kind: 'stripped', count: 5, samples: ['extra'] },
            {
                method: 'POST',
                route: '/api/b',
                kind: 'mismatch',
                count: 2,
                samples: ['id:invalid_type'],
            },
        ];
        read.mockResolvedValue(items);
        const response = (await def.handlers.GET!(
            {} as RequestEvent,
            {
                surface: 'internal',
                input: { body: undefined, params: undefined, query: { days: 2 } },
            } as never,
        )) as Response;
        expect(read).toHaveBeenCalledWith(2, expect.any(Date), undefined);
        expect(await response.json()).toEqual({
            days: 2,
            totals: { stripped: 5, mismatch: 2 },
            items,
        });
    });
    it('returns zero totals for an empty window', async () => {
        read.mockResolvedValue([]);
        const response = (await def.handlers.GET!(
            {} as RequestEvent,
            { surface: 'internal', input: { query: {} } } as never,
        )) as Response;
        expect(await response.json()).toEqual({
            days: 1,
            totals: { stripped: 0, mismatch: 0 },
            items: [],
        });
    });
    it('passes since to the reader and reads back far enough to cover it', async () => {
        read.mockResolvedValue([]);
        const since = new Date(Date.now() - 2.5 * 86_400_000).toISOString();
        const response = (await def.handlers.GET!(
            {} as RequestEvent,
            { surface: 'internal', input: { query: { since } } } as never,
        )) as Response;
        expect(read).toHaveBeenCalledWith(4, expect.any(Date), new Date(since));
        expect(await response.json()).toMatchObject({ days: 4, since });
    });
});
