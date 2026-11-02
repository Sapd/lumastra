// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for config-rules.ts.
 *
 * Each test mocks the minimum set of values required by the rule under test.
 * Pure sub-functions (evaluateJwtSecretStrength, evaluateForwardAuthReflection)
 * are tested without any mocking — they take plain values.
 *
 * Runs with the default vitest suite (`npm run test` / `npx vitest run`):
 * matches the default `src/**\/*.test.ts` include glob and is not excluded.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Module mocks ─────────────────────────────────────────────────────────────
// We mock the entire config module so individual rule tests can supply
// targeted fixtures without touching process.env.

vi.mock('$lib/server/config', () => {
    return {
        config: {
            AUTH_OIDC_ALLOW_INSECURE: false,
            AUTH_OIDC_ENABLED: false,
            AUTH_OIDC_SCOPES: 'openid profile email',
            AUTH_OIDC_CLIENT_ID: 'client-id',
            AUTH_OIDC_CLIENT_SECRET: 'client-secret',
            AUTH_OIDC_LINK_BY_USERNAME: false,
            JWT_SECRET: 'a'.repeat(64),
            NATIVE_AUTH_SESSION_TTL_DAYS: 30,
            AUTH_NATIVE_LOGIN_ENABLED: false,
            FEATURE_SUBSONIC_COMPAT: false,
            FEATURE_JELLYFIN_COMPAT: false,
            DEVICE_VERIFICATION_BASE_URL: 'https://example.com',
            LIVETV_SOURCE: 'disabled',
            STREAM_PROXY_URL: '',
            SETUP_UNLOCK: false,
            FORWARD_AUTH_ENABLED: true,
        },
        devFeaturesEnabled: false,
        features: {
            jellyfinCompat: false,
        },
    };
});

const mockUndecryptableKeys = vi.fn<() => string[]>(() => []);
// Backs checkStreamTokenIpPinningIneffective's getConfigValue('STREAM_TOKEN_WILDCARD_IP')
// read. Defaults to the real config default (true / wildcard IP) so every
// pre-existing test — which doesn't care about this rule — gets its 'pass'
// branch without needing to know about it.
const mockConfigValues: Record<string, unknown> = { STREAM_TOKEN_WILDCARD_IP: true };
vi.mock('$lib/server/config/config.service', () => ({
    getUndecryptableConfigKeys: () => mockUndecryptableKeys(),
    get: (key: string) => mockConfigValues[key],
}));

vi.mock('$lib/server/utils/client-ip', () => {
    return {
        forwardAuthTrustPosture: vi.fn(() => 'allowlist' as const),
    };
});

// Backs checkProxyMasterKeyEnv's getMasterKeySource() read (C25). Defaults to
// 'env' so every pre-existing test that doesn't care about this rule gets the
// "explicit key" branch. The dedicated seam test for the REAL interaction
// between resolveMasterKey() and this rule — proving the back-fill can no
// longer suppress the warning — lives in
// config-rules.proxy-master-key-seam.test.ts, which deliberately does NOT
// mock crypto/master-key.js.
const mockMasterKeySource = vi.fn<() => 'env' | 'file' | 'generated' | 'none'>(() => 'env');
vi.mock('$lib/server/crypto/master-key.js', () => ({
    getMasterKeySource: () => mockMasterKeySource(),
}));

import { config, features } from '$lib/server/config';
import { forwardAuthTrustPosture } from '$lib/server/utils/client-ip';
import {
    checkOidcAllowInsecure,
    checkDevFeaturesEnabled,
    checkJwtSecretMissing,
    checkJwtSecretStrength,
    evaluateJwtSecretStrength,
    checkOidcScopesMissingOpenid,
    checkProxyTrustAny,
    checkProxyUnpinned,
    checkProxyWideRange,
    checkForwardAuthEnabledPosture,
    checkStreamTokenIpPinningIneffective,
    checkNativeSessionTtl,
    checkNativeEnabled,
    checkOidcLinkByUsername,
    checkOidcMissingClient,
    checkCompatJellyfinEnabled,
    checkCompatSubsonicEnabled,
    checkCompatSubsonicCredsInQuery,
    checkDeviceVerificationBaseUrl,
    runConfigRules,
    checkUndecryptableConfigSecrets,
    checkProxyMasterKeyEnv,
    checkSetupUnlockLeftSet,
} from './config-rules';
import {
    noteIgnoredForwardAuthHeaders,
    resetIgnoredForwardAuthSighting,
} from '$lib/server/utils/forward-auth-disabled-observer';

// Helper to cast the mocked config to a writable object for per-test overrides.
const mockConfig = config as Record<string, unknown>;
const mockFeatures = features as Record<string, unknown>;

// ── evaluateJwtSecretStrength (pure — no mocks needed) ───────────────────────

