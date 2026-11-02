// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/library/file-stats.ts
 *
 * GET /api/admin/library/file-stats
 *
 * Returns aggregate statistics from media_files for the file scanner admin UI.
 *
 * Auth:    library:admin
 * Surface: internal
 *
 * Response: bare object { totalFiles, withMtime, withHash, probed, withKeyframes,
 *                          totalSizeBytes, avgDurationSeconds }
 * 503 dependency_unavailable on DB down.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';

interface FileStatsRow {
    total_files: string;
    with_mtime: string;
    with_hash: string;
    probed: string;
    with_keyframes: string;
    total_size_bytes: string | null;
    avg_duration_seconds: string | null;
}

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['library:admin'] },
    visibility: 'internal',
    handlers: {
        GET: async (_event, _ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const [row] = await sql<FileStatsRow[]>`
                SELECT
                    COUNT(*)::text                       AS total_files,
                    COUNT(file_mtime)::text              AS with_mtime,
                    COUNT(file_hash_head)::text          AS with_hash,
                    COUNT(probed_at)::text               AS probed,
                    COUNT(keyframes)::text               AS with_keyframes,
                    COALESCE(SUM(file_size_bytes), 0)::text AS total_size_bytes,
                    AVG(duration_seconds)::text          AS avg_duration_seconds
                FROM media_files
            `;

            return json({
                totalFiles: parseInt(row.total_files, 10),
                withMtime: parseInt(row.with_mtime, 10),
                withHash: parseInt(row.with_hash, 10),
                probed: parseInt(row.probed, 10),
                withKeyframes: parseInt(row.with_keyframes, 10),
                totalSizeBytes: parseInt(row.total_size_bytes ?? '0', 10),
                avgDurationSeconds: row.avg_duration_seconds
                    ? parseFloat(row.avg_duration_seconds)
                    : null,
            });
        },
    },
});
