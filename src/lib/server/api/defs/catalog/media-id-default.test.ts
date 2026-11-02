// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
const id = '123e4567-e89b-42d3-a456-426614174000';
const rich = vi.hoisted(() => ({
    genres: ['Action'],
    runtime: 90,
    ratings: { imdb: 8 },
    trailerUrl: 'https://example.com/trailer',
    certification: 'PG',
    extras: [{ title: 'Trailer' }],
}));
vi.mock('$lib/server/database/queries/media-lookup.queries.js', () => ({
    getMediaDetailsById: vi.fn(async () => ({
        title: 'Film',
        media_type: 'movie',
        year: 2026,
        overview: 'Synopsis',
        runtime_minutes: 90,
        is_available: true,
    })),
    getExternalIdsByMediaId: vi.fn(async () => []),
    buildExternalIdsObject: vi.fn(() => ({})),
    getMediaNavContext: vi.fn(async () => null),
}));
vi.mock('$lib/server/database/queries/media-items.queries.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/database/queries/media-items.queries.js')>()),
    // No probed file: durationMs falls back to runtime_minutes * 60000.
    findPlaybackDurationMs: vi.fn(async () => null),
}));
vi.mock('$lib/server/database/queries/media-details.queries.js', () => ({
    getMediaDetailByUuid: vi.fn(async () => ({ media_type: 'movie', genres: ['Action'] })),
}));
vi.mock('$lib/server/database/queries/media-stream-summary.queries.js', () => ({
    getMediaStreamSummary: vi.fn(async () => ({})),
}));
vi.mock('$lib/server/services/image-descriptor/resolver.js', () => ({
    resolveImageSet: vi.fn(async () => ({})),
}));
vi.mock('$lib/server/utils/api-transforms.js', () => ({
    toDbMediaRow: vi.fn(() => ({})),
    transformToMediaDetail: vi.fn(() => rich),
    toNodeDetailsExtra: vi.fn(() => ({ ...rich })),
}));
import { buildMediaDetail } from './media-id.js';

describe('media detail defaults', () => {
    it('returns rich metadata, images and millisecond progress with no includes', async () => {
        const sql = vi.fn(async () => []) as unknown as Sql;
        const body = await buildMediaDetail(sql, id, 'v1', '', undefined);
        expect(body).toMatchObject({
            id,
            catalogId: id,
            overview: 'Synopsis',
            durationMs: 5400000,
            images: {},
            progress: { positionMs: null, durationMs: 5400000, finished: false },
            details: expect.objectContaining({
                genres: ['Action'],
                ratings: { imdb: 8 },
                trailerUrl: 'https://example.com/trailer',
                certification: 'PG',
            }),
        });
        expect(body).not.toHaveProperty('runtimeMinutes');
        expect(body).not.toHaveProperty('genres');
        expect(body).not.toHaveProperty('ratings');
        expect(body).not.toHaveProperty('trailer');
        expect(body).not.toHaveProperty('certification');
        expect(body?.details).not.toHaveProperty('runtime');
        expect(body?.details).not.toHaveProperty('extras');
    });
    it('keeps heavy extras opt-in', async () => {
        const sql = vi.fn(async () => []) as unknown as Sql;
        const body = await buildMediaDetail(sql, id, 'v1', 'extras', undefined);
        expect(body?.details).toHaveProperty('extras');
    });
});
