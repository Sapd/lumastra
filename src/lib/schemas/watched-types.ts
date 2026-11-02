// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Watched Items Types - Zod Schemas
 *
 * Schemas for user's watched/completed media items.
 *
 * Convention:
 * - All property names use camelCase
 * - Database columns (snake_case) are transformed at the server boundary
 * - Use .optional() for optional fields (NOT .nullable())
 * - Add .meta({ description: '...' }) for OpenAPI docs
 * - Export both schema and inferred type
 */

import { z } from 'zod';
import { ExternalIdsResponseSchema } from './api-responses';

// ============================================================================
// Watched Item Response
// ============================================================================

/**
 * API response format for a watched item
 */
export const WatchedItemResponseSchema = z
    .object({
        /** External IDs from various providers */
        externalIds: ExternalIdsResponseSchema.describe('External provider IDs'),
        /** Media type — canonical `series`, never the stored `tv`. */
        // Was pinned to ['movie','tv'] because the handler emitted the raw
        // stored token; the handler now canonicalises, so this matches the
        // file header's long-standing (previously false) promise.
        mediaType: z.enum(['movie', 'series']).describe('Media type'),
    })
    .meta({ description: 'Watched item response' });

export type WatchedItemResponse = z.infer<typeof WatchedItemResponseSchema>;

// ============================================================================
// Watched Items Data
// ============================================================================

/**
 * Response from GET /api/watched
 */
export const WatchedItemsDataSchema = z
    .object({
        /** List of watched items */
        watchedItems: z.array(WatchedItemResponseSchema).describe('Watched items'),
        /** Whether data was served from cache */
        cached: z.boolean().optional().describe('Served from cache'),
    })
    .meta({ description: 'Watched items API response' });

export type WatchedItemsData = z.infer<typeof WatchedItemsDataSchema>;
