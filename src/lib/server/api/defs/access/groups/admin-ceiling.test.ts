// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Security review 2026-09-23 final fix wave, X1(a): the access-group write
 * defs (create with capabilities, replace capabilities, add a member) had no
 * admin ceiling — a delegated non-admin `access:admin` credential could grant
 * the `admin` capability to a brand-new group, add it to an existing group's
 * capability set, or add a member to a group that already confers admin.
 * Combined with X1's chain (a demoted in-app admin's stale `['admin']` token
 * still carries `access:admin`), this was exactly how a demoted admin could
 * re-escalate. `requireAdminCeiling()` — the same helper the `users:admin`
 * endpoints use (security review 2026-09-13, C1) — now gates all three.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { toUserId } from '$lib/shared/user-id.js';
import { buildPrincipal, type Principal } from '$lib/server/api/principal.js';
import type { ApiContext } from '$lib/server/api/define.js';

vi.mock('$lib/server/database/index.js', () => ({ getDb: () => ({}) }));

const mockCreateAccessGroup = vi.fn();
const mockUpdateAccessGroupWithCaps = vi.fn();
const mockAddMember = vi.fn();
const mockRemoveMember = vi.fn();
vi.mock('$lib/server/services/access-control.service.js', async (importOriginal) => {
    const actual =
        await importOriginal<typeof import('$lib/server/services/access-control.service.js')>();
    return {
        ...actual,
        createAccessGroup: (...args: unknown[]) => mockCreateAccessGroup(...args),
        updateAccessGroupWithCaps: (...args: unknown[]) => mockUpdateAccessGroupWithCaps(...args),
        addMember: (...args: unknown[]) => mockAddMember(...args),
        removeMember: (...args: unknown[]) => mockRemoveMember(...args),
    };
});

const mockGetAccessGroupById = vi.fn();
vi.mock('$lib/server/database/queries/access-groups.queries.js', () => ({
    listAccessGroupMembers: vi.fn(),
    getAccessGroupById: (...args: unknown[]) => mockGetAccessGroupById(...args),
}));

vi.mock('$lib/server/utils/audit-log.js', () => ({
    auditLog: vi.fn(),
    auditActor: vi.fn(() => 'tester'),
}));

import { def as groupsIndexDef } from './index.js';
import { def as groupIdDef } from './[id]/index.js';
import { def as membersDef } from './[id]/members/[userId].js';

const USER_ID = toUserId('00000000-0000-0000-0000-000000000042');

function makeEvent(
    principal: Principal,
    opts: { method?: string; url?: string; params?: Record<string, string> } = {},
): RequestEvent {
    const url = opts.url ?? 'http://localhost/api/v1/access/groups';
    return {
        request: new Request(url, { method: opts.method ?? 'POST' }),
        url: new URL(url),
        params: opts.params ?? {},
        locals: { principal, user: undefined },
    } as unknown as RequestEvent;
}

function ctxWithBody(body: unknown): ApiContext {
    return { surface: 'v1', input: { body } } as unknown as ApiContext;
}

const accessAdminOnly = buildPrincipal({
    kind: 'pat',
    userId: USER_ID,
    username: 'delegate',
    userGroups: [],
    tokenScopes: ['access:admin'],
    ownerIsAdmin: false,
});

const adminSession = buildPrincipal({
    kind: 'session',
    userId: USER_ID,
    username: 'root',
    userGroups: ['admins'],
    sessionIsAdmin: true,
});

const groupRowWithAdminCap = {
    id: 'group-1',
    name: 'ops',
    display_name: 'Ops',
    description: null,
    is_system: false,
    created_at: new Date(),
    updated_at: new Date(),
    member_count: 0,
    capabilities: [{ capability: 'admin', value: null }],
};

const groupRowNoAdminCap = {
    ...groupRowWithAdminCap,
    id: 'group-2',
    name: 'watchers',
    capabilities: [{ capability: 'watch', value: null }],
};

describe('POST /api/v1/access/groups: admin ceiling (X1a)', () => {
    const POST = groupsIndexDef.handlers.POST!;

    beforeEach(() => {
        mockCreateAccessGroup.mockReset().mockResolvedValue({
            ok: true,
            data: { ...groupRowWithAdminCap },
        });
    });

    it('an access:admin-only caller cannot create a group with the admin capability -> 403, service never called', async () => {
        const res = await POST(
            makeEvent(accessAdminOnly),
            ctxWithBody({ name: 'newgroup', capabilities: [{ capability: 'admin' }] }),
        );
        expect(res.status).toBe(403);
        expect(mockCreateAccessGroup).not.toHaveBeenCalled();
    });

    it('an access:admin-only caller may still create a group WITHOUT the admin capability', async () => {
        mockCreateAccessGroup.mockResolvedValue({ ok: true, data: { ...groupRowNoAdminCap } });
        const res = await POST(
            makeEvent(accessAdminOnly),
            ctxWithBody({ name: 'newgroup', capabilities: [{ capability: 'watch' }] }),
        );
        expect(res.status).toBe(201);
        expect(mockCreateAccessGroup).toHaveBeenCalledTimes(1);
    });

    it('an admin caller may create a group with the admin capability', async () => {
        const res = await POST(
            makeEvent(adminSession),
            ctxWithBody({ name: 'newgroup', capabilities: [{ capability: 'admin' }] }),
        );
        expect(res.status).toBe(201);
        expect(mockCreateAccessGroup).toHaveBeenCalledTimes(1);
    });
});