describe('evaluateJwtSecretStrength', () => {
    it('returns fail when length < 32', () => {
        const result = evaluateJwtSecretStrength(16, 10);
        expect(result.status).toBe('fail');
        expect(result.id).toBe('jwt.secret-weak');
        expect(result.detail).toContain('16 character');
    });

    it('returns fail for exactly 31 chars', () => {
        expect(evaluateJwtSecretStrength(31, 16).status).toBe('fail');
    });

    it('returns warn when length >= 32 but unique chars < 8', () => {
        const result = evaluateJwtSecretStrength(64, 3);
        expect(result.status).toBe('warn');
        expect(result.detail).toContain('3 unique');
    });

    it('returns warn for exactly 7 unique chars', () => {
        expect(evaluateJwtSecretStrength(32, 7).status).toBe('warn');
    });

    it('returns pass when length >= 32 and unique chars >= 8', () => {
        const result = evaluateJwtSecretStrength(64, 16);
        expect(result.status).toBe('pass');
    });

    it('returns pass for exactly 32 chars and exactly 8 unique chars', () => {
        expect(evaluateJwtSecretStrength(32, 8).status).toBe('pass');
    });

    it('detail mentions the char count, never secret value', () => {
        const result = evaluateJwtSecretStrength(20, 5);
        // The detail must NOT contain any actual secret value — only counts.
        expect(result.detail).toContain('20 character');
        expect(result.detail).not.toContain('secret=');
    });
});

// ── checkOidcAllowInsecure ───────────────────────────────────────────────────

describe('checkOidcAllowInsecure', () => {
    it('returns fail when AUTH_OIDC_ALLOW_INSECURE=true', () => {
        mockConfig['AUTH_OIDC_ALLOW_INSECURE'] = true;
        const result = checkOidcAllowInsecure();
        expect(result.status).toBe('fail');
        expect(result.id).toBe('oidc.allow-insecure');
    });

    it('returns pass when AUTH_OIDC_ALLOW_INSECURE=false', () => {
        mockConfig['AUTH_OIDC_ALLOW_INSECURE'] = false;
        const result = checkOidcAllowInsecure();
        expect(result.status).toBe('pass');
    });
});

// ── checkDevFeaturesEnabled ──────────────────────────────────────────────────

describe('checkDevFeaturesEnabled', () => {
    // devFeaturesEnabled is a module-level const captured at import time; the
    // config mock pins it to `false`, so this exercises the pass branch. (The
    // fail branch — dev features on in prod — would need a separate mocked
    // module; the rule logic itself is a single boolean check.)
    it('returns pass when devFeaturesEnabled=false (mocked)', () => {
        const result = checkDevFeaturesEnabled();
        expect(result.status).toBe('pass');
        expect(result.id).toBe('dev.features-enabled');
    });
});

// ── checkJwtSecretMissing ────────────────────────────────────────────────────

describe('checkJwtSecretMissing', () => {
    it('returns fail when JWT_SECRET is empty', () => {
        mockConfig['JWT_SECRET'] = '';
        expect(checkJwtSecretMissing().status).toBe('fail');
        expect(checkJwtSecretMissing().id).toBe('jwt.secret-missing');
    });

    it('returns pass when JWT_SECRET is set', () => {
        mockConfig['JWT_SECRET'] = 'a'.repeat(64);
        expect(checkJwtSecretMissing().status).toBe('pass');
    });
});

// ── checkJwtSecretStrength ───────────────────────────────────────────────────

describe('checkJwtSecretStrength', () => {
    it('returns skipped when JWT_SECRET is empty', () => {
        mockConfig['JWT_SECRET'] = '';
        expect(checkJwtSecretStrength().status).toBe('skipped');
    });

    it('returns fail when JWT_SECRET is too short', () => {
        mockConfig['JWT_SECRET'] = 'short';
        expect(checkJwtSecretStrength().status).toBe('fail');
    });

    it('returns warn when JWT_SECRET has low entropy', () => {
        mockConfig['JWT_SECRET'] = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; // 34 chars, 1 unique
        expect(checkJwtSecretStrength().status).toBe('warn');
    });

    it('returns pass for a strong JWT_SECRET', () => {
        mockConfig['JWT_SECRET'] = 'abcdefghijklmnopqrstuvwxyz012345678'; // >= 32, >= 8 unique
        expect(checkJwtSecretStrength().status).toBe('pass');
    });
});

// ── checkOidcScopesMissingOpenid ─────────────────────────────────────────────

