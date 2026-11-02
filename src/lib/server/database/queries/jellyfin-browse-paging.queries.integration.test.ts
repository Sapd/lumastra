// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `browseMediaItems` picks the page first (ids, total and episode-ordering
 * numbers) and only then builds the display columns for those rows. These tests
 * pin what that must keep: the rows, their order, `total_count` and the
 * display columns, on the first page, a later page and a page past the end.
 * Example names are fictional.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';
import { ensureTestUser } from '../../../../../tests/integration/fixtures/index.js';
import { toUserId, type UserId } from '$lib/shared/user-id.js';
import { browseMediaItems, type BrowseItemsOptions } from './jellyfin-browse.queries.js';
import { unrestrictedAccess } from './builders/media-access-boundary.js';

let sql: postgres.Sql;
let userId: UserId;

beforeAll(() => {
    sql = getTestDb();
});

afterAll(async () => {
    await closeTestDb();
});

beforeEach(async () => {
    await truncateTables(sql, [
        'episode_orderings',
        'series_episode_ordering',
        'user_media_state',
        'provider_metadata',
        'media_file_items',
        'media_files',
        'media_items',
    ]);
    userId = toUserId(randomUUID());
    await ensureTestUser(sql, userId);
});

async function insertItem(args: {
    title: string;
    type: string;
    parentId?: string | null;
    seasonNumber?: number | null;
    episodeNumber?: number | null;
    runtimeSeconds?: number | null;
    fileSeconds?: number | null;
    tmdbMetadata?: Record<string, unknown>;
}): Promise<string> {
    const leaf = args.type === 'movie' || args.type === 'episode';
    const [row] = await sql<{ id: string }[]>`
        INSERT INTO media_items (
            title, sort_title, media_type, status, parent_id, has_files,
            season_number, episode_number, runtime_seconds
        ) VALUES (
            ${args.title}, ${args.title.toLowerCase()}, ${args.type}, 'active',
            ${args.parentId ?? null}, ${leaf},
            ${args.seasonNumber ?? null}, ${args.episodeNumber ?? null}, ${args.runtimeSeconds ?? null}
        ) RETURNING id`;
    if (args.tmdbMetadata) {
        await sql`INSERT INTO provider_metadata (media_id, provider, metadata)
                  VALUES (${row.id}::uuid, 'tmdb', ${sql.json(args.tmdbMetadata as never)})`;
    }
    if (leaf) {
        const [file] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path, duration_seconds, created_at, updated_at)
            VALUES (${`/paging/${row.id}.mkv`}, ${args.fileSeconds ?? null}, NOW(), NOW())
            RETURNING id`;
        await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default)
                  VALUES (${file.id}::uuid, ${row.id}::uuid, true)`;
    }
    return row.id;
}

function browse(opts: Partial<BrowseItemsOptions>) {
    return browseMediaItems(sql, {
        mediaTypes: [],
        parentId: null,
        searchTerm: null,
        genres: [],
        years: [],
        nameStartsWith: null,
        isFavoriteFilter: false,
        isPlayedFilter: false,
        isUnplayedFilter: false,
        enableUserData: true,
        userId,
        idList: [],
        sortBy: 'SortName',
        sortOrder: 'Ascending',
        limit: 100,
        startIndex: 0,
        access: unrestrictedAccess(),
        ...opts,
    });
}

