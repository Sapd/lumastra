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
vi.mock('$app/paths', () => ({ base: '' }));

import DownloadButton from './DownloadButton.svelte';
import DownloadConfirmSheet from './DownloadConfirmSheet.svelte';
import { downloadQueue } from '$lib/downloads/download-queue.svelte';

function listBody(over: Record<string, unknown> = {}) {
    const mk = (n: number, size: number) => ({
        mediaItemId: `ep-${n}`,
        fileId: `f-${n}`,
        season: 1,
        episode: n,
        seasonFolder: 'Season 01',
        fileName: `Show - S01E0${n}.mkv`,
        sizeBytes: size,
        available: true,
    });
    return {
        allowed: true,
        maxParallel: 3,
        seriesFolder: 'Show (2020)',
        missingCount: 0,
        items: [mk(1, 1_000_000_000), mk(2, 1_000_000_000)],
        ...over,
    };
}

function stubList(body: unknown, status = 200) {
    const f = vi.fn(async (_url: string) => new Response(JSON.stringify(body), { status }));
    vi.stubGlobal('fetch', f);
    return f;
}

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    downloadQueue.dismissPending();
    downloadQueue.error = undefined;
    viewPage.data.features.mediaDownload = true;
});

describe('DownloadButton', () => {
    test('shows the button with the file size only when downloads are allowed', async () => {
        stubList(listBody({ items: [listBody().items[0]] }));
        render(DownloadButton, { mediaItemId: 'movie-allowed', showSize: true });
        expect(await screen.findByRole('button', { name: /Download \(1\.0 GB\)/ })).toBeTruthy();
    });

    test('renders nothing when the user may not download', async () => {
        const f = stubList(listBody({ allowed: false }));
        render(DownloadButton, { mediaItemId: 'movie-denied' });
        await waitFor(() => expect(f).toHaveBeenCalled());
        await Promise.resolve();
        expect(screen.queryByTestId('download-button')).toBeNull();
    });

    test('renders nothing and does not call the server when the feature is off', async () => {
        viewPage.data.features.mediaDownload = false;
        const f = stubList(listBody());
        render(DownloadButton, { mediaItemId: 'movie-off' });
        await Promise.resolve();
        expect(screen.queryByTestId('download-button')).toBeNull();
        expect(f).not.toHaveBeenCalled();
    });

    test('a failed list call (404) hides the button', async () => {
        const f = stubList({}, 404);
        render(DownloadButton, { mediaItemId: 'movie-404' });
        await waitFor(() => expect(f).toHaveBeenCalled());
        await Promise.resolve();
        expect(screen.queryByTestId('download-button')).toBeNull();
    });

    test('season button asks for that season only', async () => {
        const f = stubList(listBody());
        render(DownloadButton, {
            mediaItemId: 'series-seasons',
            season: 2,
            label: 'Download season',
        });
        await fireEvent.click(await screen.findByRole('button', { name: 'Download season' }));
        await waitFor(() =>
            expect(f.mock.calls.some((c) => String(c[0]).includes('?season=2'))).toBe(true),
        );
    });

    test('episode icons share the series permission check', async () => {
        const f = stubList(listBody());
        render(DownloadButton, {
            mediaItemId: 'ep-9',
            accessId: 'series-shared',
            variant: 'icon',
        });
        await screen.findByTestId('download-button');
        expect(String(f.mock.calls[0][0])).toContain('/api/media/series-shared/download-list');
    });
});

describe('DownloadConfirmSheet', () => {
    test('shows episode count, total size and unavailable episodes', async () => {
        stubList(listBody({ missingCount: 3 }));
        render(DownloadConfirmSheet);
        await downloadQueue.enqueue('series-sheet', { season: 1 });
        expect((await screen.findByTestId('download-summary')).textContent).toContain(
            '2 files, 2.0 GB',
        );
        expect(screen.getByTestId('download-missing').textContent).toContain(
            '3 episodes not available',
        );
        // the series-wide sheet offers specials, a single-season one does not
        expect(screen.queryByText('Include specials')).toBeNull();
    });

    test('series-wide sheet offers specials', async () => {
        stubList(listBody());
        render(DownloadConfirmSheet);
        await downloadQueue.enqueue('series-sheet-2');
        expect(await screen.findByText('Include specials')).toBeTruthy();
    });
});