describe('checkOidcScopesMissingOpenid', () => {
    it('returns skipped when OIDC is disabled', () => {
        mockConfig['AUTH_OIDC_ENABLED'] = false;
        expect(checkOidcScopesMissingOpenid().status).toBe('skipped');
    });

    it('returns fail when OIDC enabled and openid scope missing', () => {
        mockConfig['AUTH_OIDC_ENABLED'] = true;
        mockConfig['AUTH_OIDC_SCOPES'] = 'profile email';
        const result = checkOidcScopesMissingOpenid();
        expect(result.status).toBe('fail');
        expect(result.id).toBe('oidc.scopes-missing-openid');
    });

    it('returns pass when OIDC enabled and openid scope present', () => {
        mockConfig['AUTH_OIDC_ENABLED'] = true;
        mockConfig['AUTH_OIDC_SCOPES'] = 'openid profile email';
        expect(checkOidcScopesMissingOpenid().status).toBe('pass');
    });

    it('handles openid as the only scope', () => {
        mockConfig['AUTH_OIDC_ENABLED'] = true;
        mockConfig['AUTH_OIDC_SCOPES'] = 'openid';
        expect(checkOidcScopesMissingOpenid().status).toBe('pass');
    });

    it('handles extra whitespace in scope list', () => {
        mockConfig['AUTH_OIDC_ENABLED'] = true;
        mockConfig['AUTH_OIDC_SCOPES'] = '  openid   profile  ';
        expect(checkOidcScopesMissingOpenid().status).toBe('pass');
    });
});

// ── checkProxyTrustAny ───────────────────────────────────────────────────────

describe('checkProxyTrustAny', () => {
    const mockForwardAuthTrustPosture = vi.mocked(forwardAuthTrustPosture);

    it('returns fail when trust-any and not dev', () => {
        mockForwardAuthTrustPosture.mockReturnValue('trust-any');
        // devFeaturesEnabled is false from the mock
        const result = checkProxyTrustAny();
        expect(result.status).toBe('fail');
        expect(result.id).toBe('proxy.trust-any');
    });

    it('returns pass when posture is allowlist', () => {
        mockForwardAuthTrustPosture.mockReturnValue('allowlist');
        expect(checkProxyTrustAny().status).toBe('pass');
    });

    it('returns pass when posture is fail-closed', () => {
        mockForwardAuthTrustPosture.mockReturnValue('fail-closed');
        expect(checkProxyTrustAny().status).toBe('pass');
    });
});

// ── forward auth off (FORWARD_AUTH_ENABLED) ──────────────────────────────────

describe('checkProxyTrustAny with forward auth off', () => {
    const mockConfig = config as unknown as Record<string, unknown>;
    afterEach(() => {
        mockConfig['FORWARD_AUTH_ENABLED'] = true;
    });

    it('passes: trust-any cannot let anyone forge identity while forward auth is off', () => {
        mockConfig['FORWARD_AUTH_ENABLED'] = false;
        vi.mocked(forwardAuthTrustPosture).mockReturnValue('trust-any');
        const result = checkProxyTrustAny();
        expect(result.status).toBe('pass');
        expect(result.detail).toContain('FORWARD_AUTH_ENABLED is off');
    });
});

describe('checkForwardAuthEnabledPosture', () => {
    const mockConfig = config as unknown as Record<string, unknown>;
    beforeEach(() => {
        resetIgnoredForwardAuthSighting();
    });
    afterEach(() => {
        mockConfig['FORWARD_AUTH_ENABLED'] = true;
        resetIgnoredForwardAuthSighting();
    });

    it('warns when forward auth is on but no proxy is trusted', () => {
        mockConfig['FORWARD_AUTH_ENABLED'] = true;
        vi.mocked(forwardAuthTrustPosture).mockReturnValue('fail-closed');
        const result = checkForwardAuthEnabledPosture();
        expect(result.id).toBe('forward-auth.enabled-posture');
        expect(result.status).toBe('warn');
        expect(result.detail).toContain('TRUSTED_PROXY_IPS is empty');
    });

    it('passes when forward auth is on with an allowlist', () => {
        mockConfig['FORWARD_AUTH_ENABLED'] = true;
        vi.mocked(forwardAuthTrustPosture).mockReturnValue('allowlist');
        expect(checkForwardAuthEnabledPosture().status).toBe('pass');
    });

    it('passes when forward auth is off and no identity header arrived', () => {
        mockConfig['FORWARD_AUTH_ENABLED'] = false;
        vi.mocked(forwardAuthTrustPosture).mockReturnValue('allowlist');
        expect(checkForwardAuthEnabledPosture().status).toBe('pass');
    });

    it('warns when identity headers arrived from a trusted proxy while forward auth is off, naming headers but no values', () => {
        mockConfig['FORWARD_AUTH_ENABLED'] = false;
        vi.mocked(forwardAuthTrustPosture).mockReturnValue('allowlist');
        noteIgnoredForwardAuthHeaders({
            peer: '10.0.0.5',
            path: '/',
            headerNames: ['X-Forwarded-User'],
        });
        const result = checkForwardAuthEnabledPosture();
        expect(result.status).toBe('warn');
        expect(result.detail).toContain('10.0.0.5');
        expect(result.detail).toContain('X-Forwarded-User');
    });

    it('stops warning once the last sighting is older than a day', () => {
        mockConfig['FORWARD_AUTH_ENABLED'] = false;
        vi.mocked(forwardAuthTrustPosture).mockReturnValue('allowlist');
        noteIgnoredForwardAuthHeaders({
            peer: '10.0.0.5',
            path: '/',
            headerNames: ['X-Forwarded-User'],
            now: Date.now() - 25 * 60 * 60 * 1000,
        });
        expect(checkForwardAuthEnabledPosture().status).toBe('pass');
    });
});

