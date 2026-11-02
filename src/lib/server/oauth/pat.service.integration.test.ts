// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for PAT Service — scope filter, lastUsedIp projection,
 * user-status check, and DB-error policy.
 *
 * Requires a live PostgreSQL database (lumastra_tests).
 * Run with: npm run test:integration src/lib/server/oauth/pat.service.integration.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getPatService } from './pat.service.js';
import { toUserId } from '$lib/shared/user-id.js';
import { getTestDb } from '../../../../tests/integration/setup/test-database.js';
import {
    ensureTestUser,
} from '../../../../tests/integration/fixtures/user.fixtures.js';

// Unique test user UUID per run (mig 16.46.0 — personal_access_tokens.user_id is now uuid).
// The human-readable handle is derived by ensureTestUser. Branded UserId since
// PatService now requires the stable users.id UUID (not a username).
const testUser = toUserId(randomUUID());

const svc = getPatService();

async function cleanupTestUser(): Promise<void> {
    await svc.revokeAllForUser(testUser);
    const sql = getTestDb();
    // users.id is the UUID; clean up by id, not username.
    await sql`DELETE FROM users WHERE id = ${testUser}::uuid`;
}

beforeEach(async () => {
    await cleanupTestUser();
    // Seed the users row required by the personal_access_tokens FK
    const sql = getTestDb();
    await ensureTestUser(sql, testUser);
});

afterEach(async () => {
    await cleanupTestUser();
});

describe('listForUser scope filter', () => {
    it('filters PATs by scope using exact-array-equality', async () => {
        await svc.create({
            userId: testUser,
            name: 'jf token',
            scopes: ['jellyfin_compat'],
            groups: [],
        });
        await svc.create({
            userId: testUser,
            name: 'read token',
            scopes: ['read'],
            groups: [],
        });

        const filtered = await svc.listForUser(testUser, {
            scopes: ['jellyfin_compat'],
        });
        expect(filtered).toHaveLength(1);
        expect(filtered[0].name).toBe('jf token');
        expect(filtered[0].scopes).toEqual(['jellyfin_compat']);
    });

    it('returns all PATs when no scope filter provided', async () => {
        await svc.create({
            userId: testUser,
            name: 'token-a',
            scopes: ['read'],
            groups: [],
        });
        await svc.create({
            userId: testUser,
            name: 'token-b',
            scopes: ['write'],
            groups: [],
        });

        const all = await svc.listForUser(testUser);
        expect(all.length).toBe(2);
    });

    it('returns empty when no PATs match the scope filter', async () => {
        await svc.create({
            userId: testUser,
            name: 'read token',
            scopes: ['read'],
            groups: [],
        });

        const filtered = await svc.listForUser(testUser, {
            scopes: ['jellyfin_compat'],
        });
        expect(filtered).toHaveLength(0);
    });

    it('projects lastUsedIp', async () => {
        const { token } = await svc.create({
            userId: testUser,
            name: 'token-for-ip-test',
            scopes: ['read'],
            groups: [],
        });
        await svc.validate(token, '203.0.113.1');

        const tokens = await svc.listForUser(testUser);
        const t = tokens.find((p) => p.name === 'token-for-ip-test');
        expect(t).toBeDefined();
        expect(t!.lastUsedIp).toBe('203.0.113.1');
    });

    it('lastUsedIp is null for unused token', async () => {
        await svc.create({
            userId: testUser,
            name: 'unused-token',
            scopes: ['read'],
            groups: [],
        });

        const tokens = await svc.listForUser(testUser);
        const t = tokens.find((p) => p.name === 'unused-token');
        expect(t).toBeDefined();
        expect(t!.lastUsedIp).toBeNull();
    });
});

describe('listAll consolidated options', () => {
    it('accepts userId in options', async () => {
        await svc.create({
            userId: testUser,
            name: 'admin-filter-test',
            scopes: ['read'],
            groups: [],
        });

        const result = await svc.listAll({ userId: testUser });
        expect(result.length).toBeGreaterThanOrEqual(1);
        // listAll projects the owner's display handle as `username` (no raw
        // user_id in the result), so ownership is checked against the handle.
        expect(result.every((p) => p.owner.userId === testUser)).toBe(true);
    });

    it('filters by scope via listAll', async () => {
        await svc.create({
            userId: testUser,
            name: 'jf-admin-token',
            scopes: ['jellyfin_compat'],
            groups: [],
        });
        await svc.create({
            userId: testUser,
            name: 'read-admin-token',
            scopes: ['read'],
            groups: [],
        });

        const filtered = await svc.listAll({
            userId: testUser,
            scopes: ['jellyfin_compat'],
        });
        expect(filtered).toHaveLength(1);
        expect(
            filtered.every((p) => p.scopes.length === 1 && p.scopes[0] === 'jellyfin_compat'),
        ).toBe(true);
    });

    it('projects lastUsedIp in listAll', async () => {
        const { token } = await svc.create({
            userId: testUser,
            name: 'admin-ip-test',
            scopes: ['read'],
            groups: [],
        });
        await svc.validate(token, '198.51.100.42');

        const result = await svc.listAll({ userId: testUser });
        const t = result.find((p) => p.name === 'admin-ip-test');
        expect(t).toBeDefined();
        expect(t!.lastUsedIp).toBe('198.51.100.42');
    });

    it('returns all active PATs when called with no options', async () => {
        await svc.create({
            userId: testUser,
            name: 'no-options-test',
            scopes: ['read'],
            groups: [],
        });

        const result = await svc.listAll();
        // listAll returns the owner's display handle as `username`, not the UUID.
        const testTokens = result.filter((p) => p.owner.userId === testUser);
        expect(testTokens.length).toBeGreaterThanOrEqual(1);
    });
});

