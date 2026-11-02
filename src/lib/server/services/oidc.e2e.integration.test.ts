// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End-to-end OIDC round-trip against a REAL (in-process) OpenID Connect server
 * (oauth2-mock-server). Unlike the unit/integration tests that hand-build claims,
 * this exercises the actual openid-client machinery — discovery, PKCE, the
 * authorization-code exchange, and ID-token signature / iss / aud / nonce
 * verification — then provisions a user in the real test database.
 *
 * The Valkey-backed transaction store is replaced with an in-memory map so the test
 * needs no Valkey; everything else (the IdP, the token exchange, the DB) is real.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type postgres from 'postgres';
import { OAuth2Server } from 'oauth2-mock-server';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';

// In-memory replacement for the Valkey-backed login-transaction store.
const txStore = new Map<string, unknown>();
vi.mock('./oidc-tx-store.js', () => ({
    storeTx: vi.fn(async (state: string, tx: unknown) => {
        txStore.set(state, tx);
        return true;
    }),
    consumeTx: vi.fn(async (state: string) => {
        const v = txStore.get(state);
        txStore.delete(state); // single-use
        return v ?? null;
    }),
}));

import { config } from '$lib/server/config.js';
import {
    startLogin,
    handleCallback,
    resolveOrProvisionOidcUser,
    resetOidcConfigCache,
} from './oidc.service.js';

const PREFIX = 'test_oidce2e_';
const CLIENT_ID = 'lumastra-e2e';
const REDIRECT_URI = 'http://localhost:9999/auth/oidc/callback';

let server: OAuth2Server;
let issuerUrl: string;

/** Spy a config getter to a fixed value for the duration of the suite. */
function freezeConfig(key: keyof typeof config, value: unknown): void {
    vi.spyOn(config, key as never, 'get').mockReturnValue(value as never);
}

describe('OIDC end-to-end (real mock IdP)', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
        server = new OAuth2Server();
        await server.issuer.keys.generate('RS256');
        await server.start(0, 'localhost'); // random free port
        issuerUrl = server.issuer.url!;
    });

    afterAll(async () => {
        await server.stop();
        await closeTestDb();
    });

    beforeEach(async () => {
        txStore.clear();
        resetOidcConfigCache();
        // Point the RP at the running mock IdP (plain http → allow-insecure).
        freezeConfig('AUTH_OIDC_ENABLED', true);
        freezeConfig('AUTH_OIDC_ISSUER', issuerUrl);
        freezeConfig('AUTH_OIDC_CLIENT_ID', CLIENT_ID);
        freezeConfig('AUTH_OIDC_CLIENT_SECRET', '');
        freezeConfig('AUTH_OIDC_SCOPES', 'openid email profile');
        freezeConfig('AUTH_OIDC_GROUPS_CLAIM', 'groups');
        freezeConfig('AUTH_OIDC_USERINFO', false);
        freezeConfig('AUTH_OIDC_ALLOW_INSECURE', true);
        freezeConfig('AUTH_OIDC_LINK_BY_VERIFIED_EMAIL', true);
        freezeConfig('AUTH_OIDC_REDIRECT_URI', REDIRECT_URI);
        await sql`DELETE FROM user_identities WHERE provider LIKE 'oidc:%'`;
        await sql`DELETE FROM users WHERE username LIKE ${PREFIX + '%'}`;
    });

    afterEach(() => {
        vi.restoreAllMocks();
        server.service.removeAllListeners('beforeTokenSigning');
    });

    /** Set the claims the mock IdP will mint into every token it signs this test. */
    function setIdpClaims(claims: Record<string, unknown>): void {
        server.service.on('beforeTokenSigning', (token: { payload: Record<string, unknown> }) => {
            Object.assign(token.payload, claims);
        });
    }

    /** Drive the full browser-less flow: startLogin → mock /authorize → handleCallback. */
    async function runFlow(): Promise<Awaited<ReturnType<typeof handleCallback>>> {
        const start = await startLogin({ redirectUri: REDIRECT_URI, returnTo: '/library' });
        // The mock /authorize 302-redirects back to the redirect_uri with ?code&state.
        const authResp = await fetch(start.authorizationUrl, { redirect: 'manual' });
        const location = authResp.headers.get('location');
        expect(location, 'IdP should redirect to the callback').toBeTruthy();
        const callbackUrl = new URL(location!);
        // State round-tripped through the IdP must equal what we issued.
        expect(callbackUrl.searchParams.get('state')).toBe(start.state);
        return handleCallback({ currentUrl: callbackUrl, cookieState: start.state });
    }

    it('completes discovery + code exchange + ID-token verification and parses claims', async () => {
        setIdpClaims({
            sub: 'e2e-subject-1',
            email: 'e2e@corp.example',
            email_verified: true,
            preferred_username: `${PREFIX}alice`,
            name: 'E2E Alice',
            groups: ['admin', 'watchers'],
        });

        const { claims, returnTo } = await runFlow();

        expect(claims.subject).toBe('e2e-subject-1');
        expect(claims.email).toBe('e2e@corp.example');
        expect(claims.emailVerified).toBe(true);
        expect(claims.preferredUsername).toBe(`${PREFIX}alice`);
        expect(claims.groups).toEqual(['admin', 'watchers']);
        expect(returnTo).toBe('/library');
    });

    it('provisions a local user from the verified round-trip claims', async () => {
        setIdpClaims({
            sub: 'e2e-subject-2',
            email: 'e2e2@corp.example',
            email_verified: true,
            preferred_username: `${PREFIX}bob`,
            groups: [],
        });

        const { claims } = await runFlow();
        const resolved = await resolveOrProvisionOidcUser(sql, claims, {
            firstRunRequiresAdmin: false,
        });

        expect(resolved.linkType).toBe('provisioned');
        expect(resolved.username).toBe(`${PREFIX}bob`);

        const row = await sql<{ email: string }[]>`
            SELECT email FROM users WHERE id = ${resolved.userId}
        `;
        expect(row[0].email).toBe('e2e2@corp.example');
    });

    it('rejects a callback whose state does not match the browser-bound cookie', async () => {
        setIdpClaims({ sub: 'e2e-subject-3', email_verified: false });
        const start = await startLogin({ redirectUri: REDIRECT_URI, returnTo: '/' });
        const authResp = await fetch(start.authorizationUrl, { redirect: 'manual' });
        const callbackUrl = new URL(authResp.headers.get('location')!);
        // Tampered cookie (attacker can't know/forge the browser-bound state).
        await expect(
            handleCallback({ currentUrl: callbackUrl, cookieState: 'not-the-real-state' }),
        ).rejects.toThrow();
    });
});
