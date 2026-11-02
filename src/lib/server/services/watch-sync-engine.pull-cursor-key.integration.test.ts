// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The cursor map handed to a watch-sync plugin must be keyed in the PLUGIN's
 * identity key space, not by the Lumastra user UUID.
 *
 * `watch_state_pull_log` is keyed by `user_id` (the UUID that logPullRun writes),
 * but a plugin looks entries up by its own provider key — the Jellyfin puller does
 * `cursors.get(providerUsername.toLowerCase())`. Delivering a UUID-keyed map meant
 * every lookup missed, `since` came back null, and the plugin took its full-pull
 * branch on EVERY cycle.
 *
 * Measured on prod before the fix: ~166k records re-imported per run (2201 movies +
 * 164160 episodes) every 15 minutes across 35 users — 5,179,127 upserts in 12h to
 * carry 33 rows that had actually changed, and long enough that runs began timing
 * out mid-fetch. The cursor column was written and advanced correctly throughout;
 * only the key space of the delivered map was wrong, so nothing looked broken.
 *
 * This asserts on the map the plugin RECEIVES, which is the seam that failed — a
 * test of the stored cursor value would have passed the whole time.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import type { WatchSyncDefinition, WatchSyncPullResult } from '@sapd/lumastra-plugin-sdk';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../tests/integration/helpers/cleanup.js';
import {
    generateTestUserId,
    ensureTestUser,
} from '../../../../tests/integration/fixtures/index.js';
import { registry } from '../tasks/registry.js';
import { watchSyncEngine } from './watch-sync-engine.service.js';

const SKIP_TESTS = !process.env.TEST_DATABASE_URL && !process.env.DATABASE_URL;

const PROVIDER_ID = 'fake-cursor-key-jellyfin-sync';
// Must contain 'jellyfin' so the engine takes the Jellyfin identity path, whose
// provider key is LOWER(COALESCE(jellyfin_username, username)) — the exact space
// the real Jellyfin puller looks up in.
const PROVIDER_NAME = 'jellyfin';
const CURSOR_ISO = '2026-08-20T12:34:56.000Z';

describe.skipIf(SKIP_TESTS)('WatchSyncEngine pull cursor key space — integration', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await truncateTables(sql, [
            'watch_sync_activity',
            'watch_state_pending_resolution',
            'watch_state_pull_log',
            'user_media_events',
            'user_media_state',
            'user_media_flags',
            'media_items',
            'external_ids',
            'user_profiles',
        ]);
    });

    it('delivers cursors keyed by the provider identity key, not the user UUID', async () => {
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);

        const [{ username }] = await sql<Array<{ username: string }>>`
            SELECT username FROM users WHERE id = ${userId}::uuid
        `;
        const providerKey = username.toLowerCase();

        // A cursor already stored for this user, exactly as logPullRun writes it.
        await sql`
            INSERT INTO watch_state_pull_log (user_id, provider, last_played_cursor)
            VALUES (${userId}::uuid, ${PROVIDER_NAME}, ${CURSOR_ISO}::timestamptz)
        `;

        let received: Map<string, string> | undefined;
        const plugin: WatchSyncDefinition = {
            id: PROVIDER_ID,
            name: 'Fake Cursor Key Sync',
            version: '1.0.0',
            capabilities: { http: true },
            providerName: PROVIDER_NAME,
            isAvailable: async () => true,
            pullWatchState: async (_ctx, opts): Promise<WatchSyncPullResult> => {
                received = opts?.cursors;
                return { items: [], errors: [], newCursors: new Map<string, string>() };
            },
            resolveIds: async () => [],
            pushWatchState: async () => ({
                succeeded: 0,
                failed: 0,
                skipped: 0,
                staleIds: [],
                errors: [],
                successful: [],
                drainedAsSkipped: [],
            }),
        };
        registry.registerWatchSync(plugin);

        await watchSyncEngine.runPull(PROVIDER_ID, undefined, sql);

        expect(received).toBeDefined();
        // The lookup the plugin actually performs.
        expect(received?.get(providerKey)).toBe(CURSOR_ISO);
        // And NOT keyed by the UUID, which is what the table stores.
        expect(received?.get(userId)).toBeUndefined();
    });
});