describe('validateToken — user status', () => {
    it('rejects PAT for missing user (no row in users table)', async () => {
        // ghostUser is a UUID (mig 16.46.0 — users.id is uuid).
        const ghostUser = toUserId(randomUUID());
        const sql = getTestDb();
        // Seed user + PAT, then delete the user (CASCADE removes the PAT too),
        // so validate sees neither a valid user nor a valid token → null.
        await ensureTestUser(sql, ghostUser);
        const { token } = await svc.create({
            userId: ghostUser,
            name: 'ghost-token',
            scopes: ['read'],
            groups: [],
        });
        try {
            await sql`DELETE FROM users WHERE id = ${ghostUser}::uuid`;
            const result = await svc.validate(token, '127.0.0.1');
            expect(result).toBeNull();
        } finally {
            // Cleanup in case DELETE failed or token somehow survived
            await sql`DELETE FROM users WHERE id = ${ghostUser}::uuid`;
        }
    });

    it('rejects PAT when user is soft-deleted', async () => {
        const sql = getTestDb();
        // Ensure testUser row exists (testUser is a UUID since mig 16.46.0)
        await ensureTestUser(sql, testUser);
        const { token } = await svc.create({
            userId: testUser,
            name: 'deleted-user-token',
            scopes: ['read'],
            groups: [],
        });
        // Soft-delete the user (update by id, not username)
        await sql`UPDATE users SET deleted_at = NOW() WHERE id = ${testUser}::uuid`;
        try {
            const result = await svc.validate(token, '127.0.0.1');
            expect(result).toBeNull();
        } finally {
            await sql`UPDATE users SET deleted_at = NULL WHERE id = ${testUser}::uuid`;
        }
    });

    it('rejects PAT when user is disabled', async () => {
        const sql = getTestDb();
        // Ensure testUser row exists (testUser is a UUID since mig 16.46.0)
        await ensureTestUser(sql, testUser);
        const { token } = await svc.create({
            userId: testUser,
            name: 'disabled-user-token',
            scopes: ['read'],
            groups: [],
        });
        // Disable the user (admin kill-switch — security review 2026-09-13, C2)
        await sql`UPDATE users SET disabled_at = NOW() WHERE id = ${testUser}::uuid`;
        try {
            const result = await svc.validate(token, '127.0.0.1');
            expect(result).toBeNull();
        } finally {
            await sql`UPDATE users SET disabled_at = NULL WHERE id = ${testUser}::uuid`;
        }
    });

    it('succeeds for an active user', async () => {
        const sql = getTestDb();
        // Ensure testUser row exists (testUser is a UUID since mig 16.46.0)
        await ensureTestUser(sql, testUser);
        const { token } = await svc.create({
            userId: testUser,
            name: 'active-user-token',
            scopes: ['read'],
            groups: [],
        });
        const result = await svc.validate(token, '127.0.0.1');
        expect(result).not.toBeNull();
        // result.username is the users.username field (derivedUsername); the resolved
        // human-readable handle is returned, not the UUID itself.
        expect(result?.username).toBeTruthy();
    });
});

describe('validate — expiry on the cache-hit path', () => {
    it('rejects a cached PAT once its expires_at has passed', async () => {
        const sql = getTestDb();
        const { token } = await svc.create({
            userId: testUser,
            name: 'short-lived',
            scopes: ['read'],
            groups: [],
        });
        await sql`
            UPDATE personal_access_tokens
            SET expires_at = NOW() + INTERVAL '1500 milliseconds'
            WHERE user_id = ${testUser}::uuid AND name = 'short-lived'
        `;

        // First validate is a cache miss and caches the row.
        expect(await svc.validate(token, '127.0.0.1')).not.toBeNull();
        await new Promise((r) => setTimeout(r, 2000));
        // Second validate would be a cache hit if the entry outlived the token.
        expect(await svc.validate(token, '127.0.0.1')).toBeNull();
    });
});

describe('revoke is scoped to the owning user', () => {
    const otherUser = toUserId(randomUUID());

    beforeEach(async () => {
        await ensureTestUser(getTestDb(), otherUser);
    });

    afterEach(async () => {
        await svc.revokeAllForUser(otherUser);
        await getTestDb()`DELETE FROM users WHERE id = ${otherUser}::uuid`;
    });

    it("does not revoke another user's token id and leaves it active", async () => {
        const { token, id } = await svc.create({
            userId: testUser,
            name: 'victim',
            scopes: ['read'],
            groups: [],
        });

        expect(await svc.revoke(id, otherUser)).toBe(false);

        const rows = await getTestDb()<
            { revoked_at: Date | null }[]
        >`SELECT revoked_at FROM personal_access_tokens WHERE id = ${id}`;
        expect(rows[0].revoked_at).toBeNull();
        expect(await svc.validate(token, '127.0.0.1')).not.toBeNull();
        expect((await svc.listForUser(testUser)).map((t) => t.id)).toContain(id);
    });

    it('revokes the token for its owner', async () => {
        const { token, id } = await svc.create({
            userId: testUser,
            name: 'mine',
            scopes: ['read'],
            groups: [],
        });
        expect(await svc.revoke(id, testUser)).toBe(true);
        expect(await svc.validate(token, '127.0.0.1')).toBeNull();
        // Second revoke finds nothing active for this owner.
        expect(await svc.revoke(id, testUser)).toBe(false);
    });
});
