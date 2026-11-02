// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/media/[id]/metadata.ts
 *
 * GET   /api/admin/media/[id]/metadata  — read custom_metadata JSONB
 * PATCH /api/admin/media/[id]/metadata  — merge custom_metadata fields
 *
 * Auth: admin.  Surface: internal-only.
 *
 * GET response:  { custom_metadata: Record<string, unknown> }
 * PATCH response: { updated: boolean }
 * 503 dependency_unavailable when DB is down.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { adminMediaId } from '$lib/server/utils/admin-media-id.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { updateItemCustomMetadata } from '$lib/server/database/queries/non-entertainment-browse.queries.js';
import { MediaLifecycleService } from '$lib/server/services/media-lifecycle.service.js';
import { reservedCustomMetadataKeys } from '$lib/server/utils/custom-metadata-reserved.js';
import {
    saveCuratedOutput,
    undoCuratedOutput,
    CuratedOutputConflict,
} from '$lib/server/services/curated-output.service.js';
import { latestMediaChange } from '$lib/server/database/queries/admin-media-change.queries.js';
import { Logger } from '$lib/server/utils/logger.js';
import {
    MediaMetadataGetResponseSchema,
    MediaMetadataPatchResponseSchema,
    type MediaMetadataGetResponse,
    type MediaMetadataPatchResponse,
} from '$lib/schemas/api-media-responses.js';

const logger = Logger.for('AdminMediaMetadata');

// ---------------------------------------------------------------------------
// Response schemas — single-sourced from $lib/schemas/api-media-responses
// (also used by the v1 _openapi.ts at routes/api/v1/media/[id]/metadata).
// `custom_metadata` is a freeform JSONB column on media_items: content managers
// merge arbitrary key→value pairs with no fixed schema.
// ---------------------------------------------------------------------------

export const MetadataGetResponseSchema = MediaMetadataGetResponseSchema;
export const MetadataPatchResponseSchema = MediaMetadataPatchResponseSchema;

// Request-side raw merge payload: arbitrary custom_metadata fields chosen by the
// admin; merged into the JSONB column verbatim. No fixed schema is possible,
// but keys and their count are bounded, and declaring the body here also puts
// it under mount's body-size cap (it was read by hand before, uncapped).
export const MetadataPatchRequestSchema = z.object({
    undoReceiptId: z.uuid().optional(),
    output: z.enum(['chapters', 'lyrics']).optional(),
    metadata: z
        .record(z.string().min(1).max(128), z.unknown())
        .refine((m) => Object.keys(m).length <= 50, {
            message: 'metadata may not exceed 50 keys',
        }),
});

export type MetadataGetResponse = MediaMetadataGetResponse;
export type MetadataPatchResponse = MediaMetadataPatchResponse;

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        body: MetadataPatchRequestSchema,
    },
    handlers: {
        GET: async (event) => {
            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const mediaItemId = adminMediaId(event);
            if (!mediaItemId) return ApiProblem.notFound('Media item');

            const [row] = await sql`
                SELECT custom_metadata FROM media_items WHERE id = ${mediaItemId}
            `;
            if (!row) return ApiProblem.notFound('Media item');

            let meta: Record<string, unknown> = {};
            const raw: unknown = row.custom_metadata;
            if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
                meta = raw as Record<string, unknown>;
            }

            return json(
                MetadataGetResponseSchema.parse({
                    custom_metadata: meta,
                    undoIds: {
                        chapters: await latestMediaChange(sql, mediaItemId, 'output:chapters'),
                        lyrics: await latestMediaChange(sql, mediaItemId, 'output:lyrics'),
                    },
                }),
            );
        },

        PATCH: async (event, ctx) => {
            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const mediaItemId = adminMediaId(event);
            if (!mediaItemId) return ApiProblem.notFound('Media item');

            const { metadata } = ctx.input!.body;
            const reserved = reservedCustomMetadataKeys(metadata);
            if (reserved.length > 0) {
                return ApiProblem.validationFailed(
                    `Server-managed metadata keys cannot be set here: ${reserved.join(', ')}`,
                );
            }

            let undoId: string | undefined;
            let updated: boolean;
            try {
                if (ctx.input!.body.undoReceiptId) {
                    if (!ctx.input!.body.output || Object.keys(metadata).length)
                        return ApiProblem.validationFailed('Choose one saved output to restore.');
                    await undoCuratedOutput(
                        sql,
                        mediaItemId,
                        ctx.input!.body.output,
                        ctx.input!.body.undoReceiptId,
                    );
                    updated = true;
                } else if (
                    Object.keys(metadata).length === 1 &&
                    ('chapters' in metadata || 'lyrics' in metadata)
                ) {
                    const key = 'chapters' in metadata ? 'chapters' : 'lyrics';
                    undoId = await saveCuratedOutput(
                        sql,
                        mediaItemId,
                        key,
                        metadata[key],
                        event.locals.user?.username ?? 'admin',
                    );
                    updated = true;
                } else updated = await updateItemCustomMetadata(sql, mediaItemId, metadata);
            } catch (error) {
                if (error instanceof CuratedOutputConflict)
                    return ApiProblem.conflict(error.message);
                throw error;
            }
            if (!updated) return ApiProblem.notFound('Media item');

            // The JSONB keys are not column names: passing them made a key that
            // happened to be called 'title' invalidate embeddings.
            const changedFields = ['custom_metadata'];
            MediaLifecycleService.afterMetadataChanged(mediaItemId, changedFields).catch(
                (err: unknown) => {
                    logger.error(
                        'afterMetadataChanged lifecycle hook failed',
                        err instanceof Error ? err : new Error(String(err)),
                        { mediaItemId, changedFields, source: 'admin/media/metadata' },
                    );
                },
            );

            return json(MetadataPatchResponseSchema.parse({ updated: true, undoId }));
        },
    },
});
