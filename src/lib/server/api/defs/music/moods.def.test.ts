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

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { MusicMoodsResponseSchema } from '$lib/schemas/api-music-responses.js';

const mockGetSql = vi.fn();
const mockListMoodKeys = vi.fn();
const mockGetCachedMoodPage = vi.fn();
const mockFeatures: Record<string, unknown> = {};

vi.mock('$lib/server/config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config.js')>();
    Object.assign(mockFeatures, actual.features);
    return { ...actual, features: mockFeatures };
});
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: (...args: unknown[]) => mockGetSql(...args) },
}));
vi.mock('$lib/server/database/queries/sonic-queue.queries.js', async (importOriginal) => ({
    ...(await importOriginal<
        typeof import('$lib/server/database/queries/sonic-queue.queries.js')
    >()),
    listMoodKeysWithVectors: (...args: unknown[]) => mockListMoodKeys(...args),
}));
vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext: vi.fn(async () => ({ deniedGroupIds: [], ageRating: null })),
}));
vi.mock('$lib/server/services/music/mood-page.service.js', () => ({
    DEFAULT_MOOD_PAGE_LIMIT: 20,
    getCachedMoodPage: (...args: unknown[]) => mockGetCachedMoodPage(...args),
}));

const { def } = await import('./moods.js');

function makeEvent(): RequestEvent {
    const url = 'http://localhost/api/v1/music/moods';
    return {
        locals: { user: { userId: 'u1', username: 'alice' } },
        url: new URL(url),
        params: {},
        request: new Request(url),
    } as unknown as RequestEvent;
}

const ctx = { surface: 'v1' } as never;

async function moods(): Promise<Array<Record<string, unknown>>> {
    const res = await def.handlers.GET!(makeEvent(), ctx);
    expect(res.status).toBe(200);
    return MusicMoodsResponseSchema.parse(await res.json()).moods;
}

describe('music/moods artwork', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockFeatures.sonicQueue = true;
        mockGetSql.mockResolvedValue({});
        mockListMoodKeys.mockResolvedValue(['music:chill', 'music:workout']);
        mockGetCachedMoodPage.mockImplementation(async (_sql: unknown, mood: string) => ({
            rows:
                mood === 'chill'
                    ? [
                          { id: 't1', album_id: 'al1' },
                          { id: 't2', album_id: 'al1' },
                          { id: 't3', album_id: null },
                      ]
                    : [],
            nextCursor: null,
        }));
    });

    it('gives each mood a collage of the albums on its default page', async () => {
        const [chill, workout] = await moods();
        expect(chill.key).toBe('chill');
        expect(
            (chill.images as { primary: { variants: { card: string } } }).primary.variants.card,
        ).toContain(
            // Album ids de-duplicated; a track with no album falls back to itself.
            '/api/v1/music/images/collage?ids=al1,t3&size=card&v=',
        );
        // Nothing to draw → no images; the client falls back to the emoji.
        expect(workout.key).toBe('workout');
        expect(workout).not.toHaveProperty('images');
        expect(mockGetCachedMoodPage).toHaveBeenCalledWith(
            expect.anything(),
            'chill',
            20,
            expect.anything(),
        );
    });

    it('never fails the list when one mood’s page errors', async () => {
        mockGetCachedMoodPage.mockRejectedValueOnce(new Error('pgvector down'));
        const list = await moods();
        expect(list.map((m) => m.key)).toEqual(['chill', 'workout']);
        expect(list[0]).not.toHaveProperty('images');
    });

    it('skips cover lookups entirely with sonicQueue off', async () => {
        mockFeatures.sonicQueue = false;
        const list = await moods();
        expect(list).toHaveLength(2);
        expect(mockGetCachedMoodPage).not.toHaveBeenCalled();
    });
});
