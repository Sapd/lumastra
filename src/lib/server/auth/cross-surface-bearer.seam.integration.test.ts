// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Cross-surface seam harness (security review 5, fix-plan-5 Task 2): drives
 * ONE raw credential through both `/api/v1` and every `/api/admin/*` arm and
 * asserts the SAME identity verdict comes back everywhere.
 *
 * This is the deliverable review 5 §7 ("Cross-surface consistency for one
 * credential") and §10 ("the right check after this loop is a test that
 * drives one credential through both surfaces") ask for. It is written
 * BEFORE Task 3 (the `token-identity.ts` collapse) so Task 3/4's RED
 * evidence comes from this seam, not from a mock.
 *
 * Five legs, same raw token each time:
 *   (a) `/api/v1` PRIMARY      — resolveAuth() -> mount(def,{surface:'v1'})
 *   (b) `/api/admin` TERTIARY  — resolveAuth()'s Bearer exception (must
 *                                 return `undefined` AND leave
 *                                 `locals.principal` unset) -> mount(def,{surface:'internal'})
 *   (c) requireAdmin()         — the ~50 legacy `/api/admin/*` route files
 *   (d) callerIsAdmin()        — the token-minting ceiling
 *   (e) `{kind:'scope'}`       — mount(def,{surface:'internal'}) -> authenticate()
 *
 * Per fact 3 of `research-shape-a.md`: leg (b)/(c)/(d)/(e) only reach the
 * Bearer exception in `forward-auth.ts` (`FA:2558`'s `if (!dev &&
 * !hasAuthHeaders)` guard) when `dev` is `false` — in dev mode a headerless
 * request becomes `DEFAULT_USER` and passes vacuously. `$app/environment` is
 * therefore mocked to `{dev:false,...}` for the whole file, matching every
 * other forward-auth test that reaches this code path.
 *
 * UNMOCKED (per Global Constraint 2 and the task brief): resolve-owner-admin-
 * status, resolve-token-user-access, access-control.service, pat.service,
 * service-token.service, client-ip, principal, mount, forward-auth,
 * middleware/auth, token-minting, tasks/api-auth, the user caches, the DB
 * connection. ONLY `$app/environment` and the `features.deviceAuth` getter
 * are stubbed.
 *
 * Run:
 *   TEST_DATABASE_URL=postgres://lumastra:lumastra@127.0.0.1:5432/lumastra_review5_tests \
 *     npm run test:integration -- src/lib/server/auth/cross-surface-bearer.seam.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, vi, type MockInstance } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { getTestDb } from '../../../../tests/integration/setup/test-database.js';
import { toUserId } from '$lib/shared/user-id.js';
import { getPatService } from '$lib/server/oauth/pat.service.js';
import { getServiceTokenService } from '$lib/server/oauth/service-token.service.js';
import { createAccessGroup, addMember } from '$lib/server/services/access-control.service.js';
import { resolveAuth } from '$lib/server/middleware/forward-auth.js';
import { mount } from '$lib/server/api/mount.js';
import { requireAdmin } from '$lib/server/middleware/auth.js';
import { callerIsAdmin } from '$lib/server/api/token-minting.js';
import { config, features } from '$lib/server/config.js';
import { def as changeTimelineDef } from '$lib/server/api/defs/admin/system/change-timeline.js';
import { def as lockMetricsDef } from '$lib/server/api/defs/admin/ops/lock-metrics.js';
import { def as usersIdDef } from '$lib/server/api/defs/users/[id].js';
import { def as accessGroupMembersDef } from '$lib/server/api/defs/access/groups/[id]/members/[userId].js';
import { def as taskRunDef } from '$lib/server/api/defs/tasks/[taskId]/run.js';
import { buildPrincipal } from '$lib/server/api/principal.js';
import { tokenEnvelopeDenial } from '$lib/server/auth/token-identity.js';

// Fact 3 (research-shape-a.md): the Bearer exception at forward-auth.ts's
// `!dev && !hasAuthHeaders` guard is skipped entirely in dev mode (a
// headerless request becomes DEFAULT_USER and passes vacuously). Mock
// EVERY field the model file's sibling forward-auth tests mock, via the
// `$app/...` specifier (an absolute path silently no-ops in CI).
vi.mock('$app/environment', () => ({
    dev: false,
    building: false,
    browser: false,
    version: 'test',
}));

const patService = getPatService();
const serviceTokenService = getServiceTokenService();
const ADMIN_GROUP = config.ADMIN_GROUPS[0] ?? 'admin';

const V1_PATH = '/api/v1/admin/system/change-timeline';
const V1_URL = `http://localhost${V1_PATH}`;
const INTERNAL_URL = 'http://localhost/api/admin/system/change-timeline';
const DEPCHECK_URL = 'http://localhost/api/admin/dependency-check';
const PATS_URL = 'http://localhost/api/admin/pats';
// Leg (e) def: a REAL deployed internal {kind:'scope'} def, mounted at
// /api/admin/lock-metrics in src/routes/api/admin/lock-metrics/+server.ts
// (unlike the earlier invariants-v1.ts choice, which is v1-ONLY and never
// actually mounted under /api/admin — fixed per fix-round-1 review MINOR 2).
const LOCK_METRICS_URL = 'http://localhost/api/admin/lock-metrics';

const v1ChangeTimeline = mount(changeTimelineDef, { surface: 'v1' });
const internalChangeTimeline = mount(changeTimelineDef, { surface: 'internal' });
const internalLockMetrics = mount(lockMetricsDef, { surface: 'internal' });
// Fixture 9 (X1): the real v1 access-group members PUT/DELETE handlers.
const { PUT: accessGroupMembersPut, DELETE: accessGroupMembersDelete } = mount(
    accessGroupMembersDef,
    { surface: 'v1' },
);
// Fixture 10 (X2): a v1 {kind:'scope', anyOf:['tasks:run']} def to compare
// against the {kind:'scope', anyOf:['metrics:read','admin']} /api/admin leg
// (metrics:read) — the narrowed-token bug affects any non-admin-suffixed
// area scope 'admin' happened to expand into, not tasks:run specifically.
const v1TaskRun = mount(taskRunDef, { surface: 'v1' });

const noopMigration = async (): Promise<void> => undefined;

// ── Fixture bookkeeping / teardown ──────────────────────────────────────────

const createdUsernames = new Set<string>();
const createdGroupIds = new Set<string>();

function trackUsername(username: string): void {
    createdUsernames.add(username);
}

async function insertUser(opts: {
    username: string;
    isAdmin: boolean;
    adminPinned: boolean;
    groups?: string[];
}): Promise<string> {
    const sql = getTestDb();
    const [row] = await sql<{ id: string }[]>`
        INSERT INTO users (username, is_admin, admin_pinned, groups)
        VALUES (${opts.username}, ${opts.isAdmin}, ${opts.adminPinned}, ${opts.groups ?? []}::text[])
        RETURNING id
    `;
    trackUsername(opts.username);
    return row.id;
}

