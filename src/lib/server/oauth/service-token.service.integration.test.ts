// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for `ServiceTokenService.revokeAllImpersonating` (security
 * review 2026-09-13, C2): a service token configured to impersonate a user
 * must stop working once that user is disabled/reset/deleted — the fan-out in
 * `credential-revocation.service.ts` calls this to revoke every token
 * impersonating the target.
 *
 * Requires a live PostgreSQL database (lumastra_tests).
 * Run with: npm run test:integration src/lib/server/oauth/service-token.service.integration.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getServiceTokenService, MintingTokenRevokedError } from './service-token.service.js';
import { toUserId } from '$lib/shared/user-id.js';
import { getTestDb } from '../../../../tests/integration/setup/test-database.js';
import { ensureTestUser } from '../../../../tests/integration/fixtures/user.fixtures.js';

const svc = getServiceTokenService();

const impersonatedUser = toUserId(randomUUID());
const otherImpersonatedUser = toUserId(randomUUID());

// validate() denies any token whose owner (service_tokens.owner_user_id, which
// create() fills from the created_by username here) is missing, disabled or
// deleted. The creator must therefore be a real, active user row — without it every
// token validates to null, the "survives" assertions fail and the "revoked"
// ones pass vacuously.
const creatorId = toUserId(randomUUID());
const creator = `svc-token-admin-${creatorId.slice(0, 8)}`;

async function cleanup(): Promise<void> {
    const sql = getTestDb();
    await sql`DELETE FROM service_tokens WHERE created_by = ${creator}`;
    await sql`DELETE FROM service_tokens WHERE act_as_user = ${impersonatedUser}::uuid`;
    await sql`DELETE FROM service_tokens WHERE act_as_user = ${otherImpersonatedUser}::uuid`;
    await sql`DELETE FROM users WHERE id = ${impersonatedUser}::uuid`;
    await sql`DELETE FROM users WHERE id = ${otherImpersonatedUser}::uuid`;
    await sql`DELETE FROM users WHERE id = ${creatorId}::uuid`;
}

beforeEach(async () => {
    await cleanup();
    const sql = getTestDb();
    await ensureTestUser(sql, impersonatedUser);
    await ensureTestUser(sql, otherImpersonatedUser);
    await sql`INSERT INTO users (id, username) VALUES (${creatorId}::uuid, ${creator})`;
});

afterEach(async () => {
    await cleanup();
});

describe('revokeAllImpersonating', () => {
    it('revokes every active token impersonating the target user', async () => {
        const { token: token1 } = await svc.create({
            name: 'grafana',
            createdBy: creator,
            actAsUser: impersonatedUser,
            scopes: ['read'],
        });
        const { token: token2 } = await svc.create({
            name: 'uptime-kuma',
            createdBy: creator,
            actAsUser: impersonatedUser,
            scopes: ['read'],
        });

        // Baseline: both tokens are live before revocation, so the nulls
        // below can only come from revokeAllImpersonating.
        expect(await svc.validate(token1)).not.toBeNull();
        expect(await svc.validate(token2)).not.toBeNull();

        const count = await svc.revokeAllImpersonating(impersonatedUser);
        expect(count).toBe(2);

        expect(await svc.validate(token1)).toBeNull();
        expect(await svc.validate(token2)).toBeNull();
    });

    it('does not touch tokens impersonating a DIFFERENT user', async () => {
        const { token: mine } = await svc.create({
            name: 'grafana',
            createdBy: creator,
            actAsUser: impersonatedUser,
            scopes: ['read'],
        });
        const { token: other } = await svc.create({
            name: 'other-app',
            createdBy: creator,
            actAsUser: otherImpersonatedUser,
            scopes: ['read'],
        });

        expect(await svc.validate(mine)).not.toBeNull();

        await svc.revokeAllImpersonating(impersonatedUser);

        expect(await svc.validate(mine)).toBeNull();
        expect(await svc.validate(other)).not.toBeNull();

        // cleanup the surviving token explicitly (not covered by act_as_user
        // scoping in the shared `cleanup()` DELETE, which IS scoped to it —
        // this call is redundant but explicit/defensive).
        await svc.revokeAllImpersonating(otherImpersonatedUser);
    });

    it('does not touch a non-impersonating (admin) token created by the same admin', async () => {
        const { token: impersonating } = await svc.create({
            name: 'grafana',
            createdBy: creator,
            actAsUser: impersonatedUser,
            scopes: ['read'],
        });
        const { token: adminToken } = await svc.create({
            name: 'admin-console',
            createdBy: creator,
            scopes: ['admin'],
        });

        expect(await svc.validate(impersonating)).not.toBeNull();

        await svc.revokeAllImpersonating(impersonatedUser);

        expect(await svc.validate(impersonating)).toBeNull();
        expect(await svc.validate(adminToken)).not.toBeNull();
        // The admin token has no act_as_user; cleanup() removes it by created_by.
    });

    it('returns 0 when the user has no impersonating tokens', async () => {
        const count = await svc.revokeAllImpersonating(impersonatedUser);
        expect(count).toBe(0);
    });
});

