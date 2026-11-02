// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * upsertUserProfile — embedding-preservation contract (real Postgres).
 *
 * Regression for the embedding-gap rec-death bug: when embeddings are mid-
 * regeneration (e.g. after a reset/re-embed), a profile rebuild produces a NULL
 * catalog_embedding. The ON CONFLICT upsert must COALESCE — i.e. PRESERVE an
 * existing non-null embedding rather than clobber it with NULL (which silently
 * empties recs until the next rebuild). A genuine new embedding still overwrites.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../tests/integration/helpers/cleanup.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
    createTestExternalIds,
    insertTestExternalIds,
    insertTestEmbedding,
    generateTestUserId,
    insertTestRating,
    createTestRating,
    ensureTestUser,
    derivedUsername,
} from '../../../../tests/integration/fixtures/index.js';
import { EMBEDDING_SOURCE } from '../utils/embedding-source.js';
import { toUserId, type UserId } from '$lib/shared/user-id.js';
import { config, features } from '$lib/server/config.js';
import { UserProfileService, type UserProfileDatabaseDeps } from './user-profile.service.js';
import { UserRatingsService } from './user-ratings.service.js';
import { EmbeddingOperationsService } from './embedding-operations.service.js';
import { batchResolveMediaIds } from '../database/queries/media-queries.js';
import { getIncludeWatchHistoryPreference } from '../database/queries/user-profile-prefs.queries.js';

// upsertUserProfile only touches `this.sql`; deps are never reached.
const unusedDeps = {} as unknown as UserProfileDatabaseDeps;

/**
 * Real (non-stubbed) UserProfileDatabaseDeps wired the same way
 * connection.ts's lazy `userProfileService` getter wires them for
 * production — needed so `rebuildUserProfile`'s canonical path exercises the
 * real ratings/embedding queries end-to-end against Postgres.
 */
function buildRealDeps(sql: postgres.Sql): UserProfileDatabaseDeps {
    const ratingsService = new UserRatingsService(sql);
    const embeddingOperationsService = new EmbeddingOperationsService(sql);
    return {
        getMediaEmbedding: async () => null,
        getMediaEmbeddingByUuid: async () => null,
        getUserRatingsWithUuid: (userId, limit, includeSkipped) =>
            ratingsService.getUserRatingsWithUuid(userId, limit, includeSkipped),
        batchResolveMediaIds: (items) => batchResolveMediaIds(sql, items),
        batchBuildMediaEmbeddingsFromUuids: (mediaIds) =>
            embeddingOperationsService.batchBuildMediaEmbeddingsFromUuids(mediaIds),
        getIncludeWatchHistoryPreference: (userId) => getIncludeWatchHistoryPreference(sql, userId),
    };
}

/** Mirrors the manual watch_history seeding helper in
 * for-you-helpers.queries.integration.test.ts — no shared export exists. */
async function insertWatchHistoryRow(
    sql: postgres.Sql,
    userId: string,
    mediaId: string,
    opts: {
        status: 'completed' | 'abandoned' | 'active';
        actualWatchTimeSeconds: number;
        completionPercentage: number | null;
    },
): Promise<void> {
    await ensureTestUser(sql, userId);
    await sql`
        INSERT INTO watch_history (
            user_id, media_type, source_service, title,
            session_start_time, actual_watch_time_seconds,
            completion_percentage, status, media_id
        ) VALUES (
            ${userId}, 'movie', 'lumastra', 'Test',
            NOW(), ${opts.actualWatchTimeSeconds},
            ${opts.completionPercentage}, ${opts.status},
            ${mediaId}::uuid
        )
    `;
}

/** Unit vector in a 1024-dim space with 1 on the given axis, 0 elsewhere. */
function axisVector(dim: number, axis: number): number[] {
    return Array.from({ length: dim }, (_, i) => (i === axis ? 1 : 0));
}

