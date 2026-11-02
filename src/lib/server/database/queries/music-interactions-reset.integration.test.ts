// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { UserId } from '$lib/shared/user-id.js';
import { clearAllTrackRatings } from './music-interactions.queries.js';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';

// Use the shared harness connection, NOT a private postgres() on
// TEST_DATABASE_URL: that env var is optional (the harness derives the
// test URL from DATABASE_URL when it is unset), so postgres(undefined)
// silently fell back to a localhost/OS-user connection and every test in
// this file failed with 'password authentication failed'. getTestDb() also
// installs the production bigint->number type mapping.
const sql = getTestDb();
const USER = '00000000-0000-0000-0000-0000000000a2' as UserId;
const TRACK = '00000000-0000-0000-0000-0000000000b2';
const MOVIE = '00000000-0000-0000-0000-0000000000c2';

describe('clearAllTrackRatings', () => {
    beforeAll(async () => {
        await sql`INSERT INTO users (id, username) VALUES (${USER}, 'reset-rating-test')
                  ON CONFLICT (id) DO NOTHING`;
        // user_ratings.user_id FKs to user_profiles(user_id), not users(id) directly.
        await sql`INSERT INTO user_profiles (user_id) VALUES (${USER})
                  ON CONFLICT (user_id) DO NOTHING`;
        await sql`INSERT INTO media_items (id, media_type, title, has_files)
                  VALUES (${TRACK}, 'track', 'T', true), (${MOVIE}, 'movie', 'M', true)
                  ON CONFLICT (id) DO NOTHING`;
        await sql`INSERT INTO user_ratings (user_id, media_id, rating, skipped)
                  VALUES (${USER}, ${TRACK}, 10, false), (${USER}, ${MOVIE}, 9, false)
                  ON CONFLICT (user_id, media_id) DO NOTHING`;
    });
    afterAll(async () => {
        await sql`DELETE FROM user_ratings WHERE user_id = ${USER}`;
        await sql`DELETE FROM users WHERE id = ${USER}`;
        await sql`DELETE FROM media_items WHERE id IN (${TRACK}, ${MOVIE})`;
        // Connection teardown is owned by the harness (once per fork, at exit).
        await closeTestDb();
    });

    it('deletes track ratings but preserves movie ratings', async () => {
        const n = await clearAllTrackRatings(sql, USER);
        expect(n).toBe(1);
        const rows = await sql`SELECT media_id FROM user_ratings WHERE user_id = ${USER}`;
        expect(rows.map((r) => r.media_id)).toEqual([MOVIE]);
    });
});
