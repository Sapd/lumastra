// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
// Type-only: the connection itself comes from the harness (getTestDb) below,
// but `postgres.Sql` is still referenced in a cast further down.
import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id.js';
import { clearAllWatchHistory, clearAllTasteDampers } from './user-data-reset.queries.js';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';

// Use the shared harness connection, NOT a private postgres() on
// TEST_DATABASE_URL: that env var is optional (the harness derives the
// test URL from DATABASE_URL when it is unset), so postgres(undefined)
// silently fell back to a localhost/OS-user connection and every test in
// this file failed with 'password authentication failed'. getTestDb() also
// installs the production bigint->number type mapping.
const sql = getTestDb();
const USER = '00000000-0000-0000-0000-0000000000a3' as UserId;
const MOVIE = '00000000-0000-0000-0000-0000000000c3';

describe('user-data-reset queries', () => {
    beforeAll(async () => {
        await sql`INSERT INTO users (id, username) VALUES (${USER}, 'reset-watch-test')
                  ON CONFLICT (id) DO NOTHING`;
        await sql`INSERT INTO media_items (id, media_type, title, has_files)
                  VALUES (${MOVIE}, 'movie', 'M', true) ON CONFLICT (id) DO NOTHING`;
        // source is NOT NULL with a CHECK constraint (see user_media_events DDL
        // in base-schema-sql.ts) — the brief's seed omitted it, so it's added
        // here to satisfy the live schema; the DELETE under test is keyed only
        // on user_id and is unaffected.
        await sql`INSERT INTO user_media_events (user_id, media_id, event_type, source, occurred_at)
                  VALUES (${USER}, ${MOVIE}, 'progress', 'lumastra-player', NOW())`;
        await sql`INSERT INTO user_media_state (user_id, media_id, is_watched)
                  VALUES (${USER}, ${MOVIE}, true)
                  ON CONFLICT (user_id, media_id) DO UPDATE SET is_watched = true`;
        // expires_at is NOT NULL with no schema default (see user_taste_dampers
        // DDL in base-schema-sql.ts) — the brief's seed omitted it, so it's added
        // here to satisfy the live schema; the DELETE under test is keyed only on
        // user_id and is unaffected.
        await sql`INSERT INTO user_taste_dampers (user_id, media_id, media_type, expires_at)
                  VALUES (${USER}, ${MOVIE}, 'movie', NOW() + INTERVAL '30 days') ON CONFLICT DO NOTHING`;
        // watch_history: media_type + session_start_time are NOT NULL.
        await sql`INSERT INTO watch_history (user_id, media_type, media_id, session_start_time)
                  VALUES (${USER}, 'movie', ${MOVIE}, NOW())`;
        // play_sessions: seed a terminated session (must be cleared) AND a live
        // one (must survive — clearing history must not kill an in-flight stream
        // on another device). status/play_method are CHECK-constrained.
        await sql`INSERT INTO play_sessions
                    (media_id, user_id, device_id, ip_address, play_method, status)
                  VALUES
                    (${MOVIE}, ${USER}, 'dev-done', '127.0.0.1', 'direct', 'COMPLETED'),
                    (${MOVIE}, ${USER}, 'dev-live', '127.0.0.1', 'direct', 'ACTIVE')`;
        // playlist_item_watched → playlist_items → playlists (FK chain).
        const [{ id: plId }] = await sql`
            INSERT INTO playlists (user_id, name) VALUES (${USER}, 'reset-test-pl') RETURNING id`;
        const [{ id: itemId }] = await sql`
            INSERT INTO playlist_items (playlist_id, title, position, media_id)
            VALUES (${plId}, 'item', 0, ${MOVIE}) RETURNING id`;
        await sql`INSERT INTO playlist_item_watched (playlist_id, item_id, user_id, watched)
                  VALUES (${plId}, ${itemId}, ${USER}, true)`;
    });
    afterAll(async () => {
        await sql`DELETE FROM users WHERE id = ${USER}`;
        await sql`DELETE FROM media_items WHERE id = ${MOVIE}`;
        // Connection teardown is owned by the harness (once per fork, at exit).
        await closeTestDb();
    });

    it('clearAllWatchHistory wipes every history store but spares live sessions', async () => {
        // TransactionSql and Sql are typed differently; cast per project convention
        const res = await sql.begin((tx) =>
            clearAllWatchHistory(tx as unknown as postgres.Sql, USER),
        );
        expect(res.events).toBeGreaterThanOrEqual(1);
        expect(res.state).toBeGreaterThanOrEqual(1);
        expect(res.watchHistory).toBeGreaterThanOrEqual(1);
        expect(res.playSessions).toBeGreaterThanOrEqual(1); // the terminated session only
        expect(res.playlistItemWatched).toBeGreaterThanOrEqual(1);

        const [{ count: ev }] =
            await sql`SELECT COUNT(*)::int FROM user_media_events WHERE user_id = ${USER}`;
        const [{ count: st }] =
            await sql`SELECT COUNT(*)::int FROM user_media_state WHERE user_id = ${USER}`;
        const [{ count: wh }] =
            await sql`SELECT COUNT(*)::int FROM watch_history WHERE user_id = ${USER}`;
        const [{ count: piw }] =
            await sql`SELECT COUNT(*)::int FROM playlist_item_watched WHERE user_id = ${USER}`;
        expect(ev).toBe(0);
        expect(st).toBe(0);
        expect(wh).toBe(0);
        expect(piw).toBe(0);

        // The live 'ACTIVE' session survives; the terminated one is gone.
        const live = await sql`SELECT status FROM play_sessions WHERE user_id = ${USER}`;
        expect(live.map((r) => r.status)).toEqual(['ACTIVE']);
    });

    it('clearAllTasteDampers removes dampers', async () => {
        const n = await clearAllTasteDampers(sql, USER);
        expect(n).toBeGreaterThanOrEqual(1);
        const [{ count }] =
            await sql`SELECT COUNT(*)::int FROM user_taste_dampers WHERE user_id = ${USER}`;
        expect(count).toBe(0);
    });
});
