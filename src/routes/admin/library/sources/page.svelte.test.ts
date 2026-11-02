// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * Libraries overview — the compact list at /admin/library/sources.
 *
 * Everything per-library (folders table, access editing, inline editing)
 * moved to the [id] page and is covered by that page's own
 * tests. This file covers what's left here: per-library scan state (carried
 * over from the pre-restructure page, since the bug it pins — one library's
 * scan bleeding into another's row — is just as reachable in the new list),
 * the row's derived type/provider/last-scan/issues/access summary, drag
 * reorder, and the schedule line.
 */

import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readable } from 'svelte/store';
import { goto } from '$app/navigation';

const pageState = vi.hoisted(() => ({
    url: new URL('http://localhost/admin/library/sources'),
    data: {},
}));
vi.mock('$env/dynamic/public', () => ({ env: {} }));
vi.mock('$app/state', () => ({ page: pageState }));
vi.mock('$app/stores', () => ({
    page: readable(pageState),
    navigating: readable(null),
}));
vi.mock('$app/navigation', () => ({
    invalidateAll: vi.fn(),
    goto: vi.fn(),
    replaceState: vi.fn(),
}));
vi.mock('$app/paths', () => ({ base: '', resolve: (p: string) => p }));

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('$lib/stores/toast.store', () => ({ toasts }));
const modals = vi.hoisted(() => ({ open: vi.fn(), close: vi.fn() }));
vi.mock('$lib/stores/modal.store', () => ({ modals }));

const emptyResult = { data: null, error: null, status: 200 };
const client = vi.hoisted(() => ({
    apiGet: vi.fn(async (_url: string) => ({ data: null, error: null, status: 200 }) as unknown),
}));
vi.mock('$lib/api/client.js', () => ({
    apiGet: client.apiGet,
    apiPost: async () => emptyResult,
    apiPut: async () => emptyResult,
    apiPatch: async () => emptyResult,
    apiDelete: async () => emptyResult,
}));

const api = vi.hoisted(() => ({
    getLibraryGroups: vi.fn(),
    getLibraryPaths: vi.fn(),
    getFileScannerStatus: vi.fn(),
    triggerFileScanner: vi.fn(),
    updateLibraryGroup: vi.fn(),
    getLatestScannerRunPerLibrary: vi.fn(),
    getLibraryGroupPermissions: vi.fn(),
    getLibraryFileStats: vi.fn(),
    listUnmatchedFiles: vi.fn(),
}));
vi.mock('$lib/api/admin', async (importOriginal) => {
    const original = await importOriginal<Record<string, unknown>>();
    return { ...original, ...api };
});

import LibrarySourcesPage from './+page.svelte';
import { getLocale, overwriteGetLocale } from '$lib/paraglide/runtime.js';
const originalGetLocale = getLocale;
afterEach(() => overwriteGetLocale(originalGetLocale));
import type { PageData } from './$types';

const G_ANIME = '11111111-1111-4111-8111-000000000001';
const G_SERIES = '11111111-1111-4111-8111-000000000002';
const G_MOVIES = '11111111-1111-4111-8111-000000000003';
const P_ANIME = '22222222-2222-4222-8222-000000000001';
const P_SERIES = '22222222-2222-4222-8222-000000000002';
const P_MOVIES = '22222222-2222-4222-8222-000000000003';

const group = (
    id: string,
    name: string,
    sortOrder: number,
    extra: Record<string, unknown> = {},
) => ({ id, name, icon: null, sortOrder, maxAgeRating: null, ...extra });

const path = (
    id: string,
    p: string,
    libraryGroupId: string,
    mediaType: string,
    enabled = true,
) => ({
    id,
    path: p,
    mediaType,
    language: 'de',
    provider: 'tmdb',
    enabled,
    providerPath: null,
    libraryGroupId,
    editionLabel: null,
    scanChapters: false,
});

function statusWith(libraries: unknown[]) {
    return { data: { isRunning: libraries.length > 0, progress: null, libraries }, error: null };
}

function rowFor(name: string): HTMLElement {
    const link = screen.getByRole('link', { name });
    const li = link.closest('li');
    if (!li) throw new Error(`no library row for ${name}`);
    return li;
}

