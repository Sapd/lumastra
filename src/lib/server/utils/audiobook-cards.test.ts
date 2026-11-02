// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { audiobookRowToPreview, bookProgress } from './audiobook-cards.js';
import { MediaPreviewSchema } from '$lib/schemas/api-media-preview.js';
import { PlaybackProgressSchema } from '$lib/schemas/api-playback-progress.js';
import { AudiobookPreviewSchema } from '$lib/schemas/api-audiobook-preview.js';
import { buildImageSet } from '$lib/shared/image-descriptor.js';
import type { CatalogBookRow } from '$lib/server/database/queries/audiobook-catalog.queries.js';
const id = '11111111-1111-4111-8111-111111111111';
function row(overrides: Partial<CatalogBookRow> = {}): CatalogBookRow {
    return {
        id,
        title: 'A book',
        year: 2020,
        ids: { isbn: '9780000000001' },
        authors: [{ id, name: 'Writer' }],
        narrators: [],
        series: null,
        position_ms: null,
        duration_ms: '3600000',
        finished: false,
        state_id: null,
        updated_at: null,
        ...overrides,
    };
}
describe('audiobook preview mapping', () => {
    it('uses catalog identity, person references and the own cover descriptor', () => {
        const images = buildImageSet('v1', {
            primary: { ownerId: id, urlRole: 'poster', source: 'self', revision: 'cover2' },
        });
        const item = audiobookRowToPreview(row(), images);
        expect(AudiobookPreviewSchema.parse(item)).toEqual(item);
        expect(MediaPreviewSchema.parse(item)).toEqual(item);
        expect(item.availability).toEqual({ isAvailable: true, hasFile: true, canRequest: false });
        expect(item).toMatchObject({
            id,
            catalogId: id,
            type: 'audiobook',
            audiobook: { authors: [{ id, name: 'Writer' }] },
        });
        expect(item.images.primary?.href).toContain('/api/v1/media/' + id + '/images/poster?');
        for (const key of ['score', 'clickData', 'externalIds', 'mediaType', 'isPlayed'])
            expect(item).not.toHaveProperty(key);
        expect(item.progress).toBeUndefined();
        expect(bookProgress(row({ state_id: id, position_ms: '0' }))).toBeUndefined();
    });
    it('aggregates completion on a collapsed series representative', () => {
        const item = audiobookRowToPreview(
            row({
                state_id: id,
                position_ms: '900000',
                series_finished_count: '1',
                series_duration_ms: '14400000',
                series: { id, name: 'Cycle', position: 1, bookCount: 4 },
            }),
            {},
        );
        expect(item.progress).toMatchObject({
            positionMs: 3600000,
            durationMs: 14400000,
            fraction: 0.25,
            finished: false,
        });
        expect(item.audiobook.series?.bookCount).toBe(4);
    });
    it('represents unknown duration, reset finished position and bounded fraction', () => {
        expect(
            bookProgress(
                row({ state_id: id, finished: true, position_ms: '0', duration_ms: null }),
            ),
        ).toEqual({
            positionMs: 0,
            durationMs: null,
            fraction: 1,
            finished: true,
            updatedAt: null,
        });
        expect(bookProgress(row({ state_id: id, position_ms: '9999999' }))?.fraction).toBe(1);
        expect(bookProgress(row({ state_id: id, position_ms: '9999999' }))?.positionMs).toBe(
            3600000,
        );
        expect(bookProgress(row({ state_id: id, finished: true, position_ms: '0' }))).toMatchObject(
            { positionMs: 0, fraction: 1 },
        );
        expect(
            bookProgress(row({ state_id: id, position_ms: '100', duration_ms: '0' }))?.fraction,
        ).toBeNull();
        expect(
            PlaybackProgressSchema.parse(
                bookProgress(
                    row({
                        state_id: id,
                        position_ms: '900000',
                        updated_at: new Date('2026-10-17T12:00:00Z'),
                    }),
                ),
            ),
        ).toMatchObject({
            positionMs: 900000,
            durationMs: 3600000,
            fraction: 0.25,
            finished: false,
            updatedAt: '2026-10-17T12:00:00.000Z',
        });
        for (const position_ms of ['0', null]) {
            expect(
                bookProgress(row({ state_id: id, position_ms, updated_at: new Date() })),
            ).toBeUndefined();
        }
    });
});
