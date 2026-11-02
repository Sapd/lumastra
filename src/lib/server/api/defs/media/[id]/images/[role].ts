// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * media/{id}/images/{role} — canonical media image endpoint.
 *
 * ID forms accepted:
 *   - Internal UUID: 550e8400-e29b-41d4-a716-446655440000
 *   - Composite key: tmdb:603:movie
 *   - ?externalId=tmdb:603:movie (query param form, preferred in <img> src)
 *
 * Role values: poster | backdrop | logo | still | primary | banner | thumb
 *
 * Optional query params (same across all image routes):
 *   ?size=thumb|medium|card|full   named preset — the CANONICAL, cache-friendly
 *                                  request form (bounded sizes with v are served immutable).
 *   ?width=<n>         pixel cap (clamped [1, 3840]). SNAPS when the nearest
 *                      preset is within ±20%, onto the smallest qualifying
 *                      preset that COVERS the request (→ that preset's immutable
 *                      cache entry); otherwise rounds up to a fixed width bucket. Covering,
 *                      not nearest, so a caller is never handed fewer pixels
 *                      than it asked for — downscaling is free, upscaling shows.
 *   ?quality=1-100     snaps to the nearest tier [50,70,85,95] within ±20%.
 *   ?exact=true        bypass preset/quality snaps; width buckets still apply.
 *   ?format=webp|avif|jpg|png
 *   ?sig=<hmac>        signed-URL credential (alternate to Bearer)
 *   ?fallback=none     suppress placeholder redirect on missing image
 *   ?path=<provider-path>  direct provider image path — an optimisation that
 *                      skips the provider API lookup. Only meaningful with a
 *                      composite key whose still/poster path the caller already
 *                      holds (e.g. a TMDB episode listing).
 *
 * Auth: internal UUID artwork stays public. External handles require a user
 * and library/age access before resolution or image delivery; `?sig=` is the alternate
 * credential for contexts where Bearer is unavailable (e.g. <img> src in
 * WebViews). The library/age access gate fires ONLY when `locals.user` is
 * present, returning 404 on failure to avoid existence leaks.
 *
 * On the `/api/v1` surface, forward-auth (see forward-auth.ts, security review
 * 2026-09-12 C10) parses any Bearer/`?api_key=`/`stream_token` credential the
 * request DOES present before reaching this handler, so `locals.user` is
 * populated and the access gate above runs whenever a real credential is
 * given. A request with `?sig=` or with NO credential at all is exempted from
 * that parsing and reaches here anonymously — for those, the access gate is a
 * no-op (no `locals.user`) and the response is artwork bytes only: an
 * internal UUID with no accompanying credential can read that item's image,
 * but never any other field of the media item. This is a deliberate,
 * documented trade-off (UUIDs are not enumerable) — do not read it as a bug.
 *
 * Class R: raw image bytes on success; problem+json on pre-stream failure.
 */

import { PROVIDER_IMAGE_PATH, isProviderImagePath } from '$lib/server/utils/provider-image-path.js';
import { IMAGE_PROXY_RATE_LIMIT } from '$lib/server/middleware/valkey-rate-limit.js';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { noImageResponse, imageClientType } from '$lib/server/utils/placeholder-image.js';

import { getImageProxyService, imageResponse } from '$lib/server/services/image-proxy/index.js';
import type { ImageType } from '$lib/server/services/image-proxy/types.js';
import {
    resolveExternalArtworkAccess,
    fetchExternalArtwork,
} from '$lib/server/utils/external-artwork-access.js';
import { parseMediaId } from '$lib/server/utils/media-key-parser.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { getDb } from '$lib/server/database/index.js';
import { verifySignedUrl } from '$lib/server/utils/signed-url.js';
import { Logger } from '$lib/server/utils/logger.js';
import { resolvePublicImageOptions } from '$lib/server/utils/image-params.js';
import { VALID_IMAGE_TYPES, isValidImageType } from '$lib/server/utils/image-validation.js';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';

