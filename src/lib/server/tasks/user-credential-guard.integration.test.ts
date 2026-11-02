// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { ensureTestUser } from '../../../../tests/integration/fixtures/index.js';
import { toUserId } from '$lib/shared/user-id.js';
import { PluginSecrets } from './secrets.js';
import { buildUserCredentialStore } from './context-primitives.js';

let sql: postgres.Sql;
beforeAll(() => {
    sql = getTestDb();
});
afterAll(async () => {
    await closeTestDb();
});

it.each(['trakt-watch-sync', 'mal-watch-sync'])(
    '%s: guarded writes do not recreate unlinked credentials',
    async (pluginId) => {
        const userId = toUserId(randomUUID());
        await ensureTestUser(sql, userId);
        const store = buildUserCredentialStore(pluginId, new PluginSecrets(sql));
        try {
            await store.set(userId, 'auth_failed', 'true', { ifKeyExists: 'access_token' });
            expect(await store.listKeys(userId)).toEqual([]);
            await store.set(userId, 'access_token', 'expired');
            await store.set(userId, 'auth_failed', 'true', { ifKeyExists: 'access_token' });
            expect(await store.get(userId, 'auth_failed')).toBe('true');
            await store.delete(userId, 'auth_failed');

            // The unlink transaction already owns the access-token row lock. A
            // guarded writer must wait for it, then observe that the row is gone.
            let write: Promise<void> | undefined;
            await sql.begin(async (tx) => {
                await tx`DELETE FROM plugin_user_credentials WHERE plugin_id = ${pluginId} AND user_id = ${userId}::uuid`;
                write = store.set(userId, 'auth_failed', 'true', { ifKeyExists: 'access_token' });
            });
            await write;
            expect(await store.listKeys(userId)).toEqual([]);
        } finally {
            await sql`DELETE FROM plugin_user_credentials WHERE plugin_id = ${pluginId} AND user_id = ${userId}::uuid`;
        }
    },
);
