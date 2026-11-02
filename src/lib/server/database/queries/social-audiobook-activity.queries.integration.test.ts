// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { restrictedAccess, unrestrictedAccess } from './builders/media-access-boundary.js';
import {
    getAudiobookActivityRail,
    getViewerAudiobookListeningMs,
} from './social-audiobook-activity.queries.js';

const BOOK = '5d000000-0000-4000-8000-00000000b001';
const VIEWER = '5d000000-0000-4000-8000-00000000d001';
const MEMBER = '5d000000-0000-4000-8000-00000000d002';
const TRUST = ['household'];
const LIBRARY_GROUP = '5d000000-0000-4000-8000-00000000a001';

describe('social audiobook activity rail query', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
        await sql`
            INSERT INTO library_groups (id, name)
            VALUES (${LIBRARY_GROUP}, 'Rail restricted library')
            ON CONFLICT (id) DO NOTHING
        `;
        await sql`
            INSERT INTO media_items (id, title, media_type, has_files, status)
            VALUES (${BOOK}, 'Rail Book', 'audiobook', true, 'active')
            ON CONFLICT (id) DO UPDATE SET has_files = true, status = 'active'
        `;
        await sql`
            INSERT INTO users (
                id, username, display_name, groups, hide_streams, share_listening_activity,
                share_audiobook_activity
            ) VALUES
                (${VIEWER}, 'rail_viewer', 'Viewer', ${TRUST}, false, true, true),
                (${MEMBER}, 'rail_member', 'Anna', ${TRUST}, false, true, true)
            ON CONFLICT (id) DO UPDATE SET
                groups = EXCLUDED.groups,
                hide_streams = false,
                share_listening_activity = true,
                share_audiobook_activity = true
        `;
    });

    beforeEach(async () => {
        await sql`DELETE FROM user_media_events WHERE user_id IN (${VIEWER}, ${MEMBER})`;
        await sql`DELETE FROM user_media_state WHERE user_id IN (${VIEWER}, ${MEMBER})`;
        await sql`DELETE FROM user_media_share_opt_out WHERE user_id IN (${VIEWER}, ${MEMBER})`;
        await sql`UPDATE media_items SET library_group_id = NULL, age_rating = NULL WHERE id = ${BOOK}`;
        await sql`
            UPDATE users SET
                hide_streams = false,
                share_listening_activity = true,
                share_audiobook_activity = true
            WHERE id IN (${VIEWER}, ${MEMBER})
        `;
    });

    afterAll(async () => {
        await sql`DELETE FROM media_items WHERE id = ${BOOK}`;
        await sql`DELETE FROM library_groups WHERE id = ${LIBRARY_GROUP}`;
        await sql`DELETE FROM users WHERE id IN (${VIEWER}, ${MEMBER})`;
        await closeTestDb();
    });

    async function rail() {
        return getAudiobookActivityRail(sql, VIEWER, unrestrictedAccess(), 10, TRUST);
    }

    it('de-duplicates cumulative player heartbeats per session and exposes only a day', async () => {
        await sql`
            INSERT INTO user_media_events (
                user_id, media_id, event_type, source, session_id,
                position_ms, session_elapsed_ms, occurred_at
            ) VALUES
                (${MEMBER}, ${BOOK}, 'progress', 'lumastra-player', 'session-one',
                 3600000, 3600000, now() - interval '2 hours'),
                (${MEMBER}, ${BOOK}, 'progress', 'lumastra-player', 'session-one',
                 7200000, 7200000, now() - interval '1 hour'),
                (${MEMBER}, ${BOOK}, 'progress', 'lumastra-player', 'session-two',
                 1800000, 1800000, now())
        `;

        const rows = await rail();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            username: 'Anna',
            kind: 'listened',
            listened_minutes: 150,
            approximate: false,
        });
        expect(rows[0].occurred_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(Object.keys(rows[0])).not.toContain('occurred_at');
    });

    it('marks positive AudiobookShelf deltas approximate', async () => {
        await sql`
            INSERT INTO user_media_events (
                user_id, media_id, event_type, source, position_ms, occurred_at
            ) VALUES
                (${MEMBER}, ${BOOK}, 'progress', 'audiobookshelf-sync', 0,
                 now() - interval '70 minutes'),
                (${MEMBER}, ${BOOK}, 'progress', 'audiobookshelf-sync', 3900000,
                 now() - interval '5 minutes')
        `;

        expect(await rail()).toEqual([
            expect.objectContaining({ listened_minutes: 65, approximate: true }),
        ]);
    });

    it('measures session-less player heartbeats by playhead movement, not per row', async () => {
        // The iOS AudiobookShelf deck: no session id, position copied into
        // session_elapsed_ms. Grouped per row this read as 3 x 6 h = 18 h.
        await sql`
            INSERT INTO user_media_events (
                user_id, media_id, event_type, source,
                position_ms, session_elapsed_ms, occurred_at
            ) VALUES
                (${MEMBER}, ${BOOK}, 'progress', 'lumastra-player',
                 21600000, 21600000, now() - interval '30 minutes'),
                (${MEMBER}, ${BOOK}, 'progress', 'lumastra-player',
                 22200000, 22200000, now() - interval '20 minutes'),
                (${MEMBER}, ${BOOK}, 'progress', 'lumastra-player',
                 22800000, 22800000, now() - interval '10 minutes')
        `;

        expect(await rail()).toEqual([
            expect.objectContaining({ kind: 'listened', listened_minutes: 20, approximate: true }),
        ]);
    });

    it('does not count the AudiobookShelf mirror of the same heartbeats twice', async () => {
        await sql`
            INSERT INTO user_media_events (
                user_id, media_id, event_type, source,
                position_ms, session_elapsed_ms, occurred_at
            ) VALUES
                (${MEMBER}, ${BOOK}, 'progress', 'lumastra-player',
                 21600000, 21600000, now() - interval '30 minutes'),
                (${MEMBER}, ${BOOK}, 'progress', 'audiobookshelf-sync',
                 21600000, 21600000, now() - interval '29 minutes'),
                (${MEMBER}, ${BOOK}, 'progress', 'lumastra-player',
                 22800000, 22800000, now() - interval '10 minutes'),
                (${MEMBER}, ${BOOK}, 'progress', 'audiobookshelf-sync',
                 22800000, 22800000, now() - interval '9 minutes')
        `;

        expect(await rail()).toEqual([
            expect.objectContaining({ listened_minutes: 20, approximate: true }),
        ]);
    });

    it('counts offline-uploaded listening (lumastra-offline) exactly like a live player heartbeat', async () => {
        await sql`
            INSERT INTO user_media_events (
                user_id, media_id, event_type, source,
                position_ms, session_elapsed_ms, occurred_at
            ) VALUES
                (${MEMBER}, ${BOOK}, 'progress', 'lumastra-offline',
                 1800000, 1800000, now() - interval '1 hour')
        `;

        const rows = await rail();
        expect(rows).toEqual([
            expect.objectContaining({ kind: 'listened', listened_minutes: 30, approximate: false }),
        ]);
    });

    it('does NOT surface a lone lumastra-user-mark toggle as listening activity', async () => {
        // A mark_watched/mark_unwatched toggle is not a listening session — it
        // must not contribute elapsed minutes (LISTENING_SOURCES deliberately
        // excludes it, unlike the broader PUSHABLE_SOURCES set), and with no
        // player/offline progress in the window there is nothing to show.
        await sql`
            INSERT INTO user_media_events (
                user_id, media_id, event_type, source, occurred_at
            ) VALUES (${MEMBER}, ${BOOK}, 'mark_watched', 'lumastra-user-mark', now())
        `;

        expect(await rail()).toEqual([]);
    });

    it('folds a current completion into the highest-tier finished item', async () => {
        await sql`
            INSERT INTO user_media_events (
                user_id, media_id, event_type, source, occurred_at
            ) VALUES (${MEMBER}, ${BOOK}, 'completed', 'lumastra-user-mark', now())
        `;
        await sql`
            INSERT INTO user_media_state (user_id, media_id, is_watched)
            VALUES (${MEMBER}, ${BOOK}, true)
        `;

        expect(await rail()).toEqual([
            expect.objectContaining({ kind: 'finished', listened_minutes: null }),
        ]);
    });

    it('renders no item when all activity is outside the seven-day window', async () => {
        await sql`
            INSERT INTO user_media_events (
                user_id, media_id, event_type, source, session_id,
                session_elapsed_ms, occurred_at
            ) VALUES (
                ${MEMBER}, ${BOOK}, 'progress', 'lumastra-player',
                'old-session', 600000, now() - interval '8 days'
            )
        `;
        expect(await rail()).toEqual([]);
    });

    it('requires reciprocal opt-in and applies historical per-book opt-out', async () => {
        await sql`
            INSERT INTO user_media_events (
                user_id, media_id, event_type, source, session_id,
                session_elapsed_ms, occurred_at
            ) VALUES (${MEMBER}, ${BOOK}, 'progress', 'lumastra-player', 'session-one', 600000, now())
        `;
        expect(await rail()).toHaveLength(1);

        await sql`UPDATE users SET share_listening_activity = false WHERE id = ${VIEWER}`;
        expect(await rail()).toEqual([]);

        await sql`UPDATE users SET share_listening_activity = true WHERE id = ${VIEWER}`;
        await sql`
            INSERT INTO user_media_share_opt_out (user_id, media_id)
            VALUES (${MEMBER}, ${BOOK})
        `;
        expect(await rail()).toEqual([]);
    });

    it('applies the audiobook-wide opt-out to subjects and viewers', async () => {
        await sql`
            INSERT INTO user_media_events (
                user_id, media_id, event_type, source, session_id,
                session_elapsed_ms, occurred_at
            ) VALUES (${MEMBER}, ${BOOK}, 'progress', 'lumastra-player', 'session-one', 600000, now())
        `;
        expect(await rail()).toHaveLength(1);

        await sql`UPDATE users SET share_audiobook_activity = false WHERE id = ${MEMBER}`;
        expect(await rail()).toEqual([]);

        await sql`UPDATE users SET share_audiobook_activity = true WHERE id = ${MEMBER}`;
        await sql`UPDATE users SET share_audiobook_activity = false WHERE id = ${VIEWER}`;
        expect(await rail()).toEqual([]);
    });

    it('applies the viewer library and age boundary in the aggregation query', async () => {
        await sql`
            INSERT INTO user_media_events (
                user_id, media_id, event_type, source, session_id,
                session_elapsed_ms, occurred_at
            ) VALUES (${MEMBER}, ${BOOK}, 'progress', 'lumastra-player', 'session-one', 600000, now())
        `;
        await sql`
            UPDATE media_items
            SET library_group_id = ${LIBRARY_GROUP}, age_rating = 18
            WHERE id = ${BOOK}
        `;

        const deniedLibrary = restrictedAccess({
            deniedGroupIds: [LIBRARY_GROUP],
            maxAgeRating: null,
            allowUnrated: true,
        });
        expect(await getAudiobookActivityRail(sql, VIEWER, deniedLibrary, 10, TRUST)).toEqual([]);

        const childBoundary = restrictedAccess({
            deniedGroupIds: [],
            maxAgeRating: 12,
            allowUnrated: false,
        });
        expect(await getAudiobookActivityRail(sql, VIEWER, childBoundary, 10, TRUST)).toEqual([]);
    });

    /**
     * The relevance gate For You applies. It measures the VIEWER's own
     * listening, so it must not be confused with the circle's activity that the
     * rail itself reports.
     */
    describe('getViewerAudiobookListeningMs', () => {
        it('sums de-duplicated player sessions rather than every heartbeat', async () => {
            await sql`
                INSERT INTO user_media_events (
                    user_id, media_id, event_type, source, session_id,
                    position_ms, session_elapsed_ms, occurred_at
                ) VALUES
                    (${VIEWER}, ${BOOK}, 'progress', 'lumastra-player', 'v-session',
                     300000, 300000, now() - interval '3 days'),
                    (${VIEWER}, ${BOOK}, 'progress', 'lumastra-player', 'v-session',
                     900000, 900000, now() - interval '3 days')
            `;

            // Cumulative heartbeats: 15 min, NOT 5 + 15.
            expect(await getViewerAudiobookListeningMs(sql, VIEWER, 30)).toBe(900000);
        });

        it('counts lumastra-offline progress the same as a live player heartbeat', async () => {
            await sql`
                INSERT INTO user_media_events (
                    user_id, media_id, event_type, source,
                    position_ms, session_elapsed_ms, occurred_at
                ) VALUES
                    (${VIEWER}, ${BOOK}, 'progress', 'lumastra-offline',
                     600000, 600000, now() - interval '2 days')
            `;

            expect(await getViewerAudiobookListeningMs(sql, VIEWER, 30)).toBe(600000);
        });

        it('counts AudiobookShelf-pulled progress as positive position deltas', async () => {
            await sql`
                INSERT INTO user_media_events (
                    user_id, media_id, event_type, source, position_ms, occurred_at
                ) VALUES
                    (${VIEWER}, ${BOOK}, 'progress', 'audiobookshelf-sync',
                     600000, now() - interval '4 days'),
                    (${VIEWER}, ${BOOK}, 'progress', 'audiobookshelf-sync',
                     1200000, now() - interval '3 days'),
                    -- A rewind must not subtract.
                    (${VIEWER}, ${BOOK}, 'progress', 'audiobookshelf-sync',
                     300000, now() - interval '2 days')
            `;

            expect(await getViewerAudiobookListeningMs(sql, VIEWER, 30)).toBe(600000);
        });

        it('measures session-less player heartbeats by playhead movement', async () => {
            await sql`
                INSERT INTO user_media_events (
                    user_id, media_id, event_type, source,
                    position_ms, session_elapsed_ms, occurred_at
                ) VALUES
                    (${VIEWER}, ${BOOK}, 'progress', 'lumastra-player',
                     21600000, 21600000, now() - interval '2 days'),
                    (${VIEWER}, ${BOOK}, 'progress', 'lumastra-player',
                     22200000, 22200000, now() - interval '2 days' + interval '10 minutes')
            `;

            expect(await getViewerAudiobookListeningMs(sql, VIEWER, 30)).toBe(600000);
        });

        it('ignores listening outside the window', async () => {
            await sql`
                INSERT INTO user_media_events (
                    user_id, media_id, event_type, source, session_id,
                    position_ms, session_elapsed_ms, occurred_at
                ) VALUES
                    (${VIEWER}, ${BOOK}, 'progress', 'lumastra-player', 'old-session',
                     3600000, 3600000, now() - interval '45 days')
            `;

            expect(await getViewerAudiobookListeningMs(sql, VIEWER, 30)).toBe(0);
        });

        it("does not count OTHER people's listening", async () => {
            await sql`
                INSERT INTO user_media_events (
                    user_id, media_id, event_type, source, session_id,
                    position_ms, session_elapsed_ms, occurred_at
                ) VALUES
                    (${MEMBER}, ${BOOK}, 'progress', 'lumastra-player', 'm-session',
                     3600000, 3600000, now() - interval '1 day')
            `;

            expect(await getViewerAudiobookListeningMs(sql, VIEWER, 30)).toBe(0);
        });

        it('returns 0 for a viewer with no events at all', async () => {
            expect(await getViewerAudiobookListeningMs(sql, VIEWER, 30)).toBe(0);
        });
    });
});