beforeEach(() => {
    vi.clearAllMocks();
    client.apiGet.mockResolvedValue({ data: null, error: null, status: 200 });
    api.getLibraryGroups.mockResolvedValue({
        data: {
            items: [
                group(G_ANIME, 'Anime', 0),
                group(G_SERIES, 'Serien', 1),
                group(G_MOVIES, 'Filme', 2),
            ],
        },
        error: null,
    });
    api.getLibraryPaths.mockResolvedValue({
        data: {
            items: [
                path(P_ANIME, '/data/anime', G_ANIME, 'anime'),
                path(P_SERIES, '/data/series', G_SERIES, 'tv'),
                path(P_MOVIES, '/data/movies', G_MOVIES, 'movie'),
            ],
        },
        error: null,
    });
    api.getFileScannerStatus.mockResolvedValue(
        statusWith([
            {
                libraryPathId: P_ANIME,
                state: 'running',
                trigger: 'scheduled',
                processedItems: 12040,
                totalItems: 30343,
                phase: 'scanning',
            },
            { libraryPathId: P_SERIES, state: 'queued', trigger: 'manual' },
        ]),
    );
    api.updateLibraryGroup.mockResolvedValue({ data: { group: {} }, error: null });
    api.getLatestScannerRunPerLibrary.mockResolvedValue({ data: { items: [] }, error: null });
    api.getLibraryGroupPermissions.mockResolvedValue({ data: { permissions: [] }, error: null });
    api.getLibraryFileStats.mockResolvedValue({ data: null, error: null });
    api.listUnmatchedFiles.mockResolvedValue({ data: { page: { total: 0 } }, error: null });
});

afterEach(() => {
    cleanup();
    pageState.url = new URL('http://localhost/admin/library/sources');
    window.history.replaceState({}, '', '/admin/library/sources');
});

async function renderPage(): Promise<void> {
    render(LibrarySourcesPage, { props: { data: {} as PageData } });
    await screen.findAllByText('Anime');
    await waitFor(() => expect(within(rowFor('Anime')).getByText(/Stop/)).toBeTruthy());
}

/** For tests with no scan in flight — waits for the rows, not a Stop button. */
async function renderIdle(): Promise<void> {
    render(LibrarySourcesPage, { props: { data: {} as PageData } });
    await screen.findAllByText('Anime');
}

describe('admin library overview — per-library scan state', () => {
    it('labels each library with its OWN state, and who started it', async () => {
        await renderPage();

        expect(within(rowFor('Anime')).getByText(/Scanning/)).toBeTruthy();
        expect(within(rowFor('Anime')).getByText(/automatic/)).toBeTruthy();
        expect(within(rowFor('Serien')).getByText(/Queued/)).toBeTruthy();
        expect(within(rowFor('Serien')).queryByText(/automatic/)).toBeNull();
        expect(within(rowFor('Filme')).getByRole('button', { name: /Scan Filme/ })).toBeTruthy();
    });

    it("Stop on one library aborts ONLY that library's scan", async () => {
        api.triggerFileScanner.mockResolvedValue({ data: { message: 'x' }, error: null });
        await renderPage();

        await fireEvent.click(within(rowFor('Serien')).getByRole('button', { name: /Stop/ }));

        await waitFor(() =>
            expect(api.triggerFileScanner).toHaveBeenCalledWith({
                action: 'abort',
                paths: [P_SERIES],
            }),
        );
    });

    it('leaves the end-of-scan notice to the app-wide manual-run tracker', async () => {
        await renderPage();
        api.getFileScannerStatus.mockResolvedValue(statusWith([]));
        await waitFor(() => expect(within(rowFor('Anime')).queryByText(/Stop/)).toBeNull(), {
            timeout: 4000,
        });
        expect(toasts.success).not.toHaveBeenCalled();
        expect(toasts.info).not.toHaveBeenCalled();
    });
});

