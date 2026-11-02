// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the derived `config.AUTH_OIDC_LOGIN_AVAILABLE` getter.
 *
 * This predicate answers "can OIDC actually render a sign-in control?" and is
 * consumed by four places that MUST agree: the forward-auth redirect gate
 * (middleware/forward-auth.ts), the /login loader, the boot preflight
 * (preflight/config-doctor.ts) and isOidcConfigured() in services/oidc.service.
 * If the gate and /login ever disagree, an anonymous visitor ping-pongs between
 * them — so the derivation is pinned here rather than only through the
 * config-mocking callers' tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const OIDC_ENV_KEYS = ['AUTH_OIDC_ENABLED', 'AUTH_OIDC_ISSUER', 'AUTH_OIDC_CLIENT_ID'] as const;

/**
 * Load a fresh config module with the given env vars in place. `$env/dynamic/private`
 * reads process.env at access time, so setting it before the import is what the
 * getters see.
 */
async function loadConfig(
    envVars: Partial<Record<(typeof OIDC_ENV_KEYS)[number], string>>,
): Promise<{ config: { AUTH_OIDC_LOGIN_AVAILABLE: boolean } }> {
    for (const key of OIDC_ENV_KEYS) delete process.env[key];
    Object.assign(process.env, envVars);
    vi.resetModules();
    return (await import('./config.js')) as unknown as {
        config: { AUTH_OIDC_LOGIN_AVAILABLE: boolean };
    };
}

const FULL = {
    AUTH_OIDC_ENABLED: 'true',
    AUTH_OIDC_ISSUER: 'https://idp.example.com/application/o/lumastra/',
    AUTH_OIDC_CLIENT_ID: 'lumastra',
};

beforeEach(() => {
    vi.resetModules();
});

describe('config.AUTH_OIDC_LOGIN_AVAILABLE', () => {
    it('is true when enabled with an issuer and a client id', async () => {
        const { config } = await loadConfig(FULL);
        expect(config.AUTH_OIDC_LOGIN_AVAILABLE).toBe(true);
    });

    it('is false when the feature flag is off, however complete the rest is', async () => {
        const { config } = await loadConfig({ ...FULL, AUTH_OIDC_ENABLED: 'false' });
        expect(config.AUTH_OIDC_LOGIN_AVAILABLE).toBe(false);
    });

    it('is false when only the flag is set — the regression that stranded operators', async () => {
        const { config } = await loadConfig({ AUTH_OIDC_ENABLED: 'true' });
        expect(config.AUTH_OIDC_LOGIN_AVAILABLE).toBe(false);
    });

    it('is false when the client id is missing', async () => {
        const { config } = await loadConfig({ ...FULL, AUTH_OIDC_CLIENT_ID: '' });
        expect(config.AUTH_OIDC_LOGIN_AVAILABLE).toBe(false);
    });

    it('is false when the issuer is missing', async () => {
        const { config } = await loadConfig({ ...FULL, AUTH_OIDC_ISSUER: '' });
        expect(config.AUTH_OIDC_LOGIN_AVAILABLE).toBe(false);
    });

    it('treats whitespace-only values as unset (the getters trim)', async () => {
        const { config } = await loadConfig({
            ...FULL,
            AUTH_OIDC_ISSUER: '   ',
            AUTH_OIDC_CLIENT_ID: '\t',
        });
        expect(config.AUTH_OIDC_LOGIN_AVAILABLE).toBe(false);
    });

    it('is false on a bare install with nothing configured', async () => {
        const { config } = await loadConfig({});
        expect(config.AUTH_OIDC_LOGIN_AVAILABLE).toBe(false);
    });
});
