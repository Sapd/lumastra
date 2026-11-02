// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The step both auth-provider kinds share: verified claims → a session.
 *
 * It exists as one function precisely so the credentials and redirect flows
 * cannot drift. Every check here — account linking, the first-admin refusal,
 * the suspension check — has to apply identically whether the user typed a
 * password or came back from a provider's redirect, and the cheapest way to
 * guarantee that is to have one place where it happens.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

let sql: unknown = {};
vi.mock('$lib/server/database/connection.js', () => ({
    getDb: () => sql,
}));

const mockResolve = vi.fn();
vi.mock('$lib/server/services/plugin-auth.service.js', () => ({
    resolvePluginIdentity: (...a: unknown[]) => mockResolve(...(a as [])),
}));

let userRow: { id: string; disabled_at: Date | null } | null = null;
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    adminExists: vi.fn(async () => true),
    getUserById: vi.fn(async () => userRow),
}));

vi.mock('$lib/server/services/user-identity.service.js', () => ({
    resolveUserIdByIdentity: vi.fn(),
    provisionUserWithIdentity: vi.fn(),
}));

vi.mock('$lib/server/services/plugin-auth-group-sync.js', () => ({
    syncPluginLoginGroups: vi.fn(async () => undefined),
}));

const mockCreate = vi.fn(async () => ({
    token: 'tok',
    expiresAt: new Date(Date.now() + 3600_000),
}));
vi.mock('$lib/server/services/session.service.js', () => ({
    getSessionService: () => ({ create: mockCreate }),
}));

const mockSetCookie = vi.fn();
vi.mock('./native-session.js', () => ({
    setSessionCookie: (...a: unknown[]) => mockSetCookie(...(a as [])),
    sessionMaxAgeSeconds: () => 3600,
}));

import { establishPluginSession } from './plugin-auth-session.js';

const identity = { subject: 'uid=alice', username: 'alice', groups: [] };
const event = {
    request: { headers: { get: () => null } },
    cookies: { set: vi.fn() },
    getClientAddress: () => '203.0.113.9',
} as never;

beforeEach(() => {
    vi.clearAllMocks();
    sql = {};
    userRow = { id: 'user-1', disabled_at: null };
    mockResolve.mockResolvedValue({ kind: 'user', userId: 'user-1' });
});

describe('the happy path', () => {
    it('mints a session and sets the cookie', async () => {
        const res = await establishPluginSession(event, 'acme', identity);
        expect(res).toEqual({ kind: 'ok', userId: 'user-1' });
        expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1' }));
        expect(mockSetCookie).toHaveBeenCalled();
    });
});

describe('refusals — none of which may mint anything', () => {
    it('a SUSPENDED account', async () => {
        userRow = { id: 'user-1', disabled_at: new Date() };
        const res = await establishPluginSession(event, 'acme', identity);
        expect(res.kind).toBe('account-refused');
        expect(mockCreate).not.toHaveBeenCalled();
        expect(mockSetCookie).not.toHaveBeenCalled();
    });

    it('a user row that vanished between resolution and mint', async () => {
        userRow = null;
        const res = await establishPluginSession(event, 'acme', identity);
        expect(res.kind).toBe('account-refused');
        expect(mockSetCookie).not.toHaveBeenCalled();
    });

    it('an unlinked account, reported distinctly so the UI can say something useful', async () => {
        mockResolve.mockResolvedValue({ kind: 'not-linked' });
        const res = await establishPluginSession(event, 'acme', identity);
        expect(res.kind).toBe('not-linked');
        expect(mockSetCookie).not.toHaveBeenCalled();
    });

    it('a provisioning refusal (no admin exists yet)', async () => {
        mockResolve.mockResolvedValue({ kind: 'refused', reason: 'no administrator exists yet' });
        const res = await establishPluginSession(event, 'acme', identity);
        expect(res.kind).toBe('unavailable');
        expect(mockSetCookie).not.toHaveBeenCalled();
    });

    it('no database', async () => {
        sql = null;
        const res = await establishPluginSession(event, 'acme', identity);
        expect(res.kind).toBe('unavailable');
        expect(mockResolve).not.toHaveBeenCalled();
    });
});
