// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { readable } from 'svelte/store';

const { viewPage } = vi.hoisted(() => ({
    viewPage: {
        data: {
            features: { mediaDownload: true },
            user: { userGroups: [] as string[] },
            adminGroups: ['admins'],
            arrManagerGroups: [] as string[],
        },
        url: new URL('http://localhost/'),
    },
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
import { downloadQueue } from '$lib/downloads/download-queue.svelte';

const MOVIE = 'a3f5e8c7-1234-5678-90ab-cdef12345601';
const SERIES = 'a3f5e8c7-1234-5678-90ab-cdef12345602';

function stubList(allowed: boolean) {
    const f = vi.fn(
        async () =>
            new Response(
                JSON.stringify({
                    allowed,
                    maxParallel: 3,
                    seriesFolder: 'Show (2019)',
                    missingCount: 0,
                    items: [],
                }),
            ),
    );
    vi.stubGlobal('fetch', f);
    return f;
}

let n = 0;
/** Each test its own id: the queue caches the permission probe per id for a minute. */
const uid = () => `a3f5e8c7-1234-5678-90ab-${String(++n).padStart(12, '0')}`;

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    viewPage.data.user.userGroups = [];
    viewPage.data.features.mediaDownload = true;
    downloadQueue.pickerContext = null;
});

const moreButton = () => screen.findByRole('button', { name: 'More actions' });
const open = async () => fireEvent.click(await moreButton());

describe('"..." menu: movie', () => {
    test('has "Download…" for a user who may download; no top-level download icon', async () => {
        stubList(true);
        render(ModalActions, {
            mediaType: 'movie',
            externalIds: { internal: uid() },
            title: 'Film',
            isAvailable: true,
        });
        await open();
        expect(await screen.findByRole('menuitem', { name: 'Download…' })).toBeTruthy();
        expect(screen.queryByTestId('download-button')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Download' })).toBeNull();
        // not an admin: no admin entries
        expect(screen.queryByRole('menuitem', { name: 'Manage in Admin' })).toBeNull();
    });

    test('the item opens the sheet for that one title (no scope)', async () => {
        stubList(true);
        const enqueue = vi.spyOn(downloadQueue, 'enqueue').mockResolvedValue();
        const id = uid();
        render(ModalActions, {
            mediaType: 'movie',
            externalIds: { internal: id },
            title: 'Film',
            isAvailable: true,
        });
        await open();
        await fireEvent.click(await screen.findByRole('menuitem', { name: 'Download…' }));
        expect(enqueue).toHaveBeenCalledWith(id);
    });

    test('a user who may not download and is no admin gets no "…" at all', async () => {
        stubList(false);
        const { container } = render(ModalActions, {
            mediaType: 'movie',
            externalIds: { internal: uid() },
            title: 'Film',
            isAvailable: true,
        });
        await new Promise((r) => setTimeout(r, 30));
        expect(screen.queryByRole('button', { name: 'More actions' })).toBeNull();
        expect(container.querySelector('[data-testid="download-button"]')).toBeNull();
    });

    test('with the feature off the menu stays hidden and the server is not asked', async () => {
        viewPage.data.features.mediaDownload = false;
        const f = stubList(true);
        render(ModalActions, {
            mediaType: 'movie',
            externalIds: { internal: uid() },
            title: 'Film',
            isAvailable: true,
        });
        await new Promise((r) => setTimeout(r, 30));
        expect(screen.queryByRole('button', { name: 'More actions' })).toBeNull();
        expect(f).not.toHaveBeenCalled();
    });
});

describe('"..." menu: series', () => {
    test('offers the picker season and the whole series', async () => {
        stubList(true);
        const enqueueSeries = vi.spyOn(downloadQueue, 'enqueueSeries').mockResolvedValue();
        const id = uid();
        downloadQueue.setPickerContext(id, 3);
        render(ModalActions, {
            mediaType: 'tv',
            isSeries: true,
            externalIds: { internal: id },
            title: 'Show',
            isAvailable: true,
        });
        await open();
        await fireEvent.click(await screen.findByRole('menuitem', { name: 'Download season 3…' }));
        expect(enqueueSeries).toHaveBeenCalledWith(id, { scope: 'season', season: 3 });
        await open();
        await fireEvent.click(await screen.findByRole('menuitem', { name: 'Download series…' }));
        expect(enqueueSeries).toHaveBeenLastCalledWith(id, { scope: 'series', season: 3 });
    });

    test('season 0 reads "Download specials…"; no picker context means only the series entry', async () => {
        stubList(true);
        const id = uid();
        downloadQueue.setPickerContext(id, 0);
        render(ModalActions, {
            mediaType: 'tv',
            isSeries: true,
            externalIds: { internal: id },
            title: 'Show',
            isAvailable: true,
        });
        await open();
        expect(await screen.findByRole('menuitem', { name: 'Download specials…' })).toBeTruthy();
        cleanup();
        downloadQueue.pickerContext = null;
        render(ModalActions, {
            mediaType: 'tv',
            isSeries: true,
            externalIds: { internal: id },
            title: 'Show',
            isAvailable: true,
        });
        await open();
        expect(await screen.findByRole('menuitem', { name: 'Download series…' })).toBeTruthy();
        expect(screen.queryByRole('menuitem', { name: /Download season|specials/ })).toBeNull();
    });

    test('a picker of another series does not lend its season', async () => {
        stubList(true);
        downloadQueue.setPickerContext('some-other-series', 2);
        render(ModalActions, {
            mediaType: 'tv',
            isSeries: true,
            externalIds: { internal: SERIES },
            title: 'Show',
            isAvailable: true,
        });
        await open();
        await screen.findByRole('menuitem', { name: 'Download series…' });
        expect(screen.queryByRole('menuitem', { name: /Download season/ })).toBeNull();
    });
});

describe('"..." menu: admin', () => {
    test('an admin who may not download sees only the admin entries', async () => {
        viewPage.data.user.userGroups = ['admins'];
        stubList(false);
        render(ModalActions, {
            mediaType: 'movie',
            externalIds: { internal: uid() },
            title: 'Film',
            isAvailable: true,
        });
        await open();
        expect(await screen.findByRole('menuitem', { name: 'Manage in Admin' })).toBeTruthy();
        expect(screen.queryByRole('menuitem', { name: 'Download…' })).toBeNull();
        expect(screen.queryByRole('separator')).toBeNull();
    });

    test('an admin who may download gets the download entry first, a divider, then the admin ones', async () => {
        viewPage.data.user.userGroups = ['admins'];
        stubList(true);
        render(ModalActions, {
            mediaType: 'movie',
            externalIds: { internal: uid() },
            title: 'Film',
            isAvailable: true,
        });
        await open();
        await screen.findByRole('menuitem', { name: 'Download…' });
        const items = screen.getAllByRole('menuitem').map((e) => e.textContent?.trim());
        expect(items).toEqual(['Download…', 'Manage in Admin', 'Admin Debug Info']);
        const sep = screen.getByRole('separator');
        const all = Array.from(document.querySelectorAll('[role="menuitem"], [role="separator"]'));
        expect(all.indexOf(sep)).toBe(1);
    });
});

describe('stale probe', () => {
    test('a menu never shows download entries before the probe answers', async () => {
        const f = vi.fn(() => new Promise<Response>(() => {}));
        vi.stubGlobal('fetch', f);
        render(ModalActions, {
            mediaType: 'movie',
            externalIds: { internal: MOVIE },
            title: 'Film',
            isAvailable: true,
        });
        await waitFor(() => expect(f).toHaveBeenCalled());
        expect(screen.queryByRole('button', { name: 'More actions' })).toBeNull();
    });
});
