// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import type { AudiobookResourceData } from '../../../routes/audiobooks/resource-load';
import AudiobookResourcePage from './AudiobookResourcePage.svelte';
import { getAudiobookResourceBooks } from '$lib/api/audiobooks';

vi.mock('$lib/api/audiobooks', () => ({ getAudiobookResourceBooks: vi.fn() }));
vi.mock('$lib/components/ui/UniversalMediaCard.svelte', async () => ({
    default: (await import('../../../routes/audiobooks/test-fixtures/AudiobookCard.svelte'))
        .default,
}));
vi.mock('$lib/utils/modal-utils', () => ({ openMediaModal: vi.fn() }));
vi.mock('$lib/services/audiobook-playback', () => ({
    playAudiobook: vi.fn(),
    audiobookStartFailureMessage: vi.fn(),
}));
vi.mock('$lib/paraglide/messages', async (original) => ({
    ...(await original<object>()),
    audiobook_catalog_next_up: () => 'Next up in this series',
}));

function data(id = 'series'): AudiobookResourceData {
    const book = {
        id: 'b1',
        catalogId: 'b1',
        type: 'audiobook' as const,
        title: 'First book',
        ids: {},
        images: {},
        audiobook: { authors: [], narrators: [], series: null },
    };
    return {
        kind: 'series',
        detail: { id, name: 'A series', bookCount: 2, durationMs: 2000, nextUp: book },
        books: { items: [book], page: { offset: 0, limit: 1, hasMore: true } },
    };
}
afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

describe('AudiobookResourcePage', () => {
    it('highlights the server nextUp and appends the next offset page', async () => {
        const initial = data();
        vi.mocked(getAudiobookResourceBooks).mockResolvedValue({
            data: {
                items: [
                    { ...initial.books.items[0], id: 'b2', catalogId: 'b2', title: 'Second book' },
                ],
                page: { offset: 1, limit: 60, hasMore: false },
            },
            error: null,
            status: 200,
        });
        render(AudiobookResourcePage, { data: initial });
        expect(screen.getAllByTestId('audiobook-next-up')).toHaveLength(2);
        await fireEvent.click(screen.getByRole('button', { name: /Load more|Mehr laden/ }));
        await tick();
        expect(getAudiobookResourceBooks).toHaveBeenCalledWith('series', 'series', 1);
        expect(screen.getByText('Second book')).toBeTruthy();
        expect(screen.queryByRole('button', { name: /Load more|Mehr laden/ })).toBeNull();
    });
    it('discards an appended response after navigating to another resource', async () => {
        let complete!: (value: Awaited<ReturnType<typeof getAudiobookResourceBooks>>) => void;
        vi.mocked(getAudiobookResourceBooks).mockReturnValue(
            new Promise((resolve) => {
                complete = resolve;
            }),
        );
        const view = render(AudiobookResourcePage, { data: data() });
        await fireEvent.click(screen.getByRole('button', { name: /Load more|Mehr laden/ }));
        await view.rerender({ data: data('other-series') });
        complete({
            data: {
                items: [{ ...data().books.items[0], id: 'stale', title: 'Stale book' }],
                page: { limit: 60, hasMore: false },
            },
            error: null,
            status: 200,
        });
        await tick();
        expect(screen.queryByText('Stale book')).toBeNull();
    });
});
