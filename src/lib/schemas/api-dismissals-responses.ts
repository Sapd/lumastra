// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Continue-Watching Dismissals API — Zod schemas
 *
 * Request and response shapes for `/api/continue-watching/dismissals`.
 * One flag_type (`dismissed_cw`) is handled here; the backing table
 * (`user_media_flags`) is designed to host additional flag types later
 * without reshaping this endpoint.
 *
 * Convention:
 * - `.optional()` for optional fields (Swift compat).
 * - `.describe(...)` so OpenAPI generation picks up human-readable docs.
 * - Export both schema and inferred type.
 */

import { z } from 'zod';

// ============================================================================
// Shared enums
// ============================================================================

/**
 * Legacy dismissal targets for For-You flags.
 */
export const DismissalTargetTypeSchema = z
    .enum(['series', 'movie'])
    .describe('Dismissal target kind');

/**
 * Kinds of entity a Continue-Watching dismissal can point at. Episodes
 * dismiss at the series level; movies and audiobooks dismiss themselves.
 */
export const CwDismissalTargetTypeSchema = z
    .enum(['series', 'movie', 'audiobook'])
    .describe('Dismissal target kind');

export type DismissalTargetType = z.infer<typeof CwDismissalTargetTypeSchema>;

// ============================================================================
// Request bodies
// ============================================================================

/**
 * Body for POST and DELETE. Reused across both verbs: DELETE carries a
 * body (rather than query params) so the shape mirrors POST exactly and
 * clients can reuse the same serializer.
 */
export const DismissalRequestBodySchema = z
    .object({
        targetId: z.string().guid().describe('Internal media_items UUID to dismiss or un-dismiss'),
        targetType: CwDismissalTargetTypeSchema,
    })
    .meta({
        id: 'DismissalRequestBody',
        description: 'Dismiss / un-dismiss a Continue-Watching item',
    });

export type DismissalRequestBody = z.infer<typeof DismissalRequestBodySchema>;

// ============================================================================
// Response shapes
// ============================================================================

/**
 * Mutation response (POST / DELETE).
 */
export const DismissalMutationResponseSchema = z
    .object({
        success: z.literal(true).describe('Always true on a 2xx response'),
    })
    .meta({
        id: 'DismissalMutationResponse',
        description: 'POST/DELETE success envelope for dismissals',
    });

export type DismissalMutationResponse = z.infer<typeof DismissalMutationResponseSchema>;

/**
 * Shape of a single dismissed item on the list endpoint. Enough metadata
 * to render a card on `/my/hidden` without a follow-up round trip.
 *
 * `images` is the canonical self-describing href map (contract: never flat posterUrl).
 */
export const DismissedItemSchema = z
    .object({
        targetId: z.string().guid().describe('Internal media_items UUID of the dismissed entity'),
        targetType: CwDismissalTargetTypeSchema,
        title: z.string().describe('Display title of the dismissed media'),
        images: z
            .object({
                poster: z.object({ href: z.string() }).optional(),
            })
            .optional()
            .describe('Self-describing image hrefs'),
        dismissedAt: z.string().describe('ISO 8601 timestamp when the dismissal was recorded'),
    })
    .meta({
        id: 'DismissedItem',
        description: 'A single dismissed Continue-Watching item',
    });

export type DismissedItem = z.infer<typeof DismissedItemSchema>;

/**
 * Response for GET. A bare object with an `items` array keeps the door
 * open for pagination metadata later without a breaking shape change.
 */
export const DismissedItemsResponseSchema = z
    .object({
        items: z
            .array(DismissedItemSchema)
            .describe('All items the user has hidden from Continue Watching'),
    })
    .meta({
        id: 'DismissedItemsResponse',
        description: "Listing of all of the user's CW dismissals",
    });

export type DismissedItemsResponse = z.infer<typeof DismissedItemsResponseSchema>;