describe('admin library overview — row summary', () => {
    it('derives type + provider from the FOLDER, not the library name', async () => {
        // The invariant: names carry no meaning. A movie library named
        // "Evening" must still show "Movie · TMDB", never anything derived
        // from the string "Evening".
        api.getLibraryGroups.mockResolvedValue({
            data: { items: [group(G_MOVIES, 'Evening', 0)] },
            error: null,
        });
        api.getLibraryPaths.mockResolvedValue({
            data: { items: [path(P_MOVIES, '/data/whatever', G_MOVIES, 'movie')] },
            error: null,
        });
        api.getFileScannerStatus.mockResolvedValue(statusWith([]));

        render(LibrarySourcesPage, { props: { data: {} as PageData } });
        await screen.findAllByText('Evening');

        const row = rowFor('Evening');
        expect(within(row).getByText('Movie')).toBeTruthy();
        expect(within(row).getByText('TMDB')).toBeTruthy();
    });

    it('shows last scan + changes summary from the newest run across the folders', async () => {
        api.getFileScannerStatus.mockResolvedValue(statusWith([]));
        api.getLatestScannerRunPerLibrary.mockResolvedValue({
            data: {
                items: [
                    {
                        id: 'run-1',
                        libraryPathId: P_MOVIES,
                        libraryPath: '/data/movies',
                        startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
                        completedAt: new Date().toISOString(),
                        totalFiles: 10,
                        matched: 5,
                        updated: 2,
                        added: 3,
                        unmatched: 0,
                        errors: 0,
                        errorSamples: [],
                        status: 'completed',
                        durationMs: 1000,
                        matchRate: 50,
                        createdAt: null,
                    },
                ],
            },
            error: null,
        });

        render(LibrarySourcesPage, { props: { data: {} as PageData } });
        await screen.findAllByText('Filme');

        expect(within(rowFor('Filme')).getByText(/new/)).toBeTruthy();
        expect(within(rowFor('Filme')).getByText(/updated/)).toBeTruthy();
    });

    it("sums errors across a library's folders into the issues summary", async () => {
        api.getFileScannerStatus.mockResolvedValue(statusWith([]));
        api.getLibraryPaths.mockResolvedValue({
            data: {
                items: [
                    path(P_MOVIES, '/data/movies-1', G_MOVIES, 'movie'),
                    path(
                        '22222222-2222-4222-8222-000000000004',
                        '/data/movies-2',
                        G_MOVIES,
                        'movie',
                    ),
                ],
            },
            error: null,
        });
        api.getLibraryGroups.mockResolvedValue({
            data: { items: [group(G_MOVIES, 'Filme', 0)] },
            error: null,
        });
        const runRow = (libraryPathId: string, errors: number) => ({
            id: `run-${libraryPathId}`,
            libraryPathId,
            libraryPath: 'x',
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            totalFiles: 10,
            matched: 0,
            updated: 0,
            added: 0,
            unmatched: 0,
            errors,
            errorSamples: [],
            status: 'completed' as const,
            durationMs: 1000,
            matchRate: 0,
            createdAt: null,
        });
        api.getLatestScannerRunPerLibrary.mockResolvedValue({
            data: {
                items: [runRow(P_MOVIES, 3), runRow('22222222-2222-4222-8222-000000000004', 5)],
            },
            error: null,
        });

        render(LibrarySourcesPage, { props: { data: {} as PageData } });
        await screen.findAllByText('Filme');

        expect(within(rowFor('Filme')).getByText(/8 files need attention/)).toBeTruthy();
    });

    it('shows a Restricted badge only for a library with allowed groups', async () => {
        api.getFileScannerStatus.mockResolvedValue(statusWith([]));
        api.getLibraryGroupPermissions.mockResolvedValue({
            data: { permissions: [{ libraryGroupId: G_MOVIES, allowedGroups: ['staff'] }] },
            error: null,
        });

        await renderIdle();

        expect(within(rowFor('Filme')).getByText('Restricted')).toBeTruthy();
        expect(within(rowFor('Anime')).queryByText('Restricted')).toBeNull();
    });
});

