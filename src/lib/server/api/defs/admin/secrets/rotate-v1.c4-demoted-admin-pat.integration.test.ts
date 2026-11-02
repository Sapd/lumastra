// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * C4 (security review 2026-09-15, fix round 1 review 2026-09-16): demotion
 * neither revoked nor narrowed the demoted admin's admin-scoped tokens, so
 * the entire `{kind:'scope'}` admin plane survived independently of the
 * `isAdmin` fix (a prior task in this plan, C2) — on EVERY demotion vector,
 * not just one.
 *
 * Fix round 1 review flagged that the original version of this file drove
 * the demotion by calling `setIsAdmin()` + `narrowAdminScopedCredentialsForUser()`
 * DIRECTLY — bypassing every route's own wiring, so deleting the hook from
 * any of the three admin-API branches (or the new IdP-group-sync branch)
 * would have left this file green. Every test below instead drives the
 * demotion (and, where relevant, the RE-promotion) through the REAL
 * production entry point for that vector:
 *
 *   1. PATCH /api/v1/users/{id} {isAdmin:false}      -> defs/users/[id].ts
 *   2. PATCH /api/admin/users/{username} {isAdmin:false} -> admin/users/[username]/index.ts
 *   3. PATCH /api/admin/users/{username} {unpin:true} (demoting) -> same def
 *   4. An IdP forward-auth request whose GROUPHEADER no longer lists an
 *      admin group -> resolveAuth() -> handleForwardAuth()'s fire-and-forget
 *      upsertUser() + syncAdminCredentialsAfterUpsert() (finding 3 of the
 *      review — the PRIMARY demotion path on an Authentik deployment)
 *
 * Each demotion test then re-authenticates the SAME raw PAT through the
 * unmocked resolveAuth() -> mount(rotate-v1 def) seam (the actual exploited
 * route from the security report) and asserts both the 403 AND the DB row's
 * `force_non_admin`. Test 1 also exercises the RE-promotion (restore) path.
 *
 * Requires a live PostgreSQL database (lumastra_tests, PG17+) and a reachable
 * Valkey. Run with:
 *   TEST_DATABASE_URL=postgresql://lumastra:lumastra@localhost:55432/lumastra_tests \
 *     npm run test:integration -- src/lib/server/api/defs/admin/secrets/rotate-v1.c4-demoted-admin-pat.integration.test.ts
 */

