// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * Example names are fictional; production shapes and measurements are retained.
 * The Book tab is a diagnostic surface: an operator opens it when a book looks
 * wrong in the library, so what it must never do is quietly show nothing.
 *
 * These tests therefore assert on the two things that make it useful — the ABS
 * identity an operator can act on (item id, library, path, revision keys) and an
 * explicit "AudiobookShelf did not report this" for anything absent — rather
 * than on layout.
 */

import { render, screen } from '@testing-library/svelte';
import { describe, expect, test } from 'vitest';
import AudiobookTab from './AudiobookTab.svelte';
import type { AudiobookAdminDetail } from '$lib/shared/audiobook-metadata';

const WORDS_OF_RADIANCE: AudiobookAdminDetail = {
    absItemId: 'li_abc123',
    libraryId: 'lib_xyz',
    libraryPathId: '11111111-1111-1111-1111-111111111111',
    relPath: 'Sanderson/Words of Radiance',
    subtitle: 'The Harborlight Archive, Book 2',
    authors: ['Brandon Sanderson'],
    narrators: ['Micah Fenwick', 'Kate Fenwick'],
    genres: ['Fantasy'],
    seriesName: 'The Harborlight Archive',
    seriesSequence: 2,
    seriesSource: 'abs-series',
    publisher: 'Macmillan Audio',
    publishedYear: '2014',
    language: 'en',
    isbn: '9781427233332',
    asin: 'B00INIXQ6E',
    explicit: false,
    abridged: false,
    durationSeconds: 172_800,
    updatedAt: 1_755_000_000_000,
    mtimeMs: 1_754_000_000_000,
    addedAt: 1_700_000_000_000,
    chapters: [
        { id: 0, start: 0, end: 600, title: 'Prologue' },
        { id: 1, start: 600, end: 172_800, title: 'Chapter 1' },
    ],
    audioFiles: [
        { index: 1, ino: '4021', duration: 3492.5, mimeType: 'audio/mp4', codec: 'aac' },
        { index: 2, ino: '4022', duration: 3501, mimeType: 'audio/mp4', codec: 'aac' },
    ],
};

/** Everything AudiobookShelf can decline to report, all at once. */
const BARE: AudiobookAdminDetail = {
    absItemId: null,
    libraryId: null,
    libraryPathId: null,
    relPath: null,
    subtitle: null,
    authors: [],
    narrators: [],
    genres: [],
    seriesName: null,
    seriesSequence: null,
    seriesSource: null,
    publisher: null,
    publishedYear: null,
    language: null,
    isbn: null,
    asin: null,
    explicit: null,
    abridged: null,
    durationSeconds: null,
    updatedAt: null,
    mtimeMs: null,
    addedAt: null,
    chapters: [],
    audioFiles: [],
};