describe('PATCH /api/v1/access/groups/{id}: admin ceiling (X1a)', () => {
    const PATCH = groupIdDef.handlers.PATCH!;

    beforeEach(() => {
        mockUpdateAccessGroupWithCaps.mockReset().mockResolvedValue({
            ok: true,
            data: { ...groupRowWithAdminCap },
        });
    });

    it('an access:admin-only caller cannot replace capabilities to include admin -> 403, service never called', async () => {
        const res = await PATCH(
            makeEvent(accessAdminOnly, {
                method: 'PATCH',
                url: 'http://localhost/api/v1/access/groups/group-1',
                params: { id: 'group-1' },
            }),
            ctxWithBody({ capabilities: [{ capability: 'admin' }] }),
        );
        expect(res.status).toBe(403);
        expect(mockUpdateAccessGroupWithCaps).not.toHaveBeenCalled();
    });

    it('an access:admin-only caller may replace capabilities that do NOT include admin', async () => {
        mockUpdateAccessGroupWithCaps.mockResolvedValue({
            ok: true,
            data: { ...groupRowNoAdminCap },
        });
        const res = await PATCH(
            makeEvent(accessAdminOnly, {
                method: 'PATCH',
                url: 'http://localhost/api/v1/access/groups/group-2',
                params: { id: 'group-2' },
            }),
            ctxWithBody({ capabilities: [{ capability: 'watch' }] }),
        );
        expect(res.status).toBe(200);
        expect(mockUpdateAccessGroupWithCaps).toHaveBeenCalledTimes(1);
    });

    it('an admin caller may replace capabilities to include admin', async () => {
        const res = await PATCH(
            makeEvent(adminSession, {
                method: 'PATCH',
                url: 'http://localhost/api/v1/access/groups/group-1',
                params: { id: 'group-1' },
            }),
            ctxWithBody({ capabilities: [{ capability: 'admin' }] }),
        );
        expect(res.status).toBe(200);
        expect(mockUpdateAccessGroupWithCaps).toHaveBeenCalledTimes(1);
    });
});

describe('PUT /api/v1/access/groups/{id}/members/{userId}: admin ceiling (X1a)', () => {
    const PUTMember = membersDef.handlers.PUT!;

    beforeEach(() => {
        mockAddMember.mockReset().mockResolvedValue({ ok: true, data: undefined });
        mockGetAccessGroupById.mockReset();
    });

    it('an access:admin-only caller cannot add a member to an admin-conferring group -> 403, service never called', async () => {
        mockGetAccessGroupById.mockResolvedValue(groupRowWithAdminCap);
        const res = await PUTMember(
            makeEvent(accessAdminOnly, {
                url: 'http://localhost/api/v1/access/groups/group-1/members',
                params: { id: 'group-1' },
            }),
            {
                surface: 'v1',
                input: {
                    params: { id: 'group-1', userId: '11111111-1111-1111-1111-111111111111' },
                },
            } as never,
        );
        expect(res.status).toBe(403);
        expect(mockAddMember).not.toHaveBeenCalled();
    });

    it('an access:admin-only caller may add a member to a group that does NOT confer admin', async () => {
        mockGetAccessGroupById.mockResolvedValue(groupRowNoAdminCap);
        const res = await PUTMember(
            makeEvent(accessAdminOnly, {
                url: 'http://localhost/api/v1/access/groups/group-2/members',
                params: { id: 'group-2' },
            }),
            {
                surface: 'v1',
                input: {
                    params: { id: 'group-1', userId: '11111111-1111-1111-1111-111111111111' },
                },
            } as never,
        );
        expect(res.status).toBe(204);
        expect(mockAddMember).toHaveBeenCalledTimes(1);
    });

    it('an admin caller may add a member to an admin-conferring group', async () => {
        mockGetAccessGroupById.mockResolvedValue(groupRowWithAdminCap);
        const res = await PUTMember(
            makeEvent(adminSession, {
                url: 'http://localhost/api/v1/access/groups/group-1/members',
                params: { id: 'group-1' },
            }),
            {
                surface: 'v1',
                input: {
                    params: { id: 'group-1', userId: '11111111-1111-1111-1111-111111111111' },
                },
            } as never,
        );
        expect(res.status).toBe(204);
        expect(mockAddMember).toHaveBeenCalledTimes(1);
    });
});
