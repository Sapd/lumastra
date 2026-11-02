// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createAndInsertTestSeries,
    ensureTestUser,
} from '../../../../../tests/integration/fixtures/index.js';
import { getSeriesEpisodeCountsBatch } from './series-episode-counts.queries.js';
import {
    unrestrictedAccess,
    restrictedAccess,
    denyAllAccess,
} from './builders/media-access-boundary.js';

describe('scoped canonical episode counts', () => {
    let sql: postgres.Sql;
    const user = randomUUID();
    const otherUser = randomUUID();
    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await truncateTables(sql, [...TEST_TABLES.media, ...TEST_TABLES.userData]);
        await ensureTestUser(sql, user);
        await ensureTestUser(sql, otherUser);
    });
    async function setup(): Promise<{ id: string; season: string; episodes: string[] }> {
        const { seriesId } = await createAndInsertTestSeries(sql, {
            tmdbId: Math.floor(Math.random() * 10000000),
            seasonCount: 1,
            episodesPerSeason: 4,
        });
        const seasons = await sql<
            { id: string }[]
        >`SELECT id FROM media_items WHERE parent_id = ${seriesId}`;
        const episodes = await sql<
            { id: string }[]
        >`SELECT id FROM media_items WHERE parent_id = ${seasons[0].id} ORDER BY id`;
        await sql`UPDATE media_items SET has_files = true WHERE id = ANY(${[seriesId, seasons[0].id, ...episodes.map((e) => e.id)]}::uuid[])`;
        await sql`UPDATE media_items SET season_number = 0 WHERE id = ${seasons[0].id}`;
        return { id: seriesId, season: seasons[0].id, episodes: episodes.map((e) => e.id) };
    }
    it('counts specials once and separates unavailable/inactive episodes and users from metadata totals', async () => {
        const { id, season, episodes } = await setup();
        const versions = [randomUUID(), randomUUID()];
        await sql`INSERT INTO media_files (id, file_path) VALUES (${versions[0]}, ${'/test/counts-version-' + versions[0]}), (${versions[1]}, ${'/test/counts-version-' + versions[1]})`;
        await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default) VALUES (${versions[0]}, ${episodes[0]}, true), (${versions[1]}, ${episodes[0]}, false)`;
        await sql`UPDATE media_items SET has_files = false WHERE id = ${episodes[2]}`;
        await sql`UPDATE media_items SET status = 'deleted' WHERE id = ${episodes[3]}`;
        await sql`INSERT INTO provider_metadata (media_id, provider, metadata) VALUES (${id}, 'tmdb', ${sql.json({ season_count: 5, number_of_episodes: 60 })}) ON CONFLICT (media_id, provider) DO UPDATE SET metadata = EXCLUDED.metadata`;
        await sql`INSERT INTO user_media_state (user_id, media_id, is_watched) VALUES (${user}, ${episodes[0]}, true), (${user}, ${episodes[2]}, true), (${user}, ${id}, true), (${otherUser}, ${episodes[1]}, true)`;
        const [first] = await getSeriesEpisodeCountsBatch(sql, [id], user, unrestrictedAccess());
        expect(first).toMatchObject({
            seasonCount: 5,
            episodeCount: 60,
            availableEpisodeCount: 2,
            watchedEpisodeCount: 1,
            unwatchedEpisodeCount: 1,
        });
        const [second] = await getSeriesEpisodeCountsBatch(
            sql,
            [id],
            otherUser,
            unrestrictedAccess(),
        );
        expect(second.watchedEpisodeCount).toBe(1);
        await sql`INSERT INTO user_media_state (user_id, media_id, is_watched) VALUES (${user}, ${episodes[1]}, true)`;
        await sql`INSERT INTO provider_metadata (media_id, provider, metadata) VALUES (${season}, 'tmdb', ${sql.json({ episode_count: 12 })}) ON CONFLICT (media_id, provider) DO UPDATE SET metadata = EXCLUDED.metadata`;
        const [complete] = await getSeriesEpisodeCountsBatch(
            sql,
            [season],
            user,
            unrestrictedAccess(),
        );
        expect(complete).toMatchObject({
            episodeCount: 12,
            availableEpisodeCount: 2,
            watchedEpisodeCount: 2,
            unwatchedEpisodeCount: 0,
        });
    });
    it('keeps overlapping series and season batch roots independent under child access filters', async () => {
        const first = await setup();
        const second = await setup();
        await sql`DELETE FROM provider_metadata WHERE media_id = ANY(${[first.id, first.season, second.id, second.season]}::uuid[])`;
        const deniedGroup = randomUUID();
        await sql`INSERT INTO library_groups (id, name) VALUES (${deniedGroup}, ${'counts-batch-' + deniedGroup})`;
        await sql`UPDATE media_items SET library_group_id = ${deniedGroup} WHERE id = ${first.episodes[0]}`;
        await sql`UPDATE media_items SET has_files = false WHERE id = ${second.episodes[3]}`;
        await sql`INSERT INTO user_media_state (user_id, media_id, is_watched) VALUES
            (${user}, ${first.episodes[0]}, true), (${user}, ${first.episodes[1]}, true),
            (${user}, ${second.episodes[0]}, true), (${user}, ${second.episodes[1]}, true),
            (${user}, ${second.episodes[3]}, true), (${otherUser}, ${first.episodes[2]}, true)`;

        const rows = await getSeriesEpisodeCountsBatch(
            sql,
            [first.id, second.id, first.season, second.season],
            user,
            restrictedAccess({
                deniedGroupIds: [deniedGroup],
                maxAgeRating: null,
                allowUnrated: false,
            }),
        );
        expect(rows).toHaveLength(4);
        const byId = new Map(rows.map((row) => [row.id, row]));
        for (const id of [first.id, first.season]) {
            expect(byId.get(id)).toMatchObject({
                seasonCount: 1,
                episodeCount: 3,
                availableEpisodeCount: 3,
                watchedEpisodeCount: 1,
                unwatchedEpisodeCount: 2,
            });
        }
        for (const id of [second.id, second.season]) {
            expect(byId.get(id)).toMatchObject({
                seasonCount: 1,
                episodeCount: 4,
                availableEpisodeCount: 3,
                watchedEpisodeCount: 2,
                unwatchedEpisodeCount: 1,
            });
        }
    });
    it('uses known catalog counts and keeps empty/zero provider totals unknown', async () => {
        const { id, season, episodes } = await setup();
        await sql`DELETE FROM provider_metadata WHERE media_id = ${id}`;
        const [fallback] = await getSeriesEpisodeCountsBatch(sql, [id], user, unrestrictedAccess());
        expect(fallback.episodeCount).toBe(4);
        await sql`UPDATE media_items SET has_files = false WHERE id = ANY(${episodes}::uuid[])`;
        const [unavailable] = await getSeriesEpisodeCountsBatch(
            sql,
            [id],
            user,
            unrestrictedAccess(),
        );
        expect(unavailable.availableEpisodeCount).toBe(0);
        await sql`UPDATE media_items SET status = 'deleted' WHERE id = ${season}`;
        await sql`INSERT INTO provider_metadata (media_id, provider, metadata) VALUES (${id}, 'tmdb', ${sql.json({ season_count: 0, number_of_episodes: 0 })})`;
        const [empty] = await getSeriesEpisodeCountsBatch(sql, [id], user, unrestrictedAccess());
        expect(empty.episodeCount).toBeNull();
        expect(empty.seasonCount).toBeNull();
        expect(empty.availableEpisodeCount).toBe(0);
    });
    it('scopes physical file libraries and counts mixed versions once', async () => {
        const { id, episodes } = await setup();
        await sql`DELETE FROM provider_metadata WHERE media_id = ${id}`;
        const deniedGroup = randomUUID();
        await sql`INSERT INTO library_groups (id, name) VALUES (${deniedGroup}, ${'counts-files-' + deniedGroup})`;
        const files = [randomUUID(), randomUUID(), randomUUID()];
        await sql`INSERT INTO media_files (id, file_path, library_group_id) VALUES
            (${files[0]}, ${'/test/counts-denied-' + files[0]}, ${deniedGroup}),
            (${files[1]}, ${'/test/counts-mixed-' + files[1]}, ${deniedGroup}),
            (${files[2]}, ${'/test/counts-allowed-' + files[2]}, NULL)`;
        await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default) VALUES
            (${files[0]}, ${episodes[0]}, true),
            (${files[1]}, ${episodes[1]}, true),
            (${files[2]}, ${episodes[1]}, false)`;
        await sql`INSERT INTO user_media_state (user_id, media_id, is_watched) VALUES
            (${user}, ${episodes[0]}, true), (${user}, ${episodes[1]}, true)`;
        const [counts] = await getSeriesEpisodeCountsBatch(
            sql,
            [id],
            user,
            restrictedAccess({
                deniedGroupIds: [deniedGroup],
                maxAgeRating: null,
                allowUnrated: false,
            }),
        );
        expect(counts).toMatchObject({
            episodeCount: 3,
            availableEpisodeCount: 3,
            watchedEpisodeCount: 1,
            unwatchedEpisodeCount: 2,
        });
    });
    it('gates root age, season parent access, denied child library, and explicit deny-all', async () => {
        const { id, season, episodes } = await setup();
        await sql`DELETE FROM provider_metadata WHERE media_id = ${id}`;
        const deniedGroup = randomUUID();
        await sql`INSERT INTO library_groups (id, name) VALUES (${deniedGroup}, ${'counts-' + deniedGroup})`;
        await sql`UPDATE media_items SET library_group_id = ${deniedGroup} WHERE id = ${episodes[0]}`;
        const restricted = restrictedAccess({
            deniedGroupIds: [deniedGroup],
            maxAgeRating: null,
            allowUnrated: false,
        });
        const [filtered] = await getSeriesEpisodeCountsBatch(sql, [id], user, restricted);
        expect(filtered.availableEpisodeCount).toBe(3);
        expect(filtered.episodeCount).toBe(3);
        await sql`UPDATE media_items SET age_rating = 18 WHERE id = ${id}`;
        const young = restrictedAccess({
            deniedGroupIds: [],
            maxAgeRating: 12,
            allowUnrated: false,
        });
        expect(await getSeriesEpisodeCountsBatch(sql, [id, season], user, young)).toEqual([]);
        await sql`UPDATE media_items SET library_group_id = ${deniedGroup} WHERE id = ${id}`;
        expect(await getSeriesEpisodeCountsBatch(sql, [season], user, restricted)).toEqual([]);
        expect(await getSeriesEpisodeCountsBatch(sql, [id], user, denyAllAccess())).toEqual([]);
        expect(await getSeriesEpisodeCountsBatch(sql, [], user, unrestrictedAccess())).toEqual([]);
    });
});
