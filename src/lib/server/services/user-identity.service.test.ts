// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the federated-identity service — the pure pieces that don't need
 * a database: the issuer-scoped provider key and the best-effort recorder's
 * error-swallowing contract.
 */

import { describe, it, expect } from 'vitest';
import type postgres from 'postgres';
import {
    oidcProviderKey,
    recordIdentityBestEffort,
    PROVIDER_NATIVE,
} from './user-identity.service.js';

/** A fake `sql` tagged-template whose every query resolves to []. */
function okSql(): postgres.Sql {
    const fn = () => Promise.resolve([]);
    return fn as unknown as postgres.Sql;
}

/** A fake `sql` tagged-template whose every query rejects. */
function failingSql(): postgres.Sql {
    const fn = () => Promise.reject(new Error('db down'));
    return fn as unknown as postgres.Sql;
}

describe('oidcProviderKey', () => {
    it('produces a stable oidc:<sha256-hex> key', () => {
        const key = oidcProviderKey('https://idp.example.com/');
        expect(key).toMatch(/^oidc:[0-9a-f]{64}$/);
    });

    it('is deterministic for the same issuer', () => {
        expect(oidcProviderKey('https://idp.example.com/')).toBe(
            oidcProviderKey('https://idp.example.com/'),
        );
    });

    it('is issuer-scoped: different issuers never collide', () => {
        // Two IdPs could both emit sub="alice"; the provider key must differ so
        // their identities can't be confused.
        expect(oidcProviderKey('https://idp-a.example.com/')).not.toBe(
            oidcProviderKey('https://idp-b.example.com/'),
        );
    });

    it('treats trailing-slash / path differences as distinct issuers', () => {
        expect(oidcProviderKey('https://idp.example.com')).not.toBe(
            oidcProviderKey('https://idp.example.com/'),
        );
    });
});

describe('recordIdentityBestEffort', () => {
    it('returns true when the upsert succeeds', async () => {
        const ok = await recordIdentityBestEffort(okSql(), {
            provider: PROVIDER_NATIVE,
            subject: 'alice',
            userId: '00000000-0000-0000-0000-000000000001',
        });
        expect(ok).toBe(true);
    });

    it('swallows DB errors and returns false (never throws)', async () => {
        const ok = await recordIdentityBestEffort(failingSql(), {
            provider: PROVIDER_NATIVE,
            subject: 'alice',
            userId: '00000000-0000-0000-0000-000000000001',
        });
        expect(ok).toBe(false);
    });
});
