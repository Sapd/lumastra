// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Social Query Module
 *
 * Tests getMediaViewers and getCurrentUserWatchState.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
    ensureTestUser,
    insertTestRating,
    generateTestUserId,
    type MediaType,
} from '../../../../../tests/integration/fixtures/index.js';
import type { UserId } from '$lib/shared/user-id.js';

import { getMediaViewers, getCurrentUserWatchState } from './social.queries.js';

/** Marks a user as having watched a media item, ensuring the user row exists first. */
async function seedWatched(
    sql: postgres.Sql,
    { mediaId, userId }: { mediaId: string; userId: UserId },
): Promise<void> {
    await ensureTestUser(sql, userId);
    await sql`
        INSERT INTO user_media_state (user_id, media_id, is_watched, last_watched_at)
        VALUES (${userId}, ${mediaId}::uuid, true, NOW())
    `;
}

/** Seeds `count` distinct watchers for a media item, returning their user IDs. */
async function seedManyWatchers(
    sql: postgres.Sql,
    mediaId: string,
    count: number,
): Promise<UserId[]> {
    const userIds: UserId[] = [];
    for (let i = 0; i < count; i++) {
        const userId = generateTestUserId();
        await seedWatched(sql, { mediaId, userId });
        userIds.push(userId);
    }
    return userIds;
}

