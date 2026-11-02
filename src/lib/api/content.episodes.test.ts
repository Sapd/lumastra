// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('./client.js', () => ({ apiGet, apiPost: vi.fn(), apiPut: vi.fn(), apiDelete: vi.fn() }));
import { getSeriesEpisodes } from './content';

const page = (id: string, offset: number, hasMore: boolean) => ({
    data: { items: [{ id }], page: { limit: 100, offset, hasMore } },
    error: null,
    status: 200,
});

beforeEach(() => apiGet.mockReset());

describe('complete episode collections', () => {
    it('follows every page using the server link and the real limit cap', async () => {
        apiGet
            .mockResolvedValueOnce(page('episode-1', 0, true))
            .mockResolvedValueOnce(page('episode-101', 100, false));
        const href = '/api/series/show/episodes?season=2&ordering=dvd';
        const result = await getSeriesEpisodes('show', 2, { href, limit: 500 });
        expect(result.data?.items.map((item) => item.id)).toEqual(['episode-1', 'episode-101']);
        expect(apiGet).toHaveBeenNthCalledWith(2, href, expect.anything(), {
            params: { limit: 100, offset: 100 },
        });
        expect(result.data?.page.hasMore).toBe(false);
    });

    it('propagates later-page errors instead of returning an incomplete season', async () => {
        apiGet
            .mockResolvedValueOnce(page('episode-1', 0, true))
            .mockResolvedValueOnce({ data: null, error: 'offline', status: 503 });
        expect((await getSeriesEpisodes('show', 1)).error).toBe('offline');
    });
});
