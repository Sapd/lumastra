// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveMasterKey } from '../crypto/master-key.js';
import { formatDoctorReport, runConfigDoctor } from './config-doctor.js';
import { toConfigHealthView } from './config-health-view.js';

// Unit tests for the env-only (synchronous) config-doctor checks added beyond
// the embedding validation: secrets presence and forward-auth gating.
//
// Since commit a07206f04 the two secrets checks no longer read the injected
// `env`: the master-key check reads the EFFECTIVE key via resolveMasterKey()
// (auto-generated into the config dir on first use), and the token-signing check
// reads config.JWT_SECRET, which DERIVES from that same master key when JWT_SECRET
// is unset. So we mock resolveMasterKey() to drive both — returning '' simulates a
// config dir where no key can be resolved or written. NODE_ENV is still read from
// the injected `env` (it gates the master-key severity and the forward-auth check).
//
// Note: forward-auth posture is read from client-ip.ts module-level constants
// (TRUSTED_PROXY_IPS / LUMASTRA_TRUST_ANY_PROXY captured at import). These tests
// therefore only assert the NODE_ENV gating of the forward-auth check (skipped
// outside production), not the posture branches themselves — those belong to
// client-ip's own coverage.

vi.mock('../crypto/master-key.js', () => ({
    resolveMasterKey: vi.fn(() => ''),
    getMasterKeyFilePath: vi.fn(() => '/config/master.key'),
}));

const mockedResolveMasterKey = vi.mocked(resolveMasterKey);

// A baseline env where the secrets/embedding checks are satisfied so we can
// isolate the check under test.
function baseEnv(
    overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
    return {
        JWT_SECRET: 'x'.repeat(32),
        LUMASTRA_MASTER_KEY: 'y'.repeat(32),
        ...overrides,
    };
}

function codes(env: Record<string, string | undefined>): string[] {
    return runConfigDoctor({ env }).issues.map((i) => i.code);
}

describe('config-doctor secrets checks', () => {
    beforeEach(() => {
        // Default: no master key can be resolved or written, so the derived JWT
        // secret AND the master-key check both see "missing". Individual tests
        // override as needed. NOTE: the only test needing an EMPTY effective
        // JWT secret (config.JWT_SECRET memoizes a non-empty derived value once
        // observed) must run before any test that resolves a key — see ordering.
        mockedResolveMasterKey.mockReturnValue('');
    });

    it('errors when no token-signing secret can be derived', () => {
        // config.JWT_SECRET derives from the (absent) master key, so it is empty.
        const report = runConfigDoctor({ env: baseEnv() });
        const jwt = report.issues.find((i) => i.code === 'secrets.jwt-secret-missing');
        expect(jwt).toBeDefined();
        expect(jwt?.severity).toBe('error');
        expect(report.ok).toBe(false);
    });

    it('treats a blank (whitespace-only) master key as missing', () => {
        mockedResolveMasterKey.mockReturnValue('   ');
        expect(codes(baseEnv())).toContain('secrets.master-key-missing');
    });

    it('does not flag the token-signing secret when a master key is present', () => {
        // A valid 64-char hex key so the derived JWT secret is non-empty.
        mockedResolveMasterKey.mockReturnValue('a'.repeat(64));
        expect(codes(baseEnv())).not.toContain('secrets.jwt-secret-missing');
    });

    it('warns (not errors) on missing master key outside production', () => {
        const report = runConfigDoctor({
            env: baseEnv({ NODE_ENV: 'development' }),
        });
        const mk = report.issues.find((i) => i.code === 'secrets.master-key-missing');
        expect(mk?.severity).toBe('warning');
    });

    it('errors on missing master key in production', () => {
        const report = runConfigDoctor({
            env: baseEnv({ NODE_ENV: 'production' }),
        });
        const mk = report.issues.find((i) => i.code === 'secrets.master-key-missing');
        expect(mk?.severity).toBe('error');
    });
});

describe('config-doctor forward-auth gating', () => {
    it('does not run the forward-auth check outside production', () => {
        const report = runConfigDoctor({
            env: baseEnv({ NODE_ENV: 'development' }),
        });
        const forwardAuth = report.issues.filter((i) => i.code.startsWith('forward-auth.'));
        expect(forwardAuth).toHaveLength(0);
    });
});

describe('config-doctor gateway-trust check', () => {
    const route =
        'Iface\tDestination\tGateway\tFlags\n' +
        'eth0\t00000000\t010015AC\t0003\n' +
        'eth0\t000015AC\t00000000\t0001\n';

    it('warns (never errors) when TRUSTED_PROXY_IPS trusts the Docker gateway', () => {
        const report = runConfigDoctor({
            env: baseEnv({ TRUSTED_PROXY_IPS: '172.21.0.1' }),
            procNetRoute: route,
        });
        const issue = report.issues.find((i) => i.code === 'forward-auth.trusts-docker-gateway');
        expect(issue).toMatchObject({ severity: 'warning', category: 'forward-auth' });
        expect(issue?.message).toContain('172.21.0.1');
        expect(issue?.remediation).toMatch(/same Docker network/);
        // …and it reaches the admin config banner as a warning.
        expect(toConfigHealthView(report).issues.map((i) => i.code)).toContain(
            'forward-auth.trusts-docker-gateway',
        );
    });

    it('is silent for a pinned proxy-container address, or without a route table', () => {
        const pinned = runConfigDoctor({
            env: baseEnv({ TRUSTED_PROXY_IPS: '172.21.0.10' }),
            procNetRoute: route,
        });
        const offLinux = runConfigDoctor({
            env: baseEnv({ TRUSTED_PROXY_IPS: '172.21.0.1' }),
            procNetRoute: null,
        });
        for (const report of [pinned, offLinux]) {
            expect(report.issues.map((i) => i.code)).not.toContain(
                'forward-auth.trusts-docker-gateway',
            );
        }
    });
});

describe('formatDoctorReport embedding header', () => {
    function providerLine(env: Record<string, string | undefined>): string | undefined {
        return formatDoctorReport(runConfigDoctor({ env, procNetRoute: null }))
            .split('\n')
            .find((line) => line.trim().startsWith('provider:'));
    }

    it('shows provider none when no embedding key is set', () => {
        expect(providerLine(baseEnv())).toBe('  provider:   none');
    });

    it('shows the configured provider when a key is set', () => {
        expect(providerLine(baseEnv({ VOYAGE_API_KEY: 'pa-test' }))).toBe('  provider:   voyage');
        expect(providerLine(baseEnv({ OPENAI_API_KEY: 'sk-test' }))).toBe('  provider:   openai');
    });
});
