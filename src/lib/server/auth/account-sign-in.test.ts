// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';

// A spy for the call assertions, plus a plain-function failure switch: a vi.fn
// whose implementation rejects is reported as a test error by vitest 5 even
// when the code under test catches it.
const mockFacts = vi.hoisted(() => ({ getAccountSignInFacts: vi.fn(), fail: false }));
vi.mock('$lib/server/database/queries/user-sessions.queries.js', () => ({
    getAccountSignInFacts: async (...args: unknown[]): Promise<unknown> => {
        if (mockFacts.fail) throw new Error('down');
        return mockFacts.getAccountSignInFacts(...args);
    },
}));

import { resolveAccountSignIn, loadAccountSignIn } from './account-sign-in.js';

const sql = {} as postgres.Sql;

describe('resolveAccountSignIn', () => {
    it('an OIDC session names the provider even though authMethod is "session"', () => {
        expect(
            resolveAccountSignIn({
                authMethod: 'session',
                hasPassword: false,
                sessionIsOidc: true,
                oidcProviderName: 'Dex',
            }),
        ).toEqual({ method: 'oidc', providerName: 'Dex', hasPassword: false });
    });

    it('a built-in login session with a password is "password"', () => {
        expect(
            resolveAccountSignIn({
                authMethod: 'session',
                hasPassword: true,
                sessionIsOidc: false,
                oidcProviderName: 'Dex',
            }),
        ).toEqual({ method: 'password', providerName: null, hasPassword: true });
    });

    it('forward auth is "proxy", regardless of a stored password', () => {
        expect(
            resolveAccountSignIn({
                authMethod: 'forward_auth',
                hasPassword: true,
                sessionIsOidc: false,
                oidcProviderName: 'Dex',
            }).method,
        ).toBe('proxy');
    });

    it('a blank provider name leaves providerName null (generic IdP wording)', () => {
        expect(
            resolveAccountSignIn({
                authMethod: 'session',
                hasPassword: false,
                sessionIsOidc: true,
                oidcProviderName: '  ',
            }).providerName,
        ).toBeNull();
    });

    it('a password-less non-OIDC account is "idp", never "password"', () => {
        expect(
            resolveAccountSignIn({
                authMethod: 'session',
                hasPassword: false,
                sessionIsOidc: false,
                oidcProviderName: 'Dex',
            }).method,
        ).toBe('idp');
    });
});

describe('loadAccountSignIn', () => {
    beforeEach(() => {
        mockFacts.getAccountSignInFacts.mockReset();
        mockFacts.fail = false;
    });

    it('passes the user and CURRENT session id to the query', async () => {
        mockFacts.getAccountSignInFacts.mockResolvedValue({
            hasPassword: false,
            sessionIsOidc: true,
        });
        const out = await loadAccountSignIn(sql, {
            userId: 'u1',
            authMethod: 'session',
            sessionId: 's1',
            oidcProviderName: 'Dex',
        });
        expect(mockFacts.getAccountSignInFacts).toHaveBeenCalledWith(sql, 'u1', 's1');
        expect(out).toEqual({ method: 'oidc', providerName: 'Dex', hasPassword: false });
    });

    it('falls back to the authMethod-only reading when the DB read fails', async () => {
        mockFacts.fail = true;
        const out = await loadAccountSignIn(sql, {
            userId: 'u1',
            authMethod: 'session',
            sessionId: 's1',
            oidcProviderName: 'Dex',
        });
        expect(out).toEqual({ method: 'password', providerName: null, hasPassword: true });
    });

    it('without a DB, a forward-auth user is still "proxy" with no password', async () => {
        const out = await loadAccountSignIn(null, {
            userId: 'u1',
            authMethod: 'forward_auth',
            sessionId: null,
            oidcProviderName: 'Dex',
        });
        expect(out).toEqual({ method: 'proxy', providerName: null, hasPassword: false });
    });
});
