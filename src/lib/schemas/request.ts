// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Zod schemas for media request API routes
 *
 * Covers Jellyseerr request redirects and related endpoints
 */

import { z } from 'zod';
import { mediaTypeSchema, nonEmptyStringSchema, externalIdsSchema } from './common';
import { isMovie, isSeries } from '$lib/shared/media-types';

// ============================================================================
// Request Redirect
// ============================================================================

/**
 * Query params for request redirect endpoint
 *
 * Supports two formats:
 * 1. Composite key: id=provider:externalId:mediaType (e.g., "tmdb:550:movie")
 * 2. Simple format: id=provider:externalId&mediaType=movie
 */
export const requestRedirectQuerySchema = z
    .object({
        id: nonEmptyStringSchema,
        mediaType: mediaTypeSchema.optional(),
    })
    .refine(
        (data) => {
            // If id contains 3 parts (composite key), mediaType is not required
            const parts = data.id.split(':');
            if (parts.length === 3) {
                return true;
            }
            // Otherwise, mediaType must be provided
            return !!data.mediaType;
        },
        {
            message: 'mediaType is required when using simple id format (provider:id)',
            path: ['mediaType'],
        },
    );

export type RequestRedirectQuery = z.infer<typeof requestRedirectQuerySchema>;

/**
 * Parsed request redirect info
 */
export interface ParsedRequestRedirect {
    provider: string;
    externalId: string;
    mediaType: 'movie' | 'tv';
}

/**
 * Helper to parse request redirect query
 */
export function parseRequestRedirect(query: RequestRedirectQuery): ParsedRequestRedirect | null {
    const parts = query.id.split(':');

    if (parts.length === 3) {
        // Composite key format: provider:id:mediaType
        const [provider, externalId, mediaType] = parts;
        if (!isMovie(mediaType) && !isSeries(mediaType)) {
            return null;
        }
        return {
            provider,
            externalId,
            mediaType: (isSeries(mediaType) ? 'tv' : 'movie') as 'movie' | 'tv',
        };
    }

    if (parts.length === 2 && query.mediaType) {
        // Simple format: provider:id with mediaType param
        const [provider, externalId] = parts;
        return { provider, externalId, mediaType: query.mediaType };
    }

    return null;
}

// ============================================================================
// Request Status
// ============================================================================

/**
 * Request status values
 */
export const requestStatusSchema = z.enum([
    'pending',
    'approved',
    'declined',
    'available',
    'processing',
    'failed',
    'unavailable',
]);

export type RequestStatus = z.infer<typeof requestStatusSchema>;

/**
 * Season request status
 */
export const seasonRequestStatusSchema = z.object({
    seasonNumber: z.number().int().min(0),
    isRequested: z.boolean(),
    isAvailable: z.boolean(),
    requestStatus: requestStatusSchema.optional(),
});

export type SeasonRequestStatus = z.infer<typeof seasonRequestStatusSchema>;

// ============================================================================
// Request Status Check (POST /api/request/status)
// ============================================================================

/**
 * Single request status query item
 *
 * `mediaType` accepts only movie and series.
 * The underlying service normalises both via `isSeries()`.
 */
export const requestStatusQueryItemSchema = z.object({
    externalIds: externalIdsSchema,
    mediaType: z.enum(['movie', 'series']),
    seasons: z.array(z.number().int().min(0)).optional(),
});

/**
 * Request status check body - array of requests to check
 */
export const requestStatusBodySchema = z.object({
    requests: z.array(requestStatusQueryItemSchema).min(1).max(20),
});

export type RequestStatusBody = z.infer<typeof requestStatusBodySchema>;

// ============================================================================
// Request Dismiss (POST /api/request/dismiss)
// ============================================================================

/**
 * Dismiss request body — requires at least one usable external ID so the
 * server never has to compute a non-deterministic fallback composite key.
 */
export const dismissRequestBodySchema = z
    .object({
        externalIds: externalIdsSchema,
        mediaType: z.enum(['movie', 'series']),
    })
    .refine(
        (b) =>
            Object.values(b.externalIds ?? {}).some((v) => typeof v === 'string' && v.length > 0),
        {
            message: 'At least one external ID is required',
            path: ['externalIds'],
        },
    );

export type DismissRequestBody = z.infer<typeof dismissRequestBodySchema>;

// ============================================================================
// Create Request (POST /api/request)
// ============================================================================

/**
 * Create media request body
 */
export const createRequestBodySchema = z.object({
    externalIds: externalIdsSchema,
    mediaType: z.enum(['movie', 'series']),
    seasons: z
        .array(z.number().int().min(1))
        .max(50)
        .transform((arr) => [...new Set(arr)])
        .optional(),
});

export type CreateRequestBody = z.infer<typeof createRequestBodySchema>;
