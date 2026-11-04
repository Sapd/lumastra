// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi } from 'vitest';

// settings.json lives on disk, so the check asks the config service rather than
// the database for that store's count. Stub it: the real module reads a file
// and this suite has no install behind it.
const { configLegacyKeys, configUnopenableKeys } = vi.hoisted(() => ({
    configLegacyKeys: [] as string[],
    configUnopenableKeys: [] as string[],
}));
vi.mock('$lib/server/config/config.service.js', () => ({
    getLegacyConfigEnvelopeKeys: () => [...configLegacyKeys],
    getUndecryptableConfigKeys: () => [...configUnopenableKeys],
}));
// checkUnopenableSecrets derives the master key unconditionally (it needs it
// even when every store is empty), and the real resolver falls back to
// reading/generating a file on disk. Pin it so this suite never touches the
// filesystem — same pattern as config-secret-rotation.test.ts.
vi.mock('$lib/server/crypto/master-key.js', () => ({
    resolveMasterKey: () => 'a'.repeat(64),
}));
import {
    runInventoryChecks,
    evaluateNonExpiringPats,
    evaluateRiskyServiceTokens,
    evaluateUnsealedLiveTvCredentials,
    evaluateLegacySecretEnvelopes,
    evaluateUnopenableSecrets,
    evaluateSingleIpPolicyPosture,
    type LegacyEnvelopeCounts,
    type UnopenableSecretCounts,
} from './inventory-checks';
import { deriveMasterKey, sealSecret, encrypt } from '$lib/server/crypto/secret-box.js';
import { pluginSecretContext } from '$lib/server/tasks/secrets.js';

/** All-clear counts; spread-override the one store a test is about. */
const NO_LEGACY: LegacyEnvelopeCounts = {
    subsonicPlaintext: 0,
    subsonicUnbound: 0,
    jellyfinUnbound: 0,
    livetvUnbound: 0,
    webhookUnbound: 0,
    pluginUnbound: 0,
    configUnbound: 0,
};

/** All-clear counts; spread-override the one store a test is about. */
const NO_UNOPENABLE: UnopenableSecretCounts = {
    subsonicUnopenable: 0,
    jellyfinUnopenable: 0,
    livetvUnopenable: 0,
    webhookUnopenable: 0,
    pluginUnopenable: 0,
    configUnopenable: 0,
};

/** The master key checkUnopenableSecrets derives, matching the mocked resolver above. */
const TEST_KEY = deriveMasterKey('a'.repeat(64));

// ---------------------------------------------------------------------------
// Pure helper tests — no sql needed
// ---------------------------------------------------------------------------

describe('evaluateNonExpiringPats', () => {
    it('returns pass when no non-expiring PATs exist', () => {
        const result = evaluateNonExpiringPats({ total: 0, adminScoped: 0 });
        expect(result.id).toBe('inventory.nonexpiring-admin-pats');
        expect(result.status).toBe('pass');
        expect(result.method).toBe('token');
        expect(result.type).toBe('inventory');
    });

    it('returns warn when non-expiring PATs exist', () => {
        const result = evaluateNonExpiringPats({ total: 3, adminScoped: 0 });
        expect(result.status).toBe('warn');
        expect(result.detail).toContain('3');
    });

    it('includes admin-scoped count in detail when > 0', () => {
        const result = evaluateNonExpiringPats({ total: 5, adminScoped: 2 });
        expect(result.status).toBe('warn');
        expect(result.detail).toContain('5');
        expect(result.detail).toContain('2');
        expect(result.detail).toContain('admin');
    });

    it('does not mention admin scope in detail when adminScoped is 0', () => {
        const result = evaluateNonExpiringPats({ total: 2, adminScoped: 0 });
        expect(result.status).toBe('warn');
        // The admin note should not appear
        expect(result.detail).not.toContain('admin scope');
    });

    it('includes remediation when status is warn', () => {
        const result = evaluateNonExpiringPats({ total: 1, adminScoped: 0 });
        expect(result.remediation).toBeTruthy();
    });

    it('does not include remediation when status is pass', () => {
        const result = evaluateNonExpiringPats({ total: 0, adminScoped: 0 });
        expect(result.remediation).toBeUndefined();
    });
});

