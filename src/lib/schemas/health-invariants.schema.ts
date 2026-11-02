// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Health Invariants Response Zod Schemas
 *
 * SINGLE SOURCE OF TRUTH for the /api/v1/admin/system-health/invariants endpoint.
 *
 * Convention:
 * - Use .optional() for optional fields (Swift compatibility)
 * - Use .nullable() only when the database/API genuinely returns null
 */

import { z } from 'zod';

export const FindingStatusSchema = z.enum(['green', 'amber', 'red', 'unknown']);

export const InvariantDetailLinkSchema = z.object({
    label: z.string().describe('Short label for the specific affected target (e.g. a task name)'),
    sublabel: z
        .string()
        .optional()
        .describe(
            'Extra disambiguating context (e.g. a stage id) when the label alone is ambiguous',
        ),
    count: z
        .number()
        .optional()
        .describe("This target's contribution to the finding's total count"),
    href: z.string().optional().describe('Deep link straight to the affected target, when known'),
});

export const HealthFindingSchema = z.object({
    id: z.string().describe('Stable kebab-case invariant identifier'),
    label: z.string().describe('Short UI label'),
    status: FindingStatusSchema.describe('Current health status'),
    value: z.number().nullable().describe('Metric value returned by the invariant query'),
    description: z.string().describe('One-sentence description of what this invariant checks'),
    remediation: z
        .string()
        .nullable()
        .describe('One-sentence remediation advice when status is red'),
    thresholdAmber: z
        .number()
        .nullable()
        .describe('Value above this threshold triggers amber status'),
    thresholdRed: z.number().nullable().describe('Value above this threshold triggers red status'),
    lastRunAt: z.string().describe('ISO timestamp of the most recent run'),
    lastChangeAt: z.string().describe('ISO timestamp of the last status transition'),
    error: z.string().nullable().describe('Error message if the invariant query itself failed'),
    details: z
        .array(InvariantDetailLinkSchema)
        .optional()
        .describe(
            'Per-target breakdown (e.g. one row per affected task) computed when status is amber/red',
        ),
});

export const HealthInvariantsResponseSchema = z.object({
    findings: z.array(HealthFindingSchema),
    /**
     * Max(lastRunAt) across all findings — the time of the most recent UPSERT,
     * regardless of whether the underlying invariant query succeeded. Use as
     * "last attempt" rather than "last success".
     */
    lastFullRunAt: z
        .string()
        .nullable()
        .describe(
            'ISO timestamp of the most recent UPSERT across all findings (success or recorded-as-unknown)',
        ),
    /**
     * Max(lastRunAt) across findings whose `error` is null — the last time
     * EVERY invariant query that ran did so successfully. Lags lastFullRunAt
     * whenever a query threw and was recorded with status='unknown'.
     */
    lastSuccessfulRunAt: z
        .string()
        .nullable()
        .describe('ISO timestamp of the most recent run with no errored invariants'),
    /** Count of findings whose latest query attempt errored (status='unknown'). */
    erroredCount: z
        .number()
        .int()
        .nonnegative()
        .describe('Count of findings whose latest query errored'),
});

export type InvariantDetailLink = z.infer<typeof InvariantDetailLinkSchema>;
export type HealthFinding = z.infer<typeof HealthFindingSchema>;
export type HealthInvariantsResponse = z.infer<typeof HealthInvariantsResponseSchema>;
