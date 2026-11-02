// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RequestHandler } from './$types';
import { requireAuth } from '$lib/server/middleware/auth.js';
import { withIdResolution } from '$lib/server/middleware/id-resolution.js';
import { withErrorHandler } from '$lib/server/middleware/error-handler.js';
import { withMediaAccess } from '$lib/server/middleware/media-access.js';
import { ApiResponses } from '$lib/server/utils/api-responses.js';
import { Logger } from '$lib/server/utils/logger.js';
import { sanitizeWebVTT } from '$lib/server/utils/subtitle-sanitizer.js';
import { getDb } from '$lib/server/database/connection.js';
import { getExternalSubtitleByIdForMediaItem } from '$lib/server/database/queries/external-subtitles.queries.js';
import { extractSubtitleStream } from '$lib/server/utils/ffmpeg-subtitle-extractor.js';
import { readSidecarText, SidecarTooLargeError } from '$lib/server/utils/sidecar-text.js';
import { ContainmentError, resolveContainedFile } from '$lib/server/utils/contained-fs.js';
import { isPathWithinMediaStore } from '$lib/server/utils/media-path-resolver.js';

const logger = Logger.for('ExternalSubtitleAPI');

export const GET: RequestHandler = requireAuth(
    withIdResolution(
        withMediaAccess(
            withErrorHandler(async ({ params, locals, url }) => {
                const sql = getDb();
                if (!sql) return ApiResponses.error('Database unavailable');

                const { internalId } = locals.resolvedIds ?? {};
                if (!internalId) {
                    return ApiResponses.notFound('Media item not found');
                }

                // Fetch subtitle only if it belongs to this media item (prevents IDOR)
                const subtitle = await getExternalSubtitleByIdForMediaItem(
                    sql,
                    params.subtitleId!,
                    internalId,
                );

                if (!subtitle) {
                    return ApiResponses.notFound(`Subtitle not found: ${params.subtitleId!}`);
                }

                if (
                    url.searchParams.has('fileId') &&
                    url.searchParams.get('fileId') !== subtitle.file_id
                )
                    return ApiResponses.notFound('Subtitle not found in selected file');
                const format = subtitle.format.toLowerCase();
                const outputFormat = url.searchParams.get('format') ?? 'vtt';
                if (outputFormat !== 'vtt' && outputFormat !== format)
                    return ApiResponses.badRequest('Unsupported subtitle format');

                if (format === 'sub' || format === 'sup') {
                    return ApiResponses.badRequest(
                        'Bitmap subtitle formats (sub/sup) cannot be served as WebVTT',
                    );
                }

                // subtitle_path is written exclusively by the file scanner from
                // library paths — use as-is (no user-controlled input)
                const subtitlePath = subtitle.subtitle_path;

                const withinRoots = await isPathWithinMediaStore(sql, subtitlePath);
                if (!withinRoots) {
                    logger.warn(
                        'Subtitle path is outside the metadata store and all library roots — blocked',
                        {
                            path: subtitlePath,
                        },
                    );
                    return ApiResponses.notFound('Subtitle not found');
                }

                let webvtt: string;

                try {
                    if (outputFormat !== 'vtt') {
                        const raw = await readSidecarText(subtitlePath);
                        return new Response(raw, {
                            headers: {
                                'Content-Type':
                                    format === 'srt'
                                        ? 'application/x-subrip; charset=utf-8'
                                        : 'text/plain; charset=utf-8',
                                'Cache-Control': 'private, max-age=3600',
                                'X-Content-Type-Options': 'nosniff',
                            },
                        });
                    }
                    if (format === 'vtt') {
                        const raw = await readSidecarText(subtitlePath);
                        webvtt = sanitizeWebVTT(raw, {
                            logPath: subtitlePath,
                        }).content;
                    } else if (!(await resolveContainedFile(subtitlePath))) {
                        // ffmpeg opens the path itself; refuse a symlink out of the roots
                        return ApiResponses.notFound('Subtitle not found');
                    } else if (format === 'srt') {
                        webvtt = await extractSubtitleStream({
                            filePath: subtitlePath,
                            streamIndex: 0,
                            codec: 'subrip',
                            outputFormat: 'webvtt',
                        });
                    } else {
                        webvtt = await extractSubtitleStream({
                            filePath: subtitlePath,
                            streamIndex: 0,
                            codec: 'ass',
                            outputFormat: 'webvtt',
                        });
                    }
                } catch (error) {
                    if (error instanceof ContainmentError && error.kind === 'refused') {
                        logger.warn('External subtitle refused by containment', {
                            path: subtitlePath,
                        });
                        return ApiResponses.notFound('Subtitle not found');
                    }
                    if (error instanceof SidecarTooLargeError) {
                        logger.warn('External subtitle file exceeds size limit', {
                            path: subtitlePath,
                            limitBytes: error.limitBytes,
                        });
                        return ApiResponses.payloadTooLarge('Subtitle file is too large');
                    }
                    logger.error(
                        `Failed to convert subtitle ${params.subtitleId!}`,
                        error as Error,
                    );
                    return ApiResponses.error('Failed to convert subtitle', error as Error);
                }

                return new Response(webvtt, {
                    headers: {
                        'Content-Type': 'text/vtt; charset=utf-8',
                        'Cache-Control': 'public, max-age=3600',
                    },
                });
            }),
        ),
    ),
);
