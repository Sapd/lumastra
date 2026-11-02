// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the `sort` option wired into `getMediaAlphabetical`
 * (the /browse A-Z query). Covers all six sort orders: title_asc, title_desc,
 * added_desc, year_desc, year_asc, rating_desc.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import { getMediaAlphabetical } from './browse.queries.js';
import { unrestrictedAccess } from './builders/media-access-boundary.js';

interface SeedMovieOptions {
    title: string;
    year: number;
    /** Offset in days from now used for both library_added_at and created_at (more negative = older). */
    addedDaysAgo: number;
    imdbRating?: number;
}

/** Insert a movie with a distinct title/year/added-date (and optional rating). */
async function seedMovie(sql: postgres.Sql, opts: SeedMovieOptions): Promise<string> {
    const addedAt = new Date(Date.now() - opts.addedDaysAgo * 24 * 60 * 60 * 1000);
    const [item] = await sql<{ id: string }[]>`
        INSERT INTO media_items (media_type, title, sort_title, year, status, has_files, library_added_at, created_at)
        VALUES ('movie', ${opts.title}, ${opts.title.toLowerCase()}, ${opts.year}, 'active', true, ${addedAt}, ${addedAt})
        RETURNING id`;

    if (opts.imdbRating !== undefined) {
        await sql`
            INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
            VALUES (${item.id}::uuid, 'tmdb', ${sql.json({ imdb_rating: opts.imdbRating })}, NOW())
        `;
    }

    return item.id;
}

