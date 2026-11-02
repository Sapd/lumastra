// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { render, screen, cleanup, fireEvent } from '@testing-library/svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { readable } from 'svelte/store';
import type { ExternalIds } from '$lib/types/api-common';

const { openAddToPlaylistModal, watchlistButton, viewPage } = vi.hoisted(() => {
    return {
        openAddToPlaylistModal: vi.fn(),
        watchlistButton: vi.fn(),
        viewPage: {
            data: { features: { playlists: true } },
            url: new URL('http://localhost/'),
        },
    };
});
vi.mock('$app/stores', () => ({ page: readable(viewPage) }));
vi.mock('$env/dynamic/public', () => ({ env: {} }));
vi.mock('$lib/stores/playlists', () => ({ openAddToPlaylistModal }));
vi.mock('$lib/stores/modal.store', () => ({ modals: { replace: vi.fn(), closeAll: vi.fn() } }));
vi.mock('$lib/stores/playerNavigation', () => ({
    saveReturnPath: vi.fn(),
    setNavigatingToPlayer: vi.fn(),
    clearNavigatingToPlayer: vi.fn(),
}));
vi.mock('$lib/utils/modal-utils', () => ({ openRequestModal: vi.fn() }));
vi.mock('$lib/components/ui', () => ({
    WatchlistButton: watchlistButton,
    SendToTVButton: vi.fn(),
    Tooltip: vi.fn(),
}));
// Render the real playlist trigger, including its mobile accessible name.
vi.mock('$lib/components/playlist', async () => ({
    PlaylistButton: (await import('$lib/components/playlist/PlaylistButton.svelte')).default,
}));
vi.mock('$lib/components/AIRatingButton.svelte', () => ({ default: vi.fn() }));
vi.mock('$lib/components/SeasonSelectorModal.svelte', () => ({ default: vi.fn() }));
vi.mock('./DebugPanel.svelte', () => ({ default: vi.fn() }));
vi.mock('$lib/components/ui/ContextMenu.svelte', () => ({ default: vi.fn() }));
vi.mock('$lib/pwa', () => ({ isPWAInstalled: vi.fn(() => false) }));

import ModalActions from './ModalActions.svelte';

const episodeId = 'a3f5e8c7-1234-5678-90ab-cdef12345678';
const seriesId = 'b3f5e8c7-1234-5678-90ab-cdef12345678';
const externalIds: ExternalIds = { internal: episodeId };

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    viewPage.data.features.playlists = true;
});

describe('episode playlist caller', () => {
    test('the actual ghost button has an accessible name and forwards episode identity/context', async () => {
        render(ModalActions, {
            mediaType: 'episode',
            externalIds,
            title: 'Episode title',
            overview: 'Episode overview',
            seasonNumber: 0,
            episodeNumber: 2,
            seriesName: 'Real series name',
            seriesInternalId: seriesId,
        });
        await fireEvent.click(screen.getByRole('button', { name: 'Add to Playlist' }));
        expect(openAddToPlaylistModal).toHaveBeenCalledWith(
            expect.objectContaining({
                externalIds: { internal: episodeId },
                mediaType: 'episode',
                title: 'Episode title',
                overview: 'Episode overview',
                seasonNumber: 0,
                episodeNumber: 2,
                seriesName: 'Real series name',
                seriesExternalIds: { internal: seriesId },
            }),
        );
        expect(watchlistButton).not.toHaveBeenCalled();
    });

    test.each([undefined, { tmdb: '123' }, { internal: 'not-a-uuid' }])(
        'does not substitute a parent or provider ID for a missing catalog episode: %j',
        (ids) => {
            render(ModalActions, {
                mediaType: 'episode',
                externalIds: ids,
                seriesInternalId: seriesId,
            });
            expect(screen.queryByRole('button', { name: 'Add to Playlist' })).toBeNull();
        },
    );

    test('respects the playlist feature without changing movie watchlist eligibility', () => {
        viewPage.data.features.playlists = false;
        render(ModalActions, { mediaType: 'movie', externalIds: { ...externalIds, tmdb: '550' } });
        expect(screen.queryByRole('button', { name: 'Add to Playlist' })).toBeNull();
        expect(watchlistButton).toHaveBeenCalled();
    });
});
