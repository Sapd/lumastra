// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { AudioTailAssessmentSchema } from './audio-tail-assessment.js';
import { AdminRangeMappingSchema } from './range-mapping-proof.js';

/** Cursor keeps PostgreSQL's six fractional digits intact. */
export const FileHealthScopeSchema = z.enum(['actionable', 'informational', 'reviewed', 'all']);
export type FileHealthScope = z.infer<typeof FileHealthScopeSchema>;
export const FileHealthCursorSchema = z
    .string()
    .max(80)
    .regex(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
    .refine((value) => {
        const timestamp = value.slice(0, 27);
        const year = Number(timestamp.slice(0, 4));
        const parsed = new Date(timestamp);
        return (
            year >= 1 &&
            Number.isFinite(parsed.getTime()) &&
            parsed.toISOString().slice(0, 23) === timestamp.slice(0, 23)
        );
    });
export const FileHealthQuerySchema = z.object({
    scope: FileHealthScopeSchema.default('actionable'),
    cursor: FileHealthCursorSchema.optional(),
});

/** Admin-only bounded projection. Unknown raw warning shapes remain actionable. */
export const AdminFileHealthIssueSchema = z.object({
    type: z.string().min(1).max(80),
    detected_at: z.string(),
    reviewed: z
        .boolean()
        .optional()
        .describe('This exact finding has a current human review; raw evidence is retained'),
    basis: z.string().max(80).optional(),
    detail: z.string().optional(),
    expected_duration: z.number().optional(),
    actual_duration: z.number().optional(),
});
export const AdminFileHealthRowSchema = z.object({
    file_id: z.string(),
    file_path: z.string(),
    duration_seconds: z.number().nullable(),
    health_issues: z.array(AdminFileHealthIssueSchema),
    classification: z.enum(['actionable', 'informational', 'reviewed']),
    updatedAt: z.string(),
    is_missing: z.boolean(),
    link_count: z.number().int().nonnegative(),
    tailAssessment: AudioTailAssessmentSchema.optional(),
    rangeMapping: AdminRangeMappingSchema.optional(),
    media_item_id: z.string().nullable(),
    title: z.string().nullable(),
    media_type: z.string().nullable(),
    year: z.number().nullable(),
});
export const FileHealthResponseSchema = z.object({
    files: z.array(AdminFileHealthRowSchema),
    /** Historic field: all recorded physical files, independent of view. */
    count: z.number().int().nonnegative(),
    recorded: z.number().int().nonnegative(),
    actionable: z.number().int().nonnegative(),
    informational: z.number().int().nonnegative(),
    reviewed: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Files whose exact current duration findings have been deliberately reviewed'),
    matching: z.number().int().nonnegative(),
    nextCursor: z.string().nullable(),
    snapshotAt: z.string(),
    scope: FileHealthScopeSchema,
});
export type FileHealthResponse = z.infer<typeof FileHealthResponseSchema>;
export type FileHealthRow = z.infer<typeof AdminFileHealthRowSchema>;
