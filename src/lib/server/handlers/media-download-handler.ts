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
import { resolveMediaPath, isPathWithinLibraryRoots } from '$lib/server/utils/media-path-resolver';
import { serveContainedMediaFile } from '$lib/server/utils/file-streaming';
import { kbpsToBytesPerSecond } from '$lib/server/utils/throttled-stream';
import { attachmentDisposition } from '$lib/server/utils/content-disposition';

const logger = Logger.for('MediaDownloadHandler');

// Control chars (\x00-\x1F) plus the characters illegal in a filename on
// Windows (also awkward on macOS/Linux): < > : " / \ | ? *
// eslint-disable-next-line no-control-regex -- stripping control chars is the point
const FS_UNSAFE_CHARS = /[\x00-\x1F<>:"/\\|?*]/g;
const MAX_NAME_LENGTH = 180;

function sanitizeFilenamePart(value: string): string {
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

export async function handleDownloadFile(event: RequestEvent): Promise<Response> {
    const { params, request } = event;

    // Single enforcement point for both surfaces (/j and /api/v1) — see the
    // FEATURE_MEDIA_DOWNLOAD getter in config.ts for why this is independent
    // of FEATURE_JELLYFIN_COMPAT. 404, matching the "disabled feature" convention
    // documented for /j (see docs/architecture/jellyfin-compat-security.md).
    if (!config.FEATURE_MEDIA_DOWNLOAD) {
        return ApiResponses.notFound('Not Found');
    }

    const sql = getDb();
    if (!sql) {
        return ApiResponses.error('Database unavailable');
    }

    const itemId = params.itemId ?? params.id;
    if (!itemId) {
        return ApiResponses.badRequest('Item ID is required');
    }

    try {
        const protocolAdapter = event.url.pathname.toLowerCase().startsWith('/j/');
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

        // Defense-in-depth: the path is DB-sourced (scanner-written), but verify it
        // resolves inside a configured library root before streaming it, so a
        // tampered media_files row cannot serve arbitrary host files.
        if (!(await isPathWithinLibraryRoots(sql, pathInfo.containerPath))) {
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

        // The row was checked at scan time; a link swapped in since is re-contained.
        const response = await serveContainedMediaFile(
            pathInfo.containerPath,
            request.headers.get('range'),
            {
                disposition: attachmentDisposition(filename),
                ifRange: request.headers.get('if-range'),
                // One enforcement point for both surfaces, exactly like the feature
                // flag above: /j and /api/v1 must not be able to disagree about how
                // fast raw file egress is allowed to go.
                throttleBytesPerSec: kbpsToBytesPerSecond(config.DOWNLOAD_THROTTLE_KBPS),
            },
        );
        return response ?? ApiResponses.notFound('Media not found');
    } catch (err) {
        logger.error('Failed to serve download', undefined, {
            itemId,
            error: err,
        });
        return ApiResponses.error('Failed to serve download');
    }
}