/**
 * Adds `userId` to a fresh in-app group carrying the `admin` capability.
 * Returns the group id (fixture 9 needs it to remove the member later).
 */
async function addInAppAdmin(userId: string, namePrefix: string): Promise<string> {
    const sql = getTestDb();
    const groupName = `${namePrefix}_${randomUUID().slice(0, 8)}`;
    const created = await createAccessGroup(sql, {
        name: groupName,
        capabilities: [{ capability: 'admin' }],
    });
    if (!created.ok) throw new Error(`setup: createAccessGroup failed: ${created.message}`);
    createdGroupIds.add(created.data.id);
    await addMember(sql, created.data.id, userId, null);
    return created.data.id;
}

async function mintPat(userId: string, scopes: string[] = ['admin']) {
    return patService.create({ userId: toUserId(userId), name: 'seam-pat', scopes, groups: [] });
}

async function mintServiceToken(opts: {
    createdBy: string;
    actAsUser?: string;
    scopes?: string[];
    allowedIps?: string[];
    allowedPathPrefixes?: string[];
    allowedMethods?: string[];
    forceNonAdmin?: boolean;
}) {
    return serviceTokenService.create({
        name: 'seam-svc',
        createdBy: opts.createdBy,
        actAsUser: opts.actAsUser ? toUserId(opts.actAsUser) : undefined,
        scopes: opts.scopes ?? ['admin'],
        allowedIps: opts.allowedIps,
        allowedPathPrefixes: opts.allowedPathPrefixes,
        allowedMethods: opts.allowedMethods,
        forceNonAdmin: opts.forceNonAdmin,
    });
}

afterAll(async () => {
    const sql = getTestDb();
    const usernames = Array.from(createdUsernames);
    const groupIds = Array.from(createdGroupIds);
    // FK order per global constraints: service_tokens, personal_access_tokens,
    // user_access_groups, access_groups, users.
    if (usernames.length > 0) {
        await sql`
            DELETE FROM service_tokens
            WHERE LOWER(created_by) = ANY(${usernames.map((u) => u.toLowerCase())}::text[])
               OR act_as_user IN (SELECT id FROM users WHERE username = ANY(${usernames}::text[]))
        `;
        await sql`
            DELETE FROM personal_access_tokens
            WHERE user_id IN (SELECT id FROM users WHERE username = ANY(${usernames}::text[]))
        `;
    }
    if (groupIds.length > 0) {
        await sql`DELETE FROM user_access_groups WHERE group_id = ANY(${groupIds}::uuid[])`;
        await sql`DELETE FROM access_groups WHERE id = ANY(${groupIds}::uuid[])`;
    }
    if (usernames.length > 0) {
        await sql`DELETE FROM users WHERE username = ANY(${usernames}::text[])`;
    }
});

// ── Event construction ───────────────────────────────────────────────────────

function baseEventFields(getClientAddress: () => string) {
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
        getClientAddress,
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: () => undefined,
    };
}

function makeEvent(opts: {
    url: string;
    method?: string;
    token?: string;
    getClientAddress?: () => string;
}): RequestEvent {
    const url = new URL(opts.url);
    const headers = new Headers();
    if (opts.token) headers.set('authorization', `Bearer ${opts.token}`);
    const request = new Request(url, { method: opts.method ?? 'GET', headers });
    return {
        ...baseEventFields(opts.getClientAddress ?? (() => '127.0.0.1')),
        // A real /api/admin/* request carries a matched route id; resolveAuth's
        // unrouted-path guard (event.route.id === null) only fires on a genuine
        // 404, so drive these legs with the concrete path as the route id.
        route: { id: url.pathname },
        request,
        url,
        params: {},
        locals: {},
    } as unknown as RequestEvent;
}

// ── Leg runners ──────────────────────────────────────────────────────────────
// Each returns the event (so `event.locals.principal` can be inspected) plus
// whatever result the leg itself produces.

/** Leg (a): /api/v1 PRIMARY. */
async function legA(
    token: string,
    opts: { method?: string; getClientAddress?: () => string } = {},
): Promise<{ event: RequestEvent; response: Response }> {
    const event = makeEvent({
        url: V1_URL,
        method: opts.method,
        token,
        getClientAddress: opts.getClientAddress,
    });
    const authResult = await resolveAuth(event, noopMigration, true);
    if (authResult) return { event, response: authResult };
    const response = await v1ChangeTimeline.GET!(event);
    return { event, response };
}

/**
 * Leg (b): /api/admin TERTIARY (mount kind:'admin').
 *
 * `principalBeforeMount` is `event.locals.principal` captured immediately
 * after `resolveAuth()` returns and BEFORE `mount()` runs — the brief-
 * mandated proof that the Bearer exception itself never materialises an
 * identity (only mount()'s TERTIARY fallback does). Every caller must
 * assert this is `undefined`, not just that `authResultUndefined` is true.
 */
async function legB(
    token: string,
    opts: { getClientAddress?: () => string } = {},
): Promise<{
    event: RequestEvent;
    response: Response;
    authResultUndefined: boolean;
    principalBeforeMount: RequestEvent['locals']['principal'];
}> {
    const event = makeEvent({ url: INTERNAL_URL, token, getClientAddress: opts.getClientAddress });
    const authResult = await resolveAuth(event, noopMigration, true);
    const authResultUndefined = authResult === undefined;
    const principalBeforeMount = event.locals.principal;
    if (!authResultUndefined) {
        return {
            event,
            response: authResult as Response,
            authResultUndefined,
            principalBeforeMount,
        };
    }
    const response = await internalChangeTimeline.GET!(event);
    return { event, response, authResultUndefined, principalBeforeMount };
}

/** Leg (c): requireAdmin() wrapping a trivial inner handler. */
async function legC(
    token: string,
    opts: { getClientAddress?: () => string } = {},
): Promise<{ event: RequestEvent; response: Response }> {
    const event = makeEvent({ url: DEPCHECK_URL, token, getClientAddress: opts.getClientAddress });
    const handler = requireAdmin(async () => new Response('ok'));
    const response = await handler(event);
    return { event, response };
}

/** Leg (d): callerIsAdmin() — the mint ceiling. */
async function legD(
    token: string,
    opts: { getClientAddress?: () => string } = {},
): Promise<{ event: RequestEvent; isAdmin: boolean }> {
    const event = makeEvent({ url: PATS_URL, token, getClientAddress: opts.getClientAddress });
    // The deployed admin mint routes materialise the credential principal
    // before their handler calls the principal-only ceiling.
    let isAdmin = false;
    await requireAdmin(async (authenticatedEvent) => {
        isAdmin = await callerIsAdmin(authenticatedEvent);
        return new Response('ok');
    })(event);
    return { event, isAdmin };
}

/** Leg (e): {kind:'scope'} def under /api/admin -> authenticate(). */
async function legE(
    token: string,
    opts: { getClientAddress?: () => string } = {},
): Promise<{ event: RequestEvent; response: Response }> {
    const event = makeEvent({
        url: LOCK_METRICS_URL,
        token,
        getClientAddress: opts.getClientAddress,
    });
    const response = await internalLockMetrics.GET!(event);
    return { event, response };
}

