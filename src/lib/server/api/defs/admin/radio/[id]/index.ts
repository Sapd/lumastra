// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/radio/[id]/index.ts
 *
 * PATCH  /api/admin/radio/[id] — update a radio station's name/metadata
 * DELETE /api/admin/radio/[id] — delete a radio station (and its artwork row)
 *
 * Auth: admin.  Surface: internal.
 * Scope: { kind: 'admin' } — internal admin BFF; no v1 surface.
 *
 * PATCH  response: bare object { updated: true, validation? }
 * DELETE response: bare object { deleted: true }
 * 503    dependency_unavailable on DB down.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { UpdateRadioStationSchema } from '$lib/schemas/radio.js';
import { isUuid } from '$lib/server/utils/media-key-parser.js';
import { deleteMediaImage } from '$lib/server/services/media-image-storage.service.js';
import { metadataSourceIssues } from '$lib/server/services/radio-metadata/validate-source.js';
import { Logger } from '$lib/server/utils/logger.js';
import { refreshSortTitles } from '$lib/server/database/queries/sort-title.queries.js';

const logger = Logger.for('AdminRadioAPI');

// ── row types ─────────────────────────────────────────────────────────────────

interface RadioRow {
    id: string;
    title: string;
    custom_metadata: Record<string, unknown>;
}

// ── response schemas ──────────────────────────────────────────────────────────

const ValidationResultSchema = z.object({
    ok: z.boolean(),
    source: z.enum(['url', 'icy', 'stale']).nullable(),
    matchedFieldCount: z.number().int().nonnegative(),
    error: z.string().optional(),
});

const RadioPatchResponseSchema = z.object({
    updated: z.literal(true),
    validation: ValidationResultSchema.optional(),
});

const RadioDeleteResponseSchema = z.object({
    deleted: z.literal(true),
});

// ── def ───────────────────────────────────────────────────────────────────────

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        body: UpdateRadioStationSchema,
    },
    handlers: {
        PATCH: async (event) => {
            const id = event.params.id;
            if (!id || !isUuid(id)) {
                return ApiProblem.validationFailed('Invalid radio station ID');
            }

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const [existing] = await sql<RadioRow[]>`
                SELECT id, title, COALESCE(custom_metadata, '{}'::jsonb) AS custom_metadata
                FROM media_items
                WHERE id = ${id} AND media_type = 'radio'
            `;
            if (!existing) return ApiProblem.notFound('Radio station not found');

            let body: z.infer<typeof UpdateRadioStationSchema>;
            try {
                const raw: unknown = await event.request.json();
                const parsed = UpdateRadioStationSchema.safeParse(raw);
                if (!parsed.success) {
                    return ApiProblem.validationFailed(
                        parsed.error.issues.map((i) => ({
                            field: i.path.join('.'),
                            message: i.message,
                        })),
                    );
                }
                body = parsed.data;
            } catch {
                return ApiProblem.validationFailed('Invalid JSON body');
            }

            const { name, streamUrl, genre, description, metadataSource } = body;

            // An unsafe now-playing regex is refused here, at save time, not
            // only per poll (security review 2026-09-12, C7).
            const sourceIssues = metadataSourceIssues(metadataSource);
            if (sourceIssues) return ApiProblem.validationFailed(sourceIssues);

            const nextMetadata: Record<string, unknown> = { ...existing.custom_metadata };
            if (streamUrl !== undefined) nextMetadata.stream_url = streamUrl;
            if (genre === null) delete nextMetadata.genre;
            else if (genre !== undefined) nextMetadata.genre = genre;
            if (description === null) delete nextMetadata.description;
            else if (description !== undefined) nextMetadata.description = description;
            if (metadataSource === null) {
                delete nextMetadata.metadata_source;
            } else if (metadataSource !== undefined) {
                nextMetadata.metadata_source = metadataSource;
            }

            const nextTitle = name ?? existing.title;

            await sql`
                UPDATE media_items
                SET
                    title = ${nextTitle},
                    custom_metadata = ${sql.json(nextMetadata as never)},
                    updated_at = NOW()
                WHERE id = ${id}
            `;
            await refreshSortTitles(sql, [id]);

            logger.info('Radio station updated', { id, name: nextTitle });

            let validation: z.infer<typeof ValidationResultSchema> | undefined;
            if (nextMetadata.metadata_source) {
                const { getNowPlaying, clearRadioCache } =
                    await import('$lib/server/services/radio-metadata');
                try {
                    await clearRadioCache(id);
                    const np = await getNowPlaying({
                        id,
                        streamUrl: String(nextMetadata.stream_url ?? ''),
                        metadataSource: nextMetadata.metadata_source as never,
                    });
                    const count =
                        Object.keys(np.track).length +
                        Object.keys(np.show).length +
                        Object.keys(np.dj).length +
                        Object.keys(np.upNext).length;
                    validation = {
                        ok: np.source === 'url' && count > 0,
                        source: np.source,
                        matchedFieldCount: count,
                    };
                } catch (err) {
                    validation = {
                        ok: false,
                        source: null,
                        matchedFieldCount: 0,
                        error: err instanceof Error ? err.message : String(err),
                    };
                }
            }

            return json(RadioPatchResponseSchema.parse({ updated: true, validation }));
        },

        DELETE: async (event) => {
            const id = event.params.id;
            if (!id || !isUuid(id)) {
                return ApiProblem.validationFailed('Invalid radio station ID');
            }

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const [existing] = await sql<{ id: string }[]>`
                SELECT id FROM media_items
                WHERE id = ${id} AND media_type = 'radio'
            `;
            if (!existing) return ApiProblem.notFound('Radio station not found');

            // Best-effort cleanup of stored artwork file/row
            try {
                await deleteMediaImage(sql, id, 'poster');
            } catch (err) {
                logger.warn('Artwork cleanup during radio delete failed', {
                    id,
                    error: err instanceof Error ? err.message : String(err),
                });
            }

            await sql`DELETE FROM media_items WHERE id = ${id}`;

            logger.info('Radio station deleted', { id });

            return json(RadioDeleteResponseSchema.parse({ deleted: true }));
        },
    },
});
