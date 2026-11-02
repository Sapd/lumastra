// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { MediaPreview } from '$lib/schemas/api-media-preview.js';
import type { ApiContext } from '$lib/server/api/define.js';
import type {
    AccessContext,
    RecommendationItem,
    RecommenderOptions,
    RecommenderResult,
} from './recommender.js';

const { mockBuildAccessContext, mockGetRailItems } = vi.hoisted(() => ({
    mockBuildAccessContext: vi.fn(),
    mockGetRailItems: vi.fn(),
}));

vi.mock('./recommender.js', () => ({
    buildAccessContext: mockBuildAccessContext,
    getRailItems: mockGetRailItems,
    UnknownRailError: class UnknownRailError extends Error {},
}));

vi.mock('$lib/server/services/image-descriptor/resolver.js', () => ({
    resolveImageSets: vi.fn(async () => new Map()),
}));

const { def } = await import('./recommendations.js');

function recommendation(id: string, type: 'movie' | 'series'): RecommendationItem {
    return { media: { id: `tmdb:${id.split('-')[1]}:${type}`, type, title: id, ids: {} } };
}

function makeEvent(query: string): RequestEvent {
    const url = new URL(`http://localhost/api/v1/recommendations${query}`);
    return {
        locals: { user: { userId: 'u1', username: 'alice', isAgeRestricted: false } },
        url,
        params: {},
        request: new Request(url),
    } as unknown as RequestEvent;
}

async function get(query: string): Promise<{
    status: number;
    body: {
        items: MediaPreview[];
        page: { limit: number; offset: number; hasMore: boolean; total?: number };
    };
}> {
    const response = (await def.handlers.GET!(makeEvent(query), {
        surface: 'v1',
    } as ApiContext)) as Response;
    return { status: response.status, body: await response.json() };
}

describe('GET /recommendations types pagination', () => {
    const ctx = { userId: 'u1', isAgeRestricted: false } as AccessContext;
    const mixed = [
        recommendation('series-1', 'series'),
        recommendation('series-2', 'series'),
        recommendation('movie-1', 'movie'),
        recommendation('series-3', 'series'),
        recommendation('movie-2', 'movie'),
        recommendation('series-4', 'series'),
        recommendation('movie-3', 'movie'),
        recommendation('movie-4', 'movie'),
        recommendation('series-5', 'series'),
        recommendation('movie-5', 'movie'),
    ];

    beforeEach(() => {
        vi.clearAllMocks();
        mockBuildAccessContext.mockResolvedValue(ctx);
        mockGetRailItems.mockImplementation(
            async (_type: string, _ctx: AccessContext, opts: RecommenderOptions) => {
                const scoped = opts.mediaTypes
                    ? mixed.filter((item) => opts.mediaTypes!.has(item.media.type))
                    : mixed;
                const offset = opts.offset ?? 0;
                return {
                    items: scoped.slice(offset, offset + opts.limit),
                    hasMore: scoped.length > offset + opts.limit,
                    total: scoped.length,
                } satisfies RecommenderResult;
            },
        );
    });

    it('filters before offset and returns a full middle page with a filtered hasMore', async () => {
        const { status, body } = await get('?type=for-you&limit=2&offset=2&types=movie');

        expect(status).toBe(200);
        expect(body.items.map((item) => item.id)).toEqual(['tmdb:3:movie', 'tmdb:4:movie']);
        expect(body.page).toEqual({ limit: 2, offset: 2, hasMore: true, total: 5 });
        expect(mockGetRailItems).toHaveBeenCalledWith(
            'for-you',
            ctx,
            expect.objectContaining({
                limit: 2,
                offset: 2,
                mediaTypes: new Set(['movie']),
                mediaType: 'movie',
            }),
        );
    });

    it('returns the final filtered page with hasMore false', async () => {
        const { body } = await get('?type=for-you&limit=2&offset=4&types=movie');

        expect(body.items.map((item) => item.id)).toEqual(['tmdb:5:movie']);
        expect(body.page.hasMore).toBe(false);
        expect(body.page.total).toBe(5);
    });

    it('leaves the unfiltered strategy pagination contract untouched', async () => {
        await get('?type=for-you&limit=2&offset=4');

        expect(mockGetRailItems).toHaveBeenCalledOnce();
        expect(mockGetRailItems).toHaveBeenCalledWith(
            'for-you',
            ctx,
            expect.objectContaining({ limit: 2, offset: 4 }),
        );
    });

    it('rejects an invalid media type before dispatching a strategy', async () => {
        const { status } = await get('?types=movie,podcast');

        expect(status).toBe(422);
        expect(mockGetRailItems).not.toHaveBeenCalled();
    });
});
