// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writable, get } from 'svelte/store';
import type { ComponentProps } from 'svelte';
import Pipeline from './+page.svelte';
const route = writable({
    url: new URL('http://localhost/admin/tasks/pipeline'),
    data: {},
    state: {} as App.PageState,
});
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), replace: vi.fn() }));
vi.mock('$app/stores', () => ({
    page: { subscribe: (fn: Parameters<typeof route.subscribe>[0]) => route.subscribe(fn) },
}));
vi.mock('$app/navigation', () => ({
    pushState: vi.fn(),
    replaceState: (url: URL, state: App.PageState) => {
        mocks.replace(url, state);
        route.update((value) => ({ ...value, state }));
    },
}));
vi.mock('$lib/components/admin/index.js', async () => ({
    AdminPageHeader: (await import('../../library/media/__fixtures__/EmptyComponent.svelte'))
        .default,
}));
vi.mock('$lib/components/admin/coverage/IngestMap.svelte', async () => ({
    default: (await import('../../library/media/__fixtures__/EmptyComponent.svelte')).default,
}));
vi.mock('$lib/components/admin/coverage/CoverageGrid.svelte', async () => ({
    default: (await import('../../library/media/__fixtures__/EmptyComponent.svelte')).default,
}));
vi.mock('$lib/components/admin/HelpPopover.svelte', async () => ({
    default: (await import('../../library/media/__fixtures__/EmptyComponent.svelte')).default,
}));
vi.mock('$lib/components/admin/glossary/TermTooltip.svelte', async () => ({
    default: (await import('../../library/media/__fixtures__/EmptyComponent.svelte')).default,
}));
function navigate(query: string) {
    route.set({
        url: new URL('http://localhost/admin/tasks/pipeline' + query),
        data: {},
        state: {},
    });
}
function mount() {
    return render(Pipeline, { data: { initial: {} } } as ComponentProps<typeof Pipeline>);
}
beforeEach(() => {
    mocks.fetch.mockReset().mockResolvedValue({
        ok: true,
        json: async () => ({
            items: [],
            summary: {
                total: 0,
                completed: 0,
                in_progress: 0,
                failed: 0,
                pending: 0,
                skipped: 0,
                obsolete: 0,
            },
            page: { limit: 50, offset: 0, hasMore: false },
        }),
    });
    mocks.replace.mockClear();
    vi.stubGlobal('fetch', mocks.fetch);
    navigate('');
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});
it('loads completion lazily and persists the media type and incomplete filters', async () => {
    mount();
    expect(mocks.fetch).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole('tab', { name: /completion/i }));
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
    await fireEvent.change(screen.getByRole('combobox'), { target: { value: 'movie' } });
    await waitFor(() =>
        expect(mocks.fetch).toHaveBeenLastCalledWith(expect.stringContaining('mediaType=movie')),
    );
    await fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() =>
        expect(mocks.fetch).toHaveBeenLastCalledWith(expect.stringContaining('incompleteOnly=1')),
    );
    expect(get(route).state.adminWorkspaceUrl).toContain('mediaType=movie');
    expect(get(route).state.adminWorkspaceUrl).toContain('incompleteOnly=1');
});
it('restores filters and fetches the right data on same-route navigation', async () => {
    navigate('?view=completion&mediaType=movie');
    mount();
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
    navigate('?view=completion&mediaType=track&incompleteOnly=1');
    await waitFor(() =>
        expect(mocks.fetch).toHaveBeenLastCalledWith(expect.stringContaining('mediaType=track')),
    );
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('track');
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
    expect(mocks.replace).not.toHaveBeenCalled();
});

it('offers an explicit retry after the coverage service fails', async () => {
    mocks.fetch.mockResolvedValueOnce({ ok: false, status: 503 });
    navigate('?view=completion');
    mount();
    await fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull());
});

it('keeps Completion lazy on Flow and reuses its loaded data when switching back', async () => {
    mount();
    expect(mocks.fetch).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole('tab', { name: /completion/i }));
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
    await screen.findByText('0 complete');
    await fireEvent.click(screen.getByRole('tab', { name: /flow/i }));
    expect(screen.getByRole('tab', { name: /flow/i }).getAttribute('aria-selected')).toBe('true');
    await fireEvent.click(screen.getByRole('tab', { name: /completion/i }));
    expect(screen.getByRole('tab', { name: /completion/i }).getAttribute('aria-selected')).toBe(
        'true',
    );
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
});
