// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

// Unit tests for /j/Auth/Keys handlers.
//
// We bypass withJellyfinAuth via vi.mock so handler-internal logic
// (admin check, stash consumption, response shape) can be exercised in
// isolation. Middleware behavior is covered separately in middleware.test.ts.

import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The first test to import ./+server pulls a large module graph cold under the
// vitest transform, which can exceed the default 10s timeout in isolation.
vi.setConfig({ testTimeout: 30_000 });

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockListForUser, mockConsumeAuthKey, mockStashAuthKey, mockCreate } = vi.hoisted(() => ({
    mockListForUser: vi.fn(),
    mockConsumeAuthKey: vi.fn(),
    mockStashAuthKey: vi.fn(),
    mockCreate: vi.fn(),
}));

// The real message barrel costs ~35 s to load cold and blew the 30 s timeout —
// see the stub's header.
vi.mock('$lib/paraglide/messages', async () => {
    const { messagesStub } = await import('$lib/server/__testkit__/paraglide-messages-stub');
    return messagesStub;
});

vi.mock('$lib/server/proprietary/jellyfin-compat/middleware', () => ({
    // No-op wrapper so the route exports the inner handler directly.
    withJellyfinAuth: (handler: RequestHandler) => handler,
}));

vi.mock('$lib/server/oauth/pat.service', () => ({
    getPatService: () => ({
        listForUser: mockListForUser,
        create: mockCreate,
    }),
}));

vi.mock('$lib/server/proprietary/jellyfin-compat/auth-keys-stash', () => ({
    consumeAuthKey: mockConsumeAuthKey,
    stashAuthKey: mockStashAuthKey,
}));

vi.mock('$lib/server/services/database.service', () => ({
    aiDbService: {
        getSql: vi.fn().mockResolvedValue(
            // postgres.js tagged template — we don't exercise it in GET tests.
            // POST tests don't run UPDATE assertions; the mock just needs to
            // be callable and resolve.
            (() => {
                const fn = vi.fn().mockResolvedValue([]);
                return fn;
            })(),
        ),
    },
}));

