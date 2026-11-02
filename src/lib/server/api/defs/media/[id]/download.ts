// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/media/[id]/download.ts — GET /api/v1/media/{id}/download
 *
 * Streams the original media file as an attachment (`Content-Disposition:
 * attachment`), with a filename rebuilt from catalog metadata rather than
 * the on-disk name — see `media-download-handler.ts` for why.
 *
 * `media:read` scope — the same coarse `read`/`write`/`admin` aliases that
 * already grant PlaybackInfo-equivalent access grant this too (a user who
 * can play an item can download it). Library/age access gate applies, same
 * as every other per-item media route (404 on denial, not 403 — avoids an
 * existence leak).
 *
 * v1-only: no internal (browser-session) twin — the web UI has its own
 * inline-play route at /api/playback/{itemId}/file; this is the
 * token-authenticated download surface for TV apps / scripts / PATs,
 * mirroring the Jellyfin-compat `/j/Items/{itemId}/Download` route (which
 * shares this same handler).
 */

import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { getDb } from '$lib/server/database/index.js';
import { handleDownloadFile } from '$lib/server/handlers/media-download-handler.js';

const DownloadQuery = z
    .object({
        /** Explicit file/edition to download when an item has multiple sources. Defaults to the item's default file. */
        fileId: z.string().optional(),
    })
    .strict();

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['media:read'] },
    raw: true,
    docs: {
        GET: {
            tags: ['Media'],
            summary: 'Download the original media file',
            stability: 'stable',
            auth: 'bearer',
            query: DownloadQuery,
            description:
                'Streams the original file for a movie, episode, or track as an ' +
                '`attachment` — the Content-Disposition filename is a normalized ' +
                '"Title (Year)" / "Series - SxxEyy - Title" form, not the on-disk ' +
                'filename. Supports `Range` requests. `?fileId=` selects a ' +
                'specific edition/file when the item has more than one.',
            responses: {
                200: {
                    binary: [
                        'video/mp4',
                        'video/x-matroska',
                        'video/webm',
                        'audio/mpeg',
                        'audio/flac',
                        'application/octet-stream',
                    ],
                    description: 'The original media file, as an attachment.',
                },
                206: 'Partial content (Range request)',
                401: 'Authentication required',
                404: 'Media not found, or no accessible file',
                416: 'Range not satisfiable',
                500: 'Internal server error',
                503: 'Database unavailable',
            },
        },
    },

    request: {
        query: DownloadQuery,
    },

    handlers: {
        GET: async (event) => {
            const id = event.params.id ?? '';
            if (!id) {
                return ApiProblem.validationFailed([
                    { field: 'id', message: 'Media ID is required' },
                ]);
            }

            const sql = getDb();
            if (sql) {
                if (!(await checkMediaAccess(sql, id, event.locals.user))) {
                    return ApiProblem.notFound('Media item not found');
                }
            } else if (event.locals.principal?.isAdmin !== true) {
                return ApiProblem.dependencyUnavailable('Unable to verify content access');
            }

            return handleDownloadFile(event);
        },
    },
});
