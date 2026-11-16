// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { ApiContext } from '$lib/server/api/define.js';
const { save } = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock('$lib/server/database/index.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/services/admin-user.service.js', () => ({
    setUserAllowDownloads: save,
}));
vi.mock('$lib/server/utils/audit-log.js', () => ({
    auditActor: () => ({ username: 'admin' }),
    auditLog: vi.fn(),
}));
import { def } from './index.js';

function event(body: unknown): RequestEvent {
    return {
        params: { username: 'Viewer' },
        locals: { user: { username: 'admin' }, principal: { username: 'admin', isAdmin: true } },
        request: new Request('http://localhost/api/admin/users/viewer', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        }),
    } as unknown as RequestEvent;
}
const ctx = { surface: 'internal' } as ApiContext;
beforeEach(() => {
    save.mockReset().mockImplementation(async (_sql, p) => ({
        ok: true,
        data: { username: p.targetUsername, allowDownloads: p.allowed },
    }));
});

describe('admin downloads override', () => {
    it.each([true, false, null])('saves tri-state value %s', async (allowDownloads) => {
        const response = await def.handlers.PATCH!(event({ allowDownloads }), ctx);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ username: 'viewer', allowDownloads });
        expect(save.mock.calls[0][1].allowed).toBe(allowDownloads);
    });
    it.each(['yes', 1])('rejects non-boolean %s', async (allowDownloads) => {
        const response = await def.handlers.PATCH!(event({ allowDownloads }), ctx);
        expect(response.status).toBe(422);
        expect(save).not.toHaveBeenCalled();
    });
    it('requires one change per request', async () => {
        const response = await def.handlers.PATCH!(
            event({ allowDownloads: false, maxAgeRating: 12 }),
            ctx,
        );
        expect(response.status).toBe(422);
        expect(save).not.toHaveBeenCalled();
    });
});
