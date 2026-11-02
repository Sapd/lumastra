// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration test for MoodRecommendationsService's taste-damper wiring.
 *
 * findMoodMediaPersonalized (mood-recommendations.queries.ts) has always
 * applied the "show less like this" penalty in its ORDER BY — but
 * getMoodRecommendations previously never fetched the user's active damper
 * context, so the query always received `damper = null` and the penalty was
 * permanently inert for the mood rail. This test exercises the SERVICE entry
 * point (not the query function directly) so a regression in the wiring —
 * not just the SQL — fails it.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { toUserId } from '$lib/shared/user-id.js';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../tests/integration/helpers/cleanup.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
    createTestExternalIds,
    insertTestExternalIds,
    insertTestEmbedding,
    ensureTestUser,
} from '../../../../tests/integration/fixtures/index.js';
import { EMBEDDING_SOURCE } from '../utils/embedding-source.js';
import { cacheManager, CACHE_NAMESPACES } from '../cache/index.js';
import { TasteDamperService } from './taste-damper.service.js';
import { getMoodRecommendations } from './mood-recommendations.service.js';
import type { SearchAccessContext } from '../utils/search-access-context.js';

const DIM = 1024;
const SQRT3_OVER_2 = Math.sqrt(3) / 2;

function vec(entries: Record<number, number>): number[] {
    const v = new Array<number>(DIM).fill(0);
    for (const [i, val] of Object.entries(entries)) v[Number(i)] = val;
    return v;
}

const accessCtx: SearchAccessContext = {
    username: null,
    deniedGroupIds: null,
    ageRating: null,
    liveTvAllowed: true,
    showUnavailableMedia: true,
};

let sql: postgres.Sql;

beforeAll(() => {
    sql = getTestDb();
});

afterAll(async () => {
    await closeTestDb();
});

beforeEach(async () => {
    await truncateTables(sql, [...TEST_TABLES.media, ...TEST_TABLES.userData]);
    // The damper context centers cosines against a cached global embedding
    // mean (see TasteDamperService.getGlobalMean) — clear it so a prior
    // test/file's seeded embeddings can't leak into this run's mean.
    await cacheManager.for(CACHE_NAMESPACES.globalEmbeddingMean).delete('global-mean:v1');
});

/** Seed a movie matching the 'exciting' mood profile with a fixed LIBRARY embedding. */
async function seedMoodItem(title: string, tmdbId: number, embedding: number[]): Promise<string> {
    const item = createTestMediaItem({ media_type: 'movie', title });
    await insertTestMediaItem(sql, item);
    await insertTestExternalIds(
        sql,
        createTestExternalIds(item.id, { tmdbId, mediaType: 'movie' }),
    );
    await sql`
        INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
        VALUES (${item.id}::uuid, 'tmdb',
            ${sql.json({ overview: 'Test', imdb_rating: 7.0, mdblist_keywords: ['action-packed'] })}, NOW())
    `;
    await sql`UPDATE media_items SET has_files = true WHERE id = ${item.id}::uuid`;
    await insertTestEmbedding(sql, {
        media_id: item.id,
        embedding,
        source: EMBEDDING_SOURCE.LIBRARY,
    });
    return item.id;
}

describe('getMoodRecommendations — taste-damper wiring', () => {
    it('demotes an item in an active damper neighborhood below an equally-relevant one', async () => {
        const userId = toUserId(randomUUID());
        await ensureTestUser(sql, userId);

        // catalog_embedding = axis 0. X and Y both sit at 60° from it (equal
        // ai_similarity = cos(60°) = 0.5) but in DIFFERENT planes, so
        // mean-centering makes X's damper-centered vector the exact negation
        // of Y's — see the sibling query-level test in
        // mood-recommendations.queries.integration.test.ts for the full
        // derivation.
        const catalogEmbedding = vec({ 0: 1 });
        const xEmbedding = vec({ 0: 0.5, 1: SQRT3_OVER_2 });
        const yEmbedding = vec({ 0: 0.5, 2: SQRT3_OVER_2 });

        const vectorLiteral = `[${catalogEmbedding.join(',')}]`;
        await sql`
            UPDATE user_profiles
            SET catalog_embedding = ${vectorLiteral}::vector
            WHERE user_id = ${userId}::uuid
        `;

        const damped = await seedMoodItem('Damped Movie', 992001, xEmbedding);
        const unrelated = await seedMoodItem('Unrelated Movie', 992002, yEmbedding);

        // damper target IS the item to be damped, so its mean-centered cosine
        // against its own damper vector is exactly 1 (max penalty), while the
        // unrelated item's works out to the exact opposite direction (penalty 0).
        const damperService = new TasteDamperService(sql);
        await damperService.recordDamper(userId, damped, 'movie');

        const items = await getMoodRecommendations(sql, {
            userId,
            mood: 'exciting',
            limit: 10,
            accessCtx,
        });

        const damperIdx = items.findIndex((i) => i.media_id === damped);
        const unrelatedIdx = items.findIndex((i) => i.media_id === unrelated);
        expect(damperIdx).toBeGreaterThanOrEqual(0);
        expect(unrelatedIdx).toBeGreaterThanOrEqual(0);
        // Tied relevance_score, but the damped item's ranking score is
        // attenuated — it must sort strictly below the unrelated one.
        expect(unrelatedIdx).toBeLessThan(damperIdx);
    });
});

