// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type postgres from 'postgres';
import {
    getTestDb,
    closeTestDb,
} from '../../../../../../../tests/integration/setup/test-database.js';
import { getSeriesEpisodesWithWatchState } from '$lib/server/database/queries/episode-detail.queries.js';
import {
    getSeasonsByInternalId,
    getSeriesOrdering,
} from '$lib/server/database/queries/season-detail.queries.js';
import { exactSeriesRows } from '../../search/exact-series.js';
import { buildSeasonNodes } from './seasons.js';
import { unrestrictedAccess } from '$lib/server/database/queries/builders/media-access-boundary.js';
import { def as episodesDef } from './episodes.js';
import type { MediaPreview } from '$lib/schemas/api-media-preview.js';
import type { UserContext } from '$lib/server/types.js';
import { toUserId } from '$lib/shared/user-id.js';

// Bind the endpoint to this suite's database; availability, ordering and all
// episode queries still execute against real PostgreSQL.
vi.mock('$lib/server/database/connection.js', async (importOriginal) => {
    const mod = await importOriginal<typeof import('$lib/server/database/connection.js')>();
    const { getTestDb: getSql } =
        await import('../../../../../../../tests/integration/setup/test-database.js');
    return { ...mod, getDb: () => getSql() };
});

// Seed only this suite's rows; never truncate another concurrently running suite's data.
describe('package 11 seasons and episode walk (seeded PostgreSQL)', () => {
    let sql: postgres.Sql;
    const series = randomUUID();
    const sameTitle = randomUUID();
    const fuzzyTitle = randomUUID();
    const seasons = [randomUUID(), randomUUID(), randomUUID()];
    const episodes = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const files = episodes.map(() => randomUUID());
    const access = unrestrictedAccess();
    const user: UserContext = {
        userId: toUserId(randomUUID()),
        username: `package11-${series}`,
        groups: '',
        userGroups: [],
        ownerIsAdmin: false,
        hasWatchPermission: true,
        hasRequestPermission: false,
        hasLiveTvPermission: false,
        maxAgeRating: null,
        isAgeRestricted: false,
        isModerator: false,
        liveTvPriority: 'low',
    };

    async function configureOrdering(
        ordering: 'dvd' | 'absolute' | 'regional' | 'other',
    ): Promise<void> {
        await sql`INSERT INTO series_episode_ordering (media_id, ordering_type, ordering_group_id)
            VALUES (${series}, ${ordering}, ${`${ordering}-fixture`})
            ON CONFLICT (media_id) DO UPDATE SET ordering_type = EXCLUDED.ordering_type,
                ordering_group_id = EXCLUDED.ordering_group_id`;
        await sql`DELETE FROM episode_orderings WHERE series_media_id = ${series} AND ordering_type = ${ordering}`;
        for (const [i, id] of episodes.entries()) {
            if (i === 0) continue;
            await sql`INSERT INTO episode_orderings (series_media_id, episode_media_id, provider, provider_episode_id,
                ordering_type, ordering_group_id, original_season_number, original_episode_number, order_season_number, order_episode_number)
                VALUES (${series}, ${id}, 'tmdb', ${`${ordering}-${i}`}, ${ordering}, ${`${ordering}-fixture`}, ${i === 3 ? 2 : 1}, ${i === 2 ? 2 : 1}, ${i < 3 ? i : 2}, ${i === 3 ? 2 : 1})`;
        }
    }
    beforeAll(async () => {
        sql = getTestDb();
        await sql`INSERT INTO media_items (id, title, media_type, year) VALUES (${series}, 'M', 'tv', 1931), (${sameTitle}, 'M', 'tv', 1951), (${fuzzyTitle}, 'M other', 'tv', 1931)`;
        for (const [i, id] of seasons.entries()) {
            await sql`INSERT INTO media_items (id, title, media_type, parent_id, season_number)
                VALUES (${id}, ${`Season ${i}`}, 'season', ${series}, ${i})`;
        }
        for (const [i, id] of episodes.entries()) {
            const n = i === 0 ? 0 : i === 3 ? 2 : 1;
            await sql`INSERT INTO media_items (id, title, media_type, parent_id, season_number, episode_number)
                VALUES (${id}, ${`Episode ${i}`}, 'episode', ${seasons[n]}, ${n}, ${i === 2 ? 2 : 1})`;
            await sql`INSERT INTO media_files (id, file_path)
                VALUES (${files[i]}, ${`/test/package11/${id}.mkv`})`;
            await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default)
                VALUES (${files[i]}, ${id}, true)`;
        }
        // The scanner propagates the canonical availability flag after linking files.
        await sql`UPDATE media_items SET has_files = true
            WHERE id = ANY(${[series, ...seasons, ...episodes]}::uuid[])`;
        await sql`INSERT INTO episode_orderings (series_media_id, episode_media_id, provider, provider_episode_id,
            ordering_type, ordering_group_id, original_season_number, original_episode_number,
            order_season_number, order_episode_number, order_episode_number_end, absolute_number)
            VALUES (${series}, ${episodes[3]}, 'tmdb', 'fixture-span', 'standard', 'standard', 2, 1, 2, 1, 2, 27)`;
    });
    afterAll(async () => {
        await sql`DELETE FROM episode_orderings WHERE series_media_id = ${series}`;
        await sql`DELETE FROM series_episode_ordering WHERE media_id = ${series}`;
        await sql`DELETE FROM media_file_items WHERE file_id = ANY(${files}::uuid[])`;
        await sql`DELETE FROM media_files WHERE id = ANY(${files}::uuid[])`;
        await sql`DELETE FROM media_items WHERE id = ANY(${sql.array(episodes)}::uuid[])`;
        await sql`DELETE FROM media_items WHERE id = ANY(${sql.array(seasons)}::uuid[])`;
        await sql`DELETE FROM media_items WHERE id IN (${series}, ${sameTitle}, ${fuzzyTitle})`;
        await closeTestDb();
    });
    it('finds exact one-character series titles by year, without fuzzy rows, and pages ranked matches', async () => {
        const matches = await exactSeriesRows(sql, 'm', undefined, 10, 0, access, false);
        // The available series ranks ahead of the metadata-only exact match.
        expect(matches.map((row) => row.internal_id)).toEqual([series, sameTitle]);
        const year = await exactSeriesRows(sql, 'M', 1931, 10, 0, access, false);
        expect(year.map((row) => row.internal_id)).toEqual([series]);
        const page = await exactSeriesRows(sql, 'M', undefined, 1, 1, access, false);
        expect(page.map((row) => row.internal_id)).toEqual([sameTitle]);
    });
    it('lists physical seasons with their own UUIDs in standard ordering', async () => {
        expect(await getSeriesOrdering(sql, series)).toBe('standard');
        const rows = await getSeasonsByInternalId(sql, series, undefined, access);
        expect(rows.map((s) => s.id)).toEqual(seasons);
        const response = await buildSeasonNodes(sql, series, undefined, 'v1', access);
        expect(response.items.every((s) => s.id === s.catalogId && !s.virtual)).toBe(true);
    });
    it('pages after stable ordering and places specials last; neighbours cross seasons', async () => {
        const all = await getSeriesEpisodesWithWatchState(sql, series, undefined, undefined, {
            access,
        });
        expect(all.map((ep) => ep.id)).toEqual([
            episodes[1],
            episodes[2],
            episodes[3],
            episodes[0],
        ]);
        expect(all[1].next_id).toBe(episodes[3]);
        expect(all[2].previous_id).toBe(episodes[2]);
        const page = await getSeriesEpisodesWithWatchState(sql, series, undefined, undefined, {
            access,
            limit: 2,
            offset: 1,
        });
        expect(page.map((ep) => ep.id)).toEqual([episodes[2], episodes[3]]);
        expect(
            await getSeriesEpisodesWithWatchState(sql, series, undefined, undefined, {
                access,
                offset: 99,
                limit: 2,
            }),
        ).toEqual([]);
    });
    it('honours all specials modes and filters before paging', async () => {
        const only = await getSeriesEpisodesWithWatchState(sql, series, undefined, undefined, {
            access,
            specials: 'only',
        });
        expect(only.map((ep) => ep.id)).toEqual([episodes[0]]);
        const main = await getSeriesEpisodesWithWatchState(sql, series, undefined, undefined, {
            access,
            specials: 'exclude',
        });
        expect(main).toHaveLength(3);
        expect(main[2].next_id).toBeNull();
        expect(
            await getSeriesEpisodesWithWatchState(sql, series, undefined, 1, {
                access,
                episode: 9,
            }),
        ).toEqual([]);
    });
    it('resolves both numbers in a reconciled span and absolute number 27', async () => {
        for (const episode of [1, 2]) {
            const found = await getSeriesEpisodesWithWatchState(sql, series, undefined, 2, {
                access,
                episode,
            });
            expect(found).toHaveLength(1);
            expect(found[0]).toMatchObject({
                id: episodes[3],
                episode_number: 1,
                episode_number_end: 2,
            });
        }
        const absolute = await getSeriesEpisodesWithWatchState(sql, series, undefined, undefined, {
            access,
            absolute: 27,
        });
        expect(absolute.map((ep) => ep.id)).toEqual([episodes[3]]);
    });
    it('makes every non-standard season virtual, including unmapped specials', async () => {
        await configureOrdering('dvd');
        const response = await buildSeasonNodes(sql, series, undefined, 'v1', access);
        expect(response.ordering).toBe('dvd');
        expect(response.items.map((s) => s.id)).toEqual(
            [1, 2, 0].map((n) => `vseason:${series}:dvd:${n}`),
        );
        expect(response.items.every((s) => s.catalogId === null && s.virtual)).toBe(true);
        const logical = await getSeriesEpisodesWithWatchState(sql, series, undefined, 2, {
            access,
        });
        expect(logical.map((ep) => ep.id)).toEqual([episodes[2], episodes[3]]);
    });
    it.each(['dvd', 'absolute', 'regional', 'other'] as const)(
        'hides unavailable-only virtual seasons and episodes in %s ordering, preserving available episodes and specials',
        async (ordering) => {
            const hidden = [randomUUID(), randomUUID()];
            try {
                await configureOrdering(ordering);
                // One metadata-only episode shares virtual season 2 with available
                // episodes; the other is the sole member of virtual season 3.
                for (const [i, id] of hidden.entries()) {
                    await sql`INSERT INTO media_items
                    (id, title, media_type, parent_id, season_number, episode_number)
                    VALUES (${id}, 'Metadata only', 'episode', ${seasons[2]}, 2, ${i + 3})`;
                    await sql`INSERT INTO episode_orderings (series_media_id, episode_media_id, provider, provider_episode_id,
                    ordering_type, ordering_group_id, original_season_number, original_episode_number, order_season_number, order_episode_number)
                    VALUES (${series}, ${id}, 'tmdb', ${`${ordering}-hidden-${i}`}, ${ordering}, ${`${ordering}-fixture`}, 2, ${i + 3}, ${i + 2}, 3)`;
                }
                const unfiltered = await getSeriesEpisodesWithWatchState(
                    sql,
                    series,
                    undefined,
                    undefined,
                    { access },
                );
                expect(unfiltered.map((ep) => ep.id)).toEqual(expect.arrayContaining(hidden));
                const response = await buildSeasonNodes(sql, series, undefined, 'v1', access);
                expect(response.items.map((s) => [s.id, s.episodeCount])).toEqual([
                    [`vseason:${series}:${ordering}:1`, 1],
                    [`vseason:${series}:${ordering}:2`, 2],
                    [`vseason:${series}:${ordering}:0`, 1],
                ]);

                const request = async (
                    query = '',
                    params: Record<string, string> = {},
                ): Promise<Response> =>
                    episodesDef.handlers.GET!(
                        {
                            params: { id: series, ...params },
                            locals: { user },
                            url: new URL(
                                `http://localhost/api/v1/series/${series}/episodes${query}`,
                            ),
                        } as unknown as RequestEvent,
                        { surface: 'v1' },
                    );

                const listed = await request();
                expect(listed.status).toBe(200);
                const body = (await listed.json()) as { items: MediaPreview[] };
                expect(body.items.map((ep) => ep.id)).toEqual([
                    episodes[1],
                    episodes[2],
                    episodes[3],
                    episodes[0],
                ]);
                expect(body.items.every((ep) => ep.availability?.isAvailable)).toBe(true);
                expect(body.items.map((ep) => ep.context?.seasonId)).toEqual(
                    [1, 2, 2, 0].map((n) => `vseason:${series}:${ordering}:${n}`),
                );
                const page = await request('?season=2&limit=1&offset=1');
                expect(await page.json()).toMatchObject({
                    items: [{ id: episodes[3], context: { nextId: episodes[0] } }],
                    page: { hasMore: false },
                });
                const emptySeason = await request('?season=3');
                expect(await emptySeason.json()).toMatchObject({
                    items: [],
                    page: { hasMore: false },
                });
                expect((await request('', { n: '3', e: '3' })).status).toBe(404);
                const direct = await request('', { n: '2', e: '1' });
                expect(direct.status).toBe(200);
                expect(await direct.json()).toMatchObject({ id: episodes[2] });
            } finally {
                await sql`DELETE FROM episode_orderings WHERE episode_media_id = ANY(${hidden}::uuid[])`;
                await sql`DELETE FROM media_items WHERE id = ANY(${hidden}::uuid[])`;
            }
        },
    );
});
