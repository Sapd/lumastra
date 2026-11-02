// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the audiobook listening reads in
 * `social-activity.queries.ts` (design doc §4.1 / §4.2).
 *
 * These are separated from `social-activity.queries.integration.test.ts` because
 * they need a different world: trust-circle rows, `share_listening_activity`, and
 * per-book opt-outs. The last section of this file is the guard the design doc
 * calls non-optional — that the ORIGINAL movie/TV reads in the same module still
 * behave exactly as they did, with no trust circle configured and none needed.
 *
 * Fixed UUIDs and exact teardown, deliberately: two sibling audiobook suites in
 * this tree insert `media_items` and never delete them, and a third asserts an
 * absolute title list over the unscoped table, so the pair is order-dependent.
 * Nothing here leaks.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { toUserId } from '$lib/shared/user-id.js';
import {
    getAudiobookListeningActivities,
    getOwnAudiobookListening,
    getAudiobookChapterTable,
    getRatedActivities,
    getWatchedActivities,
} from './social-activity.queries.js';

const BOOK = '5c000000-0000-4000-8000-00000000b001';
const BOOK_NO_CHAPTERS = '5c000000-0000-4000-8000-00000000b002';
const MOVIE = '5c000000-0000-4000-8000-00000000b003';
const ALL_MEDIA = [BOOK, BOOK_NO_CHAPTERS, MOVIE];

const VIEWER = '5c000000-0000-4000-8000-00000000d001';
const MEMBER = '5c000000-0000-4000-8000-00000000d002';
const PRIVATE_MEMBER = '5c000000-0000-4000-8000-00000000d003';
const OUTSIDER = '5c000000-0000-4000-8000-00000000d004';
const LURKER = '5c000000-0000-4000-8000-00000000d005';
const ALL_USERS = [VIEWER, MEMBER, PRIVATE_MEMBER, OUTSIDER, LURKER];

const TRUST = ['household'];

/** Three 10-minute chapters, stored the way the ABS connector writes them. */
const STORED_CHAPTERS = [
    { id: 0, start: 0, end: 600, title: 'Kapitel 1' },
    { id: 1, start: 600, end: 1200, title: 'Kapitel 2' },
    { id: 2, start: 1200, end: 1800, title: 'Kapitel 3' },
];

