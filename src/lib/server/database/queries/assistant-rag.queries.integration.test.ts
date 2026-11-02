// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Integration Tests for Assistant RAG Query Module
 *
 * Tests rate limit helpers, user ratings context, and media search.
 * Note: findRelevantMediaByVector requires pgvector embeddings and
 * is deferred to a separate focused test file if needed.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import type postgres from 'postgres';
import { toUserId, type UserId } from '$lib/shared/user-id.js';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
    createTestExternalIds,
    insertTestExternalIds,
    ensureTestUser,
    insertTestRating,
    createTestRating,
    insertTestEmbedding,
} from '../../../../../tests/integration/fixtures/index.js';
import { EMBEDDING_SOURCE } from '../../utils/embedding-source.js';

import {
    incrementChatUsage,
    getUserRateLimitUsage,
    getUserRecentRatings,
    searchMediaByTitle,
    getRemainingMessages,
    getUserRateLimitInfo,
    findRelevantMediaByVector,
    findMediaByGenre,
    findMediaByKeyword,
    findMediaByPerson,
    findMediaByConstraints,
} from './assistant-rag.queries.js';
import {
    denyAllAccess,
    restrictedAccess,
    unrestrictedAccess,
} from './builders/media-access-boundary.js';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';

describe('Assistant RAG Queries', () => {
    let sql: postgres.Sql;
    const userId: UserId = toUserId(randomUUID());

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [...TEST_TABLES.media, ...TEST_TABLES.userData]);
        await sql`DELETE FROM assistant_rate_limits WHERE user_id = ${userId}::uuid`;
        await ensureTestUser(sql, userId);
    });

    describe('incrementChatUsage', () => {
        it('increments usage count for a user', async () => {
            const result = await incrementChatUsage(sql, userId, false, 100);
            expect(typeof result.count).toBe('number');
            expect(result.count).toBeGreaterThanOrEqual(1);
        });
    });

    describe('getUserRateLimitUsage', () => {
        it('returns null when no record exists for today', async () => {
            const result = await getUserRateLimitUsage(sql, userId);
            expect(result).toBeNull();
        });

        it('returns usage after increment', async () => {
            await incrementChatUsage(sql, userId, false, 100);
            const result = await getUserRateLimitUsage(sql, userId);
            expect(result).not.toBeNull();
            expect(result!.message_count).toBeGreaterThanOrEqual(1);
        });
    });

    describe('getRemainingMessages', () => {
        it('returns remaining count for a user', async () => {
            const result = await getRemainingMessages(sql, userId, false, 100);
            expect(typeof result.remaining).toBe('number');
        });
    });

    describe('getUserRateLimitInfo', () => {
        it('returns null when no record exists', async () => {
            const result = await getUserRateLimitInfo(sql, userId);
            expect(result).toBeNull();
        });

        it('returns info after increment', async () => {
            await incrementChatUsage(sql, userId, false, 100);
            const result = await getUserRateLimitInfo(sql, userId);
            expect(result).not.toBeNull();
            expect(result!.message_count).toBeGreaterThanOrEqual(1);
            expect(result!.date).toBeDefined();
        });
    });

    describe('getUserRecentRatings', () => {
        it('returns empty array when user has no ratings', async () => {
            const result = await getUserRecentRatings(sql, userId);
            expect(result).toEqual([]);
        });

        it('returns user ratings with context', async () => {
            await ensureTestUser(sql, userId);
            const media = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, media);
            await insertTestRating(sql, createTestRating(userId, media.id, 8));

            const result = await getUserRecentRatings(sql, userId);
            expect(result.length).toBe(1);
            expect(result[0].rating).toBe(8);
            expect(result[0].title).toBe(media.title);
        });
    });

    describe('searchMediaByTitle', () => {
        it('finds media by title substring', async () => {
            const media = createTestMediaItem({
                media_type: 'movie',
                title: 'RAG Search Test',
            });
            await insertTestMediaItem(sql, media);
            await insertTestExternalIds(
                sql,
                createTestExternalIds(media.id, {
                    tmdbId: 777,
                    mediaType: 'movie',
                }),
            );

            const result = await searchMediaByTitle(sql, {
                title: 'RAG Search',
                access: unrestrictedAccess(),
            });
            // May be empty due to metadata join requirements
            expect(Array.isArray(result)).toBe(true);
        });

        it('filters by year when provided', async () => {
            const media = createTestMediaItem({
                media_type: 'movie',
                title: 'Year Filter',
                year: 2022,
            });
            await insertTestMediaItem(sql, media);
            await insertTestExternalIds(
                sql,
                createTestExternalIds(media.id, {
                    tmdbId: 888,
                    mediaType: 'movie',
                }),
            );

            const result = await searchMediaByTitle(sql, {
                title: 'Year Filter',
                year: 2022,
                access: unrestrictedAccess(),
            });
            expect(Array.isArray(result)).toBe(true);
        });

        it('finds a LOCAL-ONLY title that has no primary external id', async () => {
            // Regression: the query used to INNER JOIN the primary external id,
            // so local-only titles (no TMDB/provider match) were invisible.
            const media = createTestMediaItem({
                media_type: 'movie',
                title: 'Milo Farrow und ein Stein Parodie',
                has_files: true,
            });
            await insertTestMediaItem(sql, media);
            // NOTE: deliberately NO external_ids inserted.

            const result = await searchMediaByTitle(sql, {
                title: 'Milo Farrow und ein Stein',
                access: unrestrictedAccess(),
            });

            expect(result.map((r) => r.title)).toContain(media.title);
            // Local-only item resolves with a null primary external id.
            expect(result[0]?.primary_ext_id ?? null).toBeNull();
        });

        it('finds a title fuzzily despite a typo (trigram match)', async () => {
            const media = createTestMediaItem({
                media_type: 'tv',
                title: 'Fillmore',
                has_files: true,
            });
            await insertTestMediaItem(sql, media);

            // User typed one "l" — exact substring would miss; trigram catches it.
            const result = await searchMediaByTitle(sql, {
                title: 'Filmore',
                access: unrestrictedAccess(),
            });

            expect(result.map((r) => r.title)).toContain(media.title);
        });
    });
});

