// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Top Shelf API Response Zod Schemas
 *
 * SINGLE SOURCE OF TRUTH for the tvOS Top Shelf preview/cinemagraph mint
 * endpoint response contract (`GET /api/v1/media/{id}/topshelf-preview`).
 *
 * Convention:
 * - Use .optional() for optional fields (NOT .nullable())
 * - Add .describe('...') for OpenAPI docs
 * - Export both schema and inferred type
 */

import { z } from 'zod';

export const TopShelfPreviewResponseSchema = z
    .object({
        status: z
            .enum(['ready', 'pending', 'unavailable'])
            .describe(
                'ready = at least the preview variant exists; pending = render enqueued/coalesced; ' +
                    'unavailable = no renderable source for this item.',
            ),
        previewVideoUrl: z
            .string()
            .optional()
            .describe(
                'Signed absolute-path URL for the focus preview MP4. Present when that variant is ready.',
            ),
        cinemagraphUrl: z
            .string()
            .optional()
            .describe(
                'Signed absolute-path URL for the silent looping MP4. Present when that variant is ready.',
            ),
        previewSource: z
            .enum(['trailer', 'snippet'])
            .optional()
            .describe('What the preview variant was rendered from.'),
        overlay: z
            .enum(['logo', 'text', 'none'])
            .optional()
            .describe(
                'What was burned into the returned MP4s: logo image, title text, or none ' +
                    '(client should draw its own title when overlay is "none" or absent). ' +
                    'Both preview and cinemagraph share this single resolved value.',
            ),
        expiresAt: z
            .string()
            .optional()
            .describe(
                'ISO-8601 expiry of the signed URLs (both share it). Present when any URL is returned.',
            ),
        retryAfterSeconds: z
            .number()
            .optional()
            .describe('Hint for re-polling when status=pending.'),
    })
    .meta({
        id: 'TopShelfPreviewResponse',
        description: 'tvOS Top Shelf preview/cinemagraph URLs',
    });

export type TopShelfPreviewResponse = z.infer<typeof TopShelfPreviewResponseSchema>;
