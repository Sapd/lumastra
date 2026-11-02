// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for buildRateQueue — watched-first ordering, filter=seen
 * scoping, served-set cursor exclusion/exhaustion, and the "never fabricate a
 * community rating" contract.
 *
 * Tests the composition function directly (not the HTTP handler) per the
 * task-5 brief: the def's GET handler is a thin wrapper around this.
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { getTestDatabaseUrl } from '../../../../../../tests/integration/setup/test-database.js';
import {
    ensureTestUser,
    generateTestUserId,
} from '../../../../../../tests/integration/fixtures/user.fixtures.js';
import { buildRateQueue, type RateQueuePage } from './queue.js';
import {
    denyAllAccess,
    restrictedAccess,
    unrestrictedAccess,
} from '$lib/server/database/queries/builders/media-access-boundary.js';
import { recordSkips } from '$lib/server/database/queries/rate-skips.queries.js';
import type { UserContext } from '$lib/server/types.js';
import type { UserId } from '$lib/shared/user-id.js';
import { getPrimaryExternalIdProvider } from '$lib/server/utils/provider-config.js';
import { imageFromIds } from '$lib/utils/image-utils.js';
import { mediaCompositeKey } from '$lib/utils/media-id-helpers.js';

const URL = getTestDatabaseUrl();

function ctxFor(userId: UserId): UserContext {
    return {
        userId,
        username: 'itest-rate-queue',
        groups: '',
        userGroups: [],
        hasWatchPermission: true,
        hasLiveTvPermission: false,
        hasRequestPermission: false,
        ownerIsAdmin: false,
        maxAgeRating: null,
        isAgeRestricted: false,
        isModerator: false,
        liveTvPriority: 'low',
    };
}

