// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { render, screen, cleanup, fireEvent } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
const getPlaylistItems = vi.hoisted(() => vi.fn());
vi.mock('$lib/api/playlists.js', () => ({ getPlaylistItems }));
vi.mock('$app/stores', async () => ({
    page: (await import('svelte/store')).readable({ data: {} }),
}));
import PlaylistBrowser from './PlaylistBrowser.svelte';
afterEach(cleanup);
describe('video playlist browser', () => {
    it('disables audio entries and retains original video positions', async () => {
        const onselectitem = vi.fn();
        getPlaylistItems.mockResolvedValue({
            data: {
                page: { limit: 200, offset: 0, hasMore: false, total: 3 },
                items: [
                    {
                        id: 1,
                        mediaId: '550e8400-e29b-41d4-a716-446655440001',
                        title: 'First film',
                        mediaType: 'movie',
                        position: 0,
                        watched: false,
                        addedAt: '2026-01-01T00:00:00Z',
                    },
                    {
                        id: 2,
                        mediaId: '550e8400-e29b-41d4-a716-446655440002',
                        title: 'A song',
                        mediaType: 'track',
                        position: 1,
                        watched: false,
                        addedAt: '2026-01-01T00:00:00Z',
                    },
                    {
                        id: 3,
                        mediaId: '550e8400-e29b-41d4-a716-446655440003',
                        title: 'Second film',
                        mediaType: 'movie',
                        position: 2,
                        watched: false,
                        addedAt: '2026-01-01T00:00:00Z',
                    },
                ],
            },
        });
        render(PlaylistBrowser, { playlistId: 1, currentPosition: 0, isOpen: true, onselectitem });
        const song = await screen.findByRole('button', { name: /A song/ });
        expect((song as HTMLButtonElement).disabled).toBe(true);
        await fireEvent.click(screen.getByRole('button', { name: /Second film/ }));
        expect(onselectitem).toHaveBeenCalledWith({
            itemId: '550e8400-e29b-41d4-a716-446655440003',
            playlistId: 1,
            position: 2,
            title: 'Second film',
        });
    });
});

it('loads subsequent items pages for the sidebar', async () => {
    getPlaylistItems.mockReset();
    getPlaylistItems.mockResolvedValueOnce({
        data: {
            items: [
                {
                    id: 1,
                    mediaId: '550e8400-e29b-41d4-a716-446655440004',
                    mediaType: 'movie',
                    title: 'First page',
                    position: 0,
                    watched: false,
                    addedAt: '2026-01-01T00:00:00Z',
                },
            ],
            page: { limit: 1, offset: 0, hasMore: true, total: 2 },
        },
    });
    getPlaylistItems.mockResolvedValueOnce({
        data: {
            items: [
                {
                    id: 2,
                    mediaId: '550e8400-e29b-41d4-a716-446655440005',
                    mediaType: 'movie',
                    title: 'Second page',
                    position: 1,
                    watched: false,
                    addedAt: '2026-01-01T00:00:00Z',
                },
            ],
            page: { limit: 1, offset: 1, hasMore: false, total: 2 },
        },
    });
    render(PlaylistBrowser, { playlistId: 42, currentPosition: 0, isOpen: true });
    expect(await screen.findByRole('button', { name: /Second page/ })).toBeTruthy();
    expect(getPlaylistItems).toHaveBeenNthCalledWith(1, 42, 0);
    expect(getPlaylistItems).toHaveBeenNthCalledWith(2, 42, 1);
});
