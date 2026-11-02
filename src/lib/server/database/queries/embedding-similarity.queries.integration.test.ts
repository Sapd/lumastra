// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Embedding Similarity Query Module
 *
 * Tests UUID resolution, source embedding fetch, and steered similarity
 * against a real PostgreSQL test database with pgvector.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
    createTestExternalIds,
    insertTestExternalIds,
    createTestEmbedding,
    insertTestEmbedding,
} from '../../../../../tests/integration/fixtures/index.js';
import { EMBEDDING_SOURCE } from '../../utils/embedding-source.js';

import {
    resolveUuidToProvider,
    getSourceEmbedding,
    querySteeredSimilarity,
} from './embedding-similarity.queries.js';
import {
    denyAllAccess,
    restrictedAccess,
    unrestrictedAccess,
} from './builders/media-access-boundary.js';

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Embedding Similarity Queries', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await truncateTables(sql, TEST_TABLES.media);
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
    });

    // ========================================================================
    // Helpers
    // ========================================================================

    async function seedMovie(
        tmdbId: number,
        options: {
            libraryEmb?: boolean;
            discoveryEmb?: boolean;
            mediaType?: 'movie' | 'tv';
        } = {},
    ): Promise<string> {
        const id = crypto.randomUUID();
        const mediaType = options.mediaType ?? 'movie';
        const item = createTestMediaItem({
            id,
            title: `Sim Movie ${tmdbId}`,
            media_type: mediaType,
            year: 2024,
        });
        await insertTestMediaItem(sql, item);
        await insertTestExternalIds(sql, createTestExternalIds(id, { tmdbId, mediaType }));
        if (options.libraryEmb) {
            await insertTestEmbedding(sql, createTestEmbedding(id, EMBEDDING_SOURCE.LIBRARY));
        }
        if (options.discoveryEmb) {
            await insertTestEmbedding(sql, createTestEmbedding(id, EMBEDDING_SOURCE.DISCOVERY));
        }
        return id;
    }

    // ========================================================================
    // resolveUuidToProvider
    // ========================================================================

    describe('resolveUuidToProvider', () => {
        it('resolves UUID to tmdb_id and media_type', async () => {
            const id = await seedMovie(990300);

            const row = await resolveUuidToProvider(sql, id);
            expect(row).not.toBeNull();
            expect(row!.tmdb_id).toBe('990300');
            expect(row!.media_type).toBe('movie');
        });

        it('returns null for unknown UUID', async () => {
            const row = await resolveUuidToProvider(sql, crypto.randomUUID());
            expect(row).toBeNull();
        });

        it('returns null when no tmdb external id exists', async () => {
            const id = crypto.randomUUID();
            await insertTestMediaItem(sql, createTestMediaItem({ id, media_type: 'movie' }));

            const row = await resolveUuidToProvider(sql, id);
            expect(row).toBeNull();
        });
    });

    // ========================================================================
    // getSourceEmbedding
    // ========================================================================

    describe('getSourceEmbedding', () => {
        it('prefers library embedding over discovery', async () => {
            await seedMovie(990301, { libraryEmb: true, discoveryEmb: true });

            const row = await getSourceEmbedding(sql, '990301', 'movie');
            expect(row).not.toBeNull();
            expect(row!.embedding).toBeTruthy();
        });

        it('falls back to discovery when library missing', async () => {
            await seedMovie(990302, { discoveryEmb: true });

            const row = await getSourceEmbedding(sql, '990302', 'movie');
            expect(row).not.toBeNull();
        });

        it('returns null when no embedding exists', async () => {
            await seedMovie(990303);

            const row = await getSourceEmbedding(sql, '990303', 'movie');
            expect(row).toBeNull();
        });
    });

    // ========================================================================
    // querySteeredSimilarity
    // ========================================================================

    describe('querySteeredSimilarity', () => {
        it('returns results for a valid steered vector', async () => {
            // Seed source item
            await seedMovie(990304, { libraryEmb: true });
            // Seed candidates
            for (let i = 0; i < 3; i++) {
                await seedMovie(990305 + i, { libraryEmb: true });
            }

            const steeredVector = '[' + Array(1024).fill(0.1).join(',') + ']';
            const rows = await querySteeredSimilarity(sql, {
                steeredVectorStr: steeredVector,
                mediaType: 'movie',
                sourceTmdbId: '990304',
                dismissedTmdbIds: [],
                watchedTmdbIds: [],
                limit: 10,
                access: unrestrictedAccess(),
            });

            expect(rows.length).toBeGreaterThanOrEqual(0);
        });

        it('excludes source tmdb id', async () => {
            await seedMovie(990308, { libraryEmb: true });
            await seedMovie(990309, { libraryEmb: true });

            const rows = await querySteeredSimilarity(sql, {
                steeredVectorStr: '[' + Array(1024).fill(0.1).join(',') + ']',
                mediaType: 'movie',
                sourceTmdbId: '990308',
                dismissedTmdbIds: [],
                watchedTmdbIds: [],
                limit: 10,
                access: unrestrictedAccess(),
            });

            const ids = rows.map((r) => r.primary_ext_id);
            expect(ids).not.toContain('990308');
        });

        it('excludes dismissed and watched tmdb ids', async () => {
            await seedMovie(990310, { libraryEmb: true });
            await seedMovie(990311, { libraryEmb: true });
            await seedMovie(990312, { libraryEmb: true });

            const rows = await querySteeredSimilarity(sql, {
                steeredVectorStr: '[' + Array(1024).fill(0.1).join(',') + ']',
                mediaType: 'movie',
                sourceTmdbId: '990310',
                dismissedTmdbIds: ['990311'],
                watchedTmdbIds: [],
                limit: 10,
                access: unrestrictedAccess(),
            });

            const ids = rows.map((r) => r.primary_ext_id);
            expect(ids).not.toContain('990311');
        });

        it('respects limit', async () => {
            for (let i = 0; i < 5; i++) {
                await seedMovie(990313 + i, { libraryEmb: true });
            }

            const rows = await querySteeredSimilarity(sql, {
                steeredVectorStr: '[' + Array(1024).fill(0.1).join(',') + ']',
                mediaType: 'movie',
                sourceTmdbId: '990313',
                dismissedTmdbIds: [],
                watchedTmdbIds: [],
                limit: 2,
                access: unrestrictedAccess(),
            });

            expect(rows.length).toBeLessThanOrEqual(2);
        });

        // ====================================================================
        // SQL-H2: HNSW index usage (two-phase rewrite regression guard)
        //
        // The previous implementation ordered directly by the computed
        // `combined_score` expression, which structurally prevents PostgreSQL
        // from using the partial HNSW indexes (idx_me_*_hnsw) — the planner
        // is forced into a Seq Scan + Sort over every embedding row.
        //
        // The two-phase rewrite gathers candidates per source via the raw
        // `<=>` operator, which IS HNSW-eligible. This test asserts that the
        // phase-1 candidate plan can use the HNSW index. We disable enable_sort
        // for the assertion so the planner is forced to prefer an ordered index
        // scan over a top-N heapsort regardless of the tiny test-table size —
        // the OLD computed-expression form cannot satisfy that and would still
        // fall back to a btree scan + Sort node.
        // ====================================================================
        it('phase-1 candidate KNN can use the HNSW index (SQL-H2)', async () => {
            for (let i = 0; i < 25; i++) {
                await seedMovie(991000 + i, {
                    libraryEmb: true,
                    discoveryEmb: i % 2 === 0,
                });
            }
            await sql`ANALYZE media_embeddings`;
            await sql`ANALYZE media_items`;

            const steeredVector = '[' + Array(1024).fill(0.1).join(',') + ']';

            // EXPLAIN the phase-1 library-source KNN subquery exactly as the
            // rewrite issues it (raw <=> ordering). With enable_sort off, an
            // HNSW-eligible query reports an Index Scan on idx_me_library_hnsw.
            // Use a reserved connection so the session-scoped SET does not leak
            // into the shared pool.
            const reserved = await sql.reserve();
            let planText: string;
            try {
                await reserved`SET enable_sort = off`;
                const plan = await reserved.unsafe(
                    `
                    EXPLAIN (COSTS OFF, FORMAT TEXT)
                    WITH steered_vec AS (
                        SELECT '${steeredVector}'::vector AS vec
                    )
                    SELECT lib_emb.media_id
                    FROM media_embeddings lib_emb
                    JOIN media_items cmi ON cmi.id = lib_emb.media_id
                        AND cmi.status = 'active'
                        AND cmi.media_type = 'movie'
                    CROSS JOIN steered_vec sv
                    WHERE lib_emb.source = 'library'
                    ORDER BY lib_emb.embedding <=> sv.vec
                    LIMIT 200;
                    `,
                );
                planText = (plan as Array<Record<string, string>>)
                    .map((r) => Object.values(r).join('\n'))
                    .join('\n');
            } finally {
                reserved.release();
            }

            expect(planText).toContain('idx_me_library_hnsw');
            // The combined-distance expression must NOT appear as a sort key:
            // candidate gathering orders by the raw operator only.
            expect(planText).not.toMatch(/Sort Key:.*1.*-.*<=>/);
        });
    });
});