describe('admin library overview — reorder', () => {
    it('enables controls explicitly, keeps saved order when leaving, and ignores normal-mode drag events', async () => {
        api.getFileScannerStatus.mockResolvedValue(statusWith([]));
        await renderIdle();
        const toggle = screen.getByRole('button', { name: 'Reorder libraries' });
        const list = document.getElementById('library-source-list');
        if (!list) throw new Error('Missing library list');
        expect(toggle.getAttribute('aria-pressed')).toBe('false');
        expect(
            within(rowFor('Anime')).queryByRole('button', { name: /Move Anime down/ }),
        ).toBeNull();
        expect(screen.getByRole('link', { name: 'Anime' }).getAttribute('href')).toBe(
            `/admin/library/sources/${G_ANIME}`,
        );
        await fireEvent(
            list,
            new CustomEvent('finalize', {
                detail: { items: [], info: { source: 'pointer', trigger: 'droppedIntoZone' } },
            }),
        );
        expect(api.updateLibraryGroup).not.toHaveBeenCalled();
        await fireEvent.click(toggle);
        expect(toggle.getAttribute('aria-pressed')).toBe('true');
        await fireEvent.click(
            within(rowFor('Anime')).getByRole('button', { name: /Move Anime down/ }),
        );
        await waitFor(() => expect(api.updateLibraryGroup).toHaveBeenCalledTimes(2));
        await waitFor(() => expect(toggle.hasAttribute('disabled')).toBe(false));
        await fireEvent.click(toggle);
        expect(toggle.getAttribute('aria-pressed')).toBe('false');
        expect(
            within(rowFor('Anime')).queryByRole('button', { name: /Move Anime down/ }),
        ).toBeNull();
        expect([...list.querySelectorAll('a')].map((link) => link.textContent?.trim())).toEqual([
            'Serien',
            'Anime',
            'Filme',
        ]);
        await fireEvent(
            list,
            new CustomEvent('finalize', {
                detail: { items: [], info: { source: 'pointer', trigger: 'droppedIntoZone' } },
            }),
        );
        expect(api.updateLibraryGroup).toHaveBeenCalledTimes(2);
    });

    it('navigates from row content only outside reorder mode', async () => {
        api.getFileScannerStatus.mockResolvedValue(statusWith([]));
        await renderIdle();
        const content = within(rowFor('Anime')).getByText('TMDB');
        await fireEvent.click(content);
        expect(goto).toHaveBeenCalledTimes(1);
        expect(goto).toHaveBeenCalledWith(`/admin/library/sources/${G_ANIME}`);
        await fireEvent.click(screen.getByRole('button', { name: 'Reorder libraries' }));
        await fireEvent.click(content);
        expect(goto).toHaveBeenCalledTimes(1);
        await fireEvent.click(screen.getByRole('button', { name: 'Done' }));
        await fireEvent.click(content);
        expect(goto).toHaveBeenCalledTimes(2);
        expect(api.updateLibraryGroup).not.toHaveBeenCalled();
    });

    it('previews consider events and persists nonempty finalized drag order only in reorder mode', async () => {
        api.getFileScannerStatus.mockResolvedValue(statusWith([]));
        await renderIdle();
        const list = document.getElementById('library-source-list');
        if (!list) throw new Error('Missing library list');
        const reordered = [
            group(G_SERIES, 'Serien', 1),
            group(G_ANIME, 'Anime', 0),
            group(G_MOVIES, 'Filme', 2),
        ];
        const order = (): string[] =>
            [...list.querySelectorAll('a')].map((link) => link.textContent?.trim() ?? '');
        await fireEvent(
            list,
            new CustomEvent('consider', {
                detail: {
                    items: reordered,
                    info: { source: 'pointer', trigger: 'droppedIntoZone' },
                },
            }),
        );
        await fireEvent(
            list,
            new CustomEvent('finalize', {
                detail: {
                    items: reordered,
                    info: { source: 'pointer', trigger: 'droppedIntoZone' },
                },
            }),
        );
        expect(order()).toEqual(['Anime', 'Serien', 'Filme']);
        expect(api.updateLibraryGroup).not.toHaveBeenCalled();
        await fireEvent.click(screen.getByRole('button', { name: 'Reorder libraries' }));
        await fireEvent(
            list,
            new CustomEvent('consider', {
                detail: {
                    items: reordered,
                    info: { source: 'pointer', trigger: 'droppedIntoZone' },
                },
            }),
        );
        expect(order()).toEqual(['Serien', 'Anime', 'Filme']);
        expect(api.updateLibraryGroup).not.toHaveBeenCalled();
        await fireEvent(
            list,
            new CustomEvent('finalize', {
                detail: {
                    items: reordered,
                    info: { source: 'pointer', trigger: 'droppedIntoZone' },
                },
            }),
        );
        await waitFor(() => expect(api.updateLibraryGroup).toHaveBeenCalledTimes(2));
        expect(api.updateLibraryGroup).toHaveBeenCalledWith(G_ANIME, { sort_order: 1 });
        expect(api.updateLibraryGroup).toHaveBeenCalledWith(G_SERIES, { sort_order: 0 });
    });

    it('keeps completion and movement disabled until the current save finishes', async () => {
        api.getFileScannerStatus.mockResolvedValue(statusWith([]));
        // Both changed rows need to resolve before another order can be submitted.
        const completions: Array<() => void> = [];
        api.updateLibraryGroup.mockImplementation(
            () =>
                new Promise((resolve) => {
                    completions.push(() => resolve({ data: {}, error: null }));
                }),
        );
        await renderIdle();
        await fireEvent.click(screen.getByRole('button', { name: 'Reorder libraries' }));
        await fireEvent.click(
            within(rowFor('Anime')).getByRole('button', { name: /Move Anime down/ }),
        );
        const saving = screen.getByRole('button', { name: 'Saving…' });
        expect(saving.hasAttribute('disabled')).toBe(true);
        expect(
            within(rowFor('Anime'))
                .getByRole('button', { name: /Move Anime down/ })
                .hasAttribute('disabled'),
        ).toBe(true);
        await fireEvent.click(
            within(rowFor('Anime')).getByRole('button', { name: /Move Anime down/ }),
        );
        expect(api.updateLibraryGroup).toHaveBeenCalledTimes(2);
        completions.forEach((resolve) => resolve());
        await waitFor(() =>
            expect(screen.getByRole('button', { name: 'Done' }).hasAttribute('disabled')).toBe(
                false,
            ),
        );
        expect(screen.getByRole('status').textContent).toContain('Anime moved to position 2 of 3.');
    });

    it('reorders through the real keyboard drag handle', async () => {
        api.getFileScannerStatus.mockResolvedValue(statusWith([]));
        await renderIdle();
        await fireEvent.click(screen.getByRole('button', { name: 'Reorder libraries' }));
        const handle = within(rowFor('Anime')).getByRole('button', {
            name: 'Drag to reorder Anime',
        });
        expect(handle.tabIndex).toBe(0);
        handle.focus();
        await fireEvent.keyDown(handle, { key: ' ' });
        await fireEvent.keyDown(rowFor('Anime'), { key: 'ArrowDown' });
        await waitFor(() =>
            expect(api.updateLibraryGroup).toHaveBeenCalledWith(G_ANIME, { sort_order: 1 }),
        );
        await waitFor(() =>
            expect(screen.getByRole('button', { name: 'Done' }).hasAttribute('disabled')).toBe(
                false,
            ),
        );
        await fireEvent.keyDown(rowFor('Anime'), { key: ' ' });
        expect(
            [...document.querySelectorAll('#library-source-list > li')].map((item) =>
                item.getAttribute('aria-label'),
            ),
        ).toEqual(['Serien', 'Anime', 'Filme']);
    });

    it('keeps keyboard focus on the moved library at a list boundary', async () => {
        api.getFileScannerStatus.mockResolvedValue(statusWith([]));
        await renderIdle();
        await fireEvent.click(screen.getByRole('button', { name: 'Reorder libraries' }));
        const down = within(rowFor('Anime')).getByRole('button', { name: /Move Anime down/ });
        down.focus();
        await fireEvent.click(down);
        await waitFor(() =>
            expect(screen.getByRole('status').textContent).toContain('position 2 of 3'),
        );
        await fireEvent.click(down);
        await waitFor(() =>
            expect(screen.getByRole('status').textContent).toContain('position 3 of 3'),
        );
        await waitFor(() =>
            expect(document.activeElement).toBe(
                within(rowFor('Anime')).getByRole('button', { name: /Move Anime up/ }),
            ),
        );
    });

    it('keyboard move persists sort_order only for the rows that actually moved', async () => {
        api.getFileScannerStatus.mockResolvedValue(statusWith([]));
        await renderIdle();

        await fireEvent.click(screen.getByRole('button', { name: 'Reorder libraries' }));

        // Move Anime (position 0) down past Serien (position 1). Filme
        // (position 2, sortOrder 2) never changes position or index, so it
        // must not be PATCHed.
        await fireEvent.click(
            within(rowFor('Anime')).getByRole('button', { name: /Move Anime down/ }),
        );

        await waitFor(() => expect(api.updateLibraryGroup).toHaveBeenCalled());
        expect(api.updateLibraryGroup).toHaveBeenCalledWith(G_ANIME, { sort_order: 1 });
        expect(api.updateLibraryGroup).toHaveBeenCalledWith(G_SERIES, { sort_order: 0 });
        expect(api.updateLibraryGroup).not.toHaveBeenCalledWith(G_MOVIES, expect.anything());
    });
});

