// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/admin/privacy-settings used to upsert by the raw name, so an
 * unknown or differently-cased username created a phantom `users` row and the
 * admin UI reported success. It now answers 404 and writes an audit row on
 * success.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { ApiContext } from '$lib/server/api/define.js';

const mockSet = vi.fn();
vi.mock('$lib/server/database/queries/oauth-admin.queries.js', () => ({
    getHiddenUsers: vi.fn(),
    setUserPrivacySetting: (...args: unknown[]) => mockSet(...args),
}));
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: vi.fn(async () => ({})) },
}));
const mockAuditLog = vi.fn();
vi.mock('$lib/server/utils/audit-log.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/utils/audit-log.js')>();
    return { ...actual, auditLog: (...args: unknown[]) => mockAuditLog(...args) };
});

import { def } from './privacy-settings.js';

const POST = def.handlers.POST!;

async function call(body: { username: string; hideFromOthers: boolean }): Promise<Response> {
    const event = {
        request: new Request('http://localhost/api/admin/privacy-settings', { method: 'POST' }),
        url: new URL('http://localhost/api/admin/privacy-settings'),
        params: {},
        locals: { user: { username: 'root', ownerIsAdmin: true } },
    } as unknown as RequestEvent;
    return POST(event, { surface: 'internal', input: { body } } as unknown as ApiContext);
}

beforeEach(() => {
    mockSet.mockReset();
    mockAuditLog.mockReset();
});

describe('POST /api/admin/privacy-settings', () => {
    it('404s an unknown user and writes no audit row', async () => {
        mockSet.mockResolvedValue(false);
        const res = await call({ username: 'nobody', hideFromOthers: true });
        expect(res.status).toBe(404);
        expect(mockAuditLog).not.toHaveBeenCalled();
    });

    it('updates an existing user and audits the change under the folded name', async () => {
        mockSet.mockResolvedValue(true);
        const res = await call({ username: 'Alice', hideFromOthers: false });
        expect(res.status).toBe(200);
        expect(mockSet).toHaveBeenCalledWith(expect.anything(), 'Alice', false);
        expect(mockAuditLog).toHaveBeenCalledWith(
            'user.privacy_hide_streams',
            'alice',
            expect.anything(),
            { hideFromOthers: false },
        );
    });
    it('protects an admin changing their own sharing, including a case variant', async () => {
        mockSet.mockResolvedValue(true);
        expect((await call({ username: 'ROOT', hideFromOthers: true })).status).toBe(200);
        expect(mockSet).toHaveBeenCalledWith(expect.anything(), 'ROOT', true);
    });
});
