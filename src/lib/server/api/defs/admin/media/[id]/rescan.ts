// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/media/[id]/rescan.ts
 *
 * POST /api/admin/media/[id]/rescan
 *
 * Triggers on-demand audio analysis (Essentia) for a single track.
 *
 * Auth: admin.  Surface: internal-only.
 *
 * Response: { bpm, key, energy, danceability, loudness_lufs }
 * 503 dependency_unavailable when DB is down.
 * 422 validation_failed when Essentia binary is unavailable or no file found.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { adminMediaId } from '$lib/server/utils/admin-media-id.js';
import { getDb } from '$lib/server/database/connection.js';
import { MediaLifecycleService } from '$lib/server/services/media-lifecycle.service.js';
import { Logger } from '$lib/server/utils/logger.js';
import {
    isEssentiaAvailable,
    analyzeTrack,
    storeAnalysis,
} from '$lib/server/services/essentia-analysis.service.js';

const logger = Logger.for('AdminMediaRescan');

// ---------------------------------------------------------------------------
// Response schema
// ---------------------------------------------------------------------------

export const RescanResponseSchema = z.object({
    bpm: z.number().nullable(),
    key: z.string().nullable(),
    energy: z.number().nullable(),
    danceability: z.number().nullable(),
    loudness_lufs: z.number().nullable(),
});

export type RescanResponse = z.infer<typeof RescanResponseSchema>;

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    handlers: {
        POST: async (event) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const internalId = adminMediaId(event);
            if (!internalId) return ApiProblem.notFound('Media item not found');

            if (!isEssentiaAvailable()) {
                return ApiProblem.validationFailed(
                    'Essentia binary is not available on this server',
                );
            }

            interface FileRow {
                file_path: string;
            }
            const rows = await sql<FileRow[]>`
                SELECT mf.file_path
                FROM media_files mf
                JOIN media_file_items mfi ON mfi.file_id = mf.id
                WHERE mfi.media_item_id = ${internalId}
                LIMIT 1
            `;

            if (rows.length === 0 || !rows[0].file_path) {
                return ApiProblem.notFound('No file associated with this media item');
            }

            const filePath = rows[0].file_path;

            try {
                const result = await analyzeTrack(filePath);
                if (!result) {
                    return ApiProblem.internalError('Essentia analysis returned no result');
                }

                await storeAnalysis(sql, internalId, result);

                MediaLifecycleService.afterMetadataChanged(internalId, [
                    'bpm',
                    'key',
                    'energy',
                    'danceability',
                    'loudness_lufs',
                ]).catch((err: unknown) => {
                    logger.error(
                        'afterMetadataChanged lifecycle hook failed',
                        err instanceof Error ? err : new Error(String(err)),
                        { internalId, source: 'admin/media/rescan' },
                    );
                });

                return json(
                    RescanResponseSchema.parse({
                        bpm: result.bpm,
                        key: result.key,
                        energy: result.energy,
                        danceability: result.danceability,
                        loudness_lufs: result.loudness_lufs,
                    }),
                );
            } catch {
                return ApiProblem.internalError('Audio analysis failed');
            }
        },
    },
});
