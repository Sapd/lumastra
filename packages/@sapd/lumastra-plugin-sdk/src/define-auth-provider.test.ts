// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit test — the auth provider contract's refusals.
 *
 * This is the contract where "it works" is not the bar, so the tests are
 * mostly about what it will not accept.
 */

import { describe, it, expect } from 'vitest';
import { defineAuthProvider } from './define-auth-provider.js';
import type { AuthProviderDefinition } from './types.js';

const credentials: AuthProviderDefinition = {
    id: 'ldap',
    name: 'Company LDAP',
    version: '1.0.0',
    capabilities: { http: true, allowedDomains: ['ldap.example.com'] },
    async verifyCredentials() {
        return { ok: false, reason: 'invalid_credentials' };
    },
};

const redirect: AuthProviderDefinition = {
    id: 'discord',
    name: 'Discord',
    version: '1.0.0',
    async beginLogin() {
        return { redirectUrl: 'https://discord.com/oauth2/authorize' };
    },
    async completeLogin() {
        return { ok: false, reason: 'invalid_credentials' };
    },
};

describe('defineAuthProvider', () => {
    it('accepts a credentials provider', () => {
        expect(defineAuthProvider(credentials)).toBe(credentials);
    });

    it('accepts a redirect provider', () => {
        expect(defineAuthProvider(redirect)).toBe(redirect);
    });

    it('REFUSES capabilities.database', () => {
        // Identity mapping is the host's job. A verifier with raw SQL could
        // write `users` and `user_sessions` directly — precisely the
        // arrangement this contract exists to replace.
        expect(() =>
            defineAuthProvider({
                ...credentials,
                capabilities: { database: true } as never,
            }),
        ).toThrow(/database is not permitted/);
    });

    it('REFUSES capabilities.browserUi', () => {
        // A plugin that could script /login could harvest the native password
        // field of an operator who never intended to use that plugin.
        expect(() =>
            defineAuthProvider({
                ...credentials,
                capabilities: { browserUi: true } as never,
            }),
        ).toThrow(/browserUi is not permitted/);
    });

    it('refuses a provider declaring both kinds', () => {
        expect(() => defineAuthProvider({ ...credentials, ...redirect, id: 'both' })).toThrow(
            /not both/,
        );
    });

    it('refuses a provider declaring neither kind', () => {
        const { verifyCredentials: _drop, ...rest } = credentials;
        expect(() => defineAuthProvider(rest)).toThrow(/must declare/);
    });

    it('refuses half a redirect flow', () => {
        // Otherwise the host offers a login button that dead-ends at the
        // callback.
        const { completeLogin: _drop, ...rest } = redirect;
        expect(() => defineAuthProvider(rest)).toThrow(/must declare|BOTH/);
    });

    it('requires a name — it labels the button an operator clicks', () => {
        expect(() => defineAuthProvider({ ...credentials, name: '' })).toThrow(/name is mandatory/);
    });

    it('rejects a non-kebab-case id', () => {
        expect(() => defineAuthProvider({ ...credentials, id: 'My_LDAP' })).toThrow(
            /id must match/,
        );
    });
});