// ── checkProxyUnpinned ───────────────────────────────────────────────────────

describe('checkProxyUnpinned', () => {
    const mockForwardAuthTrustPosture = vi.mocked(forwardAuthTrustPosture);

    it('returns pass when posture is allowlist', () => {
        mockForwardAuthTrustPosture.mockReturnValue('allowlist');
        expect(checkProxyUnpinned().status).toBe('pass');
    });

    it('returns skipped when posture is trust-any', () => {
        mockForwardAuthTrustPosture.mockReturnValue('trust-any');
        expect(checkProxyUnpinned().status).toBe('skipped');
    });

    it('returns fail when fail-closed and not dev', () => {
        mockForwardAuthTrustPosture.mockReturnValue('fail-closed');
        // devFeaturesEnabled=false from mock
        const result = checkProxyUnpinned();
        expect(result.status).toBe('fail');
        expect(result.id).toBe('proxy.unpinned');
        // C15: an operator setting allowed_ips on a token must learn here that
        // it can only match the proxy while the proxy is unpinned.
        expect(result.detail).toContain('allowed_ips');
    });

    it('warns (client-address wording only) when fail-closed with forward auth off', () => {
        const mockConfig = config as unknown as Record<string, unknown>;
        mockConfig['FORWARD_AUTH_ENABLED'] = false;
        try {
            mockForwardAuthTrustPosture.mockReturnValue('fail-closed');
            const result = checkProxyUnpinned();
            expect(result.status).toBe('warn');
            expect(result.detail).toContain('allowed_ips');
            expect(result.detail).not.toContain('rejected from all peers');
        } finally {
            mockConfig['FORWARD_AUTH_ENABLED'] = true;
        }
    });
});

// ── checkStreamTokenIpPinningIneffective (security review P2) ───────────────

describe('checkStreamTokenIpPinningIneffective', () => {
    const mockForwardAuthTrustPosture = vi.mocked(forwardAuthTrustPosture);

    it('passes when STREAM_TOKEN_WILDCARD_IP is at its default (true), regardless of posture', () => {
        mockConfigValues.STREAM_TOKEN_WILDCARD_IP = true;
        mockForwardAuthTrustPosture.mockReturnValue('fail-closed');
        expect(checkStreamTokenIpPinningIneffective().status).toBe('pass');
    });

    it('passes when STREAM_TOKEN_WILDCARD_IP=false and the proxy IS pinned (allowlist)', () => {
        mockConfigValues.STREAM_TOKEN_WILDCARD_IP = false;
        mockForwardAuthTrustPosture.mockReturnValue('allowlist');
        expect(checkStreamTokenIpPinningIneffective().status).toBe('pass');
    });

    // P2: strict IP resolution collapses to the raw TCP peer when unpinned —
    // it does NOT restore per-client binding, so pinning stream tokens to an
    // IP without ALSO pinning TRUSTED_PROXY_IPS is a no-op wearing a lock.
    it('warns when STREAM_TOKEN_WILDCARD_IP=false and the proxy is NOT pinned (trust-any)', () => {
        mockConfigValues.STREAM_TOKEN_WILDCARD_IP = false;
        mockForwardAuthTrustPosture.mockReturnValue('trust-any');
        const result = checkStreamTokenIpPinningIneffective();
        expect(result.status).toBe('warn');
        expect(result.id).toBe('stream-token.ip-pinning-ineffective');
        expect(result.detail).toContain('raw TCP peer');
        expect(result.detail).not.toContain('restores per-client binding');
    });

    it('warns when STREAM_TOKEN_WILDCARD_IP=false and the proxy is fail-closed', () => {
        mockConfigValues.STREAM_TOKEN_WILDCARD_IP = false;
        mockForwardAuthTrustPosture.mockReturnValue('fail-closed');
        expect(checkStreamTokenIpPinningIneffective().status).toBe('warn');
    });
});

// ── checkUndecryptableConfigSecrets (security review 2026-09-12, C9) ────────

describe('checkUndecryptableConfigSecrets', () => {
    it('returns pass when every sealed setting opened', () => {
        mockUndecryptableKeys.mockReturnValue([]);
        const result = checkUndecryptableConfigSecrets();
        expect(result.id).toBe('config.undecryptable-secrets');
        expect(result.status).toBe('pass');
        expect(result.method).toBe('secrets');
    });

    it('returns fail naming the keys that are silently not in effect', () => {
        mockUndecryptableKeys.mockReturnValue(['TMDB_API_KEY', 'SMTP_PASSWORD']);
        const result = checkUndecryptableConfigSecrets();
        expect(result.status).toBe('fail');
        expect(result.detail).toContain('TMDB_API_KEY');
        expect(result.detail).toContain('SMTP_PASSWORD');
        expect(result.detail).toContain('2');
        expect(result.remediation).toContain('master-key-rotation');
    });

    it('is part of runConfigRules', () => {
        mockUndecryptableKeys.mockReturnValue(['TMDB_API_KEY']);
        const ids = runConfigRules().map((f) => f.id);
        expect(ids).toContain('config.undecryptable-secrets');
    });
});

