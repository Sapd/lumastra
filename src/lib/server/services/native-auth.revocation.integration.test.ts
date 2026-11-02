// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { getTestDatabaseUrl } from '../../../../tests/integration/setup/test-database.js';

// Every real service shares this single-connection pool, as a web deployment
// with LUMASTRA_DB_POOL_WEB_MAX=1 does. No revocation service/query is mocked.
vi.mock('../database/connection.js', () => ({
    Database: class {
        getSql() {
            return sql;
        }
    },
    getDb: () => sql,
}));
vi.mock('$lib/server/middleware/forward-auth.js', () => ({ invalidateAdminExistsCache: vi.fn() }));
vi.mock('$lib/server/services/user-identity.service.js', () => ({
    recordIdentityBestEffort: vi.fn(),
    PROVIDER_NATIVE: 'native',
    PROVIDER_FORWARD_AUTH: 'forward-auth',
}));
// Core-only deployment: the /j implementation is tested in its own licensed tree.
vi.mock('$lib/server/licensing/entitlements.js', () => ({ ensureProprietaryLoaded: vi.fn() }));
import { connectValkey, disconnectValkey } from '$lib/server/cache/valkey.js';
import { hashPassword, verifyPassword } from '../crypto/password.js';
import { resetPassword } from './admin-user.service.js';
import { attemptLogin, changeOwnPassword } from './native-auth.service.js';
import { getSessionService } from './session.service.js';

let sql: postgres.Sql;
const ids: string[] = [];
const OLD = 'Old!Passphrase-for-fanout-2026';
const NEW = 'New!Passphrase-for-fanout-2026';

beforeAll(async () => {
    sql = postgres(getTestDatabaseUrl(), {
        max: 1,
        connection: { idle_in_transaction_session_timeout: 4000 },
    });
    expect(await connectValkey()).toBe(true);
});
afterAll(async () => {
    await sql`DELETE FROM hls_playback_tokens WHERE user_id IN ${sql(ids)}`;
    await sql`DELETE FROM service_tokens WHERE act_as_user IN ${sql(ids)}`;
    await sql`DELETE FROM users WHERE id IN ${sql(ids)}`;
    await sql.end();
    await disconnectValkey();
});

it.each(['admin reset', 'own change'])(
    '%s completes the real credential fan-out with one connection',
    async (mode) => {
        const username = `fanout_${randomUUID()}`;
        const hash = await hashPassword(OLD);
        const [user] = await sql<
            { id: string }[]
        >`INSERT INTO users (username, password_hash) VALUES (${username}, ${hash}) RETURNING id`;
        const id = user.id;
        ids.push(id);
        const sid = randomUUID();
        const patHash = createHash('sha256').update(randomUUID()).digest('hex');
        await sql`INSERT INTO oauth_refresh_tokens (token_hash, user_id, client_id, expires_at, device_session_id)
        VALUES (${randomUUID()}, ${id}, 'fanout-test', NOW() + INTERVAL '1 day', ${sid})`;
        await sql`INSERT INTO personal_access_tokens (token_hash, token_prefix, user_id, name, scopes, user_groups)
        VALUES (${patHash}, 'pat_test', ${id}, 'fanout-test', ARRAY['read'], ARRAY[]::text[])`;
        await sql`INSERT INTO service_tokens (token_hash, token_prefix, name, created_by, owner_user_id, act_as_user, scopes)
        VALUES (${randomUUID()}, 'svc_test', 'fanout-test', ${username}, ${id}, ${id}, ARRAY['read'])`;
        await sql`INSERT INTO subsonic_client_passwords (user_id, token) VALUES (${id}, ${randomUUID()})`;
        await sql`INSERT INTO user_provider_device_tokens (user_id, provider_user_id, device_session_id, provider_device_binding, provider_access_token)
        VALUES (${id}, 'provider-user', ${sid}, 'fanout-test', 'test-token')`;
        // Exercise both the OAuth and PAT stream cascades while the pool is pinned.
        await sql`INSERT INTO hls_playback_tokens (token_hash, username, user_id, client_ip, expires_at, device_session_id)
        VALUES (${randomUUID()}, ${username}, ${id}, '127.0.0.1', NOW() + INTERVAL '1 hour', ${sid})`;
        await sql`INSERT INTO hls_playback_tokens (token_hash, username, user_id, client_ip, expires_at, parent_token_hash)
        VALUES (${randomUUID()}, ${username}, ${id}, '127.0.0.1', NOW() + INTERVAL '1 hour', ${patHash})`;
        const oldSession = await attemptLogin(sql, { username, password: OLD });
        expect(oldSession).not.toBeNull();
        const result =
            mode === 'admin reset'
                ? await resetPassword(sql, { targetUsername: username, newPassword: NEW })
                : await changeOwnPassword(sql, {
                      username,
                      currentPassword: OLD,
                      newPassword: NEW,
                  });
        expect(result.ok).toBe(true);
        expect(await getSessionService().validate(oldSession!.token)).toBeNull();
        const [password] = await sql<
            { password_hash: string }[]
        >`SELECT password_hash FROM users WHERE id = ${id}`;
        expect(await verifyPassword(NEW, password.password_hash)).toBe(true);
        expect(await attemptLogin(sql, { username, password: NEW })).not.toBeNull();
        const [live] = await sql<
            {
                refresh: number;
                pat: number;
                service: number;
                subsonic: number;
                provider: number;
                streams: number;
            }[]
        >`
        SELECT
            (SELECT COUNT(*)::int FROM oauth_refresh_tokens WHERE user_id = ${id} AND revoked_at IS NULL) AS refresh,
            (SELECT COUNT(*)::int FROM personal_access_tokens WHERE user_id = ${id} AND revoked_at IS NULL) AS pat,
            (SELECT COUNT(*)::int FROM service_tokens WHERE act_as_user = ${id} AND revoked_at IS NULL) AS service,
            (SELECT COUNT(*)::int FROM subsonic_client_passwords WHERE user_id = ${id}) AS subsonic,
            (SELECT COUNT(*)::int FROM user_provider_device_tokens WHERE user_id = ${id} AND revoked_at IS NULL) AS provider,
            (SELECT COUNT(*)::int FROM hls_playback_tokens WHERE user_id = ${id} AND is_active) AS streams
    `;
        expect(live).toEqual({
            refresh: 0,
            pat: 0,
            service: 0,
            subsonic: 0,
            provider: 0,
            streams: 0,
        });
    },
    15000,
);