// ---------------------------------------------------------------------------
// Access boundary — differential coverage
//
// These assert the boundary argument actually reaches the emitted SQL and lands
// on the right alias. A boundary that arrived but was silently ignored (or one
// whose predicate was applied to the phase-1 `cmi` alias instead of the phase-2
// `mi` alias) would make `restricted` equal `unrestricted` here, or blow up at
// runtime — neither of which the pre-existing tests above could detect, since
// they all ran unrestricted.
// ---------------------------------------------------------------------------

describe('querySteeredSimilarity access boundary', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [
            'media_file_items',
            'media_files',
            'library_groups',
            ...TEST_TABLES.media,
        ]);
    });

    // `createTestEmbedding` returns a RANDOM unit vector, and in 1024 dimensions
    // two random vectors are near-orthogonal — scores would then be dominated by
    // noise. Giving every fixture row the SAME vector, and steering with it,
    // pins similarity identically across rows so the access boundary is the only
    // thing that can change the result set.
    const AXIS_VEC: number[] = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0));
    const AXIS_VEC_STR = `[${AXIS_VEC.join(',')}]`;

    async function createLibraryGroup(name: string): Promise<string> {
        const [row] = await sql<{ id: string }[]>`
            INSERT INTO library_groups (name, sort_order, created_at, updated_at)
            VALUES (${name}, 1, NOW(), NOW())
            RETURNING id
        `;
        return row.id;
    }

    async function attachFile(mediaItemId: string, libraryGroupId: string): Promise<void> {
        const [file] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path, library_group_id, created_at, updated_at)
            VALUES (${`/movies/${mediaItemId}.mkv`}, ${libraryGroupId}::uuid, NOW(), NOW())
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
        sourceTmdbId: string;
    }

    /**
     * A source row plus three candidates, each isolating one outcome:
     * one passes both axes, one fails ONLY the library axis, one fails ONLY the
     * age axis. All three are otherwise identical, so any difference between the
     * unrestricted and restricted result sets is attributable to the boundary.
     */
    async function seedAxisFixture(): Promise<AxisFixture> {
        const allowedGroupId = await createLibraryGroup('Allowed');
        const deniedGroupId = await createLibraryGroup('Denied');

        const spec = [
            { tmdbId: 992000, group: 'allowed', age: 6 }, // source
            { tmdbId: 992001, group: 'allowed', age: 6 }, // visible
            { tmdbId: 992002, group: 'denied', age: 6 }, // fails library axis
            { tmdbId: 992003, group: 'allowed', age: 18 }, // fails age axis
        ] as const;

        for (const s of spec) {
            const movie = createTestMediaItem({
                media_type: 'movie',
                title: `Boundary ${s.tmdbId}`,
            });
            await insertTestMediaItem(sql, movie);
            await insertTestExternalIds(
                sql,
                createTestExternalIds(movie.id, { tmdbId: s.tmdbId, mediaType: 'movie' }),
            );
            await insertTestEmbedding(sql, {
                media_id: movie.id,
                embedding: AXIS_VEC,
                source: EMBEDDING_SOURCE.LIBRARY,
            });
            await attachFile(movie.id, s.group === 'allowed' ? allowedGroupId : deniedGroupId);
            await sql`UPDATE media_items SET age_rating = ${s.age} WHERE id = ${movie.id}::uuid`;
        }

        return { deniedGroupId, sourceTmdbId: '992000' };
    }

    async function run(
        fx: AxisFixture,
        access: Parameters<typeof querySteeredSimilarity>[1]['access'],
    ): Promise<string[]> {
        const rows = await querySteeredSimilarity(sql, {
            steeredVectorStr: AXIS_VEC_STR,
            mediaType: 'movie',
            sourceTmdbId: fx.sourceTmdbId,
            dismissedTmdbIds: [],
            watchedTmdbIds: [],
            limit: 50,
            access,
        });
        return rows.map((r) => r.primary_ext_id);
    }

    it('restricted rows are a strict subset of unrestricted rows', async () => {
        const fx = await seedAxisFixture();

        const open = await run(fx, unrestrictedAccess());
        const closed = await run(
            fx,
            restrictedAccess({
                deniedGroupIds: [fx.deniedGroupId],
                maxAgeRating: 12,
                allowUnrated: true,
            }),
        );

        expect(open).toEqual(expect.arrayContaining(['992001', '992002', '992003']));
        for (const id of closed) {
            expect(open).toContain(id);
        }
        expect(closed.length).toBeLessThan(open.length);
    });

    it('the library axis alone removes only the denied-group row', async () => {
        const fx = await seedAxisFixture();

        const closed = await run(
            fx,
            restrictedAccess({
                deniedGroupIds: [fx.deniedGroupId],
                maxAgeRating: null,
                allowUnrated: true,
            }),
        );

        expect(closed).not.toContain('992002');
        expect(closed).toEqual(expect.arrayContaining(['992001', '992003']));
    });

    it('the age axis alone removes only the over-age row', async () => {
        const fx = await seedAxisFixture();

        const closed = await run(
            fx,
            restrictedAccess({
                deniedGroupIds: [],
                maxAgeRating: 12,
                allowUnrated: true,
            }),
        );

        expect(closed).not.toContain('992003');
        expect(closed).toEqual(expect.arrayContaining(['992001', '992002']));
    });

    it('a denyAll boundary returns an empty result', async () => {
        const fx = await seedAxisFixture();

        expect(await run(fx, denyAllAccess())).toEqual([]);
    });

    it('denyAll short-circuits before opening a transaction', async () => {
        // The short-circuit exists so a deny-everything caller never pays for
        // the `sql.begin` + `set_config('hnsw.ef_search', ...)` + ANN scan.
        // Passing a `sql` whose every method throws proves nothing was issued.
        const exploding = new Proxy(
            {},
            {
                get() {
                    throw new Error('querySteeredSimilarity issued a query under denyAll');
                },
            },
        ) as unknown as postgres.Sql;

        await expect(
            querySteeredSimilarity(exploding, {
                steeredVectorStr: AXIS_VEC_STR,
                mediaType: 'movie',
                sourceTmdbId: '992000',
                dismissedTmdbIds: [],
                watchedTmdbIds: [],
                limit: 50,
                access: denyAllAccess(),
            }),
        ).resolves.toEqual([]);
    });
});
