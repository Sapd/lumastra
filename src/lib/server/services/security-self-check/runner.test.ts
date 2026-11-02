// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';
import type { SecuritySelfCheckFinding } from '$lib/schemas/security-self-check';
import { SecuritySelfCheckReportSchema } from '$lib/schemas/security-self-check';

// ── Mock the three check families ─────────────────────────────────────────────
// Each is hoisted; we drive their behaviour per-test via the vi.fn() handles.

const runConfigRulesMock = vi.fn<() => SecuritySelfCheckFinding[]>();
const runInventoryChecksMock = vi.fn<(sql: postgres.Sql) => Promise<SecuritySelfCheckFinding[]>>();
const runEdgeProbesMock =
    vi.fn<
        (opts: {
            baseUrl: string | null;
            mintToken: unknown;
        }) => Promise<SecuritySelfCheckFinding[]>
    >();

vi.mock('./config-rules', () => ({
    runConfigRules: () => runConfigRulesMock(),
}));
vi.mock('./inventory-checks', () => ({
    runInventoryChecks: (sql: postgres.Sql) => runInventoryChecksMock(sql),
}));
vi.mock('./edge-probes', () => ({
    runEdgeProbes: (opts: { baseUrl: string | null; mintToken: unknown }) =>
        runEdgeProbesMock(opts),
}));

import { runSecuritySelfCheck } from './runner';

// Minimal fake sql — never actually called (inventory family is mocked).
const fakeSql = (() => {
    throw new Error('sql should not be invoked in these tests');
}) as unknown as postgres.Sql;

function mkFinding(
    id: string,
    status: SecuritySelfCheckFinding['status'],
): SecuritySelfCheckFinding {
    return {
        id,
        method: 'edge',
        type: 'edge-probe',
        status,
        title: `title ${id}`,
        detail: `detail ${id}`,
    };
}

const noopMintToken = async (): Promise<{ token: string; revoke: () => Promise<void> }> => ({
    token: 'svc_test',
    revoke: async () => {},
});

describe('runSecuritySelfCheck', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        runConfigRulesMock.mockReturnValue([mkFinding('config.a', 'pass')]);
        runInventoryChecksMock.mockResolvedValue([mkFinding('inventory.a', 'warn')]);
        runEdgeProbesMock.mockResolvedValue([mkFinding('edge.a', 'fail')]);
    });

    it('concatenates findings from all three families', async () => {
        const report = await runSecuritySelfCheck({
            sql: fakeSql,
            baseUrl: 'https://example.test',
            mintToken: noopMintToken,
        });
        const ids = report.findings.map((f) => f.id);
        expect(ids).toContain('config.a');
        expect(ids).toContain('inventory.a');
        expect(ids).toContain('edge.a');
        expect(report.findings).toHaveLength(3);
    });

    it('computes the summary from all findings', async () => {
        const report = await runSecuritySelfCheck({
            sql: fakeSql,
            baseUrl: 'https://example.test',
            mintToken: noopMintToken,
        });
        expect(report.summary).toEqual({
            pass: 1,
            warn: 1,
            fail: 1,
            skipped: 0,
            error: 0,
            info: 0,
        });
    });

    it('stamps a valid ISO ranAt timestamp', async () => {
        const before = Date.now();
        const report = await runSecuritySelfCheck({
            sql: fakeSql,
            baseUrl: null,
            mintToken: noopMintToken,
        });
        const parsed = Date.parse(report.ranAt);
        expect(Number.isNaN(parsed)).toBe(false);
        expect(parsed).toBeGreaterThanOrEqual(before - 1000);
    });

    it('returns a schema-valid report', async () => {
        const report = await runSecuritySelfCheck({
            sql: fakeSql,
            baseUrl: 'https://example.test',
            mintToken: noopMintToken,
        });
        // Should not throw.
        expect(() => SecuritySelfCheckReportSchema.parse(report)).not.toThrow();
    });

    it('passes baseUrl and mintToken through to edge probes', async () => {
        await runSecuritySelfCheck({
            sql: fakeSql,
            baseUrl: 'https://edge.test',
            mintToken: noopMintToken,
        });
        expect(runEdgeProbesMock).toHaveBeenCalledWith(
            expect.objectContaining({ baseUrl: 'https://edge.test', mintToken: noopMintToken }),
        );
    });

    it('passes sql through to inventory checks', async () => {
        await runSecuritySelfCheck({
            sql: fakeSql,
            baseUrl: null,
            mintToken: noopMintToken,
        });
        expect(runInventoryChecksMock).toHaveBeenCalledWith(fakeSql);
    });

    it('does not abort when the config family throws — emits an error finding', async () => {
        runConfigRulesMock.mockImplementation(() => {
            throw new Error('config boom');
        });
        const report = await runSecuritySelfCheck({
            sql: fakeSql,
            baseUrl: 'https://example.test',
            mintToken: noopMintToken,
        });
        // Other families still ran.
        const ids = report.findings.map((f) => f.id);
        expect(ids).toContain('inventory.a');
        expect(ids).toContain('edge.a');
        // Config family error surfaced as an error-status finding.
        const errFinding = report.findings.find((f) => f.id === 'config-rules.family-error');
        expect(errFinding?.status).toBe('error');
        expect(errFinding?.detail).toContain('config boom');
        expect(report.summary.error).toBe(1);
    });

    it('does not abort when the inventory family rejects', async () => {
        runInventoryChecksMock.mockRejectedValue(new Error('db down'));
        const report = await runSecuritySelfCheck({
            sql: fakeSql,
            baseUrl: 'https://example.test',
            mintToken: noopMintToken,
        });
        const ids = report.findings.map((f) => f.id);
        expect(ids).toContain('config.a');
        expect(ids).toContain('edge.a');
        const errFinding = report.findings.find((f) => f.id === 'inventory-checks.family-error');
        expect(errFinding?.status).toBe('error');
        expect(errFinding?.detail).toContain('db down');
    });

    it('does not abort when the edge family rejects', async () => {
        runEdgeProbesMock.mockRejectedValue(new Error('probe boom'));
        const report = await runSecuritySelfCheck({
            sql: fakeSql,
            baseUrl: 'https://example.test',
            mintToken: noopMintToken,
        });
        const errFinding = report.findings.find((f) => f.id === 'edge-probes.family-error');
        expect(errFinding?.status).toBe('error');
        expect(errFinding?.detail).toContain('probe boom');
    });

    it('handles all families failing without throwing', async () => {
        runConfigRulesMock.mockImplementation(() => {
            throw new Error('a');
        });
        runInventoryChecksMock.mockRejectedValue(new Error('b'));
        runEdgeProbesMock.mockRejectedValue(new Error('c'));
        const report = await runSecuritySelfCheck({
            sql: fakeSql,
            baseUrl: null,
            mintToken: noopMintToken,
        });
        expect(report.summary.error).toBe(3);
        expect(report.findings).toHaveLength(3);
    });
});
