// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the admin identity / Jellyfin-mapping service.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { insertIdentityIfAbsent } from '../database/queries/user-identities.queries.js';
import { getJellyfinMapping } from '../database/queries/users.queries.js';
import {
    listUserIdentities,
    setJellyfinOverride,
    unlinkIdentity,
} from './admin-identity.service.js';

const PREFIX = 'test_adminid_';

async function makeUser(sql: postgres.Sql, username: string): Promise<string> {
    const rows = await sql<{ id: string }[]>`
        INSERT INTO users (username, is_admin, updated_at)
        VALUES (${username.toLowerCase()}, false, NOW())
        RETURNING id
    `;
    return rows[0].id;
}

describe('admin-identity.service', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await sql`DELETE FROM user_identities WHERE subject LIKE ${PREFIX + '%'} OR provider = 'oidc:testhash'`;
        await sql`DELETE FROM users WHERE username LIKE ${PREFIX + '%'}`;
    });

    it('lists a user’s identities + jellyfin mapping', async () => {
        const userId = await makeUser(sql, `${PREFIX}u1`);
        await insertIdentityIfAbsent(sql, {
            provider: 'oidc:testhash',
            subject: `${PREFIX}sub1`,
            userId,
            email: 'u1@example.com',
            emailVerified: true,
        });

        const res = await listUserIdentities(sql, `${PREFIX}u1`);
        expect(res.ok).toBe(true);
        if (!res.ok) return;
        expect(res.data.identities).toHaveLength(1);
        expect(res.data.identities[0].isOidc).toBe(true);
        expect(res.data.identities[0].emailVerified).toBe(true);
        expect(res.data.jellyfin.override).toBeNull();
        expect(res.data.jellyfin.effectiveName).toBe(`${PREFIX}u1`);
    });

    it('returns 404 for an unknown user', async () => {
        const res = await listUserIdentities(sql, `${PREFIX}ghost`);
        expect(res.ok).toBe(false);
        if (res.ok) return;
        expect(res.status).toBe(404);
    });

    it('sets and clears the jellyfin override (clearing the cached id)', async () => {
        const userId = await makeUser(sql, `${PREFIX}jf`);
        // Seed a cached id to prove it is cleared when the override changes.
        await sql`UPDATE users SET jellyfin_user_id = 'stale-uuid' WHERE id = ${userId}`;

        const set = await setJellyfinOverride(sql, `${PREFIX}jf`, 'jf_real');
        expect(set.ok).toBe(true);
        let map = await getJellyfinMapping(sql, `${PREFIX}jf`);
        expect(map?.jellyfin_username).toBe('jf_real');
        expect(map?.jellyfin_user_id).toBeNull(); // cache cleared

        const clear = await setJellyfinOverride(sql, `${PREFIX}jf`, null);
        expect(clear.ok).toBe(true);
        map = await getJellyfinMapping(sql, `${PREFIX}jf`);
        expect(map?.jellyfin_username).toBeNull();
    });

    it('unlinks a federated identity', async () => {
        const userId = await makeUser(sql, `${PREFIX}un`);
        // Give the user two identities so the lockout guard (added in
        // fix(admin/users): close authz/edge gaps) does not block the unlink.
        // The guard refuses when removing the identity would leave zero login
        // methods; a second forward_auth row satisfies it.
        await insertIdentityIfAbsent(sql, {
            provider: 'oidc:testhash',
            subject: `${PREFIX}subun`,
            userId,
        });
        await insertIdentityIfAbsent(sql, {
            provider: 'forward_auth',
            subject: `${PREFIX}un`,
            userId,
        });
        const res = await unlinkIdentity(sql, `${PREFIX}un`, 'oidc:testhash', `${PREFIX}subun`);
        expect(res.ok).toBe(true);
        if (!res.ok) return;
        expect(res.data.unlinked).toBe(true);

        const after = await listUserIdentities(sql, `${PREFIX}un`);
        expect(after.ok).toBe(true);
        if (!after.ok) return;
        // Only the forward_auth identity remains.
        expect(after.data.identities).toHaveLength(1);
        expect(after.data.identities[0].provider).toBe('forward_auth');
    });

    it('refuses to unlink the last identity (lockout guard)', async () => {
        const userId = await makeUser(sql, `${PREFIX}un`);
        await insertIdentityIfAbsent(sql, {
            provider: 'oidc:testhash',
            subject: `${PREFIX}subun`,
            userId,
        });
        // Single identity, no native password → guard must fire.
        const res = await unlinkIdentity(sql, `${PREFIX}un`, 'oidc:testhash', `${PREFIX}subun`);
        expect(res.ok).toBe(false);
        if (res.ok) return;
        expect(res.status).toBe(409);
    });
});
