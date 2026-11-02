// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { AudioTailAssessmentSchema } from './audio-tail-assessment.js';

export const ReviewableDurationIssueSchema = z.enum([
    'duration_mismatch',
    'video_ends_early',
    'truncated_video',
]);
const Signature = z.string().regex(/^[a-f0-9]{64}$/);
export const FileHealthReviewIssueSchema = z.object({
    key: Signature.describe('Exact canonical finding identifier'),
    type: ReviewableDurationIssueSchema,
    expectedDuration: z.number().positive().finite().optional(),
    actualDuration: z.number().nonnegative().finite().optional(),
    detail: z.string().max(2048).optional(),
    state: z.enum(['needs-review', 'reviewed', 'blocked']),
    reviewId: z.uuid().optional(),
});
export const FileHealthReviewHistorySchema = z.object({
    id: z.uuid(),
    issueKey: Signature,
    issueType: ReviewableDurationIssueSchema,
    reason: z.string(),
    evidence: z.string(),
    decidedBy: z.string(),
    decidedAt: z.string(),
    state: z.enum(['current', 'outdated', 'revoked']),
    revokedAt: z.string().optional(),
});
export const FileHealthReviewPreviewSchema = z.object({
    fileId: z.uuid(),
    fileName: z.string(),
    filePath: z.string().describe('Selected physical file path, admin only'),
    fileModifiedAt: z.string().optional().describe('Recorded file modification time'),
    fileSizeBytes: z.string().optional().describe('Recorded file size'),
    assessment: AudioTailAssessmentSchema.optional().describe(
        'Unmodified technical evidence; does not prove completeness',
    ),
    snapshot: Signature,
    eligible: z.boolean(),
    blockedReason: z
        .enum([
            'file-missing',
            'needs-recheck',
            'source-changed',
            'technical-failure',
            'unsupported-evidence',
        ])
        .optional(),
    findings: z.array(FileHealthReviewIssueSchema).max(20),
    history: z.array(FileHealthReviewHistorySchema).max(50),
});
export const FileHealthReviewRequestSchema = z.discriminatedUnion('action', [
    z.strictObject({ action: z.literal('preview'), fileId: z.uuid() }),
    z.strictObject({
        action: z.literal('confirm'),
        fileId: z.uuid(),
        snapshot: Signature,
        issueKeys: z.array(Signature).min(1).max(20),
        reason: z
            .string()
            .trim()
            .max(1000)
            .optional()
            .describe('Optional note for accepting the warning'),
        evidence: z
            .string()
            .trim()
            .max(2000)
            .optional()
            .describe('Optional supporting notes; no inspection claim required'),
    }),
    z.strictObject({ action: z.literal('revoke'), fileId: z.uuid(), reviewId: z.uuid() }),
]);
export const FileHealthReviewResponseSchema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('preview'), preview: FileHealthReviewPreviewSchema }),
    z.object({ action: z.literal('confirm'), reviewed: z.number().int().nonnegative() }),
    z.object({ action: z.literal('revoke'), revoked: z.boolean() }),
]);
export type FileHealthReviewPreview = z.infer<typeof FileHealthReviewPreviewSchema>;
export type FileHealthReviewHistory = z.infer<typeof FileHealthReviewHistorySchema>;
export type FileHealthReviewRequest = z.infer<typeof FileHealthReviewRequestSchema>;
