// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * users/{id}/images/{role} — canonical user image endpoint.
 *
 * {role} is constrained to `avatar`. Other roles return 404.
 *
 * {id} is a stable users.id UUID.
 *
 * GET:    any authenticated principal (session, bearer). An uploaded avatar and the
 * initials generated from a user's name are personal data: no credential, no answer
 * (401 problem+json, identical for existing and unknown ids). There is no per-user
 * visibility setting for avatars (the privacy switches cover activity sharing), so any
 * signed-in user may read any user's avatar (Watch Together, shared playlists).
 * PUT:    selfOrAdmin — upload a new avatar (multipart/form-data, field "avatar").
 * DELETE: selfOrAdmin — remove avatar (reverts to fallback chain).
 *
 * Class R: raw image bytes on GET success; bare JSON on PUT/DELETE success;
 * problem+json on all failures.
 */

import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getImageProxyService, imageResponse } from '$lib/server/services/image-proxy/index.js';
import { getDb } from '$lib/server/database/index.js';
import {
    getUserById,
    setUserAvatar,
    deleteUserAvatar,
} from '$lib/server/database/queries/users.queries.js';
import { Logger } from '$lib/server/utils/logger.js';
import {
    snapQualityToTier,
    parseExact,
    parseAvatarImageOptions,
} from '$lib/server/utils/image-params.js';
import { generateAvatarSvg } from '$lib/utils/avatar-svg.js';
import { json } from '@sveltejs/kit';
import {
    AVATAR_TOO_MANY_PIXELS_MESSAGE,
    AvatarTooManyPixelsError,
    isAllowedAvatarImage,
    processAvatarImage,
} from '$lib/server/utils/avatar-image.js';
import { AVATAR_MAX_UPLOAD_LABEL, readAvatarUpload } from '$lib/server/utils/avatar-upload.js';

const AvatarUploadResponseSchema = z.object({
    updated: z.boolean(),
});

const UserImageQuerySchema = z.object({
    v: z.string().optional().describe('Opaque artwork revision; does not affect resolution.'),
    quality: z.coerce
        .number()
        .int()
        .optional()
        .meta({ description: 'Snaps to tier [50,70,85,95] within ±20%' }),
    width: z.coerce
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .meta({ description: 'Pixel width; snaps UP onto the ladder [48,96,160,200]' }),
    size: z
        .enum(['thumb', 'card', 'full'])
        .optional()
        .meta({ description: 'Named width: thumb=48, card=96, full=200 (the stored size)' }),
    exact: z
        .enum(['true', '1', 'yes', 'false', '0', 'no'])
        .optional()
        .meta({ description: 'Bypass quality-tier snapping for an exact avatar quality' }),
    fallback: z.enum(['initials']).optional().meta({
        description:
            'When nothing resolves, answer 200 with a generated initials SVG instead of 404',
    }),
});

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

/**
 * Params schema for GET|PUT|DELETE /users/{id}/images/{role}.
 *
 * `id` is the user id path segment; `role` is the image role string (currently
 * only "avatar" is served — the handler enforces the allowed set). Lenient:
 * `id` is a plain string (NOT .uuid()) so a malformed id reaches the handler,
 * which runs the selfOrAdmin auth check first and resolves/404s an unknown id —
 * preserving the prior 401/403/404 ordering instead of a pre-auth 422.
 */
const UserImageParams = z.object({
    id: z.string().min(1),
    role: z.string().min(1),
});

/**
 * Query schema for GET /users/{id}/images/{role}.
 *
 * Only `quality` is surfaced here (read by parseQuality in the handler).
 */
const UserImageQuery = z.object({
    v: z.string().optional().describe('Opaque artwork revision; does not affect resolution.'),
    // Coercion only; parseQuality() ignores out-of-range in the handler.
    quality: z.coerce.number().int().optional(),
    // Coercion only; the service snaps onto the avatar ladder.
    width: z.coerce.number().int().optional(),
    size: z.enum(['thumb', 'card', 'full']).optional(),
    // Bypass quality-tier snapping for an exact avatar quality.
    exact: z.enum(['true', '1', 'yes', 'false', '0', 'no']).optional(),
    // Generated initials SVG instead of a 404 when no avatar resolves.
    fallback: z.enum(['initials']).optional(),
});

