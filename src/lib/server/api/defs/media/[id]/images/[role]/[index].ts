// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * media/{id}/images/{role}/{index} — §7.1 Nth image for a role.
 *
 * {index} is a zero-based integer. Index 0 is identical to
 * media/{id}/images/{role}. Indices > 0 return 404 because the current image
 * proxy serves one canonical image per role (the listing endpoint exposes
 * count=1). When a future provider exposes multi-image arrays the count and
 * route will be updated together.
 *
 * This route intentionally delegates to the existing single-image handler
 * logic so auth, signed-URL verification, resize params, and fallback
 * behaviour are identical. We do NOT import the sibling def to avoid a
 * circular dependency — the handler is inlined with the same contract.
 *
 * Auth: public — same as media/{id}/images/{role}.
 * Class R: raw image bytes on success; problem+json on pre-stream failure.
 */

import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { def as roleDef } from '../[role].js';

const ImageIndexQuerySchema = z.object({
    inherit: z.enum(['none']).optional().describe('Only own artwork; 404 if absent.'),
    v: z.string().optional().describe('Opaque artwork revision; does not affect resolution.'),
    externalId: z.string().optional().meta({
        description: 'Composite external ID alias (e.g. tmdb:603:movie) — used instead of {id}',
    }),
    width: z.coerce.number().int().optional().meta({
        description: 'Snaps to nearest preset within ±20%; fixed width bucket otherwise',
    }),
    size: z
        .enum(['thumb', 'medium', 'card', 'hd', 'wide', 'full'])
        .optional()
        .meta({ description: 'Named size preset — canonical, immutable-cached' }),
    quality: z.coerce.number().int().optional().meta({
        description: 'Snaps to tier [50,70,85,95] within ±20%',
    }),
    format: z
        .enum(['webp', 'avif', 'jpg', 'png'])
        .optional()
        .meta({ description: 'Output image format' }),
    sig: z.string().optional().meta({ description: 'Signed-URL verification signature' }),
    fallback: z.string().optional().meta({ description: 'Fallback image URL on miss' }),
});

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

/**
 * Query schema mirrors media/{id}/images/{role} — the contract layer
 * accepts the same image params (externalId, width, size, quality, format, sig,
 * fallback) and passes them through to the delegated handler.
 */
const ImageIndexQuery = z.object({
    inherit: z.enum(['none']).optional().describe('Only own artwork; 404 if absent.'),
    v: z.string().optional().describe('Opaque artwork revision; does not affect resolution.'),
    externalId: z.string().optional(),
    // Coercion only; the delegated [role] handler clamps width/quality.
    width: z.coerce.number().int().optional(),
    size: z.enum(['thumb', 'medium', 'card', 'hd', 'wide', 'full']).optional(),
    quality: z.coerce.number().int().optional(),
    format: z.enum(['webp', 'avif', 'jpg', 'png']).optional(),
    sig: z.string().optional(),
    fallback: z.string().optional(),
});

/**
 * Parse {index} — must be a non-negative integer.
 * Returns null when the value is not a valid index.
 */
function parseIndex(raw: string): number | null {
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
}

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Media'],
            summary: 'Get the Nth image for a media role',
            stability: 'stable',
            auth: 'none',
            description:
                'Internal UUID artwork stays public; external provider handles require authentication and library/age access. Returns the image at `{index}` for the given `{role}` (e.g. `poster`, `backdrop`, `logo`). ' +
                'Index 0 is the primary image. Most media items have only one image per role (index 0). ' +
                'For the primary image, prefer `GET /api/v1/media/{id}/images/{role}` (no `/{index}`).\n\n' +
                'Accepts the same sizing params as the primary image endpoint:\n' +
                '`?size=thumb|medium|card|full` (named preset — canonical, immutable-cached), ' +
                '`?width=N` (snaps to nearest preset within ±20%; fixed width bucket otherwise), ' +
                '`?quality=Q` (snaps to tier [50,70,85,95] within ±20%), ' +
                '`?exact=true` (bypass preset/quality snapping; fixed width buckets still apply), `?format=webp|avif|jpg|png`. ' +
                'Named presets and snapped widths are served `immutable`; custom/exact derivatives are max-age cached.',
            query: ImageIndexQuerySchema,
            responses: {
                200: {
                    binary: ['image/jpeg', 'image/webp', 'image/avif', 'image/png'],
                    description: 'Image bytes',
                },
                400: 'Invalid role, index, or resize params',
                401: 'Authentication required for external provider handles',
                404:
                    'Media not found, or index out of range for this role. Browsers instead ' +
                    'receive the placeholder image bytes with 200; native clients get this 404.',
                429: 'Image request budget exceeded',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'public' },
    rateLimit: roleDef.rateLimit,
    raw: true,
    request: {
        query: ImageIndexQuery,
    },
    handlers: {
        GET: async (event, ctx) => {
            const { params } = event;
            const rawIndex = params.index ?? '0';
            const index = parseIndex(rawIndex);

            if (index === null) {
                return ApiProblem.validationFailed([
                    {
                        field: 'index',
                        message: `Invalid image index "${rawIndex}". Must be a non-negative integer.`,
                    },
                ]);
            }

            // Only index 0 is served — the proxy has one canonical image per role.
            if (index > 0 && event.params.role !== 'backdrop') {
                return ApiProblem.notFound(
                    `Image index ${index} not available. This role has only 1 image (index 0).`,
                );
            }

            // Delegate to the single-image handler (index 0 === /{role}).
            const roleHandler = roleDef.handlers.GET;
            if (!roleHandler) {
                return ApiProblem.internalError('Image handler not available');
            }
            return roleHandler(event, ctx);
        },
    },
});
