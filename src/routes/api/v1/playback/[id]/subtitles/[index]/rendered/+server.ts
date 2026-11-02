// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Public API: Rendered Bitmap Subtitle Manifest
 *
 * GET /api/v1/playback/{id}/subtitles/{index}/rendered
 *
 * Returns timing and positions for a bitmap subtitle track (PGS or VobSub) that the server
 * has rendered to PNGs, so a client can draw subtitles in its own overlay without
 * carrying a subtitle decoder and without the server re-encoding the video to burn
 * them in.
 *
 * Each positioned image carries a ready PNG href built through the timeline URL seam.
 *
 * Cue times are on the player timeline; see subtitle-render.service for what that
 * means and why it is not simply the container's own timestamps.
 */

import { createHash } from 'crypto';
import { apiUrl } from '$lib/shared/api-urls.js';
import { buildTimelineHref } from '$lib/server/services/playback-timeline-hrefs.js';

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
import { resolvePlaybackSelection } from '$lib/server/database/queries/media-file-resolution.queries.js';
import { getOwnerItemForFile } from '$lib/server/database/queries/media-files.queries.js';

const logger = Logger.for('RenderedSubtitleAPI');

export const GET: RequestHandler = requireAuth(async ({ params, url, locals, request }) => {
    const { id, index } = params;

    if (!id || !index) {
        return problem('validation_failed', { error: 'Missing id or index parameter' });
    }

    if (!isUuid(id)) {
        return new Response(null, { status: 404 });
    }

    const subtitleIndex = parseInt(index, 10);
    if (Number.isNaN(subtitleIndex) || subtitleIndex < 0) {
        return problem('validation_failed', { error: 'Invalid subtitle index' });
    }

    const requestedFileId = url.searchParams.get('fileId');

    try {
        const sql = getDb();
        if (!sql) {
            return problem('dependency_unavailable', { error: 'Database unavailable' });
        }

        // Android-TV-style clients may pass a media_files uuid as id; resolve to
        // the owning item so the access check and the renderer agree.
        const ownerItemId = await getOwnerItemForFile(sql, id);
        const resolvedItemId = ownerItemId ?? id;

        if (
            (await userNeedsMediaAccessCheck(sql, locals.user)) &&
            !(await checkMediaAccess(sql, resolvedItemId, locals.user))
        ) {
            return new Response(null, { status: 404 });
        }

        const selection = await resolvePlaybackSelection(sql, resolvedItemId, {
            fileId: requestedFileId,
        });
        const fileId = selection.fileId;
        if (!fileId) return problem('not_found', { error: 'No selected media file' });

        const rendered = await getRenderedSubtitle(sql, resolvedItemId, subtitleIndex, fileId);

        if (!rendered) {
            return problem('not_found', {
                error: 'No renderable bitmap subtitle for this track',
            });
        }

        const body = JSON.stringify({
            ...rendered.manifest,
            cues: rendered.manifest.cues.map((cue) => ({
                ...cue,
                rects: cue.rects.map(({ image, ...rect }) => ({
                    ...rect,
                    href: buildTimelineHref(
                        apiUrl(
                            url.pathname.startsWith('/api/v1/') ? 'v1' : 'internal',
                            `/playback/${resolvedItemId}/subtitles/${subtitleIndex}/rendered/${image}.png`,
                        ),
                        { fileId },
                    ),
                })),
            })),
        });

        // The images this manifest points at are immutable (content-addressed
        // ids), but the MANIFEST is not: a re-probe re-renders the track, and the
        // new bundle's ids will not match the old one's. Cached hard for 24h, a
        // client would keep requesting ids that now 404 — the mirror of the stale
        // -image problem content-addressing solved. So: revalidate, with an ETag
        // over the body so an unchanged manifest still costs only a 304.
        const etag = `"${createHash('sha1').update(body).digest('hex').slice(0, 32)}"`;

        if (request.headers.get('if-none-match') === etag) {
            return new Response(null, {
                status: 304,
                headers: { ETag: etag, 'Access-Control-Allow-Origin': '*' },
            });
        }

        // Counted like the sibling subtitle routes: a feature-film manifest runs
        // to hundreds of KB per client per session, which is not rounding error.
        bandwidthTracker.trackSubtitle(Buffer.byteLength(body));

        return new Response(body, {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                ETag: etag,
                'Cache-Control': 'public, max-age=300, must-revalidate',
                'Access-Control-Allow-Origin': '*',
            },
        });
    } catch (error) {
        logger.error('Failed to render subtitle', error as Error, { id, subtitleIndex });
        return problem('internal_error', { error: 'Failed to render subtitle' });
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
