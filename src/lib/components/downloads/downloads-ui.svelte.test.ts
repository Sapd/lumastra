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
const { toast } = vi.hoisted(() => ({
    toast: { info: vi.fn(), warning: vi.fn(), error: vi.fn(), success: vi.fn() },
}));
vi.mock('$lib/stores/toast.store', () => ({ toasts: toast }));

import DownloadButton from './DownloadButton.svelte';
import DownloadConfirmSheet from './DownloadConfirmSheet.svelte';
import DownloadQueuePanel from './DownloadQueuePanel.svelte';
import { archiveUrl, downloadQueue } from '$lib/downloads/download-queue.svelte';

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
    const f = vi.fn(async (url: string) => {
        // link mode asks the slots endpoint: free slots, and every hand-off confirmed
        if (String(url).includes('/downloads/slots')) {
            const h = new URL(String(url), 'http://x').searchParams.get('h');
            return new Response(
                JSON.stringify({ maxParallel: 3, inUse: 0, ...(h ? { started: true } : {}) }),
            );
        }
        return new Response(JSON.stringify(body), { status });
    });
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
    toast.info.mockClear();
    viewPage.data.features.mediaDownload = true;
});

describe('DownloadButton', () => {
    test('shows the button only when downloads are allowed', async () => {
        stubList(listBody());
        render(DownloadButton, { mediaItemId: 'movie-allowed' });
        const btn = await screen.findByRole('button', { name: 'Download episode' });
        // icon only: no visible text, the icon is hidden from assistive tech
        expect(btn.textContent?.trim()).toBe('');
        expect(btn.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    });

    test('episode icon is named "Download episode"', async () => {
        stubList(listBody());
        render(DownloadButton, { mediaItemId: 'ep-1', accessId: 'series-x' });
        expect(await screen.findByRole('button', { name: 'Download episode' })).toBeTruthy();
    });

    test('visibility uses the summary probe, the full list is fetched on click', async () => {
        const f = stubList(listBody());
        render(DownloadButton, { mediaItemId: 'movie-probe' });
        await fireEvent.click(await screen.findByTestId('download-button'));
        await waitFor(() => expect(f).toHaveBeenCalledTimes(2));
        expect(String(f.mock.calls[0][0])).toContain('/download-list?summary=1');
        expect(String(f.mock.calls[1][0])).toBe('/api/media/movie-probe/download-list');
    });

    test('stays enabled while a queue runs: a click answers with the busy toast', async () => {
        stubList(listBody());
        downloadQueue.state = 'running';
        render(DownloadButton, { mediaItemId: 'movie-busy' });
        const btn = (await screen.findByTestId('download-button')) as HTMLButtonElement;
        expect(btn.disabled).toBe(false);
        expect(btn.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
        await fireEvent.click(btn);
        expect(toast.info).toHaveBeenCalledWith('A download is already running.');
    });

    test('episode icons reveal on row hover and keep a touch hit area', async () => {
        stubList(listBody());
        render(DownloadButton, { mediaItemId: 'ep-1', accessId: 'series-x', revealOnHover: true });
        const btn = await screen.findByTestId('download-button');
        expect(btn.classList.contains('download-reveal')).toBe(true);
        expect(btn.classList.contains('download-ghost')).toBe(true);
    });

    test('an episode icon opens the sheet with "This episode" preselected, from ONE series list', async () => {
        const f = stubList(
            listBody({
                items: [1, 2, 3].map((n) => ({
                    ...listBody().items[0],
                    mediaItemId: `ep-${n}`,
                    fileId: `f-${n}`,
                    episode: n,
                })),
            }),
        );
        render(DownloadButton, { mediaItemId: 'ep-2', accessId: 'series-ep' });
        await fireEvent.click(await screen.findByTestId('download-button'));
        await waitFor(() => expect(downloadQueue.pending?.series?.scope).toBe('episode'));
        expect(downloadQueue.pending?.series?.episodeId).toBe('ep-2');
        expect(downloadQueue.pending?.list.items.map((i) => i.mediaItemId)).toEqual(['ep-2']);
        const urls = f.mock.calls.map((c) => String(c[0]));
        expect(urls).toEqual([
            '/api/media/series-ep/download-list?summary=1',
            '/api/media/series-ep/download-list?specials=1',
        ]);
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

    test('episode icons share the series permission check', async () => {
        const f = stubList(listBody());
        render(DownloadButton, {
            mediaItemId: 'ep-9',
            accessId: 'series-shared',
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
        expect((await screen.findByTestId('download-start')).textContent).toContain(
            'Download 2 files · 2.0 GB',
        );
        expect(screen.getByTestId('download-missing').textContent).toContain(
            '3 episodes not available',
        );
        // the series-wide sheet offers specials, a single-season one does not
        expect(screen.queryByText('Include specials')).toBeNull();
    });

    test('a series-wide sheet offers specials, a single-episode one does not', async () => {
        const sp = {
            ...listBody().items[0],
            mediaItemId: 'sp-1',
            season: 0,
            seasonFolder: 'Specials',
        };
        stubList(listBody({ items: [...listBody().items, sp] }));
        render(DownloadConfirmSheet);
        await downloadQueue.enqueueSeries('series-sheet-2', { scope: 'series' });
        expect(await screen.findByText('Include specials')).toBeTruthy();
        downloadQueue.dismissPending();
        await downloadQueue.enqueueSeries('series-sheet-2', {
            scope: 'episode',
            episodeId: 'ep-1',
        });
        await screen.findByTestId('download-confirm-sheet');
        expect(screen.queryByText('Include specials')).toBeNull();
    });
});

describe('DownloadConfirmSheet scope', () => {
    const it = (season: number, episode: number, size = 1_000_000_000) => ({
        mediaItemId: `ep-${season}-${episode}`,
        fileId: `f-${season}-${episode}`,
        season,
        episode,
        seasonFolder: season === 0 ? 'Specials' : `Season ${season}`,
        fileName: `Show - S0${season}E0${episode} - Title ${season}${episode}.mkv`,
        sizeBytes: size,
        available: true,
    });

    /** The one series list (season 0 included) the sheet derives everything from. */
    function stubSeries(all: ReturnType<typeof it>[]) {
        return stubList({
            allowed: true,
            maxParallel: 3,
            seriesFolder: 'Show (2019)',
            missingCount: 0,
            items: all,
        });
    }

    const twoSeasons = [it(1, 1), it(1, 2), it(1, 3), it(2, 1), it(2, 2, 3_000_000_000), it(0, 1)];
    const radioIds = () =>
        Array.from(document.querySelectorAll('[data-testid^="download-scope-"]')).map((e) =>
            e.getAttribute('data-testid'),
        );

    test('from an episode: every option with its count and size', async () => {
        const f = stubSeries(twoSeasons);
        render(DownloadConfirmSheet);
        await downloadQueue.enqueueSeries('s-scope', { scope: 'episode', episodeId: 'ep-1-2' });
        expect((await screen.findByTestId('download-confirm-sheet')).textContent).toContain(
            'Download "Show (2019)"',
        );
        expect(screen.getByText('This episode · S01E02 · 1.0 GB')).toBeTruthy();
        expect(screen.getByText('From here to end of season · 2 episodes · 2.0 GB')).toBeTruthy();
        expect(screen.getByText('Choose episodes…')).toBeTruthy();
        expect(screen.getByText('Whole season 1 · 3 episodes · 3.0 GB')).toBeTruthy();
        expect(screen.getByText('Whole series · 5 episodes · 7.0 GB')).toBeTruthy();
        expect((screen.getByTestId('download-scope-episode') as HTMLInputElement).checked).toBe(
            true,
        );
        expect(screen.getByTestId('download-start').textContent).toContain('Download · 1.0 GB');
        expect(f).toHaveBeenCalledTimes(1);
    });

    test('the last episode has no "from here"; a one-episode season has no checklist', async () => {
        stubSeries(twoSeasons);
        render(DownloadConfirmSheet);
        await downloadQueue.enqueueSeries('s-scope-2', { scope: 'episode', episodeId: 'ep-1-3' });
        await screen.findByTestId('download-scope');
        expect(screen.queryByTestId('download-scope-fromHere')).toBeNull();
        expect(screen.getByTestId('download-scope-custom')).toBeTruthy();
        downloadQueue.dismissPending();
        const one = [it(1, 1), it(2, 1), it(2, 2)];
        stubSeries(one);
        await downloadQueue.enqueueSeries('s-scope-2', { scope: 'season', season: 1 });
        await waitFor(() =>
            expect(radioIds()).toEqual(['download-scope-season', 'download-scope-series']),
        );
    });

    test('a season opened from the menu: "Whole season" selected, specials only for series', async () => {
        stubSeries(twoSeasons);
        render(DownloadConfirmSheet);
        await downloadQueue.enqueueSeries('s-scope-3', { scope: 'season', season: 2 });
        expect(await screen.findByText('Whole season 2 · 2 episodes · 4.0 GB')).toBeTruthy();
        expect((screen.getByTestId('download-scope-season') as HTMLInputElement).checked).toBe(
            true,
        );
        expect(screen.getByTestId('download-start').textContent).toContain(
            'Download 2 files · 4.0 GB',
        );
        expect(screen.queryByText('Include specials')).toBeNull();
        await fireEvent.click(screen.getByTestId('download-scope-series'));
        await waitFor(() =>
            expect(screen.getByTestId('download-start').textContent).toContain(
                'Download 5 files · 7.0 GB',
            ),
        );
        await fireEvent.click(screen.getByTestId('download-specials'));
        await waitFor(() =>
            expect(screen.getByTestId('download-start').textContent).toContain(
                'Download 6 files · 8.0 GB',
            ),
        );
    });

    test('the checklist lists the season, starts with the opening episode, and selects/deselects', async () => {
        stubSeries(twoSeasons);
        render(DownloadConfirmSheet);
        await downloadQueue.enqueueSeries('s-scope-4', { scope: 'episode', episodeId: 'ep-1-2' });
        await fireEvent.click(await screen.findByTestId('download-scope-custom'));
        const box = (id: string) =>
            screen.getByTestId(`download-episode-${id}`) as HTMLInputElement;
        await waitFor(() => expect(box('ep-1-1')).toBeTruthy());
        expect(screen.getByTestId('download-episodes').textContent).toContain('Title 12');
        expect([box('ep-1-1').checked, box('ep-1-2').checked, box('ep-1-3').checked]).toEqual([
            false,
            true,
            false,
        ]);
        await fireEvent.click(box('ep-1-3'));
        await waitFor(() =>
            expect(screen.getByTestId('download-start').textContent).toContain(
                'Download 2 files · 2.0 GB',
            ),
        );
        await fireEvent.click(screen.getByTestId('download-select-all'));
        await waitFor(() =>
            expect(screen.getByTestId('download-start').textContent).toContain(
                'Download 3 files · 3.0 GB',
            ),
        );
        await fireEvent.click(screen.getByTestId('download-select-none'));
        await waitFor(() =>
            expect((screen.getByTestId('download-start') as HTMLButtonElement).disabled).toBe(true),
        );
        await fireEvent.click(box('ep-1-1'));
        await waitFor(() =>
            expect((screen.getByTestId('download-start') as HTMLButtonElement).disabled).toBe(
                false,
            ),
        );
        expect(downloadQueue.pending?.opts).toEqual({ episodeIds: ['ep-1-1'] });
    });

    test('a season opened without an episode starts with every episode checked', async () => {
        stubSeries(twoSeasons);
        render(DownloadConfirmSheet);
        await downloadQueue.enqueueSeries('s-scope-5', { scope: 'custom', season: 1 });
        await screen.findByTestId('download-episodes');
        for (const id of ['ep-1-1', 'ep-1-2', 'ep-1-3']) {
            expect((screen.getByTestId(`download-episode-${id}`) as HTMLInputElement).checked).toBe(
                true,
            );
        }
    });

    test('a single-season series with one scope shows no scope radio', async () => {
        stubSeries([it(1, 1)]);
        render(DownloadConfirmSheet);
        await downloadQueue.enqueueSeries('s-one', { scope: 'season', season: 1 });
        await screen.findByTestId('download-confirm-sheet');
        expect(screen.queryByTestId('download-scope')).toBeNull();
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
        await screen.findByTestId('download-confirm-sheet');
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

    test('shows a waiting state', async () => {
        const base = listBody().items[0];
        downloadQueue.items = [{ ...base, path: ['a'], status: 'waiting', bytesDone: 0 }];
        downloadQueue.mode = 'folder';
        downloadQueue.state = 'running';
        render(DownloadQueuePanel);
        // collapsed by default: details on demand
        expect(screen.queryByTestId('download-waiting')).toBeNull();
        fireEvent.click(screen.getByTestId('download-toggle'));
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
    test('the sheet shows one hint line and the panel offers "Start next N"', async () => {
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
        // Chromium with the picker and no folder yet: only the folder hint, no browser or
        // batch hint (the panel's "Start next" explains batches when they happen).
        expect(await screen.findByTestId('download-folder-hint')).toBeTruthy();
        expect(screen.queryByTestId('download-browser-hint')).toBeNull();
        expect(screen.queryByTestId('download-batch-hint')).toBeNull();
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

describe('DownloadConfirmSheet ZIP choice (no folder picker)', () => {
    const season = (n: number, size = 1_000_000_000) => ({
        ...listBody({
            items: Array.from({ length: n }, (_, i) => ({
                mediaItemId: `ep-${i + 1}`,
                fileId: `f-${i + 1}`,
                season: 1,
                episode: i + 1,
                seasonFolder: 'Season 01',
                fileName: `Show - S01E0${i + 1}.mkv`,
                sizeBytes: size,
                available: true,
            })),
        }),
    });

    async function open(body: unknown) {
        // the picker is not usable here (as in Safari/Firefox/Brave)
        downloadQueue.pickerReason = 'blocked';
        stubList(body);
        render(DownloadConfirmSheet);
        await downloadQueue.enqueue('series-1');
        return screen.findByTestId('download-confirm-sheet');
    }

    afterEach(() => {
        downloadQueue.pickerReason = null;
    });

    test('offers separate files (default) or one ZIP, with the resume note only under ZIP', async () => {
        await open(season(2));
        const files = screen.getByTestId('download-format-files') as HTMLInputElement;
        const zip = screen.getByTestId('download-format-zip') as HTMLInputElement;
        expect(files.checked).toBe(true);
        expect(screen.getByText('Separate files')).toBeTruthy();
        expect(screen.getByText('One ZIP file (keeps Show/Season folders)')).toBeTruthy();
        expect(screen.queryByTestId('download-zip-note-resume')).toBeNull();
        await fireEvent.click(zip);
        await waitFor(() => expect(downloadQueue.archive).toBe(true));
        expect(screen.getByText("Can't resume if the connection drops.")).toBeTruthy();
        // 2 GB in total: no exFAT note
        expect(screen.queryByTestId('download-zip-note-big')).toBeNull();
        await fireEvent.click(files);
        await waitFor(() => expect(downloadQueue.archive).toBe(false));
    });

    test('over 4 GB adds the exFAT note', async () => {
        await open(season(3, 2_000_000_000));
        await fireEvent.click(screen.getByTestId('download-format-zip'));
        expect(
            await screen.findByText('Over 4 GB: needs an exFAT stick (not FAT32).'),
        ).toBeTruthy();
    });

    test('the primary button says ZIP when the ZIP is chosen, and a custom subset passes the ids', async () => {
        downloadQueue.pickerReason = 'blocked';
        stubList(season(3));
        render(DownloadConfirmSheet);
        await downloadQueue.enqueueSeries('series-zip', { scope: 'custom', season: 1 });
        await screen.findByTestId('download-format');
        await fireEvent.click(screen.getByTestId('download-episode-ep-3'));
        await fireEvent.click(screen.getByTestId('download-format-zip'));
        await waitFor(() =>
            expect(screen.getByTestId('download-start').textContent).toContain(
                'Download ZIP · 2.0 GB',
            ),
        );
        expect(downloadQueue.pending?.opts).toEqual({ episodeIds: ['ep-1', 'ep-2'] });
        expect(archiveUrl('series-zip', downloadQueue.pending!.opts)).toBe(
            '/api/media/series-zip/download-zip?episodes=ep-1%2Cep-2',
        );
    });

    test('a custom selection of more than 200 episodes hides the ZIP choice, silently', async () => {
        downloadQueue.pickerReason = 'blocked';
        stubList(season(201));
        render(DownloadConfirmSheet);
        await downloadQueue.enqueueSeries('series-big', { scope: 'custom', season: 1 });
        await screen.findByTestId('download-episodes');
        expect(screen.queryByTestId('download-format')).toBeNull();
        await fireEvent.click(screen.getByTestId('download-episode-ep-201'));
        await waitFor(() => expect(screen.getByTestId('download-format')).toBeTruthy());
    });

    test('is not offered for a single file', async () => {
        await open(season(1));
        expect(screen.queryByTestId('download-format')).toBeNull();
    });

    test('is not offered when the folder picker works', async () => {
        stubList(season(2));
        render(DownloadConfirmSheet);
        await downloadQueue.enqueue('series-1');
        await screen.findByTestId('download-confirm-sheet');
        expect(screen.queryByTestId('download-format')).toBeNull();
    });
});

describe('DownloadQueuePanel ZIP failures', () => {
    test.each([
        ['files_unavailable', /missing on the server/],
        ['limit', /Too many downloads at once/],
        ['forbidden', /not allowed/],
    ] as const)('shows the %s reason for the archive', async (reason, text) => {
        downloadQueue.items = [
            {
                mediaItemId: 's',
                fileId: 'archive',
                season: null,
                episode: null,
                seasonFolder: null,
                fileName: 'Show.zip',
                sizeBytes: 1,
                available: true,
                path: ['Show.zip'],
                status: 'failed',
                bytesDone: 0,
                reason,
            },
        ];
        downloadQueue.mode = 'zip';
        downloadQueue.state = 'done';
        render(DownloadQueuePanel);
        const failures = await screen.findByTestId('download-failures');
        expect(failures.textContent).toContain('Show.zip');
        expect(failures.textContent).toMatch(text);
    });
});

describe('DownloadQueuePanel ZIP retry', () => {
    test('a failed archive offers Retry that hands the ZIP over again', async () => {
        const retry = vi.spyOn(downloadQueue, 'retryArchive').mockResolvedValue();
        downloadQueue.items = [
            {
                mediaItemId: 's',
                fileId: 'archive',
                season: null,
                episode: null,
                seasonFolder: null,
                fileName: 'Show.zip',
                sizeBytes: 1,
                available: true,
                path: ['Show.zip'],
                status: 'failed',
                bytesDone: 0,
                reason: 'not_started',
            },
        ];
        downloadQueue.mode = 'zip';
        downloadQueue.state = 'done';
        render(DownloadQueuePanel);
        await fireEvent.click(await screen.findByTestId('download-retry'));
        expect(retry).toHaveBeenCalledTimes(1);
        retry.mockRestore();
    });
});