describe('getMoodRecommendations — cache behaviour', () => {
    const moodCache = cacheManager.for(CACHE_NAMESPACES.moodRecommendations);

    /** Seed a movie matching the 'exciting' profile, no embedding (non-personalized path). */
    async function seedPlainItem(tmdbId: number): Promise<string> {
        const item = createTestMediaItem({ media_type: 'movie', title: `Cache ${tmdbId}` });
        await insertTestMediaItem(sql, item);
        await insertTestExternalIds(
            sql,
            createTestExternalIds(item.id, { tmdbId, mediaType: 'movie' }),
        );
        await sql`
            INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
            VALUES (${item.id}::uuid, 'tmdb',
                ${sql.json({ overview: 'T', imdb_rating: 9.0, mdblist_keywords: ['action-packed'] })}, NOW())
        `;
        await sql`UPDATE media_items SET has_files = true WHERE id = ${item.id}::uuid`;
        return item.id;
    }

    it('serves a second identical call from cache (does not observe a concurrent DB insert)', async () => {
        const userId = toUserId(randomUUID());
        await ensureTestUser(sql, userId);
        await seedPlainItem(970101);

        const first = await getMoodRecommendations(sql, {
            userId,
            mood: 'exciting',
            limit: 10,
            accessCtx,
        });
        expect(first.length).toBe(1);

        // Add a second matching title behind the cache's back.
        await seedPlainItem(970102);

        const second = await getMoodRecommendations(sql, {
            userId,
            mood: 'exciting',
            limit: 10,
            accessCtx,
        });
        // Still 1 — proving the second call was served from cache, not re-queried.
        expect(second.length).toBe(1);

        // …and `refresh` must bypass it and see both.
        const refreshed = await getMoodRecommendations(sql, {
            userId,
            mood: 'exciting',
            limit: 10,
            accessCtx,
            refresh: true,
        });
        expect(refreshed.length).toBe(2);
    });

    it('is purged by deleteUserCache, so a rating change is visible immediately', async () => {
        // Guards the cacheInvalidation.onUserRating wiring: the mood entry must
        // be stored under the user's cache scope, or the invalidation on rating
        // silently no-ops and a just-disliked title lingers for the whole TTL.
        const userId = toUserId(randomUUID());
        await ensureTestUser(sql, userId);
        const mediaId = await seedPlainItem(970103);

        const before = await getMoodRecommendations(sql, {
            userId,
            mood: 'exciting',
            limit: 10,
            accessCtx,
        });
        expect(before.length).toBe(1);

        await sql`
            INSERT INTO user_ratings (user_id, media_id, rating, suggestion_context, skipped)
            VALUES (${userId}, ${mediaId}::uuid, 3, NULL, false)
        `;
        await moodCache.deleteUserCache(userId);

        const after = await getMoodRecommendations(sql, {
            userId,
            mood: 'exciting',
            limit: 10,
            accessCtx,
        });
        expect(after.length).toBe(0);
    });

    it('does not let one user’s cached mood satisfy another user', async () => {
        const userA = toUserId(randomUUID());
        const userB = toUserId(randomUUID());
        await ensureTestUser(sql, userA);
        await ensureTestUser(sql, userB);
        const mediaId = await seedPlainItem(970104);
        // Only userA dislikes it — userB must still see it.
        await sql`
            INSERT INTO user_ratings (user_id, media_id, rating, suggestion_context, skipped)
            VALUES (${userA}, ${mediaId}::uuid, 2, NULL, false)
        `;

        const a = await getMoodRecommendations(sql, {
            userId: userA,
            mood: 'exciting',
            limit: 10,
            accessCtx,
        });
        const b = await getMoodRecommendations(sql, {
            userId: userB,
            mood: 'exciting',
            limit: 10,
            accessCtx,
        });

        expect(a.length).toBe(0);
        expect(b.length).toBe(1);
    });
});
