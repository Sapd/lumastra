// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/media/[id]/probe-raw.ts
 *
 * POST /api/admin/media/[id]/probe-raw
 *
 * Runs ffprobe on a specific file and returns raw JSON output.
 * File path is always resolved from DB — never from user input.
 *
 * Auth: admin.  Surface: internal-only.
 *
 * Request body: { fileId: string (uuid) }
 * Response: { filePath: string, probe: unknown }
 * 503 dependency_unavailable when DB is down.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { adminMediaId } from '$lib/server/utils/admin-media-id.js';
import { getDb } from '$lib/server/database/connection.js';
import { getFilePathForMediaItem } from '$lib/server/database/queries/media-files.queries.js';
import { probeRaw } from '$lib/server/utils/ffprobe.js';
import { resolveMediaPath } from '$lib/server/utils/media-path-resolver.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('AdminProbeRaw');

// ---------------------------------------------------------------------------
// Request / response schemas
// ---------------------------------------------------------------------------

const ProbeRawBodySchema = z.object({
    fileId: z.string().guid(),
});

export const ProbeRawResponseSchema = z.object({
    filePath: z.string(),
    probe: z.unknown(),
});

export type ProbeRawResponse = z.infer<typeof ProbeRawResponseSchema>;

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        body: ProbeRawBodySchema,
    },
    handlers: {
        POST: async (event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const internalId = adminMediaId(event);
            if (!internalId) return ApiProblem.notFound('Media item not found');

            const { fileId } = ctx.input!.body;

            const filePath = await getFilePathForMediaItem(sql, fileId, internalId);
            if (!filePath) {
                return ApiProblem.notFound('File not found or does not belong to this media item');
            }

            // The stored path is the host/library path; map it to this
            // container's view first, as the compatibility endpoint does.
            const pathInfo = await resolveMediaPath(filePath, { skipLocalAccessCheck: true }, sql);
            if (!pathInfo?.isAccessible) {
                return ApiProblem.notFound('File is not accessible from the server');
            }
            // probeRaw throws on a non-zero ffprobe exit, a timeout or bad
            // JSON; that was an unhandled 500 for any missing or unreadable file.
            let probe: Record<string, unknown>;
            try {
                probe = (await probeRaw(pathInfo.containerPath)).data;
            } catch (err) {
                logger.warn('ffprobe failed for raw probe', {
                    fileId,
                    error: err instanceof Error ? err.message : String(err),
                });
                return ApiProblem.dependencyUnavailable('ffprobe could not read the file');
            }
            return json(ProbeRawResponseSchema.parse({ filePath, probe }));
        },
    },
});
