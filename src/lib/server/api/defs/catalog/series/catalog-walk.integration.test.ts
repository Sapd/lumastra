// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import {
    getTestDb,
    closeTestDb,
} from '../../../../../../../tests/integration/setup/test-database.js';
import { unrestrictedAccess } from '$lib/server/database/queries/builders/media-access-boundary.js';
import { getSeriesEpisodesWithWatchState } from '$lib/server/database/queries/episode-detail.queries.js';
import {
    getSeasonsByInternalId,
    getSeriesOrdering,
} from '$lib/server/database/queries/season-detail.queries.js';
import { upsertSeriesOrdering } from '$lib/server/database/queries/episode-orderings.queries.js';

/** Real SQL: no mocked tag can prove paging, span, NULL joins or window ordering. */
describe('package 11 catalog season and episode queries', () => {
    let sql: postgres.Sql;
    const series = randomUUID();
    const seasons = [randomUUID(), randomUUID(), randomUUID()];
    const eps = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const access = unrestrictedAccess();
    beforeAll(async () => {
        sql = getTestDb();
        await sql`INSERT INTO media_items (id, title, media_type) VALUES (${series}, 'Catalog walk fixture', 'tv')`;
        for (let n = 0; n < seasons.length; n++) {
            await sql`INSERT INTO media_items (id, title, media_type, parent_id, season_number)
                VALUES (${seasons[n]}, ${`Season ${n}`}, 'season', ${series}, ${n})`;
        }
        for (const [index, season, episode] of [
            [0, 0, 1],
            [1, 1, 1],
            [2, 1, 2],
            [3, 2, 4],
        ]) {
            await sql`INSERT INTO media_items (id, title, media_type, parent_id, season_number, episode_number)
                VALUES (${eps[index]}, ${`Episode ${index}`}, 'episode', ${seasons[season]}, ${season}, ${episode})`;
        }
        // The combined file's reconciliation span is also available without a nonstandard preference.
        await sql`INSERT INTO episode_orderings (series_media_id, episode_media_id, provider,
            provider_episode_id, ordering_type, ordering_group_id, original_season_number,
            original_episode_number, order_season_number, order_episode_number, order_episode_number_end, absolute_number)
            VALUES (${series}, ${eps[3]}, 'tmdb', 'fixture-span', 'standard', '', 2, 4, 2, 4, 5, 27)`;
    });
    afterAll(async () => {
        await sql`DELETE FROM episode_orderings WHERE series_media_id = ${series}`;
        await sql`DELETE FROM series_episode_ordering WHERE media_id = ${series}`;
        await sql`DELETE FROM media_items WHERE id = ANY(${eps}::uuid[])`;
        await sql`DELETE FROM media_items WHERE id = ANY(${seasons}::uuid[])`;
        await sql`DELETE FROM media_items WHERE id = ${series}`;
        await closeTestDb();
    });
    it('returns physical season UUIDs for standard ordering', async () => {
        expect(await getSeriesOrdering(sql, series)).toBe('standard');
        const rows = await getSeasonsByInternalId(sql, series, undefined, access);
        expect(rows.map((r) => r.id)).toEqual(seasons);
        expect(rows.map((r) => r.episode_count)).toEqual([1, 2, 1]);
    });
    it('pages across seasons with specials last and consistent neighbours', async () => {
        const walk = await getSeriesEpisodesWithWatchState(sql, series, undefined, undefined, {
            access,
        });
        expect(walk.map((r) => r.id)).toEqual([eps[1], eps[2], eps[3], eps[0]]);
        expect(walk[1].next_id).toBe(eps[3]);
        expect(walk[2].previous_id).toBe(eps[2]);
        const page = await getSeriesEpisodesWithWatchState(sql, series, undefined, undefined, {
            access,
            offset: 2,
            limit: 1,
        });
        expect(page.map((r) => r.id)).toEqual([eps[3]]);
        expect(page[0].next_id).toBe(eps[0]);
        const excluded = await getSeriesEpisodesWithWatchState(sql, series, undefined, undefined, {
            access,
            specials: 'exclude',
        });
        expect(excluded.map((r) => r.id)).toEqual([eps[1], eps[2], eps[3]]);
        expect(excluded.at(-1)?.next_id).toBeNull();
        const only = await getSeriesEpisodesWithWatchState(sql, series, undefined, undefined, {
            access,
            specials: 'only',
        });
        expect(only.map((r) => r.id)).toEqual([eps[0]]);
    });
    it('looks up every number in a combined episode span, and reconciled absolute numbers', async () => {
        for (const episode of [4, 5]) {
            const rows = await getSeriesEpisodesWithWatchState(sql, series, undefined, 2, {
                access,
                episode,
            });
            expect(rows.map((r) => r.id)).toEqual([eps[3]]);
            expect(rows[0]).toMatchObject({
                episode_number: 4,
                episode_number_end: 5,
                absolute_number: 27,
            });
        }
        expect(
            await getSeriesEpisodesWithWatchState(sql, series, undefined, 2, {
                access,
                episode: 6,
            }),
        ).toEqual([]);
        for (const absolute of [27, 28]) {
            expect(
                (
                    await getSeriesEpisodesWithWatchState(sql, series, undefined, undefined, {
                        access,
                        absolute,
                    })
                ).map((r) => r.id),
            ).toEqual([eps[3]]);
        }
    });
    it('groups and walks DVD numbers while physical season UUIDs retain physical membership', async () => {
        await upsertSeriesOrdering(sql, {
            mediaId: series,
            orderingType: 'dvd',
            orderingSource: 'manual',
            orderingProvider: 'tmdb',
            orderingGroupId: 'fixture',
        });
        for (const [index, n] of [
            [1, 3],
            [2, 4],
        ]) {
            await sql`INSERT INTO episode_orderings (series_media_id, episode_media_id, provider,
                provider_episode_id, ordering_type, ordering_group_id, original_season_number,
                original_episode_number, order_season_number, order_episode_number)
                VALUES (${series}, ${eps[index]}, 'tmdb', ${`dvd-${index}`}, 'dvd', 'fixture', 1, ${index}, ${n}, 1)`;
        }
        expect(await getSeriesOrdering(sql, series)).toBe('dvd');
        const logical = await getSeriesEpisodesWithWatchState(sql, series, undefined, 4, {
            access,
        });
        expect(logical.map((r) => r.id)).toEqual([eps[2]]);
        expect(logical[0].ordering).toBe('dvd');
        const physical = await getSeriesEpisodesWithWatchState(sql, series, undefined, undefined, {
            access,
            physicalSeasonId: seasons[1],
        });
        expect(physical.map((r) => r.id)).toEqual([eps[1], eps[2]]);
        expect(physical.map((r) => r.season_number)).toEqual([1, 1]);
    });
});
