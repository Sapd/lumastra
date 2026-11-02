// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import { FileHealthIssueSchema } from './api-media-responses.js';

export const FileHealthRecheckRequestSchema = z.object({
    fileId: z.string().uuid().toLowerCase().describe('UUID of the selected physical media file'),
});
export const FileHealthRecheckAcceptedSchema = z.object({
    runId: z.string().describe('Persisted selected-file run whose terminal result must be checked'),
    deduped: z.boolean().describe('True when the identical in-flight selected-file run was reused'),
});
export const FileHealthRecheckResultSchema = z.object({
    fileId: z.string().uuid(),
    outcome: z.enum(['healthy', 'warning', 'inconclusive', 'error', 'cancelled', 'busy']),
    // Generic runs:read is not an admin file-detail surface. Persist enums only.
    issues: z.array(FileHealthIssueSchema.pick({ type: true })),
    reason: z
        .enum(['disabled', 'probe_failed', 'inconclusive', 'warnings_remain', 'busy'])
        .optional(),
});
export type FileHealthRecheckResult = z.infer<typeof FileHealthRecheckResultSchema>;
