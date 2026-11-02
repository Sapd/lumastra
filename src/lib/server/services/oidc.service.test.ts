// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the OIDC discovery probe (probeOidcDiscovery) used by the
 * first-run wizard's "Test connection" button. openid-client's `discovery` +
 * the config object are mocked, so no IdP or network is touched — we drive the
 * serverMetadata() shape directly to assert the derived sanity checks.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as oidc from 'openid-client';
import { LoggerInstance } from '$lib/server/utils/logger.js';

// Mutable config the service reads at call time; tweak per test.
const { mockConfig } = vi.hoisted(() => ({
    mockConfig: {
        AUTH_OIDC_ENABLED: true,
        AUTH_OIDC_ISSUER: 'https://idp.example.com',
        AUTH_OIDC_CLIENT_ID: 'client-abc',
        AUTH_OIDC_CLIENT_SECRET: 'secret-xyz',
        AUTH_OIDC_ALLOW_INSECURE: false,
        AUTH_OIDC_SCOPES: 'openid profile email',
        AUTH_OIDC_GROUPS_CLAIM: 'groups',
        // Derived on the real config object; isOidcConfigured() delegates to it so
        // the forward-auth gate and /login share one definition. Mirrored here
        // (not a fixed literal) so flipping the three inputs above still works.
        get AUTH_OIDC_LOGIN_AVAILABLE(): boolean {
            return (
                this.AUTH_OIDC_ENABLED &&
                this.AUTH_OIDC_ISSUER.length > 0 &&
                this.AUTH_OIDC_CLIENT_ID.length > 0
            );
        },
    },
}));

const { mockDiscovery } = vi.hoisted(() => ({ mockDiscovery: vi.fn() }));

// Keep every other config export real (the oidc.service import graph reaches the
// task registry, which reads FEATURE_PER_TASK_QUEUES etc. at load) — override only
// the `config` object with our mutable OIDC fixture.
vi.mock('$lib/server/config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config.js')>();
    return { ...actual, config: mockConfig };
});

vi.mock('openid-client', async (importOriginal) => ({
    ...(await importOriginal<typeof import('openid-client')>()),
    discovery: (...args: unknown[]) => mockDiscovery(...args),
}));

// Build a fake openid-client Configuration whose serverMetadata() returns `meta`.
function fakeConfig(meta: Record<string, unknown>) {
    return { serverMetadata: () => meta };
}

const FULL_META = {
    issuer: 'https://idp.example.com',
    authorization_endpoint: 'https://idp.example.com/authorize',
    token_endpoint: 'https://idp.example.com/token',
    userinfo_endpoint: 'https://idp.example.com/userinfo',
    jwks_uri: 'https://idp.example.com/jwks',
    end_session_endpoint: 'https://idp.example.com/logout',
    scopes_supported: ['openid', 'profile', 'email', 'groups'],
    code_challenge_methods_supported: ['S256', 'plain'],
    claims_supported: ['sub', 'email', 'email_verified', 'preferred_username', 'groups', 'name'],
    backchannel_logout_supported: true,
};

