// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
const { resolveAnyMediaId } = vi.hoisted(() => ({ resolveAnyMediaId: vi.fn() }));
vi.mock('$lib/server/services/media-id-resolver.js', () => ({
    mediaIdResolver: { resolveAnyMediaId },
}));
import { resolveSeriesId } from './resolve-series-id.js';
import {
    buildVirtualSeasonHandle,
    parseVirtualSeasonHandle,
} from '$lib/server/services/media-handle.js';
const uuid = '11111111-1111-4111-8111-111111111111';
beforeEach(() => {
    resolveAnyMediaId.mockReset();
});
describe('series identity', () => {
    it.each([uuid, 'tvdb:81189:series', 'tmdb:1396:series', 'imdb:tt0903747:series'])(
        'resolves the path handle %s, ignoring query overrides',
        async (id) => {
            resolveAnyMediaId.mockResolvedValue({ internalId: uuid, mediaType: 'tv' });
            const event = {
                params: { id },
                url: new URL('http://localhost/?externalId=tmdb:1:series'),
            } as unknown as RequestEvent;
            expect(await resolveSeriesId(event)).toBe(uuid);
            expect(resolveAnyMediaId).toHaveBeenCalledExactlyOnceWith(id);
        },
    );
    it('rejects non-series and missing catalog identities', async () => {
        const event = { params: { id: uuid } } as unknown as RequestEvent;
        resolveAnyMediaId.mockResolvedValue({ internalId: uuid, mediaType: 'movie' });
        expect(await resolveSeriesId(event)).toBeNull();
        resolveAnyMediaId.mockResolvedValue({ internalId: null, mediaType: 'series' });
        expect(await resolveSeriesId(event)).toBeNull();
    });
    it('round trips all virtual orderings and rejects malformed handles', () => {
        for (const ordering of ['dvd', 'absolute', 'regional', 'other'] as const) {
            expect(parseVirtualSeasonHandle(buildVirtualSeasonHandle(uuid, ordering, 0))).toEqual({
                seriesUuid: uuid,
                ordering,
                seasonNumber: 0,
            });
        }
        expect(parseVirtualSeasonHandle(`vseason:${uuid}:dvd:-1`)).toBeNull();
        expect(parseVirtualSeasonHandle(`vseason:${uuid}:dvd:1junk`)).toBeNull();
    });
});
