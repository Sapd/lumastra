// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Security review 2026-09-23, C3 (`PATCH /api/v1/users/{id}` writes
 * `max_age_rating` with no invalidation/audit) + R1 residual (the documented
 * `null = unpin` contract instead pinned the column to NULL) + the audit
 * INFO (the v1 def writes age/admin with no audit row at all).
 *
 * Drives the REAL production entry point — `resolveAuth()`-independent here
 * (an already-built `Principal` is enough to exercise `mount()`'s scope gate
 * and the handler; the seam files elsewhere in this plan cover resolveAuth()
 * itself) — against a real PostgreSQL database, following the
 * `rotate-v1.c4-demoted-admin-pat.integration.test.ts` pattern in the
 * sibling `admin/secrets/` directory.
 *
 * Isolation for the last-admin cases (fix round 1): `lumastra_review5_tests`
 * is private to this plan, this plan's implementers run strictly
 * sequentially (a shared index / lint-staged rule), and
 * `vitest.integration.config.ts` sets `fileParallelism: false` — so nothing
 * else is concurrently touching this database while this file runs. Each
 * last-admin case disables every OTHER non-disabled user for its duration
 * (`UPDATE users SET disabled_at = now() WHERE disabled_at IS NULL AND id <>
 * $target`) and restores exactly those rows in a `finally`, making
 * `countOtherEffectiveAdmins() === 0` deterministic without a shared-state
 * race.
 *
 * Requires a live PostgreSQL database (lumastra_review5_tests) and a
 * reachable Valkey. Run with:
 *   TEST_DATABASE_URL=postgres://lumastra:lumastra@127.0.0.1:5432/lumastra_review5_tests \
 *     npm run test:integration -- "src/lib/server/api/defs/users/[id].max-age.integration.test.ts"
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { getTestDb } from '../../../../../../tests/integration/setup/test-database.js';
import { toUserId } from '$lib/shared/user-id.js';
import { buildPrincipal } from '$lib/server/api/principal.js';
import { mount } from '$lib/server/api/mount.js';
import { config } from '$lib/server/config.js';
import { createAccessGroup, addMember } from '$lib/server/services/access-control.service.js';
import { def as usersIdDef } from './[id].js';
import { def as adminUsersDef } from '../admin/users/[username]/index.js';

const ADMIN_GROUP = config.ADMIN_GROUPS[0] ?? 'admin';
const createdUsernames = new Set<string>();

async function insertUser(opts: {
    username: string;
    groups?: string[];
    maxAgeRating?: number | null;
    ageRatingPinned?: boolean;
    isAdmin?: boolean;
    adminPinned?: boolean;
}): Promise<string> {
    const sql = getTestDb();
    const [row] = await sql<{ id: string }[]>`
        INSERT INTO users (username, groups, max_age_rating, age_rating_pinned, is_admin, admin_pinned)
        VALUES (
            ${opts.username},
            ${opts.groups ?? []}::text[],
            ${opts.maxAgeRating ?? null},
            ${opts.ageRatingPinned ?? false},
            ${opts.isAdmin ?? false},
            ${opts.adminPinned ?? false}
        )
        RETURNING id
    `;
    createdUsernames.add(opts.username);
    return row.id;
}

async function getUserRow(
    username: string,
): Promise<{ max_age_rating: number | null; age_rating_pinned: boolean }> {
    const sql = getTestDb();
    const [row] = await sql<Array<{ max_age_rating: number | null; age_rating_pinned: boolean }>>`
        SELECT max_age_rating, age_rating_pinned FROM users WHERE username = ${username}
    `;
    return row;
}

async function getAuditRow(
    action: string,
    target: string,
): Promise<{ action: string; target: string; actor: string } | undefined> {
    const sql = getTestDb();
    const [row] = await sql<Array<{ action: string; target: string; actor: string }>>`
        SELECT action, target, actor FROM audit_log
        WHERE action = ${action} AND target = ${target}
        ORDER BY id DESC LIMIT 1
    `;
    return row;
}

async function waitUntil(
    predicate: () => Promise<boolean>,
    { timeoutMs = 5000, intervalMs = 50 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (await predicate()) return;
        if (Date.now() >= deadline) {
            throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
        }
        await new Promise((r) => setTimeout(r, intervalMs));
    }
}

function baseEventFields() {
    return {
        route: { id: null },
        cookies: {
            get: () => undefined,
            getAll: () => [],
            set: () => undefined,
            delete: () => undefined,
            serialize: () => '',
        },
        fetch: async () => new Response(null),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: () => undefined,
    };
}

