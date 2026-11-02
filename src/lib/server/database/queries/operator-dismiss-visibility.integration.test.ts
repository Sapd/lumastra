// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Library → Fix matches → "Remove from library" (DELETE
 * /api/admin/unmatched-files/[id] → dismissMediaItemWithChildren) promises the
 * item "disappears from browsing for EVERY user". The library surfaces gate on
 * `status = 'active' AND has_files = true` (has_files = "playable in this
 * install"), so an operator dismissal that left has_files = true on a
 * still-linked series kept it in A-Z, genres, recently added, search, the admin
 * homepage and the Jellyfin-compat browse.
 *
 * Each case seeds a REAL file-backed series (media_files + media_file_items via
 * attachFileToItem), asserts it is visible first (control), dismisses it, and
 * asserts it is gone — then restores it and asserts it is back.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import { unrestrictedAccess } from './builders/media-access-boundary.js';
import { getRecentlyAddedMedia, getMediaAlphabetical, getMediaByGenre } from './browse.queries.js';
import { searchMedia } from './search.queries.js';
import { getHomepageLibrarySnapshot } from './homepage-library.queries.js';
import { browseMediaItems } from './jellyfin-browse.queries.js';
import {
    attachFileToItem,
    upsertMediaFile,
    propagateHasFiles,
    recomputeHasFilesBatch,
} from './media-files.queries.js';
import { backfillHasFilesMediaItems } from './database-cleanup.queries.js';
import { dismissMediaItemWithChildren } from './media-items.queries.js';
import { restoreDismissedMediaItemWithChildren } from './unmatched-files.queries.js';

const GENRE = 'ZZDismissGenre';

interface SeededSeries {
    seriesId: string;
    seasonId: string;
    episodeIds: string[];
}

async function insertItem(
    sql: postgres.Sql,
    item: {
        title: string;
        mediaType: string;
        parentId?: string | null;
        season?: number | null;
        episode?: number | null;
    },
): Promise<string> {
    const id = randomUUID();
    await sql`
        INSERT INTO media_items (id, title, media_type, status, parent_id, season_number, episode_number, has_files)
        VALUES (${id}::uuid, ${item.title}, ${item.mediaType}, 'active', ${item.parentId ?? null},
                ${item.season ?? null}, ${item.episode ?? null}, false)
    `;
    return id;
}

async function seedFileBackedSeries(sql: postgres.Sql, title: string): Promise<SeededSeries> {
    const seriesId = await insertItem(sql, { title, mediaType: 'tv' });
    const seasonId = await insertItem(sql, {
        title: 'Season 1',
        mediaType: 'season',
        parentId: seriesId,
        season: 1,
    });
    const episodeIds: string[] = [];
    for (const n of [1, 2]) {
        const epId = await insertItem(sql, {
            title: `${title} Episode ${n}`,
            mediaType: 'episode',
            parentId: seasonId,
            season: 1,
            episode: n,
        });
        const { id: fileId } = await upsertMediaFile(sql, {
            filePath: `/data/series/${title}/Season 01/${title} - S01E0${n}.mkv`,
        });
        await attachFileToItem(sql, fileId, epId);
        episodeIds.push(epId);
    }
    await sql`
        UPDATE media_items SET library_added_at = NOW()
        WHERE id IN (${seriesId}::uuid, ${seasonId}::uuid)
    `;
    await sql`
        INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at, updated_at)
        VALUES (${seriesId}::uuid, 'tmdb',
                ${sql.json({ overview: 'x', popularity: 1, genres: [{ id: 4242, name: GENRE }] })},
                NOW(), NOW())
    `;
    return { seriesId, seasonId, episodeIds };
}

async function seedFileBackedMovie(sql: postgres.Sql, title: string): Promise<string> {
    const id = await insertItem(sql, { title, mediaType: 'movie' });
    const { id: fileId } = await upsertMediaFile(sql, { filePath: `/data/movies/${title}.mkv` });
    await attachFileToItem(sql, fileId, id);
    await sql`UPDATE media_items SET library_added_at = NOW() WHERE id = ${id}::uuid`;
    return id;
}

/** Every user-facing library surface, reduced to "which ids/titles does it list". */
async function visibleOn(sql: postgres.Sql, id: string, title: string) {
    const access = unrestrictedAccess();
    const recent = await getRecentlyAddedMedia(sql, { access, limit: 200 });
    const az = await getMediaAlphabetical(sql, { access, limit: 200 });
    const genre = await getMediaByGenre(sql, GENRE, { access, limit: 200 });
    const search = await searchMedia(sql, title, access, { availableOnly: true });
    const home = await getHomepageLibrarySnapshot(sql, 50);
    const jf = await browseMediaItems(sql, {
        mediaTypes: ['tv', 'movie'],
        parentId: null,
        searchTerm: null,
        genres: [],
        years: [],
        nameStartsWith: null,
        isFavoriteFilter: false,
        isPlayedFilter: false,
        isUnplayedFilter: false,
        enableUserData: false,
        userId: undefined,
        idList: [],
        sortBy: 'SortName',
        sortOrder: 'Ascending',
        limit: 200,
        startIndex: 0,
        access,
    });
    return {
        recentlyAdded: recent.some((r) => r.id === id),
        az: az.items.some((r) => r.title === title),
        genre: genre.some((r) => r.id === id),
        search: search.some((r) => r.title === title),
        home: home.recent.some((r) => r.title === title),
        jellyfinBrowse: jf.rows.some((r) => String(r.id) === id),
    };
}

const ALL_VISIBLE = {
    recentlyAdded: true,
    az: true,
    genre: true,
    search: true,
    home: true,
    jellyfinBrowse: true,
};
const ALL_HIDDEN = {
    recentlyAdded: false,
    az: false,
    genre: false,
    search: false,
    home: false,
    jellyfinBrowse: false,
};

describe('operator "Remove from library" hides the item from every library surface', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
    });

    it('a dismissed file-backed series is gone from browse/search/home/jellyfin, and Undo brings it back', async () => {
        const title = 'Quokkaville Chronicles';
        const s = await seedFileBackedSeries(sql, title);

        // Control: the seeded series is genuinely on every surface first.
        expect(await visibleOn(sql, s.seriesId, title)).toEqual(ALL_VISIBLE);

        const dismissed = await dismissMediaItemWithChildren(sql, s.seriesId);
        expect(dismissed).toBe(4); // series + season + 2 episodes

        expect(await visibleOn(sql, s.seriesId, title)).toEqual(ALL_HIDDEN);

        // Admin/history stay intact: the rows and their file links survive.
        const [links] = await sql<[{ n: number }]>`
            SELECT count(*)::int AS n FROM media_file_items
            WHERE media_item_id = ANY(${s.episodeIds}::uuid[])
        `;
        expect(links.n).toBe(2);

        const restored = await restoreDismissedMediaItemWithChildren(sql, s.seriesId);
        expect(restored).toBe(4);
        expect(await visibleOn(sql, s.seriesId, title)).toEqual(ALL_VISIBLE);

        const rows = await sql<{ id: string; has_files: boolean; is_dismissed: boolean }[]>`
            SELECT id, has_files, is_dismissed FROM media_items
            WHERE id = ANY(${[s.seriesId, s.seasonId, ...s.episodeIds]}::uuid[])
        `;
        expect(rows.every((r) => r.has_files && !r.is_dismissed)).toBe(true);
    });

    it('stays hidden through the has_files writers (cleanup backfill, propagate, recompute)', async () => {
        const title = 'Wombat Junction';
        const s = await seedFileBackedSeries(sql, title);
        await dismissMediaItemWithChildren(sql, s.seriesId);

        // Every cleanup tick re-derives has_files from the (still present) links.
        await backfillHasFilesMediaItems(sql);
        await propagateHasFiles(sql, s.episodeIds[0]);
        await recomputeHasFilesBatch(sql, [s.seriesId, s.seasonId, ...s.episodeIds]);

        expect(await visibleOn(sql, s.seriesId, title)).toEqual(ALL_HIDDEN);
    });

    it('a dismissed file-backed movie is hidden too', async () => {
        const title = 'Platypus Express';
        const id = await seedFileBackedMovie(sql, title);
        const access = unrestrictedAccess();
        const before = await getMediaAlphabetical(sql, { access, limit: 200 });
        expect(before.items.some((r) => r.title === title)).toBe(true);

        expect(await dismissMediaItemWithChildren(sql, id)).toBe(1);
        await backfillHasFilesMediaItems(sql);

        const after = await getMediaAlphabetical(sql, { access, limit: 200 });
        expect(after.items.some((r) => r.title === title)).toBe(false);
        const search = await searchMedia(sql, title, access, { availableOnly: true });
        expect(search).toHaveLength(0);
    });

    it('a legacy-dismissed season with live episodes keeps has_files through recompute', async () => {
        // Prod shape (2026-10-06): 8 seasons carry is_dismissed = true with
        // dismissed_at NULL under a live series, their episodes live and
        // file-backed. Re-derivers must leave them alone, not hide the season.
        const title = 'Bilby Bay';
        const s = await seedFileBackedSeries(sql, title);
        await sql`UPDATE media_items SET is_dismissed = true WHERE id = ${s.seasonId}::uuid`;

        await recomputeHasFilesBatch(sql, s.episodeIds);
        await backfillHasFilesMediaItems(sql);

        const [season] = await sql<[{ has_files: boolean }]>`
            SELECT has_files FROM media_items WHERE id = ${s.seasonId}::uuid
        `;
        expect(season.has_files).toBe(true);
        expect(await visibleOn(sql, s.seriesId, title)).toEqual(ALL_VISIBLE);
    });

    it('re-attaching a NEW file still un-dismisses (scanner reclaim path unchanged)', async () => {
        const title = 'Echidna Heights';
        const s = await seedFileBackedSeries(sql, title);
        await dismissMediaItemWithChildren(sql, s.seriesId);

        const { id: fileId } = await upsertMediaFile(sql, {
            filePath: `/data/series/${title}/Season 01/${title} - S01E01.v2.mkv`,
        });
        await attachFileToItem(sql, fileId, s.episodeIds[0]);

        const [ep] = await sql<[{ has_files: boolean; is_dismissed: boolean }]>`
            SELECT has_files, is_dismissed FROM media_items WHERE id = ${s.episodeIds[0]}::uuid
        `;
        expect(ep).toEqual({ has_files: true, is_dismissed: false });
    });
});
