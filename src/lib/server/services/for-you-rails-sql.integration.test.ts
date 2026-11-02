// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * SQL-shape smoke tests plus access-boundary differential coverage for the
 * for-you.service rail queries that build their access predicates inline.
 *
 * The smoke half: these queries live inline in for-you.service.ts and were
 * restructured with per-availability-class `availability_ranked` windows; unit
 * tests mock `sql`, so a syntax error in any of the four branches (personalized
 * / non-personalized × short-movies / anime) would otherwise surface only at
 * runtime. Each test executes the real SQL against the test database — an empty
 * result is fine, a thrown query error is the regression.
 *
 * The differential half: each rail is run TWICE over the same fixture — once
 * with an explicitly unrestricted boundary, once with a restricted one — and
 * the restricted result must be a STRICT subset. A denyAll boundary must return
 * nothing. That is what catches a boundary argument that arrived but was never
 * spliced into the SQL (both runs would return the same set) and a predicate
 * attached to the wrong table alias (the query throws, or filters the wrong
 * rows).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id.js';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../tests/integration/helpers/cleanup.js';
import {
    generateTestUserId,
    ensureTestUser,
    createTestMediaItem,
    insertTestMediaItem,
} from '../../../../tests/integration/fixtures/index.js';
import {
    fetchShortMovies,
    fetchAnimeRecommendations,
    fetchPopularKeywords,
} from './for-you.service.js';
import {
    denyAllAccess,
    restrictedAccess,
    unrestrictedAccess,
} from '../database/queries/builders/media-access-boundary.js';
import type { MediaAccessBoundary } from '../database/queries/builders/media-access-boundary.js';
import {
    getMetadataProviderChain,
    getPrimaryExternalIdProvider,
} from '../utils/provider-config.js';

describe('for-you rail SQL smoke (availability_ranked windows)', () => {
    let sql: postgres.Sql;
    let userId: UserId;

    beforeAll(async () => {
        sql = getTestDb();
        userId = generateTestUserId();
        await ensureTestUser(sql, userId);
    });

    afterAll(async () => {
        await closeTestDb();
    });

    it('fetchShortMovies non-personalized branch executes', async () => {
        const rows = await fetchShortMovies(sql, 5, null, [], unrestrictedAccess());
        expect(Array.isArray(rows)).toBe(true);
    });

    it('fetchShortMovies personalized branch executes', async () => {
        const rows = await fetchShortMovies(sql, 5, userId, [123], unrestrictedAccess());
        expect(Array.isArray(rows)).toBe(true);
    });

    it('fetchAnimeRecommendations non-personalized branch executes', async () => {
        const rows = await fetchAnimeRecommendations(sql, 5, null, [], null, unrestrictedAccess());
        expect(Array.isArray(rows)).toBe(true);
    });

    it('fetchAnimeRecommendations personalized branch executes', async () => {
        const rows = await fetchAnimeRecommendations(
            sql,
            5,
            userId,
            [123],
            null,
            unrestrictedAccess(),
        );
        expect(Array.isArray(rows)).toBe(true);
    });
});

// ============================================================================
// Access boundary — differential coverage
// ============================================================================

