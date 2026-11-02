// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

export const ConformanceKindSchema = z.enum(['stripped', 'mismatch']);
export const ConformanceItemSchema = z.object({
    method: z.string().describe('HTTP method'),
    route: z.string().describe('SvelteKit route id; never a concrete request path'),
    kind: ConformanceKindSchema,
    count: z.number().int().nonnegative(),
    samples: z.array(z.string()).max(5).describe('First undeclared fields or path:code issues'),
    firstSeenAt: z
        .string()
        .datetime()
        .optional()
        .describe(
            'First hit still inside the retained 8-day window. Absent for counts recorded before timestamps were kept.',
        ),
    lastSeenAt: z
        .string()
        .datetime()
        .optional()
        .describe(
            'Most recent hit. `since` keeps only items whose lastSeenAt is at or after it, so an empty list means no new hits.',
        ),
    lastBuild: z
        .string()
        .max(40)
        .optional()
        .describe('Short commit of the build that served the most recent hit'),
});
export const ConformanceResponseSchema = z.object({
    days: z.number().int().min(1).max(8),
    since: z.string().datetime().optional().describe('Echo of the since filter, when given'),
    totals: z.object({
        stripped: z.number().int().nonnegative(),
        mismatch: z.number().int().nonnegative(),
    }),
    items: z.array(ConformanceItemSchema),
});
export type ConformanceKind = z.infer<typeof ConformanceKindSchema>;
export type ConformanceItem = z.infer<typeof ConformanceItemSchema>;
export type ConformanceResponse = z.infer<typeof ConformanceResponseSchema>;