describe('probeOidcDiscovery', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });
    beforeEach(async () => {
        vi.clearAllMocks();
        // Reset both the module-level discovery cache and the config back to defaults.
        const { resetOidcConfigCache } = await import('./oidc.service.js');
        resetOidcConfigCache();
        Object.assign(mockConfig, {
            AUTH_OIDC_ENABLED: true,
            AUTH_OIDC_ISSUER: 'https://idp.example.com',
            AUTH_OIDC_CLIENT_ID: 'client-abc',
            AUTH_OIDC_CLIENT_SECRET: 'secret-xyz',
            AUTH_OIDC_ALLOW_INSECURE: false,
            AUTH_OIDC_SCOPES: 'openid profile email',
            AUTH_OIDC_GROUPS_CLAIM: 'groups',
        });
    });

    it('maps endpoints, scopes, PKCE and claim checks on a full discovery doc', async () => {
        mockDiscovery.mockResolvedValue(fakeConfig(FULL_META));
        const { probeOidcDiscovery } = await import('./oidc.service.js');

        const r = await probeOidcDiscovery();

        expect(r.ok).toBe(true);
        expect(r.issuer).toBe('https://idp.example.com');
        expect(r.endpoints).toEqual({
            authorization: 'https://idp.example.com/authorize',
            token: 'https://idp.example.com/token',
            userinfo: 'https://idp.example.com/userinfo',
            jwks: 'https://idp.example.com/jwks',
            endSession: 'https://idp.example.com/logout',
        });
        expect(r.requestedScopes).toEqual(['openid', 'profile', 'email']);
        expect(r.missingScopes).toEqual([]);
        expect(r.supportsPkceS256).toBe(true);
        expect(r.supportsBackchannelLogout).toBe(true);
        expect(r.groupsClaim).toBe('groups');
        expect(r.groupsClaimAdvertised).toBe(true);
        expect(r.emailAdvertised).toBe(true);
        expect(r.preferredUsernameAdvertised).toBe(true);
        expect(r.insecure).toBe(false);
    });

    it('re-runs discovery on every probe instead of answering from the cache', async () => {
        mockDiscovery.mockResolvedValueOnce(fakeConfig(FULL_META));
        const { probeOidcDiscovery } = await import('./oidc.service.js');
        expect((await probeOidcDiscovery()).ok).toBe(true);

        // The IdP goes down after the first (cached) discovery.
        mockDiscovery.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
        const r = await probeOidcDiscovery();

        expect(mockDiscovery).toHaveBeenCalledTimes(2);
        expect(r.ok).toBe(false);
    });

    it('flags a requested scope the OP does not advertise', async () => {
        mockConfig.AUTH_OIDC_SCOPES = 'openid profile email groups';
        mockDiscovery.mockResolvedValue(
            fakeConfig({ ...FULL_META, scopes_supported: ['openid', 'profile', 'email'] }),
        );
        const { probeOidcDiscovery } = await import('./oidc.service.js');

        const r = await probeOidcDiscovery();

        expect(r.ok).toBe(true);
        expect(r.missingScopes).toEqual(['groups']);
    });

    it('marks groupsClaimAdvertised=false when the OP omits the groups claim', async () => {
        mockDiscovery.mockResolvedValue(
            fakeConfig({
                ...FULL_META,
                claims_supported: ['sub', 'email', 'email_verified', 'name'],
            }),
        );
        const { probeOidcDiscovery } = await import('./oidc.service.js');

        const r = await probeOidcDiscovery();

        expect(r.groupsClaimAdvertised).toBe(false);
        expect(r.emailAdvertised).toBe(true);
        expect(r.preferredUsernameAdvertised).toBe(false);
    });

    it('leaves groupsClaimAdvertised undefined for a nested claim path', async () => {
        mockConfig.AUTH_OIDC_GROUPS_CLAIM = 'realm_access.roles';
        mockDiscovery.mockResolvedValue(fakeConfig(FULL_META));
        const { probeOidcDiscovery } = await import('./oidc.service.js');

        const r = await probeOidcDiscovery();

        expect(r.groupsClaim).toBe('realm_access.roles');
        expect(r.groupsClaimAdvertised).toBeUndefined();
    });

    it('leaves advertised-claim checks undefined when claims_supported is absent', async () => {
        const meta = { ...FULL_META };
        delete (meta as Record<string, unknown>).claims_supported;
        delete (meta as Record<string, unknown>).scopes_supported;
        delete (meta as Record<string, unknown>).code_challenge_methods_supported;
        mockDiscovery.mockResolvedValue(fakeConfig(meta));
        const { probeOidcDiscovery } = await import('./oidc.service.js');

        const r = await probeOidcDiscovery();

        expect(r.ok).toBe(true);
        expect(r.claimsSupported).toBeUndefined();
        expect(r.groupsClaimAdvertised).toBeUndefined();
        expect(r.emailAdvertised).toBeUndefined();
        expect(r.missingScopes).toBeUndefined();
        expect(r.supportsPkceS256).toBeUndefined();
    });

    it('returns ok:false when discovery succeeds but the issuer is empty', async () => {
        mockDiscovery.mockResolvedValue(fakeConfig({ ...FULL_META, issuer: undefined }));
        const { probeOidcDiscovery } = await import('./oidc.service.js');

        const r = await probeOidcDiscovery();

        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/issuer/i);
    });

    it('returns ok:false with the error message when discovery throws', async () => {
        mockDiscovery.mockRejectedValue(new Error('ENOTFOUND idp.example.com'));
        const { probeOidcDiscovery } = await import('./oidc.service.js');

        const r = await probeOidcDiscovery();

        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/discovery|issuer/i);
        // groupsClaim is still populated on the failure path (from config).
        expect(r.groupsClaim).toBe('groups');
        expect(r.requestedScopes).toEqual(['openid', 'profile', 'email']);
    });

    it('names the underlying fetch cause + a TLS hint instead of a bare "fetch failed"', async () => {
        const cause = Object.assign(new Error('self-signed certificate in certificate chain'), {
            code: 'SELF_SIGNED_CERT_IN_CHAIN',
        });
        mockDiscovery.mockRejectedValue(new TypeError('fetch failed', { cause }));
        const { probeOidcDiscovery } = await import('./oidc.service.js');

        const r = await probeOidcDiscovery();

        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/TLS/);
        expect(r.error).toContain('NODE_EXTRA_CA_CERTS');
    });

    it('returns ok:false when OIDC is not configured (no discovery call)', async () => {
        mockConfig.AUTH_OIDC_ENABLED = false;
        const { probeOidcDiscovery } = await import('./oidc.service.js');

        const r = await probeOidcDiscovery();

        expect(r.ok).toBe(false);
        expect(r.error).toBeTruthy();
        expect(mockDiscovery).not.toHaveBeenCalled();
    });

    it('probes an unsaved candidate while OIDC is disabled without changing config or cache', async () => {
        mockConfig.AUTH_OIDC_ENABLED = false;
        mockDiscovery.mockResolvedValue(fakeConfig(FULL_META));
        const { probeOidcDiscovery } = await import('./oidc.service.js');
        const candidate = {
            issuer: 'https://candidate.example.com',
            clientId: 'new-client',
            clientSecret: 'new-secret',
            scopes: 'openid email',
            groupsClaim: 'roles',
        };
        mockDiscovery.mockResolvedValueOnce(fakeConfig({ ...FULL_META, issuer: candidate.issuer }));
        const result = await probeOidcDiscovery(candidate);
        expect(result.ok).toBe(true);
        expect(result.groupsClaim).toBe('roles');
        expect(result.requestedScopes).toEqual(['openid', 'email']);
        expect(mockDiscovery).toHaveBeenCalledWith(
            new URL(candidate.issuer),
            'new-client',
            'new-secret',
            undefined,
            expect.objectContaining({ timeout: 5, [oidc.customFetch]: expect.any(Function) }),
        );
        expect(mockConfig.AUTH_OIDC_ENABLED).toBe(false);
        expect(mockConfig.AUTH_OIDC_ISSUER).toBe(FULL_META.issuer);
        expect(mockConfig.AUTH_OIDC_CLIENT_SECRET).toBe('secret-xyz');
        expect((await probeOidcDiscovery()).ok).toBe(false);
    });

    it.each(['ENOTFOUND', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT'])(
        'explains an unreachable issuer without echoing request credentials (%s)',
        async (code) => {
            const leaked = 'https://user:password@idp.example.com/?key=secret-xyz';
            const cause = Object.assign(new Error(leaked), { code });
            mockDiscovery.mockRejectedValue(new TypeError(leaked, { cause }));
            const { probeOidcDiscovery } = await import('./oidc.service.js');
            const result = await probeOidcDiscovery();
            expect(result.ok).toBe(false);
            expect(result.error).toMatch(/unreachable/i);
            expect(result.error).not.toContain('password');
            expect(result.error).not.toContain('secret-xyz');
        },
    );

    it.each(['authorization_endpoint', 'token_endpoint', 'jwks_uri'])(
        'rejects discovery missing %s',
        async (field) => {
            mockDiscovery.mockResolvedValue(fakeConfig({ ...FULL_META, [field]: undefined }));
            const { probeOidcDiscovery } = await import('./oidc.service.js');
            const result = await probeOidcDiscovery();
            expect(result.ok).toBe(false);
            expect(result.error).toMatch(/discovery.*invalid/i);
        },
    );

    it('does not echo malformed discovery errors', async () => {
        mockDiscovery.mockRejectedValue(
            new Error('invalid document https://user:password@host/?key=secret-xyz'),
        );
        const { probeOidcDiscovery } = await import('./oidc.service.js');
        const result = await probeOidcDiscovery();
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/discovery.*invalid/i);
        expect(result.error).not.toContain('password');
        expect(result.error).not.toContain('secret-xyz');
    });

    it('rejects a non-https issuer unless allow-insecure is set', async () => {
        mockConfig.AUTH_OIDC_ISSUER = 'http://idp.example.com';
        const { probeOidcDiscovery } = await import('./oidc.service.js');

        const r = await probeOidcDiscovery();

        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/https/i);
        expect(mockDiscovery).not.toHaveBeenCalled();
    });

    it('allows a non-https issuer when AUTH_OIDC_ALLOW_INSECURE is true and flags insecure', async () => {
        mockConfig.AUTH_OIDC_ISSUER = 'http://idp.example.com';
        mockConfig.AUTH_OIDC_ALLOW_INSECURE = true;
        mockDiscovery.mockResolvedValue(
            fakeConfig({ ...FULL_META, issuer: 'http://idp.example.com' }),
        );
        const { probeOidcDiscovery } = await import('./oidc.service.js');

        const r = await probeOidcDiscovery();

        expect(r.ok).toBe(true);
        expect(r.insecure).toBe(true);
        expect(mockDiscovery).toHaveBeenCalled();
    });

    it('explicitly forbids redirect following in the discovery transport', async () => {
        const fetch = vi.fn().mockResolvedValue(new Response('{}'));
        vi.stubGlobal('fetch', fetch);
        mockDiscovery.mockResolvedValue(fakeConfig(FULL_META));
        const { probeOidcDiscovery } = await import('./oidc.service.js');
        await probeOidcDiscovery();
        const options = mockDiscovery.mock.calls[0][4] as oidc.DiscoveryRequestOptions;
        const transport = options[oidc.customFetch];
        expect(transport).toBeTypeOf('function');
        const controller = new AbortController();
        await transport!('https://192.168.1.20/.well-known/openid-configuration', {
            body: undefined,
            method: 'GET',
            headers: {},
            redirect: 'manual',
            signal: controller.signal,
        });
        expect(fetch).toHaveBeenCalledWith(
            'https://192.168.1.20/.well-known/openid-configuration',
            expect.objectContaining({ redirect: 'error' }),
        );
    });

    it('shares a two-probe process cap between setup candidates and configured probes without queuing', async () => {
        let finish: () => void = () => undefined;
        const pending = new Promise<ReturnType<typeof fakeConfig>>((resolve) => {
            finish = () => resolve(fakeConfig(FULL_META));
        });
        mockDiscovery.mockReturnValue(pending);
        const { probeOidcDiscovery } = await import('./oidc.service.js');
        const candidate = {
            issuer: FULL_META.issuer,
            clientId: 'candidate',
            clientSecret: '',
            scopes: 'openid',
            groupsClaim: 'groups',
        };
        const first = probeOidcDiscovery(candidate);
        const second = probeOidcDiscovery();
        const third = probeOidcDiscovery(candidate);
        try {
            const result = await Promise.race([third, Promise.resolve('still pending')]);
            expect(result).toEqual(
                expect.objectContaining({
                    ok: false,
                    error: expect.stringMatching(/busy|in progress/i),
                }),
            );
            expect(mockDiscovery).toHaveBeenCalledTimes(2);
        } finally {
            finish();
            await Promise.all([first, second, third]);
        }
        mockDiscovery.mockResolvedValue(fakeConfig(FULL_META));
        expect((await probeOidcDiscovery()).ok).toBe(true);
    });

    it('aborts slow probes after five seconds and releases their permits after failure', async () => {
        const deadline = new AbortController();
        const upstream = new AbortController();
        const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
        const fetch = vi.fn(
            (_url: string, init: RequestInit) =>
                new Promise<Response>((_resolve, reject) => {
                    init.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
                        once: true,
                    });
                }),
        );
        vi.stubGlobal('fetch', fetch);
        mockDiscovery.mockImplementation(
            async (
                _issuer: URL,
                _clientId: string,
                _secret: string,
                _auth: unknown,
                options: oidc.DiscoveryRequestOptions,
            ) => {
                const transport = options[oidc.customFetch] ?? globalThis.fetch;
                await transport(FULL_META.issuer, {
                    body: undefined,
                    method: 'GET',
                    headers: {},
                    redirect: 'manual',
                    signal: upstream.signal,
                });
                return fakeConfig(FULL_META);
            },
        );
        const { probeOidcDiscovery } = await import('./oidc.service.js');
        const first = probeOidcDiscovery();
        const second = probeOidcDiscovery();
        try {
            expect(mockDiscovery.mock.calls[0][4].timeout).toBe(5);
            expect(timeout).toHaveBeenCalledWith(5000);
            deadline.abort(new DOMException('OIDC discovery timed out', 'TimeoutError'));
            expect((await first).ok).toBe(false);
            expect((await second).ok).toBe(false);
            expect(fetch.mock.calls.every(([, init]) => init.signal?.aborted)).toBe(true);
        } finally {
            upstream.abort();
            await Promise.all([first, second]);
        }
        timeout.mockRestore();
        mockDiscovery.mockResolvedValue(fakeConfig(FULL_META));
        expect((await probeOidcDiscovery()).ok).toBe(true);
    });

    it('does not replace the login cache with a probe-specific transport or timeout', async () => {
        const { getOidcServerMetadata, probeOidcDiscovery } = await import('./oidc.service.js');
        mockDiscovery.mockResolvedValueOnce(fakeConfig(FULL_META));
        expect((await getOidcServerMetadata()).jwksUri).toBe(FULL_META.jwks_uri);
        mockDiscovery.mockResolvedValueOnce(
            fakeConfig({ ...FULL_META, jwks_uri: 'https://idp.example.com/probe-only' }),
        );
        expect((await probeOidcDiscovery()).ok).toBe(true);
        expect((await getOidcServerMetadata()).jwksUri).toBe(FULL_META.jwks_uri);
        expect(mockDiscovery).toHaveBeenCalledTimes(2);
    });

    it('refuses a redirect through the real discovery library without requesting its target', async () => {
        const actual = await vi.importActual<typeof import('openid-client')>('openid-client');
        mockDiscovery.mockImplementation(actual.discovery);
        const fetch = vi.fn().mockResolvedValue(
            new Response(null, {
                status: 302,
                headers: { location: 'https://192.168.1.10:8443/private' },
            }),
        );
        vi.stubGlobal('fetch', fetch);
        const { probeOidcDiscovery } = await import('./oidc.service.js');
        expect((await probeOidcDiscovery()).ok).toBe(false);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(fetch).toHaveBeenCalledWith(
            expect.stringContaining('idp.example.com'),
            expect.objectContaining({ redirect: 'error' }),
        );
    });

    it('reports the real discovery library timeout as an unreachable issuer', async () => {
        const actual = await vi.importActual<typeof import('openid-client')>('openid-client');
        mockDiscovery.mockImplementation(actual.discovery);
        const deadline = new AbortController();
        vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
        const fetch = vi.fn(
            (_url: string, init: RequestInit) =>
                new Promise<Response>((_resolve, reject) => {
                    if (init.signal?.aborted) reject(init.signal.reason);
                    else
                        init.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
                            once: true,
                        });
                }),
        );
        vi.stubGlobal('fetch', fetch);
        const { probeOidcDiscovery } = await import('./oidc.service.js');
        const pending = probeOidcDiscovery();
        try {
            await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
            deadline.abort(new DOMException('Discovery deadline exceeded', 'TimeoutError'));
            const result = await pending;
            expect(result.ok).toBe(false);
            expect(result.error).toMatch(/unreachable/i);
        } finally {
            deadline.abort();
            await pending;
        }
    });

    it('preserves the original discovery cause and logs English diagnostics without credentials', async () => {
        const messages = await import('$lib/paraglide/messages');
        vi.spyOn(messages, 'setup_oidc_discovery_tls').mockReturnValue(
            'Lokalisierte TLS-Fehlermeldung' as ReturnType<
                typeof messages.setup_oidc_discovery_tls
            >,
        );
        const warn = vi.spyOn(LoggerInstance.prototype, 'warn').mockImplementation(() => undefined);
        const cause = Object.assign(
            new Error(
                'certificate failed for https://username:password@idp.example.com/?key=private-key',
            ),
            { code: 'SELF_SIGNED_CERT_IN_CHAIN' },
        );
        const original = new TypeError('fetch failed: secret-xyz', { cause });
        mockDiscovery.mockRejectedValue(original);
        const { getOidcServerMetadata } = await import('./oidc.service.js');
        await expect(getOidcServerMetadata()).rejects.toMatchObject({
            message: 'Lokalisierte TLS-Fehlermeldung',
            cause: original,
        });
        expect(warn).toHaveBeenCalledWith(
            'OIDC discovery failed',
            expect.objectContaining({
                failure: 'tls',
                error: expect.stringContaining('SELF_SIGNED_CERT_IN_CHAIN'),
            }),
        );
        const log = JSON.stringify(warn.mock.calls);
        expect(log).toContain('NODE_EXTRA_CA_CERTS');
        for (const credential of [
            'username',
            'password',
            'private-key',
            'secret-xyz',
            'Lokalisierte',
        ]) {
            expect(log).not.toContain(credential);
        }
    });
});
