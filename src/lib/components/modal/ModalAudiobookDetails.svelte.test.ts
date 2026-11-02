// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen, fireEvent } from '@testing-library/svelte';
import { describe, expect, test } from 'vitest';
import type { AudiobookChapter } from '$lib/schemas/api-audiobook';
import ModalAudiobookDetails from './ModalAudiobookDetails.svelte';

/**
 * The audiobook half of the media detail modal.
 *
 * Regression context: for an AudiobookShelf book the modal used to render only a
 * cover, a truncated title and a year — no author, no narrator, no description,
 * no chapters — even though every one of those facts was already stored.
 */
function chapters(count: number): AudiobookChapter[] {
    return Array.from({ length: count }, (_, i) => ({
        index: i,
        name: `Kapitel ${i + 1}`,
        startMs: i * 600_000,
        endMs: (i + 1) * 600_000,
    }));
}

describe('ModalAudiobookDetails', () => {
    test('renders author and narrator as their own labelled fields', () => {
        render(ModalAudiobookDetails, {
            authors: [{ id: '1', name: 'M.K. Fenwick' }],
            narrators: [{ id: '1', name: 'Felix Vale' }],
        });

        expect(screen.getByText('Author:')).toBeTruthy();
        expect(screen.getByText('M.K. Fenwick')).toBeTruthy();
        expect(screen.getByText('Narrator:')).toBeTruthy();
        expect(screen.getByText('Felix Vale')).toBeTruthy();
    });

    test('uses the plural label for multiple authors/narrators', () => {
        render(ModalAudiobookDetails, {
            authors: [
                { id: '1', name: 'A' },
                { id: '2', name: 'B' },
            ],
            narrators: [
                { id: '1', name: 'C' },
                { id: '2', name: 'D' },
            ],
        });

        expect(screen.getByText('Authors:')).toBeTruthy();
        expect(screen.getByText('Narrators:')).toBeTruthy();
        // Each name is its OWN link, so they are separate elements rather than
        // the old joined "A, B" string.
        expect(screen.getByRole('link', { name: 'A' })).toBeTruthy();
        expect(screen.getByRole('link', { name: 'B' })).toBeTruthy();
    });

    test('links every credit to its resource page', () => {
        render(ModalAudiobookDetails, {
            authors: [{ id: '1', name: 'Cixin Liu' }],
            narrators: [{ id: '1', name: 'Mark Bremer' }],
        });

        expect(screen.getByRole('link', { name: 'Cixin Liu' }).getAttribute('href')).toContain(
            '/audiobooks/authors/1',
        );
        expect(screen.getByRole('link', { name: 'Mark Bremer' }).getAttribute('href')).toContain(
            '/audiobooks/narrators/1',
        );
    });

    test('links each of two credits separately rather than as one joined name', () => {
        // A book credited to two people belongs on BOTH shelves; one link over
        // "Andreas Fröhlich, Oliver Rohrbeck" would search for a name nobody has.
        render(ModalAudiobookDetails, {
            narrators: [
                { id: '1', name: 'Andreas Fröhlich' },
                { id: '2', name: 'Oliver Rohrbeck' },
            ],
        });

        expect(
            screen.getByRole('link', { name: 'Andreas Fröhlich' }).getAttribute('href'),
        ).toContain('/audiobooks/narrators/1');
        expect(
            screen.getByRole('link', { name: 'Oliver Rohrbeck' }).getAttribute('href'),
        ).toContain('/audiobooks/narrators/2');
    });

    test('uses the stable id even when the name contains URL punctuation', () => {
        render(ModalAudiobookDetails, { authors: [{ id: '1', name: 'Rock & Roll #1' }] });

        const href = screen.getByRole('link', { name: 'Rock & Roll #1' }).getAttribute('href');
        expect(href).toContain('/audiobooks/authors/1');
    });

    test('shows the series with its position, and without one when absent', () => {
        const { unmount } = render(ModalAudiobookDetails, {
            series: { id: 'series-1', name: 'Milo Farrow', position: 1 },
        });
        expect(screen.getByText('Milo Farrow #1')).toBeTruthy();
        expect(screen.getByRole('link', { name: 'Milo Farrow #1' }).getAttribute('href')).toContain(
            '/audiobooks/series/series-1',
        );
        unmount();

        render(ModalAudiobookDetails, {
            series: { id: 'series-2', name: 'Hörspiele', position: null },
        });
        // No invented "#1" for a folder-derived shelf with no real position.
        expect(screen.getByText('Hörspiele')).toBeTruthy();
        expect(screen.queryByText('Hörspiele #1')).toBeNull();
    });

    test('summarises the chapter count and keeps the list collapsed', () => {
        render(ModalAudiobookDetails, {
            chapterCount: 108,
            chapters: chapters(108),
        });

        const toggle = screen.getByRole('button', { name: /108 chapters/ });
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        // 108 rows must not be in the DOM before the user asks for them.
        expect(screen.queryByText('Kapitel 1')).toBeNull();
    });

    test('expands to the full chapter list with book-relative offsets', async () => {
        render(ModalAudiobookDetails, {
            chapterCount: 3,
            chapters: chapters(3),
        });

        const toggle = screen.getByRole('button', { name: /3 chapters/ });
        toggle.click();
        await Promise.resolve();

        expect(toggle.getAttribute('aria-expanded')).toBe('true');
        expect(screen.getByText('Kapitel 1')).toBeTruthy();
        expect(screen.getByText('Kapitel 3')).toBeTruthy();
        // h:mm:ss — the hour field is always present so the format never changes
        // mid-list on a book that runs past 60 minutes.
        expect(screen.getByText('0:00:00')).toBeTruthy();
        expect(screen.getByText('0:10:00')).toBeTruthy();
        expect(screen.getByText('0:20:00')).toBeTruthy();
    });

    test('reports the server count with no list, and offers no toggle', () => {
        render(ModalAudiobookDetails, { chapterCount: 108, chapters: [] });

        expect(screen.getByText('108 chapters')).toBeTruthy();
        expect(screen.queryByRole('button')).toBeNull();
    });

    /** File splits: every title is the book's own name plus an ordinal. */
    function parts(count: number): AudiobookChapter[] {
        return Array.from({ length: count }, (_, i) => ({
            index: i,
            name: `Liu Cixin - Jenseits der Zeit - ${String(i + 1).padStart(3, '0')}`,
            startMs: i * 180_000,
            endMs: (i + 1) * 180_000,
        }));
    }

    test('drops the repeated title from a parts list and keeps the offset', async () => {
        // The signal that renames the count to "parts" also decides the row: the
        // number and the offset already carry everything, so the title column was
        // the same 26 characters repeated 555 times.
        render(ModalAudiobookDetails, { chapterCount: 30, chapters: parts(30) });

        await fireEvent.click(screen.getByRole('button', { name: /30 parts/ }));

        expect(screen.queryByText(/Liu Cixin - Jenseits der Zeit/)).toBeNull();
        expect(screen.getByText('0:03:00')).toBeTruthy();
    });

    test('keeps titles when they actually say something', async () => {
        render(ModalAudiobookDetails, { chapterCount: 30, chapters: chapters(30) });

        await fireEvent.click(screen.getByRole('button', { name: /30 chapters/ }));

        expect(screen.getByText('Kapitel 2')).toBeTruthy();
    });

    test('does not auto-expand a parts list even with no synopsis to show', () => {
        // `expandChapters` is passed when the modal has no description. For real
        // chapters that is a fair trade; for file splits it promotes the least
        // useful block in the modal to the most prominent.
        render(ModalAudiobookDetails, {
            chapterCount: 30,
            chapters: parts(30),
            expandChapters: true,
        });

        expect(screen.queryByText('0:03:00')).toBeNull();
        expect(screen.getByRole('button', { name: /30 parts/ })).toBeTruthy();
    });

    test('still auto-expands a real chapter list with no synopsis', () => {
        render(ModalAudiobookDetails, {
            chapterCount: 30,
            chapters: chapters(30),
            expandChapters: true,
        });

        expect(screen.getByText('Kapitel 2')).toBeTruthy();
    });

    test('carries the year and length as labelled rows', () => {
        // They used to sit in the shared metadata bar, where a book suppresses
        // ratings, genres and studio — leaving two orphaned numbers.
        render(ModalAudiobookDetails, { year: 2019, durationMs: 96_660_000 });

        expect(screen.getByText('Published:')).toBeTruthy();
        expect(screen.getByText('2019')).toBeTruthy();
        expect(screen.getByText('Length:')).toBeTruthy();
    });

    test('renders nothing at all when the book has no metadata', () => {
        const { container } = render(ModalAudiobookDetails, {});
        expect(container.querySelector('.audiobook-details')).toBeNull();
    });

    test('shows the abridged badge only when upstream says so', () => {
        const { unmount } = render(ModalAudiobookDetails, {
            authors: [{ id: '1', name: 'A' }],
            abridged: false,
        });
        expect(screen.queryByText('ABRIDGED')).toBeNull();
        unmount();

        render(ModalAudiobookDetails, { authors: [{ id: '1', name: 'A' }], abridged: true });
        expect(screen.getByText('ABRIDGED')).toBeTruthy();
    });
});
