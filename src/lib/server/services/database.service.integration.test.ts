// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for DatabaseService.
 *
 * DatabaseService normally wraps the application web pool (getDb()). In the
 * integration harness, connection.ts captures DATABASE_URL at module load,
 * which the vitest setup mirror does not reliably redirect to lumastra_tests in
 * time — so getDb() would otherwise hit the dev database. We therefore mock
 * ONLY connection.ts's `getDb` / `testDbConnection` factory functions to return
 * the harness `getTestDb()` handle, while keeping the REAL `Database` class
 * (its constructor accepts a provided sql handle). Every query the service
 * issues then runs against the seeded lumastra_tests rows.
 *
 * Populated read paths (real DB state seeded per test):
 *   getSystemStats          – counts reflect seeded users/ratings/items/suggestions
 *   validateUserAccess      – canUseAI=true once a user has >= 5 ratings
 *   getUserOnboardingStatus – ratingsCount / hasProfile / needsOnboarding
 *   getUserRatings          – returns the seeded ratings
 *   getMediaEmbeddingByUuid – resolves a seeded media item by UUID
 *
 * Empty-state read paths:
 *   validateUserAccess / getUserRatings / getMediaEmbeddingByUuid /
 *   getUserOnboardingStatus all exercise the not-found branch.
 *
 * Connection/availability + factory methods + cleanupExpiredData smoke.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../tests/integration/helpers/cleanup.js';
import { toUserId, type UserId } from '$lib/shared/user-id.js';

// ---------------------------------------------------------------------------
// Pin connection.ts's pool factories to the harness test DB while keeping the
// real Database class. `Database`'s constructor resolves getDb() when no sql is
// passed, so overriding getDb() is sufficient for both `new Database()` and the
// service's `this.sql = getDb()`.
// ---------------------------------------------------------------------------

const { mockGetTestSql } = vi.hoisted(() => ({
    mockGetTestSql: vi.fn(),
}));

vi.mock('$lib/server/database/connection.js', async (importActual) => {
    const actual = await importActual<typeof import('$lib/server/database/connection.js')>();
    // The real Database constructor resolves its OWN module-internal getDb()
    // when no sql is passed (it does not read the mocked export), so wrap the
    // class to inject the harness handle whenever the caller passes nothing.
    class TestDatabase extends actual.Database {
        constructor(providedSql?: postgres.Sql | null) {
            super(providedSql ?? mockGetTestSql());
        }
    }
    return {
        ...actual,
        Database: TestDatabase,
        getDb: () => mockGetTestSql(),
        getTaskDb: () => mockGetTestSql(),
        testDbConnection: vi.fn().mockResolvedValue(true),
    };
});

import { DatabaseService } from './database.service.js';

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

const CLEANUP_TABLES = [
    'media_embeddings',
    'external_ids',
    'provider_metadata',
    'user_suggestions',
    'user_ratings',
    'user_profiles',
    'media_items',
    'users',
] as const;

function embeddingVector(dims = 1024): string {
    return `[${Array.from({ length: dims }, (_, i) => (i % 100) / 100).join(',')}]`;
}

/** Seed an active movie media_items row; returns its UUID. */
async function seedMovie(
    sql: postgres.Sql,
    opts: { title: string; year?: number } = { title: 'Seeded Movie' },
): Promise<string> {
    const id = crypto.randomUUID();
    await sql`
        INSERT INTO media_items (id, title, media_type, year, status)
        VALUES (${id}::uuid, ${opts.title}, 'movie', ${opts.year ?? null}, 'active')
    `;
    return id;
}

/**
 * Seed a users row + the user_profiles row it is FK-required to have.
 * All user-data columns are uuid REFERENCES users(id) since mig 16.46.0.
 * The `displayName` parameter is stored as the username; the returned UUID is
 * the stable users.id that must be used as user_id in all child tables.
 */