// ── checkProxyMasterKeyEnv (P3) ──────────────────────────────────────────────

describe('checkProxyMasterKeyEnv', () => {
    const ORIGINAL_MASTER_KEY = process.env.LUMASTRA_MASTER_KEY;

    afterEach(() => {
        mockMasterKeySource.mockReturnValue('env');
        if (ORIGINAL_MASTER_KEY === undefined) {
            delete process.env.LUMASTRA_MASTER_KEY;
        } else {
            process.env.LUMASTRA_MASTER_KEY = ORIGINAL_MASTER_KEY;
        }
    });

    it('warns when a standalone proxy is configured and the master key was auto-generated', () => {
        mockMasterKeySource.mockReturnValue('generated');
        mockConfig['LIVETV_SOURCE'] = 'standalone';
        mockConfig['STREAM_PROXY_URL'] = 'http://lumastra-proxy:3000';

        const result = checkProxyMasterKeyEnv();
        expect(result.id).toBe('proxy.master-key-not-explicit');
        expect(result.status).toBe('warn');
        expect(result.method).toBe('secrets');
        expect(result.remediation).toContain('LUMASTRA_MASTER_KEY');
    });

    it('warns when a standalone proxy is configured and the master key came from the file (peer-generated)', () => {
        mockMasterKeySource.mockReturnValue('file');
        mockConfig['LIVETV_SOURCE'] = 'standalone';
        mockConfig['STREAM_PROXY_URL'] = 'http://lumastra-proxy:3000';

        const result = checkProxyMasterKeyEnv();
        expect(result.status).toBe('warn');
    });

    it('passes when LUMASTRA_MASTER_KEY is set explicitly, even with a standalone proxy', () => {
        mockMasterKeySource.mockReturnValue('env');
        mockConfig['LIVETV_SOURCE'] = 'standalone';
        mockConfig['STREAM_PROXY_URL'] = 'http://lumastra-proxy:3000';

        const result = checkProxyMasterKeyEnv();
        expect(result.status).toBe('pass');
    });

    it('passes when no standalone proxy is configured, even without an explicit master key', () => {
        mockMasterKeySource.mockReturnValue('generated');
        mockConfig['LIVETV_SOURCE'] = 'disabled';
        mockConfig['STREAM_PROXY_URL'] = '';

        const result = checkProxyMasterKeyEnv();
        expect(result.status).toBe('pass');
    });

    it('is part of runConfigRules', () => {
        mockMasterKeySource.mockReturnValue('generated');
        mockConfig['LIVETV_SOURCE'] = 'standalone';
        mockConfig['STREAM_PROXY_URL'] = 'http://lumastra-proxy:3000';
        const ids = runConfigRules().map((f) => f.id);
        expect(ids).toContain('proxy.master-key-not-explicit');
    });

    // fix-round-1 minor: source 'none' means resolveMasterKey() has not run
    // in this process yet, which also means its process.env back-fill hasn't
    // happened — so reading process.env directly is still safe in that one
    // case, and skipping it would falsely warn on an operator who DID set
    // LUMASTRA_MASTER_KEY.
    it('passes when source is "none" but LUMASTRA_MASTER_KEY IS set (rule ran before first resolution)', () => {
        mockMasterKeySource.mockReturnValue('none');
        process.env.LUMASTRA_MASTER_KEY = 'a'.repeat(64);
        mockConfig['LIVETV_SOURCE'] = 'standalone';
        mockConfig['STREAM_PROXY_URL'] = 'http://lumastra-proxy:3000';

        const result = checkProxyMasterKeyEnv();
        expect(result.status).toBe('pass');
    });

    it('warns when source is "none" and LUMASTRA_MASTER_KEY is NOT set', () => {
        mockMasterKeySource.mockReturnValue('none');
        delete process.env.LUMASTRA_MASTER_KEY;
        mockConfig['LIVETV_SOURCE'] = 'standalone';
        mockConfig['STREAM_PROXY_URL'] = 'http://lumastra-proxy:3000';

        const result = checkProxyMasterKeyEnv();
        expect(result.status).toBe('warn');
    });
});

// ── checkNativeSessionTtl ────────────────────────────────────────────────────

