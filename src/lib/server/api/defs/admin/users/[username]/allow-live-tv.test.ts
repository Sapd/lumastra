// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { ApiContext } from '$lib/server/api/define.js';
const { save } = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock('$lib/server/database/index.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/services/admin-user.service.js', () => ({
    setUserAllowLiveTv: save,
    setUserAgeRating: vi.fn().mockResolvedValue({ ok: true, data: { maxAgeRating: 12 } }),
}));
vi.mock('$lib/server/utils/audit-log.js', () => ({
    auditActor: () => ({ username: 'admin' }),
    auditLog: vi.fn(),
}));
import { def } from './index.js';

function event(body: unknown): RequestEvent {
    return {
        params: { username: 'viewer' },
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
        data: { username: p.targetUsername, allowLiveTv: p.allowed, liveTvDefault: false },
    }));
});

describe('admin Live TV switch', () => {
    it.each([true, false])('saves explicit %s and is safe to repeat', async (allowed) => {
        for (let i = 0; i < 2; i++) {
            const response = await def.handlers.PATCH!(event({ allowLiveTv: allowed }), ctx);
            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({
                username: 'viewer',
                allowLiveTv: allowed,
                liveTvDefault: false,
            });
        }
        expect(save).toHaveBeenCalledTimes(2);
    });
    it.each(['secret-key', null, 1, 'https://name:password@example.test'])(
        'rejects a non-boolean without echoing the value',
        async (allowLiveTv) => {
            const response = await def.handlers.PATCH!(event({ allowLiveTv }), ctx);
            expect(response.status).toBe(422);
            const body = await response.text();
            expect(body).toContain('allowLiveTv');
            if (typeof allowLiveTv === 'string') expect(body).not.toContain(allowLiveTv);
            expect(save).not.toHaveBeenCalled();
        },
    );
    it('requires separate requests for the age limit and Live TV switch', async () => {
        const response = await def.handlers.PATCH!(
            event({ allowLiveTv: false, maxAgeRating: 12 }),
            ctx,
        );
        expect(response.status).toBe(422);
        expect(save).not.toHaveBeenCalled();
    });
});
