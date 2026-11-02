// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { resolveAudiobookEntryClick } from './audiobook-entry-click';
import type { AudiobookPreview } from '$lib/schemas/api-audiobook-preview';

function tile(series: AudiobookPreview['audiobook']['series'] = null): AudiobookPreview {
    return {
        id: 'book',
        catalogId: 'book',
        type: 'audiobook',
        title: 'Book',
        ids: {},
        images: {},
        audiobook: { authors: [], narrators: [], series },
    };
}

describe('resolveAudiobookEntryClick', () => {
    it('opens the stable series resource for a collapsed tile', () => {
        expect(
            resolveAudiobookEntryClick(
                tile({ id: 'series', name: 'Cycle', position: 1, bookCount: 5 }),
            ),
        ).toEqual({ action: 'series', seriesId: 'series' });
    });
    it('uses identity rather than the series display name', () => {
        expect(
            resolveAudiobookEntryClick(
                tile({ id: 'series', name: 'Rock & Roll #1', position: null, bookCount: 9 }),
            ),
        ).toEqual({ action: 'series', seriesId: 'series' });
    });
    it('opens a single book even when it belongs to a series', () => {
        expect(
            resolveAudiobookEntryClick(tile({ id: 'series', name: 'Cycle', position: 2 })),
        ).toEqual({ action: 'book' });
    });
    it('opens a standalone book', () => {
        expect(resolveAudiobookEntryClick(tile())).toEqual({ action: 'book' });
    });
    it('opens a collapsed series of one by id', () => {
        expect(
            resolveAudiobookEntryClick(
                tile({ id: 'series', name: 'Cycle', position: null, bookCount: 1 }),
            ),
        ).toEqual({ action: 'series', seriesId: 'series' });
    });
    it('does not need a nonblank series name to navigate by id', () => {
        expect(
            resolveAudiobookEntryClick(
                tile({ id: 'series', name: '', position: null, bookCount: 3 }),
            ),
        ).toEqual({ action: 'series', seriesId: 'series' });
    });
});