async function seedUser(sql: postgres.Sql, displayName: string): Promise<UserId> {
    const id = crypto.randomUUID();
    await sql`
        INSERT INTO users (id, username) VALUES (${id}::uuid, ${displayName})
        ON CONFLICT (username) DO UPDATE SET id = users.id
    `;
    // Re-read the id in case of conflict (idempotent between tests).
    const [{ id: resolvedId }] = await sql<{ id: string }[]>`
        SELECT id FROM users WHERE username = ${displayName}
    `;
    // user_ratings.user_id / user_suggestions.user_id both FK to
    // user_profiles.user_id, so a profile row is mandatory before either.
    await sql`
        INSERT INTO user_profiles (user_id, total_ratings, updated_at)
        VALUES (${resolvedId}::uuid, 0, NOW())
        ON CONFLICT (user_id) DO NOTHING
    `;
    return toUserId(resolvedId);
}

/**
 * Seed a user (with the FK-mandated profile) and N rating rows, each against
 * its own seeded movie. Returns the user's UUID (users.id).
 */
async function seedUserWithRatings(
    sql: postgres.Sql,
    opts: { userId: string; ratingCount: number },
): Promise<UserId> {
    const uuid = await seedUser(sql, opts.userId);
    for (let i = 0; i < opts.ratingCount; i++) {
        const mediaId = await seedMovie(sql, {
            title: `Rated ${i}`,
            year: 2000 + i,
        });
        await sql`
            INSERT INTO user_ratings (user_id, media_id, rating)
            VALUES (${uuid}::uuid, ${mediaId}::uuid, ${7 + (i % 3)})
        `;
    }
    return uuid;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('DatabaseService (integration)', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        DatabaseService.resetInstance();
        mockGetTestSql.mockReturnValue(sql);
        await truncateTables(sql, CLEANUP_TABLES);
    });

    // -------------------------------------------------------------------------
    // Connection health
    // -------------------------------------------------------------------------

    describe('isAvailable / testConnection', () => {
        it('reports available when the test DB is reachable', async () => {
            const svc = DatabaseService.getInstance();
            expect(await svc.isAvailable()).toBe(true);
        });

        it('getSql returns the test connection after initialization', async () => {
            const svc = DatabaseService.getInstance();
            await svc.isAvailable();
            const handle = await svc.getSql();
            expect(handle).toBe(sql);
        });

        it('getDatabase returns a non-null Database after initialization', async () => {
            const svc = DatabaseService.getInstance();
            await svc.isAvailable();
            expect(await svc.getDatabase()).not.toBeNull();
        });
    });

    // -------------------------------------------------------------------------
    // getSystemStats – populated
    // -------------------------------------------------------------------------

    describe('getSystemStats', () => {
        it('reports zero across the board on an empty database', async () => {
            const svc = DatabaseService.getInstance();
            const stats = await svc.getSystemStats();

            expect(stats.totalUsers).toBe(0);
            expect(stats.totalRatings).toBe(0);
            expect(stats.totalMediaItems).toBe(0);
            expect(stats.totalSuggestions).toBe(0);
        });

        it('reflects seeded users, ratings, active media items and suggestions', async () => {
            // 2 distinct raters: alice (3 ratings), bob (2 ratings) → 5 ratings,
            // 2 distinct users. Each rating seeds its own active movie → 5 items.
            const aliceId = await seedUserWithRatings(sql, { userId: 'alice', ratingCount: 3 });
            await seedUserWithRatings(sql, { userId: 'bob', ratingCount: 2 });

            // One extra non-active (deleted) item must NOT be counted —
            // getSystemStats only counts status='active' media items.
            const deletedId = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, status)
                VALUES (${deletedId}::uuid, 'Deleted', 'movie', 'deleted')
            `;

            // One suggestion row for alice.
            const suggMedia = await seedMovie(sql, { title: 'Suggested' });
            await sql`
                INSERT INTO user_suggestions (user_id, media_id, combined_score)
                VALUES (${aliceId}::uuid, ${suggMedia}::uuid, 0.9)
            `;

            const svc = DatabaseService.getInstance();
            const stats = await svc.getSystemStats();

            expect(stats.totalUsers).toBe(2); // COUNT(DISTINCT user_id)
            expect(stats.totalRatings).toBe(5); // COUNT(*) of user_ratings
            // 5 rated movies + 1 suggested movie = 6 active; inactive excluded.
            expect(stats.totalMediaItems).toBe(6);
            expect(stats.totalSuggestions).toBe(1);
            // Invariant: distinct raters <= total rating rows.
            expect(stats.totalRatings).toBeGreaterThanOrEqual(stats.totalUsers);
        });
    });

    // -------------------------------------------------------------------------
    // validateUserAccess
    // -------------------------------------------------------------------------

    describe('validateUserAccess', () => {
        it('rejects a UUID that does not exist in the database (0/5 ratings)', async () => {
            const svc = DatabaseService.getInstance();
            const result = await svc.validateUserAccess(toUserId(crypto.randomUUID()));
            expect(result.canUseAI).toBe(false);
            expect(result.reason).toMatch(/insufficient ratings \(0\/5 required\)/i);
        });

        it('rejects a second absent UUID (independent seed)', async () => {
            const svc = DatabaseService.getInstance();
            const result = await svc.validateUserAccess(toUserId(crypto.randomUUID()));
            expect(result.canUseAI).toBe(false);
            expect(result.reason).toMatch(/insufficient ratings \(0\/5 required\)/i);
        });

        it('rejects a user with fewer than 5 ratings (reports the exact count)', async () => {
            const fewId = await seedUserWithRatings(sql, {
                userId: 'fewratings',
                ratingCount: 3,
            });

            const svc = DatabaseService.getInstance();
            const result = await svc.validateUserAccess(fewId);

            expect(result.canUseAI).toBe(false);
            expect(result.reason).toMatch(/insufficient ratings \(3\/5 required\)/i);
        });

        it('rejects a brand-new user with no ratings (0/5)', async () => {
            const svc = DatabaseService.getInstance();
            const result = await svc.validateUserAccess(toUserId(crypto.randomUUID()));
            expect(result.canUseAI).toBe(false);
            expect(result.reason).toMatch(/insufficient ratings \(0\/5 required\)/i);
        });

        it('grants access once a user has 5 ratings', async () => {
            const powerId = await seedUserWithRatings(sql, {
                userId: 'poweruser',
                ratingCount: 5,
            });

            const svc = DatabaseService.getInstance();
            const result = await svc.validateUserAccess(powerId);

            expect(result.canUseAI).toBe(true);
            expect(result.reason).toBeUndefined();
        });
    });

    // -------------------------------------------------------------------------
    // getUserOnboardingStatus
    // -------------------------------------------------------------------------

    describe('getUserOnboardingStatus', () => {
        it('reports needsOnboarding for a completely unknown user', async () => {
            const svc = DatabaseService.getInstance();
            const status = await svc.getUserOnboardingStatus(toUserId(crypto.randomUUID()));

            expect(status.hasRatings).toBe(false);
            expect(status.ratingsCount).toBe(0);
            expect(status.hasProfile).toBe(false);
            expect(status.needsOnboarding).toBe(true);
        });

        it('still needs onboarding with ratings below 5 even when a profile exists', async () => {
            const partialId = await seedUserWithRatings(sql, {
                userId: 'partial',
                ratingCount: 4,
            });

            const svc = DatabaseService.getInstance();
            const status = await svc.getUserOnboardingStatus(partialId);

            expect(status.hasRatings).toBe(true);
            expect(status.ratingsCount).toBe(4);
            expect(status.hasProfile).toBe(true);
            // ratings < 5 → still needs onboarding.
            expect(status.needsOnboarding).toBe(true);
        });

        it('is complete with >= 5 ratings and a profile', async () => {
            const completeId = await seedUserWithRatings(sql, {
                userId: 'complete',
                ratingCount: 6,
            });

            const svc = DatabaseService.getInstance();
            const status = await svc.getUserOnboardingStatus(completeId);

            expect(status.ratingsCount).toBe(6);
            expect(status.hasProfile).toBe(true);
            expect(status.needsOnboarding).toBe(false);
        });
    });

    // -------------------------------------------------------------------------
    // getUserRatings
    // -------------------------------------------------------------------------

    describe('getUserRatings', () => {
        it('returns an empty array for a user that has never rated anything', async () => {
            const svc = DatabaseService.getInstance();
            const ratings = await svc.getUserRatings(toUserId(crypto.randomUUID()), 50);
            expect(ratings).toEqual([]);
        });

        it('returns the seeded ratings for a user', async () => {
            const raterId = await seedUserWithRatings(sql, { userId: 'rater', ratingCount: 3 });

            const svc = DatabaseService.getInstance();
            const ratings = await svc.getUserRatings(raterId, 50);

            expect(ratings).toHaveLength(3);
            for (const r of ratings) {
                // user_id is now uuid (mig 16.46.0)
                expect(r.user_id).toBe(raterId);
                expect(typeof r.rating).toBe('number');
                expect(r.media_id).toBeTruthy();
            }
        });

        it('respects the limit parameter', async () => {
            const manyId = await seedUserWithRatings(sql, {
                userId: 'manyratings',
                ratingCount: 5,
            });

            const svc = DatabaseService.getInstance();
            const ratings = await svc.getUserRatings(manyId, 2);

            expect(ratings).toHaveLength(2);
        });
    });

    // -------------------------------------------------------------------------
    // getMediaEmbeddingByUuid
    // -------------------------------------------------------------------------

    describe('getMediaEmbeddingByUuid', () => {
        it('returns null for a UUID that does not exist', async () => {
            const svc = DatabaseService.getInstance();
            expect(
                await svc.getMediaEmbeddingByUuid('00000000-0000-0000-0000-000000000000'),
            ).toBeNull();
            expect(await svc.getMediaEmbeddingByUuid(crypto.randomUUID())).toBeNull();
        });

        it('resolves a seeded media item (title, year, tmdb_id, embedding) by UUID', async () => {
            const mediaId = await seedMovie(sql, {
                title: 'The Lantern',
                year: 1999,
            });
            await sql`
                INSERT INTO external_ids (media_id, provider, external_id, media_type)
                VALUES (${mediaId}::uuid, 'tmdb', '603', 'movie')
            `;
            await sql`
                INSERT INTO media_embeddings (media_id, source, embedding)
                VALUES (${mediaId}::uuid, 'library', ${embeddingVector()}::vector)
            `;

            const svc = DatabaseService.getInstance();
            const result = await svc.getMediaEmbeddingByUuid(mediaId);

            expect(result).not.toBeNull();
            expect(result?.internal_id).toBe(mediaId);
            expect(result?.title).toBe('The Lantern');
            expect(result?.release_year).toBe(1999);
            expect(result?.tmdb_id).toBe(603);
            expect(result?.media_type).toBe('movie');
        });
    });

    // -------------------------------------------------------------------------
    // cleanupExpiredData
    // -------------------------------------------------------------------------

    describe('cleanupExpiredData', () => {
        it('deletes suggestions older than 7 days but keeps recent ones', async () => {
            const cleanupId = await seedUser(sql, 'cleanup');
            const oldMedia = await seedMovie(sql, { title: 'Old Suggestion' });
            const freshMedia = await seedMovie(sql, {
                title: 'Fresh Suggestion',
            });

            await sql`
                INSERT INTO user_suggestions (user_id, media_id, combined_score, created_at)
                VALUES (${cleanupId}::uuid, ${oldMedia}::uuid, 0.5, NOW() - INTERVAL '10 days')
            `;
            await sql`
                INSERT INTO user_suggestions (user_id, media_id, combined_score, created_at)
                VALUES (${cleanupId}::uuid, ${freshMedia}::uuid, 0.5, NOW())
            `;

            const svc = DatabaseService.getInstance();
            await expect(svc.cleanupExpiredData()).resolves.not.toThrow();

            const remaining = await sql<{ media_id: string }[]>`
                SELECT media_id FROM user_suggestions WHERE user_id = ${cleanupId}::uuid
            `;
            // Only the fresh suggestion survives.
            expect(remaining).toHaveLength(1);
            expect(remaining[0].media_id).toBe(freshMedia);
        });
    });

    // -------------------------------------------------------------------------
    // Service factory methods
    // -------------------------------------------------------------------------

    describe('service factory methods', () => {
        it('getCatalogService returns a non-null service', async () => {
            const svc = DatabaseService.getInstance();
            expect(await svc.getCatalogService()).not.toBeNull();
        });

        it('getUserRatingsService returns a non-null service', async () => {
            const svc = DatabaseService.getInstance();
            expect(await svc.getUserRatingsService()).not.toBeNull();
        });
    });
});
