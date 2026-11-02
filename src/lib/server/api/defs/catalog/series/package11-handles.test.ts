// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
const mocks = vi.hoisted(() => ({ external: vi.fn(), provider: vi.fn() }));
vi.mock('$lib/server/database/queries/media-queries.js', () => ({
    getMediaExternalIds: mocks.external,
    resolveMediaIdByProvider: mocks.provider,
    resolveJellyfinIdToMediaId: vi.fn().mockResolvedValue(null),
}));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/cache/valkey.js', () => ({
    getValkeyClient: () => undefined,
    subscribeToChannel: vi.fn(async () => undefined),
}));
import { mediaIdResolver } from '$lib/server/services/media-id-resolver.js';
import { buildVirtualSeasonHandle } from '$lib/server/services/media-handle.js';
import { resolveSeriesId } from './resolve-series-id.js';
const series = '11111111-1111-4111-8111-111111111111';
function event(id: string): RequestEvent {
    return {
        params: { id },
        url: new URL('http://localhost/api/v1/series/ignored?externalId=tmdb:999:movie'),
    } as unknown as RequestEvent;
}
describe('package 11 series and virtual season resolution', () => {
    it.each([series, 'tmdb:81189:series', 'tvdb:81189:series', 'imdb:tt0903747:series'])(
        'accepts %s as a series path handle',
        async (id) => {
            mocks.provider.mockResolvedValue(series);
            mocks.external.mockResolvedValue({
                internalId: series,
                mediaType: 'tv',
                status: 'active',
                externalIds: {},
                canonicalId: null,
            });
            expect(await resolveSeriesId(event(id))).toBe(series);
        },
    );
    it('returns a virtualSeason kind without borrowing a catalog UUID', async () => {
        const handle = buildVirtualSeasonHandle(series, 'dvd', 2);
        const result = await mediaIdResolver.resolveAnyMediaId(handle);
        expect(result).toMatchObject({
            kind: 'virtualSeason',
            internalId: null,
            mediaType: 'season',
            virtualSeason: { seriesUuid: series, ordering: 'dvd', seasonNumber: 2 },
        });
    });
    it.each([
        `vseason:${series}:standard:1`,
        `vseason:${series}:dvd:-1`,
        'vseason:bad:dvd:1',
        `vseason:${series}:dvd:1junk`,
    ])('rejects malformed/non-virtual handle %s', async (id) => {
        await expect(mediaIdResolver.resolveAnyMediaId(id)).rejects.toThrow(
            'Invalid media ID format',
        );
    });
    it('does not accept a movie handle as a series', async () => {
        const movie = '22222222-2222-4222-8222-222222222222';
        mocks.provider.mockResolvedValue(movie);
        mocks.external.mockResolvedValue({
            internalId: movie,
            mediaType: 'movie',
            status: 'active',
            externalIds: {},
            canonicalId: null,
        });
        expect(await resolveSeriesId(event('tmdb:999:movie'))).toBeNull();
    });
});
