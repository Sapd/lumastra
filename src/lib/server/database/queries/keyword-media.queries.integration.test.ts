// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Keyword Media Query Module
 *
 * Tests keyword-based media search with and without personalization.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
} from '../../../../../tests/integration/fixtures/index.js';
import {
    ensureTestUser,
    generateTestUserId,
} from '../../../../../tests/integration/fixtures/user.fixtures.js';
import { toUserId } from '$lib/shared/user-id.js';

import {
    findKeywordMedia,
    findKeywordMediaPersonalized,
    userHasCatalogProfile,
} from './keyword-media.queries.js';
import {
    denyAllAccess,
    restrictedAccess,
    unrestrictedAccess,
} from './builders/media-access-boundary.js';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';

describe('Keyword Media Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [
            'media_embeddings',
            'user_profiles',
            'provider_metadata',
            'external_ids',
            'media_items',
        ]);
    });

    async function insertKeywordMedia(
        keyword: string,
        mediaType: 'movie' | 'tv' = 'movie',
    ): Promise<string> {
        const item = createTestMediaItem({ media_type: mediaType });
        await insertTestMediaItem(sql, item);

        await sql`
            INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
            VALUES (
                ${item.id}::uuid,
                'tmdb',
                ${sql.json({
                    mdblist_keywords: [keyword, 'other'],
                    keywords: [keyword],
                    overview: 'Test media with keyword',
                    mdblist_score: 80,
                    imdb_rating: 7.5,
                    rt_rating: 85,
                    letterboxd_rating: 3.5,
                    popularity: 100,
                    genres: [{ id: 28, name: 'Action' }],
                })},
                NOW()
            )
        `;

        return item.id;
    }

    // ========================================================================
    // findKeywordMedia
    // ========================================================================

    describe('findKeywordMedia', () => {
        it('returns items matching keyword in mdblist_keywords', async () => {
            const itemId = await insertKeywordMedia('spaceship');

            const result = await findKeywordMedia(sql, {
                keyword: 'spaceship',
                limit: 10,
                offset: 0,
                access: unrestrictedAccess(),
            });

            expect(result.length).toBeGreaterThan(0);
            const found = result.find((r) => r.internal_id === itemId);
            expect(found).toBeDefined();
            expect(found!.title).toBeTruthy();
        });

        it('returns items matching keyword in keywords array', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES (
                    ${item.id}::uuid,
                    'tmdb',
                    ${sql.json({
                        keywords: ['time-travel'],
                        mdblist_keywords: [],
                        overview: 'Test',
                    })},
                    NOW()
                )
            `;

            const result = await findKeywordMedia(sql, {
                keyword: 'time-travel',
                limit: 10,
                offset: 0,
                access: unrestrictedAccess(),
            });

            const found = result.find((r) => r.internal_id === item.id);
            expect(found).toBeDefined();
        });

        it('returns empty array for empty keyword', async () => {
            const result = await findKeywordMedia(sql, {
                keyword: '',
                limit: 10,
                offset: 0,
                access: unrestrictedAccess(),
            });
            expect(result).toEqual([]);
        });

        it('returns empty array for whitespace-only keyword', async () => {
            const result = await findKeywordMedia(sql, {
                keyword: '   ',
                limit: 10,
                offset: 0,
                access: unrestrictedAccess(),
            });
            expect(result).toEqual([]);
        });

        it('respects limit and offset', async () => {
            for (let i = 0; i < 3; i++) {
                await insertKeywordMedia('paginated');
            }

            const page1 = await findKeywordMedia(sql, {
                keyword: 'paginated',
                limit: 2,
                offset: 0,
                access: unrestrictedAccess(),
            });

            expect(page1.length).toBeLessThanOrEqual(2);
        });

        it('returns computed fields', async () => {
            const itemId = await insertKeywordMedia('computed');

            const result = await findKeywordMedia(sql, {
                keyword: 'computed',
                limit: 10,
                offset: 0,
                access: unrestrictedAccess(),
            });

            const found = result.find((r) => r.internal_id === itemId);
            expect(found).toBeDefined();
            expect(found).toHaveProperty('is_available');
            expect(found).toHaveProperty('can_request');
            expect(found).toHaveProperty('ai_similarity');
            expect(found!.ai_similarity).toBe(0.5);
        });
    });

    // ========================================================================
    // findKeywordMediaPersonalized
    // ========================================================================

    describe('findKeywordMediaPersonalized', () => {
        it('returns personalized results with user profile', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            // Insert a catalog_embedding for the user
            const vector = Array.from({ length: 1024 }, () => Math.random());
            await sql`
                UPDATE user_profiles
                SET catalog_embedding = ${`[${vector.join(',')}]`}::vector
                WHERE user_id = ${userId}
            `;

            const itemId = await insertKeywordMedia('personalized');

            const result = await findKeywordMediaPersonalized(sql, {
                keyword: 'personalized',
                limit: 10,
                offset: 0,
                access: unrestrictedAccess(),
                userId,
            });

            const found = result.find((r) => r.internal_id === itemId);
            expect(found).toBeDefined();
        });

        it('falls back to default similarity when no embedding', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            const itemId = await insertKeywordMedia('noembedding');

            const result = await findKeywordMediaPersonalized(sql, {
                keyword: 'noembedding',
                limit: 10,
                offset: 0,
                access: unrestrictedAccess(),
                userId,
            });

            const found = result.find((r) => r.internal_id === itemId);
            expect(found).toBeDefined();
            expect(found!.ai_similarity).toBe(0.5);
        });

        it('returns empty array when user has no profile', async () => {
            // Use a valid UUID that has no user_profiles row — the query returns
            // empty instead of erroring (user_profiles join produces no rows).
            const result = await findKeywordMediaPersonalized(sql, {
                keyword: 'nouser',
                limit: 10,
                offset: 0,
                access: unrestrictedAccess(),
                userId: toUserId('00000000-0000-0000-0000-000000000099'),
            });
            expect(result).toEqual([]);
        });

        it('returns empty array for empty keyword', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            const result = await findKeywordMediaPersonalized(sql, {
                keyword: '',
                limit: 10,
                offset: 0,
                access: unrestrictedAccess(),
                userId,
            });
            expect(result).toEqual([]);
        });
    });

    // ========================================================================
    // userHasCatalogProfile
    // ========================================================================

    describe('userHasCatalogProfile', () => {
        it('returns true when the user has a non-null catalog embedding', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            const vector = Array.from({ length: 1024 }, () => Math.random());
            await sql`
                UPDATE user_profiles
                SET catalog_embedding = ${`[${vector.join(',')}]`}::vector
                WHERE user_id = ${userId}
            `;

            expect(await userHasCatalogProfile(sql, userId)).toBe(true);
        });

        it('returns false when the user has a profile but no catalog embedding', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            expect(await userHasCatalogProfile(sql, userId)).toBe(false);
        });

        it('returns false for a user with no profile row', async () => {
            // Use a valid UUID that has no user_profiles row
            expect(
                await userHasCatalogProfile(sql, toUserId('00000000-0000-0000-0000-000000000099')),
            ).toBe(false);
        });
    });
});

/**
 * Differential access-boundary coverage.
 *
 * Each query runs TWICE over the same fixture — once unrestricted, once
 * restricted — and the restricted result must be a STRICT subset. A plain
 * "restricted returns fewer rows" assertion would pass even if the predicate
 * were applied to the wrong alias or the boundary silently dropped; requiring
 * the restricted set to be contained in the unrestricted one AND to be missing
 * exactly the seeded-inaccessible item pins down which rows disappeared.
 *
 * Both axes are exercised separately because they emit independent fragments:
 * the library axis can only exclude an item that HAS a media_files row (the
 * predicate always admits items with no file rows at all), while the age axis
 * keys off media_items.age_rating.
 */
describe('keyword-media queries — access boundary is honoured (differential)', () => {
    let sql: postgres.Sql;
    const boundaryUser = generateTestUserId();
    let deniedGroup: string;

    // Items seeded per test, all sharing this keyword.
    const KEYWORD = 'boundaryfixture';
    let openItemId: string; // no files, no age rating — always visible
    let groupItemId: string; // file in `deniedGroup` — hidden by the library axis
    let adultItemId: string; // age_rating 18 — hidden by the age axis

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await truncateTables(sql, ['user_profiles', ...TEST_TABLES.media]);
        // library_paths.library_group_id FKs library_groups ON DELETE
        // RESTRICT, so this unscoped clear throws 23503 if ANY file that ran
        // earlier left a group-attached library_paths row behind. Drop the
        // dependents first: this file's intent is "no library groups exist",
        // and a path attached to a group that is about to be deleted has to go
        // with it anyway. Group-less paths are deliberately left alone.
        await sql`DELETE FROM library_paths WHERE library_group_id IS NOT NULL`;
        await sql`DELETE FROM library_groups`;
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, ['user_profiles', ...TEST_TABLES.media]);
        // library_paths.library_group_id FKs library_groups ON DELETE
        // RESTRICT, so this unscoped clear throws 23503 if ANY file that ran
        // earlier left a group-attached library_paths row behind. Drop the
        // dependents first: this file's intent is "no library groups exist",
        // and a path attached to a group that is about to be deleted has to go
        // with it anyway. Group-less paths are deliberately left alone.
        await sql`DELETE FROM library_paths WHERE library_group_id IS NOT NULL`;
        await sql`DELETE FROM library_groups`;
        await ensureTestUser(sql, boundaryUser);

        deniedGroup = crypto.randomUUID();
        await sql`
            INSERT INTO library_groups (id, name)
            VALUES (${deniedGroup}::uuid, 'Denied Keyword Group')
        `;

        openItemId = await seed({ libraryGroupId: null, ageRating: null });
        groupItemId = await seed({ libraryGroupId: deniedGroup, ageRating: null });
        adultItemId = await seed({ libraryGroupId: null, ageRating: 18 });
    });

    async function seed(opts: {
        libraryGroupId: string | null;
        ageRating: number | null;
    }): Promise<string> {
        const item = createTestMediaItem({ media_type: 'movie' });
        await insertTestMediaItem(sql, item);

        await sql`
            INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
            VALUES (
                ${item.id}::uuid,
                'tmdb',
                ${sql.json({
                    mdblist_keywords: [KEYWORD],
                    keywords: [KEYWORD],
                    overview: 'Access boundary fixture',
                    mdblist_score: 80,
                    popularity: 50,
                })},
                NOW()
            )
        `;

        if (opts.ageRating !== null) {
            await sql`
                UPDATE media_items SET age_rating = ${opts.ageRating} WHERE id = ${item.id}::uuid
            `;
        }

        // Only an item with an actual media_files row can be excluded by the
        // library predicate — it admits every item that has no file rows.
        if (opts.libraryGroupId) {
            const fileId = crypto.randomUUID();
            await sql`
                INSERT INTO media_files (id, file_path, library_group_id, created_at, updated_at)
                VALUES (${fileId}::uuid, ${`/test/keyword/${item.id}.mkv`}, ${opts.libraryGroupId}::uuid, NOW(), NOW())
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${fileId}::uuid, ${item.id}::uuid)
            `;
            await sql`UPDATE media_items SET has_files = true WHERE id = ${item.id}::uuid`;
        }

        return item.id;
    }

    type Fetcher = (access: MediaAccessBoundary) => Promise<Array<{ internal_id: string | null }>>;

    const fetchers: Array<[string, Fetcher]> = [
        [
            'findKeywordMedia',
            (access) => findKeywordMedia(sql, { keyword: KEYWORD, limit: 50, offset: 0, access }),
        ],
        [
            'findKeywordMediaPersonalized',
            (access) =>
                findKeywordMediaPersonalized(sql, {
                    keyword: KEYWORD,
                    limit: 50,
                    offset: 0,
                    userId: boundaryUser,
                    access,
                }),
        ],
    ];

    async function idsFor(fetch: Fetcher, access: MediaAccessBoundary): Promise<Set<string>> {
        const rows = await fetch(access);
        return new Set(rows.map((r) => r.internal_id).filter((id): id is string => id !== null));
    }

    describe.each(fetchers)('%s', (_name, fetch) => {
        it('unrestricted access sees every seeded item', async () => {
            const all = await idsFor(fetch, unrestrictedAccess());
            expect(all).toContain(openItemId);
            expect(all).toContain(groupItemId);
            expect(all).toContain(adultItemId);
        });

        it('a denied library group yields a strict subset missing that item', async () => {
            const all = await idsFor(fetch, unrestrictedAccess());
            const restricted = await idsFor(
                fetch,
                restrictedAccess({
                    deniedGroupIds: [deniedGroup],
                    maxAgeRating: null,
                    allowUnrated: true,
                }),
            );

            for (const id of restricted) expect(all).toContain(id);
            expect(restricted.size).toBeLessThan(all.size);
            expect(restricted).not.toContain(groupItemId);
            // The other axis must be untouched.
            expect(restricted).toContain(openItemId);
            expect(restricted).toContain(adultItemId);
        });

        it('an age limit yields a strict subset missing the over-limit item', async () => {
            const all = await idsFor(fetch, unrestrictedAccess());
            const restricted = await idsFor(
                fetch,
                restrictedAccess({
                    deniedGroupIds: [],
                    maxAgeRating: 12,
                    allowUnrated: true,
                }),
            );

            for (const id of restricted) expect(all).toContain(id);
            expect(restricted.size).toBeLessThan(all.size);
            expect(restricted).not.toContain(adultItemId);
            expect(restricted).toContain(openItemId);
            expect(restricted).toContain(groupItemId);
        });

        it('a denyAll boundary returns nothing', async () => {
            expect(await fetch(denyAllAccess())).toEqual([]);
        });
    });
});
