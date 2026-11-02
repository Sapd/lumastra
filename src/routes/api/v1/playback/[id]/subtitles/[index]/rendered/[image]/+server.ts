// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Public API: Rendered Bitmap Subtitle Image
 *
 * GET /api/v1/playback/{id}/subtitles/{index}/rendered/{image}
 *
 * Serves one PNG referenced by the sibling `rendered` manifest. `{image}` is the
 * opaque id from a manifest rect, with an optional `.png` suffix.
 *
 * Images are served individually rather than as one sprite sheet on purpose: a
 * feature film's cues total ~75 Mpx, which as a single sheet would be ~1920x39000
 * and cost a client ~300 MB once decoded to RGBA — and would force the whole film
 * to be fetched before the first cue could draw.
 */

import type { RequestHandler } from './$types';
import { requireAuth } from '$lib/server/middleware/auth.js';
import { problem } from '$lib/server/api/problem.js';
import { Logger } from '$lib/server/utils/logger.js';
import { getRenderedSubtitle } from '$lib/server/services/subtitle-render.service.js';
import { bandwidthTracker } from '$lib/server/services/bandwidth-tracker.service.js';
import { getDb } from '$lib/server/database/index.js';
import {
    checkMediaAccess,
    userNeedsMediaAccessCheck,
} from '$lib/server/middleware/media-access.js';
import { isUuid } from '$lib/server/utils/media-key-parser.js';
import { getOwnerItemForFile } from '$lib/server/database/queries/media-files.queries.js';

const logger = Logger.for('RenderedSubtitleImageAPI');

/** Manifest ids are a hex digest prefix; reject anything else before a lookup. */
const IMAGE_ID_RE = /^[a-f0-9]{1,32}$/;

export const GET: RequestHandler = requireAuth(async ({ params, url, locals }) => {
    const { id, index, image } = params;

    if (!id || !index || !image) {
        return problem('validation_failed', { error: 'Missing id, index or image parameter' });
    }

    if (!isUuid(id)) {
        return new Response(null, { status: 404 });
    }

    const subtitleIndex = parseInt(index, 10);
    if (Number.isNaN(subtitleIndex) || subtitleIndex < 0) {
        return problem('validation_failed', { error: 'Invalid subtitle index' });
    }

    const imageId = image.endsWith('.png') ? image.slice(0, -4) : image;
    if (!IMAGE_ID_RE.test(imageId)) {
        return problem('validation_failed', { error: 'Invalid image id' });
    }

    const fileId = url.searchParams.get('fileId');
    if (!fileId) {
        return problem('validation_failed', { error: 'fileId is required' });
    }

    try {
        const sql = getDb();
        if (!sql) {
            return problem('dependency_unavailable', { error: 'Database unavailable' });
        }

        const ownerItemId = await getOwnerItemForFile(sql, id);
        const resolvedItemId = ownerItemId ?? id;

        if (
            (await userNeedsMediaAccessCheck(sql, locals.user)) &&
            !(await checkMediaAccess(sql, resolvedItemId, locals.user))
        ) {
            return new Response(null, { status: 404 });
        }

        const rendered = await getRenderedSubtitle(sql, resolvedItemId, subtitleIndex, fileId);
        const png = rendered?.getImage(imageId);

        if (!png) {
            return new Response(null, {
                status: 404,
                headers: { 'Access-Control-Allow-Origin': '*' },
            });
        }

        bandwidthTracker.trackSubtitle(png.length);

        return new Response(new Uint8Array(png), {
            status: 200,
            headers: {
                'Content-Type': 'image/png',
                'Content-Length': String(png.length),
                // Immutable, and genuinely so: ids are a digest of the bitmap
                // itself, so the same id always denotes the same bytes even
                // across a re-render of a replaced file.
                'Cache-Control': 'public, max-age=86400, immutable',
                'Access-Control-Allow-Origin': '*',
            },
        });
    } catch (error) {
        logger.error('Failed to serve rendered subtitle image', error as Error, {
            id,
            subtitleIndex,
        });
        return problem('internal_error', { error: 'Failed to serve rendered subtitle image' });
    }
});

export const OPTIONS: RequestHandler = async () =>
    new Response(null, {
        status: 204,
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        },
    });
