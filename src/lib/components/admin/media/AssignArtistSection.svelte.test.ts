// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, fireEvent, screen } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
    searchArtists: vi.fn(),
    reassignAlbumArtist: vi.fn(),
    createArtistAndAssign: vi.fn(),
    updateMediaMetadata: vi.fn(),
}));
vi.mock('$lib/api/admin.js', () => api);
vi.mock('$lib/api/music-credits.js', () => ({
    readMusicEdits: vi.fn().mockResolvedValue({ data: { edits: [] } }),
    restoreMusicEdit: vi.fn(),
}));
vi.mock('$app/navigation', () => ({ goto: vi.fn(), beforeNavigate: vi.fn() }));
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('$lib/stores/toast.store.js', () => ({ toasts }));
import AssignArtistSection from './AssignArtistSection.svelte';
import OverviewTab from './OverviewTab.svelte';

const artist = { id: 'artist-id', title: 'Various Artists' };
const props = { albumId: 'album-id', currentArtistId: artist.id, currentArtistTitle: artist.title };

beforeEach(() => {
    vi.clearAllMocks();
    api.searchArtists.mockResolvedValue({ data: { artists: [artist] } });
    api.reassignAlbumArtist.mockResolvedValue({
        data: { artistId: artist.id, artistTitle: artist.title },
    });
});

describe('manual album artist confirmation', () => {
    it('permits explicit confirmation of the current artist and reloads after success', async () => {
        const onsaved = vi.fn();
        render(AssignArtistSection, { props: { ...props, onsaved } });
        await fireEvent.click(screen.getByRole('button', { name: 'Change' }));
        const current = await screen.findByRole('button', { name: artist.title });
        expect((current as HTMLButtonElement).disabled).toBe(false);
        await fireEvent.click(current);
        expect(api.reassignAlbumArtist).toHaveBeenCalledWith(props.albumId, artist.id, undefined);
        await vi.waitFor(() => expect(onsaved).toHaveBeenCalledOnce());
        expect(screen.getByText(artist.title)).toBeTruthy();
    });

    it('opening and cancelling writes nothing', async () => {
        render(AssignArtistSection, { props });
        await fireEvent.click(screen.getByRole('button', { name: 'Change' }));
        await screen.findByRole('button', { name: artist.title });
        await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(api.reassignAlbumArtist).not.toHaveBeenCalled();
        expect(api.createArtistAndAssign).not.toHaveBeenCalled();
    });

    it.each(['PATCH', 'POST'] as const)(
        '%s failure keeps the picker open without claiming save/lock success',
        async (method) => {
            const onsaved = vi.fn();
            api.searchArtists.mockResolvedValue({
                data: { artists: method === 'PATCH' ? [artist] : [] },
            });
            const mutation =
                method === 'PATCH' ? api.reassignAlbumArtist : api.createArtistAndAssign;
            mutation.mockResolvedValueOnce({ error: { message: 'Rejected' }, data: null });
            render(AssignArtistSection, { props: { ...props, onsaved } });
            await fireEvent.click(screen.getByRole('button', { name: 'Change' }));
            if (method === 'POST')
                await fireEvent.input(screen.getByPlaceholderText('Search artists…'), {
                    target: { value: 'New artist' },
                });
            const button = await screen.findByRole('button', {
                name: method === 'PATCH' ? artist.title : 'Create artist “New artist”',
            });
            await fireEvent.click(button);
            await vi.waitFor(() =>
                expect(toasts.error).toHaveBeenCalledWith(
                    method === 'PATCH' ? 'Could not assign artist' : 'Could not create artist',
                ),
            );
            expect(onsaved).not.toHaveBeenCalled();
            expect(toasts.success).not.toHaveBeenCalled();
            expect((button as HTMLButtonElement).disabled).toBe(false);
            expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
            expect(screen.queryByText(/Metadata locked/)).toBeNull();
            // Retry a rejected promise too: network rejection must leave the same usable picker.
            mutation.mockRejectedValueOnce(new Error('Network unavailable'));
            await fireEvent.click(button);
            await vi.waitFor(() => expect(toasts.error).toHaveBeenCalledTimes(2));
            expect(onsaved).not.toHaveBeenCalled();
            expect(toasts.success).not.toHaveBeenCalled();
            expect((button as HTMLButtonElement).disabled).toBe(false);
        },
    );

    it('Overview reflects the established manual metadata lock after reload', async () => {
        const overview = {
            mediaId: props.albumId,
            mediaType: 'album',
            title: 'Compilation',
            locked: false,
        };
        const { rerender } = render(OverviewTab, { props: overview });
        await rerender({ ...overview, locked: true, lockedBy: 'curator' });
        expect(
            screen.getByText('Metadata locked by curator — syncs will not overwrite'),
        ).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Unlock' })).toBeTruthy();
    });
});
