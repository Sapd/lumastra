// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Security review 6, P2 — real-PG seam tests for `POST /api/oauth/authorize`'s
 * `users.groups` write.
 *
 * HEAD wrote `user.userGroups` — the MERGED set (IdP header groups union
 * in-app group names, `forward-auth.ts:2343`/`native-session.ts:81-84`) —
 * into `users.groups` for every auth method. Every `resolveTokenUserAccess`
 * consumer (PAT, device JWT, `/j`, Subsonic, stream tokens) reads that column
 * as the IdP projection and re-merges CURRENT in-app names on top of it, so a
 * name baked in by this route survived `removeMember()` on every one of those
 * surfaces — including the admin axis, when the in-app group's name happens
 * to equal a `config.ADMIN_GROUPS` entry (native and OIDC sessions never
 * re-sync `users.groups` on their own, so the bake is effectively permanent
 * for them).
 *
 * Ruling (S-P2):
 * the route writes ONLY `locals.idpGroups` (the raw header list, set by
 * `forward-auth.ts` beside `authMethod`), and writes it whenever forward-auth
 * supplied the groups header — including an empty one (coordinated with the
 * empty-IdP-header follow-up: `idpGroups` is `undefined` only when the
 * header was ABSENT, `[]` when it was PRESENT and empty). Every other auth
 * method writes nothing.
 *
 * These tests drive the REAL `POST` handler (the seam) with real Postgres,
 * real `access-control.service.ts` (`addMember`/`removeMember`), real
 * `resolveTokenUserAccess` and `resolveOwnerAdminStatus`. Only the device-code
 * service (a leaf, external to this finding) is mocked — same shape as
 * `server.test.ts`'s existing mock.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
    generateTestUserId,
    ensureTestUser,
    derivedUsername,
} from '../../../../../tests/integration/fixtures/index.js';
import { addMember, removeMember } from '$lib/server/services/access-control.service.js';
import { createAccessGroup } from '$lib/server/services/access-control.service.js';
import {
    insertAccessGroup,
    getAccessGroupByName,
    removeAccessGroupMember,
} from '$lib/server/database/queries/access-groups.queries.js';
import { resolveTokenUserAccess } from '$lib/server/auth/resolve-token-user-access.js';
import { resolveOwnerAdminStatus } from '$lib/server/auth/resolve-owner-admin-status.js';
import { clearUserAccessCache } from '$lib/server/cache/user-access-cache.js';
import { config } from '$lib/server/config.js';
import { toUserId } from '$lib/shared/user-id.js';
import type { UserContext } from '$lib/server/types.js';

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
    },
}));

const mockGetByUserCode = vi.fn();
const mockAuthorize = vi.fn();

vi.mock('$lib/server/oauth', () => ({
    getDeviceCodeService: () => ({
        getByUserCode: (...args: unknown[]) => mockGetByUserCode(...args),
        authorize: (...args: unknown[]) => mockAuthorize(...args),
        deny: vi.fn(),
    }),
    isDeviceAuthEnabled: vi.fn().mockReturnValue(true),
    getJellyfinPermissionsService: () => ({
        fetchAndCachePermissions: vi.fn(),
    }),
}));

let sql: postgres.Sql;
const cleanupUserIds: string[] = [];
const cleanupGroupIds: string[] = [];

function baseUserContext(overrides: Partial<UserContext>): UserContext {
    return {
        userId: overrides.userId as UserContext['userId'],
        username: overrides.username ?? '',
        groups: (overrides.userGroups ?? []).join('|'),
        userGroups: overrides.userGroups ?? [],
        hasWatchPermission: true,
        hasLiveTvPermission: false,
        hasRequestPermission: false,
        ownerIsAdmin: false,
        maxAgeRating: null,
        isAgeRestricted: false,
        isModerator: false,
        liveTvPriority: 'low',
        ...overrides,
    };
}

