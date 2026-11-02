// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { config } from '$lib/server/config.js';
import {
    upsertUser,
    insertFederatedUser,
    createNativeAdmin,
    adminCreateUser,
} from './users.queries.js';
import { upsertUserGroups, setUserPrivacySetting } from './oauth-admin.queries.js';
import { ensureUserExists } from './user-ratings.queries.js';
import { applyActivitySharingDefault } from './activity-sharing.queries.js';
import type { RequestEvent } from '@sveltejs/kit';
import type { ApiContext } from '$lib/server/api/define.js';

const connection = vi.hoisted(() => ({ sql: null as postgres.Sql | null }));
vi.mock('$lib/server/database/connection.js', async (original) => ({
    ...(await original<typeof import('$lib/server/database/connection.js')>()),
    getDb: () => connection.sql,
}));
import { def as privacy } from '$lib/server/api/defs/user/stream-privacy.js';

const rollback = new Error('rollback');
let db: postgres.Sql;
beforeAll(() => {
    db = getTestDb();
});
afterAll(async () => {
    await closeTestDb();
});
afterEach(() => {
    vi.restoreAllMocks();
    connection.sql = null;
});

/** Real production columns/defaults, isolated from all other test users and setup state. */
async function isolated(run: (sql: postgres.TransactionSql) => Promise<void>): Promise<void> {
    await db
        .begin(async (raw) => {
            const sql = raw;
            await sql`CREATE TEMP TABLE users (LIKE public.users INCLUDING ALL) ON COMMIT DROP`;
            await sql`CREATE TEMP TABLE setup_lock (LIKE public.setup_lock INCLUDING ALL) ON COMMIT DROP`;
            connection.sql = sql;
            await run(sql);
            throw rollback;
        })
        .catch((error: unknown) => {
            if (error !== rollback) throw error;
        });
}

async function ownChoice(username: string, body: Record<string, boolean>): Promise<Response> {
    return privacy.handlers.POST!(
        { locals: { principal: { username } } } as unknown as RequestEvent,
        { surface: 'internal', input: { body } } as unknown as ApiContext,
    );
}

const privateValues = {
    hide_streams: true,
    share_listening_activity: false,
    share_audiobook_activity: false,
};
const sharedValues = {
    hide_streams: false,
    share_listening_activity: true,
    share_audiobook_activity: true,
};

