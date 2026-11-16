// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared "download the original file" handler.
 *
 * Auth-agnostic — mirrors `stream-file-handler.ts`: the caller (route) does
 * auth + library/age access-checks, then delegates here. Used by both the
 * Jellyfin-compat surface (`/j/Items/{itemId}/Download`) and the public API
 * (`/api/v1/media/{id}/download`).
 *
 * Unlike playback streaming, the served filename is NOT the on-disk
 * filename — on-disk names are frequently scene-release garbage
 * (`the.movie.1999.1080p.bluray.x264-GROUP.mkv`). The Content-Disposition
 * filename is rebuilt from catalog metadata (title/year, or series/S/E for
 * episodes) so what lands in the user's downloads folder is legible, while
 * the original file extension is preserved unchanged.
 */

import type { RequestEvent } from '@sveltejs/kit';
import { UUID_RE_LOOSE } from '$lib/utils/id-patterns';
import { extname } from 'node:path';
import { config } from '$lib/server/config';
import { getDb } from '$lib/server/database';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { resolvePlaybackSelection } from '$lib/server/database/queries/media-file-resolution.queries';
import { getMediaItemForDownloadNaming } from '$lib/server/database/queries/catalog-operations.queries';
import type { MediaDownloadNamingRow } from '$lib/server/database/queries/catalog-operations.queries';
import { resolveMediaPath } from '$lib/server/utils/media-path-resolver';
import { resolveDownloadablePath } from '$lib/server/utils/download-path';
import { preflightFile, serveContainedMediaFile } from '$lib/server/utils/file-streaming';
import { attachmentDisposition } from '$lib/server/utils/content-disposition';
import {
    downloadForbiddenResponse,
    mediaAccessUserOf,
} from '$lib/server/services/download-access-guard.js';
import {
    allowedFileIds,
    deniedLibraryGroupsFor,
    scopeSelection,
} from '$lib/server/services/download-file-scope.js';
import {
    parseRangeStart,
    recordDownloadRefused,
    trackDownload,
    type DownloadSurface,
} from '$lib/server/services/download-tracking.js';

const logger = Logger.for('MediaDownloadHandler');

