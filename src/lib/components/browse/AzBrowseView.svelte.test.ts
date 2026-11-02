// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pins the genre/tag -> getAzBrowse() wiring in AzBrowseView, and the
 * reactive refetch the task-6 brief specifically flagged as the most likely
 * bug: a prop change that isn't read inside the fetching $effect would
 * silently never trigger a refetch (e.g. navigating from ?tag=whodunit to
 * ?tag=heist would keep showing the first result set).
 */

import { render, cleanup, screen, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mockGetAzBrowse = vi.fn();
const mockGetLibraries = vi.fn();

vi.mock('$lib/api/browse', () => ({
    getAzBrowse: (...args: unknown[]) => mockGetAzBrowse(...args),
    getLibraries: (...args: unknown[]) => mockGetLibraries(...args),
}));

// AzBrowseView statically imports UniversalMediaCard, which reads
// $env/dynamic/public at module scope. In the real app this is populated by
// a server-injected global (`window.__sveltekit_env`); no such bootstrap runs
// under vitest, so the virtual module throws on import. Nothing under test
// here renders a media card (items stays empty), so an empty stub is enough
// to let the module graph load.
vi.mock('$env/dynamic/public', () => ({ env: {} }));

class MockIntersectionObserver {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
}

import { bumpWatchStateVersion, watchStateVersion } from '$lib/stores/watch-state-version';
import type { UniversalMediaItem } from '$lib/schemas/api-responses';
import AzBrowseView from './AzBrowseView.svelte';

function emptyAzResult() {
    return {
        data: { items: [], page: { limit: 1, offset: 0, total: 0, hasMore: false } },
        error: null,
    };
}

describe('AzBrowseView genre/tag wiring', () => {
    beforeEach(() => {
        vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
        mockGetAzBrowse.mockReset().mockResolvedValue(emptyAzResult());
        mockGetLibraries.mockReset().mockResolvedValue({ data: { libraries: [] }, error: null });
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    test('restores a legacy quality-only include-unknown link and lets the chip clear it', async () => {
        render(AzBrowseView, { resolutions: ['4K'], qualityIncludeUnknown: true });
        await vi.waitFor(() => expect(mockGetAzBrowse).toHaveBeenCalledTimes(1));
        expect(mockGetAzBrowse.mock.calls[0][0]).toMatchObject({ qualityIncludeUnknown: true });
        expect(mockGetAzBrowse.mock.calls[0][0].includeUnknown).toBeUndefined();
        await fireEvent.click(
            screen.getByRole('button', { name: /Remove.*untagged|Remove.*missing/i }),
        );
        expect(mockGetAzBrowse.mock.calls.at(-1)?.[0].qualityIncludeUnknown).toBeUndefined();
    });

    test('passes the tag prop through to getAzBrowse on mount', async () => {
        render(AzBrowseView, { tag: 'whodunit' });

        await vi.waitFor(() => expect(mockGetAzBrowse).toHaveBeenCalled());
        const call = mockGetAzBrowse.mock.calls[0][0] as { tag?: string; genre?: string };
        expect(call.tag).toBe('whodunit');
        expect(call.genre).toBeUndefined();
    });

    test('search narrows the selected library and playback filters instead of going global', async () => {
        // A successful empty library response intentionally clears stale selections.
        mockGetLibraries.mockResolvedValue({
            data: {
                libraries: [{ id: 'kids', name: 'Kids', itemCount: 5, mediaType: 'mixed' }],
                totalLibraries: 1,
            },
            error: null,
        });
        const { rerender } = render(AzBrowseView, {
            selectedGroupId: 'kids',
            genre: 'Action',
            resolutions: ['4K'],
            audioLangs: ['en'],
            query: '',
        });
        await vi.waitFor(() => expect(mockGetAzBrowse).toHaveBeenCalledTimes(1));
        await rerender({ query: 'star' });
        await vi.waitFor(() =>
            expect(mockGetAzBrowse).toHaveBeenLastCalledWith(
                expect.objectContaining({
                    q: 'star',
                    libraryGroupId: 'kids',
                    genre: 'Action',
                    res: ['4K'],
                    audio: ['en'],
                    offset: 0,
                    signal: expect.any(AbortSignal),
                }),
            ),
        );
    });

    test('invalidates a pending response immediately when the title changes', async () => {
        let finish: (result: ReturnType<typeof emptyAzResult>) => void = () => {};
        mockGetAzBrowse.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const { rerender } = render(AzBrowseView, { query: 'old' });
        await vi.waitFor(() => expect(mockGetAzBrowse).toHaveBeenCalledTimes(1));
        const signal = mockGetAzBrowse.mock.calls[0][0].signal as AbortSignal;
        await rerender({ query: 'new' });
        expect(signal.aborted).toBe(true);
        finish(emptyAzResult());
        await tick();
        expect(screen.queryByText('No titles match this combination.')).toBeNull();
        await vi.waitFor(() =>
            expect(mockGetAzBrowse).toHaveBeenLastCalledWith(expect.objectContaining({ q: 'new' })),
        );
    });

    test('offers retry on failure, keeping the exact filter scope', async () => {
        mockGetAzBrowse.mockResolvedValueOnce({ data: null, error: { message: 'offline' } });
        render(AzBrowseView, { query: 'star', tag: 'space opera', resolutions: ['4K'] });
        const retry = await screen.findByRole('button', { name: /Retry/i });
        expect(screen.queryByText('No titles match this combination.')).toBeNull();
        await fireEvent.click(retry);
        expect(mockGetAzBrowse).toHaveBeenLastCalledWith(
            expect.objectContaining({ q: 'star', tag: 'space opera', res: ['4K'], offset: 0 }),
        );
    });

    test('clears a playback filter from its visible chip', async () => {
        const onFilterChange = vi.fn();
        render(AzBrowseView, { resolutions: ['4K'], onFilterChange });
        await vi.waitFor(() => expect(mockGetAzBrowse).toHaveBeenCalled());
        await fireEvent.click(screen.getByRole('button', { name: 'Remove 4K' }));
        expect(onFilterChange).toHaveBeenLastCalledWith(
            expect.objectContaining({ resolutions: [] }),
        );
        expect(mockGetAzBrowse.mock.calls.at(-1)?.[0].res).toBeUndefined();
    });

    test('passes the genre prop through to getAzBrowse on mount', async () => {
        render(AzBrowseView, { genre: 'Action' });

        await vi.waitFor(() => expect(mockGetAzBrowse).toHaveBeenCalled());
        const call = mockGetAzBrowse.mock.calls[0][0] as { genre?: string };
        expect(call.genre).toBe('Action');
    });

    test('omits tag and genre from the getAzBrowse call when neither prop is set', async () => {
        render(AzBrowseView, {});

        await vi.waitFor(() => expect(mockGetAzBrowse).toHaveBeenCalled());
        const call = mockGetAzBrowse.mock.calls[0][0] as Record<string, unknown>;
        expect(call).not.toHaveProperty('tag');
        expect(call).not.toHaveProperty('genre');
    });

    test('changing the tag prop triggers a refetch with the new tag', async () => {
        const { rerender } = render(AzBrowseView, { tag: 'whodunit' });

        await vi.waitFor(() => expect(mockGetAzBrowse).toHaveBeenCalledTimes(1));
        expect(mockGetAzBrowse.mock.calls[0][0]).toMatchObject({ tag: 'whodunit' });

        await rerender({ tag: 'heist' });

        await vi.waitFor(() => expect(mockGetAzBrowse.mock.calls.length).toBeGreaterThan(1));
        const lastCall = mockGetAzBrowse.mock.calls.at(-1)?.[0] as { tag?: string };
        expect(lastCall.tag).toBe('heist');
    });

    test('changing the genre prop triggers a refetch with the new genre', async () => {
        const { rerender } = render(AzBrowseView, { genre: 'Action' });

        await vi.waitFor(() => expect(mockGetAzBrowse).toHaveBeenCalledTimes(1));

        await rerender({ genre: 'Comedy' });

        await vi.waitFor(() => expect(mockGetAzBrowse.mock.calls.length).toBeGreaterThan(1));
        const lastCall = mockGetAzBrowse.mock.calls.at(-1)?.[0] as { genre?: string };
        expect(lastCall.genre).toBe('Comedy');
    });

    describe('library row', () => {
        function libs(list: Array<{ id: string; name: string; mediaType: string }>) {
            mockGetLibraries.mockResolvedValue({
                data: { libraries: list.map((l) => ({ ...l, itemCount: 5 })) },
                error: null,
            });
        }
        const allLibrariesButton = () => screen.queryByRole('button', { name: /All Libraries/ });

        test('is hidden when each library is just one of the media tabs', async () => {
            libs([
                { id: 'm', name: 'Movies', mediaType: 'movie' },
                { id: 's', name: 'Series', mediaType: 'series' },
            ]);
            render(AzBrowseView, {});
            // Wait until the list has actually rendered (loading text gone), so
            // "hidden" is not just "not loaded yet".
            await vi.waitFor(() => expect(screen.queryByText(/Loading libraries/i)).toBeNull());
            await vi.waitFor(() => expect(mockGetLibraries).toHaveBeenCalled());
            await tick();
            expect(allLibrariesButton()).toBeNull();
            expect(screen.queryByText(/No libraries/i)).toBeNull();
        });

        test('stays when two libraries share a media type', async () => {
            libs([
                { id: 'm', name: 'Movies', mediaType: 'movie' },
                { id: 'k', name: 'Kids Movies', mediaType: 'movie' },
            ]);
            render(AzBrowseView, {});
            await vi.waitFor(() => expect(allLibrariesButton()).not.toBeNull());
            expect(screen.getByRole('button', { name: /Kids Movies/ })).toBeTruthy();
        });

        test('stays for a mixed library', async () => {
            libs([{ id: 'x', name: 'Everything', mediaType: 'mixed' }]);
            render(AzBrowseView, {});
            await vi.waitFor(() => expect(allLibrariesButton()).not.toBeNull());
        });

        test('stays while a library is selected, so it can be cleared', async () => {
            libs([
                { id: 'm', name: 'Movies', mediaType: 'movie' },
                { id: 's', name: 'Series', mediaType: 'series' },
            ]);
            render(AzBrowseView, { selectedGroupId: 'm' });
            await vi.waitFor(() => expect(allLibrariesButton()).not.toBeNull());
        });
    });
});

function seriesItem(id: string, unwatched = 2): UniversalMediaItem {
    return {
        id,
        mediaType: 'series',
        title: `Series ${id}`,
        image: '/poster.png',
        externalIds: {},
        isAvailable: true,
        canRequest: false,
        episodeCount: 10,
        availableEpisodeCount: 2,
        watchedEpisodeCount: 2 - unwatched,
        unwatchedEpisodeCount: unwatched,
    };
}
function pageResult(id: string, unwatched: number, offset = 0, hasMore = false) {
    return {
        data: {
            items: [seriesItem(id, unwatched)],
            page: { limit: 1, offset, total: 2, hasMore },
        },
        error: null,
    };
}
function deferredPage() {
    let resolve!: (value: ReturnType<typeof pageResult>) => void;
    const promise = new Promise<ReturnType<typeof pageResult>>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}
describe('A–Z mounted watch count refresh', () => {
    beforeEach(() => {
        vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
        window.matchMedia = vi.fn().mockReturnValue({
            matches: false,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        });
        watchStateVersion.set(0);
        mockGetAzBrowse.mockReset();
        mockGetLibraries.mockReset().mockResolvedValue({ data: { libraries: [] }, error: null });
    });
    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });
    test('refreshes two loaded pages without replacing their identity, order, or pagination', async () => {
        mockGetAzBrowse
            .mockResolvedValueOnce(pageResult('a', 2, 0, true))
            .mockResolvedValueOnce(pageResult('b', 2, 1));
        const { component, container } = render(AzBrowseView, { pageSize: 1, restoreCount: 2 });
        await vi.waitFor(() => expect(component.getLoadedCount()).toBe(2));
        const titles = [...container.querySelectorAll('h3')];
        mockGetAzBrowse.mockImplementation(({ offset }: { offset: number }) =>
            Promise.resolve(pageResult(offset === 0 ? 'a' : 'b', 0, offset)),
        );
        bumpWatchStateVersion();
        await vi.waitFor(() =>
            expect(
                container.querySelectorAll('[aria-label="All available episodes watched"]'),
            ).toHaveLength(2),
        );
        expect(component.getLoadedCount()).toBe(2);
        expect([...container.querySelectorAll('h3')]).toEqual(titles);
        expect(mockGetAzBrowse.mock.calls.slice(-2).map(([args]) => args.offset)).toEqual([0, 1]);
    });
    test('queues mutation bursts during an initial empty load and refreshes after it lands', async () => {
        const initial = deferredPage();
        mockGetAzBrowse.mockReturnValueOnce(initial.promise).mockResolvedValue(pageResult('a', 0));
        const { container } = render(AzBrowseView, { pageSize: 1 });
        await vi.waitFor(() => expect(mockGetAzBrowse).toHaveBeenCalledTimes(1));
        bumpWatchStateVersion();
        bumpWatchStateVersion();
        bumpWatchStateVersion();
        expect(mockGetAzBrowse).toHaveBeenCalledTimes(1);
        initial.resolve(pageResult('a', 2));
        await vi.waitFor(() =>
            expect(
                container.querySelector('[aria-label="All available episodes watched"]'),
            ).toBeTruthy(),
        );
        expect(mockGetAzBrowse).toHaveBeenCalledTimes(2);
    });
    test('waits for pagination before refreshing every loaded page', async () => {
        const pagination = deferredPage();
        mockGetAzBrowse
            .mockResolvedValueOnce(pageResult('a', 2, 0, true))
            .mockReturnValueOnce(pagination.promise);
        const { component, container } = render(AzBrowseView, { pageSize: 1 });
        await vi.waitFor(() => expect(component.getLoadedCount()).toBe(1));
        const loading = component.loadItems();
        await vi.waitFor(() => expect(mockGetAzBrowse).toHaveBeenCalledTimes(2));
        bumpWatchStateVersion();
        mockGetAzBrowse.mockImplementation(({ offset }: { offset: number }) =>
            Promise.resolve(pageResult(offset === 0 ? 'a' : 'b', 0, offset)),
        );
        pagination.resolve(pageResult('b', 2, 1));
        await loading;
        await vi.waitFor(() =>
            expect(
                container.querySelectorAll('[aria-label="All available episodes watched"]'),
            ).toHaveLength(2),
        );
        expect(mockGetAzBrowse.mock.calls.slice(-2).map(([args]) => args.offset)).toEqual([0, 1]);
    });
    test('rejects an old scope refresh after switching the visible filter', async () => {
        const oldRefresh = deferredPage();
        mockGetAzBrowse
            .mockResolvedValueOnce(pageResult('old', 2))
            .mockReturnValueOnce(oldRefresh.promise);
        const { container, rerender } = render(AzBrowseView, { pageSize: 1, genre: 'Old' });
        await vi.waitFor(() => expect(screen.getByText('Series old')).toBeTruthy());
        bumpWatchStateVersion();
        await vi.waitFor(() => expect(mockGetAzBrowse).toHaveBeenCalledTimes(2));
        mockGetAzBrowse.mockResolvedValue(pageResult('new', 1));
        await rerender({ genre: 'New' });
        await vi.waitFor(() => expect(screen.getByText('Series new')).toBeTruthy());
        oldRefresh.resolve(pageResult('old', 0));
        await tick();
        await vi.waitFor(() => expect(mockGetAzBrowse.mock.calls.at(-1)?.[0].genre).toBe('New'));
        expect(screen.queryByText('Series old')).toBeNull();
        expect(container.querySelector('[aria-label="All available episodes watched"]')).toBeNull();
        expect(container.querySelector('[aria-label="1 unwatched episode"]')).toBeTruthy();
    });
    test('retries a refresh overtaken by pagination rather than leaving the appended page stale', async () => {
        const refresh = deferredPage();
        mockGetAzBrowse
            .mockResolvedValueOnce(pageResult('a', 2, 0, true))
            .mockReturnValueOnce(refresh.promise)
            .mockResolvedValueOnce(pageResult('b', 2, 1));
        const { component, container } = render(AzBrowseView, { pageSize: 1 });
        await vi.waitFor(() => expect(component.getLoadedCount()).toBe(1));
        bumpWatchStateVersion();
        await vi.waitFor(() => expect(mockGetAzBrowse).toHaveBeenCalledTimes(2));
        await component.loadItems();
        expect(component.getLoadedCount()).toBe(2);
        mockGetAzBrowse.mockImplementation(({ offset }: { offset: number }) =>
            Promise.resolve(pageResult(offset === 0 ? 'a' : 'b', 0, offset)),
        );
        refresh.resolve(pageResult('a', 0));
        await vi.waitFor(() =>
            expect(
                container.querySelectorAll('[aria-label="All available episodes watched"]'),
            ).toHaveLength(2),
        );
        expect(mockGetAzBrowse.mock.calls.slice(-2).map(([args]) => args.offset)).toEqual([0, 1]);
    });
    test('retains the loaded page but clears stale badges when the refresh fails', async () => {
        mockGetAzBrowse
            .mockResolvedValueOnce(pageResult('a', 2))
            .mockResolvedValue({ data: null, error: { message: 'offline' } });
        const { component, container } = render(AzBrowseView, { pageSize: 1 });
        await vi.waitFor(() => expect(component.getLoadedCount()).toBe(1));
        expect(container.querySelector('[aria-label="2 unwatched episodes"]')).toBeTruthy();
        bumpWatchStateVersion();
        await vi.waitFor(() =>
            expect(container.querySelector('[aria-label="2 unwatched episodes"]')).toBeNull(),
        );
        expect(component.getLoadedCount()).toBe(1);
        expect(screen.getByText('Series a')).toBeTruthy();
    });
});
