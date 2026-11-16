// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
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

describe('movie download icon placement and tooltip', () => {
    test('is an icon-only Share-style button before Close and carries the size once known', async () => {
        stubList(true);
        const { container } = render(ModalActions, {
            mediaType: 'movie',
            externalIds: { internal: 'a3f5e8c7-1234-5678-90ab-cdef12345603' },
            title: 'Film',
            isAvailable: true,
        });
        const btn = await screen.findByRole('button', { name: 'Download' });
        expect(btn.className).toContain('btn-icon');
        expect(btn.className).toContain('variant-ghost-surface');
        expect(btn.textContent?.trim()).toBe('');
        // the close button stays the last control of the row
        const buttons: HTMLElement[] = Array.from(container.querySelectorAll('button'));
        expect(buttons[buttons.length - 1].getAttribute('aria-label')).toBe('Close');
        expect(buttons.indexOf(btn)).toBeLessThan(buttons.length - 1);
        await fireEvent.pointerEnter(btn);
        await waitFor(() => expect(btn.getAttribute('aria-label')).toBe('Download (4.2 GB)'));
    });
});
