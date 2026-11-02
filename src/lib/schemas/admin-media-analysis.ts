// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

export const AnalyzerReadinessSchema = z.object({
    mediaId: z.string().uuid(),
    state: z
        .enum(['ready', 'awaiting-input'])
        .describe('Whether the actual selected analyzer input is eligible.'),
    inputIdentity: z
        .string()
        .nullable()
        .describe('Selected content and logical window identity; absent input is null.'),
    fileId: z.string().uuid().nullable(),
    filePath: z.string().nullable(),
    alternate: z
        .boolean()
        .describe('An eligible alternate was selected instead of the default version.'),
    proof: z
        .object({
            runId: z.string().nullable(),
            inputIdentity: z.string(),
            stageId: z.string(),
            segmentTypes: z.array(z.string()),
            processingVersion: z.number().int(),
            coverageComplete: z.boolean(),
            segmentsCount: z.number().int().nonnegative(),
            completedAt: z.string(),
        })
        .nullable()
        .describe('A completed pass for this exact input. Legacy coverage is not proof.'),
});
export type AnalyzerReadiness = z.infer<typeof AnalyzerReadinessSchema>;
