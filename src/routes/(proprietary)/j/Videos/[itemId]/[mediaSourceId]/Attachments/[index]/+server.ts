// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * GET /Videos/{videoId}/{mediaSourceId}/Attachments/{index}
 *
 * Jellyfin's `VideoAttachmentsController.GetAttachment`: one embedded
 * attachment (in practice a font for ASS subtitles) by its container stream
 * index, as PlaybackInfo's `MediaAttachments[].DeliveryUrl` names it. 404 when
 * the item, the media source or the attachment does not exist, or the caller
 * may not see the item. Extraction and caching: video-attachments.ts.
 */

import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { getDb } from '$lib/server/database';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { getOwnerItemForFile } from '$lib/server/database/queries/media-files.queries';
import { resolvePlaybackSelection } from '$lib/server/database/queries/media-file-resolution.queries';
import { resolveMediaPath } from '$lib/server/utils/media-path-resolver';
import { isUuid } from '$lib/server/utils/media-key-parser';
import { SCRIPTABLE_RESPONSE_CSP } from '$lib/server/middleware/scriptable-response-sandbox';
import { resolveMediaSourceFileId } from '$lib/server/proprietary/jellyfin-compat/media-source-id';
import {
    attachmentContentType,
    extractVideoAttachment,
} from '$lib/server/proprietary/jellyfin-compat/video-attachments';

export const GET: RequestHandler = withJellyfinAuth(async (event) => {
    const { params } = event;
    const sql = getDb();
    if (!sql) return ApiResponses.error('Database unavailable');

    const { itemId: rawItemId, mediaSourceId: rawSourceId, index: rawIndex } = params;
    if (!rawItemId || !rawSourceId) return new Response('Missing parameters', { status: 400 });
    if (!rawIndex || !/^\d{1,6}$/.test(rawIndex)) {
        return new Response('Invalid attachment index', { status: 400 });
    }
    const index = Number(rawIndex);
    // Jellyfin binds videoId as a Guid; the owner lookup casts to uuid.
    if (!isUuid(rawItemId)) return new Response('Invalid item id', { status: 400 });

    // Android TV passes MediaSource.Id (a media_files uuid) as the item id.
    const itemId = (await getOwnerItemForFile(sql, rawItemId)) ?? rawItemId;
    if (!(await checkMediaAccess(sql, itemId, event.locals.user))) {
        return ApiResponses.notFound('Media');
    }

    // PlaybackInfo's DeliveryUrl carries the raw media_files id; a client that
    // builds the URL from MediaSource.Id sends the file token.
    const fileId = await resolveMediaSourceFileId(rawSourceId);
    if (!fileId) return ApiResponses.notFound('Media source');
    const selection = await resolvePlaybackSelection(sql, itemId, { fileId });
    const file = selection.files[0];
    if (!file?.file_path) return ApiResponses.notFound('Media source');

    const pathInfo = await resolveMediaPath(file.file_path, { skipLocalAccessCheck: true }, sql);
    if (!pathInfo?.isAccessible) return ApiResponses.notFound('Media source');

    const result = await extractVideoAttachment(pathInfo.containerPath, index);
    if (!result) return ApiResponses.notFound('Attachment');

    // The bytes and their tags come from the media file, not from us: font
    // types only, never rendered as a document (attachment + sandbox CSP), the
    // same stance as the artwork routes (scriptable-response-sandbox.ts).
    const fileName = result.attachment.fileName;
    const headers: Record<string, string> = {
        'Content-Type': attachmentContentType(result.attachment),
        'Content-Length': String(result.data.length),
        'Content-Disposition': fileName
            ? `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`
            : 'attachment',
        'Content-Security-Policy': SCRIPTABLE_RESPONSE_CSP,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, max-age=86400',
        'Access-Control-Allow-Origin': '*',
    };
    // A view, not a copy: fonts can be tens of MB.
    const body = new Uint8Array(
        result.data.buffer as ArrayBuffer,
        result.data.byteOffset,
        result.data.length,
    );
    return new Response(body, { status: 200, headers });
});