async function embeddingDim(sql: postgres.Sql): Promise<number> {
    const [row] = await sql<{ type: string }[]>`
        SELECT format_type(a.atttypid, a.atttypmod) AS type
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        WHERE c.relname = 'user_profiles' AND a.attname = 'catalog_embedding'
    `;
    const match = row?.type?.match(/vector\((\d+)\)/);
    return match ? Number.parseInt(match[1], 10) : 8; // unconstrained vector → any dim
}

function unitVector(dim: number, hot: number): number[] {
    return Array.from({ length: dim }, (_, i) => (i === hot ? 1 : 0));
}

async function seedUser(sql: postgres.Sql): Promise<UserId> {
    const id = randomUUID();
    await sql`INSERT INTO users (id, username) VALUES (${id}::uuid, ${derivedUsername(id)})`;
    return toUserId(id);
}

async function storedEmbedding(sql: postgres.Sql, userId: UserId): Promise<string | null> {
    const [row] = await sql<{ e: string | null }[]>`
        SELECT catalog_embedding::text AS e FROM user_profiles WHERE user_id = ${userId}::uuid
    `;
    return row?.e ?? null;
}

describe('upsertUserProfile — embedding preservation (COALESCE)', () => {
    let sql: postgres.Sql;
    let service: UserProfileService;
    let dim: number;

    beforeAll(async () => {
        sql = getTestDb();
        service = new UserProfileService(sql, unusedDeps);
        dim = await embeddingDim(sql);
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await sql`DELETE FROM user_profiles WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'u\\_%')`;
        await sql`DELETE FROM users WHERE username LIKE 'u\\_%'`;
    });

    function baseProfile(userId: UserId, embedding: number[] | null) {
        return {
            user_id: userId,
            catalog_embedding: embedding,
            request_embedding: embedding,
            availability_preference: 0.7,
            quality_weight: 0.2,
            popularity_weight: 0.1,
            recency_weight: 0.1,
            preferences: { created_from: 'ratings' as const },
            total_ratings: 3,
            last_activity: new Date(),
        };
    }

    it('preserves an existing embedding when a rebuild writes NULL', async () => {
        const userId = await seedUser(sql);
        const good = unitVector(dim, 0);

        await service.upsertUserProfile(baseProfile(userId, good));
        const afterGood = await storedEmbedding(sql, userId);
        expect(afterGood).not.toBeNull();

        // Embedding-gap rebuild: no rated-item embeddings available → NULL.
        await service.upsertUserProfile(baseProfile(userId, null));
        const afterNull = await storedEmbedding(sql, userId);

        // PRESERVED, not clobbered — this is the fix.
        expect(afterNull).not.toBeNull();
        expect(afterNull).toBe(afterGood);
    });

    it('still overwrites with a genuine new (non-null) embedding', async () => {
        const userId = await seedUser(sql);

        await service.upsertUserProfile(baseProfile(userId, unitVector(dim, 0)));
        const first = await storedEmbedding(sql, userId);

        await service.upsertUserProfile(baseProfile(userId, unitVector(dim, 1)));
        const second = await storedEmbedding(sql, userId);

        expect(second).not.toBeNull();
        expect(second).not.toBe(first);
    });

    it('writes NULL on first creation when no prior embedding exists', async () => {
        const userId = await seedUser(sql);

        await service.upsertUserProfile(baseProfile(userId, null));

        // Cold-start with nothing to preserve → NULL is correct.
        expect(await storedEmbedding(sql, userId)).toBeNull();
    });
});

/**
 * rebuildUserProfile — behavioral abandonment demotion (real Postgres).
 *
 * Regression for finding I4: `softDemote` (getBehaviorallyDemotedMediaIds →
 * createEnhancedUserProfile weight attenuation) was only wired into the
 * manual admin `generate-enhanced-profile` route, never into the canonical
 * `rebuildUserProfile` path that every rating-milestone/watch-completion
 * rebuild actually uses — so an admin-applied demotion was silently
 * discarded on the user's next automatic rebuild. This exercises
 * `rebuildUserProfile` directly (not the admin route) end-to-end against a
 * real database and asserts the demotion measurably shifts the resulting
 * profile centroid.
 */
