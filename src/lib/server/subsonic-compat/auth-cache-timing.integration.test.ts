// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Real SQL lookups with an observable auth cache: repeated incorrect credentials
// must skip the DB for both existing and absent usernames, closing the 60s oracle.
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { getTokenByUsername } from '$lib/server/database/queries/subsonic-client-passwords.queries';
import { validateCredentials, invalidateCacheForUser } from './auth';

const { cache } = vi.hoisted(() => ({ cache: new Map<string, string>() }));
vi.mock('$lib/server/cache/valkey', () => ({
    cacheGet: async (key: string) => cache.get(key) ?? null,
    cacheSet: async (key: string, value: string) => {
        cache.set(key, value);
        return true;
    },
    subscribeToChannel: async () => undefined,
    publishMessage: async () => undefined,
    cacheDel: async (key: string) => (cache.delete(key) ? 1 : 0),
}));

describe('Subsonic unknown-user auth cache timing (integration)', () => {
    let sql: postgres.Sql;
    const username = `subsonic_cache_${randomUUID()}`;
    const absent = `subsonic_absent_${randomUUID()}`;

    beforeAll(async () => {
        sql = getTestDb();
        const [user] = await sql<{ id: string }[]>`
            INSERT INTO users (username, is_admin) VALUES (${username}, false) RETURNING id`;
        await sql`INSERT INTO subsonic_client_passwords (user_id, token)
                  VALUES (${user!.id}, ${'a'.repeat(40)})`;
    });
    beforeEach(() => {
        cache.clear();
    });
    afterAll(async () => {
        vi.restoreAllMocks();
        await sql`DELETE FROM users WHERE username = ${username}`;
        await closeTestDb();
    });

    it.each([{ password: 'b'.repeat(40) }, { token: '0'.repeat(32), salt: 'probe' }])(
        'caches real and absent username lookups equally for %j',
        async (opts) => {
            const lookup = vi.spyOn(getTokenByUsername, 'one');
            for (const name of [username, absent]) {
                lookup.mockClear();
                expect(await validateCredentials(name, opts)).toBeNull();
                expect(await validateCredentials(name, opts)).toBeNull();
                expect(lookup).toHaveBeenCalledTimes(1);
                // Revocation/reset invalidation must remove negative entries too.
                await invalidateCacheForUser(name);
                expect(await validateCredentials(name, opts)).toBeNull();
                expect(lookup).toHaveBeenCalledTimes(2);
            }
            lookup.mockRestore();
        },
    );
});