function buildEvent(opts: {
    userId: string;
    username: string;
    userGroups: string[];
    authMethod: 'forward_auth' | 'session' | 'bearer' | 'pat';
    idpGroups?: string[];
}): RequestEvent {
    const url = 'http://localhost/api/oauth/authorize';
    const body = JSON.stringify({ user_code: 'ABCD-1234' });
    const request = new Request(url, {
        method: 'POST',
        body,
        headers: new Headers({ 'content-type': 'application/json' }),
    });
    return {
        url: new URL(url),
        request,
        locals: {
            user: baseUserContext({
                userId: toUserId(opts.userId),
                username: opts.username,
                userGroups: opts.userGroups,
            }),
            authMethod: opts.authMethod,
            ...(opts.idpGroups !== undefined ? { idpGroups: opts.idpGroups } : {}),
        },
        params: {},
    } as unknown as RequestEvent;
}

async function storedGroups(userId: string): Promise<string[] | null> {
    const rows = await sql<{ groups: string[] | null }[]>`
        SELECT groups FROM users WHERE id = ${userId}::uuid
    `;
    return rows[0]?.groups ?? null;
}

beforeAll(async () => {
    sql = getTestDb();
});

afterAll(async () => {
    // Best-effort cleanup — cascades to user_access_groups via FK ON DELETE
    // CASCADE (base-schema-sql.ts).
    if (cleanupUserIds.length > 0) {
        await sql`DELETE FROM users WHERE id = ANY(${cleanupUserIds}::uuid[])`;
    }
    if (cleanupGroupIds.length > 0) {
        await sql`DELETE FROM access_groups WHERE id = ANY(${cleanupGroupIds}::uuid[])`;
    }
    await closeTestDb();
});

