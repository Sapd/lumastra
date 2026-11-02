// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for getQualityLibraryMedia (hero cold-start fallback)
 *
 * Requires the lumastra_tests database. Run with:
 *   npm run test:integration src/lib/server/database/queries/hero-fallback.queries.integration.test.ts
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
} from '../../../../../tests/integration/fixtures/index.js';

import { getHeroFallbackItem, getQualityLibraryMedia } from './hero-fallback.queries.js';
import {
    denyAllAccess,
    restrictedAccess,
    unrestrictedAccess,
} from './builders/media-access-boundary.js';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';

describe('getQualityLibraryMedia', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, ['provider_metadata', 'external_ids', 'media_items']);
    });

    async function insertMovieWithMetadata(opts: {
        hasFiles?: boolean;
        imdbRating?: number;
        popularity?: number;
        backdropPath?: string | null;
        status?: string;
        mediaType?: 'movie' | 'tv';
    }): Promise<string> {
        const {
            hasFiles = true,
            imdbRating = 7.0,
            popularity = 100,
            backdropPath = '/some/backdrop.jpg',
            status = 'active',
            mediaType = 'movie',
        } = opts;

        const item = createTestMediaItem({
            media_type: mediaType,
            has_files: hasFiles,
            status: status as 'active' | 'merged' | 'deleted',
        });
        await insertTestMediaItem(sql, item);

        await sql`
            INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
            VALUES (
                ${item.id}::uuid,
                'aggregated',
                ${sql.json({
                    overview: 'Test movie overview',
                    imdb_rating: imdbRating,
                    popularity: popularity,
                    backdrop_path: backdropPath,
                    genres: [{ id: 28, name: 'Action' }],
                })},
                NOW()
            )
        `;

        return item.id;
    }

    it('returns only active + has_files items', async () => {
        const activeId = await insertMovieWithMetadata({ hasFiles: true });
        await insertMovieWithMetadata({ hasFiles: false });

        const results = await getQualityLibraryMedia(sql, {
            mediaType: 'movie',
            limit: 10,
            access: unrestrictedAccess(),
        });

        expect(results.length).toBe(1);
        expect(results[0].internal_id).toBe(activeId);
    });

    it('filters by mediaType', async () => {
        const movieId = await insertMovieWithMetadata({ mediaType: 'movie' });
        await insertMovieWithMetadata({ mediaType: 'tv' });

        const movieResults = await getQualityLibraryMedia(sql, {
            mediaType: 'movie',
            limit: 10,
            access: unrestrictedAccess(),
        });

        expect(movieResults.every((r) => r.media_type === 'movie')).toBe(true);
        expect(movieResults.some((r) => r.internal_id === movieId)).toBe(true);

        const tvResults = await getQualityLibraryMedia(sql, {
            mediaType: 'tv',
            limit: 10,
            access: unrestrictedAccess(),
        });

        expect(tvResults.every((r) => r.media_type === 'tv')).toBe(true);
    });

    it('returns BOTH movie and tv when mediaType is omitted (feed "all" case)', async () => {
        // Regression: an undefined mediaType used to be bound directly into the
        // SQL, making postgres.js throw UNDEFINED_VALUE — the /feed for-you rail
        // swallowed the throw and always rendered empty for typeless requests.
        const movieId = await insertMovieWithMetadata({ mediaType: 'movie' });
        const tvId = await insertMovieWithMetadata({ mediaType: 'tv' });

        const results = await getQualityLibraryMedia(sql, {
            limit: 10,
            access: unrestrictedAccess(),
        });

        const ids = results.map((r) => r.internal_id);
        expect(ids).toContain(movieId);
        expect(ids).toContain(tvId);
        // Only top-level movie/tv types — never episodes/seasons/channels.
        expect(results.every((r) => r.media_type === 'movie' || r.media_type === 'tv')).toBe(true);
    });

    it('orders items with backdrop_path first', async () => {
        const noBackdropId = await insertMovieWithMetadata({
            backdropPath: null,
            imdbRating: 9.5,
            popularity: 9999,
        });
        const withBackdropId = await insertMovieWithMetadata({
            backdropPath: '/backdrop.jpg',
            imdbRating: 5.0,
            popularity: 1,
        });

        const results = await getQualityLibraryMedia(sql, {
            mediaType: 'movie',
            limit: 10,
            access: unrestrictedAccess(),
        });

        expect(results.length).toBe(2);
        // Item with backdrop should come first despite lower ratings
        expect(results[0].internal_id).toBe(withBackdropId);
        expect(results[1].internal_id).toBe(noBackdropId);
    });

    it('orders by imdb_rating descending when both have backdrop', async () => {
        // quality_score = backdrop(+1_000_000) + imdb_rating×1000 + popularity
        // (compute_media_quality_score, materialized by the trg_provider_metadata_quality
        // trigger on the provider_metadata INSERT below). Both items have a backdrop
        // (equal tier) and EQUAL popularity, so imdb_rating (×1000) is the sole
        // differentiator: 9.0 > 5.0. popularity is a real weighted term here, NOT a
        // pure tiebreaker — an adversarial spread would legitimately let the
        // lower-rated but far-more-popular item win, so hold it equal.
        const lowRatedId = await insertMovieWithMetadata({ imdbRating: 5.0, popularity: 100 });
        const highRatedId = await insertMovieWithMetadata({ imdbRating: 9.0, popularity: 100 });

        const results = await getQualityLibraryMedia(sql, {
            mediaType: 'movie',
            limit: 10,
            access: unrestrictedAccess(),
        });

        expect(results.length).toBe(2);
        expect(results[0].internal_id).toBe(highRatedId);
        expect(results[1].internal_id).toBe(lowRatedId);
    });

    it('respects limit', async () => {
        for (let i = 0; i < 5; i++) {
            await insertMovieWithMetadata({});
        }

        const results = await getQualityLibraryMedia(sql, {
            mediaType: 'movie',
            limit: 3,
            access: unrestrictedAccess(),
        });

        expect(results.length).toBe(3);
    });

    it('returns empty array when no matching items exist', async () => {
        const results = await getQualityLibraryMedia(sql, {
            mediaType: 'movie',
            limit: 10,
            access: unrestrictedAccess(),
        });

        expect(results).toEqual([]);
    });

    it('excludes deleted items', async () => {
        await insertMovieWithMetadata({ status: 'deleted' });

        const results = await getQualityLibraryMedia(sql, {
            mediaType: 'movie',
            limit: 10,
            access: unrestrictedAccess(),
        });

        expect(results).toEqual([]);
    });

    it('returned rows have the MediaEmbedding shape expected by the recommendations route', async () => {
        await insertMovieWithMetadata({});

        const results = await getQualityLibraryMedia(sql, {
            mediaType: 'movie',
            limit: 1,
            access: unrestrictedAccess(),
        });

        expect(results.length).toBe(1);
        const item = results[0];
        // Fields the recommendations route mapping accesses
        expect(item).toHaveProperty('internal_id');
        expect(item).toHaveProperty('media_type');
        expect(item).toHaveProperty('title');
        expect(item).toHaveProperty('is_available');
        expect(item).toHaveProperty('can_request');
        // is_available should be true since has_files = true
        expect(item.is_available).toBe(true);
        expect(item.can_request).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Access-boundary differential coverage
// ---------------------------------------------------------------------------

/**
 * Differential tests for BOTH exported queries: run the same fixture twice —
 * once unrestricted, once restricted — and assert the restricted result is a
 * STRICT SUBSET of the unrestricted one, plus that a denyAll boundary is empty.
 *
 * Subset-plus-strictness is what catches the failure modes a "returns some
 * rows" assertion cannot: a boundary argument that arrived but was never
 * spliced into the SQL (restricted == unrestricted), and a predicate bound to
 * the wrong alias (restricted empty for the wrong reason, caught by the
 * positive control that the allowed row IS still returned).
 *
 * getQualityLibraryMedia additionally swallows every error into `[]`, so an
 * empty restricted result proves nothing on its own — every case below pins
 * the exact surviving id.
 */
/** Name of the library group this suite denies; used to scope its own cleanup. */
const DENIED_GROUP_NAME = 'Denied Hero Group';

describe('hero-fallback access boundary (differential)', () => {
    let sql: postgres.Sql;
    let deniedGroup: string;

    beforeAll(() => {
        sql = getTestDb();
    });

    /**
     * Remove only THIS suite's fixtures.
     *
     * A blanket `DELETE FROM library_groups` throws against any shared test
     * database in which another suite has left a `library_paths` row behind
     * (`fk_library_paths_library_group` is RESTRICT), which made every test in
     * this describe block fail in `beforeEach` — i.e. the differential access
     * assertions silently stopped running. Several suites do insert
     * `library_paths` (file-scanner-runs, library-types, jellyfin-item-detail),
     * so scope the cleanup to the rows this suite created instead.
     *
     * `media_files` must go before `library_groups` — those rows carry the
     * group FK and are not covered by the `media_items` truncate.
     */
    async function cleanupSuiteFixtures(): Promise<void> {
        await truncateTables(sql, ['provider_metadata', 'external_ids', 'media_items']);
        await sql`DELETE FROM media_files WHERE file_path LIKE '/test/hero/%'`;
        await sql`DELETE FROM library_groups WHERE name = ${DENIED_GROUP_NAME}`;
    }

    afterAll(async () => {
        await cleanupSuiteFixtures();
        await closeTestDb();
    });

    beforeEach(async () => {
        await cleanupSuiteFixtures();
        deniedGroup = crypto.randomUUID();
        await sql`
            INSERT INTO library_groups (id, name)
            VALUES (${deniedGroup}::uuid, ${DENIED_GROUP_NAME})
        `;
    });

    /** Deny exactly these library groups; age axis left unrestricted. */
    function denyGroups(...ids: string[]): MediaAccessBoundary {
        return restrictedAccess({ deniedGroupIds: ids, maxAgeRating: null, allowUnrated: true });
    }

    /** Cap the age axis; library axis left unrestricted. */
    function ageLimit(maxAgeRating: number, allowUnrated: boolean): MediaAccessBoundary {
        return restrictedAccess({ deniedGroupIds: [], maxAgeRating, allowUnrated });
    }

    /**
     * Seed one active movie with a backdrop blurhash (getHeroFallbackItem
     * requires it) and aggregated metadata (getQualityLibraryMedia joins it).
     *
     * `libraryGroupId` attaches a media_files row in that group — WITHOUT a file
     * row the library predicate always admits the item (it explicitly passes
     * rows that have no media_file_items at all), so a denied-group test would
     * silently prove nothing.
     */
    async function seed(opts: {
        libraryGroupId?: string | null;
        ageRating?: number | null;
    }): Promise<string> {
        const item = createTestMediaItem({ media_type: 'movie', has_files: true });
        await insertTestMediaItem(sql, item);
        await sql`
            UPDATE media_items
               SET backdrop_blurhash = 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
                   age_rating = ${opts.ageRating ?? null}
             WHERE id = ${item.id}::uuid
        `;
        await sql`
            INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
            VALUES (${item.id}::uuid, 'aggregated', ${sql.json({
                overview: 'Boundary fixture',
                imdb_rating: 7.0,
                popularity: 100,
                backdrop_path: '/b.jpg',
            })}, NOW())
        `;
        if (opts.libraryGroupId) {
            const fileId = crypto.randomUUID();
            await sql`
                INSERT INTO media_files (id, file_path, library_group_id, created_at, updated_at)
                VALUES (${fileId}::uuid, ${`/test/hero/${item.id}.mkv`}, ${opts.libraryGroupId}::uuid, NOW(), NOW())
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${fileId}::uuid, ${item.id}::uuid)
            `;
        }
        return item.id;
    }

    async function qualityIds(access: MediaAccessBoundary): Promise<string[]> {
        const rows = await getQualityLibraryMedia(sql, { mediaType: 'movie', limit: 50, access });
        return rows.map((r) => r.internal_id as string);
    }

    describe('getQualityLibraryMedia', () => {
        it('restricted library scope is a STRICT subset of unrestricted', async () => {
            const allowedId = await seed({ libraryGroupId: null });
            const deniedId = await seed({ libraryGroupId: deniedGroup });

            const unrestricted = await qualityIds(unrestrictedAccess());
            const restricted = await qualityIds(denyGroups(deniedGroup));

            // Positive control: both rows are visible without a boundary.
            expect(unrestricted).toHaveLength(2);
            expect(unrestricted).toEqual(expect.arrayContaining([allowedId, deniedId]));

            // Subset...
            expect(restricted.every((id) => unrestricted.includes(id))).toBe(true);
            // ...and STRICTLY so — the denied row is the one that disappeared.
            expect(restricted.length).toBeLessThan(unrestricted.length);
            expect(restricted).toEqual([allowedId]);
            expect(restricted).not.toContain(deniedId);
        });

        it('restricted age scope is a STRICT subset of unrestricted', async () => {
            const kidsId = await seed({ ageRating: 6 });
            const adultId = await seed({ ageRating: 18 });

            const unrestricted = await qualityIds(unrestrictedAccess());
            const restricted = await qualityIds(ageLimit(12, false));

            expect(unrestricted).toEqual(expect.arrayContaining([kidsId, adultId]));
            expect(restricted.every((id) => unrestricted.includes(id))).toBe(true);
            expect(restricted.length).toBeLessThan(unrestricted.length);
            expect(restricted).toEqual([kidsId]);
        });

        it('allowUnrated flips whether NULL-age-rating rows survive', async () => {
            const unratedId = await seed({ ageRating: null });

            expect(await qualityIds(ageLimit(12, true))).toEqual([unratedId]);
            expect(await qualityIds(ageLimit(12, false))).toEqual([]);
        });

        it('denyAll returns EMPTY even though rows exist and are otherwise visible', async () => {
            await seed({ libraryGroupId: null });
            expect(await qualityIds(unrestrictedAccess())).toHaveLength(1);
            expect(await qualityIds(denyAllAccess())).toEqual([]);
        });
    });

    describe('getHeroFallbackItem', () => {
        it('never returns a denied-library row that unrestricted access does return', async () => {
            // The denied row is the ONLY candidate, so a boundary that was
            // dropped on the floor would hand it straight back.
            const deniedId = await seed({ libraryGroupId: deniedGroup });

            const unrestricted = await getHeroFallbackItem(sql, {
                source: 'trending',
                access: unrestrictedAccess(),
            });
            expect(unrestricted?.media_id).toBe(deniedId);

            const restricted = await getHeroFallbackItem(sql, {
                source: 'trending',
                access: denyGroups(deniedGroup),
            });
            expect(restricted).toBeNull();
        });

        it('picks the allowed row when a denied row is also present', async () => {
            const allowedId = await seed({ libraryGroupId: null });
            await seed({ libraryGroupId: deniedGroup });

            const restricted = await getHeroFallbackItem(sql, {
                source: 'trending',
                access: denyGroups(deniedGroup),
            });
            expect(restricted?.media_id).toBe(allowedId);
        });

        it('never returns an over-age row that unrestricted access does return', async () => {
            const adultId = await seed({ ageRating: 18 });

            const unrestricted = await getHeroFallbackItem(sql, {
                source: 'trending',
                access: unrestrictedAccess(),
            });
            expect(unrestricted?.media_id).toBe(adultId);

            const restricted = await getHeroFallbackItem(sql, {
                source: 'trending',
                access: ageLimit(12, true),
            });
            expect(restricted).toBeNull();
        });

        it('denyAll returns null even though a row exists and is otherwise visible', async () => {
            await seed({ libraryGroupId: null });

            expect(
                (
                    await getHeroFallbackItem(sql, {
                        source: 'trending',
                        access: unrestrictedAccess(),
                    })
                )?.media_id,
            ).toBeTruthy();
            expect(
                await getHeroFallbackItem(sql, { source: 'trending', access: denyAllAccess() }),
            ).toBeNull();
        });
    });
});
