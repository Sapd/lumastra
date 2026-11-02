// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';

// The forward-auth posture check against the FORWARD_AUTH_ENABLED opt-in.
// `config` and `forwardAuthTrustPosture` are mocked directly for the reasons in
// config-doctor-transport.test.ts (both snapshot process.env at import).

vi.mock('../crypto/master-key.js', () => ({
    resolveMasterKey: vi.fn(() => 'a'.repeat(64)),
    getMasterKeyFilePath: vi.fn(() => '/config/master.key'),
}));

const mockConfig = {
    JWT_SECRET: 'x'.repeat(32),
    AUTH_NATIVE_LOGIN_ENABLED: true,
    AUTH_OIDC_LOGIN_AVAILABLE: false,
    FORWARD_AUTH_ENABLED: false as boolean | undefined,
};

vi.mock('../config.js', () => ({ config: mockConfig }));

const mockForwardAuthTrustPosture = vi.fn<() => 'allowlist' | 'trust-any' | 'fail-closed'>(
    () => 'fail-closed',
);

vi.mock('../utils/client-ip.js', () => ({
    forwardAuthTrustPosture: () => mockForwardAuthTrustPosture(),
}));

const { runConfigDoctor } = await import('./config-doctor.js');
const { noteIgnoredForwardAuthHeaders, resetIgnoredForwardAuthSighting } =
    await import('../utils/forward-auth-disabled-observer.js');

function forwardAuthIssues(env: Record<string, string | undefined> = { NODE_ENV: 'production' }) {
    return runConfigDoctor({ env }).issues.filter((i) => i.code.startsWith('forward-auth.'));
}

