// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * The rail is shaped like Similar Movies but means something different: order
 * is READING ORDER, not relevance, and the per-book state is the reason it
 * exists. These pin the state, not the styling.
 */
import { cleanup, render, screen, fireEvent } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ModalAudiobookSeries from './ModalAudiobookSeries.svelte';
import type { AudiobookPreview } from '$lib/schemas/api-audiobook-preview';

afterEach(cleanup);

function series(): AudiobookPreview[] {
    return [1, 2, 3, 4].map<AudiobookPreview>((number) => ({
        id: `b${number}`,
        catalogId: `b${number}`,
        title: ['Book One', 'Book Two', 'Book Three', 'Book Four'][number - 1],
        type: 'audiobook',
        ids: {},
        images: { primary: { href: `/p${number}`, revision: '1', source: 'self' } },
        audiobook: {
            authors: [],
            narrators: [],
            series: { id: 'series', name: 'Cycle', position: number },
        },
        progress:
            number <= 2
                ? {
                      positionMs: number === 2 ? 3_600_000 : 0,
                      durationMs: 7_200_000,
                      fraction: number === 2 ? 0.5 : 0,
                      finished: number === 1,
                      updatedAt: null,
                  }
                : undefined,
    }));
}

describe('ModalAudiobookSeries', () => {
    it('renders a cover for every book, in the given order', () => {
        const { container } = render(ModalAudiobookSeries, { books: series() });
        const covers = container.querySelectorAll('[data-testid="audiobook-series-book"] img');
        expect([...covers].map((img) => img.getAttribute('src'))).toEqual([
            '/p1',
            '/p2',
            '/p3',
            '/p4',
        ]);
    });

    it('marks the finished book and shows partial progress on the started one', () => {
        const { container } = render(ModalAudiobookSeries, { books: series() });
        const rows = container.querySelectorAll('[data-testid="audiobook-series-book"]');

        expect(rows[0].querySelector('[data-testid="series-book-finished"]')).not.toBeNull();
        const bar = rows[1].querySelector<HTMLElement>('[data-testid="series-book-progress"]');
        expect(bar?.style.width).toBe('50%');
    });

    it('points at the in-progress book before an untouched book', () => {
        const { container } = render(ModalAudiobookSeries, { books: series() });
        const rows = container.querySelectorAll('[data-testid="audiobook-series-book"]');
        expect(rows[1].querySelector('[data-testid="series-book-next"]')).not.toBeNull();
        expect(rows[2].querySelector('[data-testid="series-book-next"]')).toBeNull();
        expect(rows[3].querySelector('[data-testid="series-book-next"]')).toBeNull();
    });

    it('uses reading order when no unfinished book is in progress', () => {
        const books = series().map((book) => ({
            ...book,
            progress: book.progress ? { ...book.progress, positionMs: 0, fraction: 0 } : undefined,
        }));
        const { container } = render(ModalAudiobookSeries, { books });
        const rows = container.querySelectorAll('[data-testid="audiobook-series-book"]');
        expect(rows[1].querySelector('[data-testid="series-book-next"]')).not.toBeNull();
        expect(rows[2].querySelector('[data-testid="series-book-next"]')).toBeNull();
    });

    it('points at nothing once every book is done', () => {
        const done = series().map((book) => ({
            ...book,
            progress: {
                positionMs: 0,
                durationMs: 7_200_000,
                fraction: 1,
                updatedAt: null,
                finished: true,
            },
        }));
        const { container } = render(ModalAudiobookSeries, { books: done });
        expect(container.querySelector('[data-testid="series-book-next"]')).toBeNull();
    });

    it('marks the open book and does not offer to open it again', async () => {
        const onopen = vi.fn();
        const { container } = render(ModalAudiobookSeries, {
            books: series(),
            currentMediaId: 'b2',
            onopen,
        });
        const current = container.querySelector<HTMLButtonElement>('[data-current="true"]')!;

        expect(current.disabled).toBe(true);
        expect(screen.getByText('You are here')).toBeTruthy();
        await fireEvent.click(current);
        expect(onopen).not.toHaveBeenCalled();
    });

    it('opens another book in the series', async () => {
        const onopen = vi.fn();
        const { container } = render(ModalAudiobookSeries, {
            books: series(),
            currentMediaId: 'b2',
            onopen,
        });
        const rows = container.querySelectorAll('[data-testid="audiobook-series-book"]');

        await fireEvent.click(rows[2]);
        expect(onopen).toHaveBeenCalledWith(expect.objectContaining({ id: 'b3' }));
    });

    /** A one-book "series" is just this book again. */
    it('renders nothing for a series of one', () => {
        const { container } = render(ModalAudiobookSeries, { books: [series()[0]] });
        expect(container.querySelector('[data-testid="audiobook-series-rail"]')).toBeNull();
    });
});
