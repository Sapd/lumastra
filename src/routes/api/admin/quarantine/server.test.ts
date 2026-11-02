// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi } from 'vitest';

const { mockList, mockInspect } = vi.hoisted(() => ({
    mockList: vi.fn(async () => []),
    mockInspect: vi.fn(async () => ({ items: [], total: 0 })),
}));
vi.mock('$lib/server/services/quarantine-inspection.service.js', () => ({
    inspectQuarantineGroup: mockInspect,
}));

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: async () => ({}) },
}));
vi.mock('$lib/server/database/queries/sync-quarantine.queries.js', () => ({
    listUnresolvedQuarantine: mockList,
    countUnresolvedQuarantine: vi.fn(async () => 250),
}));
vi.mock('$lib/server/middleware/error-handler.js', () => ({
    withErrorHandler: (fn: (evt: unknown) => Promise<Response>) => fn,
}));

import { GET } from './+server.js';
import { delegateToAdmin } from '$lib/server/api/delegate.js';

describe('GET /api/admin/quarantine', () => {
    it('applies the requested offset (page 2 is not page 1 again)', async () => {
        const url = new URL('http://test/api/admin/quarantine?limit=100&offset=100');
        const res = await GET!({
            locals: {
                user: { ownerIsAdmin: true, username: 'admin' },
                principal: { kind: 'session', isAdmin: true, scopes: ['admin'] },
            },
            url,
            params: {},
            request: new Request(url),
        } as never);
        expect(res.status).toBe(200);
        expect(mockList).toHaveBeenCalledWith(expect.anything(), 100, 100);
    });
    it('validates bounded group inspection and refuses unauthorized direct access', async () => {
        const url = new URL('http://test/api/admin/quarantine?group=unknown&limit=25');
        const event = {
            locals: {
                user: { ownerIsAdmin: true, username: 'admin' },
                principal: { kind: 'session', isAdmin: true, scopes: ['admin'] },
            },
            url,
            params: {},
            request: new Request(url),
        };
        expect((await GET!(event as never)).status).toBe(200);
        expect(mockInspect).toHaveBeenCalledWith(expect.anything(), 'unknown', {
            limit: 25,
            after: undefined,
        });
        event.locals.principal.isAdmin = false;
        event.locals.principal.scopes = [];
        event.locals.user.ownerIsAdmin = false;
        expect((await GET!(event as never)).status).toBe(403);
        const malformed = new URL('http://test/api/admin/quarantine?group=not-a-group');
        event.locals.principal.isAdmin = true;
        event.locals.principal.scopes = ['admin'];
        event.locals.user.ownerIsAdmin = true;
        expect(
            (await GET!({ ...event, url: malformed, request: new Request(malformed) } as never))
                .status,
        ).toBe(422);
    });

    it('does not expose the inspection projection through the versioned delegate', async () => {
        const url = new URL('http://test/api/v1/libraries/quarantine?group=unknown');
        const event = {
            locals: {
                user: { ownerIsAdmin: true, username: 'admin' },
                principal: { kind: 'session', username: 'admin', isAdmin: true, scopes: ['admin'] },
            },
            url,
            params: {},
            request: new Request(url),
        };
        expect((await delegateToAdmin(event as never, GET!)).status).toBe(422);
    });
});
