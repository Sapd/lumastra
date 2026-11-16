// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen, cleanup } from '@testing-library/svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { readable } from 'svelte/store';

const { viewPage } = vi.hoisted(() => ({
    viewPage: { data: { features: { mediaDownload: true } }, url: new URL('http://localhost/') },
}));
vi.mock('$app/stores', () => ({ page: readable(viewPage) }));
vi.mock('$env/dynamic/public', () => ({ env: {} }));
vi.mock('$lib/stores/modal.store', () => ({ modals: { replace: vi.fn(), closeAll: vi.fn() } }));
vi.mock('$lib/stores/playerNavigation', () => ({
    saveReturnPath: vi.fn(),
    setNavigatingToPlayer: vi.fn(),
    clearNavigatingToPlayer: vi.fn(),
}));
vi.mock('$lib/utils/modal-utils', () => ({ openRequestModal: vi.fn(), confirmDialog: vi.fn() }));
vi.mock('$lib/components/ui', () => ({
    WatchlistButton: vi.fn(),
    SendToTVButton: vi.fn(),
    Tooltip: vi.fn(),
}));
vi.mock('$lib/components/playlist', () => ({ PlaylistButton: vi.fn() }));
vi.mock('$lib/components/AIRatingButton.svelte', () => ({ default: vi.fn() }));
vi.mock('$lib/components/SeasonSelectorModal.svelte', () => ({ default: vi.fn() }));
vi.mock('./DebugPanel.svelte', () => ({ default: vi.fn() }));
vi.mock('$lib/components/ui/ContextMenu.svelte', () => ({ default: vi.fn() }));
vi.mock('$lib/pwa', () => ({ isPWAInstalled: vi.fn(() => false) }));

import ModalActions from './ModalActions.svelte';

const item = {
    mediaItemId: 'x',
    fileId: 'f',
    season: null,
    episode: null,
    seasonFolder: null,
    fileName: 'Film (2019).mkv',
    sizeBytes: 4_200_000_000,
    available: true,
};

function stubList(allowed: boolean) {
    vi.stubGlobal(
        'fetch',
        vi.fn(
            async () =>
                new Response(
                    JSON.stringify({
                        allowed,
                        maxParallel: 3,
                        seriesFolder: 'Film (2019)',
                        missingCount: 0,
                        items: [item],
                    }),
                ),
        ),
    );
}

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe('movie download button', () => {
    test('shows when the user may download', async () => {
        stubList(true);
        render(ModalActions, {
            mediaType: 'movie',
            externalIds: { internal: 'a3f5e8c7-1234-5678-90ab-cdef12345601' },
            title: 'Film',
            isAvailable: true,
        });
        expect(await screen.findByRole('button', { name: 'Download' })).toBeTruthy();
    });

    test('is absent when the user may not download', async () => {
        stubList(false);
        render(ModalActions, {
            mediaType: 'movie',
            externalIds: { internal: 'a3f5e8c7-1234-5678-90ab-cdef12345602' },
            title: 'Film',
            isAvailable: true,
        });
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 20));
        expect(screen.queryByTestId('download-button')).toBeNull();
    });
});
