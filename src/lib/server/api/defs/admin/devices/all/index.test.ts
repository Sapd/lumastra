// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Final fix wave (2026-09-13): POST /api/admin/devices/{userId}/revoke-all must revoke
 * ONLY device-class credentials (native sessions, OAuth refresh tokens,
 * Jellyfin OAuth device tokens, /j compat sessions) — never PATs or the
 * Subsonic client password, which the C2 fan-out had silently started
 * wiping despite this endpoint's name/UI promising only "devices".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ApiContext } from '$lib/server/api/define.js';
import type { RequestEvent } from '@sveltejs/kit';

const mockGetDb = vi.fn();
const mockGetUserById = vi.fn();
const mockRevokeDeviceClassCredentialsForUser = vi.fn();

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: (...args: unknown[]) => mockGetDb(...args),
}));
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserById: (...args: unknown[]) => mockGetUserById(...args),
}));
vi.mock('$lib/server/services/credential-revocation.service.js', () => ({
    revokeDeviceClassCredentialsForUser: (...args: unknown[]) =>
        mockRevokeDeviceClassCredentialsForUser(...args),
}));
const mockCeiling = vi.fn();
vi.mock('$lib/server/api/token-minting.js', () => ({
    requireAdminCeilingForTarget: (...args: unknown[]) => mockCeiling(...args),
}));
vi.mock('$lib/server/config.js', () => ({ features: { deviceAuth: true } }));
const mockAuditLog = vi.fn();
vi.mock('$lib/server/utils/audit-log.js', () => ({
    auditLog: (...args: unknown[]) => mockAuditLog(...args),
    auditActor: () => ({ kind: 'session', username: 'admin-alice' }),
}));
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

const { def } = await import('./index.js');

const USER_ID = '550e8400-e29b-41d4-a716-446655440001';
const ADMIN_ID = '550e8400-e29b-41d4-a716-446655440002';

function makeEvent(opts: { targetUserId?: string; sessionCookie?: string } = {}): RequestEvent {
    return {
        params: { id: opts.targetUserId ?? USER_ID },
        locals: { user: { username: 'admin-alice', userId: ADMIN_ID } },
        cookies: {
            get: (name: string) => (name === 'lumastra_session' ? opts.sessionCookie : undefined),
        },
    } as unknown as RequestEvent;
}

function makeCtx(userId = USER_ID): ApiContext<NonNullable<typeof def.request>> {
    return {
        surface: 'internal',
        input: {
            query: undefined,
            params: { id: userId },
            body: undefined,
        },
    } as unknown as ApiContext<NonNullable<typeof def.request>>;
}

beforeEach(() => {
    vi.clearAllMocks();
    mockCeiling.mockResolvedValue(null);
    mockGetDb.mockReturnValue({});
    mockGetUserById.mockResolvedValue({ id: USER_ID, username: 'bob' });
});

