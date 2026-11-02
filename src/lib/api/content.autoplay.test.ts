// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { getNextEpisodeAfterPlayback } from './content.js';
import { NextEpisodeNodeSchema } from '$lib/schemas/api-series-responses';

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('./client.js', () => ({ apiGet, apiPost: vi.fn(), apiPut: vi.fn(), apiDelete: vi.fn() }));

describe('getNextEpisodeAfterPlayback', () => {
    it('uses the whole-file cursor and requests only the episode’s own artwork', async () => {
        apiGet.mockResolvedValue({ data: null, error: null });
        await getNextEpisodeAfterPlayback('series-id', 'episode-id');
        expect(apiGet).toHaveBeenCalledWith(
            '/api/series/series-id/next-episode',
            NextEpisodeNodeSchema,
            {
                params: { afterPlayback: 'episode-id', inherit: 'none' },
            },
        );
    });
});