describe('Social Queries', () => {
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
    // getMediaViewers
    // ========================================================================

    describe('getMediaViewers', () => {
        it('keeps a new user private until they explicitly enable sharing', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            const watcher = generateTestUserId();
            const viewer = generateTestUserId();
            await sql`INSERT INTO users (id, username) VALUES (${watcher}, ${watcher})`;
            await seedWatched(sql, { mediaId: item.id, userId: watcher });
            await ensureTestUser(sql, viewer);
            expect(await getMediaViewers(sql, item.id, viewer)).toEqual([]);
            await sql`UPDATE users SET hide_streams = false WHERE id = ${watcher}`;
            expect(
                (await getMediaViewers(sql, item.id, viewer)).map((row) => row.user_id),
            ).toContain(watcher);
        });

        it('returns users who watched the media', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            const user1 = generateTestUserId();
            const user2 = generateTestUserId();
            const currentUser = generateTestUserId();
            await ensureTestUser(sql, currentUser);
            await seedWatched(sql, { mediaId: item.id, userId: user1 });
            await seedWatched(sql, { mediaId: item.id, userId: user2 });
            await sql`UPDATE users SET display_name = 'Alice' WHERE id = ${user1}::uuid`;
            await sql`UPDATE users SET display_name = 'Bob' WHERE id = ${user2}::uuid`;

            const rows = await getMediaViewers(sql, item.id, currentUser);
            const displayNames = rows.map((r) => r.display_name);

            expect(displayNames).toContain('Alice');
            expect(displayNames).toContain('Bob');
        });

        it('includes rating when user has rated the media', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            const user = generateTestUserId();
            const currentUser = generateTestUserId();
            await ensureTestUser(sql, currentUser);
            await seedWatched(sql, { mediaId: item.id, userId: user });
            await insertTestRating(sql, {
                user_id: user,
                media_id: item.id,
                rating: 8,
                suggestion_context: null,
                skipped: false,
            });

            const rows = await getMediaViewers(sql, item.id, currentUser);

            expect(rows).toHaveLength(1);
            expect(rows[0].rating).toBe(8);
        });

        it('includes rating_style when the viewer rated with a known style', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            const user = generateTestUserId();
            const currentUser = generateTestUserId();
            await ensureTestUser(sql, currentUser);
            await seedWatched(sql, { mediaId: item.id, userId: user });
            await insertTestRating(sql, {
                user_id: user,
                media_id: item.id,
                rating: 8,
                suggestion_context: null,
                skipped: false,
            });
            await sql`
                UPDATE user_ratings SET rating_style = 'stars'
                WHERE user_id = ${user}::uuid AND media_id = ${item.id}::uuid
            `;

            const rows = await getMediaViewers(sql, item.id, currentUser);

            expect(rows).toHaveLength(1);
            expect(rows[0].rating_style).toBe('stars');
        });

        it('reports rating_style as null when the viewer has not rated', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            const user = generateTestUserId();
            const currentUser = generateTestUserId();
            await ensureTestUser(sql, currentUser);
            await seedWatched(sql, { mediaId: item.id, userId: user });

            const rows = await getMediaViewers(sql, item.id, currentUser);

            expect(rows).toHaveLength(1);
            expect(rows[0].rating_style).toBeNull();
        });

        it('excludes users with stream privacy enabled', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            const userPublic = generateTestUserId();
            const userPrivate = generateTestUserId();
            const currentUser = generateTestUserId();
            await ensureTestUser(sql, currentUser);
            await seedWatched(sql, { mediaId: item.id, userId: userPublic });
            await seedWatched(sql, { mediaId: item.id, userId: userPrivate });

            await sql`
                UPDATE users SET hide_streams = true WHERE id = ${userPrivate}::uuid
            `;

            const rows = await getMediaViewers(sql, item.id, currentUser);
            const userIds = rows.map((r) => r.user_id);

            expect(userIds).toContain(userPublic);
            expect(userIds).not.toContain(userPrivate);
        });

        it('returns empty array when no viewers', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            const currentUser = generateTestUserId();
            await ensureTestUser(sql, currentUser);

            const rows = await getMediaViewers(sql, item.id, currentUser);
            expect(rows).toEqual([]);
        });

        it('excludes hide_streams users from BOTH the rows and the count', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            const visibleUser = generateTestUserId();
            const hiddenUser = generateTestUserId();
            const otherUser = generateTestUserId();
            await ensureTestUser(sql, otherUser);
            await seedWatched(sql, { mediaId: item.id, userId: visibleUser });
            await seedWatched(sql, { mediaId: item.id, userId: hiddenUser });
            await sql`UPDATE users SET hide_streams = true WHERE id = ${hiddenUser}::uuid`;

            const rows = await getMediaViewers(sql, item.id, otherUser);

            expect(rows).toHaveLength(1);
            expect(Number(rows[0].total_count)).toBe(1); // NOT 2 — the opt-out must not be inferable
        });

        it('excludes the current user from the count', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            const alice = generateTestUserId();
            const bob = generateTestUserId();
            await seedWatched(sql, { mediaId: item.id, userId: alice });
            await seedWatched(sql, { mediaId: item.id, userId: bob });

            const rows = await getMediaViewers(sql, item.id, alice);

            expect(rows).toHaveLength(1);
            expect(Number(rows[0].total_count)).toBe(1);
        });

        it('reports the pre-LIMIT total so "+N others" stays meaningful', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            const otherUser = generateTestUserId();
            await ensureTestUser(sql, otherUser);
            await seedManyWatchers(sql, item.id, 7);

            const rows = await getMediaViewers(sql, item.id, otherUser, 3);

            expect(rows).toHaveLength(3);
            expect(Number(rows[0].total_count)).toBe(7);
        });

        it('returns null instead of exposing username when display_name is null', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            const visibleUser = generateTestUserId();
            const otherUser = generateTestUserId();
            await ensureTestUser(sql, otherUser);
            await seedWatched(sql, { mediaId: item.id, userId: visibleUser });

            await sql`UPDATE users SET display_name = NULL WHERE id = ${visibleUser}::uuid`;

            const rows = await getMediaViewers(sql, item.id, otherUser);
            expect(rows[0].display_name).toBeNull();
        });

        // The zero-width/bidi cases are the read-side half of the write-boundary
        // sanitiser. Legacy rows that render blank become NULL; they must never
        // fall back to the login handle on a shared screen.
        it.each([
            ['empty', ''],
            ['whitespace-only', '   '],
            ['tab/newline whitespace', '\t\n'],
            ['zero-width spaces only', '\u200B\u200B'],
            ['a BOM only', '\uFEFF'],
            ['bidi controls only', '\u202E\u202C'],
            ['zero-width padded whitespace', '\u200B \u200D'],
        ])('returns null when display_name is %s', async (_label, value) => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            const visibleUser = generateTestUserId();
            const otherUser = generateTestUserId();
            await ensureTestUser(sql, otherUser);
            await seedWatched(sql, { mediaId: item.id, userId: visibleUser });

            await sql`UPDATE users SET display_name = ${value} WHERE id = ${visibleUser}::uuid`;

            const rows = await getMediaViewers(sql, item.id, otherUser);
            expect(rows[0].display_name).toBeNull();
        });
    });

    // ========================================================================
    // getMediaViewers — the audiobook tier
    //
    // This endpoint is media-type agnostic and used to gate on `hide_streams`
    // alone, so an audiobook UUID returned everyone who finished that book,
    // straight past the trust-circle predicate every other listening surface
    // goes through. Each case below starts from a row that is provably visible
    // and flips exactly one thing — otherwise a predicate that hid everything
    // would pass the whole block.
    // ========================================================================

    describe('getMediaViewers — audiobooks are gated by the trust circle', () => {
        const TRUST = ['household'];

        /** A book, a finisher in `groups`, and a viewer. Returns their ids. */
        async function seedBook(options: {
            mediaType?: MediaType;
            finisherGroups: string[] | null;
            viewerGroups: string[] | null;
        }): Promise<{ mediaId: string; finisher: UserId; viewer: UserId }> {
            const item = createTestMediaItem({
                media_type: options.mediaType ?? 'audiobook',
            });
            await insertTestMediaItem(sql, item);

            const finisher = generateTestUserId();
            const viewer = generateTestUserId();
            await seedWatched(sql, { mediaId: item.id, userId: finisher });
            await ensureTestUser(sql, viewer);
            await sql`UPDATE users SET groups = ${options.finisherGroups} WHERE id = ${finisher}::uuid`;
            await sql`UPDATE users SET groups = ${options.viewerGroups} WHERE id = ${viewer}::uuid`;

            return { mediaId: item.id, finisher, viewer };
        }

        it('shows a finisher who shares a designated group with the viewer', async () => {
            const { mediaId, viewer } = await seedBook({
                finisherGroups: ['Household', 'users'],
                viewerGroups: ['household', 'users'],
            });

            const rows = await getMediaViewers(sql, mediaId, viewer, 50, {
                trustGroups: TRUST,
            });

            expect(rows).toHaveLength(1);
            expect(Number(rows[0].total_count)).toBe(1);
        });

        it('hides a finisher who shares only a broad group', async () => {
            const { mediaId, viewer } = await seedBook({
                finisherGroups: ['users'],
                viewerGroups: ['household', 'users'],
            });

            const rows = await getMediaViewers(sql, mediaId, viewer, 50, {
                trustGroups: TRUST,
            });

            // Both rows AND the count, so "N people finished this" cannot leak
            // the size of a circle the viewer is not in.
            expect(rows).toEqual([]);
        });

        // --------------------------------------------------------------
        // Movies and series obey the SAME audience
        // --------------------------------------------------------------
        //
        // These used to be gated on `hide_streams` alone: a user who narrowed
        // their audience to one group still had their whole watch history
        // visible to every account on the instance. Each case starts from a row
        // that is provably visible and flips exactly one thing, so a predicate
        // that hid everything would not pass.

        it('hides a movie watcher outside the configured audience', async () => {
            const { mediaId, viewer } = await seedBook({
                mediaType: 'movie',
                finisherGroups: ['outsiders'],
                viewerGroups: TRUST,
            });

            // Visible under the household audience...
            expect(
                await getMediaViewers(sql, mediaId, viewer, 50, { audienceMode: 'household' }),
            ).toHaveLength(1);

            // ...and hidden once the audience is a group they are not in.
            expect(
                await getMediaViewers(sql, mediaId, viewer, 50, {
                    trustGroups: TRUST,
                    audienceMode: 'groups',
                }),
            ).toEqual([]);
        });

        it('keeps a movie watcher who shares the configured audience', async () => {
            const { mediaId, viewer } = await seedBook({
                mediaType: 'movie',
                finisherGroups: TRUST,
                viewerGroups: TRUST,
            });

            expect(
                await getMediaViewers(sql, mediaId, viewer, 50, {
                    trustGroups: TRUST,
                    audienceMode: 'groups',
                }),
            ).toHaveLength(1);
        });

        it('does not require the audiobook switch for a movie watcher', async () => {
            // `share_audiobook_activity` is audiobook-specific; turning it off
            // must not hide someone's movie history.
            const { mediaId, finisher, viewer } = await seedBook({
                mediaType: 'movie',
                finisherGroups: TRUST,
                viewerGroups: TRUST,
            });
            await sql`UPDATE users SET share_audiobook_activity = false WHERE id = ${finisher}::uuid`;

            expect(
                await getMediaViewers(sql, mediaId, viewer, 50, {
                    trustGroups: TRUST,
                    audienceMode: 'groups',
                }),
            ).toHaveLength(1);
        });

        it('hides every audiobook finisher when no trust circle is configured', async () => {
            const { mediaId, viewer } = await seedBook({
                finisherGroups: ['household', 'users'],
                viewerGroups: ['household', 'users'],
            });

            expect(
                await getMediaViewers(sql, mediaId, viewer, 50, {
                    trustGroups: [],
                    // Pinned: under the default 'auto', no groups means HOUSEHOLD, and
                    // this case is specifically about the group mode's dark state.
                    audienceMode: 'groups',
                }),
            ).toEqual([]);
            // ...and the very same rows ARE visible once a circle exists, so this
            // is the dark-by-default gate and not a broken query.
            expect(
                await getMediaViewers(sql, mediaId, viewer, 50, { trustGroups: TRUST }),
            ).toHaveLength(1);
        });

        it('household mode shows audiobook finishers with no circle configured', async () => {
            // The point of the household audience: the same seed that is dark under
            // group mode with no groups is visible here, with nothing to configure.
            const { mediaId, viewer } = await seedBook({
                finisherGroups: [],
                viewerGroups: [],
            });

            expect(
                await getMediaViewers(sql, mediaId, viewer, 50, {
                    trustGroups: [],
                    audienceMode: 'household',
                }),
            ).toHaveLength(1);

            // Group mode on the identical seed stays dark — proving the difference is
            // the audience mode and not the fixture.
            expect(
                await getMediaViewers(sql, mediaId, viewer, 50, {
                    trustGroups: [],
                    audienceMode: 'groups',
                }),
            ).toEqual([]);
        });

        it('honours a per-book share opt-out', async () => {
            const { mediaId, finisher, viewer } = await seedBook({
                finisherGroups: ['household'],
                viewerGroups: ['household'],
            });
            expect(
                await getMediaViewers(sql, mediaId, viewer, 50, { trustGroups: TRUST }),
            ).toHaveLength(1);

            await sql`
                INSERT INTO user_media_share_opt_out (user_id, media_id)
                VALUES (${finisher}::uuid, ${mediaId}::uuid)
            `;
            try {
                expect(
                    await getMediaViewers(sql, mediaId, viewer, 50, { trustGroups: TRUST }),
                ).toEqual([]);
            } finally {
                await sql`
                    DELETE FROM user_media_share_opt_out
                    WHERE user_id = ${finisher}::uuid AND media_id = ${mediaId}::uuid
                `;
            }
        });

        it('honours the subject audiobook-wide opt-out', async () => {
            const { mediaId, finisher, viewer } = await seedBook({
                finisherGroups: ['household'],
                viewerGroups: ['household'],
            });
            expect(
                await getMediaViewers(sql, mediaId, viewer, 50, { trustGroups: TRUST }),
            ).toHaveLength(1);

            await sql`
                UPDATE users SET share_audiobook_activity = false WHERE id = ${finisher}::uuid
            `;
            try {
                expect(
                    await getMediaViewers(sql, mediaId, viewer, 50, { trustGroups: TRUST }),
                ).toEqual([]);
            } finally {
                await sql`
                    UPDATE users SET share_audiobook_activity = true WHERE id = ${finisher}::uuid
                `;
            }
        });

        it('leaves movies on the hide_streams tier — an unconfigured circle must not blank them', async () => {
            // The regression this pairs with: gating every media type through the
            // trust circle would make every existing "who watched this" list go
            // dark on an install that never configures SOCIAL_TRUST_GROUPS.
            const { mediaId, viewer } = await seedBook({
                mediaType: 'movie',
                finisherGroups: null,
                viewerGroups: null,
            });

            expect(
                await getMediaViewers(sql, mediaId, viewer, 50, { trustGroups: [] }),
            ).toHaveLength(1);
        });

        it('leaves an episode on the hide_streams tier too', async () => {
            const { mediaId, viewer } = await seedBook({
                mediaType: 'episode',
                finisherGroups: null,
                viewerGroups: null,
            });

            expect(
                await getMediaViewers(sql, mediaId, viewer, 50, { trustGroups: [] }),
            ).toHaveLength(1);
        });
    });

    // ========================================================================
    // getCurrentUserWatchState
    // ========================================================================

    describe('getCurrentUserWatchState', () => {
        it('returns watched=true and the rating when the user watched and rated', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            const user = generateTestUserId();
            await seedWatched(sql, { mediaId: item.id, userId: user });
            await insertTestRating(sql, {
                user_id: user,
                media_id: item.id,
                rating: 9,
                suggestion_context: null,
                skipped: false,
            });

            const state = await getCurrentUserWatchState(sql, item.id, user);

            expect(state.watched).toBe(true);
            expect(state.rating).toBe(9);
        });

        it('returns watched=false and rating=null when the user has no state', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            const user = generateTestUserId();
            await ensureTestUser(sql, user);

            const state = await getCurrentUserWatchState(sql, item.id, user);

            expect(state.watched).toBe(false);
            expect(state.rating).toBeNull();
        });

        it('returns the rating even when the user rated without watching', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            const user = generateTestUserId();
            await insertTestRating(sql, {
                user_id: user,
                media_id: item.id,
                rating: 5,
                suggestion_context: null,
                skipped: false,
            });

            const state = await getCurrentUserWatchState(sql, item.id, user);

            expect(state.watched).toBe(false);
            expect(state.rating).toBe(5);
        });
    });
});
