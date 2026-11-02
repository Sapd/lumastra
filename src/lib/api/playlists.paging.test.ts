// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./client', () => ({
    apiGet: vi.fn(),
    apiPost: vi.fn(),
    apiPatch: vi.fn(),
    apiPut: vi.fn(),
    apiDelete: vi.fn(),
}));
import { apiGet } from './client';
import { getAllPlaylistItems } from './playlists';

beforeEach(() => {
    vi.clearAllMocks();
});

describe('playlist queue continuation', () => {
    it('follows page.nextCursor and appends each entry once', async () => {
        vi.mocked(apiGet)
            .mockResolvedValueOnce({
                data: {
                    items: [{ id: 1 }, { id: 2 }],
                    page: { limit: 2, hasMore: true, nextCursor: 'older' },
                },
                error: null,
                status: 200,
            })
            .mockResolvedValueOnce({
                data: { items: [{ id: 3 }], page: { limit: 2, hasMore: false } },
                error: null,
                status: 200,
            });
        const result = await getAllPlaylistItems(7);
        expect(result.data?.items.map((entry) => entry.id)).toEqual([1, 2, 3]);
        expect(apiGet).toHaveBeenLastCalledWith('/api/playlists/7/items', expect.anything(), {
            params: { offset: 0, limit: 1000, itemType: undefined, cursor: 'older' },
        });
    });

    it('fails a repeated continuation rather than building a duplicate queue', async () => {
        vi.mocked(apiGet).mockResolvedValue({
            data: { items: [{ id: 1 }], page: { limit: 1, hasMore: true, nextCursor: 'stuck' } },
            error: null,
            status: 200,
        });
        await expect(getAllPlaylistItems(7)).rejects.toThrow('Playlist cursor did not advance');
    });
});