describe('POST /api/oauth/authorize — users.groups write (security review 6, P2)', () => {
    it('a native/OIDC session does not bake an in-app group name into users.groups (survives removeMember)', async () => {
        const userId = generateTestUserId();
        cleanupUserIds.push(userId);
        await ensureTestUser(sql, userId);
        const username = derivedUsername(userId);

        const groupRes = await createAccessGroup(sql, { name: `p2-native-${userId.slice(0, 8)}` });
        expect(groupRes.ok).toBe(true);
        if (!groupRes.ok) return;
        const groupId = groupRes.data.id;
        cleanupGroupIds.push(groupId);
        const groupName = groupRes.data.name;

        await addMember(sql, groupId, userId, null);
        clearUserAccessCache();

        mockGetByUserCode.mockResolvedValue({
            status: 'pending',
            user_id: toUserId(userId),
            client_id: 'client-1',
        });
        mockAuthorize.mockResolvedValue(true);

        const { POST } = (await import('./+server.js')) as unknown as {
            POST: (event: RequestEvent) => Promise<Response>;
        };
        const res = await POST(
            buildEvent({
                userId,
                username,
                // What a native/OIDC session actually carries: the merged set
                // (row.groups union in-app names) — `native-session.ts:81-84`.
                userGroups: [groupName],
                authMethod: 'session',
                // No idpGroups on this path — only forward-auth sets it.
            }),
        );
        expect(res.status).toBe(200);

        // Control: membership is correctly recognised BEFORE removal, both at
        // HEAD and after the fix — a signal without this comparison would not
        // prove the assertion below is about the WRITE, not about whether
        // membership is read at all.
        const beforeAccess = await resolveTokenUserAccess(username);
        expect(beforeAccess?.userGroups).toContain(groupName);

        const removeRes = await removeMember(sql, groupId, userId);
        expect(removeRes.ok).toBe(true);
        clearUserAccessCache();

        const afterAccess = await resolveTokenUserAccess(username);
        expect(afterAccess?.userGroups ?? []).not.toContain(groupName);
    });

    it('a native/OIDC session does not bake an admin-conferring group name into users.groups (admin axis)', async () => {
        // A safety admin so removeMember's last-admin guard does not refuse
        // the removal below.
        const safetyAdminId = generateTestUserId();
        cleanupUserIds.push(safetyAdminId);
        await ensureTestUser(sql, safetyAdminId);
        await sql`UPDATE users SET is_admin = true, admin_pinned = true WHERE id = ${safetyAdminId}::uuid`;

        const userId = generateTestUserId();
        cleanupUserIds.push(userId);
        await ensureTestUser(sql, userId);
        const username = derivedUsername(userId);

        // A group named per config.ADMIN_GROUPS confers admin via the
        // config-name path (`groupConfersAdmin`). `createAccessGroup` refuses
        // this name (`isReservedGroupName`), so insert directly — the same
        // bypass `access-control.service.integration.test.ts`'s own
        // name-conferred-admin tests use.
        //
        // Fix round 1, Important 4: under the shipped default
        // (`ADMIN_GROUPS=Admins`), `config.ADMIN_GROUPS[0]` names the
        // schema-seeded SYSTEM group `admins` (`base-schema-sql.ts`) — a
        // prior version of this test unconditionally
        // `DELETE FROM access_groups WHERE LOWER(name) = LOWER(...)`'d that
        // name first, which deleted the seeded system group (never
        // recreated by the base seed) and broke unrelated tests elsewhere in
        // the shared DB. Never delete a group by name: reuse an existing
        // group with this name if one exists (don't delete it — only clean
        // up the membership we add, via `removeMember` below, which the
        // test's own assertion already exercises), or create a fresh one
        // (tracked for id-scoped cleanup) only when none exists.
        const adminGroupName = config.ADMIN_GROUPS[0];
        expect(adminGroupName).toBeTruthy();
        const existingGroup = await getAccessGroupByName(sql, adminGroupName);
        const group =
            existingGroup ??
            (await insertAccessGroup(sql, {
                name: adminGroupName,
                displayName: adminGroupName,
                description: null,
            }));
        if (!existingGroup) cleanupGroupIds.push(group.id);

        try {
            await addMember(sql, group.id, userId, null);
            clearUserAccessCache();

            mockGetByUserCode.mockResolvedValue({
                status: 'pending',
                user_id: toUserId(userId),
                client_id: 'client-1',
            });
            mockAuthorize.mockResolvedValue(true);

            const { POST } = (await import('./+server.js')) as unknown as {
                POST: (event: RequestEvent) => Promise<Response>;
            };
            const res = await POST(
                buildEvent({
                    userId,
                    username,
                    userGroups: [adminGroupName],
                    authMethod: 'session',
                }),
            );
            expect(res.status).toBe(200);

            // Control: the in-app admin-conferring membership is recognised
            // BEFORE removal, both at HEAD and after the fix.
            const before = await resolveOwnerAdminStatus(sql, username);
            expect(before?.isAdmin).toBe(true);

            const removeRes = await removeMember(sql, group.id, userId);
            expect(removeRes.ok).toBe(true);
            clearUserAccessCache();

            const after = await resolveOwnerAdminStatus(sql, username);
            expect(after?.isAdmin).toBe(false);
        } finally {
            // Guarantee no leaked membership on a REUSED (possibly shared,
            // e.g. the seeded system) group even if an assertion above threw
            // before removeMember ran. A no-op once removeMember succeeded.
            if (existingGroup) {
                await removeAccessGroupMember(sql, group.id, userId);
            }
        }
    });

    it('forward-auth writes only the raw IdP projection, not the in-app-merged set', async () => {
        const userId = generateTestUserId();
        cleanupUserIds.push(userId);
        await ensureTestUser(sql, userId);
        const username = derivedUsername(userId);

        const groupRes = await createAccessGroup(sql, {
            name: `p2-fa-extra-${userId.slice(0, 8)}`,
        });
        expect(groupRes.ok).toBe(true);
        if (!groupRes.ok) return;
        const groupId = groupRes.data.id;
        cleanupGroupIds.push(groupId);
        const groupName = groupRes.data.name;

        await addMember(sql, groupId, userId, null);
        clearUserAccessCache();

        const idpGroups = ['HeaderGroupOnly'];
        // What forward-auth actually computes for `user.userGroups` —
        // `resolveInAppAccess`'s union of the header list and in-app names
        // (`forward-auth.ts:2343`).
        const mergedGroups = [...idpGroups, groupName];

        mockGetByUserCode.mockResolvedValue({
            status: 'pending',
            user_id: toUserId(userId),
            client_id: 'client-1',
        });
        mockAuthorize.mockResolvedValue(true);

        const { POST } = (await import('./+server.js')) as unknown as {
            POST: (event: RequestEvent) => Promise<Response>;
        };
        // Fix round 1 (minor): call with a MIXED-CASE username while the real
        // row's username is the canonical lowercase `derivedUsername` — the
        // route's write must still land on that row (`upsertUserGroups`
        // lowercases before matching `ON CONFLICT (username)`).
        const res = await POST(
            buildEvent({
                userId,
                username: username.toUpperCase(),
                userGroups: mergedGroups,
                authMethod: 'forward_auth',
                idpGroups,
            }),
        );
        expect(res.status).toBe(200);

        const stored = await storedGroups(userId);
        expect(stored).toEqual(idpGroups);

        // Control: the forward-auth write still lands — dropping it entirely
        // would fail age caps open on Valkey-less installs (research §P2 (d)).
        expect(stored).toContain('HeaderGroupOnly');
    });

    it('a PAT/bearer caller writes nothing to users.groups', async () => {
        const userId = generateTestUserId();
        cleanupUserIds.push(userId);
        await ensureTestUser(sql, userId);
        const username = derivedUsername(userId);

        // A pre-existing value the route must NOT touch — at HEAD (pre-fix)
        // the unconditional write would have overwritten it with
        // `user.userGroups` regardless of auth method.
        const sentinel = ['pre-existing-sentinel'];
        await sql`UPDATE users SET groups = ${sentinel} WHERE id = ${userId}::uuid`;

        mockGetByUserCode.mockResolvedValue({
            status: 'pending',
            user_id: toUserId(userId),
            client_id: 'client-1',
        });
        mockAuthorize.mockResolvedValue(true);

        const { POST } = (await import('./+server.js')) as unknown as {
            POST: (event: RequestEvent) => Promise<Response>;
        };
        const res = await POST(
            buildEvent({
                userId,
                username,
                // What a PAT/device-JWT caller's resolved row carries — no
                // idpGroups is ever set on that path (only forward-auth sets
                // it), and authMethod is neither 'forward_auth' nor 'session'.
                userGroups: ['bearer-derived-group'],
                authMethod: 'bearer',
            }),
        );
        expect(res.status).toBe(200);

        const stored = await storedGroups(userId);
        expect(stored).toEqual(sentinel);
    });

    // Fix round 1 (coordinator update): the empty-IdP-header follow-up makes
    // `idpGroups` distinguish ABSENT (`undefined` — no groups header at all,
    // e.g. a proxy that doesn't forward it) from PRESENT-but-empty (`[]` —
    // the IdP revoked every group, which the route now writes to CLEAR
    // `users.groups`). This test covers the ABSENT case only — the
    // PRESENT-and-empty case is the peer session's
    // `authorize-empty-idp-groups.integration.test.ts`. This case stays
    // green both before and after that follow-up lands, since `idpGroups`
    // being `undefined` has always meant "nothing to persist".
    it('forward-auth with an ABSENT idpGroups (no groups header) writes nothing (ruling S-P2)', async () => {
        const userId = generateTestUserId();
        cleanupUserIds.push(userId);
        await ensureTestUser(sql, userId);
        const username = derivedUsername(userId);

        const sentinel = ['pre-existing-sentinel-2'];
        await sql`UPDATE users SET groups = ${sentinel} WHERE id = ${userId}::uuid`;

        mockGetByUserCode.mockResolvedValue({
            status: 'pending',
            user_id: toUserId(userId),
            client_id: 'client-1',
        });
        mockAuthorize.mockResolvedValue(true);

        const { POST } = (await import('./+server.js')) as unknown as {
            POST: (event: RequestEvent) => Promise<Response>;
        };
        const res = await POST(
            buildEvent({
                userId,
                username,
                userGroups: [],
                authMethod: 'forward_auth',
                // idpGroups omitted entirely — undefined, the ABSENT case.
            }),
        );
        expect(res.status).toBe(200);

        const stored = await storedGroups(userId);
        expect(stored).toEqual(sentinel);
    });
});