describe('admin library overview — failures and confirmations', () => {
    it('a rejected reorder is reported and the saved order reloaded', async () => {
        api.getFileScannerStatus.mockResolvedValue(statusWith([]));
        api.updateLibraryGroup.mockResolvedValue({ data: null, error: 'HTTP 500' });
        await renderIdle();
        const loadsBefore = api.getLibraryGroups.mock.calls.length;
        await fireEvent.click(screen.getByRole('button', { name: 'Reorder libraries' }));

        await fireEvent.click(
            within(rowFor('Anime')).getByRole('button', { name: /Move Anime down/ }),
        );

        await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('HTTP 500'));
        await waitFor(() =>
            expect(api.getLibraryGroups.mock.calls.length).toBeGreaterThan(loadsBefore),
        );
    });

    it('a failed library list shows a retry, not the create-your-first-library prompt', async () => {
        api.getFileScannerStatus.mockResolvedValue(statusWith([]));
        api.getLibraryGroups.mockResolvedValueOnce({ data: null, error: 'HTTP 503' });
        render(LibrarySourcesPage, { props: { data: {} as PageData } });

        await screen.findByRole('button', { name: 'Retry' });
        expect(screen.queryByRole('button', { name: /create/i })).toBeNull();
    });

    it('"Stop all" asks before cancelling every scan', async () => {
        api.getFileScannerStatus.mockResolvedValue(
            statusWith([{ libraryPathId: P_ANIME, state: 'running', trigger: 'manual' }]),
        );
        await renderIdle();
        const stopAll = await screen.findByRole('button', { name: /Stop all/ });

        await fireEvent.click(stopAll);

        expect(modals.open).toHaveBeenCalledTimes(1);
        expect(api.triggerFileScanner).not.toHaveBeenCalledWith({ action: 'abort' });
        const props = modals.open.mock.calls[0][1] as { onConfirm: () => Promise<void> };
        api.triggerFileScanner.mockResolvedValue({ data: {}, error: 'refused' });
        await props.onConfirm();
        expect(api.triggerFileScanner).toHaveBeenCalledWith({ action: 'abort' });
        // A failed abort is reported, not shown as if it worked.
        expect(toasts.error).toHaveBeenCalledWith('refused');
    });
});

