// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Security Self-Check — Zod schemas (single source of truth).
 *
 * SINGLE SOURCE OF TRUTH for the admin Security Self-Check report shape returned by
 * `POST /api/admin/security-self-check/run`.
 *
 * Findings are READ-ONLY observations about the live deployment posture (edge probes,
 * live config, read-only DB counts). They NEVER contain secret values — only names,
 * counts, prefixes, and `file:line` evidence.
 *
 * Types are inferred via `z.infer<>` — never hand-write a parallel interface.
 *
 * Convention:
 * - Use .optional() for optional fields (Swift compatibility)
 * - Use .nullable() only when the database/API genuinely returns null
 */

import { z } from 'zod';

// ── Enumerations ────────────────────────────────────────────────────────────

/** Which auth method / surface a finding belongs to. Used to group findings in the UI. */
export const SecuritySelfCheckMethodSchema = z
    .enum([
        'forward-auth',
        'native',
        'oidc',
        'token',
        'jellyfin-compat',
        'subsonic-compat',
        'edge',
        'secrets',
    ])
    .describe('Auth method / surface the finding belongs to (UI groups findings by this)');
export type SecuritySelfCheckMethod = z.infer<typeof SecuritySelfCheckMethodSchema>;

/** How the finding was produced. */
export const SecuritySelfCheckTypeSchema = z
    .enum(['edge-probe', 'config-static', 'inventory'])
    .describe('How the finding was produced: live edge probe, static config rule, or DB inventory');
export type SecuritySelfCheckType = z.infer<typeof SecuritySelfCheckTypeSchema>;

/** Verdict status of a single finding. */
export const SecuritySelfCheckStatusSchema = z
    .enum(['pass', 'warn', 'fail', 'skipped', 'error', 'info'])
    .describe(
        'Verdict: pass / warn / fail; info (neutral observation, no action implied); ' +
            'skipped (not applicable) / error (check could not run)',
    );
export type SecuritySelfCheckStatus = z.infer<typeof SecuritySelfCheckStatusSchema>;

// ── Finding ─────────────────────────────────────────────────────────────────

export const SecuritySelfCheckFindingSchema = z.object({
    id: z.string().describe('Stable identifier, e.g. "oidc.allow-insecure"'),
    method: SecuritySelfCheckMethodSchema,
    type: SecuritySelfCheckTypeSchema,
    status: SecuritySelfCheckStatusSchema,
    title: z.string().describe('Short human-readable title of the check'),
    detail: z.string().describe('What was observed (never contains secret values)'),
    remediation: z.string().optional().describe('How to fix, when status is warn/fail'),
    evidence: z
        .string()
        .optional()
        .describe('file:line or config key supporting the finding (no secret values)'),
});
export type SecuritySelfCheckFinding = z.infer<typeof SecuritySelfCheckFindingSchema>;

// ── Report ──────────────────────────────────────────────────────────────────

export const SecuritySelfCheckSummarySchema = z
    .object({
        pass: z.number().int().nonnegative(),
        warn: z.number().int().nonnegative(),
        fail: z.number().int().nonnegative(),
        skipped: z.number().int().nonnegative(),
        error: z.number().int().nonnegative(),
        info: z.number().int().nonnegative(),
    })
    .describe('Count of findings per status');
export type SecuritySelfCheckSummary = z.infer<typeof SecuritySelfCheckSummarySchema>;

export const SecuritySelfCheckReportSchema = z.object({
    ranAt: z.string().describe('ISO timestamp, stamped by the route after the run'),
    findings: z
        .array(SecuritySelfCheckFindingSchema)
        .describe('All findings, grouped by method in the UI'),
    summary: SecuritySelfCheckSummarySchema,
});
export type SecuritySelfCheckReport = z.infer<typeof SecuritySelfCheckReportSchema>;
