// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Fix round 1, finding 3: `withValidation()` used to sit OUTSIDE the auth
 * check (the check lived inside the wrapped handler), so an anonymous caller
 * had its body fully buffered/parsed before ever being rejected — exactly the
 * pre-auth buffering C15 set out to close. The auth (and feature-enabled)
 * checks now run in the outer handler, before `withValidation()` is even
 * invoked.
 *
 * These tests drive the real POST/DELETE handlers (the seam) with mocked
 * collaborators, asserting BOTH the HTTP outcome and that no body-consuming
 * or DB work happens for a caller that fails the outer checks.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
    },
}));

const approvalLimit = vi.hoisted(() => vi.fn(async () => null as Response | null));
vi.mock('$lib/server/oauth/device-approval-rate-limit', () => ({
    checkDeviceApprovalRateLimit: approvalLimit,
}));
const mockGetByUserCode = vi.fn();
const mockAuthorize = vi.fn();
const mockDeny = vi.fn();
const mockFetchAndCachePermissions = vi.fn();

vi.mock('$lib/server/oauth', () => ({
    getDeviceCodeService: () => ({
        getByUserCode: (...args: unknown[]) => mockGetByUserCode(...args),
        authorize: (...args: unknown[]) => mockAuthorize(...args),
        deny: (...args: unknown[]) => mockDeny(...args),
    }),
    isDeviceAuthEnabled: vi.fn().mockReturnValue(true),
    getJellyfinPermissionsService: () => ({
        fetchAndCachePermissions: (...args: unknown[]) => mockFetchAndCachePermissions(...args),
    }),
}));

const mockSyncUserGroups = vi.fn();
vi.mock('$lib/server/services/user-groups.service.js', () => ({
    syncUserGroups: (...args: unknown[]) => mockSyncUserGroups(...args),
}));

const mockGetDb = vi.fn(() => ({}) as never);
vi.mock('$lib/server/database/connection.js', () => ({
    getDb: () => mockGetDb(),
}));

vi.mock('$lib/server/operation-mode.js', () => ({
    operationMode: { isJellyfinEnabled: false },
}));

vi.mock('$lib/server/config.js', () => ({
    features: { jellyfinSync: false },
}));

function buildEvent(opts: {
    authenticated?: boolean;
    body?: unknown;
    contentLength?: string;
    method?: string;
}): RequestEvent {
    const method = opts.method ?? 'POST';
    const url = 'http://localhost/api/oauth/authorize';
    const init: RequestInit = { method };
    if (opts.body !== undefined) {
        init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
        const headers = new Headers({ 'content-type': 'application/json' });
        if (opts.contentLength !== undefined) headers.set('content-length', opts.contentLength);
        init.headers = headers;
    }
    return {
        url: new URL(url),
        request: new Request(url, init),
        locals: opts.authenticated
            ? {
                  user: {
                      username: 'alice',
                      userId: 'user-1',
                      userGroups: ['Users'],
                  },
              }
            : {},
        params: {},
        getClientAddress: () => '192.0.2.10',
    } as unknown as RequestEvent;
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetByUserCode.mockResolvedValue({
        status: 'pending',
        user_id: 'user-1',
        client_id: 'client-1',
    });
    mockAuthorize.mockResolvedValue(true);
    mockDeny.mockResolvedValue(true);
    mockSyncUserGroups.mockResolvedValue(undefined);
});