describe('browseMediaItems paging', () => {
    it('keeps rows, order and total_count on every page, and past the end', async () => {
        const ids: string[] = [];
        for (let i = 1; i <= 7; i++) {
            ids.push(await insertItem({ title: `Movie ${i}`, type: 'movie' }));
        }
        const pages = [];
        for (const startIndex of [0, 3, 6]) {
            pages.push(await browse({ mediaTypes: ['movie'], limit: 3, startIndex }));
        }
        expect(pages.map((p) => p.rows.map((r) => r.id))).toEqual([
            ids.slice(0, 3),
            ids.slice(3, 6),
            ids.slice(6),
        ]);
        for (const page of pages) {
            expect(page.totalCount).toBe(7);
            for (const row of page.rows) expect(Number(row.total_count)).toBe(7);
        }

        // startIndex past the end: no row carries the total, so it is counted apart.
        const past = await browse({ mediaTypes: ['movie'], limit: 3, startIndex: 9 });
        expect(past.rows).toHaveLength(0);
        expect(past.totalCount).toBe(7);

        const none = await browse({ mediaTypes: ['track'] });
        expect(none.rows).toHaveLength(0);
        expect(none.totalCount).toBe(0);
    });

    it('skipCount returns the page and no total', async () => {
        for (let i = 1; i <= 4; i++) await insertItem({ title: `Movie ${i}`, type: 'movie' });
        const { rows, totalCount } = await browse({
            mediaTypes: ['movie'],
            limit: 3,
            skipCount: true,
        });
        expect(rows).toHaveLength(3);
        expect(totalCount).toBe(3);
    });

    it('sorts by Runtime (own, TMDB, file) and still returns the runtime column', async () => {
        const own = await insertItem({ title: 'Own', type: 'movie', runtimeSeconds: 3000 });
        const tmdb = await insertItem({
            title: 'Tmdb',
            type: 'movie',
            tmdbMetadata: { runtime: 90 },
            fileSeconds: 100,
        });
        const file = await insertItem({ title: 'File', type: 'movie', fileSeconds: 4000 });
        const none = await insertItem({ title: 'None', type: 'movie' });

        const page = await browse({
            mediaTypes: ['movie'],
            sortBy: 'Runtime',
            sortOrder: 'Descending',
            limit: 3,
        });
        // TMDB's 90 min (5400 s) beats the file's 100 s; DESC puts the item without a runtime last.
        expect(page.rows.map((r) => [r.id, r.runtime_seconds])).toEqual([
            [tmdb, 5400],
            [file, 4000],
            [own, 3000],
        ]);
        expect(page.totalCount).toBe(4);

        const second = await browse({
            mediaTypes: ['movie'],
            sortBy: 'Runtime',
            sortOrder: 'Descending',
            limit: 3,
            startIndex: 3,
        });
        expect(second.rows.map((r) => [r.id, r.runtime_seconds])).toEqual([[none, null]]);
        expect(second.totalCount).toBe(4);
    });

    it('episodes: ordering numbers, series and season, user state, series sort', async () => {
        const zeta = await insertItem({ title: 'Zeta Show', type: 'tv' });
        const zetaSeason = await insertItem({
            title: 'Season 1',
            type: 'season',
            parentId: zeta,
            seasonNumber: 1,
        });
        const alpha = await insertItem({ title: 'Alpha Show', type: 'tv' });
        const alphaSeason = await insertItem({
            title: 'Season 1',
            type: 'season',
            parentId: alpha,
            seasonNumber: 1,
        });
        const z1 = await insertItem({
            title: 'Z one',
            type: 'episode',
            parentId: zetaSeason,
            seasonNumber: 1,
            episodeNumber: 1,
        });
        const z2 = await insertItem({
            title: 'Z two',
            type: 'episode',
            parentId: zetaSeason,
            seasonNumber: 1,
            episodeNumber: 2,
        });
        const a1 = await insertItem({
            title: 'A one',
            type: 'episode',
            parentId: alphaSeason,
            seasonNumber: 1,
            episodeNumber: 1,
        });
        const a2 = await insertItem({
            title: 'A two',
            type: 'episode',
            parentId: alphaSeason,
            seasonNumber: 1,
            episodeNumber: 2,
        });
        // Zeta is shown in DVD order: its first episode becomes S02E05.
        await sql`INSERT INTO series_episode_ordering (media_id, ordering_type, ordering_group_id)
                  VALUES (${zeta}::uuid, 'dvd', 'g1')`;
        await sql`
            INSERT INTO episode_orderings (
                series_media_id, episode_media_id, provider, provider_episode_id, ordering_type,
                ordering_group_id, original_season_number, original_episode_number,
                order_season_number, order_episode_number, fetched_at
            ) VALUES (
                ${zeta}::uuid, ${z1}::uuid, 'tvdb', 'z1', 'dvd', 'g1', 1, 1, 2, 5, NOW()
            )`;
        await sql`INSERT INTO user_media_state (user_id, media_id, resume_position_ms, runtime_ms, is_watched)
                  VALUES (${userId}::uuid, ${a1}::uuid, 600000, 1200000, false)`;

        const all = await browse({
            mediaTypes: ['episode'],
            sortBy: 'SeriesSortName,SortName',
            limit: 3,
        });
        // Alpha before Zeta; within a show by the displayed S/E (Z two is S01E02, Z one is S02E05).
        expect(all.rows.map((r) => r.id)).toEqual([a1, a2, z2]);
        expect(all.totalCount).toBe(4);
        const a1Row = all.rows[0];
        expect(a1Row).toMatchObject({
            series_id: alpha,
            series_name: 'Alpha Show',
            season_id: alphaSeason,
            season_name: 'Season 1',
            season_number: 1,
            episode_number: 1,
            resume_position_ms: 600000,
            is_watched: false,
        });
        expect(Number(a1Row.played_percentage)).toBe(50);

        const later = await browse({
            mediaTypes: ['episode'],
            sortBy: 'SeriesSortName,SortName',
            limit: 3,
            startIndex: 3,
        });
        expect(later.rows.map((r) => r.id)).toEqual([z1]);
        expect(later.rows[0]).toMatchObject({
            series_id: zeta,
            season_number: 2,
            episode_number: 5,
        });
        expect(later.totalCount).toBe(4);
    });
});
