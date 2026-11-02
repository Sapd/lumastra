// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import { readable } from 'svelte/store';
import type { PageData } from './$types';
import Page from './+page.svelte';
import { apiGet } from '$lib/api/client';
import { goto } from '$app/navigation';

vi.mock('$app/stores', () => ({
    page: readable({
        url: new URL(
            'http://localhost/audiobooks?libraryGroupId=shelf&lang=de&authorId=Writer&narratorId=Reader',
        ),
    }),
}));
vi.mock('$app/navigation', () => ({
    goto: vi.fn(),
    invalidateAll: vi.fn(),
    beforeNavigate: vi.fn(),
}));
vi.mock('$lib/api/client', () => ({ apiGet: vi.fn() }));
vi.mock('$lib/utils/modal-utils', () => ({ openMediaModal: vi.fn() }));
vi.mock('$lib/services/audiobook-playback', () => ({
    playAudiobook: vi.fn(),
    audiobookStartFailureMessage: vi.fn(),
}));
vi.mock('$lib/components/ui/UniversalMediaCard.svelte', async () => ({
    default: (await import('./test-fixtures/AudiobookCard.svelte')).default,
}));
vi.mock('$lib/components/audiobook/AudiobookActivityRail.svelte', async () => ({
    default: (await import('./test-fixtures/AudiobookCard.svelte')).default,
}));
vi.mock('$lib/paraglide/messages.js', async (original) => ({
    ...(await original<object>()),
    viewer_audiobooks_scope: () => 'Search this library view — all selected filters apply.',
    viewer_audiobooks_remove_filter: ({ name }: { name: string }) => `Remove filter: ${name}`,
    viewer_audiobooks_reading_order: () => 'Series shown in reading order.',
    viewer_audiobooks_load_error: () => 'Could not load audiobooks',
    viewer_audiobooks_resume_scope: () => 'Your listening across all shelves.',
    viewer_audiobooks_library: () => 'Your library',
}));

function book(title: string, id = title) {
    return {
        id,
        catalogId: id,
        title,
        type: 'audiobook' as const,
        ids: {},
        images: {},
        audiobook: {
            authors: [],
            narrators: [],
            series: null as {
                id: string;
                name: string;
                position: number | null;
                bookCount?: number;
            } | null,
        },
    };
}

function data(): PageData {
    return {
        items: [book('Initial book', 'initial')],
        totalCount: 61,
        hasMore: true,
        pageSize: 60,
        loadError: false,
        shelves: [{ id: 'shelf', name: 'My shelf', bookCount: 61 }],
        languages: [],
        letterCounts: [],
        resume: [],
        audiobookActivity: null,
        filter: {
            group: 'shelf',
            language: 'de',
            series: null,
            author: 'Writer',
            narrator: 'Reader',
            letter: null,
            sort: 'title_asc',
        },
    } as unknown as PageData;
}