describe('evaluateRiskyServiceTokens', () => {
    it('returns pass when count is 0', () => {
        const result = evaluateRiskyServiceTokens(0);
        expect(result.id).toBe('inventory.admin-service-tokens');
        expect(result.status).toBe('pass');
        expect(result.method).toBe('token');
        expect(result.type).toBe('inventory');
    });

    it('returns warn when unrestricted admin service tokens exist', () => {
        const result = evaluateRiskyServiceTokens(2);
        expect(result.status).toBe('warn');
        expect(result.detail).toContain('2');
    });

    it('includes remediation when status is warn', () => {
        const result = evaluateRiskyServiceTokens(1);
        expect(result.remediation).toBeTruthy();
    });

    it('does not include remediation when status is pass', () => {
        const result = evaluateRiskyServiceTokens(0);
        expect(result.remediation).toBeUndefined();
    });

    it('mentions admin scope, no expiry, and no IP allowlist in warn detail', () => {
        const result = evaluateRiskyServiceTokens(3);
        expect(result.detail).toContain('admin scope');
        expect(result.detail).toContain('no expiry');
        expect(result.detail).toContain('no IP allowlist');
    });
});

describe('evaluateSingleIpPolicyPosture', () => {
    it('passes when no user_stream_policies row sets require_single_ip', () => {
        const result = evaluateSingleIpPolicyPosture(0, 'fail-closed');
        expect(result.id).toBe('inventory.single-ip-policy-posture');
        expect(result.status).toBe('pass');
        expect(result.method).toBe('forward-auth');
    });

    it('passes when rows exist but TRUSTED_PROXY_IPS is pinned (allowlist posture)', () => {
        // Pinned posture means the strict resolver reads a distinct XFF value
        // per client, so require_single_ip actually enforces per-client.
        const result = evaluateSingleIpPolicyPosture(2, 'allowlist');
        expect(result.status).toBe('pass');
    });

    it('passes when the client IP is pinned by a narrow router trust or list (fail-closed identity posture)', () => {
        expect(evaluateSingleIpPolicyPosture(2, 'fail-closed', 'pinned').status).toBe('pass');
    });

    it('is info while the router hop is not yet verified on this pod', () => {
        const result = evaluateSingleIpPolicyPosture(2, 'fail-closed', 'unverified');
        expect(result.status).toBe('info');
        expect(result.title).toContain('not yet verified');
        expect(evaluateSingleIpPolicyPosture(0, 'fail-closed', 'unverified').status).toBe('pass');
    });

    it('warns, caveated, when the client IP comes from a router that trusts a wide range', () => {
        const result = evaluateSingleIpPolicyPosture(2, 'fail-closed', 'caveat');
        expect(result.status).toBe('warn');
        expect(result.detail).toContain('any pod in the cluster can choose it');
        expect(result.remediation).toContain('router.realIp.fromCIDRs');
        expect(evaluateSingleIpPolicyPosture(0, 'fail-closed', 'caveat').status).toBe('pass');
        expect(evaluateSingleIpPolicyPosture(2, 'allowlist', 'caveat').status).toBe('pass');
    });

    it('warns when rows exist and the proxy posture is fail-closed (unpinned)', () => {
        // Unpinned: getClientIpStrictFromRequest ignores XFF and falls back to
        // the raw TCP peer, so every client behind the same reverse proxy
        // collapses to ONE address — require_single_ip silently never trips.
        const result = evaluateSingleIpPolicyPosture(1, 'fail-closed');
        expect(result.status).toBe('warn');
        expect(result.detail).toContain('1');
        expect(result.remediation).toBeTruthy();
    });

    it('warns when rows exist and the proxy posture is trust-any (unpinned)', () => {
        const result = evaluateSingleIpPolicyPosture(3, 'trust-any');
        expect(result.status).toBe('warn');
        expect(result.detail).toContain('3');
    });
});

// ---------------------------------------------------------------------------
// runInventoryChecks — mock sql tag
// ---------------------------------------------------------------------------

