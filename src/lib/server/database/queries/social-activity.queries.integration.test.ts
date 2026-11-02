// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Social Activity Query Module
 *
 * Tests getMediaTypeAndParent, resolveExternalIdToMediaId,
 * getRatedActivities, getWatchedActivities.
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
    ensureTestUser,
    insertTestRating,
    generateTestUserId,
    derivedUsername,
} from '../../../../../tests/integration/fixtures/index.js';
import { toUserId } from '$lib/shared/user-id.js';

import {
    getMediaTypeAndParent,
    resolveExternalIdToMediaId,
    getRatedActivities,
    getWatchedActivities,
} from './social-activity.queries.js';

describe('Social Activity Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [...TEST_TABLES.userData, ...TEST_TABLES.media]);
    });

    // ========================================================================
    // getMediaTypeAndParent
    // ========================================================================

    describe('getMediaTypeAndParent', () => {
        it('returns media type and parent_id', async () => {
            const movie = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, movie);

            const row = await getMediaTypeAndParent(sql, movie.id);

            expect(row).not.toBeNull();
            expect(row!.media_type).toBe('movie');
            expect(row!.parent_id).toBeNull();
        });

        it('returns null for deleted/inactive media', async () => {
            const movie = createTestMediaItem({
                media_type: 'movie',
                status: 'deleted',
            });
            await insertTestMediaItem(sql, movie);

            const row = await getMediaTypeAndParent(sql, movie.id);
            expect(row).toBeNull();
        });
    });

    // ========================================================================
    // resolveExternalIdToMediaId
    // ========================================================================

    describe('resolveExternalIdToMediaId', () => {
        it('resolves TMDB external ID to internal UUID', async () => {
            const movie = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, movie);
            const extIds = createTestExternalIds(movie.id, {
                tmdbId: 990001,
                mediaType: 'movie',
            });
            await insertTestExternalIds(sql, extIds);

            const mediaId = await resolveExternalIdToMediaId(sql, '990001', 'movie');

            expect(mediaId).toBe(movie.id);
        });

        it('returns null for unknown external ID', async () => {
            const mediaId = await resolveExternalIdToMediaId(sql, '999999', 'movie');
            expect(mediaId).toBeNull();
        });
    });

    // ========================================================================
    // getRatedActivities
    // ========================================================================

    describe('getRatedActivities', () => {
        it('returns users who rated the media excluding current user', async () => {
            const movie = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, movie);
            const currentUser = generateTestUserId();
            const otherUser = generateTestUserId();
            await ensureTestUser(sql, currentUser);
            await ensureTestUser(sql, otherUser);

            await insertTestRating(sql, {
                user_id: otherUser,
                media_id: movie.id,
                rating: 8,
                suggestion_context: null,
                skipped: false,
            });

            const rows = await getRatedActivities(sql, movie.id, currentUser);

            expect(rows).toHaveLength(1);
            expect(rows[0].user_id).toBe(otherUser);
            // Must expose the human-readable handle, not the users.id UUID.
            expect(rows[0].username).toBe(derivedUsername(otherUser));
            expect(rows[0].rating).toBe(8);
        });

        it('excludes users with hide_streams=true', async () => {
            const movie = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, movie);
            const publicUser = generateTestUserId();
            const privateUser = generateTestUserId();
            await ensureTestUser(sql, publicUser);
            await ensureTestUser(sql, privateUser);
            await sql`
                UPDATE users SET hide_streams = true WHERE id = ${privateUser}::uuid
            `;

            for (const u of [publicUser, privateUser]) {
                await insertTestRating(sql, {
                    user_id: u,
                    media_id: movie.id,
                    rating: 5,
                    suggestion_context: null,
                    skipped: false,
                });
            }

            const rows = await getRatedActivities(
                sql,
                movie.id,
                toUserId('00000000-0000-0000-0000-000000000000'),
            );
            const ids = rows.map((r) => r.user_id);

            expect(ids).toContain(publicUser);
            expect(ids).not.toContain(privateUser);
        });

        it('excludes skipped ratings', async () => {
            const movie = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, movie);
            const user = generateTestUserId();
            await ensureTestUser(sql, user);

            await insertTestRating(sql, {
                user_id: user,
                media_id: movie.id,
                rating: 1,
                suggestion_context: null,
                skipped: true,
            });

            const rows = await getRatedActivities(
                sql,
                movie.id,
                toUserId('00000000-0000-0000-0000-000000000000'),
            );
            expect(rows).toHaveLength(0);
        });
    });

    // ========================================================================
    // getWatchedActivities
    // ========================================================================

    describe('getWatchedActivities', () => {
        it('keeps activity from a new user private until they opt in', async () => {
            const movie = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, movie);
            const watcher = generateTestUserId();
            const viewer = generateTestUserId();
            await sql`INSERT INTO users (id, username) VALUES (${watcher}, ${watcher})`;
            await ensureTestUser(sql, watcher);
            await ensureTestUser(sql, viewer);
            await sql`
                INSERT INTO user_media_state (user_id, media_id, is_watched, last_watched_at)
                VALUES (${watcher}, ${movie.id}::uuid, true, now())
            `;
            expect(await getWatchedActivities(sql, movie.id, 'movie', viewer)).toEqual([]);
            await sql`UPDATE users SET hide_streams = false WHERE id = ${watcher}`;
            expect(await getWatchedActivities(sql, movie.id, 'movie', viewer)).toHaveLength(1);
        });

        it('returns users who watched the media', async () => {
            const movie = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, movie);
            const currentUser = generateTestUserId();
            const watcher = generateTestUserId();
            await ensureTestUser(sql, currentUser);
            await ensureTestUser(sql, watcher);

            await sql`
                INSERT INTO user_media_state (user_id, media_id, is_watched, last_watched_at)
                VALUES (${watcher}, ${movie.id}::uuid, true, NOW())
            `;

            const rows = await getWatchedActivities(sql, movie.id, 'movie', currentUser);

            expect(rows).toHaveLength(1);
            expect(rows[0].user_id).toBe(watcher);
            // Must expose the human-readable handle, not the users.id UUID.
            expect(rows[0].username).toBe(derivedUsername(watcher));
        });

        it('excludes current user', async () => {
            const movie = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, movie);
            const me = generateTestUserId();
            await ensureTestUser(sql, me);

            await sql`
                INSERT INTO user_media_state (user_id, media_id, is_watched, last_watched_at)
                VALUES (${me}, ${movie.id}::uuid, true, NOW())
            `;

            const rows = await getWatchedActivities(sql, movie.id, 'movie', me);
            expect(rows).toHaveLength(0);
        });

        it('excludes privacy-enabled users', async () => {
            const movie = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, movie);
            const publicUser = generateTestUserId();
            const privateUser = generateTestUserId();
            await ensureTestUser(sql, publicUser);
            await ensureTestUser(sql, privateUser);
            await sql`
                UPDATE users SET hide_streams = true WHERE id = ${privateUser}::uuid
            `;

            for (const u of [publicUser, privateUser]) {
                await sql`
                    INSERT INTO user_media_state (user_id, media_id, is_watched, last_watched_at)
                    VALUES (${u}, ${movie.id}::uuid, true, NOW())
                `;
            }

            const rows = await getWatchedActivities(
                sql,
                movie.id,
                'movie',
                toUserId('00000000-0000-0000-0000-000000000000'),
            );
            const ids = rows.map((r) => r.user_id);

            expect(ids).toContain(publicUser);
            expect(ids).not.toContain(privateUser);
        });

        // The social endpoint keeps episodes episode-scoped rather than rolling
        // them up to the series, so that "watched this episode" is literally
        // true. These two cover the data assumption that makes that safe.
        it('resolves per-episode rows, not the parent series', async () => {
            const series = createTestMediaItem({ media_type: 'tv' });
            await insertTestMediaItem(sql, series);
            const episode = createTestMediaItem({
                media_type: 'episode',
                parent_id: series.id,
            });
            await insertTestMediaItem(sql, episode);

            const currentUser = generateTestUserId();
            const episodeWatcher = generateTestUserId();
            const seriesOnlyWatcher = generateTestUserId();
            await ensureTestUser(sql, currentUser);
            await ensureTestUser(sql, episodeWatcher);
            await ensureTestUser(sql, seriesOnlyWatcher);

            await sql`
                INSERT INTO user_media_state (user_id, media_id, is_watched, last_watched_at)
                VALUES (${episodeWatcher}, ${episode.id}::uuid, true, NOW())
            `;
            await sql`
                INSERT INTO user_media_state (user_id, media_id, is_watched, last_watched_at)
                VALUES (${seriesOnlyWatcher}, ${series.id}::uuid, true, NOW())
            `;

            const rows = await getWatchedActivities(sql, episode.id, 'episode', currentUser);
            const ids = rows.map((r) => r.user_id);

            // Someone who watched the SERIES must not be reported as having
            // watched this episode — that was the bug the scoping change fixes.
            expect(ids).toContain(episodeWatcher);
            expect(ids).not.toContain(seriesOnlyWatcher);
        });

        it("leaves series progress columns null for 'episode' scope", async () => {
            const series = createTestMediaItem({ media_type: 'tv' });
            await insertTestMediaItem(sql, series);
            const episode = createTestMediaItem({
                media_type: 'episode',
                parent_id: series.id,
            });
            await insertTestMediaItem(sql, episode);

            const currentUser = generateTestUserId();
            const watcher = generateTestUserId();
            await ensureTestUser(sql, currentUser);
            await ensureTestUser(sql, watcher);

            await sql`
                INSERT INTO user_media_state (user_id, media_id, is_watched, last_watched_at)
                VALUES (${watcher}, ${episode.id}::uuid, true, NOW())
            `;

            const rows = await getWatchedActivities(sql, episode.id, 'episode', currentUser);

            expect(rows).toHaveLength(1);
            // episodes_watched/total_episodes describe the SERIES; surfacing them
            // against one episode would let the UI render "watched 12 episodes"
            // on a single-episode line.
            expect(rows[0].episodes_watched).toBeNull();
            expect(rows[0].total_episodes).toBeNull();
        });
    });
});
