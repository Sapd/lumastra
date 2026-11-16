// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { readable } from 'svelte/store';

const { viewPage } = vi.hoisted(() => {
    // The queue singleton decides at import time whether the browser has a folder picker.
    Object.assign(window, { showDirectoryPicker: async () => ({ name: 'USB' }) });
    return {
        viewPage: {
            data: { features: { mediaDownload: true } },
            url: new URL('http://localhost/'),
        },
    };
});
vi.mock('$app/stores', () => ({ page: readable(viewPage) }));
vi.mock('$app/paths', () => ({ base: '' }));

import DownloadButton from './DownloadButton.svelte';
import DownloadConfirmSheet from './DownloadConfirmSheet.svelte';
import DownloadQueuePanel from './DownloadQueuePanel.svelte';
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
    downloadQueue.state = 'idle'; // reset() refuses while 'running'
    downloadQueue.reset();
    downloadQueue.error = undefined;
    downloadQueue.notice = undefined;
    viewPage.data.features.mediaDownload = true;
});

describe('DownloadButton', () => {
    test('shows the button only when downloads are allowed', async () => {
        stubList(listBody());
        render(DownloadButton, { mediaItemId: 'movie-allowed' });
        expect(await screen.findByRole('button', { name: 'Download' })).toBeTruthy();
    });

    test('visibility uses the summary probe, the full list is fetched on click', async () => {
        const f = stubList(listBody());
        render(DownloadButton, { mediaItemId: 'movie-probe' });
        await fireEvent.click(await screen.findByRole('button', { name: 'Download' }));
        await waitFor(() => expect(f).toHaveBeenCalledTimes(2));
        expect(String(f.mock.calls[0][0])).toContain('/download-list?summary=1');
        expect(String(f.mock.calls[1][0])).toBe('/api/media/movie-probe/download-list');
    });

    test('is disabled while a queue is running', async () => {
        stubList(listBody());
        downloadQueue.state = 'running';
        render(DownloadButton, { mediaItemId: 'movie-busy', variant: 'icon' });
        const btn = (await screen.findByTestId('download-button')) as HTMLButtonElement;
        expect(btn.disabled).toBe(true);
        expect(btn.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
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
        expect(String(f.mock.calls[0][0])).toBe('/api/media/series-shared/download-list?summary=1');
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

describe('DownloadConfirmSheet extras', () => {
    test('warns about FAT32 when a file is 4 GiB or larger', async () => {
        const big = { ...listBody().items[0], sizeBytes: 5 * 1024 ** 3 };
        stubList(listBody({ items: [big] }));
        render(DownloadConfirmSheet);
        await downloadQueue.enqueue('series-fat');
        expect((await screen.findByTestId('download-fat32-warning')).textContent).toContain(
            'exFAT',
        );
    });

    test('no FAT32 warning for small files', async () => {
        stubList(listBody());
        render(DownloadConfirmSheet);
        await downloadQueue.enqueue('series-nofat');
        await screen.findByTestId('download-summary');
        expect(screen.queryByTestId('download-fat32-warning')).toBeNull();
    });

    test('moves focus into the sheet and back to the opener on close', async () => {
        stubList(listBody());
        const opener = document.createElement('button');
        document.body.appendChild(opener);
        opener.focus();
        render(DownloadConfirmSheet);
        await downloadQueue.enqueue('series-focus');
        const dialog = await screen.findByTestId('download-confirm-sheet');
        await waitFor(() => expect(document.activeElement).toBe(dialog));
        downloadQueue.dismissPending();
        await waitFor(() => expect(document.activeElement).toBe(opener));
        opener.remove();
    });
});

describe('DownloadQueuePanel', () => {
    function finishedWithFailures() {
        const base = listBody().items[0];
        downloadQueue.items = [
            { ...base, path: ['a'], status: 'failed', bytesDone: 0, reason: 'size_mismatch' },
            {
                ...base,
                fileId: 'f-2',
                fileName: 'two.mkv',
                path: ['b'],
                status: 'failed',
                bytesDone: 0,
                reason: 'limit',
            },
            { ...base, fileId: 'f-3', path: ['c'], status: 'done', bytesDone: 5 },
        ];
        downloadQueue.mode = 'folder';
        downloadQueue.state = 'done';
    }

    test('a finished run shows the failure count and a reason per failed item', () => {
        finishedWithFailures();
        render(DownloadQueuePanel);
        expect(screen.getByTestId('download-state').textContent).toBe('Done, 2 failed');
        const list = screen.getByTestId('download-failures').textContent ?? '';
        expect(list).toContain('File incomplete (size mismatch)');
        expect(list).toContain('Too many downloads at once, gave up');
    });

    test('shows a waiting state', () => {
        const base = listBody().items[0];
        downloadQueue.items = [{ ...base, path: ['a'], status: 'waiting', bytesDone: 0 }];
        downloadQueue.mode = 'folder';
        downloadQueue.state = 'running';
        render(DownloadQueuePanel);
        expect(screen.getByTestId('download-waiting').textContent).toContain('free slot');
    });

    test('the live region announces state, not byte progress', () => {
        const base = listBody().items[0];
        downloadQueue.items = [{ ...base, path: ['a'], status: 'active', bytesDone: 3 }];
        downloadQueue.current = downloadQueue.items[0];
        downloadQueue.mode = 'folder';
        downloadQueue.state = 'running';
        downloadQueue.bytesTotal = 2_000_000_000;
        downloadQueue.bytesDone = 123_456;
        render(DownloadQueuePanel);
        const live = screen.getByTestId('download-announcer');
        expect(live.getAttribute('aria-live')).toBe('polite');
        expect(live.textContent?.trim()).toBe(base.fileName);
        // the panel root itself is not a live region
        expect(screen.getByTestId('download-queue-panel').getAttribute('aria-live')).toBeNull();
    });
});

describe('link batches in the UI', () => {
    test('the sheet explains the batches and the panel offers "Start next N"', async () => {
        const items = [1, 2, 3, 4, 5].map((n) => ({
            mediaItemId: `ep-${n}`,
            fileId: `f-${n}`,
            season: 1,
            episode: n,
            seasonFolder: 'Season 01',
            fileName: `Show - S01E0${n}.mkv`,
            sizeBytes: 10,
            available: true,
        }));
        stubList(listBody({ maxParallel: 2, items }));
        await downloadQueue.enqueue('series-batches');
        downloadQueue.forgetFolder();
        render(DownloadConfirmSheet);
        render(DownloadQueuePanel);
        expect(await screen.findByTestId('download-batch-hint')).toBeTruthy();
        // no folder picked in this test: link mode
        await downloadQueue.start();
        const next = await screen.findByTestId('download-start-next');
        expect(next.textContent).toContain('2'); // 3 left, batch of 2
        expect(screen.queryByTestId('download-state')).toBeNull();
    });

    test('shows the Brave hint upfront when the picker is missing', async () => {
        stubList(listBody());
        const q = downloadQueue as unknown as { deps: { pickDirectory: unknown } };
        const savedPicker = q.deps.pickDirectory;
        q.deps.pickDirectory = null;
        Object.defineProperty(navigator, 'brave', {
            value: { isBrave: async () => true },
            configurable: true,
        });
        try {
            await downloadQueue.enqueue('series-brave');
            render(DownloadConfirmSheet);
            const hint = await screen.findByTestId('download-browser-hint');
            expect(hint.textContent).toContain('brave://flags/#file-system-access-api');
            // only one browser hint paragraph
            expect(screen.getAllByTestId('download-browser-hint')).toHaveLength(1);
        } finally {
            q.deps.pickDirectory = savedPicker;
            Reflect.deleteProperty(navigator, 'brave');
        }
    });

    test('Brave on iPhone shows the iOS hint, not the desktop flag', async () => {
        stubList(listBody());
        const q = downloadQueue as unknown as { deps: { pickDirectory: unknown; env: unknown } };
        const saved = { p: q.deps.pickDirectory, e: q.deps.env };
        q.deps.pickDirectory = null;
        q.deps.env = () => ({
            userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) Safari/604.1',
            maxTouchPoints: 5,
            brave: true,
        });
        try {
            await downloadQueue.enqueue('series-brave-ios');
            render(DownloadConfirmSheet);
            const hint = await screen.findByTestId('download-browser-hint');
            expect(hint.textContent).toContain('Files');
            expect(hint.textContent).not.toContain('brave://flags');
        } finally {
            q.deps.pickDirectory = saved.p;
            q.deps.env = saved.e;
        }
    });
});