/** Fixture 6 only: the single production entry point that Task 4 gates. */
async function resolveOnly(url: string, token: string): Promise<Response | undefined> {
    const event = makeEvent({ url, token });
    return resolveAuth(event, noopMigration, true);
}

// ── Fixture 7 helpers: demotion/promotion through the real production path ──
// (Q8 narrowing arm — mirrors rotate-v1.c4-demoted-admin-pat.integration.test.ts's
// own rationale for driving demotion/promotion through the actual route
// rather than calling narrowAdminScopedCredentialsForUser() directly.)

/** A `users:admin`-scoped (non-admin) operator principal — enough to demote, not promote. */
function operatorPrincipalNonAdmin() {
    return buildPrincipal({
        kind: 'pat',
        userId: toUserId(randomUUID()),
        username: 'seam-operator',
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

/**
 * A delegated non-admin `access:admin`-scoped principal (fixture 9, X1a): has
 * the SCOPE needed to pass mount()'s {kind:'scope'} gate on the access-group
 * defs, but is not an administrator — requireAdminCeiling() must still deny
 * it for a write that confers admin.
 */
function operatorPrincipalAccessAdminOnly() {
    return buildPrincipal({
        kind: 'pat',
        userId: toUserId(randomUUID()),
        username: 'seam-access-admin-delegate',
        userGroups: [],
        tokenScopes: ['access:admin'],
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
        username: 'seam-root-operator',
        userGroups: [ADMIN_GROUP],
        tokenScopes: ['admin'],
        ownerIsAdmin: true,
    });
}

const { PATCH: usersIdPatch } = mount(usersIdDef, { surface: 'v1' });

/** Sets `isAdmin` on `userId` through the REAL PATCH /api/v1/users/{id} route. */
async function setAdminViaRealRoute(userId: string, isAdmin: boolean): Promise<number> {
    const url = new URL(`http://localhost/api/v1/users/${userId}`);
    const event = {
        ...baseEventFields(() => '127.0.0.1'),
        request: new Request(url, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ isAdmin }),
        }),
        url,
        params: { id: userId },
        locals: { principal: isAdmin ? operatorPrincipalAdmin() : operatorPrincipalNonAdmin() },
    } as unknown as RequestEvent;
    const response = await usersIdPatch!(event);
    return response.status;
}

async function getServiceTokenNarrowState(id: number): Promise<{
    force_non_admin: boolean;
    force_non_admin_narrowed_at: Date | null;
    force_non_admin_narrowed_by_target: boolean;
    force_non_admin_narrowed_by_creator: boolean;
}> {
    const sql = getTestDb();
    const [row] = await sql<
        Array<{
            force_non_admin: boolean;
            force_non_admin_narrowed_at: Date | null;
            force_non_admin_narrowed_by_target: boolean;
            force_non_admin_narrowed_by_creator: boolean;
        }>
    >`
        SELECT force_non_admin, force_non_admin_narrowed_at,
               force_non_admin_narrowed_by_target, force_non_admin_narrowed_by_creator
        FROM service_tokens WHERE id = ${id}
    `;
    return row;
}

// ── Fixture 9 helpers (X1): remove/add a member through the REAL v1 route ───

/** Removes an addressed member through the real, bodyless v1 DELETE. */
async function removeMemberViaRealRoute(groupId: string, userId: string): Promise<number> {
    const url = new URL(`http://localhost/api/v1/access/groups/${groupId}/members/${userId}`);
    const event = {
        ...baseEventFields(() => '127.0.0.1'),
        request: new Request(url, {
            method: 'DELETE',
        }),
        url,
        params: { id: groupId, userId },
        locals: { principal: operatorPrincipalAdmin() },
    } as unknown as RequestEvent;
    const response = await accessGroupMembersDelete!(event);
    return response.status;
}

/** Attempts to PUT a member add to `groupId` using a REAL Bearer token (own PAT). */
async function addMemberViaOwnToken(
    token: string,
    groupId: string,
    userId: string,
): Promise<Response> {
    const url = new URL(`http://localhost/api/v1/access/groups/${groupId}/members/${userId}`);
    const request = new Request(url, {
        method: 'PUT',
        headers: { authorization: `Bearer ${token}` },
    });
    const event = {
        ...baseEventFields(() => '127.0.0.1'),
        request,
        url,
        params: { id: groupId, userId },
        locals: {},
    } as unknown as RequestEvent;
    const authResult = await resolveAuth(event, noopMigration, true);
    if (authResult) return authResult;
    return accessGroupMembersPut!(event);
}

/** Attempts to PUT a member add to `groupId` using a manually-built (non-token) Principal. */
async function addMemberViaPrincipal(
    principal: ReturnType<typeof buildPrincipal>,
    groupId: string,
    userId: string,
): Promise<Response> {
    const url = new URL(`http://localhost/api/v1/access/groups/${groupId}/members/${userId}`);
    const event = {
        ...baseEventFields(() => '127.0.0.1'),
        request: new Request(url, {
            method: 'PUT',
        }),
        url,
        params: { id: groupId, userId },
        locals: { principal },
    } as unknown as RequestEvent;
    return accessGroupMembersPut!(event);
}

// ── Fixture 10 helper (X2): a /api/v1 {kind:'scope'} route reached via resolveAuth ──

async function legATaskRun(token: string): Promise<{ event: RequestEvent; response: Response }> {
    const taskId = '__seam_fixture10_missing_task__';
    const url = new URL(`http://localhost/api/v1/tasks/${taskId}/run`);
    const request = new Request(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({}),
    });
    const event = {
        ...baseEventFields(() => '127.0.0.1'),
        request,
        url,
        params: { taskId },
        locals: {},
    } as unknown as RequestEvent;
    const authResult = await resolveAuth(event, noopMigration, true);
    if (authResult) return { event, response: authResult };
    const response = await v1TaskRun.POST!(event);
    return { event, response };
}