describe('A-Z browse sort options', () => {
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

    /** Seeds the standard 3-movie fixture: Alpha (oldest/lowest year), Zulu (middle), Mike (newest/highest year). */
    async function seedStandardFixture(): Promise<{ alpha: string; zulu: string; mike: string }> {
        const alpha = await seedMovie(sql, { title: 'Alpha', year: 2000, addedDaysAgo: 30 });
        const zulu = await seedMovie(sql, { title: 'Zulu', year: 2010, addedDaysAgo: 15 });
        const mike = await seedMovie(sql, { title: 'Mike', year: 2020, addedDaysAgo: 1 });
        return { alpha, zulu, mike };
    }

    it('title_asc orders alphabetically ascending (Alpha first)', async () => {
        await seedStandardFixture();

        const result = await getMediaAlphabetical(sql, {
            access: unrestrictedAccess(),
            mediaType: 'movie',
            sort: 'title_asc',
        });

        expect(result.items[0]?.title).toBe('Alpha');
    });

    it('title_desc orders alphabetically descending (Zulu first)', async () => {
        await seedStandardFixture();

        const result = await getMediaAlphabetical(sql, {
            access: unrestrictedAccess(),
            mediaType: 'movie',
            sort: 'title_desc',
        });

        expect(result.items[0]?.title).toBe('Zulu');
    });

    it('year_desc orders by year descending (Mike/2020 first)', async () => {
        await seedStandardFixture();

        const result = await getMediaAlphabetical(sql, {
            access: unrestrictedAccess(),
            mediaType: 'movie',
            sort: 'year_desc',
        });

        expect(result.items[0]?.title).toBe('Mike');
        expect(result.items[0]?.release_year).toBe(2020);
    });

    it('year_asc orders by year ascending (Alpha/2000 first)', async () => {
        await seedStandardFixture();

        const result = await getMediaAlphabetical(sql, {
            access: unrestrictedAccess(),
            mediaType: 'movie',
            sort: 'year_asc',
        });

        expect(result.items[0]?.title).toBe('Alpha');
        expect(result.items[0]?.release_year).toBe(2000);
    });

    it('added_desc orders by library_added_at descending (Mike, added most recently, first)', async () => {
        const { mike } = await seedStandardFixture();

        const result = await getMediaAlphabetical(sql, {
            access: unrestrictedAccess(),
            mediaType: 'movie',
            sort: 'added_desc',
        });

        expect(result.items[0]?.title).toBe('Mike');
        expect(result.items[0]?.internal_id).toBe(mike);
        // totalCount must still reflect all 3 seeded movies — the parent_id
        // IS NULL narrowing added for this sort must not drop top-level rows.
        expect(result.totalCount).toBe(3);
    });

    it('rating_desc orders by imdb_rating descending', async () => {
        await truncateTables(sql, TEST_TABLES.media);
        await seedMovie(sql, { title: 'Low Rated', year: 2001, addedDaysAgo: 10, imdbRating: 4.5 });
        const high = await seedMovie(sql, {
            title: 'High Rated',
            year: 2002,
            addedDaysAgo: 5,
            imdbRating: 9.1,
        });
        await seedMovie(sql, { title: 'No Rating', year: 2003, addedDaysAgo: 1 });

        const result = await getMediaAlphabetical(sql, {
            access: unrestrictedAccess(),
            mediaType: 'movie',
            sort: 'rating_desc',
        });

        expect(result.items[0]?.title).toBe('High Rated');
        expect(result.items[0]?.internal_id).toBe(high);
    });

    it('defaults to title_asc when sort is omitted', async () => {
        await seedStandardFixture();

        const result = await getMediaAlphabetical(sql, {
            access: unrestrictedAccess(),
            mediaType: 'movie',
        });

        expect(result.items[0]?.title).toBe('Alpha');
    });

    it('rating_desc with a non-numeric vote_average (e.g. "N/A") does not throw and returns rows, sorting the bad value last', async () => {
        // NOTE: this seeds a bad `vote_average`, not `imdb_rating` — provider_metadata
        // has an *unguarded* functional index (idx_pm_imdb_rating, straight
        // `(metadata->>'imdb_rating')::numeric`) that already rejects a non-numeric
        // imdb_rating at INSERT time, so that specific field can never carry bad data
        // in this schema. `vote_average` has no such index, so it's the field that can
        // actually reach the read path with a non-numeric value like OMDb's "N/A".
        const high = await seedMovie(sql, {
            title: 'High Rated',
            year: 2002,
            addedDaysAgo: 5,
            imdbRating: 9.1,
        });
        const [{ id: badId }] = await sql<{ id: string }[]>`
            INSERT INTO media_items (media_type, title, sort_title, year, status, has_files, library_added_at, created_at)
            VALUES ('movie', 'Bad Rating', 'bad rating', 2003, 'active', true, NOW(), NOW())
            RETURNING id`;
        await sql`
            INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
            VALUES (${badId}::uuid, 'tmdb', ${sql.json({ vote_average: 'N/A' })}, NOW())
        `;

        // Must not throw (the pre-fix ORDER BY / SELECT casts would crash the whole
        // query on this single bad value, and getMediaAlphabetical's catch would
        // silently return an empty result that az.ts then caches as valid).
        const result = await getMediaAlphabetical(sql, {
            access: unrestrictedAccess(),
            mediaType: 'movie',
            sort: 'rating_desc',
        });

        expect(result.totalCount).toBe(2);
        expect(result.items).toHaveLength(2);
        expect(result.items[0]?.title).toBe('High Rated');

        const badItem = result.items.find((i) => i.internal_id === badId);
        expect(badItem).toBeDefined();
        expect(badItem?.tmdb_rating).toBeFalsy();

        const badIndex = result.items.findIndex((i) => i.internal_id === badId);
        const highIndex = result.items.findIndex((i) => i.internal_id === high);
        expect(badIndex).toBeGreaterThan(highIndex);
    });

    it('a non-alphabetical sort (year_desc) ignores a stale `letter` option and returns items across all letters', async () => {
        await seedMovie(sql, { title: 'Alpha', year: 2000, addedDaysAgo: 30 });
        await seedMovie(sql, { title: 'Zulu', year: 2020, addedDaysAgo: 1 });

        // 'letter: Z' would (pre-fix) narrow to titles starting with Z, dropping
        // 'Alpha' even though the jump-nav rail is hidden client-side for
        // non-title sorts and the letter should therefore be ignored.
        const result = await getMediaAlphabetical(sql, {
            access: unrestrictedAccess(),
            mediaType: 'movie',
            sort: 'year_desc',
            letter: 'Z',
        });

        const titles = result.items.map((i) => i.title);
        expect(titles).toContain('Alpha');
        expect(titles).toContain('Zulu');
        expect(result.items[0]?.title).toBe('Zulu');
    });
});
