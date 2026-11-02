// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Media Annotations Types
 *
 * Types are re-exported from Zod schemas in '$lib/schemas/media-annotations'.
 */

export type {
    AnnotationType,
    AnnotationData,
    CreateAnnotation,
    AnnotationQuery,
    AnnotationsListResponse,
    AnnotationCreatedResponse,
    AnnotationPreferences,
} from '$lib/schemas/media-annotations';