// Control chars (\x00-\x1F) plus the characters illegal in a filename on
// Windows (also awkward on macOS/Linux): < > : " / \ | ? *
// eslint-disable-next-line no-control-regex -- stripping control chars is the point
const FS_UNSAFE_CHARS = /[\x00-\x1F<>:"/\\|?*]/g;
const MAX_NAME_LENGTH = 180;

export function sanitizeFilenamePart(value: string): string {
    return value.replace(FS_UNSAFE_CHARS, '').replace(/\s+/g, ' ').trim();
}

/**
 * Build a human-legible download filename from catalog metadata (not the
 * on-disk name). Falls back to the item's own title whenever series/episode
 * context is unavailable, and always keeps the original file's extension.
 */
export function buildDownloadFilename(item: MediaDownloadNamingRow, fileExt: string): string {
    let base: string;
    if (
        item.media_type === 'episode' &&
        item.season_number != null &&
        item.episode_number != null
    ) {
        const code = `S${String(item.season_number).padStart(2, '0')}E${String(
            item.episode_number,
        ).padStart(2, '0')}`;
        base = item.series_title
            ? `${item.series_title} - ${code} - ${item.title}`
            : `${code} - ${item.title}`;
    } else if (item.year) {
        base = `${item.title} (${item.year})`;
    } else {
        base = item.title;
    }

    const sanitized = sanitizeFilenamePart(base).slice(0, MAX_NAME_LENGTH) || 'download';
    return `${sanitized}${fileExt}`;
}

/**
 * `surface` is named by the route that calls this (not guessed from the URL):
 * `/j` passes `jellyfin`, `/api/v1` passes `api`.
 */
export async function handleDownloadFile(
    event: RequestEvent,
    { surface, itemId: itemIdOverride }: { surface: DownloadSurface; itemId?: string },
): Promise<Response> {
    const { params, request } = event;

    // Single enforcement point for both surfaces (/j and /api/v1) — see the
    // FEATURE_MEDIA_DOWNLOAD getter in config.ts for why this is independent
    // of FEATURE_JELLYFIN_COMPAT. 404, matching the "disabled feature" convention
    // documented for /j (see docs/architecture/jellyfin-compat-security.md).
    if (!config.FEATURE_MEDIA_DOWNLOAD) {
        return ApiResponses.notFound('Not Found');
    }

    // Per-user permission. The route already did auth + checkMediaAccess (404),
    // so an item the caller cannot see never reaches this 403.
    const forbidden = await downloadForbiddenResponse(event.locals);
    if (forbidden) {
        // Logged after the verdict, so an item the caller cannot see (404 above) never lands here.
        const refusedItemId = itemIdOverride ?? params.itemId ?? params.id;
        if (refusedItemId) {
            recordDownloadRefused(event, { mediaItemId: refusedItemId, surface }, 'denied');
        }
        return forbidden;
    }

    const sql = getDb();
    if (!sql) {
        return ApiResponses.error('Database unavailable');
    }

    const itemId = itemIdOverride ?? params.itemId ?? params.id;
    if (!itemId) {
        return ApiResponses.badRequest('Item ID is required');
    }

    try {
        // The surface the route named, not the URL: the Jellyfin protocol adapter
        // (mediaSourceId, stale-source fallback) only applies to /j.
        const protocolAdapter = surface === 'jellyfin';
        const rawSourceId = protocolAdapter
            ? (event.url.searchParams.get('mediaSourceId') ??
              event.url.searchParams.get('MediaSourceId') ??
              undefined)
            : (event.url.searchParams.get('fileId') ?? undefined);
        if (!protocolAdapter && rawSourceId !== undefined && !UUID_RE_LOOSE.test(rawSourceId))
            return ApiResponses.notFound('File not found');
        let selection = await resolvePlaybackSelection(sql, itemId, { fileId: rawSourceId });
        // A stale/foreign mediaSourceId won't match — fall back to the default file.
        if (protocolAdapter && rawSourceId && selection.files.length === 0) {
            selection = await resolvePlaybackSelection(sql, itemId);
        }
        // File-level library scope: the item gate passed, but this FILE may sit in a library
        // the caller is denied. The default becomes the best allowed file; an explicit
        // fileId / mediaSourceId / play token naming a denied file is a 404.
        const denied = await deniedLibraryGroupsFor(sql, mediaAccessUserOf(event.locals));
        if (denied) {
            selection = scopeSelection(
                selection,
                await allowedFileIds(
                    sql,
                    selection.files.map((f) => f.id),
                    denied,
                ),
            );
            if (selection.files.length === 0) return ApiResponses.notFound('File not found');
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

        // Strict containment for a download: the CANONICAL target must lie inside a library
        // root (a symlink may not lead out of it, unlike playback). The canonical path is what
        // gets opened, so a swap after this check cannot redirect the read. Outside = 404.
        const downloadPath = await resolveDownloadablePath(
            sql,
            pathInfo.containerPath,
            config.DOWNLOAD_ALLOWED_MOUNT_ROOTS,
            itemId,
        );
        if (!downloadPath) {
            recordDownloadRefused(
                event,
                { mediaItemId: itemId, fileId: file?.id ?? selection.fileId, surface },
                'denied',
            );
            return ApiResponses.notFound('Media not found');
        }

        const fileSize = pathInfo.fileSize;
        if (!fileSize) {
            return ApiResponses.error('File size unavailable');
        }

        const naming = await getMediaItemForDownloadNaming(sql, itemId);
        const filename = naming
            ? buildDownloadFilename(naming, extname(pathInfo.containerPath))
            : `download${extname(pathInfo.containerPath)}`;

        const rangeHeader = request.headers.get('range');
        // HEAD and a matching conditional GET are answered from metadata alone: no lease,
        // no log row, no file stream.
        const disposition = attachmentDisposition(filename);
        const pre = await preflightFile(downloadPath, {
            contained: true,
            mimePath: pathInfo.containerPath,
            method: request.method,
            ifNoneMatch: request.headers.get('if-none-match'),
            ifModifiedSince: request.headers.get('if-modified-since'),
            disposition,
        });
        if (pre.kind === 'refused') return ApiResponses.notFound('Media not found');
        if (pre.kind === 'response') return pre.response;
        const tracked = await trackDownload(event, {
            // The catalog row's own id (never a composite / external id), so
            // the lease and the log always key on the same item.
            mediaItemId: naming?.id ?? itemId,
            fileId: file?.id ?? selection.fileId,
            surface,
            bytesTotal: fileSize,
            rangeStart: parseRangeStart(rangeHeader),
        });
        if (!tracked.ok) return tracked.response;
        const { tracker } = tracked;

        // The row was checked at scan time; a link swapped in since is re-contained.
        let response: Response | null;
        try {
            response = await serveContainedMediaFile(downloadPath, rangeHeader, {
                disposition,
                mimePath: pathInfo.containerPath,
                ifRange: request.headers.get('if-range'),
                // One enforcement point for both surfaces, exactly like the feature
                // flag above: /j and /api/v1 must not be able to disagree about how
                // fast raw file egress is allowed to go. The lease's rate already
                // includes DOWNLOAD_THROTTLE_KBPS.
                throttleBytesPerSec: () => tracker.rate(),
                observer: tracker.observer,
            });
        } catch (err) {
            tracker.discard();
            throw err;
        }
        // 416 and a refused path stream nothing, so no lease is held and nothing is logged.
        if (!response || response.status === 416) tracker.discard();
        else tracker.served(response.status);
        return response ?? ApiResponses.notFound('Media not found');
    } catch (err) {
        logger.error('Failed to serve download', undefined, {
            itemId,
            error: err,
        });
        return ApiResponses.error('Failed to serve download');
    }
}
