// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /jellyfin-connect/quick-connect/authorize: the stored `isAdmin` later
 * becomes the /j session's is_admin, so it must come from the credential's
 * admin authority (`locals.principal`), not the token owner's
 * `locals.user.isAdmin` (spec 2026-10-07-auth-route-policy-design §5.1).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import {
    adminOwnersDeviceToken,
    adminOwnersReadWritePat,
    adminSession,
    adminUserWithoutPrincipal,
} from '$lib/server/api/principal-locals.test-helpers.js';

const mockCacheGet = vi.fn();
const mockCacheSet = vi.fn();
const mockGetUserByUsername = vi.fn();

vi.mock('$lib/server/cache/valkey.js', () => ({
    cacheGet: (...a: unknown[]) => mockCacheGet(...a),
    cacheSet: (...a: unknown[]) => mockCacheSet(...a),
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/quick-connect-store', () => ({
    updateQuickConnectRequest: async (
        _code: string,
        secret: string,
        _raw: string,
        updated: string,
    ) => {
        await mockCacheSet(`jfcompat:qc:secret:${secret}`, updated, 300);
        return true;
    },
}));
vi.mock('$lib/server/database/connection.js', () => ({
    Database: class {
        getSql(): unknown {
            return {};
        }
    },
}));
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserByUsername: (...a: unknown[]) => mockGetUserByUsername(...a),
}));
const log = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn(), info: log, debug: vi.fn() }) },
}));

const { jellyfinQuickConnectAuthorizeDef: def } = await import('./jellyfin-quick-connect.js');

const SECRET = 'secret-1';
const pending = {
    code: '123456',
    authenticated: false,
    userId: null,
    username: null,
    isAdmin: false,
    groups: [],
    displayName: null,
};

async function authorize(locals: RequestEvent['locals']): Promise<void> {
    const event = {
        locals,
        params: {},
        url: new URL('http://localhost/api/jellyfin-connect/quick-connect/authorize'),
    } as unknown as RequestEvent;
    const res = await def.handlers.POST!(event, {
        surface: 'internal',
        input: { body: { code: '123456' } },
    } as never);
    expect(res.status).toBe(200);
}

function storedIsAdmin(): boolean {
    expect(mockCacheSet).toHaveBeenCalledTimes(1);
    const stored = JSON.parse(mockCacheSet.mock.calls[0]![1] as string) as {
        authenticated: boolean;
        isAdmin: boolean;
    };
    expect(stored.authenticated).toBe(true);
    return stored.isAdmin;
}

describe('quick-connect authorize stores credential admin authority', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockCacheGet.mockImplementation(async (key: string) =>
            key.endsWith(':123456') ? SECRET : JSON.stringify(pending),
        );
        mockGetUserByUsername.mockResolvedValue({
            id: 'u1',
            username: 'alice',
            display_name: 'Alice',
        });
    });

    it("an admin owner's device token stores isAdmin:false", async () => {
        await authorize(adminOwnersDeviceToken());
        expect(storedIsAdmin()).toBe(false);
    });

    it("an admin owner's read/write PAT stores isAdmin:false", async () => {
        await authorize(adminOwnersReadWritePat());
        expect(storedIsAdmin()).toBe(false);
    });

    it('a request without a principal stores isAdmin:false', async () => {
        await authorize(adminUserWithoutPrincipal());
        expect(storedIsAdmin()).toBe(false);
    });

    it('logs no approval code or reversible digest on the web path', async () => {
        await authorize(adminSession());
        expect(log).toHaveBeenCalledWith('Quick Connect code authorized', { username: 'alice' });
    });

    it('control: an admin session stores isAdmin:true', async () => {
        await authorize(adminSession());
        expect(storedIsAdmin()).toBe(true);
    });
});
