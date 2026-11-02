// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * AVFoundation Cache-Busting Route for HLS Playback
 *
 * Path: /api/v1/playback/{itemId}/avp/{cacheNonce}/hls
 *
 * AVFoundation (tvOS/iOS) maintains a process-wide CFNetwork connection pool
 * that caches by URL PATH (ignoring query params). When switching audio tracks,
 * using the same path causes AVFoundation to reuse corrupted connection state.
 *
 * This route accepts a unique `cacheNonce` (e.g., UUID) in the path which forces
 * AVFoundation to create fresh connections. The nonce is ignored for authentication.
 *
 * Usage:
 *   /playback/{itemId}/avp/a1b2c3d4/hls?AudioStreamIndex=2
 *                      ^^^^^^^^^^^
 *                      Unique per audio switch
 *
 * Each audio switch should use a new cacheNonce to bust the connection cache.
 */

import type { RequestHandler } from './$types';
import { requireAuth } from '$lib/server/middleware/auth.js';
import { withIdResolution } from '$lib/server/middleware/id-resolution.js';
import { withErrorHandler } from '$lib/server/middleware/error-handler.js';
import { withMediaAccess } from '$lib/server/middleware/media-access.js';

/**
 * GET /api/v1/playback/{itemId}/avp/{cacheNonce}/hls
 *
 * The cacheNonce param is intentionally ignored — it's only for cache busting.
 * Redirects to the internal HLS endpoint.
 */
export const GET: RequestHandler = requireAuth(
    withIdResolution(
        withMediaAccess(
            withErrorHandler(async ({ url }) => {
                const lumastraUrl = new URL(url);
                lumastraUrl.pathname = lumastraUrl.pathname.replace(/\/avp\/[^/]+\/hls$/, '/hls');
                return Response.redirect(lumastraUrl.toString(), 307);
            }),
        ),
    ),
);
