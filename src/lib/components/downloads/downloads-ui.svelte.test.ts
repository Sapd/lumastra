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
        render(DownloadButton, { mediaItemId: 'movie-allowed', showSize: true });
        const btn = await screen.findByRole('button', { name: 'Download' });
        // icon only: no visible text, the icon is hidden from assistive tech
        expect(btn.textContent?.trim()).toBe('');
        expect(btn.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    });

    test('episode icon is named "Download episode"', async () => {
        stubList(listBody());
        render(DownloadButton, { mediaItemId: 'ep-1', accessId: 'series-x' });
        expect(await screen.findByRole('button', { name: 'Download episode' })).toBeTruthy();
    });

    test('the size shows in the label after the first hover', async () => {
        const f = stubList(listBody({ items: [listBody().items[0]] }));
        render(DownloadButton, { mediaItemId: 'movie-size', showSize: true });
        const btn = await screen.findByRole('button', { name: 'Download' });
        expect(f).toHaveBeenCalledTimes(1); // only the summary probe so far
        await fireEvent.pointerEnter(btn);
        await waitFor(() =>
            expect(screen.getByTestId('download-button').getAttribute('aria-label')).toBe(
                'Download (1.0 GB)',
            ),
        );
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

    test('the tooltip text updates when the size arrives while it is open', async () => {
        const f = stubList(listBody({ items: [listBody().items[0]] }));
        render(DownloadButton, { mediaItemId: 'movie-live', showSize: true });
        const btn = await screen.findByRole('button', { name: 'Download' });
        await fireEvent.mouseEnter(btn.parentElement as HTMLElement);
        await waitFor(() => expect(document.querySelector('.tooltip-fixed')).toBeTruthy());
        expect(document.querySelector('.tooltip-fixed')?.textContent).toBe('Download');
        await fireEvent.pointerEnter(btn);
        await waitFor(() =>
            expect(document.querySelector('.tooltip-fixed')?.textContent).toBe('Download (1.0 GB)'),
        );
        expect(f).toHaveBeenCalledTimes(2);
    });

    test('episode icons reveal on row hover and keep a touch hit area', async () => {
        stubList(listBody());
        render(DownloadButton, { mediaItemId: 'ep-1', accessId: 'series-x', revealOnHover: true });
        const btn = await screen.findByTestId('download-button');
        expect(btn.classList.contains('download-reveal')).toBe(true);
        expect(btn.classList.contains('download-ghost')).toBe(true);
    });

    test('the season button asks for that season and passes it as the sheet scope', async () => {
        const f = stubList(listBody());
        render(DownloadButton, {
            mediaItemId: 'series-seasons',
            season: 2,
            label: 'Download season or series',
        });
        await fireEvent.click(
            await screen.findByRole('button', { name: 'Download season or series' }),
        );
        await waitFor(() =>
            expect(f.mock.calls.some((c) => String(c[0]).includes('?season=2'))).toBe(true),
        );
        await waitFor(() => expect(downloadQueue.pending?.scopeSeason).toBe(2));
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

    test('series-wide sheet offers specials', async () => {
        stubList(listBody());
        render(DownloadConfirmSheet);
        await downloadQueue.enqueue('series-sheet-2');
        expect(await screen.findByText('Include specials')).toBeTruthy();
    });
});

describe('DownloadConfirmSheet scope', () => {
    const it = (season: number, episode: number, size = 1_000_000_000) => ({
        mediaItemId: `ep-${season}-${episode}`,
        fileId: `f-${season}-${episode}`,
        season,
        episode,
        seasonFolder: `Season ${season}`,
        fileName: `S${season}E${episode}.mkv`,
        sizeBytes: size,
        available: true,
    });

    /** A server that filters by ?season / ?specials like the real endpoint. */
    function stubSeries(all: ReturnType<typeof it>[]) {
        const f = vi.fn(async (url: string) => {
            const u = new URL(String(url), 'http://x');
            const season = u.searchParams.get('season');
            const specials = u.searchParams.get('specials') === '1';
            const items = all.filter((i) =>
                season !== null ? i.season === Number(season) : specials || i.season !== 0,
            );
            return new Response(
                JSON.stringify({
                    allowed: true,
                    maxParallel: 3,
                    seriesFolder: 'Show (2019)',
                    missingCount: 0,
                    items,
                }),
            );
        });
        vi.stubGlobal('fetch', f);
        return f;
    }

    const twoSeasons = [it(1, 1), it(1, 2), it(2, 1), it(2, 2, 3_000_000_000), it(0, 1)];

    test('a season of a multi-season series offers season / whole series with counts and sizes', async () => {
        stubSeries(twoSeasons);
        render(DownloadConfirmSheet);
        await downloadQueue.enqueue('s-scope', { season: 2 }, 2);
        expect((await screen.findByTestId('download-confirm-sheet')).textContent).toContain(
            'Download "Show (2019)"',
        );
        expect(await screen.findByText('Season 2 · 2 episodes · 4.0 GB')).toBeTruthy();
        expect(screen.getByText('Whole series · 4 episodes · 6.0 GB')).toBeTruthy();
        expect((screen.getByTestId('download-scope-season') as HTMLInputElement).checked).toBe(
            true,
        );
        expect(screen.getByTestId('download-start').textContent).toContain(
            'Download 2 files · 4.0 GB',
        );
    });

    test('the radio switches to the whole series and back', async () => {
        stubSeries(twoSeasons);
        render(DownloadConfirmSheet);
        await downloadQueue.enqueue('s-scope-2', { season: 2 }, 2);
        await screen.findByText('Whole series · 4 episodes · 6.0 GB');
        await fireEvent.click(screen.getByTestId('download-scope-series'));
        await waitFor(() => expect(downloadQueue.pending?.opts).toEqual({}));
        await waitFor(() =>
            expect(screen.getByTestId('download-start').textContent).toContain(
                'Download 4 files · 6.0 GB',
            ),
        );
        // the specials checkbox belongs to the whole-series scope
        expect(screen.getByText('Include specials')).toBeTruthy();
        await fireEvent.click(screen.getByTestId('download-scope-season'));
        await waitFor(() => expect(downloadQueue.pending?.opts).toEqual({ season: 2 }));
        expect(screen.queryByText('Include specials')).toBeNull();
    });

    test('a single-season series has no scope radio', async () => {
        stubSeries([it(1, 1), it(1, 2), it(0, 1)]);
        render(DownloadConfirmSheet);
        await downloadQueue.enqueue('s-one', { season: 1 }, 1);
        await screen.findByTestId('download-confirm-sheet');
        await new Promise((r) => setTimeout(r, 20));
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