describe('POST /api/oauth/authorize — auth runs before body validation (fix round 1, finding 3)', () => {
    it('rejects an anonymous caller with 401 and never touches the device-code service or DB', async () => {
        const { POST } = (await import('./+server.js')) as unknown as {
            POST: (event: RequestEvent) => Promise<Response>;
        };
        const res = await POST(buildEvent({ authenticated: false, body: { user_code: 'ABCD' } }));

        expect(res.status).toBe(401);
        expect(mockGetByUserCode).not.toHaveBeenCalled();
        expect(mockSyncUserGroups).not.toHaveBeenCalled();
    });

    it('rejects an anonymous caller even with an oversized body — the auth check runs before ANY body read', async () => {
        const { POST } = (await import('./+server.js')) as unknown as {
            POST: (event: RequestEvent) => Promise<Response>;
        };
        const res = await POST(
            buildEvent({
                authenticated: false,
                body: { user_code: 'x'.repeat(1_000_000) },
            }),
        );

        // 401, not 413 — proves the auth check short-circuits before
        // withValidation() (and its body-size cap) ever runs.
        expect(res.status).toBe(401);
        expect(mockGetByUserCode).not.toHaveBeenCalled();
    });

    it('an authenticated caller with a >256KB body gets 413, not the handler', async () => {
        const { POST } = (await import('./+server.js')) as unknown as {
            POST: (event: RequestEvent) => Promise<Response>;
        };
        const res = await POST(
            buildEvent({
                authenticated: true,
                body: { user_code: 'x'.repeat(300_000) },
            }),
        );

        expect(res.status).toBe(413);
        expect(mockGetByUserCode).not.toHaveBeenCalled();
    });

    it('an authenticated caller with a normal body succeeds', async () => {
        const { POST } = (await import('./+server.js')) as unknown as {
            POST: (event: RequestEvent) => Promise<Response>;
        };
        const res = await POST(
            buildEvent({ authenticated: true, body: { user_code: 'ABCD-1234' } }),
        );

        expect(res.status).toBe(200);
        expect(mockGetByUserCode).toHaveBeenCalledWith('ABCD-1234');
        expect(mockAuthorize).toHaveBeenCalled();
    });
});

describe('DELETE /api/oauth/authorize — auth runs before body validation', () => {
    it('rejects an anonymous caller with 401 and never touches the device-code service', async () => {
        const { DELETE } = (await import('./+server.js')) as unknown as {
            DELETE: (event: RequestEvent) => Promise<Response>;
        };
        const res = await DELETE(
            buildEvent({ authenticated: false, method: 'DELETE', body: { user_code: 'ABCD' } }),
        );

        expect(res.status).toBe(401);
        expect(mockGetByUserCode).not.toHaveBeenCalled();
    });

    it('an authenticated caller with a normal body succeeds', async () => {
        const { DELETE } = (await import('./+server.js')) as unknown as {
            DELETE: (event: RequestEvent) => Promise<Response>;
        };
        const res = await DELETE(
            buildEvent({ authenticated: true, method: 'DELETE', body: { user_code: 'ABCD-1234' } }),
        );

        expect(res.status).toBe(200);
        expect(mockDeny).toHaveBeenCalledWith('ABCD-1234', 'user-1');
    });
});

describe.each(['POST', 'DELETE'] as const)(
    'browser approval %s budgets and opaque misses',
    (method) => {
        it('limits before lookup and normalizes the code', async () => {
            const handlers = await import('./+server.js');
            approvalLimit.mockResolvedValueOnce(new Response(null, { status: 429 }));
            const response = await handlers[method](
                buildEvent({
                    authenticated: true,
                    method,
                    body: { user_code: 'abcd1234' },
                }) as never,
            );
            expect(response.status).toBe(429);
            expect(approvalLimit).toHaveBeenCalledWith('user-1', 'ABCD-1234', '192.0.2.10');
            expect(mockGetByUserCode).not.toHaveBeenCalled();
        });
        it.each([
            null,
            { status: 'authorized', user_id: 'other' },
            { status: 'denied' },
            { status: 'expired' },
        ])('returns a uniform 404 for unavailable codes (%j)', async (record) => {
            mockGetByUserCode.mockResolvedValue(record);
            const handlers = await import('./+server.js');
            const response = await handlers[method](
                buildEvent({
                    authenticated: true,
                    method,
                    body: { user_code: 'ABCD-1234' },
                }) as never,
            );
            expect(response.status).toBe(404);
            expect(await response.text()).toContain('Invalid or expired device code');
        });
        it('rejects an unbounded or malformed user_code before lookup', async () => {
            const handlers = await import('./+server.js');
            const response = await handlers[method](
                buildEvent({
                    authenticated: true,
                    method,
                    body: { user_code: 'x'.repeat(1000) },
                }) as never,
            );
            expect(response.status).toBe(422);
            expect(mockGetByUserCode).not.toHaveBeenCalled();
        });
    },
);