describe('checkNativeSessionTtl', () => {
    it('returns pass for 30 days', () => {
        mockConfig['NATIVE_AUTH_SESSION_TTL_DAYS'] = 30;
        expect(checkNativeSessionTtl().status).toBe('pass');
    });

    it('returns pass for exactly 90 days', () => {
        mockConfig['NATIVE_AUTH_SESSION_TTL_DAYS'] = 90;
        expect(checkNativeSessionTtl().status).toBe('pass');
    });

    it('returns warn for 91 days', () => {
        mockConfig['NATIVE_AUTH_SESSION_TTL_DAYS'] = 91;
        expect(checkNativeSessionTtl().status).toBe('warn');
    });

    it('returns warn for 365 days', () => {
        mockConfig['NATIVE_AUTH_SESSION_TTL_DAYS'] = 365;
        const result = checkNativeSessionTtl();
        expect(result.status).toBe('warn');
        expect(result.detail).toContain('365');
    });
});

// ── checkNativeEnabled ───────────────────────────────────────────────────────

describe('checkNativeEnabled', () => {
    it('returns pass with title "enabled" when native login is on', () => {
        mockConfig['AUTH_NATIVE_LOGIN_ENABLED'] = true;
        const result = checkNativeEnabled();
        expect(result.status).toBe('pass');
        expect(result.title).toContain('enabled');
    });

    it('returns pass with title "disabled" when native login is off', () => {
        mockConfig['AUTH_NATIVE_LOGIN_ENABLED'] = false;
        const result = checkNativeEnabled();
        expect(result.status).toBe('pass');
        expect(result.title).toContain('disabled');
    });
});

// ── checkOidcLinkByUsername ──────────────────────────────────────────────────

describe('checkOidcLinkByUsername', () => {
    it('returns skipped when OIDC disabled', () => {
        mockConfig['AUTH_OIDC_ENABLED'] = false;
        expect(checkOidcLinkByUsername().status).toBe('skipped');
    });

    it('returns warn when OIDC enabled and link-by-username=true', () => {
        mockConfig['AUTH_OIDC_ENABLED'] = true;
        mockConfig['AUTH_OIDC_LINK_BY_USERNAME'] = true;
        const result = checkOidcLinkByUsername();
        expect(result.status).toBe('warn');
        expect(result.id).toBe('oidc.link-by-username');
    });

    it('returns pass when OIDC enabled and link-by-username=false', () => {
        mockConfig['AUTH_OIDC_ENABLED'] = true;
        mockConfig['AUTH_OIDC_LINK_BY_USERNAME'] = false;
        expect(checkOidcLinkByUsername().status).toBe('pass');
    });
});

// ── checkOidcMissingClient ───────────────────────────────────────────────────

describe('checkOidcMissingClient', () => {
    it('returns skipped when OIDC disabled', () => {
        mockConfig['AUTH_OIDC_ENABLED'] = false;
        expect(checkOidcMissingClient().status).toBe('skipped');
    });

    it('returns fail when client ID missing', () => {
        mockConfig['AUTH_OIDC_ENABLED'] = true;
        mockConfig['AUTH_OIDC_CLIENT_ID'] = '';
        mockConfig['AUTH_OIDC_CLIENT_SECRET'] = 'some-secret';
        const result = checkOidcMissingClient();
        expect(result.status).toBe('fail');
        expect(result.detail).toContain('AUTH_OIDC_CLIENT_ID');
    });

    it('returns fail when client secret missing', () => {
        mockConfig['AUTH_OIDC_ENABLED'] = true;
        mockConfig['AUTH_OIDC_CLIENT_ID'] = 'client-id';
        mockConfig['AUTH_OIDC_CLIENT_SECRET'] = '';
        const result = checkOidcMissingClient();
        expect(result.status).toBe('fail');
        expect(result.detail).toContain('AUTH_OIDC_CLIENT_SECRET');
    });

    it('returns fail when both missing', () => {
        mockConfig['AUTH_OIDC_ENABLED'] = true;
        mockConfig['AUTH_OIDC_CLIENT_ID'] = '';
        mockConfig['AUTH_OIDC_CLIENT_SECRET'] = '';
        const result = checkOidcMissingClient();
        expect(result.status).toBe('fail');
        expect(result.detail).toContain('AUTH_OIDC_CLIENT_ID');
        expect(result.detail).toContain('AUTH_OIDC_CLIENT_SECRET');
    });

    it('returns pass when both are set', () => {
        mockConfig['AUTH_OIDC_ENABLED'] = true;
        mockConfig['AUTH_OIDC_CLIENT_ID'] = 'client-id';
        mockConfig['AUTH_OIDC_CLIENT_SECRET'] = 'client-secret';
        expect(checkOidcMissingClient().status).toBe('pass');
    });
});

// ── checkCompatJellyfinEnabled ───────────────────────────────────────────────

describe('checkCompatJellyfinEnabled', () => {
    it('returns pass with "active" title when jellyfinCompat=true', () => {
        mockFeatures['jellyfinCompat'] = true;
        const result = checkCompatJellyfinEnabled();
        expect(result.status).toBe('pass');
        expect(result.title).toContain('active');
    });

    it('returns pass with "inactive" title when jellyfinCompat=false', () => {
        mockFeatures['jellyfinCompat'] = false;
        const result = checkCompatJellyfinEnabled();
        expect(result.status).toBe('pass');
        expect(result.title).toContain('inactive');
    });
});