import { describe, it, beforeEach, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';

// The IdP-demotion tests drive resolveAuth() with forward-auth identity
// headers from getClientAddress() = 127.0.0.1. client-ip.ts reads the proxy
// trust config at MODULE LOAD and fails closed when neither TRUSTED_PROXY_IPS
// nor LUMASTRA_TRUST_ANY_PROXY is set (CI) — the headers are then dropped and
// the demotion never happens. A developer .env with LUMASTRA_TRUST_ANY_PROXY
// hid this locally, so pin the peer explicitly, like the forward-auth unit tests.
vi.hoisted(() => {
    process.env.TRUSTED_PROXY_IPS = '127.0.0.1';
    delete process.env.LUMASTRA_TRUST_ANY_PROXY;
});
import { getTestDb } from '../../../../../../../tests/integration/setup/test-database.js';
import { toUserId } from '$lib/shared/user-id.js';
import { getPatService } from '$lib/server/oauth/pat.service.js';
import { getServiceTokenService } from '$lib/server/oauth/service-token.service.js';
import { buildPrincipal } from '$lib/server/api/principal.js';
import { resolveAuth } from '$lib/server/middleware/forward-auth.js';
import { mount } from '$lib/server/api/mount.js';
import { config, features } from '$lib/server/config.js';
import { def as rotateDef } from './rotate-v1.js';
import { def as usersIdDef } from '../../users/[id].js';
import { def as adminUsersDef } from '../users/[username]/index.js';

// Forward auth is opt-in (FORWARD_AUTH_ENABLED). config.ts snapshots process.env
// before this file's hoisted block runs, so turn it on per test instead.
beforeEach(() => {
    vi.spyOn(config, 'FORWARD_AUTH_ENABLED', 'get').mockReturnValue(true);
});

const patService = getPatService();
const serviceTokenService = getServiceTokenService();
const ADMIN_GROUP = config.ADMIN_GROUPS[0] ?? 'admin';

/** Track every user row + PAT this file creates, for teardown. */
const createdUsernames = new Set<string>();
/** Access-group rows created directly via SQL (fix round 2, MINOR 4 test) — not tied to a user by FK. */
const createdGroupIds = new Set<string>();

async function insertAdminUser(opts: {
    username: string;
    adminPinned: boolean;
    groups?: string[];
}): Promise<string> {
    const sql = getTestDb();
    const [row] = await sql<{ id: string }[]>`
        INSERT INTO users (username, is_admin, admin_pinned, groups)
        VALUES (${opts.username}, true, ${opts.adminPinned}, ${opts.groups ?? [ADMIN_GROUP]}::text[])
        RETURNING id
    `;
    createdUsernames.add(opts.username);
    return row.id;
}

async function mintAdminPat(userId: string): Promise<{ id: number; token: string }> {
    return patService.create({
        userId: toUserId(userId),
        name: 'admin-pat',
        scopes: ['admin'],
        groups: [ADMIN_GROUP],
    });
}

async function getPatRow(
    patId: number,
): Promise<{ revoked_at: Date | null; force_non_admin: boolean; scopes: string[] }> {
    const sql = getTestDb();
    const [row] = await sql<
        Array<{ revoked_at: Date | null; force_non_admin: boolean; scopes: string[] }>
    >`
        SELECT revoked_at, force_non_admin, scopes FROM personal_access_tokens WHERE id = ${patId}
    `;
    return row;
}

/**
 * Mints a service token as a non-impersonating admin-scoped token CREATED BY
 * `username` (no `actAsUser`) -- the "creator" relationship
 * `markAdminScopedForceNonAdminImpersonating()`'s `LOWER(created_by)` arm
 * covers. `createdBy` must be a REAL, active `users` row -- `validate()`'s
 * `isCreatorActive()` denies the token entirely otherwise, independent of
 * `force_non_admin`.
 */
async function mintCreatorAdminServiceToken(
    username: string,
): Promise<{ id: number; token: string }> {
    return serviceTokenService.create({
        name: 'creator-admin-svc',
        createdBy: username,
        scopes: ['admin'],
    });
}

/**
 * Mints a sandboxed (operator forceNonAdmin:true) admin-scoped service token
 * impersonating `userId` -- the exact shape the fix round 2 review named
 * (a Grafana/Uptime-Kuma-style integration token). `createdBy` is the SAME
 * user for simplicity (a real, active row `isCreatorActive()` can resolve);
 * the identity of the creator is not what these tests are about.
 */
async function mintSandboxedActAsServiceToken(
    userId: string,
    createdByUsername: string,
): Promise<{ id: number; token: string }> {
    return serviceTokenService.create({
        name: 'sandboxed-grafana-svc',
        createdBy: createdByUsername,
        actAsUser: toUserId(userId),
        scopes: ['admin'],
        forceNonAdmin: true,
    });
}

async function getServiceTokenRow(id: number): Promise<{
    revoked_at: Date | null;
    force_non_admin: boolean;
    force_non_admin_narrowed_at: Date | null;
    scopes: string[];
}> {
    const sql = getTestDb();
    const [row] = await sql<
        Array<{
            revoked_at: Date | null;
            force_non_admin: boolean;
            force_non_admin_narrowed_at: Date | null;
            scopes: string[];
        }>
    >`
        SELECT revoked_at, force_non_admin, force_non_admin_narrowed_at, scopes
        FROM service_tokens WHERE id = ${id}
    `;
    return row;
}

async function getUserAdminState(
    username: string,
): Promise<{ is_admin: boolean; admin_pinned: boolean }> {
    const sql = getTestDb();
    const [row] = await sql<Array<{ is_admin: boolean; admin_pinned: boolean }>>`
        SELECT is_admin, admin_pinned FROM users WHERE username = ${username}
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

const noopMigration = async (): Promise<void> => undefined;

/** Re-authenticate a raw PAT against the real exploited route and return the response. */
async function callRotateWithToken(token: string): Promise<Response> {
    const url = new URL('http://localhost/api/v1/admin/secrets/rotate');
    const request = new Request(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        // Deliberately invalid body — see the original file header reasoning
        // (preserved from round 1): guarantees a harmless 400 from
        // RotateSecretsSchema if the outer gate lets a demoted admin's PAT
        // through, instead of an actual master-key rotation attempt against
        // the shared lumastra_tests database.
        body: JSON.stringify({}),
    });
    const event = {
        request,
        url,
        params: {},
        route: { id: null },
        locals: {},
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
    } as unknown as RequestEvent;
    const authResult = await resolveAuth(event, noopMigration, true);
    expect(authResult).toBeUndefined();
    const { POST } = mount(rotateDef, { surface: 'v1' });
    return POST!(event);
}

/** A `users:admin`-scoped (non-admin) operator principal — enough to demote, not to promote. */
function operatorPrincipalNonAdmin() {
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

/** A full-admin operator principal — required by requireAdminCeiling() to grant admin. */
function operatorPrincipalAdmin() {
    return buildPrincipal({
        kind: 'pat',
        userId: toUserId(randomUUID()),
        username: 'root-operator',
        userGroups: [ADMIN_GROUP],
        tokenScopes: ['admin'],
        ownerIsAdmin: true,
    });
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

describe('C4 fix round 1 review: every demotion/promotion vector narrows/restores admin-scoped credentials', () => {
    // Every vector below goes through resolveAuth(), whose handleApiV1Auth ->
    // handlePublicApiAuth() short-circuits with 503 "Public API is not enabled"
    // unless features.deviceAuth is on — and FEATURE_DEVICE_AUTH defaults to
    // false, with no test env enabling it. Without this the whole file asserted
    // against that 503 instead of the demotion behaviour it exists to cover.
    // Spying the GETTER (not assigning config.*) is what actually takes effect:
    // deviceAuth is a computed getter over FEATURE_DEVICE_AUTH && JWT_SECRET.
    beforeAll(() => {
        vi.spyOn(features, 'deviceAuth', 'get').mockReturnValue(true);
    });
    afterAll(() => {
        vi.restoreAllMocks();
    });

    // countOtherEffectiveAdmins()'s last-admin guard is real product behaviour
    // this file must work WITH, not around: each test below demotes the ONLY
    // admin it itself creates, so without a standing companion admin the
    // guard correctly (but inconveniently) 409s every demotion attempt in a
    // lumastra_tests database that happens to have no other enabled admin at
    // that moment. One companion, shared by the whole file.
    const companionUsername = `itest_c4_companion_${randomUUID().slice(0, 8)}`;

    beforeAll(async () => {
        // Raw insert, NOT insertAdminUser() -- that tracks the username in
        // createdUsernames for per-test afterEach cleanup, which would
        // delete this companion after the first test.
        const sql = getTestDb();
        await sql`
            INSERT INTO users (username, is_admin, admin_pinned, groups)
            VALUES (${companionUsername}, true, true, ${[ADMIN_GROUP]}::text[])
        `;
    });

    afterAll(async () => {
        const sql = getTestDb();
        await sql`DELETE FROM users WHERE username = ${companionUsername}`;
    });

    afterEach(async () => {
        const sql = getTestDb();
        for (const username of createdUsernames) {
            await sql`DELETE FROM personal_access_tokens WHERE user_id IN (SELECT id FROM users WHERE username = ${username})`;
            await sql`DELETE FROM users WHERE username = ${username}`;
        }
        createdUsernames.clear();
        // Membership rows cascade away with the user deletion above; only a
        // GROUP this file itself created (never a pre-existing one it reused)
        // needs explicit cleanup.
        for (const groupId of createdGroupIds) {
            await sql`DELETE FROM access_groups WHERE id = ${groupId}::uuid`;
        }
        createdGroupIds.clear();
    });

    it('PATCH /api/v1/users/{id} {isAdmin:false} (defs/users/[id].ts) narrows the PAT; {isAdmin:true} restores it', async () => {
        const username = `itest_c4_v1_${randomUUID().slice(0, 8)}`;
        const userId = await insertAdminUser({ username, adminPinned: true });
        const { id: patId, token } = await mintAdminPat(userId);

        // Sanity: admin PAT works against the exploited route before demotion.
        const preResp = await callRotateWithToken(token);
        expect(preResp.status).not.toBe(403);

        // --- Demote through the REAL v1 route ---
        const demoteUrl = new URL(`http://localhost/api/v1/users/${userId}`);
        const demoteEvent = {
            ...baseEventFields(),
            request: new Request(demoteUrl, {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ isAdmin: false }),
            }),
            url: demoteUrl,
            params: { id: userId },
            locals: { principal: operatorPrincipalNonAdmin() },
        } as unknown as RequestEvent;
        const { PATCH: usersIdPatch } = mount(usersIdDef, { surface: 'v1' });
        const demoteResp = await usersIdPatch!(demoteEvent);
        expect(demoteResp.status).toBe(200);

        const rowAfterDemotion = await getPatRow(patId);
        expect(rowAfterDemotion.revoked_at).toBeNull();
        expect(rowAfterDemotion.force_non_admin).toBe(true);

        const demotedResp = await callRotateWithToken(token);
        expect(demotedResp.status).toBe(403);
        const demotedBody = (await demotedResp.json()) as { code?: string };
        expect(demotedBody.code).toBe('scope_required');

        // --- Re-promote through the SAME real route ---
        const promoteUrl = new URL(`http://localhost/api/v1/users/${userId}`);
        const promoteEvent = {
            ...baseEventFields(),
            request: new Request(promoteUrl, {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ isAdmin: true }),
            }),
            url: promoteUrl,
            params: { id: userId },
            locals: { principal: operatorPrincipalAdmin() },
        } as unknown as RequestEvent;
        const promoteResp = await usersIdPatch!(promoteEvent);
        expect(promoteResp.status).toBe(200);

        const rowAfterPromotion = await getPatRow(patId);
        expect(rowAfterPromotion.force_non_admin).toBe(false);

        const restoredResp = await callRotateWithToken(token);
        expect(restoredResp.status).not.toBe(403);
    });

    it('PATCH /api/admin/users/{username} {isAdmin:false} (SPA def) narrows the PAT', async () => {
        const username = `itest_c4_spa_${randomUUID().slice(0, 8)}`;
        const userId = await insertAdminUser({ username, adminPinned: true });
        const { id: patId, token } = await mintAdminPat(userId);

        const url = new URL(`http://localhost/api/admin/users/${username}`);
        const event = {
            ...baseEventFields(),
            request: new Request(url, {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ isAdmin: false }),
            }),
            url,
            params: { username },
            locals: { principal: operatorPrincipalNonAdmin() },
        } as unknown as RequestEvent;
        const { PATCH } = mount(adminUsersDef, { surface: 'internal' });
        const resp = await PATCH!(event);
        expect(resp.status).toBe(200);

        const row = await getPatRow(patId);
        expect(row.force_non_admin).toBe(true);

        const rotateResp = await callRotateWithToken(token);
        expect(rotateResp.status).toBe(403);
    });

    it('PATCH /api/admin/users/{username} {unpin:true} that demotes (SPA def) narrows the PAT', async () => {
        const username = `itest_c4_unpin_${randomUUID().slice(0, 8)}`;
        // Pinned admin whose IdP groups do NOT grant admin -- unpinning hands
        // control to groups and demotes.
        const userId = await insertAdminUser({ username, adminPinned: true, groups: ['nobody'] });
        const { id: patId, token } = await mintAdminPat(userId);

        const url = new URL(`http://localhost/api/admin/users/${username}`);
        const event = {
            ...baseEventFields(),
            request: new Request(url, {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ unpin: true }),
            }),
            url,
            params: { username },
            // fix-plan-5 Task 5, fix round 1 new finding: unpin now requires
            // the admin ceiling exactly like {isAdmin:true}, since unpinning
            // is data-dependent (the target's IdP groups decide demote vs.
            // promote) and a delegated users:admin-only token must not be
            // able to trigger either outcome. operatorPrincipalNonAdmin()
            // would now 403 here before ever reaching the write this test
            // means to exercise.
            locals: { principal: operatorPrincipalAdmin() },
        } as unknown as RequestEvent;
        const { PATCH } = mount(adminUsersDef, { surface: 'internal' });
        const resp = await PATCH!(event);
        expect(resp.status).toBe(200);

        const userState = await getUserAdminState(username);
        expect(userState.is_admin).toBe(false);
        expect(userState.admin_pinned).toBe(false);

        const row = await getPatRow(patId);
        expect(row.force_non_admin).toBe(true);

        const rotateResp = await callRotateWithToken(token);
        expect(rotateResp.status).toBe(403);
    });

    it('an IdP forward-auth request that drops the admin group narrows the PAT (fire-and-forget upsertUser path)', async () => {
        const username = `itest_c4_idp_${randomUUID().slice(0, 8)}`;
        // UNPINNED -- required for the IdP group sync to actually change is_admin.
        const userId = await insertAdminUser({ username, adminPinned: false });
        const { id: patId, token } = await mintAdminPat(userId);

        // Deliberately NO "sanity" callRotateWithToken() here before the
        // forward-auth request: PAT validation warms resolve-token-user-
        // access's shared user-admin-cache entries for this username (the
        // SAME process-global cache resolveDbAuth() below checks FIRST), and
        // a pre-warmed isAdmin:true would make resolveDbAuth() return the
        // stale cached verdict instead of re-deriving from THIS request's
        // group header -- silently defeating the very thing this test
        // exists to prove.

        const url = new URL('http://localhost/dashboard-itest-idp-demotion');
        const event = {
            ...baseEventFields(),
            request: new Request(url, {
                method: 'GET',
                headers: {
                    [config.USERHEADER]: username,
                    // A group that is NOT config.ADMIN_GROUPS -- this is the
                    // "dropped from the admin group" login the review named.
                    [config.GROUPHEADER]: 'itest-nonadmin-group',
                },
            }),
            url,
            params: {},
            locals: {},
        } as unknown as RequestEvent;

        const authResult = await resolveAuth(event, noopMigration, true);
        expect(authResult).toBeUndefined();
        // Identity is resolved as non-admin THIS request already (dbIsAdmin
        // derives straight from the header for an unpinned user).
        expect(event.locals.principal?.isAdmin).toBe(false);

        // The credential-narrowing side effect is fire-and-forget (never
        // blocks the response) -- poll for it.
        await waitUntil(async () => (await getPatRow(patId)).force_non_admin === true);

        const demotedResp = await callRotateWithToken(token);
        expect(demotedResp.status).toBe(403);
    });

    it('fix round 2, MINOR 4: dropping the IdP admin group does NOT narrow when the user is ALSO in an in-app group whose NAME confers admin (no capability row)', async () => {
        // The X3/MINOR-4 in-app check must cover the group-NAME-match path,
        // not just the `admin` CAPABILITY — an in-app group whose NAME is in
        // config.ADMIN_GROUPS confers admin via hasGroupPermission() inside
        // buildUserPermissions, with no capability row at all. `createAccessGroup()`
        // refuses a group named after an ADMIN_GROUPS entry (isReservedGroupName),
        // so this is inserted directly, mirroring access-control.service.
        // integration.test.ts's own "name-conferred admin" test.
        const username = `itest_c4_idp_name_${randomUUID().slice(0, 8)}`;
        const userId = await insertAdminUser({ username, adminPinned: false });
        const { id: patId, token } = await mintAdminPat(userId);

        const sql = getTestDb();
        // Group names are case-insensitively UNIQUE, and some environments
        // (this one included) already seed a non-system group whose name
        // happens to match config.ADMIN_GROUPS[0] — insert-or-reuse rather
        // than assume either state. Only delete the group in teardown if
        // THIS test created it (a pre-existing one is left alone).
        let groupId: string;
        try {
            const [row] = await sql<{ id: string }[]>`
                INSERT INTO access_groups (name, display_name, description, is_system)
                VALUES (${ADMIN_GROUP}, ${ADMIN_GROUP}, NULL, FALSE)
                RETURNING id
            `;
            groupId = row.id;
            createdGroupIds.add(groupId);
        } catch {
            const [row] = await sql<{ id: string }[]>`
                SELECT id FROM access_groups WHERE LOWER(name) = LOWER(${ADMIN_GROUP})
            `;
            groupId = row.id;
        }
        // The membership row cascades away with the user (afterEach deletes
        // `users` for every tracked username) — no separate cleanup needed.
        await sql`
            INSERT INTO user_access_groups (group_id, user_id, assigned_by)
            VALUES (${groupId}::uuid, ${userId}::uuid, NULL)
        `;

        const url = new URL('http://localhost/dashboard-itest-idp-name-conferred');
        const event = {
            ...baseEventFields(),
            request: new Request(url, {
                method: 'GET',
                headers: {
                    [config.USERHEADER]: username,
                    // Drops the IdP admin group — but the in-app group above
                    // (name-matched, no capability) should keep Formula A true.
                    [config.GROUPHEADER]: 'itest-nonadmin-group',
                },
            }),
            url,
            params: {},
            locals: {},
        } as unknown as RequestEvent;

        const authResult = await resolveAuth(event, noopMigration, true);
        expect(authResult).toBeUndefined();

        // The fire-and-forget IIFE this test exercises does, in order:
        // upsertUser() (the is_admin column write) -> syncAdminCredentialsAfterUpsert()
        // (the in-app-aware admin-transition decision this test is actually
        // about) -> ensureUserProfileExists(). A fixed sleep here is a
        // coin-flip about whether BOTH preceding awaits (an in-app DB lookup
        // + a dynamic import) have actually finished by the time it fires —
        // flaky-negative risk (asserting `false` before the decision ran,
        // rather than because it correctly decided not to narrow). Poll
        // instead for the LAST step's side effect: this test's user has no
        // user_profiles row yet, so its existence proves
        // syncAdminCredentialsAfterUpsert() (and its no-op-or-not decision)
        // already ran to completion before we assert the negative.
        await waitUntil(async () => {
            const sql = getTestDb();
            const rows = await sql<{ one: number }[]>`
                SELECT 1 AS one FROM user_profiles WHERE user_id = ${userId}::uuid
            `;
            return rows.length > 0;
        });
        expect((await getPatRow(patId)).force_non_admin).toBe(false);

        const stillAdminResp = await callRotateWithToken(token);
        expect(stillAdminResp.status).not.toBe(403);
    });

    /** Drive PATCH /api/admin/users/{username} through the real SPA def. */
    async function patchAdminUser(
        username: string,
        body: Record<string, unknown>,
        principal: ReturnType<typeof operatorPrincipalNonAdmin>,
    ): Promise<Response> {
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
            locals: { principal },
        } as unknown as RequestEvent;
        const { PATCH } = mount(adminUsersDef, { surface: 'internal' });
        return PATCH!(event);
    }

    it("a demoted admin's own non-impersonating admin-scoped service token (created_by, no actAsUser) is narrowed", async () => {
        // Fix round 2 review named this exact gap: round 1 only covered
        // act_as_user; the LOWER(created_by) arm added in round 2 had NO
        // test at any level until now.
        const username = `itest_c4_creator_${randomUUID().slice(0, 8)}`;
        await insertAdminUser({ username, adminPinned: true });
        const { id: svcId, token } = await mintCreatorAdminServiceToken(username);

        const preResp = await callRotateWithToken(token);
        expect(preResp.status).not.toBe(403);

        const resp = await patchAdminUser(
            username,
            { isAdmin: false },
            operatorPrincipalNonAdmin(),
        );
        expect(resp.status).toBe(200);

        const row = await getServiceTokenRow(svcId);
        expect(row.revoked_at).toBeNull();
        expect(row.force_non_admin).toBe(true);
        expect(row.force_non_admin_narrowed_at).not.toBeNull();

        const demotedResp = await callRotateWithToken(token);
        expect(demotedResp.status).toBe(403);
    });

    it('an operator-sandboxed (forceNonAdmin:true) admin-scoped service token survives a demote-then-repromote of its act_as_user subject', async () => {
        // Fix round 2 review, NEW Important 1: the round-2 promotion
        // restore cleared force_non_admin on EVERY row that had it set --
        // including one an OPERATOR chose at mint time, not narrowing. That
        // is a privilege ESCALATION: an admin-scoped, deliberately
        // sandboxed integration token (the "Force non-admin" checkbox the
        // admin token UI recommends for Grafana/Uptime-Kuma-style
        // integrations) would silently regain full admin the next time its
        // subject's admin status was ever touched.
        const username = `itest_c4_sandbox_repromote_${randomUUID().slice(0, 8)}`;
        const userId = await insertAdminUser({ username, adminPinned: true });
        const { id: svcId } = await mintSandboxedActAsServiceToken(userId, username);

        // Sanity: mint-time state is exactly force_non_admin:true, NOT
        // narrowed by us.
        const minted = await getServiceTokenRow(svcId);
        expect(minted.force_non_admin).toBe(true);
        expect(minted.force_non_admin_narrowed_at).toBeNull();

        // Demote (narrowing SELECTs `force_non_admin = false`, so this
        // already-sandboxed token is skipped -- stays operator-owned).
        const demoteResp = await patchAdminUser(
            username,
            { isAdmin: false },
            operatorPrincipalNonAdmin(),
        );
        expect(demoteResp.status).toBe(200);
        const afterDemote = await getServiceTokenRow(svcId);
        expect(afterDemote.force_non_admin).toBe(true);
        expect(afterDemote.force_non_admin_narrowed_at).toBeNull();

        // Re-promote -- a REAL transition (false -> true). THE assertion:
        // the operator's own sandbox must survive this restore.
        const promoteResp = await patchAdminUser(
            username,
            { isAdmin: true },
            operatorPrincipalAdmin(),
        );
        expect(promoteResp.status).toBe(200);

        const afterPromote = await getServiceTokenRow(svcId);
        expect(afterPromote.force_non_admin).toBe(true);
        expect(afterPromote.force_non_admin_narrowed_at).toBeNull();
    });

    it('an operator-sandboxed admin-scoped service token survives a REDUNDANT PATCH {isAdmin:true} on an already-admin subject', async () => {
        // Fix round 2 review, NEW Important 2: the promotion branches were a
        // bare `} else {` on `if (!isAdmin)`, with no check against the
        // target's PRIOR state -- an idempotent re-promotion of someone
        // already admin ran the full restore for no reason, which alone was
        // enough to trigger NEW Important 1's escalation without any
        // demote/re-promote cycle at all.
        const username = `itest_c4_sandbox_redundant_${randomUUID().slice(0, 8)}`;
        // Already admin AND pinned -- PATCH {isAdmin:true} on this user has
        // NO is_admin transition.
        const userId = await insertAdminUser({ username, adminPinned: true });
        const { id: svcId } = await mintSandboxedActAsServiceToken(userId, username);

        const resp = await patchAdminUser(username, { isAdmin: true }, operatorPrincipalAdmin());
        expect(resp.status).toBe(200);

        const row = await getServiceTokenRow(svcId);
        expect(row.force_non_admin).toBe(true);
        expect(row.force_non_admin_narrowed_at).toBeNull();
    });
});
