// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the `custom_metadata.audiobookshelf` → admin-detail mapper.
 *
 * The blob these read is written by the AudiobookShelf connector with no schema
 * to enforce it, and the admin book tab is a *diagnostic* surface — the one place
 * an operator looks when a book renders wrong. So the mapper must survive a
 * malformed blob field-by-field rather than throwing and 500ing the page: a
 * missing narrator list must not cost the operator the ABS item id sitting next
 * to it.
 */

import { describe, it, expect } from 'vitest';
import { parseAudiobookAdminDetail } from './audiobook-admin-detail.queries';

/** A complete blob, shaped exactly as the sweep persists it. */
const FULL_BLOB = {
    libraryId: 'lib_xyz',
    libraryPathId: '11111111-1111-1111-1111-111111111111',
    updatedAt: 1_755_000_000_000,
    mtimeMs: 1_754_000_000_000,
    addedAt: 1_700_000_000_000,
    relPath: 'Sanderson/Words of Radiance',
    coverPath: '/metadata/items/li_abc/cover.jpg',
    subtitle: 'The Harborlight Archive, Book 2',
    authors: ['Brandon Sanderson'],
    narrators: ['Micah Fenwick', 'Kate Fenwick'],
    series: [{ id: 'ser_1', name: 'The Harborlight Archive', sequence: '2' }],
    derivedSeries: { name: 'The Harborlight Archive', sequence: 2, source: 'abs-series' },
    audioFiles: [
        { index: 1, ino: '4021', duration: 3492.5, mimeType: 'audio/mp4', codec: 'aac' },
        { index: 2, ino: '4022', duration: 3501, mimeType: 'audio/mp4', codec: 'aac' },
    ],
    genres: ['Fantasy', 'Epic'],
    publisher: 'Macmillan Audio',
    publishedYear: '2014',
    language: 'en',
    isbn: '9781427233332',
    asin: 'B00INIXQ6E',
    explicit: false,
    abridged: false,
    duration: 173_000,
    chapters: [
        { id: 0, start: 0, end: 600, title: 'Prologue' },
        { id: 1, start: 600, end: 1800, title: 'Chapter 1' },
    ],
};

describe('parseAudiobookAdminDetail', () => {
    it('maps a complete AudiobookShelf blob to the admin detail shape', () => {
        const detail = parseAudiobookAdminDetail(FULL_BLOB, 'li_abc123');

        expect(detail).toMatchObject({
            absItemId: 'li_abc123',
            libraryId: 'lib_xyz',
            relPath: 'Sanderson/Words of Radiance',
            subtitle: 'The Harborlight Archive, Book 2',
            authors: ['Brandon Sanderson'],
            narrators: ['Micah Fenwick', 'Kate Fenwick'],
            genres: ['Fantasy', 'Epic'],
            publisher: 'Macmillan Audio',
            publishedYear: '2014',
            language: 'en',
            isbn: '9781427233332',
            asin: 'B00INIXQ6E',
            explicit: false,
            abridged: false,
            durationSeconds: 173_000,
            seriesName: 'The Harborlight Archive',
            seriesSequence: 2,
            seriesSource: 'abs-series',
            updatedAt: 1_755_000_000_000,
            mtimeMs: 1_754_000_000_000,
            addedAt: 1_700_000_000_000,
        });
        expect(detail.audioFiles).toHaveLength(2);
        expect(detail.audioFiles[0]).toEqual({
            index: 1,
            ino: '4021',
            duration: 3492.5,
            mimeType: 'audio/mp4',
            codec: 'aac',
        });
        // Two tagged chapters plus the synthetic tail the shared normaliser
        // appends because the list stops at 1800s of a 173000s book. Asserted
        // rather than filtered: an operator reading this tab needs to see that
        // the upstream chapter list does not cover the audio.
        expect(detail.chapters).toHaveLength(3);
        expect(detail.chapters[0]).toMatchObject({ start: 0, title: 'Prologue' });
        expect(detail.chapters[2]).toMatchObject({ synthetic: true, end: 173_000 });
    });

    it('returns an empty detail rather than throwing when the blob is absent', () => {
        const detail = parseAudiobookAdminDetail(null, null);

        expect(detail).toMatchObject({
            absItemId: null,
            libraryId: null,
            publisher: null,
            seriesName: null,
            seriesSequence: null,
            seriesSource: null,
            explicit: null,
            abridged: null,
            durationSeconds: null,
            updatedAt: null,
        });
        expect(detail.authors).toEqual([]);
        expect(detail.narrators).toEqual([]);
        expect(detail.genres).toEqual([]);
        expect(detail.audioFiles).toEqual([]);
        expect(detail.chapters).toEqual([]);
    });

    it('keeps the fields around a malformed one instead of losing the whole blob', () => {
        const detail = parseAudiobookAdminDetail(
            { ...FULL_BLOB, narrators: 'Micah Fenwick', publisher: 42, explicit: 'yes' },
            'li_abc123',
        );

        expect(detail.narrators).toEqual([]);
        expect(detail.publisher).toBeNull();
        expect(detail.explicit).toBeNull();
        // The point of the test: everything else still arrives.
        expect(detail.authors).toEqual(['Brandon Sanderson']);
        expect(detail.libraryId).toBe('lib_xyz');
        expect(detail.asin).toBe('B00INIXQ6E');
    });

    it('drops non-string entries from the author and narrator lists', () => {
        const detail = parseAudiobookAdminDetail(
            { ...FULL_BLOB, authors: ['Brandon Sanderson', null, 7, ''] },
            null,
        );

        expect(detail.authors).toEqual(['Brandon Sanderson']);
    });

    it('reads no series sequence when AudiobookShelf recorded a non-numeric one', () => {
        const detail = parseAudiobookAdminDetail(
            {
                ...FULL_BLOB,
                derivedSeries: { name: 'Cloudrealm', sequence: '2.5', source: 'folder' },
            },
            null,
        );

        expect(detail.seriesName).toBe('Cloudrealm');
        expect(detail.seriesSequence).toBeNull();
        // The other half of the diagnosis: this shelf came from a folder name,
        // not from anything AudiobookShelf reported.
        expect(detail.seriesSource).toBe('folder');
    });

    it('skips audio files with no usable index', () => {
        const detail = parseAudiobookAdminDetail(
            {
                ...FULL_BLOB,
                audioFiles: [
                    {
                        index: 1,
                        ino: '4021',
                        duration: 3492.5,
                        mimeType: 'audio/mp4',
                        codec: 'aac',
                    },
                    'not-a-file',
                    { ino: '4023' },
                ],
            },
            null,
        );

        expect(detail.audioFiles).toEqual([
            { index: 1, ino: '4021', duration: 3492.5, mimeType: 'audio/mp4', codec: 'aac' },
        ]);
    });

    it('drops chapters with no numeric start, keeping the ones around them', () => {
        const detail = parseAudiobookAdminDetail(
            {
                ...FULL_BLOB,
                duration: 1800,
                chapters: [
                    { id: 0, start: 0, end: 600, title: 'Prologue' },
                    { id: 1, start: 'later', end: 1200, title: 'Broken' },
                ],
            },
            null,
        );

        // 'Broken' is dropped; the synthetic tail then covers 600s-1800s, which
        // is the normaliser reporting the hole rather than hiding it.
        expect(detail.chapters.map((c) => c.title)).toEqual(['Prologue', '']);
        expect(detail.chapters[1]).toMatchObject({ synthetic: true, start: 600, end: 1800 });
    });
});
