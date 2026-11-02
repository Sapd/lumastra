// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the rail metadata batch hydrator.
 *
 * These run the REAL SQL against a real PostgreSQL — the point is to catch
 * malformed SQL, wrong column names, and the provider-metadata LATERAL join
 * shape, none of which unit tests or ESLint can see.
 */

import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { getMediaRailMetadataBatch } from './media-rail-metadata.queries.js';
import { getTestDatabaseUrl } from '../../../../../tests/integration/setup/test-database.js';

const TEST_DATABASE_URL = getTestDatabaseUrl();

let sql: postgres.Sql;
const createdIds: string[] = [];

beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL, { max: 2 });
});

afterAll(async () => {
    if (createdIds.length > 0) {
        await sql`DELETE FROM media_items WHERE id = ANY(${createdIds}::uuid[])`;
    }
    await sql.end();
});

describe('getMediaRailMetadataBatch', () => {
    it('returns an empty map without touching the database for an empty id list', async () => {
        const result = await getMediaRailMetadataBatch(sql, []);
        expect(result.size).toBe(0);
    });

    it('executes the real SQL and tolerates unknown ids', async () => {
        // A well-formed UUID that does not exist: proves the query runs and that
        // absent rows are simply omitted rather than throwing.
        const result = await getMediaRailMetadataBatch(sql, [
            '00000000-0000-0000-0000-000000000000',
        ]);
        expect(result.size).toBe(0);
    });

    it('hydrates overview, runtime, genres and quality tiers for a real row', async () => {
        const [row] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, status, runtime_seconds, overview)
            VALUES ('Rail Metadata Fixture', 'movie', 'active', 7200, 'base overview')
            RETURNING id
        `;
        createdIds.push(row.id);

        await sql`
            INSERT INTO provider_metadata (media_id, provider, metadata)
            VALUES (${row.id}, 'tmdb', ${sql.json({
                overview: 'provider overview',
                imdb_rating: 8.1,
                // TMDB's score is `vote_average`. `tmdb_rating` is written by
                // nothing in this pipeline — it is included here ONLY to prove
                // the query no longer reads it.
                tmdb_rating: 7.9,
                vote_average: 6.4,
                vote_count: 1200,
                rt_rating: 91,
                runtime_minutes: 118,
                certification: 'PG-13',
                genres: [
                    { id: 28, name: 'Action' },
                    { id: 12, name: 'Adventure' },
                ],
            })})
        `;

        await sql`
            INSERT INTO media_item_quality (
                media_item_id, resolution_tier, hdr_tier, hdr_type,
                has_atmos, has_cc, has_sdh, has_ad
            )
            VALUES (${row.id}, '4K', 'dolby_vision', 'DolbyVision', true, true, true, true)
        `;

        const result = await getMediaRailMetadataBatch(sql, [row.id]);
        const meta = result.get(row.id);

        expect(meta).toBeDefined();
        expect(meta?.overview).toBe('provider overview');
        expect(meta?.imdbRating).toBe(8.1);
        expect(meta?.tmdbRating).toBe(6.4);
        expect(meta?.voteCount).toBe(1200);
        expect(meta?.rtRating).toBe(91);
        expect(meta?.runtimeMinutes).toBe(118);
        expect(meta?.certification).toBe('PG-13');
        expect(meta?.genres).toEqual(['Action', 'Adventure']);
        expect(meta?.resolutionTier).toBe('4K');
        expect(meta?.hdrTier).toBe('dolby_vision');
        expect(meta?.hasAtmos).toBe(true);
        expect(meta?.hasCc).toBe(true);
        expect(meta?.hasSdh).toBe(true);
        expect(meta?.hasAd).toBe(true);
    });

    it('reports accessibility flags as false when the item has no projection row', async () => {
        // LEFT JOIN yields NULL for never-probed items; the badges must read as
        // absent, not as undefined booleans leaking into the response.
        const [row] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, status)
            VALUES ('Rail No Projection', 'movie', 'active')
            RETURNING id
        `;
        createdIds.push(row.id);

        const meta = (await getMediaRailMetadataBatch(sql, [row.id])).get(row.id);
        expect(meta).toBeDefined();
        expect(meta?.hasAtmos).toBe(false);
        expect(meta?.hasCc).toBe(false);
        expect(meta?.hasSdh).toBe(false);
        expect(meta?.hasAd).toBe(false);
        expect(meta?.resolutionTier).toBeNull();
    });

    it('yields null ratings instead of aborting the batch on non-numeric metadata', async () => {
        // A bare `::float` cast on a dirty value raises 22P02 and takes the
        // WHOLE page of rails down, not just the offending card. The regex
        // guards must degrade to NULL for that one row instead.
        //
        // Only the UNINDEXED keys are exercised here. `imdb_rating` (and
        // letterboxd_rating / mal_score / mdblist_score / popularity) each back
        // a partial expression index that casts to numeric, so Postgres rejects
        // a non-numeric value at INSERT — the guard on those is belt-and-braces
        // and cannot be provoked. `vote_average`, `vote_count` and `rt_rating`
        // have no such index, which is exactly why they need the guard.
        const [dirty] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, status)
            VALUES ('Rail Dirty Ratings', 'movie', 'active')
            RETURNING id
        `;
        createdIds.push(dirty.id);
        const [clean] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, status)
            VALUES ('Rail Clean Ratings', 'movie', 'active')
            RETURNING id
        `;
        createdIds.push(clean.id);

        await sql`
            INSERT INTO provider_metadata (media_id, provider, metadata)
            VALUES (${dirty.id}, 'tmdb', ${sql.json({
                vote_average: '',
                vote_count: '1,200',
                rt_rating: 'tbd',
            })})
        `;
        await sql`
            INSERT INTO provider_metadata (media_id, provider, metadata)
            VALUES (${clean.id}, 'tmdb', ${sql.json({ vote_average: 7.2, vote_count: 500 })})
        `;

        const result = await getMediaRailMetadataBatch(sql, [dirty.id, clean.id]);

        expect(result.get(dirty.id)?.tmdbRating).toBeNull();
        expect(result.get(dirty.id)?.voteCount).toBeNull();
        expect(result.get(dirty.id)?.rtRating).toBeNull();
        // The clean row in the SAME batch still hydrates.
        expect(result.get(clean.id)?.tmdbRating).toBe(7.2);
        expect(result.get(clean.id)?.voteCount).toBe(500);
    });

    it('falls back to media_items.runtime_seconds when the provider omits runtime', async () => {
        const [row] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, status, runtime_seconds)
            VALUES ('Rail Runtime Fallback', 'movie', 'active', 5400)
            RETURNING id
        `;
        createdIds.push(row.id);

        await sql`
            INSERT INTO provider_metadata (media_id, provider, metadata)
            VALUES (${row.id}, 'tmdb', ${sql.json({ overview: 'no runtime here' })})
        `;

        const result = await getMediaRailMetadataBatch(sql, [row.id]);
        expect(result.get(row.id)?.runtimeMinutes).toBe(90);
    });
});
