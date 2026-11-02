// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import type { RequestEvent } from '@sveltejs/kit';
import {
    getTestDb,
    closeTestDb,
} from '../../../../../../../tests/integration/setup/test-database.js';
import {
    truncateTables,
    TEST_TABLES,
} from '../../../../../../../tests/integration/helpers/cleanup.js';
import { createAndInsertTestTvShow } from '../../../../../../../tests/integration/fixtures/index.js';
import { tmdbApi } from '$lib/server/providers/implementations/tmdb/index.js';
import { getEpisodeOrderingService } from '$lib/server/services/episode-ordering.service.js';

vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => getTestDb() }));
vi.mock('$lib/server/middleware/media-access.js', () => ({ checkMediaAccess: async () => true }));
vi.mock('$lib/server/cache/index.js', () => ({
    cacheManager: { for: () => ({ clear: async () => undefined }) },
}));

import { def, applyDef } from './ordering.js';

const GROUP_ID = '62c942aec8113d004c7b261e';
const group = {
    id: GROUP_ID,
    name: 'German Broadcast Combined (Original Air Date)',
    type: 1 as const,
    episode_count: 1,
    group_count: 1,
    groups: [
        {
            id: 'original-air-date-season',
            order: 0,
            locked: false,
            episodes: [{ id: 12345, season_number: 1, episode_number: 2, order: 0 }],
        },
    ],
};
const selection = { provider: 'tmdb', groupId: GROUP_ID };
const CTX = {} as Parameters<NonNullable<typeof def.handlers.GET>>[1];
let sql: postgres.Sql;
let seriesId: string;
let episodeId: string;

function event(method = 'GET', body?: unknown): RequestEvent {
    const url = new URL(`http://localhost/api/series/${seriesId}/ordering`);
    return {
        params: { id: seriesId },
        url,
        request: new Request(url, { method, body: body ? JSON.stringify(body) : undefined }),
        locals: { user: { username: 'admin', ownerIsAdmin: true } },
    } as unknown as RequestEvent;
}

beforeAll(() => {
    sql = getTestDb();
});
afterAll(async () => {
    await closeTestDb();
});
afterEach(() => {
    vi.restoreAllMocks();
});
beforeEach(async () => {
    await truncateTables(sql, [...TEST_TABLES.mediaFiles, ...TEST_TABLES.media]);
    ({ id: seriesId } = await createAndInsertTestTvShow(sql, { tmdbId: 2228 }));
    const seasonId = crypto.randomUUID();
    episodeId = crypto.randomUUID();
    await sql`
        INSERT INTO media_items (id, title, media_type, parent_id, season_number, episode_number, status)
        VALUES (${seasonId}, 'Season 1', 'season', ${seriesId}, 1, null, 'active'),
               (${episodeId}, 'Episode 2', 'episode', ${seasonId}, 1, 2, 'active')
    `;
    vi.spyOn(tmdbApi, 'isAvailable').mockReturnValue(true);
    vi.spyOn(tmdbApi, 'getEpisodeGroups').mockResolvedValue([group]);
    vi.spyOn(tmdbApi, 'getEpisodeGroupDetails').mockResolvedValue(group);
});

async function saveAndApply(orderingType: string): Promise<void> {
    const saved = await def.handlers.PUT!(event('PUT', { orderingType, ...selection }), CTX);
    expect(saved.status).toBe(200);
    const applied = await applyDef.handlers.POST!(event('POST', selection), {
        input: { body: selection },
    } as Parameters<NonNullable<typeof applyDef.handlers.POST>>[1]);
    expect(applied.status).toBe(200);
    expect(await applied.json()).toEqual({ applied: 1, skipped: 0, combined: 0 });
    expect(await saved.json()).toMatchObject({ orderingType: 'other', ...selection });
    const rows = await sql`
        SELECT ordering_type, episode_media_id, order_season_number, order_episode_number
        FROM episode_orderings WHERE series_media_id = ${seriesId} AND ordering_group_id = ${GROUP_ID}
    `;
    expect(rows).toEqual([
        expect.objectContaining({
            ordering_type: 'other',
            episode_media_id: episodeId,
            order_season_number: 1,
            order_episode_number: 1,
        }),
    ]);
    expect(
        await getEpisodeOrderingService(sql).getSeriesOrdering({ mediaId: seriesId }),
    ).toMatchObject({ orderingType: 'other', orderingSource: 'manual', orderingGroupId: GROUP_ID });
}

it('discovers, saves, syncs and applies a TMDB type-1 group', async () => {
    const [available] = await getEpisodeOrderingService(sql).getAvailableOrderings({
        mediaId: seriesId,
    });
    await saveAndApply(available.type);
});

it('coerces a stale client sending standard with a provider and group', async () => {
    await saveAndApply('standard');
});

it.each(['manual', 'auto'] as const)(
    'keeps a legacy %s standard row standard until reselected',
    async (source) => {
        const service = getEpisodeOrderingService(sql);
        await service.setSeriesOrdering({ mediaId: seriesId }, 'standard', {
            source,
            ...selection,
        });
        const current = await def.handlers.GET!(event(), CTX);
        expect(await current.json()).toMatchObject({ current: { orderingType: 'standard' } });
        expect(
            await service.getOrderedEpisodes({ mediaId: seriesId }, [
                { seasonNumber: 1, episodeNumber: 2 },
            ]),
        ).toMatchObject([
            { orderingType: 'standard', displaySeasonNumber: 1, displayEpisodeNumber: 2 },
        ]);
        const [available] = await service.getAvailableOrderings({ mediaId: seriesId });
        await saveAndApply(available.type);
    },
);
