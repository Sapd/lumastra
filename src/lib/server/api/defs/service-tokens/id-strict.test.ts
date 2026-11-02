// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * DELETE /service-tokens/{id} used parseInt, so `12abc` or `12.9` revoked
 * token 12. A revoke must also land in the audit trail.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { ApiContext } from '$lib/server/api/define.js';

const mockRevoke = vi.fn();
vi.mock('$lib/server/oauth/service-token.service.js', () => ({
    getServiceTokenService: () => ({ revoke: (...a: unknown[]) => mockRevoke(...a) }),
}));
vi.mock('$lib/server/config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config.js')>();
    return { ...actual, features: { ...actual.features, deviceAuth: true } };
});
const mockAuditLog = vi.fn();
vi.mock('$lib/server/utils/audit-log.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/utils/audit-log.js')>();
    return { ...actual, auditLog: (...a: unknown[]) => mockAuditLog(...a) };
});

import { def } from './[id].js';

async function del(id: string): Promise<Response> {
    const event = {
        request: new Request(`http://localhost/api/admin/service-tokens/${id}`, {
            method: 'DELETE',
        }),
        url: new URL(`http://localhost/api/admin/service-tokens/${id}`),
        params: { id },
        locals: { user: { username: 'root', ownerIsAdmin: true } },
    } as unknown as RequestEvent;
    return def.handlers.DELETE!(event, { surface: 'internal' } as unknown as ApiContext);
}

beforeEach(() => {
    mockRevoke.mockReset().mockResolvedValue(true);
    mockAuditLog.mockReset();
});

describe('DELETE /service-tokens/{id}', () => {
    it.each(['12abc', '12.9', '0', '-1', '1e3', ' 12'])(
        'rejects id %j without revoking',
        async (id) => {
            const res = await del(id);
            expect(res.status).toBe(422);
            expect(mockRevoke).not.toHaveBeenCalled();
        },
    );

    it('revokes a plain integer id and audits it', async () => {
        const res = await del('12');
        expect(res.status).toBe(204);
        expect(mockRevoke).toHaveBeenCalledWith(12);
        expect(mockAuditLog).toHaveBeenCalledWith('service_token.revoke', '12', expect.anything());
    });
});