describe('POST /api/admin/devices/{userId}/revoke-all', () => {
    it('calls the DEVICE-class-only revocation (not the full fan-out)', async () => {
        mockRevokeDeviceClassCredentialsForUser.mockResolvedValue({
            failedStores: [],
            counts: {
                native_sessions: 1,
                refresh_tokens: 2,
                jellyfin_oauth_tokens: 3,
                jellyfin_compat_sessions: 4,
            },
        });

        const res = await def.handlers.POST!(makeEvent(), makeCtx());
        const body = (await res.json()) as Record<string, unknown>;

        expect(mockRevokeDeviceClassCredentialsForUser).toHaveBeenCalledWith(
            expect.anything(),
            USER_ID,
            'bob',
            { keepSessionToken: undefined },
        );
        expect(mockAuditLog).toHaveBeenCalledWith(
            'user.devices_revoke_all',
            'bob',
            expect.anything(),
            expect.objectContaining({ totalRevoked: 10, failedStores: [] }),
        );
        expect(body).toMatchObject({
            revoked: 10,
            failedStores: [],
        });
    });

    it('sums revoked from all four device-class counts, defaulting a missing store to 0', async () => {
        mockRevokeDeviceClassCredentialsForUser.mockResolvedValue({
            failedStores: ['jellyfin_compat_sessions'],
            counts: { native_sessions: 5, refresh_tokens: 0, jellyfin_oauth_tokens: 2 },
        });

        const res = await def.handlers.POST!(makeEvent(), makeCtx());
        const body = (await res.json()) as Record<string, unknown>;

        expect(body.revoked).toBe(7);
        expect(body).not.toHaveProperty('jellyfinCompatSessionsRevoked');
    });

    // Residual fix-plan finding (2026-09-13, item 4): a store throwing inside
    // the best-effort fan-out was silently swallowed into `revoked: true` with
    // `?? 0` counts — the caller had no way to tell a real 0 apart from a
    // failed store. The current contract exposes both the revoked count and
    // failedStores so a partial sweep stays distinguishable from a clean one.
    it('a partial failure is surfaced: the revoked count and failedStores in the response, still 200 (best-effort sweep)', async () => {
        mockRevokeDeviceClassCredentialsForUser.mockResolvedValue({
            failedStores: ['jellyfin_compat_sessions', 'refresh_tokens'],
            counts: { native_sessions: 5, jellyfin_oauth_tokens: 2 },
        });

        const res = await def.handlers.POST!(makeEvent(), makeCtx());
        expect(res.status).toBe(200);
        const body = (await res.json()) as Record<string, unknown>;

        expect(body.revoked).toBe(7);
        expect(body.failedStores).toEqual(['jellyfin_compat_sessions', 'refresh_tokens']);
        // Counts for the failed stores still default to 0 — unchanged behaviour.
        expect(body).not.toHaveProperty('oauthRevoked');
        expect(body).not.toHaveProperty('jellyfinCompatSessionsRevoked');
    });

    it('a clean sweep (no failed stores) still reports the revoked count and an empty failedStores', async () => {
        mockRevokeDeviceClassCredentialsForUser.mockResolvedValue({
            failedStores: [],
            counts: {
                native_sessions: 1,
                refresh_tokens: 1,
                jellyfin_oauth_tokens: 1,
                jellyfin_compat_sessions: 1,
            },
        });

        const res = await def.handlers.POST!(makeEvent(), makeCtx());
        const body = (await res.json()) as Record<string, unknown>;

        expect(body.revoked).toBe(4);
        expect(body.failedStores).toEqual([]);
    });

    it('returns 404 when the user does not exist', async () => {
        mockGetUserById.mockResolvedValue(null);

        const res = await def.handlers.POST!(makeEvent(), makeCtx());
        expect(res.status).toBe(404);
        expect(mockRevokeDeviceClassCredentialsForUser).not.toHaveBeenCalled();
    });

    it('denies a non-admin caller revoking an administrator target (admin ceiling), nothing revoked', async () => {
        mockCeiling.mockResolvedValue(new Response(null, { status: 403 }));

        const res = await def.handlers.POST!(makeEvent(), makeCtx());
        expect(res.status).toBe(403);
        expect(mockRevokeDeviceClassCredentialsForUser).not.toHaveBeenCalled();
    });

    it('tolerates a caller without locals.user (scope/service-token principal)', async () => {
        mockRevokeDeviceClassCredentialsForUser.mockResolvedValue({ failedStores: [], counts: {} });
        const event = makeEvent();
        (event.locals as unknown as Record<string, unknown>).user = undefined;
        (event.locals as unknown as Record<string, unknown>).principal = { username: 'svc' };

        const res = await def.handlers.POST!(event, makeCtx());
        expect(res.status).toBe(200);
    });

    it('an admin revoking their OWN devices keeps the session they are using', async () => {
        mockGetUserById.mockResolvedValue({ id: ADMIN_ID, username: 'admin-alice' });
        mockRevokeDeviceClassCredentialsForUser.mockResolvedValue({ failedStores: [], counts: {} });

        await def.handlers.POST!(
            makeEvent({ targetUserId: ADMIN_ID, sessionCookie: 'tok-current' }),
            makeCtx(ADMIN_ID),
        );

        expect(mockRevokeDeviceClassCredentialsForUser).toHaveBeenCalledWith(
            expect.anything(),
            ADMIN_ID,
            'admin-alice',
            { keepSessionToken: 'tok-current' },
        );
    });

    it("never keeps the caller's cookie session when revoking ANOTHER user", async () => {
        mockRevokeDeviceClassCredentialsForUser.mockResolvedValue({ failedStores: [], counts: {} });

        await def.handlers.POST!(
            makeEvent({ sessionCookie: 'tok-current' }),
            makeCtx(),
        );

        expect(mockRevokeDeviceClassCredentialsForUser).toHaveBeenCalledWith(
            expect.anything(),
            USER_ID,
            'bob',
            { keepSessionToken: undefined },
        );
    });
});