describe('cross-surface Bearer seam: /api/v1 vs /api/admin/* verdicts for one credential', () => {
    let deviceAuthSpy: MockInstance;

    beforeAll(() => {
        // Every fixture below needs the /api/v1 leg reachable at all — see
        // rotate-v1.c4-demoted-admin-pat.integration.test.ts's identical
        // comment. Fixture 6 overrides this locally to `false`.
        deviceAuthSpy = vi.spyOn(features, 'deviceAuth', 'get').mockReturnValue(true);
    });

    afterAll(() => {
        vi.restoreAllMocks();
    });

    // =========================================================================
    // Fixture 1: unpinned non-admin + in-app `admin` capability, ['admin'] PAT
    //   -> admin on every leg (C6; GREEN after Task 1).
    // =========================================================================
    describe('fixture 1: unpinned + in-app admin capability -> admin everywhere', () => {
        let userId: string;
        let token: string;

        beforeAll(async () => {
            const username = `itest_seam_f1_${randomUUID().slice(0, 8)}`;
            userId = await insertUser({
                username,
                isAdmin: false,
                adminPinned: false,
                groups: ['users'],
            });
            await addInAppAdmin(userId, 'itest_seam_f1_group');
            const pat = await mintPat(userId, ['admin']);
            token = pat.token;
        });

        it('leg (a) /api/v1: admin', async () => {
            const { event, response } = await legA(token);
            expect(event.locals.principal?.isAdmin).toBe(true);
            expect(event.locals.principal?.userId).toBe(userId);
            expect(response.status).not.toBe(403);
        });

        it('leg (b) /api/admin TERTIARY: admin', async () => {
            const { event, response, authResultUndefined, principalBeforeMount } =
                await legB(token);
            expect(authResultUndefined).toBe(true);
            expect(principalBeforeMount).toBeUndefined();
            expect(event.locals.principal?.isAdmin).toBe(true);
            expect(event.locals.principal?.userId).toBe(userId);
            expect(response.status).not.toBe(403);
        });

        it('leg (c) requireAdmin: admin', async () => {
            const { event, response } = await legC(token);
            expect(event.locals.principal?.isAdmin).toBe(true);
            expect(event.locals.principal?.userId).toBe(userId);
            expect(response.status).not.toBe(403);
        });

        it('leg (d) callerIsAdmin: admin', async () => {
            const { isAdmin } = await legD(token);
            expect(isAdmin).toBe(true);
        });

        it('leg (e) {kind:scope} authenticate(): admin', async () => {
            const { event } = await legE(token);
            expect(event.locals.principal?.isAdmin).toBe(true);
            expect(event.locals.principal?.userId).toBe(userId);
        });
    });

    // =========================================================================
    // Fixture 2: pinned-demoted + in-app `admin` capability, ['admin'] PAT
    //   -> non-admin on every leg (guard — the pin must beat the in-app term).
    // =========================================================================
    describe('fixture 2: pinned-demoted + in-app admin capability -> non-admin everywhere', () => {
        let userId: string;
        let token: string;

        beforeAll(async () => {
            const username = `itest_seam_f2_${randomUUID().slice(0, 8)}`;
            // Stale admin group present too: the guard must show the PIN beats
            // BOTH the stale group AND the in-app capability.
            userId = await insertUser({
                username,
                isAdmin: false,
                adminPinned: true,
                groups: [ADMIN_GROUP],
            });
            await addInAppAdmin(userId, 'itest_seam_f2_group');
            const pat = await mintPat(userId, ['admin']);
            token = pat.token;
        });

        it('leg (a) /api/v1: denied', async () => {
            const { event, response } = await legA(token);
            expect(event.locals.principal?.isAdmin).toBe(false);
            expect(response.status).toBe(403);
        });

        it('leg (b) /api/admin TERTIARY: denied', async () => {
            const { event, response, authResultUndefined, principalBeforeMount } =
                await legB(token);
            expect(authResultUndefined).toBe(true);
            expect(principalBeforeMount).toBeUndefined();
            expect(event.locals.principal?.isAdmin).toBe(false);
            expect(response.status).toBe(403);
        });

        it('leg (c) requireAdmin: denied', async () => {
            const { event, response } = await legC(token);
            expect(event.locals.principal?.isAdmin).toBe(false);
            expect(response.status).toBe(403);
        });

        it('leg (d) callerIsAdmin: denied', async () => {
            const { isAdmin } = await legD(token);
            expect(isAdmin).toBe(false);
        });

        // {kind:'scope'} gates used to grant on the token's raw 'admin'
        // string alone, regardless of the owner's admin status. Since
        // 2026-10-02 authenticate() strips admin-class scopes when the owner
        // is not currently admin (stripsAdminScopesForToken() in
        // principal.ts, shared with buildPrincipal()), so the pin-demoted
        // owner's ['admin'] PAT is refused at the scope gate and no identity
        // is materialised (the C20 fallback only runs on a grant).
        it('leg (e) {kind:scope} authenticate(): denied (demoted owner keeps no admin-class scope)', async () => {
            const { event, response } = await legE(token);
            expect(response.status).toBe(403);
            expect(event.locals.principal).toBeUndefined();
        });
    });

    // =========================================================================
    // Fixture 3 (C1): non-admin target, still-admin creator, impersonating
    //   svc token -> non-admin everywhere; principal.userId is the TARGET's.
    // =========================================================================
    describe('fixture 3 (C1): impersonating svc token judged by creator, not target', () => {
        let targetId: string;
        let token: string;

        beforeAll(async () => {
            const creatorUsername = `itest_seam_f3_creator_${randomUUID().slice(0, 8)}`;
            const targetUsername = `itest_seam_f3_target_${randomUUID().slice(0, 8)}`;
            await insertUser({
                username: creatorUsername,
                isAdmin: true,
                adminPinned: true,
                groups: [ADMIN_GROUP],
            });
            targetId = await insertUser({
                username: targetUsername,
                isAdmin: false,
                adminPinned: false,
                groups: ['users'],
            });
            const svc = await mintServiceToken({
                createdBy: creatorUsername,
                actAsUser: targetId,
                scopes: ['admin'],
            });
            token = svc.token;
        });

        it('leg (a) /api/v1: already judges the target (GREEN)', async () => {
            const { event, response } = await legA(token);
            expect(event.locals.principal?.isAdmin).toBe(false);
            expect(event.locals.principal?.userId).toBe(targetId);
            expect(response.status).toBe(403);
        });

        // fix-plan-5 Task 3 (C1 fixed): resolveBearerAdminPrincipal() now
        // resolves an impersonating service token's identity through the
        // SAME shared token-identity.ts producer /api/v1 uses, which judges
        // the TARGET (act_as_user), never the creator.
        it('leg (b) /api/admin TERTIARY: must judge the target, not the creator', async () => {
            const { event, response, authResultUndefined, principalBeforeMount } =
                await legB(token);
            expect(authResultUndefined).toBe(true);
            expect(principalBeforeMount).toBeUndefined();
            expect(event.locals.principal?.isAdmin).toBe(false);
            expect(event.locals.principal?.userId).toBe(targetId);
            expect(response.status).toBe(403);
        });

        it('leg (c) requireAdmin: must judge the target, not the creator', async () => {
            const { event, response } = await legC(token);
            expect(event.locals.principal?.isAdmin).toBe(false);
            expect(event.locals.principal?.userId).toBe(targetId);
            expect(response.status).toBe(403);
        });

        // The route guard materialises the target principal before the ceiling.
        it('leg (d) callerIsAdmin: must judge the target, not the creator', async () => {
            const { isAdmin } = await legD(token);
            expect(isAdmin).toBe(false);
        });

        // Judged by the TARGET: a non-admin target means the ['admin'] scope
        // is stripped (2026-10-02, stripsAdminScopesForToken()), so the
        // scope gate refuses it outright — before 2026-10-02 it granted on
        // the raw 'admin' string and only the materialised principal showed
        // the target's non-admin verdict.
        it('leg (e) {kind:scope} authenticate(): judges the target — denied', async () => {
            const { event, response } = await legE(token);
            expect(response.status).toBe(403);
            expect(event.locals.principal).toBeUndefined();
        });
    });

    // =========================================================================
    // Fixture 3b (C1 guard): impersonating svc token whose TARGET is ALSO an
    // admin (creator admin too) -> admin on every leg; where a principal
    // exists, principal.userId is the TARGET's. This is the counterpart to
    // fixture 3: it stops a Task 3 fix that simply denies EVERY impersonating
    // token (over-correcting C1) from silently passing, because legs (a)/(e)
    // already grant admin here today and must keep doing so, and because
    // `isAdmin` alone cannot tell "judges the creator" apart from "judges the
    // target" when BOTH are admin — only `userId` can, which is exactly what
    // legs (b)/(c) still get wrong today (creator's id instead of target's).
    // =========================================================================
    describe('fixture 3b (C1 guard): impersonating svc token, target ALSO admin', () => {
        let creatorId: string;
        let targetId: string;
        let token: string;

        beforeAll(async () => {
            const creatorUsername = `itest_seam_f3b_creator_${randomUUID().slice(0, 8)}`;
            const targetUsername = `itest_seam_f3b_target_${randomUUID().slice(0, 8)}`;
            creatorId = await insertUser({
                username: creatorUsername,
                isAdmin: true,
                adminPinned: true,
                groups: [ADMIN_GROUP],
            });
            targetId = await insertUser({
                username: targetUsername,
                isAdmin: true,
                adminPinned: true,
                groups: [ADMIN_GROUP],
            });
            const svc = await mintServiceToken({
                createdBy: creatorUsername,
                actAsUser: targetId,
                scopes: ['admin'],
            });
            token = svc.token;
        });

        it('leg (a) /api/v1: admin, judges the target — GREEN', async () => {
            const { event, response } = await legA(token);
            expect(event.locals.principal?.isAdmin).toBe(true);
            expect(event.locals.principal?.userId).toBe(targetId);
            expect(response.status).not.toBe(403);
        });

        // isAdmin is trivially true either way (both creator and target are
        // admin) — the C1 symptom only shows up in WHICH user's id comes
        // back. Fixed by fix-plan-5 Task 3 (see fixture 3's legs above).
        it('leg (b) /api/admin TERTIARY: userId must be the target, not the creator', async () => {
            const { event, response, authResultUndefined, principalBeforeMount } =
                await legB(token);
            expect(authResultUndefined).toBe(true);
            expect(principalBeforeMount).toBeUndefined();
            expect(event.locals.principal?.isAdmin).toBe(true);
            expect(event.locals.principal?.userId).toBe(targetId);
            expect(response.status).not.toBe(403);
        });

        it('leg (c) requireAdmin: userId must be the target, not the creator', async () => {
            const { event, response } = await legC(token);
            expect(event.locals.principal?.isAdmin).toBe(true);
            expect(event.locals.principal?.userId).toBe(targetId);
            expect(response.status).not.toBe(403);
        });

        // callerIsAdmin() only returns a boolean (no userId observable), and
        // that boolean is CORRECT here regardless of the C1 bug — both the
        // creator and the target are admin, so this cell is GREEN today. A
        // future fix that denies every impersonating token outright would
        // break this cell, which is the guard's purpose.
        it('leg (d) callerIsAdmin: admin (guard — a C1 fix must not deny this)', async () => {
            const { isAdmin } = await legD(token);
            expect(isAdmin).toBe(true);
        });

        it('leg (e) {kind:scope} authenticate(): admin, judges the target — GREEN', async () => {
            const { event } = await legE(token);
            expect(event.locals.principal?.isAdmin).toBe(true);
            expect(event.locals.principal?.userId).toBe(targetId);
        });

        it('sanity: creator and target are different users', () => {
            expect(creatorId).not.toBe(targetId);
        });
    });

    // =========================================================================
    // Fixture 4 (C2): svc token scoped to a v1 path prefix -> allowed on (a)
    //   GET, denied on every /api/admin leg and on a non-GET.
    // =========================================================================
    describe('fixture 4 (C2): path/method envelope ignored on /api/admin', () => {
        let token: string;

        beforeAll(async () => {
            const creatorUsername = `itest_seam_f4_creator_${randomUUID().slice(0, 8)}`;
            await insertUser({
                username: creatorUsername,
                isAdmin: true,
                adminPinned: true,
                groups: [ADMIN_GROUP],
            });
            const svc = await mintServiceToken({
                createdBy: creatorUsername,
                scopes: ['admin'],
                allowedPathPrefixes: [V1_PATH],
                allowedMethods: ['GET'],
            });
            token = svc.token;
        });

        it('leg (a) /api/v1 GET: allowed (matches the envelope) — GREEN', async () => {
            const { event, response } = await legA(token);
            expect(event.locals.principal?.isAdmin).toBe(true);
            expect(response.status).not.toBe(403);
        });

        // /api/v1 answers a method outside the token's envelope as a 403 problem+json
        // (`forbidden`, reason `method_not_permitted`) since the fresh-eyes error-envelope
        // change: one error shape, the denial itself unchanged.
        it('leg (a) /api/v1 POST: denied by method (403 method_not_permitted) — already enforced, GREEN', async () => {
            const { response } = await legA(token, { method: 'POST' });
            expect(response.status).toBe(403);
            const body = (await response.json()) as { code?: string; reason?: string };
            expect(body).toMatchObject({ code: 'forbidden', reason: 'method_not_permitted' });
        });

        // fix-plan-5 Task 3 (C2 fixed): RBP now runs the shared envelope gate
        // (token-identity.ts's tokenEnvelopeDenial(), reached from step 1)
        // before any identity work, so an out-of-envelope service token
        // resolves to `null` here — same as an invalid/absent credential.
        //
        // Reviewer fix-round-1 tightening: a bare `status===403` cannot tell
        // an envelope denial apart from any OTHER 403 mount.ts's admin arm
        // can produce. Distinguish by asserting the SPECIFIC mechanism —
        // `resolveBearerAdminPrincipal` returned `null`, so mount.ts's
        // `case 'admin'` branch never entered its `if (bearerPrincipal)`
        // block at all and `event.locals.principal` was never materialised
        // (a resolved-but-non-admin Principal, by contrast, WOULD be
        // materialised before its own 403 — see fixture 2's leg (b)).
        // In-fixture discriminator (Task 3 review Minor 6): `locals.principal`
        // being undefined proves RBP returned null, but not WHY. Prove the
        // SPECIFIC mechanism by calling the same tokenEnvelopeDenial() the
        // shared producer runs, directly on this token's minted envelope and
        // the leg's actual target path/method — it must return a PATH denial
        // (this fixture's envelope is a v1-only prefix, so a mismatched
        // /api/admin/* path always misses on the path check, never the
        // method check).
        it('leg (b) /api/admin TERTIARY: must be denied by the envelope', async () => {
            const envelopeVerdict = tokenEnvelopeDenial(
                { allowedPathPrefixes: [V1_PATH], allowedMethods: ['GET'] },
                new URL(INTERNAL_URL).pathname,
                'GET',
            );
            expect(envelopeVerdict).toEqual({
                status: 403,
                error: 'Token not permitted on this endpoint',
            });

            const { response, authResultUndefined, principalBeforeMount, event } =
                await legB(token);
            expect(authResultUndefined).toBe(true);
            expect(principalBeforeMount).toBeUndefined();
            expect(response.status).toBe(403);
            expect(event.locals.principal).toBeUndefined();
        });

        it('leg (c) requireAdmin: must be denied by the envelope', async () => {
            const envelopeVerdict = tokenEnvelopeDenial(
                { allowedPathPrefixes: [V1_PATH], allowedMethods: ['GET'] },
                new URL(DEPCHECK_URL).pathname,
                'GET',
            );
            expect(envelopeVerdict).toEqual({
                status: 403,
                error: 'Token not permitted on this endpoint',
            });

            const { response, event } = await legC(token);
            expect(response.status).toBe(403);
            // Same distinguishing assertion as leg (b) — see that leg's comment.
            expect(event.locals.principal).toBeUndefined();
        });

        // The route guard enforces the envelope before the ceiling can run.
        it('leg (d) callerIsAdmin: must be denied by the envelope', async () => {
            const { isAdmin } = await legD(token);
            expect(isAdmin).toBe(false);
        });

        it('leg (e) {kind:scope} authenticate(): already denied by the envelope — GREEN', async () => {
            const { response } = await legE(token);
            expect(response.status).toBe(403);
        });
    });

    // =========================================================================
    // Fixture 5: svc token restricted to allowedIps:['127.0.0.1'].
    //   Allowed peer -> admin everywhere. Disallowed peer -> denied everywhere.
    // =========================================================================
    describe('fixture 5: IP-restricted svc token', () => {
        let token: string;
        const allowedPeer = () => '127.0.0.1';
        const disallowedPeer = () => '10.9.9.9';

        beforeAll(async () => {
            const creatorUsername = `itest_seam_f5_creator_${randomUUID().slice(0, 8)}`;
            await insertUser({
                username: creatorUsername,
                isAdmin: true,
                adminPinned: true,
                groups: [ADMIN_GROUP],
            });
            const svc = await mintServiceToken({
                createdBy: creatorUsername,
                scopes: ['admin'],
                allowedIps: ['127.0.0.1'],
            });
            token = svc.token;
        });

        describe('peer 127.0.0.1 (allowed)', () => {
            it('leg (a) /api/v1: admin — GREEN (clientIp passed correctly today)', async () => {
                const { event, response } = await legA(token, { getClientAddress: allowedPeer });
                expect(event.locals.principal?.isAdmin).toBe(true);
                expect(response.status).not.toBe(403);
            });

            // Fixed by fix-plan-5 Task 3: every plane now calls
            // getClientIpStrict(event) once and passes it into
            // token-identity.ts's validateBearerCredential(), which forwards
            // it to `validate()` — an allowed peer is honoured everywhere.
            // Asserting only `status !== 403` would ALSO pass on a 401/500 (a
            // denial that just isn't a 403), so assert the actual identity
            // verdict instead, as fixture 1 and this fixture's leg (a) do.
            it('leg (b) /api/admin TERTIARY: must be admin', async () => {
                const { event, response, authResultUndefined, principalBeforeMount } = await legB(
                    token,
                    { getClientAddress: allowedPeer },
                );
                expect(authResultUndefined).toBe(true);
                expect(principalBeforeMount).toBeUndefined();
                expect(event.locals.principal?.isAdmin).toBe(true);
                expect(response.status).not.toBe(403);
            });

            it('leg (c) requireAdmin: must be admin', async () => {
                const { event, response } = await legC(token, { getClientAddress: allowedPeer });
                expect(event.locals.principal?.isAdmin).toBe(true);
                expect(response.status).not.toBe(403);
            });

            it('leg (d) callerIsAdmin: must be admin', async () => {
                const { isAdmin } = await legD(token, { getClientAddress: allowedPeer });
                expect(isAdmin).toBe(true);
            });

            it('leg (e) {kind:scope} authenticate(): must resolve admin', async () => {
                const { event } = await legE(token, { getClientAddress: allowedPeer });
                expect(event.locals.principal?.isAdmin).toBe(true);
            });
        });

        describe('peer 10.9.9.9 (disallowed)', () => {
            it('leg (a) /api/v1: denied 401 (invalid_token — IP not allowed) — GREEN', async () => {
                const { event, response } = await legA(token, { getClientAddress: disallowedPeer });
                expect(response.status).toBe(401);
                expect(event.locals.principal).toBeUndefined();
            });

            it("leg (b) /api/admin TERTIARY: denied 403 — GREEN (clientIp correctly reaches validate(), which rejects the disallowed peer; RBP collapses any step-1 denial to null, which mount.ts's TERTIARY renders as 403 regardless of the underlying reason)", async () => {
                const { response, authResultUndefined, principalBeforeMount } = await legB(token, {
                    getClientAddress: disallowedPeer,
                });
                expect(authResultUndefined).toBe(true);
                expect(principalBeforeMount).toBeUndefined();
                expect(response.status).toBe(403);
            });

            it('leg (c) requireAdmin: denied — GREEN', async () => {
                const { response } = await legC(token, { getClientAddress: disallowedPeer });
                expect(response.status).toBe(403);
            });

            it('leg (d) callerIsAdmin: denied — GREEN', async () => {
                const { isAdmin } = await legD(token, { getClientAddress: disallowedPeer });
                expect(isAdmin).toBe(false);
            });

            it('leg (e) {kind:scope} authenticate(): denied 401 (clientIp correctly reaches validate(), which rejects the disallowed peer) — GREEN', async () => {
                const { event, response } = await legE(token, { getClientAddress: disallowedPeer });
                expect(response.status).toBe(401);
                expect(event.locals.principal).toBeUndefined();
            });
        });
    });

    // =========================================================================
    // Fixture 6: features.deviceAuth spied false.
    //   (a) 503 today (unrelated to Task 4). (b)-(e): after Task 4 the /api/admin
    //   Bearer exception must not be taken, so the SAME production entry point
    //   (resolveAuth()) that fronts every one of these legs in a real deployment
    //   must deny with 401 instead of passing through undecoded.
    // =========================================================================
    describe('fixture 6: features.deviceAuth off gates the /api/admin Bearer exception', () => {
        let token: string;

        beforeAll(async () => {
            const username = `itest_seam_f6_${randomUUID().slice(0, 8)}`;
            const userId = await insertUser({
                username,
                isAdmin: true,
                adminPinned: true,
                groups: [ADMIN_GROUP],
            });
            const pat = await mintPat(userId, ['admin']);
            token = pat.token;
            deviceAuthSpy.mockReturnValue(false);
        });

        afterAll(() => {
            deviceAuthSpy.mockReturnValue(true);
        });

        it('leg (a) /api/v1: 503 (public API disabled) — GREEN, unrelated to Task 4', async () => {
            const response = await resolveOnly(V1_URL, token);
            expect(response).toBeInstanceOf(Response);
            expect((response as Response).status).toBe(503);
        });

        it('leg (b) /api/admin TERTIARY URL: resolveAuth() must deny (401)', async () => {
            const response = await resolveOnly(INTERNAL_URL, token);
            expect(response).toBeInstanceOf(Response);
            expect((response as Response).status).toBe(401);
        });

        // Same single gate fronts every /api/admin/* path in production
        // (hooks.server.ts's handle hook), including the ones requireAdmin()
        // guards, so proving resolveAuth() denies this URL proves the leg.
        it('leg (c) requireAdmin URL: resolveAuth() must deny (401)', async () => {
            const response = await resolveOnly(DEPCHECK_URL, token);
            expect(response).toBeInstanceOf(Response);
            expect((response as Response).status).toBe(401);
        });

        it('leg (d) callerIsAdmin URL: resolveAuth() must deny (401)', async () => {
            const response = await resolveOnly(PATS_URL, token);
            expect(response).toBeInstanceOf(Response);
            expect((response as Response).status).toBe(401);
        });

        it('leg (e) {kind:scope} URL: resolveAuth() must deny (401)', async () => {
            const response = await resolveOnly(LOCK_METRICS_URL, token);
            expect(response).toBeInstanceOf(Response);
            expect((response as Response).status).toBe(401);
        });
    });

    // =========================================================================
    // Fixture 7 (fix-plan-5 Task 4, Q8): a service token impersonating a
    // STILL-admin colleague must be narrowed when its CREATOR is demoted —
    // arm 2 of markAdminScopedForceNonAdminImpersonating() used to require
    // `act_as_user IS NULL`, so this relationship was never narrowed at all
    // (outage-class gap: the token kept full admin authority on both planes
    // forever). A second, independently-demoted token must stay narrowed
    // when only ONE of its two narrowing reasons is cleared (migration
    // 16.263.0's reason flags) — re-promoting the creator alone must not
    // un-narrow a token whose impersonation TARGET is still demoted.
    // =========================================================================
    describe('fixture 7: demoted creator narrows an impersonating token (Q8); independent narrowing reasons do not cross-restore', () => {
        let userIdA: string;
        let userIdB: string;
        let userIdC: string;
        let tokenT1: string;
        let idT1: number;
        let tokenT2: string;
        let idT2: number;

        beforeAll(async () => {
            const suffix = randomUUID().slice(0, 8);
            const usernameA = `itest_seam_f7_a_${suffix}`;
            const usernameB = `itest_seam_f7_b_${suffix}`;
            const usernameC = `itest_seam_f7_c_${suffix}`;
            userIdA = await insertUser({
                username: usernameA,
                isAdmin: true,
                adminPinned: true,
                groups: [ADMIN_GROUP],
            });
            userIdB = await insertUser({
                username: usernameB,
                isAdmin: true,
                adminPinned: true,
                groups: [ADMIN_GROUP],
            });
            userIdC = await insertUser({
                username: usernameC,
                isAdmin: true,
                adminPinned: true,
                groups: [ADMIN_GROUP],
            });

            // T1: created by A, impersonates B (still admin throughout).
            const t1 = await mintServiceToken({
                createdBy: usernameA,
                actAsUser: userIdB,
                scopes: ['admin'],
            });
            tokenT1 = t1.token;
            idT1 = t1.id;

            // T2: created by A, impersonates C — C is demoted INDEPENDENTLY
            // of A, so T2's narrowing reason is the TARGET relationship, not
            // the creator relationship A's own demotion sets.
            const t2 = await mintServiceToken({
                createdBy: usernameA,
                actAsUser: userIdC,
                scopes: ['admin'],
            });
            tokenT2 = t2.token;
            idT2 = t2.id;
        });

        it('sanity: both tokens are admin on both planes before any demotion', async () => {
            for (const token of [tokenT1, tokenT2]) {
                const a = await legA(token);
                expect(a.event.locals.principal?.isAdmin).toBe(true);
                const b = await legB(token);
                expect(b.event.locals.principal?.isAdmin).toBe(true);
            }
        });

        it('demoting C (the target of T2 only) narrows T2 but leaves T1 untouched', async () => {
            const status = await setAdminViaRealRoute(userIdC, false);
            expect(status).toBe(200);

            const t2Row = await getServiceTokenNarrowState(idT2);
            expect(t2Row.force_non_admin).toBe(true);
            expect(t2Row.force_non_admin_narrowed_at).not.toBeNull();
            const t2LegA = await legA(tokenT2);
            expect(t2LegA.event.locals.principal?.isAdmin).toBe(false);
            // TERTIARY: resolveBearerAdminPrincipal() short-circuits to `null`
            // for a forceNonAdmin token (resolve-bearer-principal.ts:107-109)
            // — no principal is materialised at all, same as fixture 4's
            // envelope-denial cell.
            const t2LegB = await legB(tokenT2);
            expect(t2LegB.event.locals.principal).toBeUndefined();
            expect(t2LegB.response.status).toBe(403);

            const t1Row = await getServiceTokenNarrowState(idT1);
            expect(t1Row.force_non_admin).toBe(false);
            const t1LegA = await legA(tokenT1);
            expect(t1LegA.event.locals.principal?.isAdmin).toBe(true);
        });

        it('demoting A (the CREATOR of both, impersonating a STILL-admin B for T1) narrows T1 too — the Q8 outage-class fix', async () => {
            const status = await setAdminViaRealRoute(userIdA, false);
            expect(status).toBe(200);

            // T1's target B is STILL admin — before this fix, arm 2 required
            // `act_as_user IS NULL` and never matched T1 at all, so T1 stayed
            // admin on both planes forever despite its creator's demotion.
            const t1Row = await getServiceTokenNarrowState(idT1);
            expect(t1Row.force_non_admin).toBe(true);
            expect(t1Row.force_non_admin_narrowed_at).not.toBeNull();
            const t1LegA = await legA(tokenT1);
            expect(t1LegA.event.locals.principal?.isAdmin).toBe(false);
            const t1LegB = await legB(tokenT1);
            expect(t1LegB.event.locals.principal).toBeUndefined();
            expect(t1LegB.response.status).toBe(403);

            // T2 remains narrowed (it already was, via C's demotion).
            const t2Row = await getServiceTokenNarrowState(idT2);
            expect(t2Row.force_non_admin).toBe(true);
        });

        it('re-promoting A restores T1 (target B still admin) but T2 STAYS narrowed (target C still demoted)', async () => {
            const status = await setAdminViaRealRoute(userIdA, true);
            expect(status).toBe(200);

            // T1: A was its ONLY narrowing reason (creator) — fully cleared.
            const t1Row = await getServiceTokenNarrowState(idT1);
            expect(t1Row.force_non_admin).toBe(false);
            expect(t1Row.force_non_admin_narrowed_at).toBeNull();
            const t1LegA = await legA(tokenT1);
            expect(t1LegA.event.locals.principal?.isAdmin).toBe(true);
            const t1LegB = await legB(tokenT1);
            expect(t1LegB.event.locals.principal?.isAdmin).toBe(true);

            // T2: A's promotion clears only the CREATOR reason. C (the
            // TARGET) is still demoted, so T2 must stay narrowed — this is
            // the case a naive mirrored restore (no reason tracking) gets
            // wrong: it would blindly clear force_non_admin here because T2
            // also matches `created_by = A`, silently restoring admin
            // authority to a token whose impersonation target is still
            // demoted.
            const t2Row = await getServiceTokenNarrowState(idT2);
            expect(t2Row.force_non_admin).toBe(true);
            expect(t2Row.force_non_admin_narrowed_at).not.toBeNull();
            const t2LegA = await legA(tokenT2);
            expect(t2LegA.event.locals.principal?.isAdmin).toBe(false);
            const t2LegB = await legB(tokenT2);
            expect(t2LegB.event.locals.principal).toBeUndefined();
            expect(t2LegB.response.status).toBe(403);
        });

        it('re-promoting C (the last remaining narrowing reason) fully restores T2', async () => {
            const status = await setAdminViaRealRoute(userIdC, true);
            expect(status).toBe(200);

            const t2Row = await getServiceTokenNarrowState(idT2);
            expect(t2Row.force_non_admin).toBe(false);
            expect(t2Row.force_non_admin_narrowed_at).toBeNull();
            const t2LegA = await legA(tokenT2);
            expect(t2LegA.event.locals.principal?.isAdmin).toBe(true);
            // Fix round 1, Minor g: assert BOTH planes, matching every other
            // case in this fixture — legA alone doesn't prove the TERTIARY
            // plane agrees.
            const t2LegB = await legB(tokenT2);
            expect(t2LegB.event.locals.principal?.isAdmin).toBe(true);
        });
    });

    // =========================================================================
    // Fixture 9 (X1 blocker chain): an in-app-only admin with an ['admin'] PAT
    //   is removed from the group through the production path (the real v1
    //   DELETE /access/groups/{id}/members route) -> the PAT is non-admin on
    //   every leg AND re-adding themselves is denied, both via their own
    //   (now-narrowed) token and via a separate non-admin access:admin
    //   delegate (the X1a ceiling).
    // =========================================================================
    describe('fixture 9 (X1): removing an in-app-only admin narrows their PAT and blocks self-re-escalation', () => {
        let userId: string;
        let username: string;
        let groupId: string;
        let token: string;

        beforeAll(async () => {
            // Another pinned admin so removeMember's last-admin guard never
            // blocks this fixture's removal, regardless of which other
            // fixtures' beforeAll blocks did or didn't run (e.g. a filtered
            // `-t` run of this fixture alone).
            await insertUser({
                username: `itest_seam_f9_other_admin_${randomUUID().slice(0, 8)}`,
                isAdmin: true,
                adminPinned: true,
                groups: [ADMIN_GROUP],
            });
            username = `itest_seam_f9_${randomUUID().slice(0, 8)}`;
            userId = await insertUser({
                username,
                isAdmin: false,
                adminPinned: false,
                groups: ['users'],
            });
            groupId = await addInAppAdmin(userId, 'itest_seam_f9_group');
            const pat = await mintPat(userId, ['admin']);
            token = pat.token;
        });

        it('sanity: admin on every leg before removal', async () => {
            const a = await legA(token);
            expect(a.event.locals.principal?.isAdmin).toBe(true);
            const b = await legB(token);
            expect(b.event.locals.principal?.isAdmin).toBe(true);
        });

        it('removing the member through the real route narrows the PAT: non-admin on every leg', async () => {
            const status = await removeMemberViaRealRoute(groupId, userId);
            expect(status).toBe(204);

            const a = await legA(token);
            expect(a.event.locals.principal?.isAdmin).toBe(false);
            const b = await legB(token);
            // Same envelope-denial shape as fixtures 4/7: a forceNonAdmin
            // token short-circuits resolveBearerAdminPrincipal() to null.
            expect(b.event.locals.principal).toBeUndefined();
            expect(b.response.status).toBe(403);
        });

        it('re-adding themselves via their OWN (now-narrowed) token is denied', async () => {
            const response = await addMemberViaOwnToken(token, groupId, userId);
            expect(response.status).not.toBe(204);
            expect([401, 403]).toContain(response.status);
        });

        it('re-adding them via a SEPARATE non-admin access:admin delegate is denied by the X1a ceiling', async () => {
            const response = await addMemberViaPrincipal(
                operatorPrincipalAccessAdminOnly(),
                groupId,
                userId,
            );
            expect(response.status).toBe(403);
        });

        it('an ADMIN can still re-add them (control — the ceiling only blocks non-admins)', async () => {
            const response = await addMemberViaPrincipal(operatorPrincipalAdmin(), groupId, userId);
            expect(response.status).toBe(204);
        });
    });

    // =========================================================================
    // Fixture 10 (X2): a narrowed ['admin'] PAT keeps admin-only AREA scopes
    //   (e.g. tasks:run) on /api/v1 via the expand-then-strip bug, while the
    //   /api/admin {kind:'scope'} leg already denies it (authenticate()
    //   strips the raw scopes). After the fix both legs deny equally.
    // =========================================================================
    describe("fixture 10 (X2): a narrowed ['admin'] token loses admin-only area scopes on /api/v1 too", () => {
        let token: string;
        let patId: number;

        beforeAll(async () => {
            const username = `itest_seam_f10_${randomUUID().slice(0, 8)}`;
            const userId = await insertUser({
                username,
                isAdmin: true,
                adminPinned: true,
                groups: [ADMIN_GROUP],
            });
            const pat = await mintPat(userId, ['admin']);
            token = pat.token;
            patId = pat.id;
            // Narrow directly — X2 is orthogonal to the narrowing TRIGGER,
            // already covered by fixture 7.
            await patService.markAdminScopedForceNonAdminForUser(toUserId(userId));
        });

        it('sanity: the PAT is force_non_admin-narrowed', async () => {
            const sql = getTestDb();
            const [row] = await sql<{ force_non_admin: boolean }[]>`
                SELECT force_non_admin FROM personal_access_tokens WHERE id = ${patId}
            `;
            expect(row.force_non_admin).toBe(true);
        });

        it('/api/v1 tasks:run-gated route denies the narrowed token', async () => {
            const { response } = await legATaskRun(token);
            expect(response.status).toBe(403);
        });

        it('/api/admin {kind:scope} metrics:read-gated route denies the narrowed token (already GREEN)', async () => {
            const { response } = await legE(token);
            expect(response.status).toBe(403);
        });
    });
});