// ── checkCompatSubsonicEnabled ───────────────────────────────────────────────

describe('checkCompatSubsonicEnabled', () => {
    it('returns warn when FEATURE_SUBSONIC_COMPAT=true', () => {
        mockConfig['FEATURE_SUBSONIC_COMPAT'] = true;
        const result = checkCompatSubsonicEnabled();
        expect(result.status).toBe('warn');
        expect(result.id).toBe('compat.subsonic-enabled');
    });

    it('returns pass when FEATURE_SUBSONIC_COMPAT=false', () => {
        mockConfig['FEATURE_SUBSONIC_COMPAT'] = false;
        expect(checkCompatSubsonicEnabled().status).toBe('pass');
    });
});

// ── checkCompatSubsonicCredsInQuery ─────────────────────────────────────────

describe('checkCompatSubsonicCredsInQuery', () => {
    it('returns skipped when FEATURE_SUBSONIC_COMPAT=false', () => {
        mockConfig['FEATURE_SUBSONIC_COMPAT'] = false;
        expect(checkCompatSubsonicCredsInQuery().status).toBe('skipped');
    });

    it('returns warn when FEATURE_SUBSONIC_COMPAT=true', () => {
        mockConfig['FEATURE_SUBSONIC_COMPAT'] = true;
        expect(checkCompatSubsonicCredsInQuery().status).toBe('warn');
        expect(checkCompatSubsonicCredsInQuery().id).toBe('compat.subsonic-creds-in-query');
    });
});

// ── checkDeviceVerificationBaseUrl ───────────────────────────────────────────

describe('checkDeviceVerificationBaseUrl', () => {
    it('returns warn when DEVICE_VERIFICATION_BASE_URL is empty', () => {
        mockConfig['DEVICE_VERIFICATION_BASE_URL'] = '';
        const result = checkDeviceVerificationBaseUrl();
        expect(result.status).toBe('warn');
        expect(result.id).toBe('device.verification-base-url');
    });

    it('returns pass when DEVICE_VERIFICATION_BASE_URL is set', () => {
        mockConfig['DEVICE_VERIFICATION_BASE_URL'] = 'https://example.com';
        expect(checkDeviceVerificationBaseUrl().status).toBe('pass');
    });
});

describe('checkSetupUnlockLeftSet', () => {
    afterEach(() => {
        mockConfig['SETUP_UNLOCK'] = false;
    });

    it('warns while SETUP_UNLOCK is set', () => {
        mockConfig['SETUP_UNLOCK'] = true;
        const result = checkSetupUnlockLeftSet();
        expect(result.status).toBe('warn');
        expect(result.id).toBe('setup.unlock-left-set');
    });

    it('passes when SETUP_UNLOCK is not set', () => {
        mockConfig['SETUP_UNLOCK'] = false;
        expect(checkSetupUnlockLeftSet().status).toBe('pass');
    });
});

// ── checkProxyWideRange ──────────────────────────────────────────────────────

describe('checkProxyWideRange', () => {
    const saved = {
        ips: process.env.TRUSTED_PROXY_IPS,
        k8s: process.env.KUBERNETES_SERVICE_HOST,
    };
    beforeEach(() => {
        delete process.env.KUBERNETES_SERVICE_HOST;
        mockConfig['FORWARD_AUTH_ENABLED'] = true;
    });
    afterEach(() => {
        if (saved.ips === undefined) delete process.env.TRUSTED_PROXY_IPS;
        else process.env.TRUSTED_PROXY_IPS = saved.ips;
        if (saved.k8s === undefined) delete process.env.KUBERNETES_SERVICE_HOST;
        else process.env.KUBERNETES_SERVICE_HOST = saved.k8s;
    });

    it.each(['', '172.28.0.10', '172.28.0.0/24', '10.0.0.5,10.0.0.6'])(
        'TRUSTED_PROXY_IPS=%j: pass',
        (ips) => {
            process.env.TRUSTED_PROXY_IPS = ips;
            expect(checkProxyWideRange().status).toBe('pass');
        },
    );

    it('a LAN range with forward auth on: warn naming the range and the sign-in risk', () => {
        process.env.TRUSTED_PROXY_IPS = '172.28.0.10,192.168.0.0/16';
        const f = checkProxyWideRange();
        expect(f.id).toBe('proxy.wide-range');
        expect(f.status).toBe('warn');
        expect(f.title).toContain('forward auth is on');
        expect(f.detail).toContain('192.168.0.0/16');
        expect(f.detail).toContain('sign in as any user');
        expect(f.remediation).toContain('fixed IP');
    });

    it('a /23 with forward auth off: still warn (client IPs), says what turning it on would do', () => {
        mockConfig['FORWARD_AUTH_ENABLED'] = false;
        process.env.TRUSTED_PROXY_IPS = '10.0.0.0/23';
        const f = checkProxyWideRange();
        expect(f.status).toBe('warn');
        expect(f.detail).toContain('If FORWARD_AUTH_ENABLED is turned on');
    });

    it('the pod CIDR on Kubernetes: info', () => {
        process.env.TRUSTED_PROXY_IPS = '10.42.0.0/16';
        process.env.KUBERNETES_SERVICE_HOST = '10.43.0.1';
        expect(checkProxyWideRange().status).toBe('info');
    });

    it('an IPv6 range: warn (matches nothing)', () => {
        process.env.TRUSTED_PROXY_IPS = 'fd00::/8';
        const f = checkProxyWideRange();
        expect(f.status).toBe('warn');
        expect(f.detail).toContain('IPv6 ranges are not supported');
    });

    it('is part of runConfigRules', () => {
        expect(runConfigRules().map((f) => f.id)).toContain('proxy.wide-range');
    });
});

