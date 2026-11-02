// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * API List Response Zod Schemas
 *
 * SINGLE SOURCE OF TRUTH for curated list API response types.
 * These schemas define the contract for /api/lists/* endpoints.
 *
 * Convention:
 * - Use .optional() for optional fields (NOT .nullable())
 * - Add .describe('...') for OpenAPI docs
 * - Export both schema and inferred type
 */

import { z } from 'zod';
import { MediaRatingsSchema } from './api-media-responses';

// ============================================================================
// List Metadata Schema (GET /api/lists)
// ============================================================================

/**
 * Curated list metadata item — matches toListItem() output from defs/lists/index.ts.
 * Fields are camelCase (server converts from snake_case DB columns).
 */
export const ListMetadataSchema = z
    .object({
        /** List slug identifier */
        id: z.string().describe('List slug ID'),
        /** Display name */
        name: z.string().describe('List name'),
        /** Description */
        description: z.string().optional().describe('Description'),
        /** Source provider (mdblist, etc.) */
        source: z.string().optional().describe('Source provider'),
        /** Source list path */
        listPath: z.string().optional().describe('Source list path'),
        /** Number of items in list */
        itemCount: z.number().int().optional().describe('Item count'),
        /** Last sync timestamp (ISO 8601 or null) */
        lastSyncedAt: z.string().nullable().optional().describe('Last synced'),
    })
    .meta({ id: 'ListMetadata', description: 'Curated list metadata item (camelCase)' });

export type ListMetadata = z.infer<typeof ListMetadataSchema>;

/**
 * Lists index response (GET /api/lists) — new contract: { items, page, syncing?, cached? }.
 * Replaces the old { lists, syncing, cached } shape.
 */
export const ListsIndexResponseSchema = z
    .object({
        /** Curated list metadata items */
        items: z.array(ListMetadataSchema).describe('List metadata items'),
        /** Pagination block */
        page: z
            .object({
                limit: z.number().int(),
                offset: z.number().int().optional(),
                hasMore: z.boolean(),
                total: z.number().int().optional(),
            })
            .describe('Pagination info'),
        /** Whether a background sync is in progress */
        syncing: z.boolean().optional().describe('Background sync in progress'),
        /** Whether data was served from cache */
        cached: z.boolean().optional().describe('Served from cache'),
    })
    .meta({
        id: 'ListsIndexResponse',
        description: 'Lists index response ({items,page} envelope)',
    });

export type ListsIndexResponse = z.infer<typeof ListsIndexResponseSchema>;

// ============================================================================
// List Item Schema (GET /api/lists/[list_id])
// ============================================================================

/**
 * Enriched list item — matches enrichedItems built by defs/lists/[id].ts.
 * Server emits the canonical `type` discriminator ('series', never raw 'tv'/
 * sonarr/radarr) and a flat `posterUrl` (matching GET /media/{id}).
 */
export const ListItemSchema = MediaRatingsSchema.extend({
    /** Internal UUID (null when not in local library) */
    id: z.string().nullable().optional().describe('Internal UUID'),
    /** External ID map (internal + primary provider) */
    externalIds: z
        .object({ internal: z.string().nullable().optional() })
        .catchall(z.string())
        .optional()
        .describe('External provider IDs'),
    /** Canonical media type discriminator ('movie' | 'series' | 'episode') */
    type: z.enum(['movie', 'series', 'episode']).describe('Media type'),
    /** Display title */
    title: z.string().optional().describe('Display title'),
    /** Overview/description */
    overview: z.string().optional().describe('Overview'),
    /** Genre names or IDs */
    genres: z
        .union([z.array(z.string()), z.array(z.number())])
        .optional()
        .describe('Genres'),
    /** Best available rating (0-10) */
    rating: z.number().optional().describe('Best available rating'),
    /** Rating source */
    ratingSource: z.string().optional().describe('Rating source'),
    /** Whether item is trending */
    trending: z.boolean().optional().describe('Is trending'),
    /** Source of trending data */
    trendingSource: z.string().optional().describe('Trending source'),
    /** Rank position in list (1-indexed) */
    rank: z.number().optional().describe('Rank position'),
    /** Release year */
    year: z.number().optional().describe('Release year'),
    /** Whether available in library */
    isAvailable: z.boolean().describe('Available in library'),
    /** Whether item can be requested */
    canRequest: z.boolean().describe('Can be requested'),
    /** Poster image proxy URL (flat; server uses getCatalogPosterUrl or /api/image proxy) */
    posterUrl: z.string().optional().describe('Poster URL'),
}).meta({
    id: 'ListItem',
    description: 'Enriched curated list item with ratings and availability',
});

export type ListItem = z.infer<typeof ListItemSchema>;

/**
 * List items response (GET /api/lists/[list_id]) — bare object, new contract.
 * Server returns { id, items, page, debug? } — no success wrapper.
 */
export const ListItemsResponseSchema = z
    .object({
        /** List slug identifier */
        id: z.string().describe('List ID'),
        /** Enriched items */
        items: z.array(ListItemSchema).describe('List items'),
        /** Pagination block */
        page: z
            .object({
                limit: z.number().int(),
                offset: z.number().int(),
                hasMore: z.boolean(),
            })
            .describe('Pagination info'),
        /** Debug diagnostics (present when debug=true) */
        debug: z
            .object({
                originalCount: z.number(),
                afterDedup: z.number(),
                duplicatesRemoved: z.number(),
                duplicates: z.array(z.unknown()),
            })
            .optional()
            .describe('Debug info'),
    })
    .meta({
        id: 'ListItemsResponse',
        description: 'List items response (bare object, no success wrapper)',
    });

export type ListItemsResponse = z.infer<typeof ListItemsResponseSchema>;

// ============================================================================
// Curated lists — OpenAPI doc schemas for GET/POST /api/v1/lists
// ============================================================================
//
// Relocated verbatim from the deleted colocated `_openapi.ts` when the route's
// doc metadata moved into `defs/lists/index.ts` as `def.docs`. These are the
// EXACT inline schemas the published spec emits for /api/v1/lists — kept as
// bare `z.object()`s (no `.meta({ id })`) so they serialise INLINE, distinct
// from the `.meta`-tagged `ListsIndexResponseSchema` above (which emits a
// component `$ref`). `CuratedListsResponseSchema` is also consumed by the
// route's contract test.

const CuratedListSchema = z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable().optional(),
    source: z.string().meta({ description: 'List source (e.g. "mdblist")' }),
    listPath: z.string().meta({ description: 'Provider-relative path identifying the list' }),
    itemCount: z.number().int().optional(),
    lastSyncedAt: z
        .string()
        .nullable()
        .optional()
        .meta({ description: 'ISO timestamp of the last successful sync, or null' }),
});

export const CuratedListsResponseSchema = z.object({
    items: z.array(CuratedListSchema),
    page: z.object({ limit: z.number().int(), offset: z.number().int(), hasMore: z.boolean() }),
    syncing: z
        .boolean()
        .optional()
        .meta({ description: 'True if a sync is currently in progress' }),
    cached: z
        .boolean()
        .optional()
        .meta({ description: 'True if the response was served from cache' }),
});

export const CuratedListSyncResponseSchema = z.object({
    accepted: z.boolean(),
});