/** The all-zero row shape the legacy-envelope query returns. */
const NO_LEGACY_ROW = {
    subsonic_plaintext: '0',
    subsonic_unbound: '0',
    jellyfin_unbound: '0',
    livetv_unbound: '0',
    webhook_unbound: '0',
    plugin_unbound: '0',
};

/**
 * checkUnopenableSecrets issues 7 MORE sequential queries after the 4 above
 * (subsonic, jellyfin, livetv, task_webhook_hooks, user_notification_webhooks,
 * plugin_secrets, plugin_user_credentials — see inventory-checks.ts). Append
 * empty-result responses for all 7 so a test that doesn't care about the new
 * check still gets a clean `pass` for it instead of an incidental `error`
 * finding from an exhausted mock queue.
 *
 * Also prepends one empty-result response for checkSingleIpPolicyPosture's
 * COUNT query (security fix C15, 2026-09-16 — runs right BEFORE
 * checkUnopenableSecrets in runInventoryChecks, precisely so its single query
 * lands in this one predictable slot instead of interleaving mid-way through
 * checkUnopenableSecrets's own 7-query chain) for the same reason.
 */
function withNoUnopenableRows(mockSql: ReturnType<typeof vi.fn>): ReturnType<typeof vi.fn> {
    return mockSql
        .mockResolvedValueOnce([{ count: '0' }]) // user_stream_policies (require_single_ip)
        .mockResolvedValueOnce([]) // subsonic_client_passwords
        .mockResolvedValueOnce([]) // jellyfin_client_passwords
        .mockResolvedValueOnce([]) // livetv_sources
        .mockResolvedValueOnce([]) // task_webhook_hooks
        .mockResolvedValueOnce([]) // user_notification_webhooks
        .mockResolvedValueOnce([]) // plugin_secrets
        .mockResolvedValueOnce([]); // plugin_user_credentials
}