/** A `users:admin`-scoped operator — enough for every axis except granting admin. */
function operatorPrincipal() {
    return buildPrincipal({
        kind: 'pat',
        userId: toUserId(randomUUID()),
        username: 'operator',
        userGroups: [],
        tokenScopes: ['users:admin'],
        // Owner currently admin, scope fine-grained only: holds the scope
        // but deriveIsAdmin() still says non-admin (no literal 'admin').
        // Since 2026-10-02 a NON-admin owner's admin-class scopes are
        // stripped (stripsAdminScopesForToken() in principal.ts) — no mint
        // path produces that principal anyway.
        ownerIsAdmin: true,
    });
}

async function patchV1(userId: string, body: Record<string, unknown>): Promise<Response> {
    const url = new URL(`http://localhost/api/v1/users/${userId}`);
    const event = {
        ...baseEventFields(),
        request: new Request(url, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        }),
        url,
        params: { id: userId },
        locals: { principal: operatorPrincipal() },
    } as unknown as RequestEvent;
    const { PATCH } = mount(usersIdDef, { surface: 'v1' });
    return PATCH!(event);
}

async function patchAdmin(username: string, body: Record<string, unknown>): Promise<Response> {
    const url = new URL(`http://localhost/api/admin/users/${username}`);
    const event = {
        ...baseEventFields(),
        request: new Request(url, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        }),
        url,
        params: { username },
        locals: { principal: operatorPrincipal() },
    } as unknown as RequestEvent;
    const { PATCH } = mount(adminUsersDef, { surface: 'internal' });
    return PATCH!(event);
}

// Module-scoped so it cleans up after EVERY test in this file, not just the
// first describe block (createdUsernames is shared across both describes).
afterEach(async () => {
    const sql = getTestDb();
    for (const username of createdUsernames) {
        await sql`DELETE FROM audit_log WHERE target = ${username}`;
        await sql`DELETE FROM users WHERE username = ${username}`;
    }
    createdUsernames.clear();
});

describe('PATCH /api/v1/users/{id}: max age rating — C3 + R1 residual + audit gap', () => {
    it('{maxAgeRating:null} is a REAL unpin — the row stays unpinned at the group-derived cap (R1 residual)', async () => {
        const username = `itest_v1_unpin_${randomUUID().slice(0, 8)}`;
        const userId = await insertUser({
            username,
            groups: ['age-12'],
            maxAgeRating: 12,
            ageRatingPinned: false,
        });

        const resp = await patchV1(userId, { maxAgeRating: null });
        expect(resp.status).toBe(200);

        // RED at HEAD: age_rating_pinned=true, max_age_rating=NULL (a pin to
        // NULL, not an unpin) — the documented v1 contract ("null = unpin")
        // was false.
        const row = await getUserRow(username);
        expect(row.age_rating_pinned).toBe(false);
        expect(row.max_age_rating).toBe(12);
    });

    it('{maxAgeRating:6} pins the value and writes an audit row (C3 audit gap)', async () => {
        const username = `itest_v1_setage_${randomUUID().slice(0, 8)}`;
        const userId = await insertUser({
            username,
            groups: ['age-12'],
            maxAgeRating: 12,
            ageRatingPinned: false,
        });

        const resp = await patchV1(userId, { maxAgeRating: 6 });
        expect(resp.status).toBe(200);

        const row = await getUserRow(username);
        expect(row.age_rating_pinned).toBe(true);
        expect(row.max_age_rating).toBe(6);

        // RED at HEAD: the v1 def never called auditLog for any field, so no
        // row is ever written here. auditLog's DB write is fire-and-forget.
        await waitUntil(async () => Boolean(await getAuditRow('user.set_age_rating', username)));
        const audit = await getAuditRow('user.set_age_rating', username);
        expect(audit?.target).toBe(username);
    });

    it('{isAdmin:false} writes an audit row too (C3 audit gap, admin axis)', async () => {
        const username = `itest_v1_setadmin_${randomUUID().slice(0, 8)}`;
        const companionUsername = `itest_v1_companion_${randomUUID().slice(0, 8)}`;
        const userId = await insertUser({
            username,
            isAdmin: true,
            adminPinned: true,
            groups: [ADMIN_GROUP],
        });
        // A standing companion so the (correct, real) last-admin guard does
        // not itself 409 this demotion — see rotate-v1's identical pattern.
        await insertUser({
            username: companionUsername,
            isAdmin: true,
            adminPinned: true,
            groups: [ADMIN_GROUP],
        });

        const resp = await patchV1(userId, { isAdmin: false });
        expect(resp.status).toBe(200);

        await waitUntil(async () => Boolean(await getAuditRow('user.set_admin', username)));
        const audit = await getAuditRow('user.set_admin', username);
        expect(audit?.target).toBe(username);
    });

    // Fix round 1, Important 2: the unpin-age-rating fix re-derives the cap
    // via `buildUserPermissions()` specifically so it honours the CONFIGURED
    // `AGE_RATING_GROUP_PREFIX` — the admin def's original inline unpin
    // branch called `resolveMaxAgeFromGroups()` with no prefix argument,
    // silently defaulting to `'age-'` regardless of what the operator
    // configured. A group name of `'age-...'` can't discriminate the old
    // code from the new one (both would find it); this case configures a
    // NON-default prefix so the two derivations disagree.
    it('unpin re-derives the cap using the CONFIGURED age-group prefix, not the default (fix round 1, Important 2)', async () => {
        const prefixSpy = vi
            .spyOn(config, 'AGE_RATING_GROUP_PREFIX', 'get')
            .mockReturnValue('kids-');
        try {
            const username = `itest_v1_prefix_${randomUUID().slice(0, 8)}`;
            const userId = await insertUser({
                username,
                groups: ['kids-6'],
                maxAgeRating: 18, // stale pinned value
                ageRatingPinned: true,
            });

            const resp = await patchV1(userId, { maxAgeRating: null });
            expect(resp.status).toBe(200);

            const row = await getUserRow(username);
            expect(row.age_rating_pinned).toBe(false);
            expect(row.max_age_rating).toBe(6);
        } finally {
            prefixSpy.mockRestore();
        }
    });
});