const MediaImageRoleQuery = z.object({
    inherit: z
        .enum(['chain', 'none'])
        .optional()
        .describe(
            '`none`: only serve own artwork, 404 if absent. `chain` (default): walk the documented fallback chain.',
        ),
    v: z.string().optional().describe('Opaque artwork revision; does not affect resolution.'),
    /**
     * Named size preset — the CANONICAL sizing form.
     * Bounded presets with v are immutable-cached within max-age.
     * Preset widths: thumb=250px, medium=350px, card=480px, hd=1280px,
     * wide=1920px. The wide presets (`hd`, `wide`) are intended for full-bleed
     * backdrops / hero sections. `full` returns the original image without any
     * resize.
     */
    size: z.enum(['thumb', 'medium', 'card', 'hd', 'wide', 'full']).optional(),
    /**
     * Custom pixel width cap (integer, clamped [1, 3840]).
     * When the nearest named preset is within ±20%, the request snaps onto the
     * smallest qualifying preset that is at least as wide (e.g. `?width=460` →
     * `card`, `?width=300` → `medium`) and gets that preset's immutable cache
     * entry. Covering rather than nearest: a request never comes back with
     * fewer pixels than it asked for. Outside all snap bands: a distinct custom
     * derivative rounded up to 250, 350, 480, 768, 1280, 1920, 2560 or 3840 px (max-age cached only).
     * Takes precedence over `?size=` when both are present.
     */
    width: z.coerce.number().int().min(1).max(3840).optional(),
    /**
     * JPEG/WebP/AVIF encode quality (1-100).
     * Snaps to the nearest canonical tier [50, 70, 85, 95] when within ±20%.
     * e.g. `?quality=82` → tier 85. Use `?exact=true` to bypass snapping.
     */
    quality: z.coerce.number().int().min(1).max(100).optional(),
    /**
     * Output format override. Omit to let the server negotiate (AVIF for
     * AVIF-capable clients when enabled, WebP otherwise).
     */
    format: z.enum(['webp', 'avif', 'jpg', 'png']).optional(),
    /**
     * Bypass preset and quality snapping. Widths still round up to fixed buckets. Forces a custom
     * derivative with its own cache entry. Never `immutable`.
     * Discouraged for production use — fragments the derivative cache.
     */
    exact: z.enum(['true', '1', 'yes', 'false', '0', 'no']).optional(),
    /** HMAC signed-URL credential for contexts where Bearer is unavailable (e.g. `<img src="…">`). */
    sig: z.string().optional(),
    /** Set to `none` to suppress the fallback placeholder redirect when the image is missing. */
    fallback: z.string().optional(),
    /** Single provider filename /[A-Za-z0-9]+.(jpg|png|webp|svg); skips the provider API lookup. */
    path: z.string().regex(PROVIDER_IMAGE_PATH).optional(),
    /** Composite external ID alias, e.g. `tmdb:603:movie`. */
    externalId: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Request query contract
// ---------------------------------------------------------------------------

/**
 * Query params accepted by GET /media/{id}/images/{role}.
 *
 * All values arrive as strings from URLSearchParams. The handler performs its
 * own fine-grained parsing (parseImageSize, parseQuality, etc.) — these schemas
 * only gate on field *type* (string) and obvious bounds, never on the rich
 * semantic validation that the handler does.
 *
 * Lenient: unknown params are stripped; no .strict(). The handler reads
 * `event.url.searchParams` directly (not ctx.input.query) to keep image-param
 * parsing in one place, so these schemas are a documentation + early-reject
 * layer for obviously wrong inputs.
 */
const ImageRoleQuery = z.object({
    inherit: z
        .enum(['chain', 'none'])
        .optional()
        .describe(
            '`none`: only serve own artwork, 404 if absent. `chain` (default): walk the documented fallback chain.',
        ),
    v: z.string().optional().describe('Opaque artwork revision; does not affect resolution.'),
    /** Composite external ID alias (e.g. `tmdb:603:movie`). */
    externalId: z.string().optional(),
    /** Pixel width cap — coercion only; parseMaxWidth() clamps [1, 3840] in the handler. */
    width: z.coerce.number().int().optional(),
    /** Backward-compat alias for `width` — coercion only; clamped by the handler. */
    maxWidth: z.coerce.number().int().optional(),
    /** Named size preset: thumb | medium | card | hd | wide | full. */
    size: z.enum(['thumb', 'medium', 'card', 'hd', 'wide', 'full']).optional(),
    /** JPEG/WebP quality — coercion only; parseQuality() clamps/ignores out-of-range in the handler. */
    quality: z.coerce.number().int().optional(),
    /** Requested output format. */
    format: z.enum(['webp', 'avif', 'jpg', 'png']).optional(),
    /**
     * Bypass preset + quality snapping — render a width-bucketed derivative
     * as a custom (non-immutable) derivative. Widths still round up to fixed buckets. Accepts true|1|yes.
     */
    exact: z.enum(['true', '1', 'yes', 'false', '0', 'no']).optional(),
    /** HMAC signed-URL credential for contexts where Bearer is unavailable. */
    sig: z.string().optional(),
    /** Set to `none` to suppress fallback redirect on missing image. */
    fallback: z.string().optional(),
    /** Single provider filename /[A-Za-z0-9]+.(jpg|png|webp|svg); skips the provider API lookup. */
    path: z.string().regex(PROVIDER_IMAGE_PATH).optional(),
});

const logger = Logger.for('MediaImagesRoute');

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Media'],
            summary: 'Get a media image',
            stability: 'stable',
            auth: 'none',
            query: MediaImageRoleQuery,
            description:
                'Returns a media image by role (`poster`, `backdrop`, `logo`, `thumb`, `still`, `banner`). ' +
                'Internal UUID artwork is public. External provider handles require authentication and library/age access. Upstream provider work is limited to 2000 requests per 60 seconds per authenticated user or 300 per anonymous client IP, shared across image routes and surfaces. Cache hits and local files do not consume the provider budget. Uncached encodes have a separate limit of 1000 per 60 seconds per authenticated user or 300 per anonymous/signed client (verified user if available, otherwise IP); cache hits are free. Anonymous and signed requests always use tiered quality, and AVIF is limited to standard size presets. ' +
                'An image URL is a capability for that image; only hand it to users allowed to see it. ' +
                '`?sig=<hmac>` is the alternate credential for `<img>` embeds and WebViews where ' +
                'Bearer headers are unavailable. A library/age access gate fires when a session is ' +
                'present and returns 404 (not 403) to avoid existence leaks. A request with a real ' +
                'credential (Bearer) always gets that gate; a request with ' +
                '`?sig=` or with NO credential at all is anonymous and, for an internal UUID, serves ' +
                'artwork ONLY — no other field of the media item is ever exposed to it.\n\n' +
                '`v` is an opaque revision and does not change resolution. Without `v`, responses use ' +
                '`public, max-age=3600, stale-while-revalidate=86400` with ETag. ' +
                '`inherit=none` serves only the item own artwork and returns 404 when absent.\n\n' +
                '**Sizing — use named presets for best cache efficiency:**\n\n' +
                '| Param | Effect | Cache |\n' +
                '|---|---|---|\n' +
                '| `?size=thumb` | 250 px wide | `immutable` with `v` |\n' +
                '| `?size=medium` | 350 px wide | `immutable` with `v` |\n' +
                '| `?size=card` | 480 px wide | `immutable` with `v` |\n' +
                '| `?size=full` | original (no resize) | max-age only |\n' +
                '| `?width=N` (within ±20% of a preset) | snapped to that preset | `immutable` with `v` |\n' +
                '| `?width=N` (outside all presets) | rounded up to a fixed width bucket | max-age only |\n' +
                '| `?exact=true&width=N` | fixed width bucket, no preset snap | max-age only |\n\n' +
                'Quality: `?quality=Q` snaps to the nearest canonical tier [50, 70, 85, 95] when ' +
                'within ±20%. Use `?exact=true` to bypass preset and quality snapping; width buckets still apply. ' +
                'Custom widths round up to 250, 350, 480, 768, 1280, 1920, 2560 or 3840 px, including with `exact=true`. Exact and custom derivatives are cached normally (stale-while-revalidate) but ' +
                'never `immutable` — avoid them in production to keep the derivative cache small.\n\n' +
                '**Format negotiation:** omit `?format=` and the server serves AVIF to clients ' +
                'that send `Accept: image/avif` (when AVIF is enabled), WebP otherwise. ' +
                '`Vary: Accept, Save-Data` is always present. ' +
                'Clients that send `Save-Data: on` receive a one-tier smaller size variant automatically.',
            responses: {
                200: {
                    binary: ['image/jpeg', 'image/webp', 'image/avif', 'image/png'],
                    description:
                        'Image bytes. Cache-Control includes `immutable` for named-preset and ' +
                        'snapped-width variants with `v`; stale-while-revalidate only for custom/exact derivatives.',
                },
                400: 'Invalid role, composite key format, or resize params',
                401: 'Authentication required for external provider handles',
                403: 'Invalid or expired `?sig=` signature',
                404:
                    'Media not found, no image for this role, or `?fallback=none` was set. ' +
                    'Browsers instead receive the placeholder image bytes with 200; native ' +
                    'clients (bearer/PAT) always get this 404. Until 2026-08-28 a miss answered ' +
                    'with 302 to /placeholders/, which left the API surface and returned an HTML ' +
                    'login page with status 200 for token-authenticated callers.\n\n' +
                    '**Detecting a placeholder without relying on that split**: EVERY no-image ' +
                    'response — the 200 with bytes and the 404 alike — carries ' +
                    '`X-Lumastra-Placeholder: 1` and `Cache-Control: no-store`. Check the header ' +
                    'rather than the status. Client type is inferred from the credential PRESENTED on ' +
                    'the request (`Authorization: Bearer`), not from the resolved session. A `?sig=` signed URL is a public ' +
                    'embed credential and does NOT count, so a native client using signed image ' +
                    'URLs is classified as a browser and WILL receive bytes — check the header.',
                429: 'Image request budget exceeded',
                503: 'Database unavailable (when access gate cannot be evaluated)',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'public' },
    rateLimit: IMAGE_PROXY_RATE_LIMIT,
    raw: true,

    request: {
        query: ImageRoleQuery,
    },

    handlers: {
        GET: async (event, _ctx) => {
            const { params, url, request, locals } = event;

            const providerPath = url.searchParams.get('path');
            if (providerPath !== null && !isProviderImagePath(providerPath)) {
                return ApiProblem.validationFailed([
                    { field: 'path', message: 'Invalid provider image path' },
                ]);
            }

            // {id} comes from the route param; ?externalId= is an accepted alias
            // that keeps composite keys out of the URL path (no URL-encoding needed).
            const id = params.id ?? url.searchParams.get('externalId') ?? '';
            const role = (params.role ?? '').toLowerCase();

            if (!id) {
                return ApiProblem.validationFailed([
                    { field: 'id', message: 'Media ID is required' },
                ]);
            }
            if (!isValidImageType(role)) {
                return ApiProblem.validationFailed([
                    {
                        field: 'role',
                        message: `Invalid image role "${role}". Valid roles: ${VALID_IMAGE_TYPES.join(', ')}`,
                    },
                ]);
            }

            const parsed = parseMediaId(id);
            if (parsed.type === 'composite' && !locals.user?.username)
                return ApiProblem.unauthorized();

            // Signed-URL credential: when ?sig= is present verify the HMAC.
            // If valid the request proceeds without a session (public image embed).
            if (url.searchParams.has('sig')) {
                const verification = verifySignedUrl(url, 'image');
                if (!verification.valid) {
                    logger.debug('Signed media image verification failed', {
                        id,
                        role,
                        reason: verification.reason,
                    });
                    return ApiProblem.forbidden('Invalid or expired image signature');
                }
            }

            // Reject malformed composite key (contains `:` but didn't parse as composite).
            if (id.includes(':') && parsed.type === 'uuid') {
                return ApiProblem.validationFailed([
                    {
                        field: 'id',
                        message:
                            'Composite keys must include provider, id, and media type (e.g. tmdb:603:movie)',
                    },
                ]);
            }

            try {
                const externalAccess =
                    parsed.type === 'composite'
                        ? await resolveExternalArtworkAccess(
                              event,
                              parsed,
                              true,
                              url.searchParams.get('path') ?? undefined,
                          )
                        : null;
                if (externalAccess instanceof Response) return externalAccess;
                const service = getImageProxyService();
                // Resolve EFFECTIVE (snapped) size + quality BEFORE any provider
                // cache key is built, so near-preset widths collapse onto one
                // bounded variant. `bounded` drives immutable cache headers below.
                const directPath = url.searchParams.get('path') ?? undefined;
                const options = {
                    ...resolvePublicImageOptions(url, request),
                    revision: url.searchParams.get('v') ?? undefined,
                    index: Number(event.params.index ?? '0'),
                    inherit:
                        url.searchParams.get('inherit') === 'none' ? ('none' as const) : undefined,
                    ...(directPath ? { path: directPath } : {}),
                    // `jellyfin:` keys reach the Jellyfin server ungated: admin only.
                    allowUnmappedJellyfinFetch: localsIsAdmin(locals),
                };

                let result;

                if (parsed.type === 'uuid') {
                    const uuid = parsed.uuid;
                    if (!uuid) {
                        return ApiProblem.validationFailed([
                            { field: 'id', message: 'Invalid UUID' },
                        ]);
                    }

                    // Library + age gate: return 404, not 403, to avoid existence leak.
                    const sql = getDb();
                    if (sql && locals.user) {
                        if (!(await checkMediaAccess(sql, uuid, locals.user))) {
                            return ApiProblem.notFound('Media item not found');
                        }
                    } else if (!sql && locals.user && locals.principal?.isAdmin !== true) {
                        return ApiProblem.dependencyUnavailable('Unable to verify content access');
                    }

                    result = await service.getImageByCatalogId(uuid, role as ImageType, options);
                } else {
                    result = externalAccess
                        ? await fetchExternalArtwork(
                              service,
                              externalAccess,
                              role as ImageType,
                              options,
                          )
                        : null;
                }

                if (!result) {
                    // Suppress the placeholder entirely when the caller opts out.
                    if (url.searchParams.get('fallback') === 'none' || options.inherit === 'none') {
                        return new Response(null, {
                            status: 404,
                            headers: { 'Cache-Control': 'no-store' },
                        });
                    }
                    // Previously a 302 to /placeholders/popcorn.jpg. That path is
                    // not on the edge's API passthrough, so a PAT/bearer client
                    // followed the redirect into the identity provider and got an
                    // HTML login page with HTTP 200 — a permanently blank card
                    // with a success status. Serving bytes (browser) or 404
                    // (native) keeps the answer on the API surface either way;
                    // see noImageResponse for why neither branch can regress.
                    return noImageResponse(imageClientType(request, url, locals.authMethod));
                }

                const hasRevision =
                    !!result.servedRevision && result.servedRevision === options.revision;
                const response = imageResponse(result, request, {
                    hasRevision,
                    bounded: options.bounded && options.size !== 'full',
                    scope: 'public',
                });
                if (parsed.type === 'composite')
                    response.headers.set('Cache-Control', 'private, no-cache');
                return response;
            } catch (error) {
                logger.error('Failed to serve media image', error as Error, { id, role });
                return ApiProblem.internalError('Failed to fetch media image');
            }
        },
    },
});