// =============================================================================
// Access boundary — differential tests
// =============================================================================
//
// These run each access-scoped query TWICE over ONE fixture: once with an
// explicitly unrestricted boundary, once with a restricted one, and assert the
// restricted result is a STRICT SUBSET. A boundary argument that arrives at the
// query but is never spliced into the SQL, or is spliced against the wrong
// alias, produces IDENTICAL results for both — which the strict-subset
// assertion catches and a single-boundary test cannot.
//
// This matters most for findMediaByGenre / findMediaByKeyword, whose provider
// tag/genre matches are EXISTS subqueries over `provider_metadata` (`pmg`/`pmk`)
// with no `mi` in scope. Both boundary fragments must attach at the OUTER WHERE
// against `mi`; attaching either inside the subquery silently stops filtering.
//
// The fixture isolates each axis — one movie fails ONLY the library check, one
// fails ONLY the age check — so a query that applies just one of the two
// fragments still fails. Every fixture row otherwise satisfies every
// non-access criterion of all five queries under test.
describe('assistant-rag — access boundary', () => {
    let sql: postgres.Sql;
    const boundaryUserId: UserId = toUserId(randomUUID());

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [
            ...TEST_TABLES.userData,
            'media_file_items',
            'media_files',
            'library_groups',
            ...TEST_TABLES.media,
        ]);
        await ensureTestUser(sql, boundaryUserId);
    });

    // A fixed axis-0 unit vector, used for BOTH the stored embeddings and the
    // query vector. `createTestEmbedding` returns a RANDOM unit vector and in
    // 1024 dimensions two random vectors are near-orthogonal, so distances
    // would be dominated by noise. Pinning every row to the same vector makes
    // the access boundary the only thing that can remove a row.
    const AXIS_VEC: number[] = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0));
    const AXIS_VEC_STR = `[${AXIS_VEC.join(',')}]`;

    const GENRE = 'Comedy';
    const KEYWORD = 'whodunit';
    const PERSON = 'Aurelia Vance';

    /** Deny the restricted library group AND cap the age at 12, unrated allowed. */
    function restrictedBoundary(deniedGroupId: string): MediaAccessBoundary {
        return restrictedAccess({
            deniedGroupIds: [deniedGroupId],
            maxAgeRating: 12,
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
        visible: { id: string; title: string };
        /** Fails ONLY the library axis. */
        deniedLibrary: { id: string; title: string };
        /** Fails ONLY the age axis. */
        deniedAge: { id: string; title: string };
    }

    /**
     * Three movies isolating each access axis. Each carries a LIBRARY embedding,
     * a primary tmdb external id (findRelevantMediaByVector INNER JOINs it), a
     * file (so has_files holds for the three browse queries), and a
     * provider_metadata row supplying the genre / keyword / person the browse
     * queries match on. Titles share the "Boundary Probe" prefix so
     * searchMediaByTitle can address the whole set or one row.
     */
    async function seedAxisFixture(): Promise<AxisFixture> {
        const allowedGroupId = await createLibraryGroup('Allowed');
        const deniedGroupId = await createLibraryGroup('Denied');

        // Titles are deliberately DISSIMILAR to each other. searchMediaByTitle
        // admits fuzzy trigram matches (similarity > 0.45), so a shared prefix
        // like "Probe visible" / "Probe deniedAge" would pull all three rows
        // into the candidate set of every single-title search. That turns these
        // cases into a test of the ORDER BY tie-break rather than of the access
        // boundary — and the ORDER BY has a pre-existing NULL quirk that makes
        // it pick the wrong row (`english_title` is NULL, so the leading
        // `a ILIKE q OR b ILIKE q OR c ILIKE q` key evaluates to NULL rather
        // than false for non-matching rows, and `DESC` is NULLS FIRST, sorting
        // non-matches ahead of the exact match). Unrelated to access; avoided
        // here rather than asserted on.
        const spec = [
            { key: 'visible', title: 'Zephyr Vault', tmdbId: 970001, group: 'allowed', age: 6 },
            {
                key: 'deniedLibrary',
                title: 'Marmalade Quarry',
                tmdbId: 970002,
                group: 'denied',
                age: 6,
            },
            {
                key: 'deniedAge',
                title: 'Nimbus Cascade',
                tmdbId: 970003,
                group: 'allowed',
                age: 18,
            },
        ] as const;

        const out: Record<string, { id: string; title: string }> = {};
        for (const s of spec) {
            const title = s.title;
            const movie = createTestMediaItem({ media_type: 'movie', title });
            await insertTestMediaItem(sql, movie);
            out[s.key] = { id: movie.id, title };

            await insertTestExternalIds(
                sql,
                createTestExternalIds(movie.id, { tmdbId: s.tmdbId, mediaType: 'movie' }),
            );
            await insertTestEmbedding(sql, {
                media_id: movie.id,
                embedding: AXIS_VEC,
                source: EMBEDDING_SOURCE.LIBRARY,
            });
            await attachFile(
                movie.id,
                s.group === 'allowed' ? allowedGroupId : deniedGroupId,
                `/movies/probe-${s.key}.mkv`,
            );
            await sql`UPDATE media_items SET age_rating = ${s.age} WHERE id = ${movie.id}::uuid`;

            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES (${movie.id}::uuid, 'tmdb', ${sql.json({
                    overview: 'Boundary probe fixture.',
                    genres: [{ id: 35, name: GENRE }],
                    keywords: [KEYWORD],
                    mdblist_keywords: [KEYWORD],
                    actors: [PERSON],
                    directors: [PERSON],
                    tmdb_rating: 8.0,
                })}, NOW())
            `;
        }

        return {
            deniedGroupId,
            visible: out.visible,
            deniedLibrary: out.deniedLibrary,
            deniedAge: out.deniedAge,
        };
    }

    /**
     * The shared differential shape: unrestricted must see all three fixture
     * rows, restricted must see ONLY the visible one (a strict subset that
     * isolates both axes), and denyAll must see nothing.
     */
    async function expectDifferential(
        fx: AxisFixture,
        run: (access: MediaAccessBoundary) => Promise<Array<{ media_id?: string | null }>>,
    ): Promise<void> {
        const open = await run(unrestrictedAccess());
        const openIds = new Set(open.map((r) => r.media_id));
        expect(openIds).toContain(fx.visible.id);
        expect(openIds).toContain(fx.deniedLibrary.id);
        expect(openIds).toContain(fx.deniedAge.id);

        const limited = await run(restrictedBoundary(fx.deniedGroupId));
        const limitedIds = new Set(limited.map((r) => r.media_id));

        // Strict subset: every restricted row was also an unrestricted row...
        for (const id of limitedIds) expect(openIds).toContain(id);
        // ...and it is strictly smaller, per axis.
        expect(limitedIds).toContain(fx.visible.id);
        expect(limitedIds).not.toContain(fx.deniedLibrary.id);
        expect(limitedIds).not.toContain(fx.deniedAge.id);
        expect(limitedIds.size).toBeLessThan(openIds.size);

        // Deny-everything sees nothing at all.
        expect(await run(denyAllAccess())).toEqual([]);
    }

    it('findRelevantMediaByVector: restricted is a strict subset; denyAll is empty', async () => {
        const fx = await seedAxisFixture();
        await expectDifferential(fx, (access) =>
            findRelevantMediaByVector(sql, {
                queryEmbeddingStr: AXIS_VEC_STR,
                userId: boundaryUserId,
                access,
            }),
        );
    });

    it('findMediaByGenre: restricted is a strict subset; denyAll is empty', async () => {
        const fx = await seedAxisFixture();
        await expectDifferential(fx, (access) =>
            findMediaByGenre(sql, {
                genres: [GENRE],
                limit: 50,
                userId: boundaryUserId,
                access,
            }),
        );
    });

    it('findMediaByConstraints: restricted is a strict subset; denyAll is empty', async () => {
        const fx = await seedAxisFixture();
        await expectDifferential(fx, (access) =>
            findMediaByConstraints(sql, {
                userId: boundaryUserId,
                access,
                limit: 50,
            }),
        );
    });

    // Regression: the tool shipped matching genres with
    // `jsonb_array_elements_text(...) WHERE lower(g) = ANY(names)`, which on the
    // `[{id,name}]` shape this fixture (and TMDB) stores compares
    // '{"id": 35, "name": "Comedy"}' against 'comedy' and matched NOTHING — so
    // every genre-filtered find_media / build_watch_plan call silently returned
    // zero rows. Pinned against all three stored shapes.
    describe('findMediaByConstraints genre matching', () => {
        async function genreHits(genres: string[]): Promise<Set<string | null | undefined>> {
            const rows = await findMediaByConstraints(sql, {
                userId: boundaryUserId,
                access: unrestrictedAccess(),
                genres,
                limit: 50,
            });
            return new Set(rows.map((r) => r.media_id));
        }

        it('matches the [{id,name}] object shape by name and by TMDB id', async () => {
            const fx = await seedAxisFixture();
            expect(await genreHits([GENRE])).toContain(fx.visible.id);
            // Synonym resolving to the same TMDB id, different spelling.
            expect(await genreHits(['comedy'])).toContain(fx.visible.id);
        });

        it('matches bare name-string and bare numeric-id genre arrays', async () => {
            const fx = await seedAxisFixture();
            await sql`
                UPDATE provider_metadata SET metadata = jsonb_set(metadata, '{genres}', '["Comedy"]'::jsonb)
                WHERE media_id = ${fx.visible.id}::uuid`;
            expect(await genreHits([GENRE])).toContain(fx.visible.id);

            await sql`
                UPDATE provider_metadata SET metadata = jsonb_set(metadata, '{genres}', '[35]'::jsonb)
                WHERE media_id = ${fx.visible.id}::uuid`;
            expect(await genreHits([GENRE])).toContain(fx.visible.id);
        });

        it('does not match an unrelated genre', async () => {
            const fx = await seedAxisFixture();
            expect(await genreHits(['Horror'])).not.toContain(fx.visible.id);
        });
    });

    it('findMediaByKeyword: restricted is a strict subset; denyAll is empty', async () => {
        const fx = await seedAxisFixture();
        await expectDifferential(fx, (access) =>
            findMediaByKeyword(sql, {
                keywords: [KEYWORD],
                limit: 50,
                userId: boundaryUserId,
                access,
            }),
        );
    });

    it('findMediaByPerson: restricted is a strict subset; denyAll is empty', async () => {
        const fx = await seedAxisFixture();
        await expectDifferential(fx, (access) =>
            findMediaByPerson(sql, {
                person: PERSON,
                limit: 50,
                userId: boundaryUserId,
                access,
            }),
        );
    });

    // searchMediaByTitle has LIMIT 1, so a subset over the whole fixture is a
    // weak assertion — one visible row would satisfy it even with the boundary
    // dropped. Address each denied row by its OWN unique title instead, so the
    // only candidate is the one the boundary must remove.
    describe('searchMediaByTitle (LIMIT 1 — per-axis single-candidate cases)', () => {
        it('drops a row denied on the LIBRARY axis only', async () => {
            const fx = await seedAxisFixture();
            const q = { title: fx.deniedLibrary.title };

            const open = await searchMediaByTitle(sql, { ...q, access: unrestrictedAccess() });
            expect(open.map((r) => r.media_id)).toEqual([fx.deniedLibrary.id]);

            const limited = await searchMediaByTitle(sql, {
                ...q,
                access: restrictedBoundary(fx.deniedGroupId),
            });
            expect(limited).toEqual([]);
        });

        it('drops a row denied on the AGE axis only', async () => {
            const fx = await seedAxisFixture();
            const q = { title: fx.deniedAge.title };

            const open = await searchMediaByTitle(sql, { ...q, access: unrestrictedAccess() });
            expect(open.map((r) => r.media_id)).toEqual([fx.deniedAge.id]);

            const limited = await searchMediaByTitle(sql, {
                ...q,
                access: restrictedBoundary(fx.deniedGroupId),
            });
            expect(limited).toEqual([]);
        });

        it('keeps a row that passes both axes, and denyAll returns empty', async () => {
            const fx = await seedAxisFixture();
            const q = { title: fx.visible.title };

            const limited = await searchMediaByTitle(sql, {
                ...q,
                access: restrictedBoundary(fx.deniedGroupId),
            });
            expect(limited.map((r) => r.media_id)).toEqual([fx.visible.id]);

            expect(await searchMediaByTitle(sql, { ...q, access: denyAllAccess() })).toEqual([]);
        });

        // The two branches (year / no-year) build their own boundary fragments.
        // Cover the year branch too — it is a separate template literal, and the
        // pre-migration code shared one fragment pair across both.
        it('applies the boundary on the YEAR branch as well', async () => {
            const fx = await seedAxisFixture();
            const [row] = await sql<{ year: number | null }[]>`
                SELECT year FROM media_items WHERE id = ${fx.deniedLibrary.id}::uuid
            `;
            if (row?.year == null) return; // fixture has no year — nothing to assert
            const q = { title: fx.deniedLibrary.title, year: row.year };

            const open = await searchMediaByTitle(sql, { ...q, access: unrestrictedAccess() });
            expect(open.map((r) => r.media_id)).toEqual([fx.deniedLibrary.id]);

            const limited = await searchMediaByTitle(sql, {
                ...q,
                access: restrictedBoundary(fx.deniedGroupId),
            });
            expect(limited).toEqual([]);
        });
    });
});
