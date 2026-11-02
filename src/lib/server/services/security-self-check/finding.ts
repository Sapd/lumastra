// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Security Self-Check — Finding helpers.
 *
 * Pure, well-typed helpers shared by every check family (config-rules,
 * inventory-checks, edge-probes) and the runner. No side effects, no I/O.
 *
 * `finding()` is the single typed builder so every check family produces the same
 * shape. `summarize()` derives the per-status counts for the report summary.
 */

import type {
    SecuritySelfCheckFinding,
    SecuritySelfCheckMethod,
    SecuritySelfCheckStatus,
    SecuritySelfCheckSummary,
    SecuritySelfCheckType,
} from '$lib/schemas/security-self-check';

/** Arguments for the {@link finding} builder. Mirrors `SecuritySelfCheckFinding`. */
export interface FindingArgs {
    id: string;
    method: SecuritySelfCheckMethod;
    type: SecuritySelfCheckType;
    status: SecuritySelfCheckStatus;
    title: string;
    detail: string;
    remediation?: string;
    evidence?: string;
}

/**
 * Build a {@link SecuritySelfCheckFinding}. Optional fields (`remediation`,
 * `evidence`) are omitted from the result when not provided, so the object stays
 * clean for Zod's `.optional()` fields.
 */
export function finding(args: FindingArgs): SecuritySelfCheckFinding {
    const result: SecuritySelfCheckFinding = {
        id: args.id,
        method: args.method,
        type: args.type,
        status: args.status,
        title: args.title,
        detail: args.detail,
    };
    if (args.remediation !== undefined) result.remediation = args.remediation;
    if (args.evidence !== undefined) result.evidence = args.evidence;
    return result;
}

/** Count findings per status for the report summary. */
export function summarize(findings: readonly SecuritySelfCheckFinding[]): SecuritySelfCheckSummary {
    const summary: SecuritySelfCheckSummary = {
        pass: 0,
        warn: 0,
        fail: 0,
        skipped: 0,
        error: 0,
        info: 0,
    };
    for (const f of findings) {
        summary[f.status] += 1;
    }
    return summary;
}
