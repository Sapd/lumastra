// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Media Annotations Schemas
 *
 * Schemas for timestamp pins, episode/movie chat, and future reviews.
 *
 * Convention:
 * - Use .optional() for optional fields (NOT .nullable())
 * - Add .meta({ description: '...' }) for OpenAPI docs
 * - Export both schema and inferred type
 */

import { z } from 'zod';
import { paginatedEnvelope } from './pagination.js';

// ─── Shared ───────────────────────────────────────────────────────────────────

export const annotationTypeSchema = z.enum(['chat', 'pin', 'review']);

export const annotationDataSchema = z
    .object({
        id: z.string().guid(),
        media_id: z.string().guid(),
        username: z.string(),
        type: annotationTypeSchema,
        content: z.string(),
        timestamp_seconds: z.number().nullable().optional(),
        created_at: z.string(),
    })
    .meta({ id: 'annotationData' });

export type AnnotationType = z.infer<typeof annotationTypeSchema>;
export type AnnotationData = z.infer<typeof annotationDataSchema>;

// ─── Request bodies ───────────────────────────────────────────────────────────

export const createAnnotationSchema = z
    .object({
        type: annotationTypeSchema,
        content: z
            .string()
            .min(1, 'Content is required')
            .transform((s) => s.trim()),
        timestamp_seconds: z.number().positive().optional(),
    })
    .refine(
        (data) => {
            if (data.type === 'pin' && data.timestamp_seconds === undefined) {
                return false;
            }
            if (data.type !== 'pin' && data.timestamp_seconds !== undefined) {
                return false;
            }
            return true;
        },
        {
            message: 'timestamp_seconds is required for pins and forbidden for chat/review',
        },
    )
    .refine(
        (data) => {
            const maxLen = data.type === 'pin' ? 200 : data.type === 'review' ? 1000 : 500;
            return data.content.length <= maxLen;
        },
        { message: 'Content too long' },
    )
    .meta({ id: 'createAnnotation' });

export const annotationQuerySchema = z
    .object({
        type: annotationTypeSchema.optional(),
        limit: z.coerce.number().int().min(1).max(100).optional().default(50),
    })
    .meta({ id: 'annotationQuery' });

export type CreateAnnotation = z.infer<typeof createAnnotationSchema>;
export type AnnotationQuery = z.infer<typeof annotationQuerySchema>;

// ─── Responses ────────────────────────────────────────────────────────────────

// GET returns the canonical `{ items, page }` pagination envelope (the shape
// the server's `paginate()` helper produces). POST returns the bare created
// annotation (201). These must match the def in
// `$lib/server/api/defs/catalog/media-id-annotations.ts`.
export const annotationsListResponseSchema = paginatedEnvelope(annotationDataSchema).meta({
    id: 'annotationsListResponse',
});

export const annotationCreatedResponseSchema = annotationDataSchema;

export type AnnotationsListResponse = z.infer<typeof annotationsListResponseSchema>;
export type AnnotationCreatedResponse = z.infer<typeof annotationCreatedResponseSchema>;

// ─── User preferences ─────────────────────────────────────────────────────────

export const annotationPreferencesSchema = z.object({
    show_annotation_markers: z.boolean().default(true),
    auto_show_annotations: z.boolean().default(true),
});

export type AnnotationPreferences = z.infer<typeof annotationPreferencesSchema>;