// ── runConfigRules — aggregate ───────────────────────────────────────────────

describe('runConfigRules', () => {
    beforeEach(() => {
        // Reset to a "clean" config for aggregate tests
        mockConfig['AUTH_OIDC_ALLOW_INSECURE'] = false;
        mockConfig['AUTH_OIDC_ENABLED'] = false;
        mockConfig['AUTH_OIDC_SCOPES'] = 'openid profile email';
        mockConfig['AUTH_OIDC_CLIENT_ID'] = 'client-id';
        mockConfig['AUTH_OIDC_CLIENT_SECRET'] = 'client-secret';
        mockConfig['AUTH_OIDC_LINK_BY_USERNAME'] = false;
        mockConfig['JWT_SECRET'] = 'a'.repeat(64);
        mockConfig['NATIVE_AUTH_SESSION_TTL_DAYS'] = 30;
        mockConfig['AUTH_NATIVE_LOGIN_ENABLED'] = false;
        mockConfig['FEATURE_SUBSONIC_COMPAT'] = false;
        mockConfig['DEVICE_VERIFICATION_BASE_URL'] = 'https://example.com';
        mockConfig['LIVETV_SOURCE'] = 'disabled';
        mockConfig['STREAM_PROXY_URL'] = '';
        mockConfig['SETUP_UNLOCK'] = false;
        mockConfig['FORWARD_AUTH_ENABLED'] = true;
        mockFeatures['jellyfinCompat'] = false;
        mockConfigValues['STREAM_TOKEN_WILDCARD_IP'] = true;
        vi.mocked(forwardAuthTrustPosture).mockReturnValue('allowlist');
    });

    it('returns an array with at least one finding per rule', () => {
        const results = runConfigRules();
        // We have 21 rules registered
        expect(results.length).toBe(21);
    });

    it('all findings have required fields', () => {
        const results = runConfigRules();
        for (const f of results) {
            expect(f.id).toBeTruthy();
            expect(f.method).toBeTruthy();
            expect(f.type).toBeTruthy();
            expect(f.status).toBeTruthy();
            expect(f.title).toBeTruthy();
            expect(typeof f.detail).toBe('string');
        }
    });

    it('catches a rule that throws and emits an error finding', () => {
        // Temporarily break JWT_SECRET getter to cause a throw
        const originalGet = Object.getOwnPropertyDescriptor(mockConfig, 'JWT_SECRET');
        Object.defineProperty(mockConfig, 'JWT_SECRET', {
            get() {
                throw new Error('simulated getter failure');
            },
            configurable: true,
        });

        const results = runConfigRules();
        const errorFindings = results.filter((f) => f.status === 'error');
        expect(errorFindings.length).toBeGreaterThanOrEqual(1);

        // Restore
        if (originalGet) {
            Object.defineProperty(mockConfig, 'JWT_SECRET', originalGet);
        } else {
            mockConfig['JWT_SECRET'] = 'a'.repeat(64);
        }
    });

    it('a rule failure does not abort other rules', () => {
        // Cause one getter to throw; the rest should still produce findings.
        Object.defineProperty(mockConfig, 'AUTH_OIDC_ALLOW_INSECURE', {
            get() {
                throw new Error('boom');
            },
            configurable: true,
        });

        const results = runConfigRules();
        // We still get all 21 findings (one is error, rest are normal)
        expect(results.length).toBe(21);

        // Restore
        Object.defineProperty(mockConfig, 'AUTH_OIDC_ALLOW_INSECURE', {
            value: false,
            writable: true,
            configurable: true,
        });
    });

    it('no finding detail or title contains a raw secret value', () => {
        const secretValue = 'a'.repeat(64);
        mockConfig['JWT_SECRET'] = secretValue;
        const results = runConfigRules();
        for (const f of results) {
            expect(f.detail).not.toContain(secretValue);
            expect(f.title).not.toContain(secretValue);
            if (f.evidence) expect(f.evidence).not.toContain(secretValue);
        }
    });
});
