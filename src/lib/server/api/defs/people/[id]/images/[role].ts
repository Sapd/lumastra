// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * people/{id}/images/{role} — canonical image scheme.
 *
 * The {role} param is constrained to `profile` for persons.
 * Any other role returns a 404 (not a validation error — the resource just
 * doesn't exist for that role).
 *
 * ID forms accepted (N3):
 *   - Bare TMDB numeric id: "123456"
 *   - Provider-prefixed: "tmdb:123456"
 *
 * Optional query params:
 *   ?size=w45|w185|h632|original  (TMDB native size vocabulary)
 *   ?quality=1-100
 *
 * Auth: user — person artwork is proxied from TMDB; rate-limited per user.
 *
 * Class R: raw image bytes on success; problem+json on pre-stream failure.
 */

import { IMAGE_PROXY_RATE_LIMIT } from '$lib/server/middleware/valkey-rate-limit.js';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import {
    getImageProxyService,
    imageResponse,
    PersonRateLimitError,
} from '$lib/server/services/image-proxy/index.js';
import { parsePersonHandle } from '$lib/shared/person-handle.js';
import { Logger } from '$lib/server/utils/logger.js';

const PeopleImageRoleQuery = z.object({
    v: z.string().optional().describe('Opaque artwork revision; does not affect resolution.'),
    /**
     * TMDB native size vocabulary for person images.
     * Defaults to `w185` when omitted.
     * w45 = ~45 px wide (thumbnail), w185 = ~185 px wide (standard),
     * h632 = ~632 px tall (large), original = full TMDB resolution.
     */
    size: z.enum(['thumb', 'card', 'full', 'w45', 'w185', 'h632', 'original']).optional(),
    /**
     * Encode quality (1-100). Snaps to the nearest tier [50,70,85,95] within ±20%.
     * e.g. `?quality=82` → tier 85.
     */
    quality: z.coerce.number().int().min(1).max(100).optional(),
});

const logger = Logger.for('PeopleImagesRoute');

/** Parse quality from URL (1-100). */
function parseQuality(url: URL): number | undefined {
    const raw = url.searchParams.get('quality');
    if (!raw) return undefined;
    const q = parseInt(raw, 10);
    return Number.isFinite(q) && q >= 1 && q <= 100 ? q : undefined;
}

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

/**
 * Query schema for GET /people/{id}/images/{role}.
 *
 * `size`    — TMDB native size vocabulary (w45, w185, h632, original).
 * `quality` — JPEG quality 1-100.
 */
const PeopleImageQuery = z.object({
    v: z.string().optional().describe('Opaque artwork revision; does not affect resolution.'),
    size: z.enum(['thumb', 'card', 'full', 'w45', 'w185', 'h632', 'original']).optional(),
    // Coercion only; parseQuality() ignores out-of-range in the handler.
    quality: z.coerce.number().int().optional(),
});

// ownership: none — see people/[id]/images/index.ts. Provider artwork, no
// per-user dimension.
export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['People'],
            summary: 'Get a person image',
            stability: 'stable',
            auth: 'bearer',
            query: PeopleImageRoleQuery,
            description:
                'Upstream provider work is limited to 2000 requests per 60 seconds per authenticated user or 300 per anonymous client IP, shared across image routes and surfaces. Cache hits and local files do not consume the provider budget. Uncached encodes have a separate limit of 1000 per 60 seconds per authenticated user or 300 per anonymous/signed client (verified user if available, otherwise IP); cache hits are free. Anonymous and signed requests always use tiered quality, and AVIF is limited to standard size presets. ' +
                'Returns a person image by role. Only the `profile` role is supported — other ' +
                'roles return 404 (the resource simply does not exist for persons). ' +
                'Person images are sourced from TMDB; requires authentication.\n\n' +
                "**Sizing** uses TMDB's native size vocabulary (not the media-image preset system):\n\n" +
                '| `?size=` | TMDB rendition |\n' +
                '|---|---|\n' +
                '| `w45` | ~45 px wide (thumbnail) |\n' +
                '| `w185` | ~185 px wide (standard, default) |\n' +
                '| `h632` | ~632 px tall (large) |\n' +
                '| `original` | full TMDB resolution |\n\n' +
                '`?quality=Q` snaps to the nearest canonical tier [50, 70, 85, 95] within ±20%. ' +
                'Aliases thumb/card/full map to w45/w185/original. Private browser caching is one hour; bounded revisions retain the provider TTL. ' +
                'TMDB API calls are rate-limited; 429 is returned when the rate limit is exceeded.',
            responses: {
                200: {
                    binary: ['image/jpeg', 'image/webp', 'image/png'],
                    description: 'Person profile image bytes.',
                },
                422: 'Invalid person handle',
                401: 'Authentication required',
                404: 'Person not found or role not supported',
                429: 'Image request or TMDB rate limit exceeded — retry after 60 s',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'user' },
    rateLimit: IMAGE_PROXY_RATE_LIMIT,
    raw: true,
    request: {
        query: PeopleImageQuery,
    },
    handlers: {
        GET: async (event, _ctx) => {
            const { params, url, request } = event;
            const id = params.id ?? '';
            const role = (params.role ?? '').toLowerCase();

            const parsed = parsePersonHandle(id);
            if (!parsed.ok)
                return ApiProblem.validationFailed([
                    { field: 'id', message: 'Invalid person handle' },
                ]);
            const personId = String(parsed.numericId);
            if (role !== 'profile')
                return ApiProblem.notFound('People images only support role profile');

            const service = getImageProxyService();
            const requestedSize = url.searchParams.get('size') ?? 'w185';
            const size =
                ({ thumb: 'w45', card: 'w185', full: 'original' } as Record<string, string>)[
                    requestedSize
                ] ?? requestedSize;
            const quality = parseQuality(url);

            try {
                const result = await service.getPersonImage(personId, { rawSize: size, quality });
                if (!result) {
                    logger.debug('Person image not found', { id, role });
                    return ApiProblem.notFound('Person image not found');
                }
                return imageResponse(result, request, {
                    scope: 'private',
                    bounded: size !== 'original',
                });
            } catch (error) {
                if (error instanceof PersonRateLimitError) {
                    return ApiProblem.rateLimited(60, {
                        error: 'Person image rate limit exceeded',
                    });
                }
                logger.error('Failed to serve person image', error as Error, { id });
                return ApiProblem.internalError('Failed to fetch person image');
            }
        },
    },
});