// Fix round 1, Important 1: the latent last-admin bug (both defs gated their
// isAdmin-toggle last-admin guard on `target.is_admin` alone, so a user who
// was ONLY an effective admin via an in-app access-group `admin` capability
// could be demoted even as the sole remaining admin) is proven here against
// REAL Postgres, for BOTH defs, instead of only in the mocked unit test.
describe('last-admin guard is in-app-aware (fix round 1, Important 1, real Postgres)', () => {
    const createdGroupIds: string[] = [];

    afterEach(async () => {
        const sql = getTestDb();
        for (const groupId of createdGroupIds) {
            await sql`DELETE FROM access_groups WHERE id = ${groupId}`;
        }
        createdGroupIds.length = 0;
    });

    /** A user whose ONLY admin standing is an in-app access-group `admin` capability. */
    async function makeInAppOnlyAdmin(
        usernamePrefix: string,
    ): Promise<{ userId: string; username: string }> {
        const username = `${usernamePrefix}_${randomUUID().slice(0, 8)}`;
        const userId = await insertUser({
            username,
            isAdmin: false,
            adminPinned: false,
            groups: [],
        });
        const sql = getTestDb();
        const groupResult = await createAccessGroup(sql, {
            name: `itest-admin-grp-${randomUUID().slice(0, 8)}`,
            capabilities: [{ capability: 'admin' }],
        });
        if (!groupResult.ok) {
            throw new Error(`createAccessGroup failed: ${groupResult.message}`);
        }
        createdGroupIds.push(groupResult.data.id);
        await addMember(sql, groupResult.data.id, userId, null);
        return { userId, username };
    }

    /**
     * Isolates `countOtherEffectiveAdmins()` to exactly `targetId`: disables
     * every OTHER currently-enabled user for the duration of `fn`, then
     * restores precisely those rows (never a blanket re-enable) in a
     * `finally`, so a throw inside `fn` (e.g. a failed assertion) still
     * leaves the database as this file found it.
     */
    async function withOnlyEffectiveAdmin<T>(targetId: string, fn: () => Promise<T>): Promise<T> {
        const sql = getTestDb();
        const others = await sql<{ id: string }[]>`
            UPDATE users SET disabled_at = now()
            WHERE disabled_at IS NULL AND id <> ${targetId}::uuid
            RETURNING id
        `;
        try {
            return await fn();
        } finally {
            if (others.length > 0) {
                const ids = others.map((o) => o.id);
                await sql`UPDATE users SET disabled_at = NULL WHERE id = ANY(${ids}::uuid[])`;
            }
        }
    }

    it('v1 def: an in-app-only admin cannot be demoted via {isAdmin:false} when it is the last effective admin', async () => {
        const { userId } = await makeInAppOnlyAdmin('itest_v1_inapp');
        await withOnlyEffectiveAdmin(userId, async () => {
            const resp = await patchV1(userId, { isAdmin: false });
            expect(resp.status).toBe(409);
        });
    });

    it('admin def: an in-app-only admin cannot be demoted via {isAdmin:false} when it is the last effective admin', async () => {
        const { userId, username } = await makeInAppOnlyAdmin('itest_admin_inapp');
        await withOnlyEffectiveAdmin(userId, async () => {
            const resp = await patchAdmin(username, { isAdmin: false });
            expect(resp.status).toBe(409);
        });
    });
});