describe('audiobook listening queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();

        await sql`
            INSERT INTO media_items (id, title, media_type, custom_metadata)
            VALUES (
                ${BOOK}, 'Listening Book', 'audiobook',
                ${sql.json({
                    audiobookshelf: { duration: 1800, chapters: STORED_CHAPTERS },
                })}
            ), (
                ${BOOK_NO_CHAPTERS}, 'Chapterless Book', 'audiobook',
                ${sql.json({ audiobookshelf: { duration: null, chapters: [] } })}
            ), (
                ${MOVIE}, 'Listening Movie', 'movie', ${sql.json({})}
            )
            ON CONFLICT (id) DO NOTHING
        `;

        for (const [id, username, groups] of [
            [VIEWER, 'abl_viewer', ['household', 'users']],
            [MEMBER, 'abl_member', ['household', 'users']],
            [PRIVATE_MEMBER, 'abl_private', ['household', 'users']],
            [OUTSIDER, 'abl_outsider', ['users']],
            [LURKER, 'abl_lurker', ['household', 'users']],
        ] as [string, string, string[]][]) {
            await sql`
                INSERT INTO users (id, username, groups, hide_streams,
                                   share_listening_activity, share_audiobook_activity)
                VALUES (${id}, ${username}, ${groups}, false, true, true)
                ON CONFLICT (id) DO NOTHING
            `;
            // user_ratings.user_id references user_profiles(user_id), NOT users(id),
            // so the rating regression tests below fail on a missing profile row.
            await sql`
                INSERT INTO user_profiles (user_id) VALUES (${id})
                ON CONFLICT (user_id) DO NOTHING
            `;
        }
    });

    afterAll(async () => {
        // media_items cascades to user_media_state / user_ratings /
        // user_media_share_opt_out; users cascades to its own children.
        await sql`DELETE FROM media_items WHERE id = ANY(${ALL_MEDIA}::uuid[])`;
        await sql`DELETE FROM users WHERE id = ANY(${ALL_USERS}::uuid[])`;
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql`DELETE FROM user_media_share_opt_out WHERE user_id = ANY(${ALL_USERS}::uuid[])`;
        await sql`DELETE FROM user_media_state WHERE user_id = ANY(${ALL_USERS}::uuid[])`;
        await sql`DELETE FROM user_ratings WHERE user_id = ANY(${ALL_USERS}::uuid[])`;
        await sql`
            UPDATE users SET
                hide_streams = false,
                share_listening_activity = true,
                share_audiobook_activity = true
            WHERE id = ANY(${ALL_USERS}::uuid[])
        `;
    });

    async function setState(
        userId: string,
        mediaId: string,
        state: {
            positionMs?: number;
            runtimeMs?: number | null;
            watched?: boolean;
            watchCount?: number;
            lastEventAt?: string;
            lastWatchedAt?: string;
        },
    ): Promise<void> {
        await sql`
            INSERT INTO user_media_state (
                user_id, media_id, resume_position_ms, runtime_ms, is_watched, watch_count,
                last_event_at, last_watched_at
            ) VALUES (
                ${userId}, ${mediaId}, ${state.positionMs ?? 0},
                ${state.runtimeMs === undefined ? 1_800_000 : state.runtimeMs},
                ${state.watched ?? false}, ${state.watchCount ?? 0},
                ${state.lastEventAt ?? new Date().toISOString()},
                ${state.lastWatchedAt ?? (state.watched ? new Date().toISOString() : null)}
            )
            ON CONFLICT (user_id, media_id) DO UPDATE SET
                resume_position_ms = EXCLUDED.resume_position_ms,
                runtime_ms = EXCLUDED.runtime_ms,
                is_watched = EXCLUDED.is_watched,
                watch_count = EXCLUDED.watch_count,
                last_event_at = EXCLUDED.last_event_at,
                last_watched_at = EXCLUDED.last_watched_at
        `;
    }

    function listen(
        options: { viewerId?: string; mediaId?: string; tier?: 'ambient' | 'activity' } = {},
    ) {
        return getAudiobookListeningActivities(
            sql,
            options.mediaId ?? BOOK,
            toUserId(options.viewerId ?? VIEWER),
            { tier: options.tier, trustGroups: TRUST },
        );
    }

    // ------------------------------------------------------------------
    // The control. Without it every exclusion below proves nothing.
    // ------------------------------------------------------------------

    it('returns a mid-book listener in the viewer trust circle', async () => {
        await setState(MEMBER, BOOK, { positionMs: 700_000 });

        const rows = await listen();

        expect(rows.map((r) => r.username)).toEqual(['abl_member']);
        expect(rows[0].position_ms).toBe(700_000);
        expect(rows[0].duration_ms).toBe(1_800_000);
        expect(rows[0].is_finished).toBe(false);
        // bigint columns come back as NUMBERS here only because a type parser is
        // installed. A string would silently turn the delta arithmetic in the
        // projection into concatenation.
        expect(typeof rows[0].position_ms).toBe('number');
        expect(typeof rows[0].duration_ms).toBe('number');
    });

    it('surfaces the in-progress row a watched-only query cannot see', async () => {
        // The whole reason this query exists: a book at 39% has is_watched = false,
        // so getWatchedActivities returns nothing for it.
        await setState(MEMBER, BOOK, { positionMs: 700_000 });

        expect(await listen()).toHaveLength(1);
        expect(await getWatchedActivities(sql, BOOK, 'movie', toUserId(VIEWER))).toHaveLength(0);
    });

    // ------------------------------------------------------------------
    // Row filter
    // ------------------------------------------------------------------

    it('includes a finished book even though its position is 0', async () => {
        await setState(MEMBER, BOOK, { positionMs: 0, watched: true, watchCount: 2 });

        const rows = await listen();

        expect(rows).toHaveLength(1);
        expect(rows[0].is_finished).toBe(true);
        expect(rows[0].finished_recently).toBe(true);
        expect(rows[0].times_finished).toBe(2);
        expect(rows[0].position_ms).toBe(0);
    });

    it('retains an old completion but marks it as too old for the timeline', async () => {
        await setState(MEMBER, BOOK, {
            positionMs: 0,
            watched: true,
            watchCount: 1,
            lastWatchedAt: '2020-01-01T00:00:00Z',
        });

        const rows = await listen();

        expect(rows).toHaveLength(1);
        expect(rows[0].is_finished).toBe(true);
        expect(rows[0].finished_recently).toBe(false);
    });

    it('ignores a row that is neither started nor finished', async () => {
        // A rating or a dismissal can create a user_media_state row at position 0.
        // Reporting it would render a phantom "abl_member is at 0%".
        await setState(MEMBER, BOOK, { positionMs: 0, watched: false });
        expect(await listen()).toEqual([]);
    });

    // ------------------------------------------------------------------
    // Visibility — the predicate is carried, not reimplemented
    // ------------------------------------------------------------------

    it('excludes the viewer themselves', async () => {
        await setState(VIEWER, BOOK, { positionMs: 500_000 });
        await setState(MEMBER, BOOK, { positionMs: 700_000 });

        expect((await listen()).map((r) => r.username)).toEqual(['abl_member']);
    });

    it('excludes hide_streams users', async () => {
        await setState(PRIVATE_MEMBER, BOOK, { positionMs: 700_000 });
        expect((await listen()).map((r) => r.username)).toEqual(['abl_private']);

        await sql`UPDATE users SET hide_streams = true WHERE id = ${PRIVATE_MEMBER}`;
        expect(await listen()).toEqual([]);
    });

    it('excludes someone outside the designated circle', async () => {
        await setState(OUTSIDER, BOOK, { positionMs: 700_000 });
        expect(await listen()).toEqual([]);
    });

    it('shows nothing at all when no trust circle is configured', async () => {
        // §6: the feature is DARK, not broken. Fail-closed — an operator who never
        // designates a circle never broadcasts anyone's reading position.
        //
        // `audienceMode` is pinned to 'groups' because that fail-closed rule belongs
        // to the GROUP audience. Under the default 'auto', "no groups" now means the
        // household audience, where having none is the expected state rather than a
        // missing configuration.
        await setState(MEMBER, BOOK, { positionMs: 700_000 });

        const rows = await getAudiobookListeningActivities(sql, BOOK, toUserId(VIEWER), {
            trustGroups: [],
            audienceMode: 'groups',
        });
        expect(rows).toEqual([]);
    });

    it('household mode shows the same listener with no circle configured', async () => {
        await setState(MEMBER, BOOK, { positionMs: 700_000 });

        const rows = await getAudiobookListeningActivities(sql, BOOK, toUserId(VIEWER), {
            trustGroups: [],
            audienceMode: 'household',
        });
        expect(rows.map((r) => r.user_id)).toContain(MEMBER);
    });

    it('hides a book the subject opted out of, including historical activity', async () => {
        await setState(MEMBER, BOOK, { positionMs: 700_000, watched: true, watchCount: 1 });
        expect(await listen()).toHaveLength(1);

        await sql`
            INSERT INTO user_media_share_opt_out (user_id, media_id)
            VALUES (${MEMBER}, ${BOOK})
        `;
        // Not "future events are hidden" — the already-recorded position and the
        // already-recorded completion both disappear.
        expect(await listen()).toEqual([]);
    });

    it('leaves other books visible when one is opted out of', async () => {
        await setState(MEMBER, BOOK, { positionMs: 700_000 });
        await setState(MEMBER, BOOK_NO_CHAPTERS, { positionMs: 700_000 });
        await sql`
            INSERT INTO user_media_share_opt_out (user_id, media_id)
            VALUES (${MEMBER}, ${BOOK})
        `;

        expect(await listen({ mediaId: BOOK })).toEqual([]);
        expect(await listen({ mediaId: BOOK_NO_CHAPTERS })).toHaveLength(1);
    });

    it('globally hides a subject from every audiobook while leaving stored history intact', async () => {
        await setState(MEMBER, BOOK, { positionMs: 700_000 });
        await setState(MEMBER, BOOK_NO_CHAPTERS, { positionMs: 500_000 });
        expect(await listen({ mediaId: BOOK })).toHaveLength(1);
        expect(await listen({ mediaId: BOOK_NO_CHAPTERS })).toHaveLength(1);

        await sql`UPDATE users SET share_audiobook_activity = false WHERE id = ${MEMBER}`;

        expect(await listen({ mediaId: BOOK })).toEqual([]);
        expect(await listen({ mediaId: BOOK_NO_CHAPTERS })).toEqual([]);
        expect(
            await sql`SELECT 1 FROM user_media_state WHERE user_id = ${MEMBER} AND media_id = ${BOOK}`,
        ).toHaveLength(1);
    });

    it('enforces reciprocity on the activity tier only', async () => {
        await setState(MEMBER, BOOK, { positionMs: 700_000 });
        await sql`UPDATE users SET share_listening_activity = false WHERE id = ${VIEWER}`;

        // The default modal tier is ambient and unaffected by the opt-in flag.
        expect(await listen()).toHaveLength(1);
        // The rail tier refuses a viewer who shares nothing themselves.
        expect(await listen({ tier: 'activity' })).toEqual([]);
    });

    it('prevents a globally opted-out viewer from reading EITHER tier', async () => {
        await setState(MEMBER, BOOK, { positionMs: 700_000 });
        // Both tiers are reciprocal on the audiobook switch. This used to assert
        // `toHaveLength(1)` for ambient — a viewer who stopped broadcasting kept
        // receiving, and the ambient tier they kept receiving carries the FINER
        // data (exact position and chapter) while the coarse rail was the one
        // protected. Turning your own sharing off now hides you and them.
        await sql`UPDATE users SET share_audiobook_activity = false WHERE id = ${VIEWER}`;

        expect(await listen()).toEqual([]);
        expect(await listen({ tier: 'activity' })).toEqual([]);

        // ...and it is genuinely the VIEWER's switch doing it: restore it and the
        // same row comes back, so this is not a broken fixture.
        await sql`UPDATE users SET share_audiobook_activity = true WHERE id = ${VIEWER}`;
        expect(await listen()).toHaveLength(1);
    });

    // ------------------------------------------------------------------
    // Ordering and shape
    // ------------------------------------------------------------------

    it('orders by recency of activity without exposing a timestamp', async () => {
        await setState(MEMBER, BOOK, { positionMs: 100_000, lastEventAt: '2026-07-01T10:00:00Z' });
        await setState(LURKER, BOOK, { positionMs: 200_000, lastEventAt: '2026-07-20T10:00:00Z' });

        const rows = await listen();

        expect(rows.map((r) => r.username)).toEqual(['abl_lurker', 'abl_member']);
        // "Never clock times, at any tier." Two things have to hold for that, and
        // this assertion covers the pair: the ordering key is never SELECTed, and
        // `normalizeListeningRow` rebuilds the row from named fields. Mutating
        // either one alone still passes; mutating both fails here.
        for (const row of rows) {
            expect(Object.keys(row).sort()).toEqual([
                'duration_ms',
                'finished_recently',
                'is_finished',
                'listened_on',
                'position_ms',
                'times_finished',
                'user_id',
                'username',
            ]);
            // The one recency field is a bare date, never a time.
            expect(row.listened_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        }
    });

    /**
     * Recency is behavioural data, so it follows the activity rail's reciprocal
     * rule: a day is shown only when BOTH sides share listening activity.
     */
    it('gives the day of latest activity when both sides share listening', async () => {
        await setState(MEMBER, BOOK, { positionMs: 100_000, lastEventAt: '2026-07-20T23:30:00Z' });

        const [row] = await listen();

        expect(row.username).toBe('abl_member');
        expect(row.listened_on).toBe(
            (
                await sql<
                    { d: string }[]
                >`SELECT '2026-07-20T23:30:00Z'::timestamptz::date::text AS d`
            )[0].d,
        );
    });

    it('withholds the day when the person does not share listening activity', async () => {
        await sql`UPDATE users SET share_listening_activity = false WHERE id = ${MEMBER}::uuid`;
        await setState(MEMBER, BOOK, { positionMs: 100_000 });

        const rows = await listen();

        const member = rows.find((r) => r.username === 'abl_member');
        expect(member).toBeDefined();
        expect(member!.listened_on).toBeNull();
    });

    it('withholds the day when the viewer does not share listening activity', async () => {
        await sql`UPDATE users SET share_listening_activity = false WHERE id = ${VIEWER}::uuid`;
        await setState(MEMBER, BOOK, { positionMs: 100_000 });

        const rows = await listen();

        const member = rows.find((r) => r.username === 'abl_member');
        expect(member).toBeDefined();
        expect(member!.listened_on).toBeNull();
    });

    it('honours the limit', async () => {
        await setState(MEMBER, BOOK, { positionMs: 100_000 });
        await setState(LURKER, BOOK, { positionMs: 200_000 });

        const rows = await getAudiobookListeningActivities(sql, BOOK, toUserId(VIEWER), {
            trustGroups: TRUST,
            limit: 1,
        });
        expect(rows).toHaveLength(1);
    });

    // ------------------------------------------------------------------
    // getOwnAudiobookListening — the shared-listen reference point
    // ------------------------------------------------------------------

    describe('getOwnAudiobookListening', () => {
        it('returns the viewer own row, which the circle predicate excludes', async () => {
            await setState(VIEWER, BOOK, { positionMs: 500_000, watched: true, watchCount: 1 });

            const own = await getOwnAudiobookListening(sql, BOOK, toUserId(VIEWER));

            expect(own).not.toBeNull();
            expect(own!.position_ms).toBe(500_000);
            expect(own!.is_finished).toBe(true);
            expect(own!.times_finished).toBe(1);
            // …and is still absent from the visible rows, so the predicate was not
            // quietly widened to make this work.
            expect(await listen()).toEqual([]);
        });

        it('returns null when the viewer has never opened the book', async () => {
            expect(await getOwnAudiobookListening(sql, BOOK, toUserId(VIEWER))).toBeNull();
        });

        it('is not filtered by the viewer own privacy settings', async () => {
            // A hide_streams user still needs their own position to detect a shared
            // listen — privacy governs what OTHERS see, not what they see.
            await sql`UPDATE users SET hide_streams = true WHERE id = ${VIEWER}`;
            await setState(VIEWER, BOOK, { positionMs: 500_000 });

            expect(await getOwnAudiobookListening(sql, BOOK, toUserId(VIEWER))).not.toBeNull();
        });
    });

    // ------------------------------------------------------------------
    // getAudiobookChapterTable
    // ------------------------------------------------------------------

    describe('getAudiobookChapterTable', () => {
        it('reads the stored chapters and converts the duration to ms', async () => {
            const table = await getAudiobookChapterTable(sql, BOOK);

            expect(table).not.toBeNull();
            expect(table!.duration_ms).toBe(1_800_000);
            expect(table!.chapters).toHaveLength(3);
            expect(table!.chapters[1]).toEqual({
                id: 1,
                title: 'Kapitel 2',
                start: 600,
                end: 1200,
            });
        });

        it('reports no chapters and no duration for a book that has neither', async () => {
            const table = await getAudiobookChapterTable(sql, BOOK_NO_CHAPTERS);

            expect(table).not.toBeNull();
            expect(table!.chapters).toEqual([]);
            expect(table!.duration_ms).toBeNull();
        });

        it('refuses a media id that is not an audiobook', async () => {
            expect(await getAudiobookChapterTable(sql, MOVIE)).toBeNull();
        });

        it('survives a non-numeric duration instead of failing the statement', async () => {
            // A ::float cast raises 22P02 for the whole statement on one bad row.
            // custom_metadata is operator- and connector-writable jsonb.
            await sql`
                UPDATE media_items
                SET custom_metadata = jsonb_set(
                    custom_metadata, '{audiobookshelf,duration}', '"12:34"'::jsonb
                )
                WHERE id = ${BOOK_NO_CHAPTERS}
            `;
            try {
                const table = await getAudiobookChapterTable(sql, BOOK_NO_CHAPTERS);
                expect(table!.duration_ms).toBeNull();
            } finally {
                await sql`
                    UPDATE media_items
                    SET custom_metadata = jsonb_set(
                        custom_metadata, '{audiobookshelf,duration}', 'null'::jsonb
                    )
                    WHERE id = ${BOOK_NO_CHAPTERS}
                `;
            }
        });

        it('drops chapter entries that carry no numeric start', async () => {
            await sql`
                UPDATE media_items
                SET custom_metadata = jsonb_set(
                    custom_metadata, '{audiobookshelf,chapters}',
                    ${sql.json([
                        { id: 0, start: null, end: 100, title: 'Broken' },
                        { id: 1, start: 0, end: 100, title: 'Good' },
                        'not-an-object',
                    ])}::jsonb
                )
                WHERE id = ${BOOK_NO_CHAPTERS}
            `;
            try {
                const table = await getAudiobookChapterTable(sql, BOOK_NO_CHAPTERS);
                expect(table!.chapters.map((c) => c.title)).toEqual(['Good']);
            } finally {
                await sql`
                    UPDATE media_items
                    SET custom_metadata = jsonb_set(
                        custom_metadata, '{audiobookshelf,chapters}', '[]'::jsonb
                    )
                    WHERE id = ${BOOK_NO_CHAPTERS}
                `;
            }
        });
    });

    // ------------------------------------------------------------------
    // REGRESSION — the design doc calls this guard non-optional, because this
    // change touches a shared query module and a shared component.
    // ------------------------------------------------------------------

    describe('the existing movie/TV reads are unchanged', () => {
        it('getWatchedActivities still needs no trust circle', async () => {
            // The tightening applies to audiobook LISTENING rows only. If it had
            // leaked into the shared query, every movie modal in the product would
            // have gone blank on an install with no configured circle.
            await setState(MEMBER, MOVIE, { positionMs: 0, watched: true });
            await setState(OUTSIDER, MOVIE, { positionMs: 0, watched: true });

            const rows = await getWatchedActivities(sql, MOVIE, 'movie', toUserId(VIEWER));

            expect(rows.map((r) => r.username).sort()).toEqual(['abl_member', 'abl_outsider']);
        });

        it('getWatchedActivities still filters is_watched = true', async () => {
            // The other half: a movie in progress must NOT start appearing. "Anna is
            // 20 minutes into this film" on every modal is the failure mode that
            // made this a separate query in the first place.
            await setState(MEMBER, MOVIE, { positionMs: 700_000, watched: false });

            expect(await getWatchedActivities(sql, MOVIE, 'movie', toUserId(VIEWER))).toEqual([]);
        });

        it('getWatchedActivities still ignores a share opt-out', async () => {
            // The per-book escape is an audiobook control. Wiring it into the shared
            // query would silently change movie/TV visibility semantics.
            await setState(MEMBER, MOVIE, { positionMs: 0, watched: true });
            await sql`
                INSERT INTO user_media_share_opt_out (user_id, media_id)
                VALUES (${MEMBER}, ${MOVIE})
            `;

            expect(
                (await getWatchedActivities(sql, MOVIE, 'movie', toUserId(VIEWER))).map(
                    (r) => r.username,
                ),
            ).toEqual(['abl_member']);
        });

        it('getRatedActivities still needs no trust circle and ignores opt-outs', async () => {
            for (const user of [MEMBER, OUTSIDER]) {
                await sql`
                    INSERT INTO user_ratings (user_id, media_id, rating)
                    VALUES (${user}, ${MOVIE}, 8)
                `;
            }
            await sql`
                INSERT INTO user_media_share_opt_out (user_id, media_id)
                VALUES (${MEMBER}, ${MOVIE})
            `;

            const rows = await getRatedActivities(sql, MOVIE, toUserId(VIEWER));

            expect(rows.map((r) => r.username).sort()).toEqual(['abl_member', 'abl_outsider']);
        });

        it('getRatedActivities still hides hide_streams users', async () => {
            await sql`
                INSERT INTO user_ratings (user_id, media_id, rating)
                VALUES (${PRIVATE_MEMBER}, ${MOVIE}, 8)
            `;
            await sql`UPDATE users SET hide_streams = true WHERE id = ${PRIVATE_MEMBER}`;

            expect(await getRatedActivities(sql, MOVIE, toUserId(VIEWER))).toEqual([]);
        });
    });
});
