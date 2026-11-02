// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * BrowseFilterSearch: the expanding tag/genre typeahead for /browse. Pins the
 * behaviours the task-7 brief calls out as the likeliest bug sources — the
 * out-of-order request guard (a slow early keystroke's response landing after
 * a faster later one must not clobber it) and the raw-vs-title-cased value
 * sent back through `onselect` (the URL must carry the raw keyword, not the
 * display string).
 */

import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mockApiGet = vi.fn();

vi.mock('$lib/api/client', () => ({
    apiGet: (...args: unknown[]) => mockApiGet(...args),
}));

import BrowseFilterSearch from './BrowseFilterSearch.svelte';

interface ApiCallOptions {
    params?: Record<string, unknown>;
}

function tagsOk(tags: { keyword: string; count: number }[]) {
    return Promise.resolve({ data: { tags }, error: null, status: 200 });
}

function genresOk(genres: { name: string; count: number }[]) {
    return Promise.resolve({ data: { genres }, error: null, status: 200 });
}

function apiError(message: string) {
    return Promise.resolve({ data: null, error: message, status: 500 });
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

const DEBOUNCE_MS = 250;
const SETTLE_MS = DEBOUNCE_MS + 150;

function wait(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
}

function getTriggerButton() {
    return screen.getByRole('button', { name: 'Search tags and genres' });
}

function getComboboxInput() {
    return screen.getByRole('combobox') as HTMLInputElement;
}

describe('BrowseFilterSearch', () => {
    beforeEach(() => {
        mockApiGet.mockReset();
        // Default: empty genres so tests that only care about tags don't have
        // to stub both endpoints every time.
        mockApiGet.mockImplementation((endpoint: string) => {
            if (endpoint === '/api/browse/genres') return genresOk([]);
            return tagsOk([]);
        });
    });

    afterEach(() => {
        cleanup();
    });

    test('refreshes an open picker when the media tab changes without typing again', async () => {
        mockApiGet.mockImplementation(
            (endpoint: string, _schema: unknown, options: ApiCallOptions) => {
                if (endpoint === '/api/browse/genres') return genresOk([]);
                return tagsOk([
                    {
                        keyword: options.params?.type === 'series' ? 'space opera' : 'space travel',
                        count: 2,
                    },
                ]);
            },
        );
        const { rerender } = render(BrowseFilterSearch, { mediaType: 'movies', onselect: vi.fn() });
        await fireEvent.click(getTriggerButton());
        await fireEvent.input(getComboboxInput(), { target: { value: 'space' } });
        await wait(SETTLE_MS);
        expect(screen.getByRole('option').textContent).toContain('Space Travel');
        await rerender({ mediaType: 'series' });
        expect(screen.queryByRole('option')).toBeNull();
        await wait(SETTLE_MS);
        expect(screen.getByRole('option').textContent).toContain('Space Opera');
    });

    test('renders a collapsed icon button with an accessible label', () => {
        render(BrowseFilterSearch, { mediaType: 'all', onselect: vi.fn() });

        const button = getTriggerButton();
        expect(button).toBeTruthy();
        expect(button.getAttribute('aria-expanded')).toBe('false');
        expect(screen.queryByRole('combobox')).toBeNull();
    });

    test('clicking the trigger expands and focuses the input', async () => {
        render(BrowseFilterSearch, { mediaType: 'all', onselect: vi.fn() });

        await fireEvent.click(getTriggerButton());

        const input = getComboboxInput();
        expect(input).toBeTruthy();
        expect(document.activeElement).toBe(input);
    });

    test('typing >=2 chars debounces then queries /browse/tags?q=, merging tag and genre results', async () => {
        mockApiGet.mockImplementation(
            (endpoint: string, _schema: unknown, opts?: ApiCallOptions) => {
                if (endpoint === '/api/browse/genres') {
                    return genresOk([
                        { name: 'Action', count: 5 },
                        { name: 'Comedy', count: 2 },
                    ]);
                }
                expect(opts?.params?.q).toBe('ac');
                return tagsOk([{ keyword: 'action packed', count: 10 }]);
            },
        );

        render(BrowseFilterSearch, { mediaType: 'all', onselect: vi.fn() });
        await fireEvent.click(getTriggerButton());
        const input = getComboboxInput();

        // A single character must not trigger a query at all.
        await fireEvent.input(input, { target: { value: 'a' } });
        await wait(SETTLE_MS);
        expect(mockApiGet).not.toHaveBeenCalled();

        await fireEvent.input(input, { target: { value: 'ac' } });
        await vi.waitFor(
            () => {
                expect(mockApiGet).toHaveBeenCalledWith(
                    '/api/browse/tags',
                    expect.anything(),
                    expect.objectContaining({ params: expect.objectContaining({ q: 'ac' }) }),
                );
            },
            { timeout: 2000 },
        );

        // Merged list: the tag (title-cased for display) and the genre that
        // matches the 'ac' prefix — Comedy must be filtered out client-side.
        await vi.waitFor(() => expect(screen.getByText('Action Packed')).toBeTruthy());
        const options = screen.getAllByRole('option');
        expect(options).toHaveLength(2);
        expect(screen.getByText('Action Packed')).toBeTruthy();
        expect(screen.getByText('Action')).toBeTruthy();
        expect(screen.queryByText('Comedy')).toBeNull();
    });

    test('Escape collapses the widget and clears the query', async () => {
        mockApiGet.mockImplementation((endpoint: string) => {
            if (endpoint === '/api/browse/genres') return genresOk([]);
            return tagsOk([{ keyword: 'heist', count: 4 }]);
        });

        render(BrowseFilterSearch, { mediaType: 'all', onselect: vi.fn() });
        await fireEvent.click(getTriggerButton());
        const input = getComboboxInput();
        await fireEvent.input(input, { target: { value: 'heist' } });
        await vi.waitFor(() => expect(screen.getByText('Heist')).toBeTruthy());

        await fireEvent.keyDown(input, { key: 'Escape' });

        expect(screen.queryByRole('combobox')).toBeNull();
        expect(getTriggerButton()).toBeTruthy();

        // Re-expanding must show a cleared input, not the previous query.
        await fireEvent.click(getTriggerButton());
        expect(getComboboxInput().value).toBe('');
        expect(screen.queryByText('Heist')).toBeNull();
    });

    test('selecting an option fires onselect with the raw value, not the title-cased label', async () => {
        mockApiGet.mockImplementation((endpoint: string) => {
            if (endpoint === '/api/browse/genres') return genresOk([]);
            return tagsOk([{ keyword: 'time travel', count: 7 }]);
        });

        const onselect = vi.fn();
        render(BrowseFilterSearch, { mediaType: 'all', onselect });
        await fireEvent.click(getTriggerButton());
        const input = getComboboxInput();
        await fireEvent.input(input, { target: { value: 'time' } });
        await vi.waitFor(() => expect(screen.getByText('Time Travel')).toBeTruthy());

        await fireEvent.click(screen.getByText('Time Travel'));

        expect(onselect).toHaveBeenCalledTimes(1);
        expect(onselect).toHaveBeenCalledWith({
            kind: 'tag',
            value: 'time travel',
            label: 'Time Travel',
        });

        // Selecting collapses the widget back down.
        expect(screen.queryByRole('combobox')).toBeNull();
    });

    test('a failed fetch shows an error message and keeps the input open', async () => {
        mockApiGet.mockImplementation((endpoint: string) => {
            if (endpoint === '/api/browse/genres') return genresOk([]);
            return apiError('Network error');
        });

        render(BrowseFilterSearch, { mediaType: 'all', onselect: vi.fn() });
        await fireEvent.click(getTriggerButton());
        const input = getComboboxInput();
        await fireEvent.input(input, { target: { value: 'wh' } });

        await vi.waitFor(() =>
            expect(screen.getByText("Couldn't load results — try again")).toBeTruthy(),
        );
        expect(screen.getByRole('combobox')).toBeTruthy();
        expect(screen.queryAllByRole('option')).toHaveLength(0);
    });

    test('fetches genres once per expand, not once per keystroke', async () => {
        mockApiGet.mockImplementation((endpoint: string) => {
            if (endpoint === '/api/browse/genres') return genresOk([{ name: 'Action', count: 5 }]);
            return tagsOk([{ keyword: 'heist', count: 4 }]);
        });

        render(BrowseFilterSearch, { mediaType: 'all', onselect: vi.fn() });
        await fireEvent.click(getTriggerButton());
        const input = getComboboxInput();

        const genreCalls = () =>
            mockApiGet.mock.calls.filter((c) => c[0] === '/api/browse/genres').length;
        const tagCalls = () =>
            mockApiGet.mock.calls.filter((c) => c[0] === '/api/browse/tags').length;

        await fireEvent.input(input, { target: { value: 'he' } });
        await vi.waitFor(() => expect(tagCalls()).toBe(1));
        await vi.waitFor(() => expect(genreCalls()).toBe(1));

        await fireEvent.input(input, { target: { value: 'hei' } });
        await vi.waitFor(() => expect(tagCalls()).toBe(2));
        await fireEvent.input(input, { target: { value: 'heis' } });
        await vi.waitFor(() => expect(tagCalls()).toBe(3));
        await wait(SETTLE_MS);

        // The tags endpoint is per-keystroke; /browse/genres is a full facet
        // aggregation with a byte-identical payload, so it must stay at one.
        expect(tagCalls()).toBe(3);
        expect(genreCalls()).toBe(1);

        // ...and the cached genres are still filtered in memory, so the merged
        // list is unchanged by the caching.
        await fireEvent.input(input, { target: { value: 'ac' } });
        await vi.waitFor(() => expect(screen.getByText('Action')).toBeTruthy());
        expect(genreCalls()).toBe(1);
    });

    test('re-expanding refetches genres so a stale catalog is not reused', async () => {
        mockApiGet.mockImplementation((endpoint: string) => {
            if (endpoint === '/api/browse/genres') return genresOk([{ name: 'Action', count: 5 }]);
            return tagsOk([{ keyword: 'heist', count: 4 }]);
        });

        render(BrowseFilterSearch, { mediaType: 'all', onselect: vi.fn() });
        const genreCalls = () =>
            mockApiGet.mock.calls.filter((c) => c[0] === '/api/browse/genres').length;

        await fireEvent.click(getTriggerButton());
        await fireEvent.input(getComboboxInput(), { target: { value: 'he' } });
        await vi.waitFor(() => expect(genreCalls()).toBe(1));

        await fireEvent.keyDown(getComboboxInput(), { key: 'Escape' });
        await fireEvent.click(getTriggerButton());
        await fireEvent.input(getComboboxInput(), { target: { value: 'he' } });
        await vi.waitFor(() => expect(genreCalls()).toBe(2));
    });

    test('aria-expanded tracks whether the listbox popup is actually rendered', async () => {
        mockApiGet.mockImplementation((endpoint: string) => {
            if (endpoint === '/api/browse/genres') return genresOk([]);
            return tagsOk([{ keyword: 'heist', count: 4 }]);
        });

        render(BrowseFilterSearch, { mediaType: 'all', onselect: vi.fn() });
        await fireEvent.click(getTriggerButton());
        const input = getComboboxInput();

        // Expanded input, no results yet: `.bfs-listbox:empty` is display:none,
        // so there is no popup to announce.
        expect(input.getAttribute('aria-expanded')).toBe('false');

        await fireEvent.input(input, { target: { value: 'he' } });
        await vi.waitFor(() => expect(screen.getByText('Heist')).toBeTruthy());
        expect(getComboboxInput().getAttribute('aria-expanded')).toBe('true');

        // Dropping back below the minimum query length empties the listbox again.
        await fireEvent.input(getComboboxInput(), { target: { value: 'h' } });
        await vi.waitFor(() => expect(screen.queryAllByRole('option')).toHaveLength(0));
        expect(getComboboxInput().getAttribute('aria-expanded')).toBe('false');
    });

    test('a slow earlier response cannot overwrite a faster later one', async () => {
        const firstTags = deferred<{
            data: { tags: { keyword: string; count: number }[] };
            error: null;
        }>();
        const secondTags = deferred<{
            data: { tags: { keyword: string; count: number }[] };
            error: null;
        }>();
        let tagsCallCount = 0;

        mockApiGet.mockImplementation((endpoint: string) => {
            if (endpoint === '/api/browse/genres') return genresOk([]);
            tagsCallCount += 1;
            return tagsCallCount === 1 ? firstTags.promise : secondTags.promise;
        });

        render(BrowseFilterSearch, { mediaType: 'all', onselect: vi.fn() });
        await fireEvent.click(getTriggerButton());
        const input = getComboboxInput();

        // First keystroke's debounce fires, kicking off a slow request.
        await fireEvent.input(input, { target: { value: 'wh' } });
        await wait(SETTLE_MS);
        await vi.waitFor(() => expect(tagsCallCount).toBe(1));

        // Second keystroke's debounce fires before the first request settles.
        await fireEvent.input(input, { target: { value: 'whx' } });
        await wait(SETTLE_MS);
        await vi.waitFor(() => expect(tagsCallCount).toBe(2));

        // The faster, later response resolves first.
        secondTags.resolve({ data: { tags: [{ keyword: 'whodunit x', count: 3 }] }, error: null });
        await vi.waitFor(() => expect(screen.getByText('Whodunit X')).toBeTruthy());

        // The slower, stale response resolves after — it must be discarded.
        firstTags.resolve({ data: { tags: [{ keyword: 'stale wh', count: 9 }] }, error: null });
        await wait(50);

        expect(screen.getByText('Whodunit X')).toBeTruthy();
        expect(screen.queryByText('Stale Wh')).toBeNull();
        expect(screen.getAllByRole('option')).toHaveLength(1);
    });
});
