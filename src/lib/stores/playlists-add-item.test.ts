// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `addItemToPlaylist` returned `null` for a 409 AND for every real failure, and
 * never rejected. Both UI callers read that single `null` as "already on the
 * playlist", so a 404, a 500 or a concurrently-deleted playlist flashed the
 * success tick over a track that was never added — and their `catch` blocks
 * were unreachable, because nothing ever threw.
 *
 * The component tests mock this function, so they pin how the UI reacts to a
 * rejection but not whether one ever happens. That is this file's job.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const addItem = vi.fn();

vi.mock('$lib/api/playlists', () => ({
    getPlaylists: vi.fn(),
    createPlaylist: vi.fn(),
    addItem: (...a: unknown[]) => addItem(...a),
    removeItem: vi.fn(),
    getPlaylist: vi.fn(),
    updatePlaylist: vi.fn(),
    deletePlaylist: vi.fn(),
    reorderItems: vi.fn(),
}));

import { addItemToPlaylist } from './playlists';

const ITEM = { externalIds: { internal: 'track-1' }, mediaType: 'track' as const, title: 'X' };

describe('addItemToPlaylist', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns null for an explicit duplicate result', async () => {
        addItem.mockResolvedValue({
            data: {
                results: [{ status: 'duplicate', entries: [] }],
                summary: { revision: 1, itemCount: 1, updatedAt: '' },
            },
            error: null,
            status: 200,
        });

        await expect(addItemToPlaylist(1, ITEM)).resolves.toBeNull();
    });

    it.each([404, 500, 503])(
        'rejects on a real failure (%i), never resolves null',
        async (status) => {
            addItem.mockResolvedValue({ data: null, error: 'boom', status });

            // Resolving null here is what let the callers confirm a write that
            // never landed.
            await expect(addItemToPlaylist(1, ITEM)).rejects.toThrow();
        },
    );

    it('rejects when the status is missing entirely', async () => {
        addItem.mockResolvedValue({ data: null, error: 'network' });

        await expect(addItemToPlaylist(1, ITEM)).rejects.toThrow();
    });

    it('rejects an unexpected success payload instead of reporting a duplicate', async () => {
        addItem.mockResolvedValue({ data: {}, error: null, status: 200 });

        await expect(addItemToPlaylist(1, ITEM)).rejects.toThrow();
    });
});
