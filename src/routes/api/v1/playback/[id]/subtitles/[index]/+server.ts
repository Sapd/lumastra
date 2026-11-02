// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Public API: Subtitle Stream
 *
 * GET /api/v1/playback/{id}/subtitles/{index}
 *
 * Resolves subtitles from local files via the database.
 * Supports text formats (VTT, SRT, ASS) and PGS bitmap subtitles.
 *
 * Query parameters:
 * - fileId: Required - Canonical Lumastra file selector for local playback
 * - format: Optional - Output format (vtt, srt, ass, pgssub, sub) - defaults to vtt
 */

import type { RequestHandler } from './$types';
import { requireAuth } from '$lib/server/middleware/auth.js';
import { problem } from '$lib/server/api/problem.js';
import { Logger } from '$lib/server/utils/logger.js';
import {
    describeSubtitleFormatMismatch,
    findSubtitleFormatMismatch,
    resolveSubtitle,
} from '$lib/server/services/subtitle-resolver.service.js';
import { bandwidthTracker } from '$lib/server/services/bandwidth-tracker.service.js';
import { getDb } from '$lib/server/database/index.js';
import {
    checkMediaAccess,
    userNeedsMediaAccessCheck,
} from '$lib/server/middleware/media-access.js';
import { isUuid } from '$lib/server/utils/media-key-parser.js';
import { getOwnerItemForFile } from '$lib/server/database/queries/media-files.queries.js';

const logger = Logger.for('PublicSubtitleAPI');

export const GET: RequestHandler = requireAuth(async ({ params, url, locals }) => {
    const { id, index } = params;

    if (!id || !index) {
        return problem('validation_failed', { error: 'Missing id or index parameter' });
    }

    if (!isUuid(id)) {
        return new Response(null, { status: 404 });
    }

    const subtitleIndex = parseInt(index, 10);
    if (Number.isNaN(subtitleIndex)) {
        return problem('validation_failed', { error: 'Invalid subtitle index' });
    }

    const format = (url.searchParams.get('format') || 'vtt') as
        'vtt' | 'srt' | 'ass' | 'pgssub' | 'sub';
    const fileId = url.searchParams.get('fileId') ?? undefined;

    try {
        const sql = getDb();
        if (!sql) {
            return problem('dependency_unavailable', { error: 'Database unavailable' });
        }

        // Android-TV-style clients sometimes pass a media_files uuid as id
        // (MediaSource.Id). Resolve file → owning media item so the access
        // check and resolveSubtitle both see a media_items.id. The owner
        // lookup is cached, so repeated subtitle fetches hit it once.
        const ownerItemId = await getOwnerItemForFile(sql, id);
        const resolvedItemId = ownerItemId ?? id;

        if (
            (await userNeedsMediaAccessCheck(sql, locals.user)) &&
            !(await checkMediaAccess(sql, resolvedItemId, locals.user))
        ) {
            return new Response(null, { status: 404 });
        }

        // Only an explicit format can mismatch: without one the track is served in its own format.
        const mismatch = !url.searchParams.has('format')
            ? null
            : await findSubtitleFormatMismatch(sql, resolvedItemId, subtitleIndex, {
            fileId,
            format,
        });
        if (mismatch) {
            const message = describeSubtitleFormatMismatch(mismatch, format);
            return problem('validation_failed', {
                error: message,
                details: [{ field: 'format', message, value: format }],
            });
        }

        const result = await resolveSubtitle(sql, resolvedItemId, subtitleIndex, {
            fileId,
            format,
        });

        if (!result) {
            logger.debug(`No subtitle found for item ${id}, index ${subtitleIndex}`);
            return new Response('Subtitle not available', {
                status: 404,
                headers: { 'Access-Control-Allow-Origin': '*' },
            });
        }

        if (format === 'pgssub' || format === 'sub') {
            const binaryBody = Buffer.isBuffer(result.content)
                ? new Uint8Array(result.content)
                : result.content;
            const subBytes = Buffer.isBuffer(result.content)
                ? result.content.length
                : Buffer.byteLength(result.content);
            bandwidthTracker.trackSubtitle(subBytes);
            return new Response(binaryBody, {
                status: 200,
                headers: {
                    'Content-Type': result.contentType,
                    'Content-Length': String(
                        Buffer.isBuffer(result.content)
                            ? result.content.length
                            : Buffer.byteLength(result.content),
                    ),
                    'Cache-Control': 'public, max-age=86400',
                    'Access-Control-Allow-Origin': '*',
                },
            });
        }

        const body = Buffer.isBuffer(result.content)
            ? new Uint8Array(result.content)
            : result.content;
        const textBytes = Buffer.isBuffer(result.content)
            ? result.content.length
            : Buffer.byteLength(result.content);
        bandwidthTracker.trackSubtitle(textBytes);
        return new Response(body, {
            status: 200,
            headers: {
                'Content-Type': result.contentType,
                'Cache-Control': 'public, max-age=86400',
                'Access-Control-Allow-Origin': '*',
            },
        });
    } catch (error) {
        logger.error('Failed to resolve subtitle', error as Error, {
            id,
            subtitleIndex,
        });
        return problem('internal_error', { error: 'Failed to resolve subtitle' });
    }
});

/**
 * OPTIONS for CORS preflight
 */
export const OPTIONS: RequestHandler = async () => {
    return new Response(null, {
        status: 204,
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Authorization',
            'Access-Control-Max-Age': '86400',
        },
    });
};
