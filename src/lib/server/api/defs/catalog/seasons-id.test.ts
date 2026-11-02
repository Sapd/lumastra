// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { resolveImageSets } from '$lib/server/services/image-descriptor/index.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { getSeasonsByInternalId, getSeriesOrdering } from '$lib/server/database/queries/season-detail.queries.js';

vi.mock('$lib/server/services/image-descriptor/index.js', () => ({
    resolveImageSets: vi.fn().mockResolvedValue(new Map()),
}));
vi.mock('$lib/server/database/connection.js', () => ({
    getDb: vi.fn().mockReturnValue({}),
}));
vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: vi.fn().mockResolvedValue(true),
}));
vi.mock('$lib/server/config.js', () => ({
    config: { METADATA_ADDITIONAL_LANGUAGES: [] },
}));
const seasonId = '11111111-1111-4111-8111-111111111111';
const seriesId = '22222222-2222-4222-8222-222222222222';

vi.mock('$lib/server/database/queries/media-lookup.queries.js', () => ({
    getMediaNavContext: vi.fn(async () => ({ series_id: seriesId })),
}));
vi.mock('$lib/server/database/queries/season-detail.queries.js', () => ({
    getSeriesOrdering: vi.fn().mockResolvedValue('standard'),
    getSeasonsByInternalId: vi.fn(async () => [
        { id: seasonId, season_number: 1, name: 'Season 1' },
    ]),
}));
vi.mock('$lib/server/database/queries/episode-detail.queries.js', () => ({
    getSeriesEpisodesWithWatchState: vi.fn().mockResolvedValue([]),
}));
vi.mock('./series/resolve-series-id.js', () => ({
    resolveSeriesId: vi.fn(async () => '22222222-2222-4222-8222-222222222222'),
}));
vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext: vi.fn(),
    searchAccessBoundary: () => ({ library: { kind: 'all' }, age: { kind: 'any' } }),
}));

const { def } = await import('./seasons-id.js');

beforeEach(() => {
    vi.clearAllMocks();
});

describe('GET /seasons/{id} — image inheritance', () => {
    it.each([undefined, 'none'] as const)('passes inherit=%s to the resolver', async (inherit) => {
        const url = new URL(`http://localhost/api/v1/seasons/${seasonId}`);
        if (inherit) url.searchParams.set('inherit', inherit);
        const event = {
            url,
            params: { id: seasonId },
            locals: {
                resolvedIds: { internalId: seasonId, source: 'uuid' },
                user: { userId: 'user-uuid' },
            },
        } as unknown as RequestEvent;
        const response = await def.handlers.GET!(event, {
            surface: 'internal',
            input: {
                body: undefined,
                params: undefined,
                query: def.request!.query!.parse(Object.fromEntries(url.searchParams)),
            },
        });
        expect(response.status).toBe(200);
        expect(resolveImageSets).toHaveBeenCalledWith(
            {},
            'internal',
            [{ id: seasonId, mediaType: 'season' }],
            inherit === 'none' ? { inherit: 'none' } : undefined,
        );
        expect((await response.json()).id).toBe(seasonId);
        expect(def.docsByPath!('/seasons/{id}')!.GET!.query!.parse({ inherit })).toEqual({
            inherit,
        });
    });
});

function seasonsEvent(pathname: string, params: Record<string, string>): RequestEvent {
    return {
        url: new URL(`http://localhost${pathname}`),
        params,
        locals: { resolvedIds: undefined, user: { userId: 'user-uuid' } },
    } as unknown as RequestEvent;
}

async function get(pathname: string, params: Record<string, string>): Promise<Response> {
    return def.handlers.GET!(seasonsEvent(pathname, params), {
        surface: 'v1',
        input: { body: undefined, params: undefined, query: {} },
    } as never);
}

describe('GET seasons — access and identity gates', () => {
    beforeEach(() => {
        vi.mocked(checkMediaAccess).mockResolvedValue(true);
        vi.mocked(getSeriesOrdering).mockResolvedValue('standard');
    });

    it.each([
        ['/api/v1/series/' + seriesId + '/seasons', { id: seriesId }],
        ['/api/v1/series/' + seriesId + '/seasons/1', { id: seriesId, n: '1' }],
        ['/api/v1/seasons/' + seasonId, { id: seasonId }],
    ])('returns 404 when the series is not accessible: %s', async (pathname, params) => {
        vi.mocked(checkMediaAccess).mockResolvedValue(false);
        const res = await get(pathname, params);
        expect(res.status).toBe(404);
        expect(getSeasonsByInternalId).not.toHaveBeenCalled();
    });

    it('returns 404 for a flat virtual handle whose ordering no longer matches', async () => {
        const res = await get(`/api/v1/seasons/vseason:${seriesId}:dvd:1`, {
            id: `vseason:${seriesId}:dvd:1`,
        });
        expect(res.status).toBe(404);
    });

    it('returns 404 for a flat id that is neither a UUID nor a virtual handle', async () => {
        const res = await get('/api/v1/seasons/not-a-uuid', { id: 'not-a-uuid' });
        expect(res.status).toBe(404);
        expect(getSeasonsByInternalId).not.toHaveBeenCalled();
    });
});
