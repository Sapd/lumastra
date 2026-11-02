// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mockRevoke = vi.fn();
const mockAuditLog = vi.fn();
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/services/credential-revocation.service.js', () => ({
    revokeDeviceClassCredentialsForUser: (...args: unknown[]) => mockRevoke(...args),
}));
vi.mock('$lib/server/auth/native-session.js', () => ({ readSessionCookie: () => null }));
vi.mock('$lib/server/utils/audit-log.js', () => ({
    auditLog: (...args: unknown[]) => mockAuditLog(...args),
    auditActor: () => ({ kind: 'service_token', username: 'service:ci' }),
}));

const { def } = await import('./revoke-all.js');

beforeEach(() => {
    vi.clearAllMocks();
});

describe('POST /user/devices revoke-all', () => {
    it('audits the revoke-all with the acting credential', async () => {
        mockRevoke.mockResolvedValue({ failedStores: [], counts: { native_sessions: 2 } });
        const event = {
            locals: {
                user: { userId: 'u1', username: 'bob' },
                principal: { kind: 'session', userId: 'u1', username: 'bob' },
            },
            cookies: { get: () => undefined },
        } as unknown as RequestEvent;

        const res = await def.handlers.POST!(event, { surface: 'v1' } as never);

        expect(res.status).toBe(200);
        expect(mockAuditLog).toHaveBeenCalledWith(
            'user.devices_revoke_all',
            'bob',
            expect.objectContaining({ kind: 'service_token' }),
            expect.objectContaining({ totalRevoked: 2 }),
        );
    });
});