describe('AudiobookTab', () => {
    test.each(['abs.local', 'abs.local:13378'])('hides invalid URL %s without crashing', (base) => {
        render(AudiobookTab, { detail: WORDS_OF_RADIANCE, absBaseUrl: base });
        expect(screen.getByText('li_abc123')).toBeTruthy();
        expect(screen.queryByRole('link', { name: /AudiobookShelf/i })).toBeNull();
    });

    test('shows the authors and narrators the connector recorded', () => {
        render(AudiobookTab, { detail: WORDS_OF_RADIANCE, absBaseUrl: null });

        expect(screen.getByText('Brandon Sanderson')).toBeTruthy();
        expect(screen.getByText(/Micah Fenwick/)).toBeTruthy();
        expect(screen.getByText(/Kate Fenwick/)).toBeTruthy();
    });

    test('shows the series with its position', () => {
        render(AudiobookTab, { detail: WORDS_OF_RADIANCE, absBaseUrl: null });

        // Matched together, not as two loose substrings: the subtitle also says
        // "The Harborlight Archive", and the position is the half that is easy to
        // lose when the sequence is a number rather than a string.
        expect(screen.getByText(/The Harborlight Archive #2/)).toBeTruthy();
    });

    test('says when a series was inferred from the folder rather than reported', () => {
        render(AudiobookTab, {
            detail: { ...WORDS_OF_RADIANCE, seriesSource: 'folder' },
            absBaseUrl: null,
        });

        expect(screen.getByText(/inferred from the folder name/i)).toBeTruthy();
    });

    test('shows the AudiobookShelf item id — the handle for every upstream action', () => {
        render(AudiobookTab, { detail: WORDS_OF_RADIANCE, absBaseUrl: null });

        expect(screen.getByText('li_abc123')).toBeTruthy();
        expect(screen.getByText('lib_xyz')).toBeTruthy();
        expect(screen.getByText('Sanderson/Words of Radiance')).toBeTruthy();
    });

    test('links to the book on the AudiobookShelf server when one is configured', () => {
        render(AudiobookTab, { detail: WORDS_OF_RADIANCE, absBaseUrl: 'https://abs.example.org' });

        const link = screen.getByRole('link', { name: /AudiobookShelf/i });
        expect(link.getAttribute('href')).toBe('https://abs.example.org/item/li_abc123');
    });

    test('keeps a nested proxy base path and its query in the upstream book link', () => {
        render(AudiobookTab, {
            detail: WORDS_OF_RADIANCE,
            absBaseUrl: 'https://abs.example.org/media/audiobookshelf/?tenant=books',
        });
        const link = screen.getByRole('link', { name: /AudiobookShelf/i });
        expect(link.getAttribute('href')).toBe(
            'https://abs.example.org/media/audiobookshelf/item/li_abc123?tenant=books',
        );
    });

    test('renders no upstream link when no AudiobookShelf URL is configured', () => {
        render(AudiobookTab, { detail: WORDS_OF_RADIANCE, absBaseUrl: null });

        expect(screen.queryByRole('link', { name: /AudiobookShelf/i })).toBeNull();
    });

    test('lists the audio files, which is where a multi-file book is diagnosed', () => {
        render(AudiobookTab, { detail: WORDS_OF_RADIANCE, absBaseUrl: null });

        expect(screen.getByText('4021')).toBeTruthy();
        expect(screen.getByText('4022')).toBeTruthy();
    });

    test('flags a chapter list that stops before the audio does', () => {
        const short = {
            ...WORDS_OF_RADIANCE,
            chapters: [
                { id: 0, start: 0, end: 600, title: 'Prologue' },
                { id: 1, start: 600, end: 172_800, title: '', synthetic: true },
            ],
        };
        render(AudiobookTab, { detail: short, absBaseUrl: null });

        expect(screen.getByText(/chapter list does not cover/i)).toBeTruthy();
    });

    test('does not flag a chapter list that covers the whole book', () => {
        render(AudiobookTab, { detail: WORDS_OF_RADIANCE, absBaseUrl: null });

        expect(screen.queryByText(/chapter list does not cover/i)).toBeNull();
    });

    test('says a field was not reported rather than rendering an empty row', () => {
        render(AudiobookTab, { detail: BARE, absBaseUrl: null });

        // The identity block still renders; every value reads as absent.
        expect(screen.getAllByText(/not reported/i).length).toBeGreaterThan(0);
    });

    test('says so plainly when AudiobookShelf reported no chapters at all', () => {
        render(AudiobookTab, { detail: BARE, absBaseUrl: null });

        expect(screen.getByText(/no chapters/i)).toBeTruthy();
    });
});

/**
 * The verbatim `custom_metadata.audiobookshelf` payload of one real production
 * book (`c3e61a56-…`, "Die sieben Laternenzeichen — 001 Der Super-Papagei"), trimmed
 * only by dropping five of its eight identical audio-file entries.
 *
 * Pinned because the synthetic fixtures above are all tidy: this one has twelve
 * narrators, a German locale, fractional chapter bounds and a chapter list that
 * exactly meets the runtime — the combination that actually ships.
 */
const REAL_PROD_BOOK: AudiobookAdminDetail = {
    absItemId: 'li_n5eckri6r0mx7ttb5e',
    libraryId: 'd99c14f8-9a53-48f0-ab21-f9b5a522fc63',
    libraryPathId: 'ea871b41-1405-49e8-ad24-50d5b0b0527a',
    relPath: 'Die Sieben Laternenzeichen ???/001 - Der Super-Papagei',
    subtitle: null,
    authors: ['H. G. Francis'],
    narrators: [
        'Peter Pasetti',
        'Jens Wawrczeck',
        'Oliver Rohrbeck',
        'Andreas Fröhlich',
        'Richard Lauffen',
        'Gerlach Fiedler',
        'Ingrid Andree',
        'Katharina Brauren',
        'Stefan Brönneke',
        'Juan Perez',
        'Albert Giro',
        'Andreas von der Meden',
    ],
    genres: [],
    seriesName: 'Die sieben Laternenzeichen',
    seriesSequence: 1,
    seriesSource: 'abs-series',
    publisher: 'EUROPA',
    publishedYear: '1979',
    language: 'Deutsch',
    isbn: null,
    asin: null,
    explicit: false,
    abridged: false,
    durationSeconds: 3144.715158,
    updatedAt: 1_752_885_069_814,
    mtimeMs: 1_657_129_717_084,
    addedAt: 1_659_218_252_631,
    chapters: [
        { id: 0, start: 0, end: 356.994711, title: '01 - Ein Hilferuf' },
        { id: 1, start: 356.994711, end: 767.8278, title: '02 - Ein Papagei spricht Latein' },
        {
            id: 7,
            start: 2761.963736,
            end: 3144.715158,
            title: '08 - Blackbeard hat das letzte Wort',
        },
    ],
    audioFiles: [
        { index: 1, ino: '39070', duration: 356.994711, mimeType: 'audio/mpeg', codec: 'mp3' },
    ],
};

describe('AudiobookTab — a real production payload', () => {
    test('renders the whole narrator credit, not just the first name', () => {
        render(AudiobookTab, { detail: REAL_PROD_BOOK, absBaseUrl: null });

        expect(screen.getByText(/Peter Pasetti/)).toBeTruthy();
        expect(screen.getByText(/Andreas von der Meden/)).toBeTruthy();
    });

    test('shows the ABS identity an operator would act on', () => {
        render(AudiobookTab, { detail: REAL_PROD_BOOK, absBaseUrl: null });

        expect(screen.getByText('li_n5eckri6r0mx7ttb5e')).toBeTruthy();
        expect(
            screen.getByText('Die Sieben Laternenzeichen ???/001 - Der Super-Papagei'),
        ).toBeTruthy();
    });

    test('does not warn about coverage when the chapters reach the runtime', () => {
        render(AudiobookTab, { detail: REAL_PROD_BOOK, absBaseUrl: null });

        expect(screen.queryByText(/chapter list does not cover/i)).toBeNull();
    });
});