describe('runInventoryChecks', () => {
    it('returns six findings (one per check) when queries succeed', async () => {
        // First call → PAT count (total=0, admin_scoped=0)
        // Second call → service token count (0); third → Live TV plaintext count (0)
        const mockSql = withNoUnopenableRows(
            vi
                .fn()
                .mockResolvedValueOnce([{ total: '0', admin_scoped: '0' }])
                .mockResolvedValueOnce([{ count: '0' }])
                .mockResolvedValueOnce([{ count: '0' }])
                .mockResolvedValueOnce([NO_LEGACY_ROW]),
        );

        const findings = await runInventoryChecks(mockSql as never);
        expect(findings).toHaveLength(6);
        expect(findings[0].id).toBe('inventory.nonexpiring-admin-pats');
        expect(findings[1].id).toBe('inventory.admin-service-tokens');
        expect(findings[2].id).toBe('inventory.livetv-plaintext-credentials');
        expect(findings[3].id).toBe('inventory.legacy-secret-envelopes');
        expect(findings[4].id).toBe('inventory.single-ip-policy-posture');
        expect(findings[5].id).toBe('inventory.bound-unopenable-secrets');
    });

    it('returns pass findings when no risky tokens exist', async () => {
        const mockSql = withNoUnopenableRows(
            vi
                .fn()
                .mockResolvedValueOnce([{ total: '0', admin_scoped: '0' }])
                .mockResolvedValueOnce([{ count: '0' }])
                .mockResolvedValueOnce([{ count: '0' }])
                .mockResolvedValueOnce([NO_LEGACY_ROW]),
        );

        const findings = await runInventoryChecks(mockSql as never);
        expect(findings.every((f) => f.status === 'pass')).toBe(true);
    });

    it('returns warn for PAT check when non-expiring PATs exist', async () => {
        const mockSql = withNoUnopenableRows(
            vi
                .fn()
                .mockResolvedValueOnce([{ total: '4', admin_scoped: '1' }])
                .mockResolvedValueOnce([{ count: '0' }])
                .mockResolvedValueOnce([{ count: '0' }])
                .mockResolvedValueOnce([NO_LEGACY_ROW]),
        );

        const findings = await runInventoryChecks(mockSql as never);
        const patFinding = findings.find((f) => f.id === 'inventory.nonexpiring-admin-pats');
        expect(patFinding?.status).toBe('warn');
        expect(findings).toHaveLength(6);
        expect(findings.filter((f) => f.status === 'error')).toEqual([]);
    });

    it('returns warn for service-token check when risky tokens exist', async () => {
        const mockSql = withNoUnopenableRows(
            vi
                .fn()
                .mockResolvedValueOnce([{ total: '0', admin_scoped: '0' }])
                .mockResolvedValueOnce([{ count: '3' }])
                .mockResolvedValueOnce([{ count: '0' }])
                .mockResolvedValueOnce([NO_LEGACY_ROW]),
        );

        const findings = await runInventoryChecks(mockSql as never);
        const svcFinding = findings.find((f) => f.id === 'inventory.admin-service-tokens');
        expect(svcFinding?.status).toBe('warn');
        // Every OTHER check got a real response, so none of them may have
        // degraded to an `error` finding: a short mock queue is how this file
        // last stopped testing what it claims to.
        expect(findings.filter((f) => f.status === 'error')).toEqual([]);
        expect(findings).toHaveLength(6);
    });

    it('returns error finding for a check when sql throws', async () => {
        // First call fails, second succeeds
        const mockSql = withNoUnopenableRows(
            vi
                .fn()
                .mockRejectedValueOnce(new Error('DB connection lost'))
                .mockResolvedValueOnce([{ count: '0' }])
                .mockResolvedValueOnce([{ count: '0' }])
                .mockResolvedValueOnce([NO_LEGACY_ROW]),
        );

        const findings = await runInventoryChecks(mockSql as never);
        // One error + five pass
        expect(findings).toHaveLength(6);
        const errorFinding = findings.find((f) => f.status === 'error');
        expect(errorFinding).toBeDefined();
        expect(errorFinding?.detail).toContain('DB connection lost');
        expect(findings.filter((f) => f.status === 'pass')).toHaveLength(5);
    });

    it('does not throw even when all checks fail', async () => {
        const mockSql = vi
            .fn()
            .mockRejectedValueOnce(new Error('query 1 failed'))
            .mockRejectedValueOnce(new Error('query 2 failed'))
            .mockRejectedValueOnce(new Error('query 3 failed'))
            .mockRejectedValueOnce(new Error('query 4 failed'))
            // query 5: checkSingleIpPolicyPosture's only query.
            .mockRejectedValueOnce(new Error('query 5 failed'))
            // query 6: checkUnopenableSecrets's FIRST query (subsonic)
            // rejecting is enough to fail that whole check — it never
            // reaches the other 6.
            .mockRejectedValueOnce(new Error('query 6 failed'));

        const findings = await runInventoryChecks(mockSql as never);
        expect(findings).toHaveLength(6);
        expect(findings.every((f) => f.status === 'error')).toBe(true);
    });

    it('never includes secret values in findings', async () => {
        const mockSql = withNoUnopenableRows(
            vi
                .fn()
                .mockResolvedValueOnce([{ total: '2', admin_scoped: '1' }])
                .mockResolvedValueOnce([{ count: '1' }])
                .mockResolvedValueOnce([{ count: '0' }])
                .mockResolvedValueOnce([NO_LEGACY_ROW]),
        );

        const findings = await runInventoryChecks(mockSql as never);
        expect(findings).toHaveLength(6);
        expect(findings.filter((f) => f.status === 'error')).toEqual([]);
        for (const f of findings) {
            // No field should look like a token hash (64-char hex)
            const allText = [f.title, f.detail, f.remediation ?? '', f.evidence ?? ''].join(' ');
            expect(/[0-9a-f]{32,}/.test(allText)).toBe(false);
        }
    });
});

// ---------------------------------------------------------------------------
// evaluateUnsealedLiveTvCredentials — security review 2026-09-12, C8
// ---------------------------------------------------------------------------

describe('evaluateUnsealedLiveTvCredentials', () => {
    it('returns pass when every Live TV credential is sealed', () => {
        const result = evaluateUnsealedLiveTvCredentials(0);
        expect(result.id).toBe('inventory.livetv-plaintext-credentials');
        expect(result.status).toBe('pass');
        expect(result.type).toBe('inventory');
        expect(result.remediation).toBeUndefined();
    });

    it('returns warn naming the count and the re-save remediation when rows are plaintext', () => {
        const result = evaluateUnsealedLiveTvCredentials(2);
        expect(result.status).toBe('warn');
        expect(result.detail).toContain('2');
        expect(result.remediation).toMatch(/re-?save/i);
    });
});

