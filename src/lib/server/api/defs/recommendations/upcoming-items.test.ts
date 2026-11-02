// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for buildUpcomingItems (defs/recommendations/upcoming.ts) —
 * the shared mapper behind GET /upcoming?view=episodes and ?view=alerts.
 *
 * Background: this item used to be constructed at two separate call sites (the
 * cache-hit path and the fresh-fetch path) which drifted apart, and BOTH
 * emitted `media.id = 'sonarr:<id>:series'` with `ids = {sonarr}` only. The
 * tvdb/tmdb ids that transformSonarrToMediaItem already computes were dropped
 * because the local row type didn't declare `externalIds` — so a client had no
 * internal id to resolve or play the series with.
 *
 * These tests pin: real UUID resolution when the series is in the catalogue,
 * the composite fallback when it isn't (an upcoming series legitimately may not
 * be), and that resolution is batched and composite-keyed by media type.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { config } from '$lib/server/config.js';
afterAll(() => vi.restoreAllMocks());

vi.mock('$lib/server/services/image-descriptor/resolver.js', async () => {
    const { buildImageSet } = await import('$lib/shared/image-descriptor.js');
    return {
        resolveImageSets: vi.fn(
            async (
                _sql: unknown,
                surface: import('$lib/shared/api-urls.js').ApiSurface,
                items: Array<{ id: string }>,
            ) =>
                new Map(
                    items.map(({ id }) => [
                        id,
                        buildImageSet(surface, {
                            poster: { ownerId: id, source: 'self' },
                            backdrop: { ownerId: id, source: 'self' },
                        }),
                    ]),
                ),
        ),
    };
});

const mockBatchResolve = vi.fn();
vi.mock('$lib/server/database/queries/external-ids.queries.js', () => ({
    batchResolvePrimaryExternalId: (...args: unknown[]) => mockBatchResolve(...args),
}));

const mockFilterAccessible = vi.fn();
vi.mock('$lib/server/utils/media-access-batch.js', () => ({
    filterAccessibleMediaIds: (...args: unknown[]) => mockFilterAccessible(...args),
}));

const { buildUpcomingItems } = await import('./upcoming.js');

const SQL = vi.fn(async () => []) as unknown as import('postgres').Sql;
const SERIES_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function makeRow(overrides: Record<string, unknown> = {}) {
    return {
        seriesName: 'Starhaven',
        title: 'Cold Harbor',
        seasonNumber: 2,
        episodeNumber: 10,
        sonarrAirDate: '2026-08-01T00:00:00Z',
        overview: 'The finale.',
        sonarrSeriesId: 42,
        externalIds: { tmdb: '95396', tvdb: '371980', imdb: 'tt11280740' },
        ...overrides,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(config, 'SHOW_UNAVAILABLE_MEDIA', 'get').mockReturnValue(true);
    mockBatchResolve.mockResolvedValue(new Map());
});

describe('buildUpcomingItems', () => {
    it('carries the catalog series identity in episode context, without internal provider ids', async () => {
        mockBatchResolve.mockResolvedValue(new Map([['95396:tv', SERIES_UUID]]));
        const [item] = await buildUpcomingItems(SQL, [makeRow()]);
        expect(item.type).toBe('episode');
        expect(item.catalogId).toBeNull();
        expect(item.context?.series).toEqual({
            id: SERIES_UUID,
            catalogId: SERIES_UUID,
            title: 'Starhaven',
        });
        expect(item.ids).not.toHaveProperty('internal');
    });
    it('uses a resolvable discovery series handle instead of sonarr identity', async () => {
        const [item] = await buildUpcomingItems(SQL, [makeRow()]);
        expect(item.id).toBe('tmdb:95396:series');
        expect(item.context?.series?.id).toBe('tmdb:95396:series');
        expect(item.catalogId).toBeNull();
        expect(item.id).not.toContain('sonarr:');
    });
    it('omits rows with no resolvable series identity', async () => {
        expect(await buildUpcomingItems(SQL, [makeRow({ externalIds: undefined })])).toEqual([]);
        expect(mockBatchResolve).not.toHaveBeenCalled();
    });
    it('resolves with composite provider id and type, batched and deduplicated', async () => {
        await buildUpcomingItems(SQL, [
            makeRow(),
            makeRow({ episodeNumber: 2 }),
            makeRow({ externalIds: { tmdb: '1399' } }),
        ]);
        expect(mockBatchResolve).toHaveBeenCalledTimes(1);
        expect(mockBatchResolve).toHaveBeenCalledWith(SQL, [
            { tmdbId: '95396', mediaType: 'tv' },
            { tmdbId: '1399', mediaType: 'tv' },
        ]);
    });
    it('exposes episode coordinates and display text without parsing a reason label', async () => {
        const [item] = await buildUpcomingItems(SQL, [makeRow()]);
        expect(item.context).toMatchObject({
            seasonNumber: 2,
            episodeNumber: 10,
            airDate: '2026-08-01T00:00:00Z',
        });
        expect(item.title).toBe('Cold Harbor');
        expect(item.overview).toBe('The finale.');
        expect(item.reason).toEqual({ kind: 'upcoming', label: 'S2E10' });
    });
    it('uses the real episode UUID when ingested', async () => {
        const episodeId = 'bbbbbbbb-0000-4000-8000-000000000001';
        mockBatchResolve.mockResolvedValue(new Map([['95396:tv', SERIES_UUID]]));
        const sql = vi.fn(async () => [
            {
                id: episodeId,
                series_id: SERIES_UUID,
                season_number: 2,
                episode_number: 10,
                has_files: true,
            },
        ]) as unknown as import('postgres').Sql;
        const [item] = await buildUpcomingItems(sql, [makeRow()]);
        expect(item.id).toBe(episodeId);
        expect(item.catalogId).toBe(episodeId);
        expect(item.availability?.hasFile).toBe(true);
    });
    it('handles a row with no series name', async () => {
        const [item] = await buildUpcomingItems(SQL, [makeRow({ seriesName: undefined })]);
        expect(item.context?.series?.title).toBe('');
    });
    it('falls back to the provider handle and no episode id when the caller cannot open the series', async () => {
        mockBatchResolve.mockResolvedValue(new Map([['95396:tv', SERIES_UUID]]));
        mockFilterAccessible.mockResolvedValue(new Set());
        const sql = vi.fn(async () => [
            {
                id: 'bbbbbbbb-0000-4000-8000-000000000001',
                series_id: SERIES_UUID,
                season_number: 2,
                episode_number: 10,
                has_files: true,
            },
        ]) as unknown as import('postgres').Sql;
        const access = { library: { kind: 'all' }, age: { kind: 'any' } } as never;
        const [item] = await buildUpcomingItems(sql, [makeRow()], 'v1', access);
        expect(mockFilterAccessible).toHaveBeenCalledWith(sql, [SERIES_UUID], access);
        expect(item.catalogId).toBeNull();
        expect(item.id).toBe('tmdb:95396:series');
        expect(item.id).not.toBe('bbbbbbbb-0000-4000-8000-000000000001');
        expect(item.context?.series?.catalogId).toBeNull();
    });
});
