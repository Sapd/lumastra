// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the server-side watched-exclusion fix on
 * FreshReleasesStrategy and ShortMoviesStrategy.
 *
 * Both rails used to only exclude already-watched items via the legacy
 * client `watched=` CSV param (`opts.extra.watchedTmdbIds`) — a param the
 * For You feed client never sends, so watched items kept reappearing.
 * Mirroring BingeWorthyStrategy/AnimeStrategy, both strategies now also
 * exclude via `watchManager.getWatchedMediaIdsCached(ctx.userId)`
 * post-cache, so a watched item is dropped even with no client param.
 *
 * `fresh-releases:global:v2` is a GLOBAL (non-user-scoped) curated-content
 * cache key, so the namespace is cleared before each test to guarantee the
 * seeded movie is actually present in the freshly computed candidate pool
 * rather than masked by a stale snapshot from an earlier run.
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
    insertTestWatchStateEntry,
} from '../../../../../../../tests/integration/fixtures/index.js';
import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache/index.js';
import { invalidateWatchedCache } from '$lib/server/services/watched-cache.service.js';
import { freshReleasesStrategy } from './fresh-releases.strategy.js';
import { shortMoviesStrategy } from './short-movies.strategy.js';
import type { AccessContext } from '../recommender.js';

const URL = getTestDatabaseUrl();

function ctxFor(userId: string): AccessContext {
    return {
        userId,
        username: 'itest-watched-exclusion',
        deniedGroupIds: null,
        maxAgeRating: null,
        allowUnrated: true,
        showUnavailableMedia: true,
        isAgeRestricted: false,
    } as AccessContext;
}

/**
 * Seed a movie eligible for BOTH Fresh Releases and Short & Sweet: a recent,
 * short (75 min), well-rated (imdb 7.5 / mdblist 80), library-available
 * (`has_files = true`, so it isn't hidden by the `showUnavailableMedia`
 * gate) movie. Writing through `provider_metadata` (provider 'tmdb') lets
 * `trg_provider_metadata_scalars` project `media_scalars` — the row also
 * becomes the query's "winning source" since it is the only source present
 * for this media_id.
 */
async function seedEligibleMovie(
    sql: postgres.Sql,
    tmdbId: number,
    releaseDate: string,
): Promise<string> {
    const id = crypto.randomUUID();
    await sql`
        INSERT INTO media_items (id, title, media_type, status, has_files)
        VALUES (${id}::uuid, ${'WatchedExclTest ' + tmdbId}, 'movie', 'active', true)
    `;
    await sql`
        INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
        VALUES (${id}::uuid, 'tmdb', ${String(tmdbId)}, 'movie', true)
    `;
    await sql`
        INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
        VALUES (${id}::uuid, 'tmdb', ${sql.json({
            release_date: releaseDate,
            mdblist_score: 80,
            runtime_minutes: 75,
            vote_average: 7.5,
            imdb_rating: 7.5,
        })}, NOW())
    `;
    return id;
}

describe('FreshReleasesStrategy / ShortMoviesStrategy — server-side watched exclusion (integration)', () => {
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

    it('excludes a server-side watched item from Fresh Releases with no client watched= param', async () => {
        const userId = generateTestUserId('itest-fresh-watched');
        await ensureTestUser(sql, userId);

        const tmdbId = 995000 + Math.floor(Math.random() * 100000);
        const recentDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
            .toISOString()
            .slice(0, 10);
        const mediaId = await seedEligibleMovie(sql, tmdbId, recentDate);

        const before = await freshReleasesStrategy.fetch(ctxFor(userId), {
            surface: 'internal',
            limit: 50,
        });
        expect(before.items.some((i) => i.media.id === mediaId)).toBe(true);

        await insertTestWatchStateEntry(sql, {
            user_id: userId,
            media_id: mediaId,
            watched_at: new Date(),
        });
        // The raw SQL insert above bypasses watchManager's own mutation path
        // (which calls invalidateWatchedCache on every write), so the `before`
        // call's cached empty watched-list for this user must be busted by
        // hand or `getWatchedMediaIdsCached` would keep serving it.
        await invalidateWatchedCache(userId);

        // No `opts.extra.watchedTmdbIds` is passed here — the exclusion must
        // come from `watchManager.getWatchedMediaIdsCached(ctx.userId)`.
        const after = await freshReleasesStrategy.fetch(ctxFor(userId), {
            surface: 'internal',
            limit: 50,
        });
        expect(after.items.some((i) => i.media.id === mediaId)).toBe(false);
    });

    it('excludes a server-side watched item from Short & Sweet with no client watched= param', async () => {
        const userId = generateTestUserId('itest-short-watched');
        await ensureTestUser(sql, userId);

        const tmdbId = 996000 + Math.floor(Math.random() * 100000);
        const mediaId = await seedEligibleMovie(sql, tmdbId, '2010-06-01');

        const before = await shortMoviesStrategy.fetch(ctxFor(userId), {
            surface: 'internal',
            limit: 50,
        });
        expect(before.items.some((i) => i.media.id === mediaId)).toBe(true);

        await insertTestWatchStateEntry(sql, {
            user_id: userId,
            media_id: mediaId,
            watched_at: new Date(),
        });
        await invalidateWatchedCache(userId);

        const after = await shortMoviesStrategy.fetch(ctxFor(userId), {
            surface: 'internal',
            limit: 50,
        });
        expect(after.items.some((i) => i.media.id === mediaId)).toBe(false);
    });
});