describe('validate — expiry on the cache-hit path', () => {
    it('rejects a cached service token once its expires_at has passed', async () => {
        const sql = getTestDb();
        const { token } = await svc.create({
            name: 'short-lived',
            createdBy: creator,
            scopes: ['read'],
        });
        await sql`
            UPDATE service_tokens
            SET expires_at = NOW() + INTERVAL '1500 milliseconds'
            WHERE created_by = ${creator} AND name = 'short-lived'
        `;

        expect(await svc.validate(token)).not.toBeNull();
        await new Promise((r) => setTimeout(r, 2000));
        expect(await svc.validate(token)).toBeNull();
    });
});

describe('owner_user_id of a token minted through another token', () => {
    it('falls back to the created_by user when the minter has no owner', async () => {
        const sql = getTestDb();
        const minter = await svc.create({
            name: 'ownerless-minter',
            createdBy: creator,
            ownerUserId: null,
            scopes: ['admin'],
        });
        const child = await svc.create({
            name: 'owner-from-created-by',
            createdBy: creator,
            createdViaTokenId: minter.id,
            scopes: ['read'],
        });
        const rows = await sql<{ owner_user_id: string | null }[]>`
            SELECT owner_user_id FROM service_tokens WHERE id = ${child.id}
        `;
        expect(rows[0].owner_user_id).toBe(creatorId);
    });
});

