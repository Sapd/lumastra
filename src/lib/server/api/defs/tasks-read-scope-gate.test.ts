// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Scope-gate regression test for C2 + C5 (2026-09-18 fix-plan-4, Task 2).
 *
 * Before this task, `tasks:read` was auto-granted to every non-admin session
 * (`principal.ts`'s `expandScopes`, independently re-granted by
 * `tasks/api-auth.ts`'s `scopeGranted`). `defs/tasks/[taskId]/failures.ts` and
 * `defs/library/paths.ts` (among others) were gated on `tasks:read` alone,
 * so any logged-in non-admin user could reach them.
 *
 * This test drives the REAL auth chain — `buildPrincipal()` (principal.ts)
 * produces the Principal exactly as `forward-auth.ts` does for a plain
 * non-admin session (no token scopes → `['read','write']` → real
 * `expandScopes()`), and `mount()`'s `{kind:'scope'}` branch runs the REAL
 * `scopeGranted()` against it. Nothing here hand-builds or mocks the scope
 * array — that is the seam Global Constraint 2 requires and the one the
 * pre-existing `task-system-admin-scope.test.ts` (2026-09-12, C16) did NOT
 * use (it hard-codes `scopes: ['read','write','tasks:read']` as a literal,
 * which cannot regress against a change to `expandScopes()`).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { mount } from '$lib/server/api/mount.js';
import { buildPrincipal, expandScopes } from '$lib/server/api/principal.js';
import { scopeGranted } from '$lib/server/tasks/api-auth.js';

const mockGetDb = vi.fn();
vi.mock('$lib/server/database/connection.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/database/connection.js')>();
    return { ...actual, getDb: (...args: unknown[]) => mockGetDb(...args) };
});

const mockGetSql = vi.fn();
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: (...args: unknown[]) => mockGetSql(...args) },
}));

import { def as failuresDef } from './tasks/[taskId]/failures.js';
import { def as libraryPathsDef } from './library/paths.js';
// tasks/index.ts stays on `tasks:read` (not moved to `tasks:admin` — it has
// real UI consumers, per the ledger's Shape C ruling item 4), so it is the
// def whose security depends ENTIRELY on the auto-grant removal below, with
// no belt-and-braces endpoint-move masking a regression in that removal.
import { def as tasksListDef } from './tasks/index.js';

function makeEvent(principal: ReturnType<typeof buildPrincipal>): RequestEvent {
    const url = new URL('http://localhost/api/v1/tasks/some-task/failures');
    return {
        url,
        params: { taskId: 'some-task' },
        route: { id: '/api/v1/tasks/[taskId]/failures' as const },
        request: new Request(url.toString()),
        locals: {
            principal,
            user: {
                userId: principal.userId,
                username: principal.username,
                userGroups: principal.userGroups,
                ownerIsAdmin: principal.isAdmin,
                maxAgeRating: null,
            },
        },
        cookies: {} as RequestEvent['cookies'],
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

/** A plain, logged-in NON-admin forward-auth session — no token scopes at all. */
function nonAdminPrincipal() {
    return buildPrincipal({
        kind: 'forward_auth',
        userId: 'usr_1' as never,
        username: 'alice',
        userGroups: [],
        sessionIsAdmin: false,
    });
}

/** An admin session (real DB-authoritative admin verdict, not a token scope). */
function adminPrincipal() {
    return buildPrincipal({
        kind: 'forward_auth',
        userId: 'usr_admin' as never,
        username: 'root',
        userGroups: [],
        sessionIsAdmin: true,
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetDb.mockReturnValue(null);
    mockGetSql.mockResolvedValue(null);
});

describe('C2 — GET /api/v1/tasks/{id}/failures requires tasks:admin', () => {
    it('403s a plain non-admin session (real expandScopes() no longer grants tasks:read)', async () => {
        const principal = nonAdminPrincipal();
        // Sanity: prove the premise via the real expansion, not an assertion
        // about the response alone — a non-admin session's real scope set
        // must NOT contain tasks:read after this fix.
        expect(principal.scopes).not.toContain('tasks:read');

        const handlers = mount(failuresDef, { surface: 'v1' });
        const res = await handlers.GET!(makeEvent(principal));
        expect(res.status).toBe(403);
    });

    it('does not 403 an admin session', async () => {
        const handlers = mount(failuresDef, { surface: 'v1' });
        const res = await handlers.GET!(makeEvent(adminPrincipal()));
        expect(res.status).not.toBe(403);
    });
});

describe('C5 — GET /api/v1/library/paths requires tasks:admin', () => {
    it('403s a plain non-admin session', async () => {
        const handlers = mount(libraryPathsDef, { surface: 'v1' });
        const res = await handlers.GET!(makeEvent(nonAdminPrincipal()));
        expect(res.status).toBe(403);
    });

    it('does not 403 an admin session', async () => {
        const handlers = mount(libraryPathsDef, { surface: 'v1' });
        const res = await handlers.GET!(makeEvent(adminPrincipal()));
        expect(res.status).not.toBe(403);
    });
});

describe('Shape C load-bearing fix — GET /api/v1/tasks still on tasks:read', () => {
    // This def was deliberately NOT moved to tasks:admin (it has real
    // admin-UI consumers per the ledger). Its security therefore depends
    // entirely on tasks:read's auto-grant having been removed from BOTH
    // producers (principal.ts expandScopes AND tasks/api-auth.ts
    // scopeGranted) — no endpoint-move masks a regression here.
    it('403s a plain non-admin session', async () => {
        const handlers = mount(tasksListDef, { surface: 'v1' });
        const res = await handlers.GET!(makeEvent(nonAdminPrincipal()));
        expect(res.status).toBe(403);
    });

    it('does not 403 an admin session', async () => {
        const handlers = mount(tasksListDef, { surface: 'v1' });
        const res = await handlers.GET!(makeEvent(adminPrincipal()));
        expect(res.status).not.toBe(403);
    });
});

describe('brief step 7 — the transitive metrics:read grant closes as a side effect', () => {
    // `scopeGranted`'s `case 'metrics:read'` also honours a literal
    // `tasks:read` in the token scopes (tasks:admin/tasks:read both grant
    // metrics:read — see api-auth.ts). Before this task, a plain non-admin
    // session's real expanded scopes contained `tasks:read`, so it
    // transitively reached /metrics, /api/health/components and
    // /api/tasks/{metrics,trends}. Proven via the REAL expandScopes() +
    // scopeGranted() chain, not a restated assertion about the code.
    it('a plain non-admin session no longer satisfies metrics:read', () => {
        const nonAdminExpanded = expandScopes(['read', 'write']);
        expect(scopeGranted(nonAdminExpanded, 'metrics:read')).toBe(false);
    });

    it('tasks:admin still satisfies metrics:read (not over-corrected)', () => {
        const taskAdminExpanded = expandScopes(['tasks:admin']);
        expect(scopeGranted(taskAdminExpanded, 'metrics:read')).toBe(true);
    });

    it('the coarse admin scope still satisfies metrics:read', () => {
        const adminExpanded = expandScopes(['admin']);
        expect(scopeGranted(adminExpanded, 'metrics:read')).toBe(true);
    });
});
