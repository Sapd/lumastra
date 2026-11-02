// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/admin/devices/{userId}/revoke-all answered 503 "Device auth is not enabled"
 * when FEATURE_DEVICE_AUTH was off, although native browser sessions and /j
 * compat sessions exist regardless of the OAuth device flow (admin/users
 * review 2026-10-07, item 8e). The sweep now runs with the flag off.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ApiContext } from '$lib/server/api/define.js';
import type { RequestEvent } from '@sveltejs/kit';

const USER_ID = '550e8400-e29b-41d4-a716-446655440001';
const ADMIN_ID = '550e8400-e29b-41d4-a716-446655440002';
const mockRevoke = vi.fn();
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserById: vi.fn().mockResolvedValue({
        id: '550e8400-e29b-41d4-a716-446655440001',
        username: 'bob',
    }),
}));
vi.mock('$lib/server/services/credential-revocation.service.js', () => ({
    revokeDeviceClassCredentialsForUser: (...args: unknown[]) => mockRevoke(...args),
}));
const mockCeiling = vi.fn();
vi.mock('$lib/server/api/token-minting.js', () => ({
    requireAdminCeilingForTarget: (...args: unknown[]) => mockCeiling(...args),
}));
vi.mock('$lib/server/config.js', () => ({ features: { deviceAuth: false } }));
vi.mock('$lib/server/utils/audit-log.js', () => ({
    auditLog: vi.fn(),
    auditActor: () => ({ kind: 'session', username: 'admin-alice' }),
}));
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

const { def } = await import('./index.js');

beforeEach(() => {
    vi.clearAllMocks();
    mockCeiling.mockResolvedValue(null);
});

describe('POST /api/admin/devices/{userId}/revoke-all with FEATURE_DEVICE_AUTH off', () => {
    it('still revokes native and /j sessions (no 503)', async () => {
        mockRevoke.mockResolvedValue({
            failedStores: [],
            counts: { native_sessions: 2, jellyfin_compat_sessions: 1 },
        });
        const res = await def.handlers.POST!(
            {
                params: { id: USER_ID },
                locals: { user: { username: 'admin-alice', userId: ADMIN_ID } },
                cookies: { get: () => undefined },
            } as unknown as RequestEvent,
            {
                surface: 'internal',
                input: { params: { id: USER_ID } },
            } as unknown as ApiContext<NonNullable<typeof def.request>>,
        );
        expect(res.status).toBe(200);
        expect(mockRevoke).toHaveBeenCalledWith(expect.anything(), USER_ID, 'bob', {
            keepSessionToken: undefined,
        });
        expect(await res.json()).toMatchObject({ revoked: 3, failedStores: [] });
    });
});
