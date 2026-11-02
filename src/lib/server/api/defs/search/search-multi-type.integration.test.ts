// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Catalog search with two type toggles at once (movie + series).
 *
 * The def maps `types=movie,series` onto `SearchSourceToggles { movies, series }`
 * and the catalog branch of `SearchService` must return BOTH row kinds in one
 * fan-out. The same fan-out must still honour library scoping: a movie whose
 * only file sits in a library group the caller is denied must disappear, while
 * the allowed movie and the series stay.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../../tests/integration/setup/test-database.js';
import { SearchService, type SearchServiceOptions } from '$lib/server/services/search.service.js';

/**
 * Letters-only title token. Digits are mapped to letters so the Postgres
 * parser sees one plain word and FTS matches it exactly.
 */
function letterToken(): string {
    const hex = randomUUID().replace(/-/g, '');
    return `qx${hex.replace(/\d/g, (d) => 'abcdefghij'[Number(d)])}`;
}

describe('catalog search with movie + series sources together', () => {
    let sql: postgres.Sql;
    const token = letterToken();
    const allowedGroupId = randomUUID();
    const deniedGroupId = randomUUID();
    const allowedMovieId = randomUUID();
    const deniedMovieId = randomUUID();
    const seriesId = randomUUID();
    const seasonId = randomUUID();
    const episodeId = randomUUID();
    const allowedFileId = randomUUID();
    const deniedFileId = randomUUID();
    const seriesFileId = randomUUID();
    const mediaIds = [allowedMovieId, deniedMovieId, seriesId, seasonId, episodeId];
    const fileIds = [allowedFileId, deniedFileId, seriesFileId];
    const groupIds = [allowedGroupId, deniedGroupId];

    beforeAll(async () => {
        sql = getTestDb();
        for (const groupId of groupIds) {
            await sql`INSERT INTO library_groups (id, name) VALUES (${groupId}::uuid, ${`${token} ${groupId}`})`;
        }
        await sql`
            INSERT INTO media_items (id, title, media_type, status, has_files, year)
            VALUES
                (${allowedMovieId}::uuid, ${`${token} Allowed Movie`}, 'movie', 'active', true, 2001),
                (${deniedMovieId}::uuid, ${`${token} Denied Movie`}, 'movie', 'active', true, 2002)
        `;
        await sql`
            INSERT INTO media_items (id, title, media_type, status, has_files, parent_id)
            VALUES (${seriesId}::uuid, ${`${token} Series`}, 'tv', 'active', true, NULL)
        `;
        await sql`
            INSERT INTO media_items (id, title, media_type, status, has_files, parent_id)
            VALUES (${seasonId}::uuid, ${`${token} Series Season 1`}, 'season', 'active', true, ${seriesId}::uuid)
        `;
        await sql`
            INSERT INTO media_items (id, title, media_type, status, has_files, parent_id)
            VALUES (${episodeId}::uuid, ${`${token} Series Episode 1`}, 'episode', 'active', true, ${seasonId}::uuid)
        `;
        await sql`
            INSERT INTO media_files (id, file_path, library_group_id)
            VALUES
                (${allowedFileId}::uuid, ${`/test/${allowedMovieId}.mkv`}, ${allowedGroupId}::uuid),
                (${deniedFileId}::uuid, ${`/test/${deniedMovieId}.mkv`}, ${deniedGroupId}::uuid),
                (${seriesFileId}::uuid, ${`/test/${episodeId}.mkv`}, ${allowedGroupId}::uuid)
        `;
        await sql`
            INSERT INTO media_file_items (file_id, media_item_id)
            VALUES
                (${allowedFileId}::uuid, ${allowedMovieId}::uuid),
                (${deniedFileId}::uuid, ${deniedMovieId}::uuid),
                (${seriesFileId}::uuid, ${episodeId}::uuid)
        `;
    });

    afterAll(async () => {
        await sql`DELETE FROM media_items WHERE id = ANY(${sql.array(mediaIds)}::uuid[])`;
        await sql`DELETE FROM media_files WHERE id = ANY(${sql.array(fileIds)}::uuid[])`;
        await sql`DELETE FROM library_groups WHERE id = ANY(${sql.array(groupIds)}::uuid[])`;
        await closeTestDb();
    });

    /** Options for the catalog branch only: movies and series, nothing else. */
    function searchOptions(
        overrides: Partial<SearchServiceOptions> & Pick<SearchServiceOptions, 'sources'>,
    ): SearchServiceOptions {
        return {
            sql,
            q: token,
            window: 20,
            offset: 0,
            limit: 20,
            useFulltext: false,
            deniedGroupIds: null,
            ageRating: null,
            showUnavailableMedia: false,
            liveTvAllowed: false,
            surface: 'internal',
            ...overrides,
        };
    }

    const movieAndSeries = {
        movies: true,
        series: true,
        episodes: false,
        music: false,
        books: false,
        audiobooks: false,
        requests: false,
        channels: false,
        nonEntTypes: [],
    } as const;

    const seriesOnly = { ...movieAndSeries, movies: false } as const;

    it('returns both the movie and the series when movies and series are requested together', async () => {
        const page = await SearchService.search(searchOptions({ sources: movieAndSeries }));
        const ids = page.items.map((item) => item.id);
        expect(ids).toContain(allowedMovieId);
        expect(ids).toContain(deniedMovieId);
        expect(ids).toContain(seriesId);
        const types = new Set(page.items.map((item) => item.type));
        expect(types.has('movie')).toBe(true);
        expect(types.has('series')).toBe(true);
    });

    it('drops a movie in a denied library group while keeping the allowed movie and the series', async () => {
        // Baseline with no scoping: the denied movie must match this query, or
        // the absence below proves nothing.
        const unscoped = await SearchService.search(searchOptions({ sources: movieAndSeries }));
        expect(unscoped.items.map((item) => item.id)).toContain(deniedMovieId);

        const scoped = await SearchService.search(
            searchOptions({ sources: movieAndSeries, deniedGroupIds: [deniedGroupId] }),
        );
        const ids = scoped.items.map((item) => item.id);
        expect(ids).not.toContain(deniedMovieId);
        expect(ids).toContain(allowedMovieId);
        expect(ids).toContain(seriesId);
    });

    it('returns no movie when only the series source is in scope', async () => {
        const page = await SearchService.search(searchOptions({ sources: seriesOnly }));
        const ids = page.items.map((item) => item.id);
        expect(ids).toContain(seriesId);
        expect(ids).not.toContain(allowedMovieId);
        expect(ids).not.toContain(deniedMovieId);
        expect(page.items.every((item) => item.type !== 'movie')).toBe(true);
    });
});