describe('for-you rails: access boundary', () => {
    let sql: postgres.Sql;

    /** Deny the restricted library group AND cap the age at 12, unrated hidden. */
    function restrictedBoundary(deniedGroupId: string): MediaAccessBoundary {
        return restrictedAccess({
            deniedGroupIds: [deniedGroupId],
            maxAgeRating: 12,
            allowUnrated: false,
        });
    }

    /** Library axis only — isolates rails that never apply the age axis. */
    function libraryOnlyBoundary(deniedGroupId: string): MediaAccessBoundary {
        return restrictedAccess({
            deniedGroupIds: [deniedGroupId],
            maxAgeRating: null,
            allowUnrated: true,
        });
    }

    async function createLibraryGroup(name: string): Promise<string> {
        const [row] = await sql<{ id: string }[]>`
            INSERT INTO library_groups (name, sort_order, created_at, updated_at)
            VALUES (${name}, 1, NOW(), NOW())
            RETURNING id
        `;
        return row.id;
    }

    async function attachFile(
        mediaItemId: string,
        libraryGroupId: string,
        path: string,
    ): Promise<void> {
        const [file] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path, library_group_id, created_at, updated_at)
            VALUES (${path}, ${libraryGroupId}::uuid, NOW(), NOW())
            RETURNING id
        `;
        await sql`
            INSERT INTO media_file_items (file_id, media_item_id)
            VALUES (${file.id}::uuid, ${mediaItemId}::uuid)
        `;
        await sql`UPDATE media_items SET has_files = true WHERE id = ${mediaItemId}::uuid`;
    }

    interface AxisFixture {
        deniedGroupId: string;
        /** Passes both axes. */
        visibleId: string;
        /** Fails the LIBRARY axis only. */
        deniedLibraryId: string;
        /** Fails the AGE axis only. */
        deniedAgeId: string;
    }

    /**
     * Seed three short movies that isolate each axis: one passes both, one fails
     * only the library axis, one fails only the age axis. A query that drops the
     * library predicate keeps `deniedLibraryId`; one that drops the age
     * predicate keeps `deniedAgeId`.
     *
     * `media_scalars` rows are written directly (the projection is normally
     * trigger-maintained from provider_metadata). Exactly ONE row per media_id
     * is inserted, so that row is trivially the "winning source" the rail's
     * buildWinningSourceScalarFilterFragment picks.
     */
    async function seedShortMovies(tag: string): Promise<AxisFixture> {
        const allowedGroupId = await createLibraryGroup(`Allowed ${tag}`);
        const deniedGroupId = await createLibraryGroup(`Denied ${tag}`);
        const source = getMetadataProviderChain()[0];
        const provider = getPrimaryExternalIdProvider();

        const specs = [
            { title: `${tag} AAA Visible`, group: allowedGroupId, age: 6 },
            { title: `${tag} BBB Denied Library`, group: deniedGroupId, age: 6 },
            { title: `${tag} CCC Denied Age`, group: allowedGroupId, age: 18 },
        ];

        const ids: string[] = [];
        for (const [i, spec] of specs.entries()) {
            const item = createTestMediaItem({ media_type: 'movie', title: spec.title });
            await insertTestMediaItem(sql, item);
            await sql`
                INSERT INTO external_ids (media_id, provider, external_id, media_type)
                VALUES (${item.id}::uuid, ${provider}, ${String(900_000 + i)}, 'movie')
                ON CONFLICT DO NOTHING
            `;
            await sql`
                INSERT INTO media_scalars (
                    media_id, source, imdb_rating, mdblist_score,
                    runtime_minutes, release_date, release_year
                )
                VALUES (
                    ${item.id}::uuid, ${source}, 7.5, 70,
                    80, '2015-01-01'::date, 2015
                )
                ON CONFLICT (media_id, source) DO NOTHING
            `;
            await sql`UPDATE media_items SET age_rating = ${spec.age}, status = 'active' WHERE id = ${item.id}::uuid`;
            await attachFile(item.id, spec.group, `/movies/${tag}-${i}.mkv`);
            ids.push(item.id);
        }

        return {
            deniedGroupId,
            visibleId: ids[0],
            deniedLibraryId: ids[1],
            deniedAgeId: ids[2],
        };
    }

    /** Assert `restricted` is a strict subset of `unrestricted`. */
    function expectStrictSubset(restricted: string[], unrestricted: string[]): void {
        for (const id of restricted) {
            expect(unrestricted).toContain(id);
        }
        expect(restricted.length).toBeLessThan(unrestricted.length);
    }

    beforeAll(() => {
        sql = getTestDb();
    });

    // Each differential test seeds its own axis fixture and then asserts on
    // exact set membership, so leftovers from a previous run (the test DB is
    // not reset between files) would leak rows that belong to a library group
    // this run never denies — and the subset assertions would fail.
    beforeEach(async () => {
        await truncateTables(sql, [
            'media_scalars',
            'provider_metadata',
            'media_file_items',
            'media_files',
            'library_groups',
            'media_items',
            'external_ids',
        ]);
    });

    afterAll(async () => {
        await closeTestDb();
    });

    describe('fetchShortMovies', () => {
        it('restricted result is a strict subset and each axis filters independently', async () => {
            const fx = await seedShortMovies('sm');

            const unrestricted = await fetchShortMovies(sql, 50, null, [], unrestrictedAccess());
            const unrestrictedIds = unrestricted
                .map((r) => r.externalIds?.internal)
                .filter((id): id is string => typeof id === 'string');

            // The fixture must actually be reachable, otherwise a subset
            // assertion over two empty sets would pass vacuously.
            expect(unrestrictedIds).toContain(fx.visibleId);
            expect(unrestrictedIds).toContain(fx.deniedLibraryId);
            expect(unrestrictedIds).toContain(fx.deniedAgeId);

            const restricted = await fetchShortMovies(
                sql,
                50,
                null,
                [],
                restrictedBoundary(fx.deniedGroupId),
            );
            const restrictedIds = restricted
                .map((r) => r.externalIds?.internal)
                .filter((id): id is string => typeof id === 'string');

            expectStrictSubset(restrictedIds, unrestrictedIds);
            expect(restrictedIds).toContain(fx.visibleId);
            // Library predicate present and spliced into the candidate CTE.
            expect(restrictedIds).not.toContain(fx.deniedLibraryId);
            // Age predicate present and bound to the `mi` alias, not `ms`.
            expect(restrictedIds).not.toContain(fx.deniedAgeId);
        });

        it('denyAll returns empty', async () => {
            const rows = await fetchShortMovies(sql, 50, null, [], denyAllAccess());
            expect(rows).toEqual([]);
        });
    });

    describe('fetchPopularKeywords', () => {
        /**
         * Keyword rails read `provider_metadata.metadata->'mdblist_keywords'`,
         * and the whitelist gate needs >= 5 distinct media per keyword, so seed
         * six movies per group.
         */
        async function seedKeywordMovies(): Promise<{ deniedGroupId: string }> {
            const allowedGroupId = await createLibraryGroup('KW Allowed');
            const deniedGroupId = await createLibraryGroup('KW Denied');
            const provider = getPrimaryExternalIdProvider();
            const source = getMetadataProviderChain()[0];

            // Each group gets one keyword under `mdblist_keywords` (UNION branch
            // one) and a different one under `keywords` (UNION branch two), so
            // dropping the access fragment from EITHER branch is detectable.
            let n = 0;
            for (const [group, keyword, altKeyword] of [
                [allowedGroupId, 'time-travel', 'heist'],
                [deniedGroupId, 'outer-space', 'cyberpunk'],
            ] as const) {
                for (let i = 0; i < 6; i++) {
                    const item = createTestMediaItem({
                        media_type: 'movie',
                        title: `KW ${keyword} ${i}`,
                    });
                    await insertTestMediaItem(sql, item);
                    await sql`UPDATE media_items SET status = 'active' WHERE id = ${item.id}::uuid`;
                    await sql`
                        INSERT INTO external_ids (media_id, provider, external_id, media_type)
                        VALUES (${item.id}::uuid, ${provider}, ${String(910_000 + n)}, 'movie')
                        ON CONFLICT DO NOTHING
                    `;
                    await sql`
                        INSERT INTO provider_metadata (media_id, provider, metadata)
                        VALUES (
                            ${item.id}::uuid,
                            ${source},
                            ${sql.json({ mdblist_keywords: [keyword], keywords: [altKeyword, keyword] })}
                        )
                        ON CONFLICT DO NOTHING
                    `;
                    await attachFile(item.id, group, `/movies/kw-${n}.mkv`);
                    n++;
                }
            }
            return { deniedGroupId };
        }

        it('restricted result is a strict subset (library axis only)', async () => {
            const { deniedGroupId } = await seedKeywordMovies();

            const unrestricted = await fetchPopularKeywords(sql, 100, unrestrictedAccess());
            const unrestrictedKeywords = unrestricted.map((k) => k.keyword);
            expect(unrestrictedKeywords).toContain('time-travel');
            expect(unrestrictedKeywords).toContain('heist');
            expect(unrestrictedKeywords).toContain('outer-space');
            expect(unrestrictedKeywords).toContain('cyberpunk');

            const restricted = await fetchPopularKeywords(
                sql,
                100,
                libraryOnlyBoundary(deniedGroupId),
            );
            const restrictedKeywords = restricted.map((k) => k.keyword);

            expectStrictSubset(restrictedKeywords, unrestrictedKeywords);
            expect(restrictedKeywords).toContain('time-travel');
            expect(restrictedKeywords).toContain('heist');
            // Both halves of the UNION must carry their own library fragment.
            // 'outer-space' comes from the mdblist_keywords branch, 'cyberpunk'
            // from the keywords branch — an unfiltered branch leaks its own.
            expect(restrictedKeywords).not.toContain('outer-space');
            expect(restrictedKeywords).not.toContain('cyberpunk');
        });

        it('counts each external ID once across keyword types and excludes inactive titles', async () => {
            await seedKeywordMovies();
            const initial = await fetchPopularKeywords(sql, 100, unrestrictedAccess());
            expect(initial.find((row) => row.keyword === 'time-travel')?.count).toBe(6);
            expect(initial.find((row) => row.keyword === 'heist')?.count).toBe(6);

            await sql`UPDATE media_items SET status = 'deleted' WHERE title = 'KW time-travel 0'`;
            const atThreshold = await fetchPopularKeywords(sql, 100, unrestrictedAccess());
            expect(atThreshold.find((row) => row.keyword === 'time-travel')?.count).toBe(5);
            expect(atThreshold.find((row) => row.keyword === 'heist')?.count).toBe(5);

            await sql`UPDATE media_items SET status = 'deleted' WHERE title = 'KW time-travel 1'`;
            const belowThreshold = await fetchPopularKeywords(sql, 100, unrestrictedAccess());
            expect(belowThreshold.map((row) => row.keyword)).not.toContain('time-travel');
            expect(belowThreshold.map((row) => row.keyword)).not.toContain('heist');
            expect(belowThreshold.find((row) => row.keyword === 'outer-space')?.count).toBe(6);
        });

        it('denyAll returns empty', async () => {
            const rows = await fetchPopularKeywords(sql, 100, denyAllAccess());
            expect(rows).toEqual([]);
        });
    });

    describe('fetchAnimeRecommendations', () => {
        it('denyAll returns empty', async () => {
            const rows = await fetchAnimeRecommendations(sql, 50, null, [], null, denyAllAccess());
            expect(rows).toEqual([]);
        });

        it('accepts a boundary carrying an age scope it deliberately does not apply', async () => {
            // Regression lock on the documented MISSING AXIS: this rail filters
            // on the library axis only. Handing it an age-limited boundary must
            // NOT start filtering by age (that would change which rows an
            // age-restricted user sees). It must simply not throw.
            const rows = await fetchAnimeRecommendations(
                sql,
                5,
                null,
                [],
                null,
                restrictedAccess({
                    deniedGroupIds: [],
                    maxAgeRating: 12,
                    allowUnrated: false,
                }),
            );
            expect(Array.isArray(rows)).toBe(true);
        });
    });
});
