// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import postgres from 'postgres';
import {
    getPreference,
    setDirection,
    setWatermark,
    listPreferences,
} from './watch-sync-preferences.queries.js';
import { getTestDatabaseUrl } from '../../../../../tests/integration/setup/test-database.js';

const URL = getTestDatabaseUrl();
let sql: postgres.Sql;
const USER_A = '00000000-0000-0000-0000-0000000000ca';
const USER_B = '00000000-0000-0000-0000-0000000000cb';

beforeAll(async () => {
    sql = postgres(URL);
    await sql`INSERT INTO users (id, username, is_admin) VALUES (${USER_A}, 'wsp-test-a', false) ON CONFLICT (id) DO NOTHING`;
    await sql`INSERT INTO users (id, username, is_admin) VALUES (${USER_B}, 'wsp-test-b', false) ON CONFLICT (id) DO NOTHING`;
});
afterAll(async () => {
    await sql`DELETE FROM watch_sync_preferences WHERE user_id IN (${USER_A}, ${USER_B})`;
    await sql`DELETE FROM users WHERE id IN (${USER_A}, ${USER_B})`;
    await sql.end();
});
beforeEach(async () => {
    await sql`DELETE FROM watch_sync_preferences WHERE user_id IN (${USER_A}, ${USER_B})`;
});

describe('watch-sync-preferences.queries', () => {
    it('returns the default {both, null} when no row exists', async () => {
        const pref = await getPreference(sql, USER_A, 'mal');
        expect(pref).toEqual({ direction: 'both', pushWatermark: null });
    });

    it('setDirection upserts and getPreference reflects it', async () => {
        await setDirection(sql, USER_A, 'mal', 'pull');
        const pref = await getPreference(sql, USER_A, 'mal');
        expect(pref.direction).toBe('pull');
        expect(pref.pushWatermark).toBeNull();
    });

    it('setWatermark upserts and getPreference reflects it', async () => {
        const at = new Date('2026-01-01T00:00:00Z');
        await setWatermark(sql, USER_A, 'trakt', at);
        const pref = await getPreference(sql, USER_A, 'trakt');
        expect(pref.direction).toBe('both'); // fresh row defaults to 'both'
        expect(pref.pushWatermark?.toISOString()).toBe(at.toISOString());
    });

    it('setDirection preserves an existing push_watermark', async () => {
        const at = new Date('2026-02-02T00:00:00Z');
        await setWatermark(sql, USER_A, 'mal', at);
        await setDirection(sql, USER_A, 'mal', 'push');
        const pref = await getPreference(sql, USER_A, 'mal');
        expect(pref.direction).toBe('push');
        expect(pref.pushWatermark?.toISOString()).toBe(at.toISOString());
    });

    it('setWatermark preserves an existing direction', async () => {
        await setDirection(sql, USER_A, 'mal', 'push');
        const at = new Date('2026-03-03T00:00:00Z');
        await setWatermark(sql, USER_A, 'mal', at);
        const pref = await getPreference(sql, USER_A, 'mal');
        expect(pref.direction).toBe('push');
        expect(pref.pushWatermark?.toISOString()).toBe(at.toISOString());
    });

    it('listPreferences maps multiple users for one provider, omitting absent rows', async () => {
        await setDirection(sql, USER_A, 'mal', 'pull');
        await setWatermark(sql, USER_A, 'mal', new Date('2026-04-04T00:00:00Z'));
        await setDirection(sql, USER_B, 'mal', 'push');
        // USER_B also has a 'trakt' row that must NOT show up in the 'mal' map.
        await setDirection(sql, USER_B, 'trakt', 'both');

        const map = await listPreferences(sql, 'mal', [USER_A, USER_B]);
        expect(map.size).toBe(2);
        expect(map.get(USER_A)?.direction).toBe('pull');
        expect(map.get(USER_A)?.pushWatermark?.toISOString()).toBe(
            new Date('2026-04-04T00:00:00Z').toISOString(),
        );
        expect(map.get(USER_B)?.direction).toBe('push');
        expect(map.get(USER_B)?.pushWatermark).toBeNull();
    });

    it('listPreferences omits users with no row for that provider', async () => {
        await setDirection(sql, USER_A, 'mal', 'pull');
        const map = await listPreferences(sql, 'mal', [USER_A, USER_B]);
        expect(map.has(USER_A)).toBe(true);
        expect(map.has(USER_B)).toBe(false);
    });

    it('listPreferences returns an empty Map for an empty userIds array', async () => {
        const map = await listPreferences(sql, 'mal', []);
        expect(map.size).toBe(0);
    });
});
