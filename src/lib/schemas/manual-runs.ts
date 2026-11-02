// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

/** One run the caller started by hand, as the app-wide progress tracker shows it. */
export const ManualRunSchema = z
    .object({
        id: z.string(),
        parentRunId: z.string().optional().describe('Set on a child of a fanned-out run'),
        taskId: z.string(),
        title: z.string().describe('Task display name, e.g. "File Library Scan"'),
        detail: z.string().optional().describe('What it acted on: a library name or a media title'),
        state: z.enum(['pending', 'active', 'cancelling', 'completed', 'failed', 'cancelled']),
        startedAt: z.string(),
        completedAt: z.string().optional(),
        processed: z.number().int().optional(),
        total: z.number().int().optional(),
        error: z.string().optional().describe('Failure message of a failed run'),
    })
    .meta({ id: 'ManualRun' });

export const ManualRunsResponseSchema = z
    .object({
        runs: z.array(ManualRunSchema),
        serverTime: z
            .string()
            .describe('Server clock — pass back as ?since= to fetch only later completions'),
    })
    .meta({ id: 'ManualRunsResponse' });

export type ManualRun = z.infer<typeof ManualRunSchema>;
export type ManualRunsResponse = z.infer<typeof ManualRunsResponseSchema>;