describe('config-doctor forward-auth check with FORWARD_AUTH_ENABLED', () => {
    beforeEach(() => {
        mockConfig.AUTH_NATIVE_LOGIN_ENABLED = true;
        mockConfig.AUTH_OIDC_LOGIN_AVAILABLE = false;
        mockConfig.FORWARD_AUTH_ENABLED = false;
        mockForwardAuthTrustPosture.mockReturnValue('fail-closed');
        resetIgnoredForwardAuthSighting();
    });

    it('built-in login only, nothing about forward auth set: no issue', () => {
        expect(forwardAuthIssues()).toEqual([]);
    });

    it('forward auth on but TRUSTED_PROXY_IPS empty: warning', () => {
        mockConfig.FORWARD_AUTH_ENABLED = true;
        const issues = forwardAuthIssues();
        expect(issues.map((i) => [i.code, i.severity])).toEqual([
            ['forward-auth.enabled-without-trusted-proxy', 'warning'],
        ]);
    });

    it('forward auth on with an allowlist: no issue', () => {
        mockConfig.FORWARD_AUTH_ENABLED = true;
        mockForwardAuthTrustPosture.mockReturnValue('allowlist');
        expect(forwardAuthIssues()).toEqual([]);
    });

    it('forward auth on with trust-any: the trust-any warning', () => {
        mockConfig.FORWARD_AUTH_ENABLED = true;
        mockForwardAuthTrustPosture.mockReturnValue('trust-any');
        expect(forwardAuthIssues().map((i) => i.code)).toEqual(['forward-auth.trust-any']);
    });

    it('TRUSTED_PROXY_IPS set, forward auth off, no headers seen: info naming the switch', () => {
        mockForwardAuthTrustPosture.mockReturnValue('allowlist');
        const issues = forwardAuthIssues();
        expect(issues.map((i) => [i.code, i.severity])).toEqual([
            ['forward-auth.disabled-with-trusted-proxy', 'info'],
        ]);
        expect(issues[0].remediation).toContain('FORWARD_AUTH_ENABLED=true');
    });

    it('identity headers arrived from a trusted proxy while off: warning', () => {
        mockForwardAuthTrustPosture.mockReturnValue('allowlist');
        noteIgnoredForwardAuthHeaders({
            peer: '172.20.0.5',
            path: '/',
            headerNames: ['X-Forwarded-User'],
        });
        const issues = forwardAuthIssues();
        expect(issues.map((i) => [i.code, i.severity])).toEqual([
            ['forward-auth.headers-while-disabled', 'warning'],
        ]);
        expect(issues[0].message).toContain('172.20.0.5');
        expect(issues[0].message).toContain('X-Forwarded-User');
    });

    it('a sighting older than a day falls back to the info note', () => {
        mockForwardAuthTrustPosture.mockReturnValue('allowlist');
        noteIgnoredForwardAuthHeaders({
            peer: '172.20.0.5',
            path: '/',
            headerNames: ['X-Forwarded-User'],
            now: Date.now() - 25 * 60 * 60 * 1000,
        });
        expect(forwardAuthIssues().map((i) => i.code)).toEqual([
            'forward-auth.disabled-with-trusted-proxy',
        ]);
    });

    it('trust-any with forward auth off: info only (it has no effect)', () => {
        mockForwardAuthTrustPosture.mockReturnValue('trust-any');
        expect(forwardAuthIssues().map((i) => [i.code, i.severity])).toEqual([
            ['forward-auth.disabled-with-trusted-proxy', 'info'],
        ]);
    });

    it('forward auth off and no other sign-in method: error, even with an allowlist', () => {
        mockConfig.AUTH_NATIVE_LOGIN_ENABLED = false;
        mockForwardAuthTrustPosture.mockReturnValue('allowlist');
        const issues = forwardAuthIssues();
        expect(issues.map((i) => [i.code, i.severity])).toEqual([
            ['forward-auth.fail-closed', 'error'],
        ]);
        expect(issues[0].message).toContain('FORWARD_AUTH_ENABLED');
    });

    it('forward auth on, allowlist, no other sign-in method: no issue', () => {
        mockConfig.AUTH_NATIVE_LOGIN_ENABLED = false;
        mockConfig.FORWARD_AUTH_ENABLED = true;
        mockForwardAuthTrustPosture.mockReturnValue('allowlist');
        expect(forwardAuthIssues()).toEqual([]);
    });

    it('skipped outside production', () => {
        mockConfig.FORWARD_AUTH_ENABLED = true;
        expect(forwardAuthIssues({ NODE_ENV: 'development' })).toEqual([]);
    });
});

describe('config-doctor TRUSTED_PROXY_IPS range check', () => {
    beforeEach(() => {
        mockConfig.FORWARD_AUTH_ENABLED = true;
        mockForwardAuthTrustPosture.mockReturnValue('allowlist');
    });

    function rangeIssues(env: Record<string, string | undefined>) {
        return runConfigDoctor({ env, procNetRoute: null }).issues.filter(
            (i) => i.code === 'forward-auth.trusts-wide-range',
        );
    }

    it('proxy addresses and the docs compose /24: no issue', () => {
        expect(rangeIssues({ TRUSTED_PROXY_IPS: '172.28.0.10' })).toEqual([]);
        expect(rangeIssues({ TRUSTED_PROXY_IPS: '172.28.0.0/24' })).toEqual([]);
    });

    it('a LAN range: warning in the forward-auth category', () => {
        const issues = rangeIssues({ TRUSTED_PROXY_IPS: '192.168.0.0/16' });
        expect(issues.map((i) => i.severity)).toEqual(['warning']);
        expect(issues[0].message).toContain('192.168.0.0/16');
        expect(issues[0].message).toContain('FORWARD_AUTH_ENABLED is on');
    });

    it('the pod CIDR on Kubernetes: info', () => {
        const issues = rangeIssues({
            TRUSTED_PROXY_IPS: '10.42.0.0/16',
            KUBERNETES_SERVICE_HOST: '10.43.0.1',
        });
        expect(issues.map((i) => i.severity)).toEqual(['info']);
    });
});
