// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A national certification (FSK, MPAA, ...) wins over MDBList and MDBList can
 * never take the rating back; MDBList still fills titles with no national one.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';
import { applyNationalAgeRating } from './age-rating-source.queries.js';
import { updateMediaAgeRating } from './media-upsert.js';

let sql: postgres.Sql;

beforeAll(() => {
    sql = getTestDb();
});
afterAll(async () => {
    await closeTestDb();
});
beforeEach(async () => {
    await truncateTables(sql, ['provider_metadata', 'media_items']);
});

async function movie(ageRating: number | null = null): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
        INSERT INTO media_items (title, media_type, status, age_rating, year)
        VALUES ('Fixture Movie', 'movie', 'active', ${ageRating}, 2020) RETURNING id`;
    return row!.id;
}

async function read(id: string) {
    const [row] = await sql<{ age_rating: number | null; age_rating_source: string | null }[]>`
        SELECT age_rating, age_rating_source FROM media_items WHERE id = ${id}`;
    return row!;
}

describe('national age rating vs MDBList', () => {
    it('MDBList fills an unrated title and records its source', async () => {
        const id = await movie();
        await updateMediaAgeRating(sql, id, 16);
        expect(await read(id)).toEqual({ age_rating: 16, age_rating_source: 'mdblist' });
    });

    it('a national certification replaces the MDBList age, in both directions', async () => {
        const stricter = await movie(18); // MDBList said 18, FSK says 12
        const looser = await movie(6); // MDBList said 6, FSK says 16
        expect(await applyNationalAgeRating(sql, stricter, 'FSK 12')).toBe(12);
        expect(await applyNationalAgeRating(sql, looser, '16')).toBe(16);
        expect(await read(stricter)).toEqual({ age_rating: 12, age_rating_source: 'national' });
        expect(await read(looser)).toEqual({ age_rating: 16, age_rating_source: 'national' });
    });

    it('MDBList never overwrites a national rating', async () => {
        const id = await movie();
        await applyNationalAgeRating(sql, id, 'FSK 12');
        await updateMediaAgeRating(sql, id, 18);
        await updateMediaAgeRating(sql, id, null);
        expect(await read(id)).toEqual({ age_rating: 12, age_rating_source: 'national' });
    });

    it('an unparseable certification changes nothing (no invented 0, no cleared rating)', async () => {
        const id = await movie();
        await updateMediaAgeRating(sql, id, 16);
        for (const cert of ['NR', 'Unrated', '', null, undefined, 'garbage']) {
            expect(await applyNationalAgeRating(sql, id, cert)).toBeNull();
        }
        expect(await read(id)).toEqual({ age_rating: 16, age_rating_source: 'mdblist' });
    });

    it('leaves the CHECK constraint validated (added NOT VALID, then validated)', async () => {
        const [row] = await sql<{ convalidated: boolean }[]>`
            SELECT convalidated FROM pg_constraint
            WHERE conname = 'media_items_age_rating_source_check'`;
        expect(row?.convalidated).toBe(true);
    });

    it('rejects an unknown source value', async () => {
        const id = await movie();
        await expect(
            sql`UPDATE media_items SET age_rating_source = 'guess' WHERE id = ${id}`,
        ).rejects.toThrow();
    });
});

describe('NFO content rating', () => {
    it('sets the rating and display certification of a local item, but never replaces a national one', async () => {
        const { applyLocalNfoDisplayMetadata } = await import('./media-items.queries.js');
        const local = await movie(); // no provider ids
        await applyLocalNfoDisplayMetadata(sql, local, { certification: 'FSK 16' });
        expect(await read(local)).toEqual({ age_rating: 16, age_rating_source: 'national' });
        const [agg] = await sql<{ certification: string }[]>`
            SELECT metadata->>'certification' AS certification FROM provider_metadata
            WHERE media_id = ${local} AND provider = 'aggregated'`;
        expect(agg?.certification).toBe('FSK 16');

        // TMDB already supplied a national rating: a rescan of the NFO must not flip it.
        const matched = await movie();
        await applyNationalAgeRating(sql, matched, 'PG-13');
        await applyLocalNfoDisplayMetadata(sql, matched, { certification: 'R' });
        expect(await read(matched)).toEqual({ age_rating: 13, age_rating_source: 'national' });

        // ... but it does replace an MDBList-sourced one.
        const mdb = await movie();
        await updateMediaAgeRating(sql, mdb, 18);
        await applyLocalNfoDisplayMetadata(sql, mdb, { certification: 'FSK 12' });
        expect(await read(mdb)).toEqual({ age_rating: 12, age_rating_source: 'national' });
    });
});

describe('countUnratedLibraryTitles', () => {
    it('counts active library movies and series without a rating', async () => {
        const { countUnratedLibraryTitles } = await import('./age-rating-source.queries.js');
        const add = (type: string, rating: number | null) =>
            sql`INSERT INTO media_items (title, media_type, status, age_rating, has_files, year)
                VALUES ('t', ${type}, 'active', ${rating}, true, 2020)`;
        await add('movie', null);
        await add('movie', 12);
        await add('tv', null);
        await add('audiobook', null); // not a video title
        await sql`INSERT INTO media_items (title, media_type, status, age_rating, has_files, year)
                  VALUES ('no files', 'movie', 'active', NULL, false, 2020)`;
        await sql`INSERT INTO media_items (title, media_type, status, age_rating, has_files, year)
                  VALUES ('gone', 'movie', 'deleted', NULL, true, 2020)`;
        expect(await countUnratedLibraryTitles(sql)).toEqual({ unrated: 2, total: 3 });
    });
});

describe('national ratings only land on movie, series and audiobook rows', () => {
    it('never sets age_rating on a season or episode (NFO, Jellyfin adoption, backfill all go through the writer)', async () => {
        const { applyLocalNfoDisplayMetadata } = await import('./media-items.queries.js');
        const row = async (type: string): Promise<string> => {
            const [r] = await sql<{ id: string }[]>`
                INSERT INTO media_items (title, media_type, status, year)
                VALUES ('t', ${type}, 'active', 2020) RETURNING id`;
            return r!.id;
        };
        for (const type of ['season', 'episode']) {
            const id = await row(type);
            expect(await applyNationalAgeRating(sql, id, 'FSK 16')).toBe(16); // parsed, not stored
            await applyNationalAgeRating(sql, id, 'FSK 16', { onlyFill: true });
            await applyLocalNfoDisplayMetadata(sql, id, { certification: 'FSK 16' });
            expect(await read(id)).toEqual({ age_rating: null, age_rating_source: null });
        }
        for (const type of ['movie', 'tv', 'audiobook']) {
            const id = await row(type);
            await applyNationalAgeRating(sql, id, 'FSK 16');
            expect(await read(id)).toEqual({ age_rating: 16, age_rating_source: 'national' });
        }
    });
});