describe('buildRateQueue (integration)', () => {
    let sql: postgres.Sql;
    let userId: UserId;
    let watchedId: string;
    let popularId: string;
    let ratedId: string;

    // Seeds `n` watched-but-unrated (embedded) movies + `m` unwatched well-rated
    // (embedded) explore movies for a throwaway user. Returns ids for cleanup.
    async function seedBlendUser(
        user: UserId,
        n: number,
        m: number,
    ): Promise<{ watchedIds: string[]; exploreIds: string[] }> {
        const watchedIds: string[] = [];
        const exploreIds: string[] = [];
        for (let i = 0; i < n; i++) {
            const [{ id }] = await sql<{ id: string }[]>`
                INSERT INTO media_items (title, media_type, status)
                VALUES (${'BlendWatched ' + i}, 'movie', 'active') RETURNING id
            `;
            watchedIds.push(id);
            await sql`
                INSERT INTO user_media_state (user_id, media_id, is_watched, last_watched_at, watch_count, last_event_source)
                VALUES (${user}, ${id}::uuid, true, now() - (${i} || ' minutes')::interval, 1, 'lumastra-user-mark')
            `;
            const emb = new Array(1024).fill(0.01 + i * 0.0005);
            await sql`
                INSERT INTO media_embeddings (media_id, embedding, source)
                VALUES (${id}::uuid, ${`[${emb.join(',')}]`}::vector, 'library')
            `;
        }
        for (let i = 0; i < m; i++) {
            const [{ id }] = await sql<{ id: string }[]>`
                INSERT INTO media_items (title, media_type, status)
                VALUES (${'BlendExplore ' + i}, 'movie', 'active') RETURNING id
            `;
            exploreIds.push(id);
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata)
                VALUES (${id}::uuid, 'tmdb', jsonb_build_object('imdb_rating', '8.0'))
            `;
            const emb = new Array(1024).fill(0.6 + i * 0.0005);
            await sql`
                INSERT INTO media_embeddings (media_id, embedding, source)
                VALUES (${id}::uuid, ${`[${emb.join(',')}]`}::vector, 'library')
            `;
        }
        return { watchedIds, exploreIds };
    }

    async function cleanupBlendUser(
        user: UserId,
        ids: { watchedIds: string[]; exploreIds: string[] },
    ): Promise<void> {
        const all = [...ids.watchedIds, ...ids.exploreIds];
        await sql`DELETE FROM user_media_state WHERE user_id = ${user}`;
        await sql`DELETE FROM media_embeddings WHERE media_id = ANY(${all}::uuid[])`;
        await sql`DELETE FROM provider_metadata WHERE media_id = ANY(${ids.exploreIds}::uuid[])`;
        await sql`DELETE FROM media_items WHERE id = ANY(${all}::uuid[])`;
        await sql`DELETE FROM user_profiles WHERE user_id = ${user}`;
        await sql`DELETE FROM users WHERE id = ${user}`;
    }

    beforeAll(async () => {
        sql = postgres(URL, { max: 2 });
        userId = generateTestUserId('itest-rate-queue');
        await ensureTestUser(sql, userId);

        // Ensure the popular sampler's provider LATERAL has an enabled 'tmdb'
        // row to join against (provider_capabilities has no seeded defaults).
        await sql`
            INSERT INTO provider_capabilities (provider, priority, enabled, capabilities)
            VALUES ('tmdb', 1, true, '{}'::jsonb)
            ON CONFLICT (provider) DO UPDATE SET enabled = true, priority = 1
        `;

        // Media A: watched, unrated — must appear, source 'watched'.
        [{ id: watchedId }] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, status)
            VALUES ('QueueTest Watched', 'movie', 'active') RETURNING id
        `;
        await sql`
            INSERT INTO user_media_state (user_id, media_id, is_watched, last_watched_at, watch_count, last_event_source)
            VALUES (${userId}, ${watchedId}::uuid, true, now(), 3, 'lumastra-user-mark')
        `;
        const watchedEmb = new Array(1024).fill(0.01);
        await sql`
            INSERT INTO media_embeddings (media_id, embedding, source)
            VALUES (${watchedId}::uuid, ${`[${watchedEmb.join(',')}]`}::vector, 'library')
        `;

        // Media B: unwatched, well-rated in the catalog — must appear as 'popular'.
        [{ id: popularId }] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, status)
            VALUES ('QueueTest Popular', 'movie', 'active') RETURNING id
        `;
        await sql`
            INSERT INTO provider_metadata (media_id, provider, metadata)
            VALUES (${popularId}::uuid, 'tmdb', jsonb_build_object('imdb_rating', '8.2', 'overview', 'A popular test movie'))
        `;
        const popularEmb = new Array(1024).fill(0.02);
        await sql`
            INSERT INTO media_embeddings (media_id, embedding, source)
            VALUES (${popularId}::uuid, ${`[${popularEmb.join(',')}]`}::vector, 'library')
        `;

        // Media C: watched AND already rated — must NOT appear anywhere.
        [{ id: ratedId }] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, status)
            VALUES ('QueueTest Rated', 'movie', 'active') RETURNING id
        `;
        await sql`
            INSERT INTO user_media_state (user_id, media_id, is_watched, last_watched_at, watch_count, last_event_source)
            VALUES (${userId}, ${ratedId}::uuid, true, now(), 1, 'lumastra-user-mark')
        `;
        await sql`
            INSERT INTO user_ratings (user_id, media_id, rating)
            VALUES (${userId}, ${ratedId}::uuid, 8)
        `;
    });

    afterAll(async () => {
        await sql`DELETE FROM user_ratings WHERE user_id = ${userId}`;
        await sql`DELETE FROM user_media_state WHERE user_id = ${userId}`;
        await sql`DELETE FROM media_embeddings WHERE media_id = ANY(${[watchedId, popularId, ratedId]}::uuid[])`;
        await sql`DELETE FROM provider_metadata WHERE media_id = ${popularId}::uuid`;
        await sql`DELETE FROM media_items WHERE id = ANY(${[watchedId, popularId, ratedId]}::uuid[])`;
        await sql`DELETE FROM user_profiles WHERE user_id = ${userId}`;
        await sql`DELETE FROM users WHERE id = ${userId}`;
        await sql.end();
    });

    it('interleaves watched and explore sources, opening on a seen title', async () => {
        const mixUser = generateTestUserId('itest-rate-queue-mix');
        await ensureTestUser(sql, mixUser);
        const watchedIds: string[] = [];
        const exploreIds: string[] = [];
        try {
            for (let i = 0; i < 5; i++) {
                const [{ id: w }] = await sql<{ id: string }[]>`
                    INSERT INTO media_items (title, media_type, status)
                    VALUES (${'MixWatched ' + i}, 'movie', 'active') RETURNING id
                `;
                watchedIds.push(w);
                await sql`
                    INSERT INTO user_media_state (user_id, media_id, is_watched, last_watched_at, watch_count, last_event_source)
                    VALUES (${mixUser}, ${w}::uuid, true, now() - (${i} || ' minutes')::interval, 1, 'lumastra-user-mark')
                `;
                const wemb = new Array(1024).fill(0.01 + i * 0.001);
                await sql`
                    INSERT INTO media_embeddings (media_id, embedding, source)
                    VALUES (${w}::uuid, ${`[${wemb.join(',')}]`}::vector, 'library')
                `;

                const [{ id: e }] = await sql<{ id: string }[]>`
                    INSERT INTO media_items (title, media_type, status)
                    VALUES (${'MixExplore ' + i}, 'movie', 'active') RETURNING id
                `;
                exploreIds.push(e);
                await sql`
                    INSERT INTO provider_metadata (media_id, provider, metadata)
                    VALUES (${e}::uuid, 'tmdb', jsonb_build_object('imdb_rating', '8.1'))
                `;
                const eemb = new Array(1024).fill(0.5 + i * 0.001);
                await sql`
                    INSERT INTO media_embeddings (media_id, embedding, source)
                    VALUES (${e}::uuid, ${`[${eemb.join(',')}]`}::vector, 'library')
                `;
            }

            const page = await buildRateQueue(sql, ctxFor(mixUser), unrestrictedAccess(), {
                filter: 'all',
                count: 10,
            });

            // backlog 5 -> share 0.5 -> 5 explore + 5 seen, alternating, seen first.
            expect(page.items).toHaveLength(10);
            expect(page.items[0].source).toBe('watched');
            expect(page.items[1].source).toBe('popular');
            // explore is not clustered at the tail:
            const popularPositions = page.items
                .map((it, i) => (it.source === 'popular' ? i : -1))
                .filter((i) => i >= 0);
            expect(popularPositions[0]).toBeLessThan(3);
        } finally {
            const all = [...watchedIds, ...exploreIds];
            await sql`DELETE FROM user_media_state WHERE user_id = ${mixUser}`;
            await sql`DELETE FROM media_embeddings WHERE media_id = ANY(${all}::uuid[])`;
            await sql`DELETE FROM provider_metadata WHERE media_id = ANY(${exploreIds}::uuid[])`;
            await sql`DELETE FROM media_items WHERE id = ANY(${all}::uuid[])`;
            await sql`DELETE FROM user_profiles WHERE user_id = ${mixUser}`;
            await sql`DELETE FROM users WHERE id = ${mixUser}`;
        }
    });

    it('guarantees the explore floor with a deep backlog (regression: everything != seen-only)', async () => {
        const user = generateTestUserId('itest-rate-deep');
        await ensureTestUser(sql, user);
        const ids = await seedBlendUser(user, 25, 5); // backlog 25 -> share 0.30
        try {
            const page = await buildRateQueue(sql, ctxFor(user), unrestrictedAccess(), {
                filter: 'all',
                count: 10,
            });
            expect(page.items).toHaveLength(10);
            const explore = page.items.filter((i) => i.source === 'popular').length;
            const seen = page.items.filter((i) => i.source === 'watched').length;
            expect(explore).toBe(3); // round(10 * 0.30)
            expect(seen).toBe(7);
        } finally {
            await cleanupBlendUser(user, ids);
        }
    });

    it('lets explore dominate when the backlog is shallow', async () => {
        const user = generateTestUserId('itest-rate-shallow');
        await ensureTestUser(sql, user);
        const ids = await seedBlendUser(user, 3, 8); // backlog 3 -> share 0.65
        try {
            const page = await buildRateQueue(sql, ctxFor(user), unrestrictedAccess(), {
                filter: 'all',
                count: 10,
            });
            expect(page.items).toHaveLength(10);
            const explore = page.items.filter((i) => i.source === 'popular').length;
            const seen = page.items.filter((i) => i.source === 'watched').length;
            expect(explore).toBe(7); // round(10 * 0.65)
            expect(seen).toBe(3);
            expect(explore).toBeGreaterThan(seen);
        } finally {
            await cleanupBlendUser(user, ids);
        }
    });

    it('falls back to all-seen when the explore pool is empty (no dead page)', async () => {
        const user = generateTestUserId('itest-rate-noexplore');
        await ensureTestUser(sql, user);
        const ids = await seedBlendUser(user, 6, 0); // 6 watched, zero explore seeded
        // Exclude the shared global explore item (popularId) from THIS user's
        // explore pool by marking it watched, so the pool is genuinely empty.
        await sql`
            INSERT INTO user_media_state (user_id, media_id, is_watched, last_watched_at, watch_count, last_event_source)
            VALUES (${user}, ${popularId}::uuid, true, now(), 1, 'lumastra-user-mark')
        `;
        try {
            const page = await buildRateQueue(sql, ctxFor(user), unrestrictedAccess(), {
                filter: 'all',
                count: 10,
            });
            expect(page.items.every((i) => i.source === 'watched')).toBe(true);
            expect(page.items.length).toBeGreaterThan(0);
            // Both pools short (explore dry, watched < count) → page returns fewer
            // than `count` rather than a dead/empty page. (spec case 4)
            expect(page.items.length).toBeLessThan(10);
        } finally {
            await cleanupBlendUser(user, ids); // its DELETE FROM user_media_state also clears the popularId row
        }
    });

    it('never marks the unserved overfetched watched tail as served', async () => {
        const user = generateTestUserId('itest-rate-tail');
        await ensureTestUser(sql, user);
        const ids = await seedBlendUser(user, 25, 5); // deep backlog: page 1 serves only 7 seen
        try {
            const p1 = await buildRateQueue(sql, ctxFor(user), unrestrictedAccess(), {
                filter: 'all',
                count: 10,
            });
            const p1Titles = new Set(p1.items.map((i) => i.title));
            const p2 = await buildRateQueue(sql, ctxFor(user), unrestrictedAccess(), {
                filter: 'all',
                count: 10,
                cursor: p1.nextCursor,
            });
            // The 18 unserved watched rows from page 1 were NOT recorded as served,
            // so page 2 still surfaces fresh watched titles disjoint from page 1.
            const p2Seen = p2.items.filter((i) => i.source === 'watched');
            expect(p2Seen.length).toBeGreaterThan(0);
            expect(p2Seen.every((i) => !p1Titles.has(i.title))).toBe(true);
        } finally {
            await cleanupBlendUser(user, ids);
        }
    });

    it('keeps the seen and explore pools disjoint (watched high-rated item is never "popular")', async () => {
        const user = generateTestUserId('itest-rate-disjoint');
        await ensureTestUser(sql, user);
        // One watched-but-unrated movie that ALSO qualifies for the explore
        // sampler (embedded + imdb >= 7). Must surface once, as 'watched'.
        const [{ id }] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, status)
            VALUES ('DisjointWatchedRated', 'movie', 'active') RETURNING id
        `;
        try {
            await sql`
                INSERT INTO user_media_state (user_id, media_id, is_watched, last_watched_at, watch_count, last_event_source)
                VALUES (${user}, ${id}::uuid, true, now(), 1, 'lumastra-user-mark')
            `;
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata)
                VALUES (${id}::uuid, 'tmdb', jsonb_build_object('imdb_rating', '9.0'))
            `;
            const emb = new Array(1024).fill(0.7);
            await sql`
                INSERT INTO media_embeddings (media_id, embedding, source)
                VALUES (${id}::uuid, ${`[${emb.join(',')}]`}::vector, 'library')
            `;

            const page = await buildRateQueue(sql, ctxFor(user), unrestrictedAccess(), {
                filter: 'all',
                count: 10,
            });
            const matches = page.items.filter((i) => i.title === 'DisjointWatchedRated');
            expect(matches).toHaveLength(1);
            expect(matches[0].source).toBe('watched');
        } finally {
            await sql`DELETE FROM user_media_state WHERE user_id = ${user}`;
            await sql`DELETE FROM media_embeddings WHERE media_id = ${id}::uuid`;
            await sql`DELETE FROM provider_metadata WHERE media_id = ${id}::uuid`;
            await sql`DELETE FROM media_items WHERE id = ${id}::uuid`;
            await sql`DELETE FROM user_profiles WHERE user_id = ${user}`;
            await sql`DELETE FROM users WHERE id = ${user}`;
        }
    });

    it('allocates sanely for count=1 at both backlog extremes', async () => {
        const shallowUser = generateTestUserId('itest-rate-c1-shallow');
        await ensureTestUser(sql, shallowUser);
        const shallowIds = await seedBlendUser(shallowUser, 2, 5); // backlog 2 -> share 0.65 -> round(0.65)=1 explore
        try {
            const page = await buildRateQueue(sql, ctxFor(shallowUser), unrestrictedAccess(), {
                filter: 'all',
                count: 1,
            });
            expect(page.items).toHaveLength(1);
            expect(page.items[0].source).toBe('popular');
        } finally {
            await cleanupBlendUser(shallowUser, shallowIds);
        }

        const deepUser = generateTestUserId('itest-rate-c1-deep');
        await ensureTestUser(sql, deepUser);
        const deepIds = await seedBlendUser(deepUser, 20, 5); // backlog 20 -> share 0.30 -> round(0.30)=0 explore
        try {
            const page = await buildRateQueue(sql, ctxFor(deepUser), unrestrictedAccess(), {
                filter: 'all',
                count: 1,
            });
            expect(page.items).toHaveLength(1);
            expect(page.items[0].source).toBe('watched');
        } finally {
            await cleanupBlendUser(deepUser, deepIds);
        }
    });

    it('filter=seen returns only watched-source items', async () => {
        const page = await buildRateQueue(sql, ctxFor(userId), unrestrictedAccess(), {
            filter: 'seen',
            count: 10,
        });
        expect(page.items.every((i) => i.source === 'watched')).toBe(true);
    });

    it('cursor excludes already-served items and exhausts honestly', async () => {
        const p1 = await buildRateQueue(sql, ctxFor(userId), unrestrictedAccess(), {
            filter: 'seen',
            count: 1,
        });
        expect(p1.items).toHaveLength(1);
        const p2 = await buildRateQueue(sql, ctxFor(userId), unrestrictedAccess(), {
            filter: 'seen',
            count: 10,
            cursor: p1.nextCursor,
        });
        expect(p2.items.map((i) => i.title)).not.toContain(p1.items[0].title);
    });

    it('never fabricates a community rating', async () => {
        const page = await buildRateQueue(sql, ctxFor(userId), unrestrictedAccess(), {
            filter: 'all',
            count: 10,
        });
        for (const item of page.items) {
            expect(item.communityRating).not.toBe(7.5); // seeded items either have a real rating or none
        }
    });

    it('treats a garbage cursor as a fresh session instead of throwing', async () => {
        const page = await buildRateQueue(sql, ctxFor(userId), unrestrictedAccess(), {
            filter: 'seen',
            count: 10,
            cursor: 'not-a-uuid',
        });
        expect(page.nextCursor).toBeTruthy();
        expect(page.nextCursor).not.toBe('not-a-uuid');
    });

    it('defensively clamps a caller-supplied out-of-range count instead of erroring (FIX 8)', async () => {
        // A raw negative value would surface as an invalid Postgres LIMIT —
        // without the internal clamp this throws instead of returning a page.
        // buildRateQueue is exported for direct callers that bypass the HTTP
        // handler's query-schema clamp (1..50).
        await expect(
            buildRateQueue(sql, ctxFor(userId), unrestrictedAccess(), {
                filter: 'seen',
                count: -5,
            }),
        ).resolves.toMatchObject({ status: expect.any(String) });
    });

    it('reallocates a starved category shortfall to the other category (FIX 5)', async () => {
        // Own user + own well-rated, embedded movie pool with ZERO series
        // ever available — the series draw always comes up empty, so the
        // fixed 70/30 split alone would return fewer than `count` items
        // unless the shortfall is reallocated to movies.
        const reallocUser = generateTestUserId('itest-rate-queue-realloc');
        await ensureTestUser(sql, reallocUser);
        const movieIds: string[] = [];
        try {
            for (let i = 0; i < 10; i++) {
                const [{ id }] = await sql<{ id: string }[]>`
                    INSERT INTO media_items (title, media_type, status)
                    VALUES (${'RealtocMovie ' + i}, 'movie', 'active') RETURNING id
                `;
                movieIds.push(id);
                await sql`
                    INSERT INTO provider_metadata (media_id, provider, metadata)
                    VALUES (${id}::uuid, 'tmdb', jsonb_build_object('imdb_rating', '8.0'))
                `;
                const emb = new Array(1024).fill(0.03 + i * 0.001);
                await sql`
                    INSERT INTO media_embeddings (media_id, embedding, source)
                    VALUES (${id}::uuid, ${`[${emb.join(',')}]`}::vector, 'library')
                `;
            }

            // remaining=10 (no watched rows for this user): movieCount=ceil(10*0.7)=7,
            // seriesCount=floor(10*0.3)=3. With 0 series ever available, the
            // 3-item series deficit must be topped up from the movie pool
            // (which has 3 unused candidates left) so the page still reaches
            // `count` instead of settling for 7.
            const page = await buildRateQueue(sql, ctxFor(reallocUser), unrestrictedAccess(), {
                filter: 'all',
                count: 10,
            });

            expect(page.items).toHaveLength(10);
            expect(page.items.every((i) => i.mediaType === 'movie')).toBe(true);
        } finally {
            await sql`DELETE FROM media_embeddings WHERE media_id = ANY(${movieIds}::uuid[])`;
            await sql`DELETE FROM provider_metadata WHERE media_id = ANY(${movieIds}::uuid[])`;
            await sql`DELETE FROM media_items WHERE id = ANY(${movieIds}::uuid[])`;
            await sql`DELETE FROM user_profiles WHERE user_id = ${reallocUser}`;
            await sql`DELETE FROM users WHERE id = ${reallocUser}`;
        }
    });

    describe('durable skip suppression (user_rate_skips)', () => {
        it('excludes a recently-skipped watched-unrated item from both filter:seen and filter:all', async () => {
            const user = generateTestUserId('itest-rate-skip-recent');
            await ensureTestUser(sql, user);
            const [{ id }] = await sql<{ id: string }[]>`
                INSERT INTO media_items (title, media_type, status)
                VALUES ('SkipTest Recent', 'movie', 'active') RETURNING id
            `;
            try {
                await sql`
                    INSERT INTO user_media_state (user_id, media_id, is_watched, last_watched_at, watch_count, last_event_source)
                    VALUES (${user}, ${id}::uuid, true, now(), 1, 'lumastra-user-mark')
                `;

                // Present before any skip.
                const before = await buildRateQueue(sql, ctxFor(user), unrestrictedAccess(), {
                    filter: 'seen',
                    count: 10,
                });
                expect(before.items.map((i) => i.title)).toContain('SkipTest Recent');

                await recordSkips(sql, user, [id]);

                const afterSeen = await buildRateQueue(sql, ctxFor(user), unrestrictedAccess(), {
                    filter: 'seen',
                    count: 10,
                });
                expect(afterSeen.items.map((i) => i.title)).not.toContain('SkipTest Recent');

                const afterAll = await buildRateQueue(sql, ctxFor(user), unrestrictedAccess(), {
                    filter: 'all',
                    count: 10,
                });
                expect(afterAll.items.map((i) => i.title)).not.toContain('SkipTest Recent');
            } finally {
                await sql`DELETE FROM user_rate_skips WHERE user_id = ${user}`;
                await sql`DELETE FROM user_media_state WHERE user_id = ${user}`;
                await sql`DELETE FROM media_items WHERE id = ${id}::uuid`;
                await sql`DELETE FROM user_profiles WHERE user_id = ${user}`;
                await sql`DELETE FROM users WHERE id = ${user}`;
            }
        });

        it('does not exclude a skip older than the 30-day suppression window', async () => {
            const user = generateTestUserId('itest-rate-skip-stale');
            await ensureTestUser(sql, user);
            const [{ id }] = await sql<{ id: string }[]>`
                INSERT INTO media_items (title, media_type, status)
                VALUES ('SkipTest Stale', 'movie', 'active') RETURNING id
            `;
            try {
                await sql`
                    INSERT INTO user_media_state (user_id, media_id, is_watched, last_watched_at, watch_count, last_event_source)
                    VALUES (${user}, ${id}::uuid, true, now(), 1, 'lumastra-user-mark')
                `;
                // 31-day-old skip — outside the 30-day suppression window.
                await sql`
                    INSERT INTO user_rate_skips (user_id, media_id, skipped_at)
                    VALUES (${user}, ${id}::uuid, now() - interval '31 days')
                `;

                const page = await buildRateQueue(sql, ctxFor(user), unrestrictedAccess(), {
                    filter: 'seen',
                    count: 10,
                });
                expect(page.items.map((i) => i.title)).toContain('SkipTest Stale');
            } finally {
                await sql`DELETE FROM user_rate_skips WHERE user_id = ${user}`;
                await sql`DELETE FROM user_media_state WHERE user_id = ${user}`;
                await sql`DELETE FROM media_items WHERE id = ${id}::uuid`;
                await sql`DELETE FROM user_profiles WHERE user_id = ${user}`;
                await sql`DELETE FROM users WHERE id = ${user}`;
            }
        });

        it('recordSkips writes a row that the queue then excludes', async () => {
            const user = generateTestUserId('itest-rate-skip-write');
            await ensureTestUser(sql, user);
            const [{ id }] = await sql<{ id: string }[]>`
                INSERT INTO media_items (title, media_type, status)
                VALUES ('SkipTest Write', 'movie', 'active') RETURNING id
            `;
            try {
                await sql`
                    INSERT INTO user_media_state (user_id, media_id, is_watched, last_watched_at, watch_count, last_event_source)
                    VALUES (${user}, ${id}::uuid, true, now(), 1, 'lumastra-user-mark')
                `;

                await recordSkips(sql, user, [id]);

                const [row] = await sql<{ media_id: string }[]>`
                    SELECT media_id FROM user_rate_skips WHERE user_id = ${user} AND media_id = ${id}::uuid
                `;
                expect(row).toBeDefined();

                const page = await buildRateQueue(sql, ctxFor(user), unrestrictedAccess(), {
                    filter: 'seen',
                    count: 10,
                });
                expect(page.items.map((i) => i.title)).not.toContain('SkipTest Write');

                // Re-skipping refreshes skipped_at (upsert) instead of erroring.
                await recordSkips(sql, user, [id]);
                const [refreshed] = await sql<{ media_id: string }[]>`
                    SELECT media_id FROM user_rate_skips WHERE user_id = ${user} AND media_id = ${id}::uuid
                `;
                expect(refreshed).toBeDefined();
            } finally {
                await sql`DELETE FROM user_rate_skips WHERE user_id = ${user}`;
                await sql`DELETE FROM user_media_state WHERE user_id = ${user}`;
                await sql`DELETE FROM media_items WHERE id = ${id}::uuid`;
                await sql`DELETE FROM user_profiles WHERE user_id = ${user}`;
                await sql`DELETE FROM users WHERE id = ${user}`;
            }
        });

        it('recordSkips is a no-op for an empty mediaIds array', async () => {
            await expect(recordSkips(sql, userId, [])).resolves.toBeUndefined();
        });

        it('handles a batch with duplicate ids without erroring (21000 regression)', async () => {
            // Without deduping, unnest + ON CONFLICT DO UPDATE raises Postgres 21000
            // ("ON CONFLICT DO UPDATE command cannot affect row a second time") when
            // the same id appears twice in one batch.
            const user = generateTestUserId('itest-rate-skip-dup');
            await ensureTestUser(sql, user);
            const [{ id }] = await sql<{ id: string }[]>`
                INSERT INTO media_items (title, media_type, status)
                VALUES ('SkipTest Duplicate', 'movie', 'active') RETURNING id
            `;
            try {
                await expect(recordSkips(sql, user, [id, id, id])).resolves.toBeUndefined();

                // Exactly one row, not one per duplicate.
                const rows = await sql<{ media_id: string }[]>`
                    SELECT media_id FROM user_rate_skips WHERE user_id = ${user} AND media_id = ${id}::uuid
                `;
                expect(rows).toHaveLength(1);
            } finally {
                await sql`DELETE FROM user_rate_skips WHERE user_id = ${user}`;
                await sql`DELETE FROM media_items WHERE id = ${id}::uuid`;
                await sql`DELETE FROM user_profiles WHERE user_id = ${user}`;
                await sql`DELETE FROM users WHERE id = ${user}`;
            }
        });
    });

    /**
     * Differential access-boundary coverage. Running the SAME fixture under an
     * unrestricted and a restricted boundary and asserting a STRICT subset is
     * what catches a boundary argument that arrived but was never spliced, or
     * one spliced against the wrong table alias — neither of which a
     * single-boundary test can see.
     */
    describe('access boundary', () => {
        /** Restricted profile: nothing above age 12, unrated still visible. */
        const restricted = restrictedAccess({
            deniedGroupIds: [],
            maxAgeRating: 12,
            allowUnrated: true,
        });

        it('restricted boundary is a strict subset of unrestricted (watched source)', async () => {
            const user = generateTestUserId('itest-rate-bound-seen');
            await ensureTestUser(sql, user);
            const ids: string[] = [];
            try {
                for (let i = 0; i < 6; i++) {
                    // Half the fixture is age-18 (invisible to `restricted`),
                    // half is unrated (visible under allowUnrated).
                    const age = i < 3 ? 18 : null;
                    const [{ id }] = await sql<{ id: string }[]>`
                        INSERT INTO media_items (title, media_type, status, age_rating)
                        VALUES (${`BoundSeen ${i < 3 ? 'R18' : 'OK'} ${i}`}, 'movie', 'active', ${age})
                        RETURNING id
                    `;
                    ids.push(id);
                    await sql`
                        INSERT INTO user_media_state (user_id, media_id, is_watched, last_watched_at, watch_count, last_event_source)
                        VALUES (${user}, ${id}::uuid, true, now() - (${i} || ' minutes')::interval, 1, 'lumastra-user-mark')
                    `;
                }

                const open = await buildRateQueue(sql, ctxFor(user), unrestrictedAccess(), {
                    filter: 'seen',
                    count: 20,
                });
                const closed = await buildRateQueue(sql, ctxFor(user), restricted, {
                    filter: 'seen',
                    count: 20,
                });

                const openTitles = new Set(open.items.map((i) => i.title));
                const closedTitles = closed.items.map((i) => i.title);

                expect(openTitles.size).toBe(6);
                // Strict subset: every restricted row is also an unrestricted
                // row, and at least one unrestricted row is withheld.
                expect(closedTitles.every((t) => openTitles.has(t))).toBe(true);
                expect(closedTitles.length).toBeLessThan(openTitles.size);
                expect(closedTitles).toHaveLength(3);
                expect(closedTitles.some((t) => t.includes('R18'))).toBe(false);
            } finally {
                await sql`DELETE FROM user_media_state WHERE user_id = ${user}`;
                await sql`DELETE FROM media_items WHERE id = ANY(${ids}::uuid[])`;
                await sql`DELETE FROM user_profiles WHERE user_id = ${user}`;
                await sql`DELETE FROM users WHERE id = ${user}`;
            }
        });

        it('boundary reaches the popular sampler, not just the watched query', async () => {
            const user = generateTestUserId('itest-rate-bound-explore');
            await ensureTestUser(sql, user);
            const ids: string[] = [];
            try {
                for (let i = 0; i < 10; i++) {
                    const [{ id }] = await sql<{ id: string }[]>`
                        INSERT INTO media_items (title, media_type, status, age_rating)
                        VALUES (${'BoundExplore R18 ' + i}, 'movie', 'active', 18) RETURNING id
                    `;
                    ids.push(id);
                    await sql`
                        INSERT INTO provider_metadata (media_id, provider, metadata)
                        VALUES (${id}::uuid, 'tmdb', jsonb_build_object('imdb_rating', '9.5'))
                    `;
                    const emb = new Array(1024).fill(0.4 + i * 0.001);
                    await sql`
                        INSERT INTO media_embeddings (media_id, embedding, source)
                        VALUES (${id}::uuid, ${`[${emb.join(',')}]`}::vector, 'library')
                    `;
                }

                // Make the explore pool EXACTLY the ten rows above: the sampler
                // excludes anything this user has watched, so marking every
                // other catalog row watched removes the shared test-database
                // catalog from the draw and makes the assertion deterministic.
                await sql`
                    INSERT INTO user_media_state (user_id, media_id, is_watched, last_watched_at, watch_count, last_event_source)
                    SELECT ${user}, mi.id, true, now(), 1, 'lumastra-user-mark'
                    FROM media_items mi
                    WHERE mi.status = 'active'
                      AND mi.media_type IN ('movie', 'tv')
                      AND NOT (mi.id = ANY(${ids}::uuid[]))
                    ON CONFLICT DO NOTHING
                `;

                const open = await buildRateQueue(sql, ctxFor(user), unrestrictedAccess(), {
                    filter: 'all',
                    count: 50,
                });
                const closed = await buildRateQueue(sql, ctxFor(user), restricted, {
                    filter: 'all',
                    count: 50,
                });

                // Count only fixture rows: the shared test database can gain
                // rows from a concurrently-running suite after the bulk insert
                // above, and those are not this assertion's business.
                const fixtureExplore = (page: Pick<RateQueuePage, 'items'>) =>
                    page.items.filter(
                        (i) =>
                            i.source === 'popular' &&
                            (i.title?.startsWith('BoundExplore') ?? false),
                    );

                // Positive control: the sampler CAN reach the fixture.
                expect(fixtureExplore(open).length).toBeGreaterThan(0);
                // The age axis is spliced into the sampler's CTE too — the whole
                // fixture pool is age-18, so a restricted caller draws none of it.
                expect(fixtureExplore(closed)).toHaveLength(0);
                // ...and nothing from the fixture leaks via the watched source either.
                expect(closed.items.some((i) => i.title.startsWith('BoundExplore'))).toBe(false);
            } finally {
                await sql`DELETE FROM user_media_state WHERE user_id = ${user}`;
                await sql`DELETE FROM media_embeddings WHERE media_id = ANY(${ids}::uuid[])`;
                await sql`DELETE FROM provider_metadata WHERE media_id = ANY(${ids}::uuid[])`;
                await sql`DELETE FROM media_items WHERE id = ANY(${ids}::uuid[])`;
                await sql`DELETE FROM user_profiles WHERE user_id = ${user}`;
                await sql`DELETE FROM users WHERE id = ${user}`;
            }
        });

        it('denyAll boundary returns an empty page for both filters', async () => {
            const user = generateTestUserId('itest-rate-bound-deny');
            await ensureTestUser(sql, user);
            const seeded = await seedBlendUser(user, 5, 5);
            try {
                for (const filter of ['seen', 'all'] as const) {
                    const page = await buildRateQueue(sql, ctxFor(user), denyAllAccess(), {
                        filter,
                        count: 20,
                    });
                    expect(page.items).toHaveLength(0);
                    expect(page.status).toBe('exhausted');
                    expect(page.nextCursor).toBeTruthy();
                }

                // Sanity: the same fixture is non-empty under an unrestricted
                // boundary, so the empty pages above are the boundary's doing
                // and not an accidentally empty fixture.
                const open = await buildRateQueue(sql, ctxFor(user), unrestrictedAccess(), {
                    filter: 'all',
                    count: 20,
                });
                expect(open.items.length).toBeGreaterThan(0);
            } finally {
                await cleanupBlendUser(user, seeded);
            }
        });

        it('library axis reaches both the watched query and the popular sampler', async () => {
            const user = generateTestUserId('itest-rate-bound-library');
            await ensureTestUser(sql, user);
            const groupId = randomUUID();
            const watchedIds: string[] = [];
            const exploreIds: string[] = [];

            /** Attach a media_files row in `groupId` so the library predicate can exclude it. */
            async function attachToDeniedGroup(mediaId: string): Promise<void> {
                const fileId = randomUUID();
                await sql`
                    INSERT INTO media_files (id, file_path, library_group_id, created_at, updated_at)
                    VALUES (${fileId}::uuid, ${`/test/rate-bound/${mediaId}.mkv`}, ${groupId}::uuid, NOW(), NOW())
                `;
                await sql`
                    INSERT INTO media_file_items (file_id, media_item_id)
                    VALUES (${fileId}::uuid, ${mediaId}::uuid)
                `;
                await sql`UPDATE media_items SET has_files = true WHERE id = ${mediaId}::uuid`;
            }

            try {
                await sql`
                    INSERT INTO library_groups (id, name) VALUES (${groupId}::uuid, 'Denied Rate Group')
                `;

                // Watched source: two rows in the denied group, two with no files
                // at all (which the library predicate always admits).
                for (let i = 0; i < 4; i++) {
                    const denied = i < 2;
                    const [{ id }] = await sql<{ id: string }[]>`
                        INSERT INTO media_items (title, media_type, status)
                        VALUES (${`BoundLibSeen ${denied ? 'DENIED' : 'OPEN'} ${i}`}, 'movie', 'active')
                        RETURNING id
                    `;
                    watchedIds.push(id);
                    if (denied) await attachToDeniedGroup(id);
                    await sql`
                        INSERT INTO user_media_state (user_id, media_id, is_watched, last_watched_at, watch_count, last_event_source)
                        VALUES (${user}, ${id}::uuid, true, now(), 1, 'lumastra-user-mark')
                    `;
                }

                // Explore source: an entire pool inside the denied group.
                for (let i = 0; i < 6; i++) {
                    const [{ id }] = await sql<{ id: string }[]>`
                        INSERT INTO media_items (title, media_type, status)
                        VALUES (${'BoundLibExplore ' + i}, 'movie', 'active') RETURNING id
                    `;
                    exploreIds.push(id);
                    await attachToDeniedGroup(id);
                    await sql`
                        INSERT INTO provider_metadata (media_id, provider, metadata)
                        VALUES (${id}::uuid, 'tmdb', jsonb_build_object('imdb_rating', '9.5'))
                    `;
                    const emb = new Array(1024).fill(0.8 + i * 0.001);
                    await sql`
                        INSERT INTO media_embeddings (media_id, embedding, source)
                        VALUES (${id}::uuid, ${`[${emb.join(',')}]`}::vector, 'library')
                    `;
                }

                // Bound the explore pool to the six rows above (see the age-axis
                // test). Older last_watched_at so the four fixture rows above stay
                // at the head of the watched ordering.
                await sql`
                    INSERT INTO user_media_state (user_id, media_id, is_watched, last_watched_at, watch_count, last_event_source)
                    SELECT ${user}, mi.id, true, now() - interval '10 days', 1, 'lumastra-user-mark'
                    FROM media_items mi
                    WHERE mi.status = 'active'
                      AND mi.media_type IN ('movie', 'tv')
                      AND NOT (mi.id = ANY(${exploreIds}::uuid[]))
                    ON CONFLICT DO NOTHING
                `;

                const denyGroup = restrictedAccess({
                    deniedGroupIds: [groupId],
                    maxAgeRating: null,
                    allowUnrated: true,
                });

                // --- watched query ---
                const openSeen = await buildRateQueue(sql, ctxFor(user), unrestrictedAccess(), {
                    filter: 'seen',
                    count: 4,
                });
                const closedSeen = await buildRateQueue(sql, ctxFor(user), denyGroup, {
                    filter: 'seen',
                    count: 4,
                });
                // Restrict the comparison to this fixture's rows: the bulk
                // "everything else is watched" insert above puts unrelated
                // catalog rows into the watched source, and the restricted page
                // backfills with them once the DENIED rows drop out — those are
                // not leaks, just the page filling up.
                const isFixture = (t: string): boolean => t.startsWith('BoundLibSeen');
                const openSeenTitles = new Set(
                    openSeen.items.map((i) => i.title).filter(isFixture),
                );
                const closedSeenTitles = closedSeen.items.map((i) => i.title).filter(isFixture);
                expect(openSeenTitles.size).toBe(4);
                expect(closedSeenTitles.every((t) => openSeenTitles.has(t))).toBe(true);
                expect(closedSeenTitles.length).toBeLessThan(openSeenTitles.size);
                expect(closedSeenTitles.some((t) => t.includes('DENIED'))).toBe(false);

                // --- popular sampler ---
                const openAll = await buildRateQueue(sql, ctxFor(user), unrestrictedAccess(), {
                    filter: 'all',
                    count: 50,
                });
                const closedAll = await buildRateQueue(sql, ctxFor(user), denyGroup, {
                    filter: 'all',
                    count: 50,
                });
                // Fixture-scoped for the same reason as the age-axis test above.
                const fixtureExplore = (page: { items: { source?: string; title: string }[] }) =>
                    page.items.filter(
                        (i) => i.source === 'popular' && i.title.startsWith('BoundLibExplore'),
                    );
                expect(fixtureExplore(openAll).length).toBeGreaterThan(0);
                expect(fixtureExplore(closedAll)).toHaveLength(0);
            } finally {
                const all = [...watchedIds, ...exploreIds];
                await sql`DELETE FROM user_media_state WHERE user_id = ${user}`;
                await sql`DELETE FROM media_embeddings WHERE media_id = ANY(${all}::uuid[])`;
                await sql`DELETE FROM provider_metadata WHERE media_id = ANY(${all}::uuid[])`;
                await sql`DELETE FROM media_file_items WHERE media_item_id = ANY(${all}::uuid[])`;
                await sql`DELETE FROM media_files WHERE library_group_id = ${groupId}::uuid`;
                await sql`DELETE FROM media_items WHERE id = ANY(${all}::uuid[])`;
                await sql`DELETE FROM library_groups WHERE id = ${groupId}::uuid`;
                await sql`DELETE FROM user_profiles WHERE user_id = ${user}`;
                await sql`DELETE FROM users WHERE id = ${user}`;
            }
        });
    });

    /**
     * TMDB ids are only unique per media type: a movie and a series can share
     * one (on prod ~1.3k ids do). The 2025 onboarding sampler this queue was
     * ported from fetched posters by bare TMDB id, so the colliding series
     * showed the movie's poster, and it was "fixed" by excluding that series
     * by title. That exclusion is gone; this guards the real fix: both items
     * reach the queue, each with its own internal id, poster URL and card key.
     */
    it('serves a movie and a series that share a TMDB id as two items with their own posters', async () => {
        const user = generateTestUserId('itest-rate-shared-tmdb');
        await ensureTestUser(sql, user);
        const provider = getPrimaryExternalIdProvider();
        const sharedId = '97531';
        const ids: string[] = [];
        try {
            const [{ id: movieId }] = await sql<{ id: string }[]>`
                INSERT INTO media_items (title, media_type, status)
                VALUES ('SharedTmdb Lantern Hollow', 'movie', 'active') RETURNING id
            `;
            const [{ id: seriesId }] = await sql<{ id: string }[]>`
                INSERT INTO media_items (title, media_type, status)
                VALUES ('SharedTmdb Lantern Hollow Chronicles', 'tv', 'active') RETURNING id
            `;
            ids.push(movieId, seriesId);
            await sql`
                INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
                VALUES (${movieId}::uuid, ${provider}, ${sharedId}, 'movie', true),
                       (${seriesId}::uuid, ${provider}, ${sharedId}, 'tv', true)
            `;
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata)
                VALUES (${movieId}::uuid, 'tmdb', jsonb_build_object('imdb_rating', '8.6', 'overview', 'Shared-id movie')),
                       (${seriesId}::uuid, 'tmdb', jsonb_build_object('vote_average', '8.6', 'vote_count', '900', 'overview', 'Shared-id series'))
            `;
            const emb = `[${new Array(1024).fill(0.03).join(',')}]`;
            await sql`
                INSERT INTO media_embeddings (media_id, embedding, source)
                VALUES (${movieId}::uuid, ${emb}::vector, 'library'),
                       (${seriesId}::uuid, ${emb}::vector, 'library')
            `;

            // The explore sampler is random over the whole catalog: page through
            // the session until it is exhausted instead of hoping both land on page 1.
            const served: RateQueuePage['items'] = [];
            let cursor: string | undefined;
            for (let page = 0; page < 40; page++) {
                const res = await buildRateQueue(sql, ctxFor(user), unrestrictedAccess(), {
                    filter: 'all',
                    count: 50,
                    cursor,
                });
                served.push(...res.items);
                cursor = res.nextCursor;
                if (res.status === 'exhausted' || res.items.length === 0) break;
            }

            const movie = served.find((i) => i.externalIds.internal === movieId);
            const series = served.find((i) => i.externalIds.internal === seriesId);
            expect(movie, 'shared-id movie must be served').toBeDefined();
            expect(series, 'shared-id series must be served').toBeDefined();
            if (!movie || !series) return;

            expect(movie.title).toBe('SharedTmdb Lantern Hollow');
            expect(movie.mediaType).toBe('movie');
            expect(series.title).toBe('SharedTmdb Lantern Hollow Chronicles');
            expect(series.mediaType).toBe('series');
            expect(movie.externalIds[provider]).toBe(sharedId);
            expect(series.externalIds[provider]).toBe(sharedId);

            // Poster URLs as SwipeCard builds them: by internal UUID, so distinct.
            const moviePoster = imageFromIds(movie.externalIds, 'poster', 'movie');
            const seriesPoster = imageFromIds(series.externalIds, 'poster', 'series');
            expect(moviePoster).toContain(movieId);
            expect(seriesPoster).toContain(seriesId);
            expect(moviePoster).not.toBe(seriesPoster);

            // Provider-key fallback (no internal id) carries the media type.
            if (provider === 'tmdb') {
                const movieExt = { ...movie.externalIds, internal: undefined };
                const seriesExt = { ...series.externalIds, internal: undefined };
                expect(imageFromIds(movieExt, 'poster', 'movie')).toContain(
                    `tmdb:${sharedId}:movie`,
                );
                expect(imageFromIds(seriesExt, 'poster', 'series')).toContain(
                    `tmdb:${sharedId}:tv`,
                );
            }

            // SwipeDeck's {#each} key and the session dedupe key stay distinct.
            expect(mediaCompositeKey(movie.externalIds, movie.mediaType, movie.title)).not.toBe(
                mediaCompositeKey(series.externalIds, series.mediaType, series.title),
            );
        } finally {
            await sql`DELETE FROM media_embeddings WHERE media_id = ANY(${ids}::uuid[])`;
            await sql`DELETE FROM provider_metadata WHERE media_id = ANY(${ids}::uuid[])`;
            await sql`DELETE FROM external_ids WHERE media_id = ANY(${ids}::uuid[])`;
            await sql`DELETE FROM media_items WHERE id = ANY(${ids}::uuid[])`;
            await sql`DELETE FROM user_profiles WHERE user_id = ${user}`;
            await sql`DELETE FROM users WHERE id = ${user}`;
        }
    });
});
