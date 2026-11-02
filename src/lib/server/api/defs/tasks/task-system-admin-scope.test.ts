// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Scope-boundary regression test for security review 2026-09-12, C16.
 *
 * `tasks:read` is auto-granted by the coarse `read` scope, which every
 * logged-in session (and any `read`-scoped PAT, when FEATURE_USER_PATS is
 * on) carries. These operational task-system surfaces used to be gated on
 * `tasks:read` and were therefore reachable by any non-admin user:
 *   - GET /api/admin/task-system/{audit,circuits,observability,systemic,
 *     now,failures/patterns} (`visibility: 'internal'` but scope-gated, not
 *     admin-gated)
 *   - their dual-mounted facades GET /api/tasks/{audit,circuits,
 *     observability,systemic} and /api/v1/tasks/{...}
 *   - the GET arm of /api/(v1/)tasks/{taskId}/settings and .../triggers
 *     (both already required tasks:admin for PUT; GET was the odd one out)
 *
 * All of the above now require `tasks:admin`. This test builds a
 * non-admin session Principal (scopes from `read`+`write`, matching what
 * `buildPrincipal` hands every logged-in non-admin session — see
 * principal.ts) and an admin session Principal, and drives the REAL
 * `enforce()`/`scopeGranted()` decision (unmocked — only `mount.test.ts`
 * mocks those) through `mount()`, exactly as production traffic would.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { EndpointDef } from '$lib/server/api/define.js';

// ── Dependency mocks ─────────────────────────────────────────────────────
//
// getDb()/getTaskDb() default to null (as they do in a real test env with no
// DATABASE_URL configured) so every handler under test takes its early
// `if (!sql) return ApiProblem.dependencyUnavailable(...)` / `notFound(...)`
// branch — proving the SCOPE gate (not a DB call) decided the response,
// without needing to fake a full DB round-trip for every surface. One test
// below (the audit admin route) overrides this to exercise a genuine 200.
const mockGetDb = vi.fn();
const mockGetTaskDb = vi.fn();
vi.mock('$lib/server/database/connection.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/database/connection.js')>();
    return {
        ...actual,
        getDb: (...args: unknown[]) => mockGetDb(...args),
        getTaskDb: (...args: unknown[]) => mockGetTaskDb(...args),
    };
});

const mockListAuditFeed = vi.fn();
vi.mock('$lib/server/database/queries/observability.queries.js', async (importOriginal) => {
    const actual =
        await importOriginal<
            typeof import('$lib/server/database/queries/observability.queries.js')
        >();
    return { ...actual, listAuditFeed: (...args: unknown[]) => mockListAuditFeed(...args) };
});

// `/api/admin/task-system/now` reads Valkey/orchestrator state unconditionally
// (unlike its siblings, it does not early-return on a missing DB), so those
// reads are stubbed out here to keep this a fast, deterministic unit test
// rather than one that depends on a live Valkey/orchestrator.
vi.mock('$lib/server/tasks/observability/heartbeat.js', () => ({
    readHeartbeats: vi.fn().mockResolvedValue([]),
}));
vi.mock('$lib/server/tasks/observability/leaders.js', () => ({
    readClassLeaders: vi.fn().mockResolvedValue([]),
}));
vi.mock('$lib/server/services/cluster-heartbeat.service.js', () => ({
    readClusterNodes: vi.fn().mockResolvedValue([]),
}));
vi.mock('$lib/server/tasks/orchestrator.js', () => ({
    orchestrator: {
        getQueueDepths: vi.fn().mockResolvedValue({}),
        getConcurrencyCaps: vi.fn().mockReturnValue({}),
    },
}));
vi.mock('$lib/server/health/component-health.js', () => ({
    buildComponentHealth: vi.fn().mockResolvedValue({}),
}));

// ── Imports (after mocks) ───────────────────────────────────────────────

