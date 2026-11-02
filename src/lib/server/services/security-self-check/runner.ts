// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Security Self-Check — Runner.
 *
 * Orchestrates the three check families (config-rules, inventory-checks,
 * edge-probes), aggregates their findings into a single report, and validates
 * the result against the Zod schema (single source of truth).
 *
 * Resilience: each family is wrapped in its own try/catch. A family that throws
 * contributes a single `error`-status finding but does NOT abort the others —
 * the report is always assembled from whatever partial results are available.
 *
 * I/O-agnostic: the runner does not know how an ephemeral token is minted. The
 * caller (the `/run` admin route) injects `mintToken`, which produces a
 * short-lived service token and a `revoke()` closure. `revoke()` is always
 * called by the edge-probe family after the forward-auth reflection probe.
 *
 * `ranAt` is stamped here with a real ISO timestamp; the route may overwrite it
 * but does not need to.
 */

import type postgres from 'postgres';
import {
    SecuritySelfCheckReportSchema,
    type SecuritySelfCheckFinding,
    type SecuritySelfCheckReport,
} from '$lib/schemas/security-self-check';
import { finding, summarize } from './finding';
import { runConfigRules } from './config-rules';
import { runInventoryChecks } from './inventory-checks';
import { runEdgeProbes } from './edge-probes';

/** Injected dependencies for {@link runSecuritySelfCheck}. */
export interface SecuritySelfCheckDeps {
    /** Read-only postgres connection for inventory COUNT queries. */
    sql: postgres.Sql;
    /**
     * Public base URL of the edge (e.g. https://example.com). When null, all edge
     * probes report `skipped` with a reason (config-rules separately flags the
     * missing base URL via `device.verification-base-url`).
     */
    baseUrl: string | null;
    /**
     * Mint a short-lived ephemeral token for the authenticated forward-auth
     * reflection probe. The returned `revoke()` closure is always invoked by the
     * edge-probe family in a finally block.
     */
    mintToken: () => Promise<{ token: string; revoke: () => Promise<void> }>;
}

/**
 * Run all security self-check families and assemble a validated report.
 *
 * Never throws: a failing family is caught and surfaced as an `error`-status
 * finding so the report is always returned.
 *
 * @param deps - Injected sql, baseUrl, and mintToken dependencies.
 * @returns A Zod-validated {@link SecuritySelfCheckReport}.
 */
export async function runSecuritySelfCheck(
    deps: SecuritySelfCheckDeps,
): Promise<SecuritySelfCheckReport> {
    const { sql, baseUrl, mintToken } = deps;

    // Run each family independently and concurrently. `runFamily` guarantees a
    // resolved value (an array of findings, or a single error-finding) so one
    // family's failure can never reject the whole run.
    const [configFindings, inventoryFindings, edgeFindings] = await Promise.all([
        runFamily('config-rules', () => Promise.resolve(runConfigRules())),
        runFamily('inventory-checks', () => runInventoryChecks(sql)),
        runFamily('edge-probes', () => runEdgeProbes({ baseUrl, mintToken })),
    ]);

    const findings: SecuritySelfCheckFinding[] = [
        ...configFindings,
        ...inventoryFindings,
        ...edgeFindings,
    ];

    const report = {
        ranAt: new Date().toISOString(),
        findings,
        summary: summarize(findings),
    };

    // Validate against the single source of truth before returning. A schema
    // mismatch is a programming error — surface it loudly rather than shipping a
    // malformed report to the admin UI.
    return SecuritySelfCheckReportSchema.parse(report);
}

/**
 * Run one check family, converting any thrown error into a single
 * `error`-status finding instead of propagating. Guarantees a resolved array.
 *
 * @param family - Family identifier used in the error finding id/title.
 * @param fn      - The family's async runner.
 */
async function runFamily(
    family: string,
    fn: () => Promise<SecuritySelfCheckFinding[]>,
): Promise<SecuritySelfCheckFinding[]> {
    try {
        return await fn();
    } catch (err) {
        return [
            finding({
                id: `${family}.family-error`,
                method: 'secrets',
                type: 'config-static',
                status: 'error',
                title: `Security self-check family "${family}" failed`,
                detail: `The ${family} check family threw an unexpected error and was skipped: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            }),
        ];
    }
}
