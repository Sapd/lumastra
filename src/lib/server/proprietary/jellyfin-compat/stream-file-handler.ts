// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Shared static file streaming handler for Jellyfin compat layer.
 * Used by both /Videos/{itemId}/stream and /Audio/{itemId}/stream.
 */

import type { RequestEvent } from '@sveltejs/kit';
import { getDb } from '$lib/server/database';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { resolvePlaybackSelection } from '$lib/server/database/queries/media-file-resolution.queries';
import { resolveMediaPath } from '$lib/server/utils/media-path-resolver';
import { serveContainedMediaFile } from '$lib/server/utils/file-streaming';
import { config } from '$lib/server/config';
import { getStreamsForFile } from '$lib/server/database/queries/media-streams.queries';
import type { MediaStreamRow } from '$lib/server/database/queries/media-streams.queries';
import { containerFromPath } from './media-container-utils';
import {
    parseProgressiveRequest,
    planProgressiveTranscode,
    type ProgressiveSource,
} from './progressive-transcode';
import { serveProgressiveTranscode } from './progressive-transcode-runner';

const logger = Logger.for('JellyfinCompat:StreamFileHandler');

export interface StreamFileOptions {
    /**
     * Honour `Static=false` + `container`/codec params with a progressive
     * transcode (see progressive-transcode.ts). Video route only.
     */
    progressiveTranscode?: boolean;
}

const HDR_TRANSFERS = new Set(['smpte2084', 'arib-std-b67']);

/** The source facts the progressive planner needs, from scanned stream rows. */
export function progressiveSourceFromStreams(
    streams: MediaStreamRow[],
    filePath: string,
    totalBitrate: number | null,
): ProgressiveSource {
    const videoRow = streams.find((s) => s.stream_type === 'video' && !s.is_external);
    const audioRows = streams.filter((s) => s.stream_type === 'audio' && !s.is_external);
    let videoBitrate = videoRow?.bitrate ?? null;
    if (videoBitrate === null && totalBitrate !== null) {
        // Matroska rarely states a per-stream video bitrate: estimate it as the
        // file total minus the audio tracks that state theirs.
        const audioBits = audioRows.reduce((sum, a) => sum + (a.bitrate ?? 0), 0);
        videoBitrate = totalBitrate - audioBits > 0 ? totalBitrate - audioBits : totalBitrate;
    }
    return {
        container: containerFromPath(filePath) || null,
        video: videoRow
            ? {
                  codec: videoRow.codec,
                  width: videoRow.width,
                  height: videoRow.height,
                  bitrate: videoBitrate,
                  isHdr:
                      (videoRow.video_range !== null &&
                          videoRow.video_range.toUpperCase() !== 'SDR') ||
                      videoRow.dv_profile !== null ||
                      HDR_TRANSFERS.has((videoRow.color_transfer ?? '').toLowerCase()),
              }
            : null,
        audio: audioRows.map((a) => ({
            index: a.stream_index,
            codec: a.codec,
            channels: a.channels,
            isDefault: a.is_default,
        })),
    };
}

export async function handleStreamFile(
    event: RequestEvent,
    options: StreamFileOptions = {},
): Promise<Response> {
    const { params, request } = event;
    const sql = getDb();
    if (!sql) {
        return ApiResponses.error('Database unavailable');
    }

    const itemId = params.itemId;
    if (!itemId) {
        return ApiResponses.badRequest('Item ID is required');
    }

    try {
        const rawSourceId =
            event.url.searchParams.get('mediaSourceId') ??
            event.url.searchParams.get('MediaSourceId') ??
            undefined;
        let selection = await resolvePlaybackSelection(sql, itemId, {
            fileId: rawSourceId,
        });
        // mediaSourceId from a stale/different item won't match — fall back to default
        if (rawSourceId && selection.files.length === 0) {
            selection = await resolvePlaybackSelection(sql, itemId);
        }
        const file = selection.files.find((f) => f.id === selection.fileId);
        const filePath = file?.file_path ?? null;

        if (!filePath) {
            return ApiResponses.notFound('File path not available');
        }

        const pathInfo = await resolveMediaPath(filePath, { skipLocalAccessCheck: true }, sql);
        if (!pathInfo?.isAccessible) {
            return ApiResponses.error(
                `Media file not accessible: ${pathInfo?.reason ?? 'unknown'}`,
            );
        }

        const fileSize = pathInfo.fileSize;
        if (!fileSize) {
            return ApiResponses.error('File size unavailable');
        }

        const progressive =
            options.progressiveTranscode && config.JELLYFIN_PROGRESSIVE_TRANSCODE_MAX_CONCURRENT > 0
                ? parseProgressiveRequest(event.url.searchParams)
                : null;
        if (progressive && file) {
            const streams = await getStreamsForFile(sql, file.id);
            const source = progressiveSourceFromStreams(
                streams,
                filePath,
                file.total_bitrate !== null ? Number(file.total_bitrate) : null,
            );
            const plan = planProgressiveTranscode(progressive, source);
            if (plan.kind === 'transcode') {
                return await serveProgressiveTranscode({
                    plan,
                    inputPath: pathInfo.containerPath,
                    request,
                    itemId,
                    username: event.locals.user?.username,
                    userId: event.locals.user?.userId,
                });
            }
        }

        // The row was checked at scan time; a link swapped in since is re-contained.
        return (
            (await serveContainedMediaFile(pathInfo.containerPath, request.headers.get('range'))) ??
            ApiResponses.notFound('Media not found')
        );
    } catch (err) {
        logger.error('Failed to stream file', undefined, {
            itemId,
            error: err,
        });
        return ApiResponses.error('Failed to stream file');
    }
}
