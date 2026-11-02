// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi, beforeEach, afterAll } from 'vitest';
import { config } from '$lib/server/config.js';
afterAll(() => vi.restoreAllMocks());
import type postgres from 'postgres';
const series = '123e4567-e89b-42d3-a456-426614174000';
const episode = '123e4567-e89b-42d3-a456-426614174001';
const mocks = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock('$lib/server/database/queries/external-ids.queries.js', () => ({
    batchResolvePrimaryExternalId: mocks.resolve,
}));
vi.mock('$lib/server/services/image-descriptor/resolver.js', () => ({
    resolveImageSets: vi.fn(async () => new Map()),
}));
import { buildUpcomingItems } from './upcoming.js';

beforeEach(() => {
    vi.spyOn(config, 'SHOW_UNAVAILABLE_MEDIA', 'get').mockReturnValue(true);
});

describe('upcoming episode preview mapper', () => {
    it('uses the episode UUID and typed coordinates when the episode exists', async () => {
        mocks.resolve.mockResolvedValue(new Map([['123:tv', series]]));
        const sql = vi.fn(async () => [
            {
                id: episode,
                series_id: series,
                season_number: 2,
                episode_number: 4,
                has_files: true,
            },
        ]);
        const items = await buildUpcomingItems(sql as unknown as postgres.Sql, [
            {
                externalIds: { tmdb: '123' },
                title: 'Episode Four',
                seriesName: 'Show',
                seasonNumber: 2,
                episodeNumber: 4,
                sonarrAirDate: '2026-10-17',
            },
        ]);
        expect(items[0]).toMatchObject({
            id: episode,
            catalogId: episode,
            type: 'episode',
            title: 'Episode Four',
            context: {
                series: { id: series, catalogId: series, title: 'Show' },
                seasonNumber: 2,
                episodeNumber: 4,
                airDate: '2026-10-17',
            },
            availability: { isAvailable: true },
            reason: { kind: 'upcoming', label: 'S2E4' },
        });
    });
    it('uses a resolvable TMDB series handle for a discovery episode', async () => {
        mocks.resolve.mockResolvedValue(new Map());
        const items = await buildUpcomingItems({} as postgres.Sql, [
            {
                externalIds: { tmdb: '123' },
                title: 'Pilot',
                seriesName: 'Show',
                seasonNumber: 1,
                episodeNumber: 1,
            },
        ]);
        expect(items[0]).toMatchObject({ id: 'tmdb:123:series', catalogId: null, type: 'episode' });
    });
    it('hides unavailable episode occurrences and discovery fallbacks when hiding is enabled', async () => {
        vi.spyOn(config, 'SHOW_UNAVAILABLE_MEDIA', 'get').mockReturnValue(false);
        mocks.resolve.mockResolvedValue(new Map([['123:tv', series]]));
        const sql = vi.fn(async () => [
            {
                id: episode,
                series_id: series,
                season_number: 1,
                episode_number: 1,
                has_files: false,
            },
        ]);
        const rows = [
            { externalIds: { tmdb: '123' }, title: 'Hidden', seasonNumber: 1, episodeNumber: 1 },
        ];
        expect(await buildUpcomingItems(sql as unknown as postgres.Sql, rows)).toEqual([]);
        mocks.resolve.mockResolvedValue(new Map());
        expect(await buildUpcomingItems({} as postgres.Sql, rows)).toEqual([]);
    });

    it('drops Sonarr-only rows instead of emitting unresolvable or empty IDs', async () => {
        mocks.resolve.mockResolvedValue(new Map());
        expect(
            await buildUpcomingItems({} as postgres.Sql, [{ sonarrSeriesId: 99, title: 'Pilot' }]),
        ).toEqual([]);
    });
});
