// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * Fix matches page — the `?library=` scope. The select + clear write the param
 * onto the VISIBLE url (keeping ?view=, which <Tabs> writes shallowly, and
 * dropping ?offset=), and the Never-matched panel fetches within the scope.
 *
 * Library names say nothing about content ("Evening" is not an evening-anything
 * library): nothing may be inferred from them.
 */

import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readable } from 'svelte/store';

const pageState = vi.hoisted(() => ({
    url: new URL('http://localhost/admin/library/fix-matches'),
    state: {},
    data: {},
}));
vi.mock('$env/dynamic/public', () => ({ env: {} }));
vi.mock('$app/state', () => ({ page: pageState }));
vi.mock('$app/stores', () => ({
    page: readable(pageState),
    navigating: readable(null),
}));
const goto = vi.hoisted(() => vi.fn());
vi.mock('$app/navigation', () => ({
    invalidateAll: vi.fn(),
    goto,
    replaceState: vi.fn(),
}));
vi.mock('$app/paths', () => ({ base: '', resolve: (p: string) => p }));
vi.mock('$lib/stores/toast.store', () => ({
    toasts: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const api = vi.hoisted(() => ({
    listUnmatchedFiles: vi.fn(),
}));
vi.mock('$lib/api/admin', async (importOriginal) => {
    const original = await importOriginal<Record<string, unknown>>();
    return { ...original, ...api };
});

import FixMatchesPage from './+page.svelte';
import type { PageData } from './$types';

const EVENING = '0f1e2d3c-4b5a-4968-8776-655443322110';
const HARBOR = '1a2b3c4d-5e6f-4a0b-9c1d-2e3f4a5b6c7d';

function pageData(libraryGroupId: string | null): PageData {
    return {
        brokenMatch: {
            items: [],
            total: 0,
            search: '',
            mediaType: undefined,
            offset: 0,
            pageSize: 48,
            dbError: null,
        },
        neverMatchedTotal: 0,
        libraries: [
            { id: EVENING, name: 'Evening' },
            { id: HARBOR, name: 'Harbor' },
        ],
        libraryGroupId,
    } as unknown as PageData;
}

function setUrl(search: string): void {
    const path = `/admin/library/fix-matches${search}`;
    // The page reads the VISIBLE url (window.location) — keep it and the mocked
    // `page.url` in step. Same origin as the happy-dom document.
    window.history.replaceState({}, '', path);
    pageState.url = new URL(window.location.href);
}

function lastGotoUrl(): URL {
    const [url] = goto.mock.calls.at(-1) ?? [];
    return new URL(String(url));
}

beforeEach(() => {
    vi.clearAllMocks();
    api.listUnmatchedFiles.mockResolvedValue({
        data: { items: [], page: { total: 0 } },
        error: null,
    });
});

afterEach(() => cleanup());

describe('fix matches page — library scope', () => {
    it('shows the scoped library and fetches Never matched within it', async () => {
        setUrl(`?library=${EVENING}`);
        render(FixMatchesPage, { props: { data: pageData(EVENING) } });

        const select = screen.getByRole('combobox') as HTMLSelectElement;
        expect(select.value).toBe(EVENING);
        expect([...select.options].map((o) => o.textContent)).toEqual([
            'All libraries',
            'Evening',
            'Harbor',
        ]);
        await waitFor(() =>
            expect(api.listUnmatchedFiles).toHaveBeenCalledWith(
                expect.objectContaining({ libraryGroupId: EVENING }),
            ),
        );
    });

    it('switching library keeps the view and drops the page offset', async () => {
        setUrl(`?view=broken&library=${EVENING}&offset=48&q=x`);
        render(FixMatchesPage, { props: { data: pageData(EVENING) } });

        await fireEvent.change(screen.getByRole('combobox'), { target: { value: HARBOR } });

        const url = lastGotoUrl();
        expect(url.pathname).toBe('/admin/library/fix-matches');
        expect(url.searchParams.get('library')).toBe(HARBOR);
        expect(url.searchParams.get('view')).toBe('broken');
        expect(url.searchParams.get('q')).toBe('x');
        expect(url.searchParams.has('offset')).toBe(false);
    });

    it('clear removes the library and nothing else', async () => {
        setUrl(`?view=broken&library=${EVENING}`);
        render(FixMatchesPage, { props: { data: pageData(EVENING) } });

        await fireEvent.click(screen.getByRole('button', { name: 'Clear library filter' }));

        const url = lastGotoUrl();
        expect(url.searchParams.has('library')).toBe(false);
        expect(url.searchParams.get('view')).toBe('broken');
    });

    it('offers no clear button while unscoped, and Never matched fetches unscoped', async () => {
        setUrl('');
        render(FixMatchesPage, { props: { data: pageData(null) } });

        expect(screen.queryByRole('button', { name: 'Clear library filter' })).toBeNull();
        expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('');
        await waitFor(() =>
            expect(api.listUnmatchedFiles).toHaveBeenCalledWith(
                expect.objectContaining({ libraryGroupId: undefined }),
            ),
        );
    });

    it('re-fetches Never matched when the scope changes under a mounted panel', async () => {
        setUrl('');
        const { rerender } = render(FixMatchesPage, { props: { data: pageData(null) } });
        await waitFor(() => expect(api.listUnmatchedFiles).toHaveBeenCalledTimes(1));

        setUrl(`?library=${HARBOR}`);
        await rerender({ data: pageData(HARBOR) });

        await waitFor(() =>
            expect(api.listUnmatchedFiles).toHaveBeenLastCalledWith(
                expect.objectContaining({ libraryGroupId: HARBOR, offset: 0 }),
            ),
        );
    });
});
