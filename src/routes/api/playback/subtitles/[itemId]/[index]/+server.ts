// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RequestHandler } from './$types';
import {
    describeSubtitleFormatMismatch,
    findSubtitleFormatMismatch,
    resolveSubtitle,
} from '$lib/server/services/subtitle-resolver.service';
import { problem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database';
import { requireAuth } from '$lib/server/middleware/auth.js';
import { withIdResolution } from '$lib/server/middleware/id-resolution.js';
import { requireResolvedId } from '$lib/server/middleware/library-access.js';
import { withErrorHandler } from '$lib/server/middleware/error-handler.js';
import { withMediaAccess } from '$lib/server/middleware/media-access.js';
import { withValidation } from '$lib/server/middleware/validate';
import { subtitleParamsSchema, subtitleQuerySchema } from '$lib/schemas/playback';
import { Logger } from '$lib/server/utils/logger.js';
import { bandwidthTracker } from '$lib/server/services/bandwidth-tracker.service.js';
import { prefetchNextEpisodeSubtitle } from '$lib/server/services/subtitle-prefetch.service.js';

const logger = Logger.for('PlaybackSubtitlesAPI');

/**
 * GET /api/playback/subtitles/[itemId]/[index]
 *
 * Resolves subtitle files from the local database for Lumastra-only mode.
 * Supports PGS (pgssub) format for client-side rendering with libpgs.
 *
 * Query parameters:
 * - format: Optional - Output format (vtt, srt, ass, pgssub, sub) - defaults to vtt
 */
export const GET: RequestHandler = requireAuth(
    withIdResolution(
        requireResolvedId(
            withMediaAccess(
                withErrorHandler(
                    withValidation(
                        async ({ validated, locals, url }) => {
                            const sql = getDb();
                            if (!sql) {
                                return new Response('Database unavailable', {
                                    status: 503,
                                });
                            }

                            // requireResolvedId guarantees internalId
                            const resolvedItemId = locals.resolvedIds!.internalId!;
                            const { index: subtitleIndex } = validated.params;
                            const { format, fileId } = validated.query;

                            // Only an explicit format can mismatch: without one the track is
                            // served in its own format.
                            const mismatch = !url.searchParams.has('format')
                                ? null
                                : await findSubtitleFormatMismatch(
                                sql,
                                resolvedItemId,
                                subtitleIndex,
                                { fileId, format },
                            );
                            if (mismatch) {
                                const message = describeSubtitleFormatMismatch(mismatch, format);
                                return problem('validation_failed', {
                                    error: message,
                                    details: [{ field: 'format', message, value: format }],
                                });
                            }

                            const result = await resolveSubtitle(
                                sql,
                                resolvedItemId,
                                subtitleIndex,
                                {
                                    fileId,
                                    format,
                                },
                            );

                            if (!result) {
                                logger.debug(
                                    `No subtitle found for item ${resolvedItemId}, index ${subtitleIndex}`,
                                );
                                return new Response('Subtitle not available', {
                                    status: 404,
                                });
                            }

                            // Warm the next episode's matching track in the background:
                            // a cold embedded extraction reads the whole file (4-7 s).
                            void prefetchNextEpisodeSubtitle(sql, {
                                mediaItemId: resolvedItemId,
                                fileId,
                                streamIndex: subtitleIndex,
                                format: format ?? 'vtt',
                            });

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
                                : new TextEncoder().encode(result.content);
                            bandwidthTracker.trackSubtitle(body.length);
                            return new Response(body, {
                                status: 200,
                                headers: {
                                    'Content-Type': result.contentType,
                                    'Content-Length': String(body.length),
                                    'Cache-Control': 'public, max-age=86400',
                                    'Access-Control-Allow-Origin': '*',
                                },
                            });
                        },
                        {
                            params: subtitleParamsSchema,
                            query: subtitleQuerySchema,
                        },
                    ),
                ),
            ),
        ),
    ),
);

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
