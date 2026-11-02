// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration test for the AnimeStrategy dislike-exclusion fix.
 *
 * `fetchAnimeRecommendations` (for-you.service) has no `user_ratings`
 * awareness at all, so a disliked (rating <= 4) anime item could stay #1 in
 * "Anime For You" — every sibling personalized rail excludes the dislike
 * band. AnimeStrategy now post-filters the cached `anime` payload against
 * `getDislikedMediaIds(sql, ctx.userId)`, mirroring the existing
 * server-watched-UUID post-filter (see watched-exclusion.integration.test.ts)
 * so a rating recorded after the cache was populated still takes effect.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import postgres from 'postgres';
import { getTestDatabaseUrl } from '../../../../../../../tests/integration/setup/test-database.js';
import {
    truncateTables,
    TEST_TABLES,
} from '../../../../../../../tests/integration/helpers/cleanup.js';
import {
    ensureTestUser,
    generateTestUserId,
} from '../../../../../../../tests/integration/fixtures/index.js';
import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache/index.js';
import { animeStrategy } from './anime.strategy.js';
import type { AccessContext } from '../recommender.js';

const URL = getTestDatabaseUrl();

function ctxFor(userId: string): AccessContext {
    return {
        userId,
        username: 'itest-anime-dislike',
        deniedGroupIds: null,
        maxAgeRating: null,
        allowUnrated: true,
        showUnavailableMedia: true,
        isAgeRestricted: false,
    } as AccessContext;
}

/**
 * Seed an anime-eligible, available media item. `anime_genres: [{ id: 1 }]`
 * projects `media_scalars.has_anime_genres = true` (the PRIMARY anime
 * detection signal `fetchAnimeRecommendations` checks), and the `keywords`
 * entry projects a `media_keywords` row matching one of the
 * `ANIME_KEYWORDS_STRONG` terms, which is what the "has the user watched
 * enough anime" gate's TMDB-id fallback (`countAnimeFromTmdbIds`) looks for.
 */
async function seedAnimeItem(sql: postgres.Sql, tmdbId: number): Promise<string> {
    const id = crypto.randomUUID();
    await sql`
        INSERT INTO media_items (id, title, media_type, status, has_files)
        VALUES (${id}::uuid, ${'AnimeDislikeTest ' + tmdbId}, 'tv', 'active', true)
    `;
    await sql`
        INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
        VALUES (${id}::uuid, 'tmdb', ${String(tmdbId)}, 'tv', true)
    `;
    await sql`
        INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
        VALUES (${id}::uuid, 'tmdb', ${sql.json({
            anime_genres: [{ id: 1 }],
            keywords: ['anime'],
            mdblist_score: 80,
            imdb_rating: 7.5,
        })}, NOW())
    `;
    return id;
}

describe('AnimeStrategy — dislike exclusion (integration)', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = postgres(URL, { max: 2 });
    });

    afterAll(async () => {
        await sql.end();
    });

    beforeEach(async () => {
        await truncateTables(sql, [...TEST_TABLES.media, ...TEST_TABLES.userData]);
        await cacheManager.for(CACHE_NAMESPACES.curatedContent).clear();
    });

    it('excludes an item the user rated <= 4 from the Anime rail', async () => {
        const userId = generateTestUserId('itest-anime-dislike');
        await ensureTestUser(sql, userId);

        // Three distinct anime items satisfy the "watched enough anime"
        // TMDB-id fallback gate (FORYOU_ANIME_MIN_WATCHED default = 3); the
        // strategy reads them from opts.extra.watchedTmdbIds (client
        // `watched=` CSV equivalent).
        const gateTmdbIds = [881001, 881002, 881003];
        for (const tmdbId of gateTmdbIds) {
            await seedAnimeItem(sql, tmdbId);
        }

        // The actual candidate under test — also anime-eligible, distinct
        // from the gate items.
        const targetTmdbId = 881004;
        const mediaId = await seedAnimeItem(sql, targetTmdbId);

        const opts = {
            surface: 'internal' as const,
            limit: 50,
            extra: { watchedTmdbIds: gateTmdbIds },
        };

        const before = await animeStrategy.fetch(ctxFor(userId), opts);
        expect(before.items.some((i) => i.media.id === mediaId)).toBe(true);

        await sql`
            INSERT INTO user_ratings (user_id, media_id, rating, suggestion_context, skipped)
            VALUES (${userId}, ${mediaId}::uuid, 3, NULL, false)
        `;

        // No cache invalidation performed — the disliked-id lookup is a
        // fresh per-call query, so the exclusion must apply immediately even
        // against a cached `anime` payload.
        const after = await animeStrategy.fetch(ctxFor(userId), opts);
        expect(after.items.some((i) => i.media.id === mediaId)).toBe(false);
    });
});
