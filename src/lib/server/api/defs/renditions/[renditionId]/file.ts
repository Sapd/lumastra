// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/renditions/[renditionId]/file.ts
 * GET /api/v1/renditions/{renditionId}/file
 *
 * Serves a finished rendition as an attachment, with the same guarantees the
 * original-file download gained: `Range`, a strong `ETag`/`Last-Modified`, and
 * `If-Range` demotion so an interrupted background transfer resumes instead of
 * restarting.
 *
 * ## The URL is stable and re-requestable, deliberately
 *
 * No token in the path, no single-use semantics, no expiry. A rendition download
 * is measured in gigabytes and can outlive the access token that started it, so
 * the client must be able to mint a fresh bearer token and retry the SAME URL
 * against the SAME bytes. Authorization is per request (scope + library/age gate
 * on the parent title), which is what makes a stable URL safe.
 *
 * If the artifact was evicted between the status poll and the download, this
 * returns 404 rather than resurrecting it inline: re-encoding takes minutes, and
 * a download request must not block on one. The client re-POSTs the rendition.
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { getDb } from '$lib/server/database/index.js';
import { config } from '$lib/server/config.js';
import { serveFileByPath } from '$lib/server/utils/file-streaming.js';
import { attachmentDisposition } from '$lib/server/utils/content-disposition.js';
import { getMediaItemForDownloadNaming } from '$lib/server/database/queries/catalog-operations.queries.js';
import { buildDownloadFilename } from '$lib/server/handlers/media-download-handler.js';
import {
    getRendition,
    touchRendition,
} from '$lib/server/database/queries/download-renditions.queries.js';
import { artifactPath } from '$lib/server/services/download-rendition/service.js';
import { kbpsToBytesPerSecond } from '$lib/server/utils/throttled-stream.js';

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['media:read'] },
    raw: true,

    docs: {
        GET: {
            tags: ['Media'],
            summary: 'Download an offline rendition',
            stability: 'protocol',
            auth: 'bearer',
            description:
                'Streams a ready rendition as an attachment. Supports `Range`, and carries a strong ' +
                '`ETag` + `Last-Modified` so a client can resume a partial transfer via `If-Range`. ' +
                'The URL is stable and may be retried with a freshly minted token.',
            responses: {
                200: {
                    binary: ['video/mp4'],
                    description: 'The rendition, as an attachment.',
                },
                206: 'Partial content (Range request)',
                401: 'Authentication required',
                404: 'Rendition not found, not ready, evicted, or the feature is disabled',
                416: 'Range not satisfiable',
                503: 'Database unavailable',
            },
        },
    },

    handlers: {
        GET: async (event) => {
            if (!config.FEATURE_DOWNLOAD_RENDITIONS) {
                return ApiProblem.notFound('Rendition not found');
            }

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const row = await getRendition(sql, event.params.renditionId ?? '');
            if (!row) return ApiProblem.notFound('Rendition not found');

            if (!(await checkMediaAccess(sql, row.media_item_id, event.locals.user))) {
                return ApiProblem.notFound('Rendition not found');
            }

            if (row.status !== 'ready' || !row.artifact_name) {
                return ApiProblem.notFound('Rendition is not ready');
            }

            // Every served range refreshes the LRU clock: a multi-hour download
            // over a slow link must not be evicted while it is in progress.
            await touchRendition(sql, row.id);

            const naming = await getMediaItemForDownloadNaming(sql, row.media_item_id);
            const filename = naming
                ? buildDownloadFilename(naming, '.mp4').replace(/\.mp4$/, ` (${row.rung_id}).mp4`)
                : `download (${row.rung_id}).mp4`;

            try {
                return await serveFileByPath(
                    artifactPath(row.artifact_name),
                    event.request.headers.get('range'),
                    undefined,
                    attachmentDisposition(filename),
                    event.request.headers.get('if-range'),
                    // Same cap as an original-file download: from the operator's
                    // point of view both are "a user pulling a big file off my box".
                    kbpsToBytesPerSecond(config.DOWNLOAD_THROTTLE_KBPS),
                );
            } catch (err) {
                // The row said `ready` a moment ago, but the cache reaper can
                // unlink the artifact between that check and this open. The
                // documented answer for a rendition that is not there is 404;
                // without this the missing file surfaced as an unhandled 500,
                // which a client reads as "the server is broken" and retries,
                // rather than "this rendition is gone" and re-requests it.
                if ((err as { code?: string } | null)?.code === 'ENOENT') {
                    return ApiProblem.notFound('This download is no longer available');
                }
                throw err;
            }
        },
    },
});
