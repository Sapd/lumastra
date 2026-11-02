// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { audiobookCardItem, openAudiobook } from './audiobook-catalog';
import { openMediaModal } from '$lib/utils/modal-utils';
import type { AudiobookPreview } from '$lib/schemas/api-audiobook-preview';
vi.mock('$lib/utils/modal-utils', () => ({ openMediaModal: vi.fn() }));

const book: AudiobookPreview = {
    id: 'book',
    catalogId: 'catalog-book',
    type: 'audiobook',
    title: 'Book',
    ids: { isbn: '9780000000001' },
    images: {
        primary: {
            href: '/cover',
            variants: { card: '/cover-card' },
            revision: '2',
            source: 'self',
        },
    },
    audiobook: { authors: [{ id: 'writer', name: 'Writer' }], narrators: [], series: null },
    progress: {
        positionMs: 500,
        durationMs: 1000,
        fraction: 0.5,
        finished: false,
        updatedAt: null,
    },
};
describe('audiobook card projection', () => {
    it('renders ready artwork, person names and the shared progress block', () => {
        expect(audiobookCardItem(book)).toMatchObject({
            aspectRatio: 'square',
            externalIds: { internal: 'catalog-book' },
            image: '/cover-card',
            subtitle: 'Writer',
            progress: 50,
            isPlayed: false,
        });
    });
    it('opens the catalog id even when ids contains only public book identifiers', () => {
        openAudiobook(book);
        expect(openMediaModal).toHaveBeenCalledWith(
            expect.objectContaining({
                externalIds: { isbn: '9780000000001', internal: 'catalog-book' },
            }),
            '/cover',
        );
    });
});
