// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import {
    render,
    screen,
    fireEvent,
    cleanup,
} from '@testing-library/svelte';
import {
    afterEach,
    beforeEach,
    expect,
    it,
    vi,
} from 'vitest';
import { musicTrackFromCard } from '$lib/utils/music-track';
import SaveMixButton from './SaveMixButton.svelte';
const mocks = vi.hoisted(() => ({ create: vi.fn(), add: vi.fn(), reorder: vi.fn() }));
vi.mock('$lib/api/playlists', () => ({
    createPlaylist: mocks.create,
    addItem: mocks.add,
    reorderItems: mocks.reorder,
}));
vi.mock('$lib/stores/toast.store', () => ({ toasts: { error: vi.fn(), success: vi.fn() } }));
vi.mock('$lib/paths', () => ({ resolve: (path: string) => path }));
beforeEach(() => {
    vi.clearAllMocks();
});
afterEach(cleanup);
it('retries a partial save into the same private playlist without repeating successful additions', async () => {
    mocks.create.mockResolvedValue({ data: { id: 42 } });
    mocks.add
        .mockResolvedValueOnce({
            data: {
                results: [
                    { mediaId: 'one', status: 'added', entries: [{ id: 1 }] },
                    { mediaId: 'two', status: 'rejected', entries: [] },
                ],
                summary: { itemCount: 1, revision: 1, updatedAt: '' },
            },
        })
        .mockResolvedValueOnce({
            data: {
                results: [{ mediaId: 'two', status: 'added', entries: [{ id: 2 }] }],
                summary: { itemCount: 2, revision: 2, updatedAt: '' },
            },
        });
    mocks.reorder.mockResolvedValue({ data: { itemCount: 2, revision: 3, updatedAt: '' } });
    render(SaveMixButton, {
        title: 'Dance Mix',
        tracks: [
            musicTrackFromCard({ id: 'one', title: 'First', artists: [{ id: null, title: 'A' }] }),
            musicTrackFromCard({ id: 'two', title: 'Second', artists: [{ id: null, title: 'B' }] }),
        ],
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Save as playlist' }));
    await fireEvent.click(await screen.findByRole('button', { name: 'Retry saving' }));
    await screen.findByRole('button', { name: 'Saved' });
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.create).toHaveBeenCalledWith(
        expect.objectContaining({ visibility: 'private', playlistType: 'music' }),
    );
    expect(mocks.add.mock.calls.map((call) => call[1].mediaIds)).toEqual([['one', 'two'], ['two']]);
    expect(mocks.reorder).toHaveBeenCalledWith(42, { expectedRevision: 2, entryIds: [1, 2] });
    expect(screen.getByRole('link', { name: 'Open saved playlist' }).getAttribute('href')).toBe(
        '/playlists/42?type=music&from=music',
    );
});