describe('admin library overview — schedule line', () => {
    it('renders nextRunAt relatively together with the interval', async () => {
        api.getFileScannerStatus.mockResolvedValue(statusWith([]));
        client.apiGet.mockImplementation(async (url: string) => {
            if (url === '/api/tasks') {
                return {
                    data: {
                        page: { limit: 1, offset: 0, hasMore: false },
                        items: [
                            {
                                id: 'file-library-scan',
                                name: 'File library scan',
                                effectiveEvery: '1h',
                                nextRunAt: new Date(Date.now() + 12 * 60_000).toISOString(),
                            },
                        ],
                        registrationErrors: [],
                    },
                    error: null,
                };
            }
            return { data: null, error: null, status: 200 };
        });

        await renderIdle();

        expect(screen.getByText(/every 1h/)).toBeTruthy();
        expect(screen.getByText(/next in 12 min/)).toBeTruthy();
    });

    it('omits the interval when the task reports none, but still shows next-in', async () => {
        api.getFileScannerStatus.mockResolvedValue(statusWith([]));
        client.apiGet.mockImplementation(async (url: string) => {
            if (url === '/api/tasks') {
                return {
                    data: {
                        page: { limit: 1, offset: 0, hasMore: false },
                        items: [
                            {
                                id: 'file-library-scan',
                                name: 'File library scan',
                                nextRunAt: new Date(Date.now() + 5 * 60_000).toISOString(),
                            },
                        ],
                        registrationErrors: [],
                    },
                    error: null,
                };
            }
            return { data: null, error: null, status: 200 };
        });

        await renderIdle();

        expect(screen.queryByText(/every/)).toBeNull();
        expect(screen.getByText(/next in 5 min/)).toBeTruthy();
    });
});