// ---------------------------------------------------------------------------
// evaluateLegacySecretEnvelopes — security review 2026-09-13, C19
// ---------------------------------------------------------------------------

describe('evaluateLegacySecretEnvelopes', () => {
    it('passes when every sealed store is row-bound and nothing is plaintext', () => {
        const result = evaluateLegacySecretEnvelopes(NO_LEGACY);
        expect(result.id).toBe('inventory.legacy-secret-envelopes');
        expect(result.status).toBe('pass');
        expect(result.method).toBe('secrets');
        expect(result.type).toBe('inventory');
        expect(result.remediation).toBeUndefined();
    });

    it('warns and points at Rotate Master Key when a store still holds unbound envelopes', () => {
        const result = evaluateLegacySecretEnvelopes({ ...NO_LEGACY, subsonicUnbound: 3 });
        expect(result.status).toBe('warn');
        expect(result.detail).toContain('3');
        expect(result.detail).toContain('subsonic_client_passwords');
        expect(result.remediation).toMatch(/rotate master key/i);
    });

    it('names a legacy PLAINTEXT Subsonic token separately from an unbound envelope', () => {
        const result = evaluateLegacySecretEnvelopes({ ...NO_LEGACY, subsonicPlaintext: 2 });
        expect(result.status).toBe('warn');
        expect(result.detail).toMatch(/plaintext/i);
        expect(result.detail).toContain('2');
    });

    it('names every affected store, and only those', () => {
        const result = evaluateLegacySecretEnvelopes({
            ...NO_LEGACY,
            jellyfinUnbound: 1,
            pluginUnbound: 4,
        });
        expect(result.status).toBe('warn');
        expect(result.detail).toContain('jellyfin_client_passwords');
        expect(result.detail).toContain('plugin_secrets');
        expect(result.detail).not.toContain('livetv_sources');
    });
});

// ---------------------------------------------------------------------------
// evaluateUnopenableSecrets — "bound-but-unopenable" follow-up to C19: an
// enc:v2 envelope that fails to open under ITS OWN row's context
// ---------------------------------------------------------------------------

describe('evaluateUnopenableSecrets', () => {
    it('passes when every row-bound value opens under its own context', () => {
        const result = evaluateUnopenableSecrets(NO_UNOPENABLE);
        expect(result.id).toBe('inventory.bound-unopenable-secrets');
        expect(result.status).toBe('pass');
        expect(result.method).toBe('secrets');
        expect(result.type).toBe('inventory');
        expect(result.remediation).toBeUndefined();
    });

    it('warns and names the affected store when a value fails to open', () => {
        const result = evaluateUnopenableSecrets({ ...NO_UNOPENABLE, subsonicUnopenable: 2 });
        expect(result.status).toBe('warn');
        expect(result.detail).toContain('2');
        expect(result.detail).toContain('subsonic_client_passwords');
        expect(result.remediation).toMatch(/investigate before rotating/i);
    });

    it('names every affected store, and only those', () => {
        const result = evaluateUnopenableSecrets({
            ...NO_UNOPENABLE,
            jellyfinUnopenable: 1,
            pluginUnopenable: 3,
        });
        expect(result.status).toBe('warn');
        expect(result.detail).toContain('jellyfin_client_passwords');
        expect(result.detail).toContain('plugin_secrets');
        expect(result.detail).not.toContain('livetv_sources');
    });

    it('names settings.json when the config store has an unopenable value', () => {
        const result = evaluateUnopenableSecrets({ ...NO_UNOPENABLE, configUnopenable: 1 });
        expect(result.status).toBe('warn');
        expect(result.detail).toContain('settings.json');
    });

    it('sums every store into the total count', () => {
        const result = evaluateUnopenableSecrets({
            ...NO_UNOPENABLE,
            subsonicUnopenable: 1,
            livetvUnopenable: 2,
        });
        expect(result.detail).toContain('3 value(s)');
    });
});