import { mount } from '$lib/server/api/mount.js';
import { GET as auditAdminGET } from '../../../../../routes/api/admin/task-system/audit/+server.js';
import { GET as circuitsAdminGET } from '../../../../../routes/api/admin/task-system/circuits/+server.js';
import { GET as observabilityAdminGET } from '../../../../../routes/api/admin/task-system/observability/+server.js';
import { GET as systemicAdminGET } from '../../../../../routes/api/admin/task-system/systemic/+server.js';
import { GET as nowAdminGET } from '../../../../../routes/api/admin/task-system/now/+server.js';
import { GET as failuresPatternsAdminGET } from '../../../../../routes/api/admin/task-system/failures/patterns/+server.js';

import { def as auditFacadeDef } from './audit.js';
import { def as circuitsFacadeDef } from './circuits.js';
import { def as observabilityFacadeDef } from './observability.js';
import { def as systemicFacadeDef } from './systemic.js';
import { def as settingsDef } from './[taskId]/settings.js';
import { def as triggersDef } from './[taskId]/triggers.js';

// ── Test helpers ─────────────────────────────────────────────────────────

function makeEvent(opts: {
    isAdmin: boolean;
    scopes: string[];
    params?: Record<string, string>;
}): RequestEvent {
    const url = new URL('http://localhost/api/admin/task-system/audit');
    return {
        url,
        params: opts.params ?? {},
        route: { id: '/api/admin/task-system/audit' as const },
        request: new Request(url.toString()),
        locals: {
            principal: {
                kind: 'session',
                userId: 'usr_1',
                username: 'alice',
                userGroups: [],
                scopes: opts.scopes,
                isAdmin: opts.isAdmin,
            },
            user: {
                userId: 'usr_1',
                username: 'alice',
                userGroups: [],
                ownerIsAdmin: opts.isAdmin,
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

// A plain logged-in NON-admin session: buildPrincipal gives ['read','write'],
// which expandScopes turns into a set containing runs:read but NOT
// tasks:admin and NOT (since 2026-09-18 fix-plan-4 Task 2, Shape C ruling)
// tasks:read either — `tasks:read`'s auto-grant from `read`/`write` was
// removed; see principal.ts's `expandScopes` and tasks/api-auth.ts's
// `scopeGranted`. `tasks:admin` still requires an explicit grant or the
// coarse `admin` alias. This literal used to also list `'tasks:read'`,
// modeling what a real non-admin session held before that ruling; it is
// dropped here because no real session can produce it anymore (`tasks:read`
// is not a mintable PAT/service-token scope, and the auto-grant is gone) —
// keeping it would have silently tested an unreachable principal shape.
// This file's own assertions are unaffected either way: every endpoint here
// requires `tasks:admin` specifically (C16), which `tasks:read` alone never
// satisfied. `tasks-read-scope-gate.test.ts` (2026-09-18 fix-plan-4 Task 2)
// is the seam test for the auto-grant question itself — it drives the REAL
// `buildPrincipal`/`expandScopes` chain end to end, which this file's
// hand-built literal does not.
const NON_ADMIN = { isAdmin: false, scopes: ['read', 'write'] };
// An admin session: buildPrincipal gives ['admin'], which expandScopes turns
// into a set containing tasks:admin (and tasks:read, via tasks:admin's own
// expansion — unaffected by the Shape C ruling above, which only touched the
// `read`/`write` expansion, not the `admin` one).
const ADMIN = { isAdmin: true, scopes: ['admin', 'tasks:admin', 'tasks:read'] };

beforeEach(() => {
    vi.clearAllMocks();
    mockGetDb.mockReturnValue(null);
    mockGetTaskDb.mockReturnValue(null);
});

describe('C16 — task-system operational surfaces require tasks:admin', () => {
    const adminRoutes: Array<[string, NonNullable<typeof auditAdminGET>]> = [
        ['audit', auditAdminGET!],
        ['circuits', circuitsAdminGET!],
        ['observability', observabilityAdminGET!],
        ['systemic', systemicAdminGET!],
        ['now', nowAdminGET!],
        ['failures/patterns', failuresPatternsAdminGET!],
    ];

    for (const [name, handler] of adminRoutes) {
        it(`GET /api/admin/task-system/${name} — 403s a tasks:read-only (non-admin) caller`, async () => {
            const res = await handler(makeEvent(NON_ADMIN));
            expect(res.status).toBe(403);
        });

        it(`GET /api/admin/task-system/${name} — scope gate does not block an admin (tasks:admin) caller`, async () => {
            const res = await handler(makeEvent(ADMIN));
            expect(res.status).not.toBe(403);
        });
    }

    it('GET /api/admin/task-system/audit — full 200 path for an admin caller', async () => {
        mockGetDb.mockReturnValue({});
        mockListAuditFeed.mockResolvedValue({ events: [], nextCursor: null });

        const res = await auditAdminGET!(makeEvent(ADMIN));

        expect(res.status).toBe(200);
        const body = (await res.json()) as { events: unknown[]; nextCursor: string | null };
        expect(body).toEqual({ items: [], page: { limit: 50, hasMore: false } });
    });

    const facades: Array<[string, EndpointDef]> = [
        ['audit', auditFacadeDef],
        ['circuits', circuitsFacadeDef],
        ['observability', observabilityFacadeDef],
        ['systemic', systemicFacadeDef],
    ];

    for (const [name, def] of facades) {
        for (const surface of ['internal', 'v1'] as const) {
            it(`GET tasks/${name} facade — 403s a tasks:read-only caller (${surface} surface)`, async () => {
                const handlers = mount(def, { surface });
                const res = await handlers.GET!(makeEvent(NON_ADMIN));
                expect(res.status).toBe(403);
            });

            it(`GET tasks/${name} facade — scope gate does not block an admin caller (${surface} surface)`, async () => {
                const handlers = mount(def, { surface });
                const res = await handlers.GET!(makeEvent(ADMIN));
                expect(res.status).not.toBe(403);
            });
        }
    }

    it('GET tasks/{taskId}/settings — 403s a tasks:read-only caller (GET moved off tasks:read)', async () => {
        const handlers = mount(settingsDef, { surface: 'v1' });
        const res = await handlers.GET!(
            makeEvent({ ...NON_ADMIN, params: { taskId: 'nonexistent-task' } }),
        );
        expect(res.status).toBe(403);
    });

    it('GET tasks/{taskId}/settings — scope gate does not block an admin caller', async () => {
        const handlers = mount(settingsDef, { surface: 'v1' });
        const res = await handlers.GET!(
            makeEvent({ ...ADMIN, params: { taskId: 'nonexistent-task' } }),
        );
        expect(res.status).not.toBe(403);
    });

    it('GET tasks/{taskId}/triggers — 403s a tasks:read-only caller (GET moved off tasks:read)', async () => {
        const handlers = mount(triggersDef, { surface: 'v1' });
        const res = await handlers.GET!(
            makeEvent({ ...NON_ADMIN, params: { taskId: 'nonexistent-task' } }),
        );
        expect(res.status).toBe(403);
    });

    it('GET tasks/{taskId}/triggers — scope gate does not block an admin caller', async () => {
        const handlers = mount(triggersDef, { surface: 'v1' });
        const res = await handlers.GET!(
            makeEvent({ ...ADMIN, params: { taskId: 'nonexistent-task' } }),
        );
        expect(res.status).not.toBe(403);
    });
});

describe('reserved core server identity', () => {
    it('rejects writes through the task-settings mirror before registry or database access', async () => {
        const response = await settingsDef.handlers.PUT!(
            makeEvent({ isAdmin: true, scopes: ['admin'], params: { taskId: 'core.server' } }),
            { surface: 'v1' },
        );
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ code: 'forbidden' });
    });
});