const logger = Logger.for('UsersImagesRoute');

/**
 * Parse quality from URL (1-100, returns undefined on missing/invalid so the
 * service can apply its own default). Unlike parseQualityParam() from
 * image-proxy.ts, this never falls back to the global config value.
 */
function parseQuality(url: URL): number | undefined {
    const raw = url.searchParams.get('quality');
    if (!raw) return undefined;
    const q = parseInt(raw, 10);
    return Number.isFinite(q) && q >= 1 && q <= 100 ? q : undefined;
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `?fallback=initials` answer for a user with no avatar anywhere: the same
 * deterministic SVG the web `Avatar` component draws, as a 200. The web client
 * asks for it on every avatar URL, so a user without an image no longer costs
 * a 404 (and a browser console error) on each page that shows them; API and
 * native clients that omit the parameter keep the documented 404.
 *
 * Initials come from the path handle only when it is a username. A UUID gets
 * '?' rather than being resolved. The route needs a credential, but it still
 * must not turn an arbitrary user id into the first letters of that user's name.
 */
function initialsFallbackResponse(id: string): Response {
    const svg = generateAvatarSvg(id, 200, GUID_RE.test(id) ? '?' : undefined);
    return new Response(svg, {
        status: 200,
        headers: {
            'Content-Type': 'image/svg+xml; charset=utf-8',
            // Short: an upload elsewhere must show up without a cache-buster.
            // Authenticated response: never shared-cacheable.
            'Cache-Control': 'private, max-age=300',
            Vary: 'Authorization, Cookie',
            'X-Content-Type-Options': 'nosniff',
            // Opened directly, an SVG is a document — never let it run anything.
            'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
        },
    });
}

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Users'],
            summary: 'Get user avatar image',
            stability: 'stable',
            auth: 'bearer',
            description:
                "Returns the user's avatar image. Only the `avatar` role is supported; " +
                'other roles return 404. Requires authentication (session or bearer token): ' +
                'an uploaded avatar and the initials generated from a name are personal data, ' +
                'so an unauthenticated request gets `401` for an existing and an unknown id alike. ' +
                "Any authenticated user may read any user's avatar (Watch Together, shared playlists).\n\n" +
                'Uncached encodes are limited to 1000 per 60 seconds per authenticated user, ' +
                'with a separate encode budget; cache hits are free. ' +
                'Avatars are normalized to at most 200 × 200 px and served as WebP — ' +
                'including those resolved from Jellyfin, which are re-encoded AND resized ' +
                '(before 2026-08-28 that source was re-encoded only, so a large upstream ' +
                'profile image was served at full resolution).\n\n' +
                '**Sizing**: `?width=N` snaps UP onto the ladder [48, 96, 160, 200] — up, ' +
                'unlike the media-image ladder, so a caller never receives fewer pixels ' +
                'than it asked for. `?size=thumb|card|full` maps to 48 / 96 / 200. ' +
                'Omitting both serves the stored 200 px. ' +
                'The resolution chain is: custom uploaded avatar → Jellyfin profile image ' +
                '(if Jellyfin is configured) → Gravatar (if enabled) → 404, or with ' +
                '`?fallback=initials` a generated initials SVG (`image/svg+xml`, 200).\n\n' +
                '**Quality**: `?quality=Q` snaps to the nearest canonical tier [50, 70, 85, 95] ' +
                'within ±20% so near-identical quality values share one cache entry. ' +
                'Use `?exact=true` to bypass snapping and force the precise value. ' +
                'Bare avatar URLs use max-age=300. With `?v=<revision>`, bounded avatar sizes ' +
                'retain the source TTL and are immutable unless `?exact=true` is set. ' +
                '`Vary: Accept, Save-Data` is always present.',
            query: UserImageQuerySchema,
            responses: {
                200: {
                    binary: ['image/jpeg', 'image/webp', 'image/png', 'image/svg+xml'],
                    description:
                        'Avatar image bytes. `immutable` requires `v` and a bounded non-exact size.',
                },
                401: 'Authentication required',
                404: 'User not found or no avatar available',
                500: 'Internal server error',
            },
        },
        PUT: {
            tags: ['Users'],
            summary: 'Upload user avatar',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Uploads a new avatar for the user. Only `avatar` role is supported. ' +
                'Self or admin access required. Accepts `multipart/form-data` with field `avatar` ' +
                '(JPEG, PNG, WebP or GIF, at most 2 MB; larger files get 413 `payload_too_large`). ' +
                'Images are resized and stored as WebP.',
            responses: {
                200: {
                    schema: AvatarUploadResponseSchema,
                    description: 'Avatar uploaded',
                },
                400: 'Invalid role, missing avatar field, or unsupported image format',
                401: 'Authentication required',
                403: 'Insufficient permissions (must be self or admin)',
                404: 'User not found',
                413: 'Avatar file larger than 2 MB',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
        DELETE: {
            tags: ['Users'],
            summary: 'Delete user avatar',
            stability: 'stable',
            auth: 'bearer',
            description:
                "Removes the user's avatar. Only `avatar` role is supported. " +
                'Self or admin access required. Reverts to fallback avatar.',
            responses: {
                204: 'Avatar deleted (no content)',
                400: 'Invalid role',
                401: 'Authentication required',
                403: 'Insufficient permissions',
                404: 'User not found',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: {
        GET: { kind: 'user' },
        // {id} is a user UUID (Q8 — user id everywhere), so the mount-level
        // selfOrAdmin spec (which matches by username) cannot be used here.
        // We require `user` at mount level (enforces authentication) and perform
        // the self-or-admin UUID check explicitly inside each handler.
        PUT: { kind: 'user' },
        DELETE: { kind: 'user' },
    },
    raw: true,
    request: {
        // params applies to all methods; query applies to GET (skipped for PUT/DELETE).
        params: UserImageParams,
        query: UserImageQuery,
    },
    handlers: {
        GET: async (event, _ctx) => {
            const { params, url, request } = event;
            const id = params.id ?? '';
            const role = (params.role ?? '').toLowerCase();

            if (!id) {
                return ApiProblem.validationFailed([
                    { field: 'id', message: 'User ID is required' },
                ]);
            }
            if (role !== 'avatar') {
                return ApiProblem.notFound('Users images only support role "avatar"');
            }

            // Snap quality onto the bounded tier set so near-identical avatar
            // qualities share one cache entry (the avatar cache key is `q<N>`);
            // ?exact=true honors the precise value. Avatars are a single fixed
            // 200px size, so revisioned non-exact variants are bounded.
            const rawQuality = parseQuality(url);
            const exact = parseExact(url);
            const quality =
                rawQuality === undefined
                    ? undefined
                    : exact
                      ? rawQuality
                      : snapQualityToTier(rawQuality);
            const service = getImageProxyService();
            // getUserAvatar accepts username or UUID; the service resolves both.
            const avatarOptions = parseAvatarImageOptions(url);
            const result = await service.getUserAvatar(id, {
                quality,
                // ImageOptions.maxWidth is a string across the proxy's other
                // callers; the service coerces and snaps it onto the ladder.
                ...avatarOptions,
            });
            if (!result) {
                return url.searchParams.get('fallback') === 'initials'
                    ? initialsFallbackResponse(id)
                    : ApiProblem.notFound('No avatar available');
            }
            return imageResponse(result, request, {
                bounded: !exact,
                maxAge: 300,
                scope: 'private',
            });
        },

        PUT: async (event, _ctx) => {
            const { params, locals } = event;
            const id = params.id ?? '';
            const role = (params.role ?? '').toLowerCase();

            if (!id) {
                return ApiProblem.validationFailed([
                    { field: 'id', message: 'User ID is required' },
                ]);
            }
            if (role !== 'avatar') {
                return ApiProblem.notFound('Users images only support role "avatar"');
            }

            // Self-or-admin UUID check BEFORE expensive formData / sharp work.
            // mount() enforces {kind:'user'} (i.e. any authenticated user); we do
            // the UUID-level ownership check here because selfOrAdmin in mount.ts
            // compares username, not userId UUID (Q8).
            const currentUserId = locals.principal?.userId ?? locals.user?.userId;
            const isAdmin = locals.principal?.isAdmin === true;
            if (!currentUserId) return ApiProblem.unauthorized();
            if (currentUserId !== id && !isAdmin) return ApiProblem.forbidden();

            // Over the cap — ours or the adapter's BODY_SIZE_LIMIT — is a 413.
            const upload = await readAvatarUpload(event.request);
            if (upload.kind === 'too_large') {
                return ApiProblem.payloadTooLarge(
                    `File too large (max ${AVATAR_MAX_UPLOAD_LABEL})`,
                );
            }
            if (upload.kind === 'missing') {
                return ApiProblem.validationFailed([
                    { field: 'avatar', message: 'No avatar file provided' },
                ]);
            }
            const { file } = upload;
            if (file.size === 0) {
                return ApiProblem.validationFailed([{ field: 'avatar', message: 'Empty file' }]);
            }

            const rawBuffer = Buffer.from(await file.arrayBuffer());
            if (!isAllowedAvatarImage(rawBuffer)) {
                return ApiProblem.validationFailed([
                    {
                        field: 'avatar',
                        message: 'Invalid image format. Allowed: JPEG, PNG, WebP, GIF',
                    },
                ]);
            }

            let processedBuffer: Buffer;
            try {
                processedBuffer = await processAvatarImage(rawBuffer);
            } catch (err) {
                if (err instanceof AvatarTooManyPixelsError) {
                    return ApiProblem.validationFailed([
                        { field: 'avatar', message: AVATAR_TOO_MANY_PIXELS_MESSAGE },
                    ]);
                }
                return ApiProblem.validationFailed([
                    { field: 'avatar', message: 'Image processing failed — file may be corrupt' },
                ]);
            }

            const db = getDb();
            if (!db) return ApiProblem.dependencyUnavailable('Database not available');

            // Verify the target user exists (by UUID).
            const user = await getUserById(db, id);
            if (!user) return ApiProblem.notFound('User not found');

            // setUserAvatar accepts username; resolve from the found user record.
            const saved = await setUserAvatar(db, user.username, processedBuffer, 'image/webp');
            if (!saved) return ApiProblem.notFound('User not found');

            const service = getImageProxyService();
            await service.invalidateAvatarCache(user.username);

            logger.info('Avatar uploaded', { userId: id, size: processedBuffer.length });
            return json({ updated: true }, { status: 200 });
        },

        DELETE: async (event, _ctx) => {
            const { params, locals } = event;
            const id = params.id ?? '';
            const role = (params.role ?? '').toLowerCase();

            if (!id) {
                return ApiProblem.validationFailed([
                    { field: 'id', message: 'User ID is required' },
                ]);
            }
            if (role !== 'avatar') {
                return ApiProblem.notFound('Users images only support role "avatar"');
            }

            const currentUserId = locals.principal?.userId ?? locals.user?.userId;
            const isAdmin = locals.principal?.isAdmin === true;
            if (!currentUserId) return ApiProblem.unauthorized();
            if (currentUserId !== id && !isAdmin) return ApiProblem.forbidden();

            const db = getDb();
            if (!db) return ApiProblem.dependencyUnavailable('Database not available');

            const user = await getUserById(db, id);
            if (!user) return ApiProblem.notFound('User not found');

            await deleteUserAvatar(db, user.username);

            const service = getImageProxyService();
            await service.invalidateAvatarCache(user.username);

            logger.info('Avatar removed', { userId: id });
            return new Response(null, { status: 204 });
        },
    },
});