// ---------------------------------------------------------------------------
// checkUnopenableSecrets (via runInventoryChecks) — real crypto against a
// mocked sql tag. The master key is mocked at the top of this file (see
// vi.mock('$lib/server/crypto/master-key.js')), so this never touches disk.
// ---------------------------------------------------------------------------

describe('runInventoryChecks — bound-unopenable secrets', () => {
    it('reports pass when every returned v2 row opens under its own context', async () => {
        const mockSql = withNoUnopenableRows(
            vi
                .fn()
                .mockResolvedValueOnce([{ total: '0', admin_scoped: '0' }])
                .mockResolvedValueOnce([{ count: '0' }])
                .mockResolvedValueOnce([{ count: '0' }])
                .mockResolvedValueOnce([NO_LEGACY_ROW]),
        );

        const findings = await runInventoryChecks(mockSql as never);
        const result = findings.find((f) => f.id === 'inventory.bound-unopenable-secrets');
        expect(result?.status).toBe('pass');
    });

    it('does not flag a subsonic row whose envelope opens under its own context', async () => {
        const validEnvelope = sealSecret(
            'token-value',
            TEST_KEY,
            'subsonic_client_passwords:real-user',
        );

        const mockSql = vi
            .fn()
            .mockResolvedValueOnce([{ total: '0', admin_scoped: '0' }])
            .mockResolvedValueOnce([{ count: '0' }])
            .mockResolvedValueOnce([{ count: '0' }])
            .mockResolvedValueOnce([NO_LEGACY_ROW])
            .mockResolvedValueOnce([{ count: '0' }]) // user_stream_policies
            .mockResolvedValueOnce([{ user_id: 'real-user', token_sealed: validEnvelope }]) // subsonic
            .mockResolvedValueOnce([]) // jellyfin
            .mockResolvedValueOnce([]) // livetv
            .mockResolvedValueOnce([]) // task_webhook_hooks
            .mockResolvedValueOnce([]) // user_notification_webhooks
            .mockResolvedValueOnce([]) // plugin_secrets
            .mockResolvedValueOnce([]); // plugin_user_credentials

        const findings = await runInventoryChecks(mockSql as never);
        const result = findings.find((f) => f.id === 'inventory.bound-unopenable-secrets');
        expect(result?.status).toBe('pass');
    });

    it('reports warn naming subsonic_client_passwords when a row context has drifted', async () => {
        // Sealed under a DIFFERENT user id than the row it is attached to —
        // the exact "context contract drift / transplanted blob" scenario
        // this check exists to catch.
        const driftedEnvelope = sealSecret(
            'token-value',
            TEST_KEY,
            'subsonic_client_passwords:wrong-user',
        );

        const mockSql = vi
            .fn()
            .mockResolvedValueOnce([{ total: '0', admin_scoped: '0' }])
            .mockResolvedValueOnce([{ count: '0' }])
            .mockResolvedValueOnce([{ count: '0' }])
            .mockResolvedValueOnce([NO_LEGACY_ROW])
            .mockResolvedValueOnce([{ count: '0' }]) // user_stream_policies
            .mockResolvedValueOnce([{ user_id: 'real-user', token_sealed: driftedEnvelope }]) // subsonic
            .mockResolvedValueOnce([]) // jellyfin
            .mockResolvedValueOnce([]) // livetv
            .mockResolvedValueOnce([]) // task_webhook_hooks
            .mockResolvedValueOnce([]) // user_notification_webhooks
            .mockResolvedValueOnce([]) // plugin_secrets
            .mockResolvedValueOnce([]); // plugin_user_credentials

        const findings = await runInventoryChecks(mockSql as never);
        const result = findings.find((f) => f.id === 'inventory.bound-unopenable-secrets');
        expect(result?.status).toBe('warn');
        expect(result?.detail).toContain('subsonic_client_passwords (1)');
        expect(result?.remediation).toMatch(/investigate before rotating/i);
    });

    it('reports warn naming plugin_secrets when a BYTEA blob context has drifted', async () => {
        // encrypt() with an AAD context produces the row-bound (`enc:v2:`
        // prefixed) blob form the query predicate selects on.
        const driftedBlob = encrypt(
            'secret-value',
            TEST_KEY,
            pluginSecretContext('wrong-plugin', 'api_key'),
        );

        const mockSql = vi
            .fn()
            .mockResolvedValueOnce([{ total: '0', admin_scoped: '0' }])
            .mockResolvedValueOnce([{ count: '0' }])
            .mockResolvedValueOnce([{ count: '0' }])
            .mockResolvedValueOnce([NO_LEGACY_ROW])
            .mockResolvedValueOnce([{ count: '0' }]) // user_stream_policies
            .mockResolvedValueOnce([]) // subsonic
            .mockResolvedValueOnce([]) // jellyfin
            .mockResolvedValueOnce([]) // livetv
            .mockResolvedValueOnce([]) // task_webhook_hooks
            .mockResolvedValueOnce([]) // user_notification_webhooks
            .mockResolvedValueOnce([
                { plugin_id: 'real-plugin', key: 'api_key', value_encrypted: driftedBlob },
            ]) // plugin_secrets
            .mockResolvedValueOnce([]); // plugin_user_credentials

        const findings = await runInventoryChecks(mockSql as never);
        const result = findings.find((f) => f.id === 'inventory.bound-unopenable-secrets');
        expect(result?.status).toBe('warn');
        expect(result?.detail).toContain('plugin_secrets');
    });
});

