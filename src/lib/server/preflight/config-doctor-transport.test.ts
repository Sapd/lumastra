// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Isolates the `checkTransport` check (S6 fix): with ORIGIN/PROTOCOL_HEADER
// unset it is an INFO-level note, never the amber admin banner. Since the
// session cookie keeps Secure unless the request shows plain HTTP
// (auth/cookie-transport.ts), that holds whether or not TRUSTED_PROXY_IPS is
// configured (posture `'allowlist'`).
//
// `config` and `forwardAuthTrustPosture` are mocked directly rather than only
// varying `process.env`, because:
//   - config.ts snapshots `process.env` into a module-private `env` object at
//     IMPORT time, so `AUTH_NATIVE_LOGIN_ENABLED` can't be toggled per-test via
//     `process.env` after the module has already loaded;
//   - client-ip.ts's TRUSTED_PROXY_IPS / LUMASTRA_TRUST_ANY_PROXY are captured
//     as module-level constants at import for the same reason (see the note in
//     config-doctor.test.ts — posture branches belong to client-ip's own
//     coverage there; here we drive `forwardAuthTrustPosture()` directly since
//     it IS the signal under test).

vi.mock('../crypto/master-key.js', () => ({
    resolveMasterKey: vi.fn(() => 'a'.repeat(64)),
    getMasterKeyFilePath: vi.fn(() => '/config/master.key'),
}));

// Plain mutable object (not a class with getters) so tests can flip fields
// directly; vi.mock only allows referencing hoisted-safe locals prefixed
// `mock`.
const mockConfig = {
    JWT_SECRET: 'x'.repeat(32),
    AUTH_NATIVE_LOGIN_ENABLED: true,
    AUTH_OIDC_LOGIN_AVAILABLE: false,
};

vi.mock('../config.js', () => ({ config: mockConfig }));

const mockForwardAuthTrustPosture = vi.fn<() => 'allowlist' | 'trust-any' | 'fail-closed'>(
    () => 'fail-closed',
);

vi.mock('../utils/client-ip.js', () => ({
    forwardAuthTrustPosture: () => mockForwardAuthTrustPosture(),
}));

const { runConfigDoctor } = await import('./config-doctor.js');
const { toConfigHealthView } = await import('./config-health-view.js');

const prodEnv = { NODE_ENV: 'production' };

function transportIssues(env: Record<string, string | undefined> = prodEnv) {
    return runConfigDoctor({ env }).issues.filter((i) => i.category === 'transport');
}

describe('config-doctor transport check (S6: false positive on plain installs)', () => {
    beforeEach(() => {
        mockConfig.AUTH_NATIVE_LOGIN_ENABLED = true;
        mockConfig.AUTH_OIDC_LOGIN_AVAILABLE = false;
        mockForwardAuthTrustPosture.mockReturnValue('fail-closed');
    });

    it('plain install (no TRUSTED_PROXY_IPS, no ORIGIN/PROTOCOL_HEADER, native login on): info only, no warning', () => {
        const issues = transportIssues();
        expect(issues).toHaveLength(1);
        expect(issues[0].severity).toBe('info');
        expect(issues[0].code).toBe('transport.session-cookie-secure-info');

        // An info issue must never count as a warning — check the delta this
        // check itself contributes, not the total (embedding/secrets checks
        // may independently add their own unrelated warnings in this env).
        const withoutTransport = runConfigDoctor({
            env: { ...prodEnv, ORIGIN: 'https://media.example.com' },
        }).warningCount;
        const withTransportInfo = runConfigDoctor({ env: prodEnv }).warningCount;
        expect(withTransportInfo).toBe(withoutTransport);
    });

    it('TRUSTED_PROXY_IPS configured + ORIGIN/PROTOCOL_HEADER unset: info only too', () => {
        // The cookie keeps Secure unless the request shows plain HTTP, so a TLS
        // proxy missing from the allowlist loses nothing (cookie-transport.ts).
        mockForwardAuthTrustPosture.mockReturnValue('allowlist');
        const issues = transportIssues();
        expect(issues).toHaveLength(1);
        expect(issues[0].severity).toBe('info');
        expect(issues[0].code).toBe('transport.session-cookie-secure-info');
        expect(issues[0].message).toContain('X-Forwarded-Proto');
    });

    it('ORIGIN set: no warning and no info, regardless of proxy trust', () => {
        mockForwardAuthTrustPosture.mockReturnValue('allowlist');
        expect(transportIssues({ ...prodEnv, ORIGIN: 'https://media.example.com' })).toHaveLength(
            0,
        );

        mockForwardAuthTrustPosture.mockReturnValue('fail-closed');
        expect(transportIssues({ ...prodEnv, ORIGIN: 'https://media.example.com' })).toHaveLength(
            0,
        );
    });

    it('PROTOCOL_HEADER set: no warning and no info, regardless of proxy trust', () => {
        mockForwardAuthTrustPosture.mockReturnValue('allowlist');
        expect(transportIssues({ ...prodEnv, PROTOCOL_HEADER: 'x-forwarded-proto' })).toHaveLength(
            0,
        );

        mockForwardAuthTrustPosture.mockReturnValue('fail-closed');
        expect(transportIssues({ ...prodEnv, PROTOCOL_HEADER: 'x-forwarded-proto' })).toHaveLength(
            0,
        );
    });

    it('does not run outside production', () => {
        mockForwardAuthTrustPosture.mockReturnValue('allowlist');
        expect(transportIssues({ NODE_ENV: 'development' })).toHaveLength(0);
    });

    it('does not run when native login is disabled', () => {
        mockConfig.AUTH_NATIVE_LOGIN_ENABLED = false;
        mockForwardAuthTrustPosture.mockReturnValue('allowlist');
        expect(transportIssues()).toHaveLength(0);
    });

    it('admin banner view drops the info note, with or without a proxy allowlist', () => {
        mockForwardAuthTrustPosture.mockReturnValue('fail-closed');
        const plainView = toConfigHealthView(runConfigDoctor({ env: prodEnv }));
        expect(
            plainView.issues.some((i) => i.code === 'transport.session-cookie-secure-info'),
        ).toBe(false);
        expect(plainView.issues.some((i) => i.code === 'transport.session-cookie-secure')).toBe(
            false,
        );

        mockForwardAuthTrustPosture.mockReturnValue('allowlist');
        const proxyView = toConfigHealthView(runConfigDoctor({ env: prodEnv }));
        expect(proxyView.issues.some((i) => i.code.startsWith('transport.'))).toBe(false);
    });
});
