// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { mount } from '$lib/server/api/mount.js';
import { buildPrincipal } from '$lib/server/api/principal.js';
import { toUserId } from '$lib/shared/user-id.js';
import { createPolicyTable, policyForMethod } from '$lib/server/auth/route-policy/policy.js';
import { ROUTE_POLICY_RULES } from '$lib/server/auth/route-policy/rules.js';

const state = vi.hoisted(() => ({
    sharing: false,
    sql: {} as object | null,
    apply: vi.fn(),
    audit: vi.fn(),
}));
vi.mock('$lib/server/config/activity-sharing.js', () => ({
    defaultActivitySharing: () => state.sharing,
}));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => state.sql }));
vi.mock('$lib/server/database/queries/activity-sharing.queries.js', () => ({
    applyActivitySharingDefault: state.apply,
}));
vi.mock('$lib/server/utils/audit-log.js', () => ({
    auditLog: state.audit,
    auditActor: () => ({ username: 'admin' }),
}));
import { def } from './activity-sharing-default.js';

const route = '/api/admin/activity-sharing-default';
const mounted = mount(def, { surface: 'internal' });
function event(admin: boolean, body: unknown, method = 'POST'): RequestEvent {
    return {
        request: new Request('http://localhost' + route, {
            method,
            ...(method === 'POST'
                ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
                : {}),
        }),
        url: new URL('http://localhost' + route),
        route: { id: route },
        locals: {
            principal: buildPrincipal({
                kind: 'session',
                username: 'admin',
                userId: toUserId('00000000-0000-0000-0000-000000000001'),
                userGroups: [],
                sessionIsAdmin: admin,
            }),
        },
    } as unknown as RequestEvent;
}

beforeEach(() => {
    state.sharing = false;
    state.sql = {};
    state.apply.mockReset().mockResolvedValue(2);
    state.audit.mockReset();
});
describe('activity sharing admin action', () => {
    it.each([false, true])(
        'applies the saved default %s and audits the result',
        async (sharing) => {
            state.sharing = sharing;
            expect(await (await mounted.GET!(event(true, undefined, 'GET'))).json()).toEqual({
                sharing,
            });
            const response = await mounted.POST!(
                event(true, { confirmed: true, expectedDefault: sharing }),
            );
            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({ sharing, changedCount: 2 });
            expect(state.apply).toHaveBeenCalledWith(state.sql, sharing);
            expect(state.audit).toHaveBeenCalledWith(
                'users.apply_activity_sharing_default',
                'users',
                { username: 'admin' },
                { sharing, changedCount: 2 },
            );
        },
    );
    it('rejects a missing confirmation and a stale default', async () => {
        expect((await mounted.POST!(event(true, { expectedDefault: false }))).status).toBe(422);
        expect(
            (await mounted.POST!(event(true, { confirmed: true, expectedDefault: true }))).status,
        ).toBe(409);
        expect(state.apply).not.toHaveBeenCalled();
        expect(state.audit).not.toHaveBeenCalled();
    });
    it('fails closed when the database is unavailable', async () => {
        state.sql = null;
        expect(
            (await mounted.POST!(event(true, { confirmed: true, expectedDefault: false }))).status,
        ).toBe(503);
        expect(state.audit).not.toHaveBeenCalled();
    });
    it('denies an admin-owned PAT without admin scope on an admin account', async () => {
        const request = event(true, { confirmed: true, expectedDefault: false });
        request.locals.principal = buildPrincipal({
            kind: 'pat',
            username: 'admin',
            userId: toUserId('00000000-0000-0000-0000-000000000001'),
            userGroups: ['admins'],
            ownerIsAdmin: true,
            tokenScopes: ['read'],
        });
        expect((await mounted.POST!(request)).status).toBe(403);
        expect(state.apply).not.toHaveBeenCalled();
    });
    it.each(['GET', 'POST'] as const)(
        'denies ordinary users on %s and requires the admin route policy',
        async (method) => {
            expect(
                (
                    await mounted[method]!(
                        event(false, { confirmed: true, expectedDefault: false }, method),
                    )
                ).status,
            ).toBe(403);
            expect(state.apply).not.toHaveBeenCalled();
            expect(
                policyForMethod(createPolicyTable(ROUTE_POLICY_RULES).match(route)!.rule, method),
            ).toBe('admin');
        },
    );
});
