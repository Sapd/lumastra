// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';
import {
    deleteTraktCredential,
    getTraktLinkStatus,
    updateTraktTokens,
    upsertTraktCredential,
} from './trakt-credentials.queries.js';
import { getTestDatabaseUrl } from '../../../../../tests/integration/setup/test-database.js';

const TEST_DB = getTestDatabaseUrl();
const USER = '00000000-0000-0000-0000-0000000000aa' as UserId;

describe('trakt-credentials.queries (integration)', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = postgres(TEST_DB, { max: 2 });
        // A real user row must exist — plugin_user_credentials.user_id FKs users(id).
        await sql`
            INSERT INTO users (id, username)
            VALUES (${USER}::uuid, 'trakt-itest-user')
            ON CONFLICT (id) DO NOTHING
        `;
    });

    afterAll(async () => {
        await deleteTraktCredential(sql, USER);
        await sql`DELETE FROM users WHERE id = ${USER}::uuid`;
        await sql.end();
    });

    it('returns null when not linked', async () => {
        await deleteTraktCredential(sql, USER);
        expect(await getTraktLinkStatus(sql, USER)).toBeNull();
    });

    it('upserts and reports linked status with provider username', async () => {
        await upsertTraktCredential(sql, {
            userId: USER,
            providerUsername: 'trakt_joe',
            accessToken: 'access-abc',
            refreshToken: 'refresh-xyz',
            tokenExpiresAt: new Date(Date.now() + 3600_000),
        });
        const status = await getTraktLinkStatus(sql, USER);
        expect(status).not.toBeNull();
        expect(status?.providerUsername).toBe('trakt_joe');
        expect(status?.createdAt).toBeInstanceOf(Date);
    });

    it('updateTraktTokens does not resurrect a deleted credential', async () => {
        await deleteTraktCredential(sql, USER);
        await updateTraktTokens(sql, USER, 'new-access', 'new-refresh');
        expect(await getTraktLinkStatus(sql, USER)).toBeNull();
    });

    it('deleteTraktCredential returns true when rows removed, false when none', async () => {
        await upsertTraktCredential(sql, { userId: USER, accessToken: 'a' });
        expect(await deleteTraktCredential(sql, USER)).toBe(true);
        expect(await deleteTraktCredential(sql, USER)).toBe(false);
    });
});

it('retains auth_failed until a successful relink, then clears it atomically', async () => {
    const sql = postgres(TEST_DB, { max: 1 });
    try {
        await sql`INSERT INTO users (id,username) VALUES (${USER}::uuid,'trakt-itest-user') ON CONFLICT DO NOTHING`;
        await upsertTraktCredential(sql, {
            userId: USER,
            providerUsername: 'joe',
            accessToken: 'expired',
        });
        await sql`INSERT INTO plugin_user_credentials (plugin_id,user_id,key,value_encrypted) VALUES ('trakt-watch-sync',${USER}::uuid,'auth_failed',${Buffer.from([0])}) ON CONFLICT (plugin_id,user_id,key) DO NOTHING`;
        expect(await getTraktLinkStatus(sql, USER)).toMatchObject({ authFailed: true });
        await upsertTraktCredential(sql, {
            userId: USER,
            providerUsername: 'joe',
            accessToken: 'new',
        });
        expect(await getTraktLinkStatus(sql, USER)).toMatchObject({ authFailed: false });
    } finally {
        await deleteTraktCredential(sql, USER);
        await sql`DELETE FROM users WHERE id=${USER}::uuid`;
        await sql.end();
    }
});