describe('admin library overview — layout', () => {
    it('shows totals and health warnings when only file statistics are available', async () => {
        api.getFileScannerStatus.mockResolvedValue(statusWith([]));
        api.getLibraryFileStats.mockResolvedValue({
            data: { totalFiles: 10, withHash: 9, probed: 8, totalSizeBytes: 1000 },
            error: null,
        });
        await renderIdle();
        const panel = await screen.findByRole('region', { name: 'Scan status' });
        expect(within(panel).getByText(/10 files/)).toBeTruthy();
        expect(within(panel).getByText(/1 file not yet hashed/)).toBeTruthy();
        expect(within(panel).getByText(/2 not probed/)).toBeTruthy();
    });

    it('keeps the summary Stop action scoped to its active library', async () => {
        api.triggerFileScanner.mockResolvedValue({ data: {}, error: null });
        await renderPage();
        const panel = screen.getByRole('region', { name: 'Scan status' });
        await fireEvent.click(within(panel).getByRole('button', { name: 'Stop scanning Anime' }));
        await waitFor(() =>
            expect(api.triggerFileScanner).toHaveBeenCalledWith({
                action: 'abort',
                paths: [P_ANIME],
            }),
        );
    });

    it('does not render an empty scan panel or invented statistics when optional data is unavailable', async () => {
        api.getFileScannerStatus.mockResolvedValue(statusWith([]));
        await renderIdle();
        expect(screen.queryByRole('region', { name: 'Scan status' })).toBeNull();
        expect(screen.queryByText(/0 files/)).toBeNull();
    });

    it('offers ONE way to create a library', async () => {
        api.getFileScannerStatus.mockResolvedValue(statusWith([]));
        await renderIdle();

        expect(screen.getByRole('button', { name: /New library/ })).toBeTruthy();
        expect(screen.queryByRole('button', { name: /^Add Path$/ })).toBeNull();
    });
});

it('describes ABS catalog imports instead of claiming it was never scanned', async () => {
    overwriteGetLocale(() => 'de');
    api.getFileScannerStatus.mockResolvedValue(statusWith([]));
    api.getLibraryGroups.mockResolvedValue({
        data: { items: [group(G_ANIME, 'Bücher', 0, { itemCount: 67 })] },
        error: null,
    });
    api.getLibraryPaths.mockResolvedValue({
        data: {
            items: [
                {
                    ...path(P_ANIME, 'abs://books', G_ANIME, 'audiobook'),
                    provider: 'audiobookshelf',
                    providerPath: 'books',
                },
            ],
        },
        error: null,
    });
    render(LibrarySourcesPage, { props: { data: {} as PageData } });
    await screen.findByText('Bücher');
    const row = rowFor('Bücher');
    expect(within(row).getByText('Hörbuch')).toBeTruthy();
    expect(within(row).getByText(/67/)).toBeTruthy();
    expect(within(row).getByText('Katalogabgleich')).toBeTruthy();
    expect(within(row).queryByText('Noch nie gescannt')).toBeNull();
    expect(
        within(row)
            .getByRole('link', { name: 'Synchronisierungsläufe öffnen' })
            .getAttribute('href'),
    ).toBe('/admin/tasks/audiobookshelf-sync');
});