// ---------------------------------------------------------------------------
// settings.json is a FILE, not a table — the one store the SQL cannot see
// ---------------------------------------------------------------------------

describe('the bound-unopenable check covers settings.json', () => {
    it('reads the count from the config service, which owns the file', async () => {
        const mockSql = withNoUnopenableRows(
            vi
                .fn()
                .mockResolvedValueOnce([{ total: '0', admin_scoped: '0' }])
                .mockResolvedValueOnce([{ count: '0' }])
                .mockResolvedValueOnce([{ count: '0' }])
                .mockResolvedValueOnce([NO_LEGACY_ROW]),
        );

        configUnopenableKeys.splice(0, configUnopenableKeys.length, 'TMDB_API_KEY');

        const findings = await runInventoryChecks(mockSql as never);
        const result = findings.find((f) => f.id === 'inventory.bound-unopenable-secrets');
        expect(result?.status).toBe('warn');
        expect(result?.detail).toContain('settings.json');

        configUnopenableKeys.length = 0;
    });
});

describe('the legacy-envelope check covers settings.json', () => {
    it('warns, naming settings.json, when config values are still unbound', () => {
        const result = evaluateLegacySecretEnvelopes({ ...NO_LEGACY, configUnbound: 2 });
        expect(result.status).toBe('warn');
        expect(result.detail).toContain('settings.json');
        expect(result.detail).toContain('2');
    });

    it('does not claim everything is bound when only settings.json is not', () => {
        // The bug: config was omitted from the check, so an install whose
        // ONLY unbound values were in settings.json got a pass titled
        // "Every stored secret is bound to its own row".
        const result = evaluateLegacySecretEnvelopes({ ...NO_LEGACY, configUnbound: 1 });
        expect(result.status).not.toBe('pass');
        expect(result.title).not.toMatch(/every stored secret is bound/i);
    });

    it('reads the count from the config service, which owns the file', async () => {
        const { runInventoryChecks } = await import('./inventory-checks');
        const mockSql = withNoUnopenableRows(
            vi
                .fn()
                .mockResolvedValueOnce([{ total: '0', admin_scoped: '0' }])
                .mockResolvedValueOnce([{ count: '0' }])
                .mockResolvedValueOnce([{ count: '0' }])
                .mockResolvedValueOnce([NO_LEGACY_ROW]),
        );

        configLegacyKeys.splice(0, configLegacyKeys.length, 'TMDB_API_KEY');

        const findings = await runInventoryChecks(mockSql as never);
        const envelopes = findings.find((f) => f.id === 'inventory.legacy-secret-envelopes');
        expect(envelopes?.status).toBe('warn');
        expect(envelopes?.detail).toContain('settings.json');

        configLegacyKeys.length = 0;
    });
});