vi.mock('$lib/server/utils/logger', () => ({
    Logger: {
        for: () => ({
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
        }),
    },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface UserShape {
    username: string;
    userId: string;
    isAdmin: boolean;
    userGroups?: string[];
    groups?: string;
}

function buildEvent(user: UserShape): RequestEvent {
    return {
        url: new URL('http://localhost/j/Auth/Keys'),
        request: { method: 'GET', headers: { get: () => null } },
        // 2026-10-13: the /j middleware sets a jellyfin_compat principal; admin is its verdict.
        locals: { user, principal: { kind: 'jellyfin_compat', isAdmin: user.isAdmin, scopes: [] } },
        params: {},
        route: { id: null },
        cookies: {} as never,
        fetch,
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: () => undefined,
        depends: () => undefined,
        untrack: <T>(fn: () => T) => fn(),
    } as unknown as RequestEvent;
}

const DENIS_UUID = '00000000-0000-0000-0000-0000000000de';
const BOB_UUID = '00000000-0000-0000-0000-0000000000b0';

const ADMIN: UserShape = {
    username: 'denis',
    userId: DENIS_UUID,
    isAdmin: true,
    userGroups: ['admins'],
    groups: 'admins',
};

const NON_ADMIN: UserShape = {
    username: 'bob',
    userId: BOB_UUID,
    isAdmin: false,
    userGroups: ['users'],
    groups: 'users',
};

interface PatRow {
    id: number;
    name: string;
    description: string | null;
    tokenPrefix: string;
    scopes: string[];
    createdAt: Date;
    expiresAt: Date | null;
    lastUsedAt: Date | null;
    lastUsedIp: string | null;
    usageCount: number;
    isExpired: boolean;
}

function makePat(partial: Partial<PatRow> & { id: number; name: string }): PatRow {
    return {
        description: null,
        tokenPrefix: 'pat_xxxx',
        scopes: ['jellyfin_compat'],
        createdAt: new Date('2026-05-07T00:00:00Z'),
        expiresAt: null,
        lastUsedAt: null,
        lastUsedIp: null,
        usageCount: 0,
        isExpired: false,
        ...partial,
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /j/Auth/Keys — inbox semantics', () => {
    beforeEach(() => {
        mockListForUser.mockReset();
        mockConsumeAuthKey.mockReset();
    });

    it('returns plaintext for PATs with an active stash', async () => {
        mockListForUser.mockResolvedValue([
            makePat({
                id: 1,
                name: 'Jellyfin Connect: Test',
                createdAt: new Date('2026-05-07T00:00:00Z'),
            }),
        ]);
        mockConsumeAuthKey.mockResolvedValue('plaintext-abc');

        const { GET } = await import('./+server');
        const res = await GET(buildEvent(ADMIN));
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
            Items: Array<{
                AppName: string;
                AccessToken: string;
                DateCreated: string;
                Id: number;
            }>;
            TotalRecordCount: number;
        };

        expect(body.TotalRecordCount).toBe(1);
        expect(body.Items).toHaveLength(1);
        expect(body.Items[0]).toEqual({
            AppName: 'Test',
            AccessToken: 'plaintext-abc',
            DateCreated: '2026-05-07T00:00:00.000Z',
            Id: 1,
        });
        expect(mockListForUser).toHaveBeenCalledWith(DENIS_UUID, {
            scopes: ['jellyfin_compat'],
        });
        expect(mockConsumeAuthKey).toHaveBeenCalledWith(1);
    });

    it('filters out PATs without an active stash', async () => {
        mockListForUser.mockResolvedValue([
            makePat({ id: 1, name: 'Jellyfin Connect: Old' }),
            makePat({ id: 2, name: 'Jellyfin Connect: Active' }),
        ]);
        // Keyed on pat id (not call order) so the result is deterministic
        // regardless of iteration order: id 1 (Old) stash expired, id 2 (Active) live.
        mockConsumeAuthKey.mockImplementation(async (id: number) =>
            id === 2 ? 'plaintext-xyz' : null,
        );

        const { GET } = await import('./+server');
        const res = await GET(buildEvent(ADMIN));
        const body = (await res.json()) as {
            Items: Array<{ AppName: string; Id: number }>;
            TotalRecordCount: number;
        };

        expect(body.TotalRecordCount).toBe(1);
        expect(body.Items).toHaveLength(1);
        expect(body.Items[0].AppName).toBe('Active');
        expect(body.Items[0].Id).toBe(2);
        expect(mockConsumeAuthKey).toHaveBeenCalledTimes(2);
    });

    it('returns an empty list when no PATs have an active stash', async () => {
        mockListForUser.mockResolvedValue([
            makePat({ id: 1, name: 'Jellyfin Connect: A' }),
            makePat({ id: 2, name: 'Jellyfin Connect: B' }),
        ]);
        mockConsumeAuthKey.mockResolvedValue(null);

        const { GET } = await import('./+server');
        const res = await GET(buildEvent(ADMIN));
        const body = (await res.json()) as {
            Items: unknown[];
            TotalRecordCount: number;
        };

        expect(body.TotalRecordCount).toBe(0);
        expect(body.Items).toEqual([]);
    });

    it('returns an empty list when the user has no jellyfin_compat PATs', async () => {
        mockListForUser.mockResolvedValue([]);

        const { GET } = await import('./+server');
        const res = await GET(buildEvent(ADMIN));
        const body = (await res.json()) as {
            Items: unknown[];
            TotalRecordCount: number;
        };

        expect(body.TotalRecordCount).toBe(0);
        expect(body.Items).toEqual([]);
        expect(mockConsumeAuthKey).not.toHaveBeenCalled();
    });

    it('rejects non-admin callers with 403', async () => {
        const { GET } = await import('./+server');
        const res = await GET(buildEvent(NON_ADMIN));
        expect(res.status).toBe(403);
        expect(mockListForUser).not.toHaveBeenCalled();
        expect(mockConsumeAuthKey).not.toHaveBeenCalled();
    });

    it('strips the "Jellyfin Connect: " prefix from PAT names', async () => {
        mockListForUser.mockResolvedValue([
            makePat({ id: 7, name: 'Jellyfin Connect: My Cool App' }),
        ]);
        mockConsumeAuthKey.mockResolvedValue('tok');

        const { GET } = await import('./+server');
        const res = await GET(buildEvent(ADMIN));
        const body = (await res.json()) as {
            Items: Array<{ AppName: string }>;
        };

        expect(body.Items[0].AppName).toBe('My Cool App');
    });

    it('preserves PAT name when prefix is absent (defensive)', async () => {
        // PATs minted outside the /Auth/Keys flow may not carry the prefix;
        // we surface their raw name rather than mangling it.
        mockListForUser.mockResolvedValue([makePat({ id: 9, name: 'Hand-rolled API Key' })]);
        mockConsumeAuthKey.mockResolvedValue('tok');

        const { GET } = await import('./+server');
        const res = await GET(buildEvent(ADMIN));
        const body = (await res.json()) as {
            Items: Array<{ AppName: string }>;
        };

        expect(body.Items[0].AppName).toBe('Hand-rolled API Key');
    });

    it('serializes createdAt as ISO 8601 string', async () => {
        const created = new Date('2026-01-15T12:34:56.789Z');
        mockListForUser.mockResolvedValue([
            makePat({ id: 1, name: 'Jellyfin Connect: X', createdAt: created }),
        ]);
        mockConsumeAuthKey.mockResolvedValue('tok');

        const { GET } = await import('./+server');
        const res = await GET(buildEvent(ADMIN));
        const body = (await res.json()) as {
            Items: Array<{ DateCreated: string }>;
        };

        expect(body.Items[0].DateCreated).toBe('2026-01-15T12:34:56.789Z');
    });
});