function result(title: string, offset = 60, hasMore = true) {
    return {
        data: {
            items: [book(title)],
            page: { limit: 60, total: 61, offset: offset - 1, hasMore },
        },
        error: null,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

async function search(value: string): Promise<void> {
    await fireEvent.input(screen.getByRole('searchbox'), { target: { value } });
    await tick();
    await vi.advanceTimersByTimeAsync(250);
}

describe('audiobook scoped browsing', () => {
    it('searches and paginates with all visible filters, including author and narrator', async () => {
        vi.mocked(apiGet)
            .mockResolvedValueOnce(result('First match') as never)
            .mockResolvedValueOnce(result('Last match', 61, false) as never);
        render(Page, { data: data() });
        await search('book');
        expect(screen.getByText('First match')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Remove filter: My shelf' })).toBeTruthy();
        const searchSection = screen.getByRole('region', {
            name: /Search audiobooks|Hörbücher suchen/,
        });
        // Card and load-more are both buttons; the final button is pagination.
        const buttons = searchSection.querySelectorAll('button');
        await fireEvent.click(buttons[buttons.length - 1]);
        await tick();
        expect(screen.getByText('Last match')).toBeTruthy();
        expect(apiGet).toHaveBeenLastCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({
                params: expect.objectContaining({
                    libraryGroupId: 'shelf',
                    lang: 'de',
                    authorId: 'Writer',
                    narratorId: 'Reader',
                    q: 'book',
                    offset: 60,
                }),
            }),
        );
    });

    it('ignores an old response during the next debounce and after clearing', async () => {
        let resolveOld!: (value: never) => void;
        vi.mocked(apiGet).mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveOld = resolve;
                }),
        );
        render(Page, { data: data() });
        await search('old');
        const signal = vi.mocked(apiGet).mock.calls[0][2]?.signal;
        await fireEvent.input(screen.getByRole('searchbox'), { target: { value: 'new' } });
        resolveOld(result('Stale result') as never);
        await tick();
        expect(signal?.aborted).toBe(true);
        expect(screen.queryByText('Stale result')).toBeNull();
        await fireEvent.input(screen.getByRole('searchbox'), { target: { value: '' } });
        await vi.advanceTimersByTimeAsync(300);
        expect(apiGet).toHaveBeenCalledTimes(1);
        expect(screen.queryByText('Stale result')).toBeNull();
    });

    it('distinguishes failures from no matches and retries the request', async () => {
        vi.mocked(apiGet)
            .mockResolvedValueOnce({ data: null, error: 'offline' } as never)
            .mockResolvedValueOnce(result('Recovered', 1, false) as never);
        render(Page, { data: data() });
        await search('book');
        expect(screen.getByRole('alert').textContent).toContain('Could not load audiobooks');
        await fireEvent.click(screen.getByRole('alert').querySelector('button')!);
        await tick();
        expect(screen.getByText('Recovered')).toBeTruthy();
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('removes one filter without silently clearing other scopes', async () => {
        render(Page, { data: data() });
        await fireEvent.click(screen.getByRole('button', { name: 'Remove filter: de' }));
        expect(goto).toHaveBeenCalledWith(
            '?libraryGroupId=shelf&authorId=Writer&narratorId=Reader',
            expect.anything(),
        );
    });

    it('surfaces an SSR failure separately from an empty library', () => {
        render(Page, { data: { ...data(), items: [], loadError: true } });
        expect(screen.getByRole('alert').textContent).toContain('Could not load audiobooks');
    });

    it('auto-loads the next page when the grid end scrolls into view', async () => {
        type ObserverCallback = ConstructorParameters<typeof IntersectionObserver>[0];
        const observed: ObserverCallback[] = [];
        let disconnected = 0;
        vi.stubGlobal(
            'IntersectionObserver',
            class {
                constructor(callback: ObserverCallback) {
                    observed.push(callback);
                }
                observe(): void {}
                disconnect(): void {
                    disconnected++;
                }
            },
        );
        try {
            vi.mocked(apiGet)
                .mockResolvedValueOnce({ data: null, error: 'offline' } as never)
                .mockResolvedValueOnce(result('Next book', 61, false) as never);
            render(Page, { data: data() });
            expect(screen.queryByRole('button', { name: /Load more|Mehr laden/ })).toBeNull();
            const intersect = (): void =>
                observed.at(-1)?.(
                    [{ isIntersecting: true } as IntersectionObserverEntry],
                    {} as IntersectionObserver,
                );
            intersect();
            await tick();
            await tick();
            // A failed page stops auto-loading and hands over to an explicit retry.
            expect(screen.getByRole('alert')).toBeTruthy();
            // No observer is re-armed while the page is in the error state.
            const armed = observed.length;
            await tick();
            expect(observed.length).toBe(armed);
            expect(disconnected).toBeGreaterThan(0);
            await fireEvent.click(screen.getByRole('button', { name: /Retry|Erneut versuchen/ }));
            await tick();
            expect(screen.getByText('Next book')).toBeTruthy();
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('keeps browse pagination scoped and offers retry after failure', async () => {
        // Without IntersectionObserver the explicit button is the only way on.
        vi.stubGlobal('IntersectionObserver', undefined);
        vi.mocked(apiGet)
            .mockResolvedValueOnce({ data: null, error: 'offline' } as never)
            .mockResolvedValueOnce(result('Next book', 61, false) as never);
        render(Page, { data: data() });
        await fireEvent.click(screen.getByRole('button', { name: /Load more|Mehr laden/ }));
        await tick();
        expect(screen.getByRole('alert')).toBeTruthy();
        expect(screen.getByText('Initial book')).toBeTruthy();
        await fireEvent.click(screen.getByRole('button', { name: /Retry|Erneut versuchen/ }));
        await tick();
        expect(screen.getByText('Next book')).toBeTruthy();
        expect(apiGet).toHaveBeenLastCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({
                params: expect.objectContaining({
                    authorId: 'Writer',
                    narratorId: 'Reader',
                    libraryGroupId: 'shelf',
                    lang: 'de',
                    offset: 1,
                }),
            }),
        );
    });

    it('opens a search series in reading order without broadening the library scope', async () => {
        const series = result('A series', 1, false);
        Object.assign(series.data.items[0], {
            audiobook: {
                authors: [],
                narrators: [],
                series: { id: 'series-id', name: 'A series', position: 1, bookCount: 3 },
            },
        });
        vi.mocked(apiGet).mockResolvedValueOnce(series as never);
        render(Page, { data: data() });
        await search('series');
        await fireEvent.click(screen.getByRole('button', { name: 'A series' }));
        expect(goto).toHaveBeenCalledWith(expect.stringContaining('/audiobooks/series/series-id'));
    });
});