describe('rebuildUserProfile — behavioral abandonment demotion', () => {
    let sql: postgres.Sql;
    let service: UserProfileService;
    const EMBEDDING_DIM = 1024;

    beforeAll(async () => {
        sql = getTestDb();
        service = new UserProfileService(sql, buildRealDeps(sql));
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [
            ...TEST_TABLES.media,
            ...TEST_TABLES.userData,
            ...TEST_TABLES.watchStatus,
        ]);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('attenuates the profile centroid toward the non-demoted item when abandonment demotion is enabled', async () => {
        vi.spyOn(features, 'forYouAbandonmentDemote', 'get').mockReturnValue(true);
        vi.spyOn(config, 'FORYOU_ABANDONMENT_DEMOTE_MULTIPLIER', 'get').mockReturnValue(0.3);

        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);

        // Item A: abandoned mid-watch (qualifies for behavioral demotion) AND
        // rated highly — reaches the positive centroid via the rating, but
        // should be soft-demoted for having been abandoned.
        const itemA = createTestMediaItem({ media_type: 'movie' });
        await insertTestMediaItem(sql, itemA);
        await insertTestExternalIds(
            sql,
            createTestExternalIds(itemA.id, { tmdbId: 920001, mediaType: 'movie' }),
        );
        await insertTestEmbedding(sql, {
            media_id: itemA.id,
            embedding: axisVector(EMBEDDING_DIM, 0),
            source: EMBEDDING_SOURCE.LIBRARY,
        });
        await insertTestRating(sql, createTestRating(userId, itemA.id, 8));

        // Item B: rated highly, never abandoned — unaffected control.
        const itemB = createTestMediaItem({ media_type: 'movie' });
        await insertTestMediaItem(sql, itemB);
        await insertTestExternalIds(
            sql,
            createTestExternalIds(itemB.id, { tmdbId: 920002, mediaType: 'movie' }),
        );
        await insertTestEmbedding(sql, {
            media_id: itemB.id,
            embedding: axisVector(EMBEDDING_DIM, 1),
            source: EMBEDDING_SOURCE.LIBRARY,
        });
        await insertTestRating(sql, createTestRating(userId, itemB.id, 8));

        // getBehaviorallyDemotedMediaIds requires >=20 total watch_history
        // rows for the user (dev/test-account noise floor) before a
        // qualifying abandonment counts — pad with 19 filler rows, then the
        // one qualifying abandonment against item A (>=5min watched, <60%
        // completion).
        for (let i = 0; i < 19; i++) {
            await insertWatchHistoryRow(sql, userId, itemB.id, {
                status: 'completed',
                actualWatchTimeSeconds: 1800,
                completionPercentage: 100,
            });
        }
        await insertWatchHistoryRow(sql, userId, itemA.id, {
            status: 'abandoned',
            actualWatchTimeSeconds: 600,
            completionPercentage: 35,
        });

        const profile = await service.rebuildUserProfile(userId);

        expect(profile).not.toBeNull();
        expect(profile?.catalog_embedding).not.toBeNull();

        // `RETURNING *` hands back the pgvector column as its raw text
        // representation (no custom type parser registered for the vector
        // OID) — parse it the same way `getUserProfile` does.
        const raw = String(profile!.catalog_embedding);
        const match = raw.match(/\[([\d.,\s-]+)\]/);
        expect(match).not.toBeNull();
        const centroid = match![1].split(',').map((x) => Number.parseFloat(x.trim()));

        // Both items share equal base weight (same rating, same media type,
        // unwatched-rating branch) — without demotion the centroid would sit
        // equidistant between axis 0 (item A) and axis 1 (item B). With the
        // default 0.3 demote multiplier applied to item A's weight, the
        // centroid must skew markedly toward item B's axis.
        expect(centroid[1]).toBeGreaterThan(centroid[0]);
        expect(centroid[0]).toBeCloseTo(0.287, 1);
        expect(centroid[1]).toBeCloseTo(0.958, 1);
    });
});
