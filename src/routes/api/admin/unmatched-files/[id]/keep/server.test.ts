// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getDb: vi.fn(() => ({})),
    keep: vi.fn(),
    restore: vi.fn(),
    auditLog: vi.fn(),
}));

vi.mock('$lib/server/database/connection.js', () => ({ getDb: mocks.getDb }));
vi.mock('$lib/server/database/queries/unmatched-files.queries.js', () => ({
    keepPersonalMediaItem: mocks.keep,
    restoreKeptPersonalMediaItem: mocks.restore,
}));
vi.mock('$lib/server/utils/audit-log.js', () => ({
    auditActor: (event: { locals?: { user?: { username?: string } } }) => ({
        username: event.locals?.user?.username ?? null,
    }),
    auditLog: mocks.auditLog,
}));

import { DELETE, POST } from './+server.js';

const ID = '11111111-1111-4111-8111-111111111111';

function event(method: 'POST' | 'DELETE', scopes: string[] = ['media:admin']) {
    const url = new URL(`http://test/api/admin/unmatched-files/${ID}/keep`);
    return {
        locals: {
            user: { ownerIsAdmin: true, username: 'health-test-admin' },
            principal: { kind: 'session', isAdmin: true, scopes },
        },
        url,
        params: { id: ID },
        request: new Request(url, {
            method,
            ...(method === 'POST'
                ? {
                      headers: { 'content-type': 'application/json', origin: 'http://test' },
                      body: '{}',
                  }
                : {}),
        }),
    } as never;
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDb.mockReturnValue({});
    mocks.keep.mockResolvedValue('kept');
    mocks.restore.mockResolvedValue(true);
});

describe('/api/admin/unmatched-files/[id]/keep', () => {
    it('requires media:admin scope', async () => {
        const response = await POST!(event('POST', ['media:read']));
        expect(response.status).toBe(403);
        expect(mocks.keep).not.toHaveBeenCalled();
    });

    it('stores the authenticated actor and returns an idempotent kept disposition', async () => {
        const response = await POST!(event('POST'));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ disposition: 'kept' });
        expect(mocks.keep).toHaveBeenCalledWith({}, ID, 'health-test-admin');
        expect(mocks.auditLog).toHaveBeenCalledWith(
            'media.keep_personal',
            ID,
            expect.objectContaining({ username: 'health-test-admin' }),
            { disposition: 'kept' },
        );
    });

    it('returns a conflict when the item is no longer eligible', async () => {
        mocks.keep.mockResolvedValue('ineligible');
        const response = await POST!(event('POST'));
        expect(response.status).toBe(409);
        expect(mocks.auditLog).not.toHaveBeenCalled();
    });

    it('clears only the Keep disposition and reports missing decisions', async () => {
        const response = await DELETE!(event('DELETE'));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ restored: true });
        expect(mocks.restore).toHaveBeenCalledWith({}, ID);

        mocks.restore.mockResolvedValue(false);
        expect((await DELETE!(event('DELETE'))).status).toBe(404);
    });
});
