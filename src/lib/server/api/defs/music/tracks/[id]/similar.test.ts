// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

vi.mock('$lib/server/database/queries/image-descriptor.queries.js', async () => {
    const { musicImageOwnerFixture } =
        await import('$lib/server/services/music/__tests__/image-fixtures.js');
    return {
        getImageDescriptorOwners: vi.fn(async (_sql: unknown, ids: string[]) =>
            ids.map((id) => musicImageOwnerFixture(id)),
        ),
    };
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { SimilarTracksResponseSchema } from '$lib/schemas/api-music-responses';

const { getSimilarTracks } = vi.hoisted(() => ({ getSimilarTracks: vi.fn() }));
vi.mock('$lib/server/config.js', () => ({
    config: {},
    features: { sonicEmbeddings: false },
    FEATURE_PER_TASK_QUEUES: false,
}));
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: vi.fn(async () => ({})) },
}));
vi.mock('$lib/server/database/queries/music.queries.js', () => ({
    getTrackDetail: vi.fn(async () => ({ id: 'source' })),
    getSimilarTracks,
}));
vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: vi.fn(async () => true),
}));
vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext: vi.fn(async () => ({})),
    scopedCacheKey: vi.fn(() => 'key'),
    searchAccessBoundary: (context: unknown) => context,
}));
vi.mock('$lib/server/utils/media-access-batch.js', () => ({
    filterAccessibleRows: vi.fn(async (_sql: unknown, rows: unknown[]) => rows),
}));
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import { def } from './similar';

beforeEach(() => vi.clearAllMocks());

function eventFor(query: string): RequestEvent {
    return {
        params: { id: 'source' },
        locals: { user: { userId: 'user', username: 'listener' } },
        url: new URL(`https://example.test/api/v1/music/tracks/source/similar?${query}`),
    } as unknown as RequestEvent;
}

describe('bounded similar tracks (metadata basis)', () => {
    it.each([0, 2, 3])('reports truncation honestly for %i candidates', async (count) => {
        getSimilarTracks.mockResolvedValue(
            Array.from({ length: count }, (_, i) => ({
                id: `track-${i}`,
                title: `Track ${i}`,
                custom_metadata: {},
            })),
        );
        const response = await def.handlers.GET!(eventFor('limit=2'), {
            surface: 'v1',
            input: { query: { basis: 'auto', limit: 2 } },
        } as never);
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(SimilarTracksResponseSchema.parse(body)).toEqual(body);
        expect(body.source).toBe('metadata');
        expect(body.items).toHaveLength(Math.min(count, 2));
        expect(body.page).toEqual({ limit: 2, truncated: count > 2 });
        expect(body.page).not.toHaveProperty('hasMore');
        expect(body.page).not.toHaveProperty('offset');
        expect(getSimilarTracks).toHaveBeenCalledWith(expect.anything(), 'source', 7);
    });

    it('rejects basis=sonic when the server has no sonic embeddings', async () => {
        const response = await def.handlers.GET!(eventFor('basis=sonic'), {
            surface: 'v1',
            input: { query: { basis: 'sonic', limit: 20 } },
        } as never);
        expect(response.status).toBe(422);
        expect(getSimilarTracks).not.toHaveBeenCalled();
    });
});