describe('revoke — cascades to tokens minted through the revoked token', () => {
    it('revokes children and grandchildren (created_via_token_id), leaves siblings alone', async () => {
        const minter = await svc.create({ name: 'minter', createdBy: creator, scopes: ['admin'] });
        const child = await svc.create({
            name: 'child',
            createdBy: creator,
            createdViaTokenId: minter.id,
            scopes: ['read'],
        });
        const grandchild = await svc.create({
            name: 'grandchild',
            createdBy: creator,
            createdViaTokenId: child.id,
            scopes: ['read'],
        });
        const sibling = await svc.create({ name: 'sibling', createdBy: creator, scopes: ['read'] });

        expect(await svc.validate(child.token)).not.toBeNull();
        expect(await svc.validate(grandchild.token)).not.toBeNull();

        expect(await svc.revoke(minter.id)).toBe(true);

        expect(await svc.validate(minter.token)).toBeNull();
        expect(await svc.validate(child.token)).toBeNull();
        expect(await svc.validate(grandchild.token)).toBeNull();
        expect(await svc.validate(sibling.token)).not.toBeNull();
    });

    const revokedAt = async (id: number): Promise<Date | null> => {
        const [row] = await getTestDb()<{ revoked_at: Date | null }[]>`
            SELECT revoked_at FROM service_tokens WHERE id = ${id}
        `;
        return row.revoked_at;
    };

    it("walks through an already-revoked child to a live grandchild and keeps the child's revoked_at", async () => {
        const sql = getTestDb();
        const minter = await svc.create({ name: 'minter', createdBy: creator, scopes: ['admin'] });
        const child = await svc.create({
            name: 'child',
            createdBy: creator,
            createdViaTokenId: minter.id,
            scopes: ['read'],
        });
        const grandchild = await svc.create({
            name: 'grandchild',
            createdBy: creator,
            createdViaTokenId: child.id,
            scopes: ['read'],
        });
        await sql`UPDATE service_tokens SET revoked_at = '2026-01-01T00:00:00Z' WHERE id = ${child.id}`;

        await svc.revoke(minter.id);

        expect(await revokedAt(grandchild.id)).not.toBeNull();
        expect((await revokedAt(child.id))?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    });

    it('terminates on a created_via_token_id cycle', async () => {
        const sql = getTestDb();
        const a = await svc.create({ name: 'a', createdBy: creator, scopes: ['read'] });
        const b = await svc.create({
            name: 'b',
            createdBy: creator,
            createdViaTokenId: a.id,
            scopes: ['read'],
        });
        await sql`UPDATE service_tokens SET created_via_token_id = ${b.id} WHERE id = ${a.id}`;

        expect(await svc.revoke(a.id)).toBe(true);
        expect(await revokedAt(b.id)).not.toBeNull();
    });

    it('repairs a half-done revoke: a retry on an already-revoked root still revokes its children', async () => {
        const sql = getTestDb();
        const minter = await svc.create({ name: 'minter', createdBy: creator, scopes: ['admin'] });
        const child = await svc.create({
            name: 'child',
            createdBy: creator,
            createdViaTokenId: minter.id,
            scopes: ['read'],
        });
        // As if the process died after revoking the root alone.
        await sql`UPDATE service_tokens SET revoked_at = NOW() WHERE id = ${minter.id}`;

        expect(await svc.revoke(minter.id)).toBe(false);
        expect(await svc.validate(child.token)).toBeNull();
    });

    it('refuses to mint through a token that is already revoked', async () => {
        const minter = await svc.create({ name: 'minter', createdBy: creator, scopes: ['admin'] });
        await svc.revoke(minter.id);

        await expect(
            svc.create({
                name: 'late-child',
                createdBy: creator,
                createdViaTokenId: minter.id,
                scopes: ['read'],
            }),
        ).rejects.toBeInstanceOf(MintingTokenRevokedError);
    });

    it('cascades from impersonating tokens revoked when their user is cut off', async () => {
        const parent = await svc.create({
            name: 'impersonating-minter',
            createdBy: creator,
            actAsUser: impersonatedUser,
            scopes: ['read'],
        });
        // A child minted through it that impersonates nobody.
        const child = await svc.create({
            name: 'child',
            createdBy: creator,
            createdViaTokenId: parent.id,
            scopes: ['read'],
        });

        expect(await svc.revokeAllImpersonating(impersonatedUser)).toBe(1);
        expect(await revokedAt(child.id)).not.toBeNull();
    });
});

// API package 15: the owner is `owner_user_id`; `created_by` is an audit label.
describe('validate(): owner by id', () => {
    const impostorId = toUserId(randomUUID());

    afterEach(async () => {
        await getTestDb()`DELETE FROM users WHERE id = ${impostorId}::uuid`;
    });

    it("keeps a renamed owner's token working; a disabled user taking the old name changes nothing", async () => {
        const sql = getTestDb();
        const { token } = await svc.create({
            name: 'renamed',
            createdBy: creator,
            scopes: ['read'],
        });
        const renamed = `${creator}-renamed`;
        await sql`UPDATE users SET username = ${renamed} WHERE id = ${creatorId}::uuid`;
        await sql`
            INSERT INTO users (id, username, disabled_at)
            VALUES (${impostorId}::uuid, ${creator}, NOW())
        `;

        const validated = await svc.validate(token);
        expect(validated?.ownerUserId).toBe(creatorId);
        expect(validated?.createdBy).toBe(creator);
    });

    it('a new active user taking the old name does not revive the token of a disabled owner', async () => {
        const sql = getTestDb();
        const { token } = await svc.create({
            name: 'disabled',
            createdBy: creator,
            scopes: ['read'],
        });
        const renamed = `${creator}-gone`;
        await sql`
            UPDATE users SET username = ${renamed}, disabled_at = NOW()
            WHERE id = ${creatorId}::uuid
        `;
        await sql`INSERT INTO users (id, username) VALUES (${impostorId}::uuid, ${creator})`;

        expect(await svc.validate(token)).toBeNull();
    });

    it('rejects a token whose owner_user_id is NULL', async () => {
        const sql = getTestDb();
        const { token, id } = await svc.create({
            name: 'orphan',
            createdBy: creator,
            scopes: ['read'],
        });
        await sql`UPDATE service_tokens SET owner_user_id = NULL WHERE id = ${id}`;
        expect(await svc.validate(token)).toBeNull();
    });

    it('demotion narrowing follows the owner id, not the username', async () => {
        const sql = getTestDb();
        const { id } = await svc.create({
            name: 'narrowing',
            createdBy: creator,
            scopes: ['admin'],
        });
        const renamed = `${creator}-renamed`;
        await sql`UPDATE users SET username = ${renamed} WHERE id = ${creatorId}::uuid`;
        await sql`INSERT INTO users (id, username) VALUES (${impostorId}::uuid, ${creator})`;
        const state = async () =>
            (
                await sql<{ force_non_admin: boolean; narrowed: boolean }[]>`
                    SELECT force_non_admin,
                           force_non_admin_narrowed_at IS NOT NULL AS narrowed
                    FROM service_tokens WHERE id = ${id}
                `
            )[0];

        // A new user who took the old username is demoted: the token is not theirs.
        await svc.markAdminScopedForceNonAdminImpersonating(impostorId, creator);
        expect(await state()).toEqual({ force_non_admin: false, narrowed: false });

        // The renamed owner is demoted: narrowed.
        await svc.markAdminScopedForceNonAdminImpersonating(creatorId, renamed);
        expect(await state()).toEqual({ force_non_admin: true, narrowed: true });

        // Re-promoting the impostor restores nothing; re-promoting the owner does.
        expect(await svc.clearForceNonAdminForUserAndCreator(impostorId, creator)).toBe(0);
        expect(await state()).toEqual({ force_non_admin: true, narrowed: true });
        expect(await svc.clearForceNonAdminForUserAndCreator(creatorId, renamed)).toBe(1);
        expect(await state()).toEqual({ force_non_admin: false, narrowed: false });
    });
});
