// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/media/merge.ts
 *
 * POST /api/admin/media/merge
 *
 * Merge one media_items row into another (operator-confirmed, per-pair).
 * See original route comment for full guardrails documentation.
 *
 * Auth: admin.  Surface: internal-only.
 *
 * Response: { applied, preview } for album mode; legacy { keepId, mergeId, ...mergeResult } otherwise.
 * 400/422 validation_failed — bad request (same ids, cross-type, ambiguous files)
 * 404 not_found — one or both items missing
 * 409 conflict — stale preview, locked albums, scan in progress, or unsafe non-album file merge
 * 503 dependency_unavailable — DB down
 */

import { AlbumMergeResultSchema } from '$lib/schemas/album-merge.js';
import { mediaMergeDocs, MergeMediaRequestSchema, MergeMediaResponseSchema } from './_merge-docs.js';
export { MergeMediaRequestSchema, MergeMediaResponseSchema } from './_merge-docs.js';
export type { MergeMediaRequest } from './_merge-docs.js';
import {
    previewAlbumMerge,
    applyAlbumMerge,
    AlbumMergeError,
} from '$lib/server/services/album-merge.service.js';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { MergeGuardError } from '$lib/server/database/queries/media-items.queries.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    getMergeGuardRows,
    hasActiveLibraryScan,
} from '$lib/server/database/queries/admin-media.queries.js';
import { MediaDeletionService } from '$lib/server/services/media-deletion.service.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('AdminMediaMerge');

// ---------------------------------------------------------------------------
// Request / response schemas
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    docs: { POST: mediaMergeDocs },
    request: {
        body: MergeMediaRequestSchema,
    },
    handlers: {
        POST: async (event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const input = ctx.input!.body;
            const { keepId, mergeId } = input;
            if (input.mode) {
                try {
                    const result =
                        input.mode === 'preview'
                            ? await previewAlbumMerge(sql, input)
                            : await applyAlbumMerge(
                                  sql,
                                  input,
                                  event.locals.user?.username ?? 'admin',
                              );
                    return json(AlbumMergeResultSchema.parse(result));
                } catch (err) {
                    if (err instanceof AlbumMergeError) {
                        if (err.reason === 'missing') return ApiProblem.notFound(err.message);
                        if (err.reason === 'invalid')
                            return ApiProblem.validationFailed(err.message);
                        return ApiProblem.conflict(err.message);
                    }
                    throw err;
                }
            }

            if (keepId === mergeId) {
                return ApiProblem.validationFailed('keepId and mergeId must differ');
            }

            const rows = await getMergeGuardRows(sql, [keepId, mergeId]);
            const keep = rows.find((r) => r.id === keepId);
            const merge = rows.find((r) => r.id === mergeId);

            if (!keep || !merge) {
                return ApiProblem.notFound('Media item not found');
            }
            if (keep.media_type !== merge.media_type) {
                return ApiProblem.validationFailed('Cannot merge across media types');
            }
            if (keep.media_type === 'album') {
                return ApiProblem.conflict(
                    'Preview this album merge with mode=preview before applying it.',
                );
            }
            if (keep.has_files && merge.has_files) {
                return ApiProblem.conflict(
                    'Both rows have files — resolve the duplicate files manually before merging.',
                );
            }
            if (merge.has_files && !keep.has_files) {
                return ApiProblem.validationFailed(
                    'keepId must be the row that has files — swap keepId and mergeId.',
                );
            }
            if (await hasActiveLibraryScan(sql)) {
                return ApiProblem.conflict(
                    'A library scan is in progress. Retry the merge once it finishes.',
                );
            }

            const operator = event.locals.user?.username ?? 'unknown';
            logger.info('Admin media merge requested', {
                operator,
                keepId,
                mergeId,
                keepTitle: keep.title,
                mergeTitle: merge.title,
                mediaType: keep.media_type,
            });

            let result: Awaited<ReturnType<typeof MediaDeletionService.mergeInto>>;
            try {
                // The checks above give clear messages; the guard repeats them
                // on the locked rows, since either row can change in between.
                result = await MediaDeletionService.mergeInto(sql, keepId, mergeId, {
                    guard: 'adminPair',
                });
            } catch (err) {
                if (err instanceof MergeGuardError) {
                    return ApiProblem.conflict(
                        `The items changed since they were checked (${err.message}); reload and retry.`,
                    );
                }
                throw err;
            }

            logger.info('Admin media merge completed', {
                operator,
                keepId,
                mergeId,
                ...result,
            });

            return json(MergeMediaResponseSchema.parse({ keepId, mergeId, ...result }));
        },
    },
});
