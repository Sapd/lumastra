// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

const lease = {
    playbackSessionId: z.string().describe('Session id returned by the start operation.'),
    href: z
        .string()
        .describe(
            'Reporting URL on the caller surface. Use account authentication, never the delivery grant.',
        ),
    intervalMs: z.number().int().positive().describe('Reporting cadence in milliseconds.'),
};

export const progressReportingSchema = z
    .object({
        ...lease,
        playbackSessionId: z.string().uuid(),
        kind: z.literal('progress'),
        method: z.literal('PUT'),
        unit: z.literal('ms').describe('Position and duration unit for progress reports.'),
    })
    .strict();

export const keepaliveReportingSchema = z
    .object({
        ...lease,
        kind: z.literal('keepalive'),
        method: z.literal('POST'),
    })
    .strict();

/** Progress reports and bodyless lease renewal have distinct protocols. */
export const reportingBlockSchema = z.discriminatedUnion('kind', [
    progressReportingSchema,
    keepaliveReportingSchema,
]);
export type ReportingBlock = z.infer<typeof reportingBlockSchema>;