describe('activity sharing defaults', () => {
    it.each([undefined, false, true])(
        'uses configured sharing=%s on every account insert without changing existing rows',
        async (configuredSharing) => {
            if (configuredSharing !== undefined) {
                vi.spyOn(config, 'DEFAULT_ACTIVITY_SHARING', 'get').mockReturnValue(
                    configuredSharing,
                );
            }
            // Without an override, the real config defaults ON despite the legacy
            // database column defaults remaining OFF since migration 16.350.0.
            const sharing = configuredSharing ?? true;
            expect(config.DEFAULT_ACTIVITY_SHARING).toBe(sharing);
            await isolated(async (sql) => {
                // Bootstrap goes first, before an admin exists.
                expect(
                    await createNativeAdmin(sql, {
                        username: 'builtin',
                        passwordHash: 'test-hash',
                        groups: [],
                        adminGroupNames: ['admins'],
                    }),
                ).toBeTruthy();
                await adminCreateUser(sql, {
                    username: 'admin-created',
                    passwordHash: 'test-hash',
                    isAdmin: false,
                    groups: [],
                });
                await insertFederatedUser(sql, {
                    username: 'oidc-or-plugin',
                    isAdmin: false,
                    groups: [],
                });
                await upsertUser(sql, { username: 'forward-auth', isAdmin: false });
                await upsertUserGroups(sql, 'group-sync-fallback', []);
                await ensureUserExists(sql, 'rating-fallback');
                const rows = await sql`SELECT * FROM users`;
                expect(rows).toHaveLength(6);
                for (const row of rows)
                    expect(row).toMatchObject({
                        ...(sharing ? sharedValues : privateValues),
                        sharing_explicitly_set_by_user: false,
                        privacy_prefs_updated_at: null,
                    });
                vi.spyOn(config, 'DEFAULT_ACTIVITY_SHARING', 'get').mockReturnValue(!sharing);
                await upsertUser(sql, { username: 'forward-auth', isAdmin: false });
                await upsertUserGroups(sql, 'group-sync-fallback', ['group']);
                await ensureUserExists(sql, 'rating-fallback');
                await insertFederatedUser(sql, {
                    username: 'oidc-or-plugin',
                    isAdmin: false,
                    groups: [],
                });
                await adminCreateUser(sql, {
                    username: 'admin-created',
                    passwordHash: 'changed-hash',
                    isAdmin: false,
                    groups: [],
                });
                for (const row of await sql`SELECT * FROM users`)
                    expect(row).toMatchObject(sharing ? sharedValues : privateValues);
            });
        },
    );

    it.each([false, true])(
        'applies sharing=%s only to never-set users, idempotently',
        async (sharing) => {
            await isolated(async (sql) => {
                await sql`INSERT INTO users (username, hide_streams, share_listening_activity, share_audiobook_activity, sharing_explicitly_set_by_user)
                VALUES ('untouched', ${sharing}, ${!sharing}, ${!sharing}, false),
                       ('explicit-on', false, true, true, true),
                       ('explicit-off', true, false, false, true),
                       ('explicit-mixed', false, false, true, true)`;
                const before =
                    await sql`SELECT * FROM users WHERE username != 'untouched' ORDER BY username`;
                expect(await applyActivitySharingDefault(sql, sharing)).toBe(1);
                expect(await applyActivitySharingDefault(sql, sharing)).toBe(0);
                expect(
                    await sql`SELECT * FROM users WHERE username != 'untouched' ORDER BY username`,
                ).toEqual(before);
                const [row] = await sql`SELECT * FROM users WHERE username = 'untouched'`;
                expect(row).toMatchObject({
                    ...(sharing ? sharedValues : privateValues),
                    sharing_explicitly_set_by_user: false,
                    privacy_prefs_updated_at: null,
                });
                // Admin-applied defaults never become explicit choices: the next default still applies.
                expect(await applyActivitySharingDefault(sql, !sharing)).toBe(1);
            });
        },
    );

    it.each<Record<string, boolean>>([
        { hideFromOthers: true },
        { hideFromOthers: false },
        { shareListeningActivity: false },
        { shareListeningActivity: true },
        { shareAudiobookActivity: false },
        { shareAudiobookActivity: true },
    ])('protects the user choice %j, including reaffirming an unchanged value', async (body) => {
        await isolated(async (sql) => {
            await sql`INSERT INTO users (username) VALUES ('self')`;
            expect((await ownChoice('self', body)).status).toBe(200);
            const [row] = await sql`SELECT * FROM users WHERE username = 'self'`;
            expect(row.sharing_explicitly_set_by_user).toBe(true);
            expect(row.privacy_prefs_updated_at).not.toBeNull();
            expect(await applyActivitySharingDefault(sql, true)).toBe(0);
            expect(await sql`SELECT * FROM users WHERE username = 'self'`).toEqual([row]);
        });
    });

    it.each([false, true])(
        'protects an admin per-user override hide=%s for self and others',
        async (hide) => {
            await isolated(async (sql) => {
                await sql`INSERT INTO users (username) VALUES ('admin-self'), ('admin-target')`;
                await setUserPrivacySetting(sql, 'admin-self', hide);
                await setUserPrivacySetting(sql, 'admin-target', hide);
                const before = await sql`SELECT * FROM users ORDER BY username`;
                for (const row of before) {
                    expect(row.hide_streams).toBe(hide);
                    expect(row.sharing_explicitly_set_by_user).toBe(true);
                    expect(row.privacy_prefs_updated_at).not.toBeNull();
                }
                expect(await applyActivitySharingDefault(sql, true)).toBe(0);
                expect(await applyActivitySharingDefault(sql, false)).toBe(0);
                expect(await sql`SELECT * FROM users ORDER BY username`).toEqual(before);
            });
        },
    );
});
