// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { UserId } from '$lib/shared/user-id.js';
import { clearAllMusicState } from './music-tracking.queries.js';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';

// Use the shared harness connection, NOT a private postgres() on
// TEST_DATABASE_URL: that env var is optional (the harness derives the
// test URL from DATABASE_URL when it is unset), so postgres(undefined)
// silently fell back to a localhost/OS-user connection and every test in
// this file failed with 'password authentication failed'. getTestDb() also
// installs the production bigint->number type mapping.
const sql = getTestDb();
const USER = '00000000-0000-0000-0000-0000000000a1' as UserId;
const TRACK = '00000000-0000-0000-0000-0000000000b1';
// A second, untouched user — proves the delete is scoped to the caller and
// never wipes another user's music rows.
const OTHER = '00000000-0000-0000-0000-0000000000a9' as UserId;

describe('clearAllMusicState', () => {
    beforeAll(async () => {
        await sql`INSERT INTO users (id, username) VALUES (${USER}, 'reset-music-test'),
                  (${OTHER}, 'reset-music-other') ON CONFLICT (id) DO NOTHING`;
        await sql`INSERT INTO media_items (id, media_type, title, has_files)
                  VALUES (${TRACK}, 'track', 'T', true) ON CONFLICT (id) DO NOTHING`;
        await sql`INSERT INTO user_music_state (user_id, track_id, play_count)
                  VALUES (${USER}, ${TRACK}, 3), (${OTHER}, ${TRACK}, 5)
                  ON CONFLICT (user_id, track_id) DO UPDATE SET play_count = EXCLUDED.play_count`;
        await sql`INSERT INTO music_listen_events (user_id, track_id)
                  VALUES (${USER}, ${TRACK}), (${OTHER}, ${TRACK})`;
    });
    afterAll(async () => {
        await sql`DELETE FROM users WHERE id IN (${USER}, ${OTHER})`;
        await sql`DELETE FROM media_items WHERE id = ${TRACK}`;
        // Connection teardown is owned by the harness (once per fork, at exit).
        await closeTestDb();
    });

    it('deletes all music state + listen events for the user and returns counts', async () => {
        const res = await clearAllMusicState(sql, USER);
        expect(res.musicState).toBeGreaterThanOrEqual(1);
        expect(res.listenEvents).toBeGreaterThanOrEqual(1);
        const [{ count: s }] =
            await sql`SELECT COUNT(*)::int FROM user_music_state WHERE user_id = ${USER}`;
        const [{ count: e }] =
            await sql`SELECT COUNT(*)::int FROM music_listen_events WHERE user_id = ${USER}`;
        expect(s).toBe(0);
        expect(e).toBe(0);
    });

    it("leaves another user's music data untouched", async () => {
        // USER was cleared by the test above; OTHER must still have its rows.
        await clearAllMusicState(sql, USER);
        const [{ count: s }] =
            await sql`SELECT COUNT(*)::int FROM user_music_state WHERE user_id = ${OTHER}`;
        const [{ count: e }] =
            await sql`SELECT COUNT(*)::int FROM music_listen_events WHERE user_id = ${OTHER}`;
        expect(s).toBe(1);
        expect(e).toBe(1);
    });
});
