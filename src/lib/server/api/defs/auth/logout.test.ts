// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /auth/logout answered 204 even when the refresh-token revoke threw,
 * so a client believed its device session was gone while the refresh token
 * could still mint access tokens (admin/users review 2026-10-07, item 6).
 * The Jellyfin device-token revoke stays best-effort.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { ApiContext } from '$lib/server/api/define.js';

const mockRevokeOAuth = vi.fn();
const mockJellyfinRevoke = vi.fn();
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/oauth/device-session-revocation.js', () => ({
    revokeDeviceSession: (...a: unknown[]) => mockRevokeOAuth(...a),
}));
vi.mock('$lib/server/oauth/jellyfin-token.service.js', () => ({
    getJellyfinTokenService: () => ({ revoke: (...a: unknown[]) => mockJellyfinRevoke(...a) }),
}));
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import { def } from './logout.js';

function event(deviceSessionId: string | undefined): RequestEvent {
    return {
        locals: {
            deviceSessionId,
            principal: { username: 'tv-user', userId: '00000000-0000-0000-0000-000000000042' },
        },
    } as unknown as RequestEvent;
}
const ctx = { surface: 'v1' } as unknown as ApiContext;

beforeEach(() => {
    vi.clearAllMocks();
    mockJellyfinRevoke.mockResolvedValue(false);
});

describe('POST /auth/logout', () => {
    it('204 once the refresh token is revoked', async () => {
        mockRevokeOAuth.mockResolvedValue({ revokedCount: 1 });
        const res = await def.handlers.POST!(event('sess-1234567890'), ctx);
        expect(res.status).toBe(204);
        expect(mockRevokeOAuth).toHaveBeenCalledWith(expect.anything(), 'sess-1234567890', {
            userId: '00000000-0000-0000-0000-000000000042',
        });
    });

    it('503 when the refresh-token revoke throws — the session is NOT gone', async () => {
        mockRevokeOAuth.mockRejectedValue(new Error('connection reset'));
        const res = await def.handlers.POST!(event('sess-1234567890'), ctx);
        expect(res.status).toBe(503);
    });

    it('a Jellyfin revoke failure stays best-effort (204)', async () => {
        mockJellyfinRevoke.mockRejectedValue(new Error('jellyfin down'));
        mockRevokeOAuth.mockResolvedValue({ revokedCount: 1 });
        const res = await def.handlers.POST!(event('sess-1234567890'), ctx);
        expect(res.status).toBe(204);
    });

    it('422 for a PAT/service token (no device session)', async () => {
        const res = await def.handlers.POST!(event(undefined), ctx);
        expect(res.status).toBe(422);
        expect(mockRevokeOAuth).not.toHaveBeenCalled();
    });
});
