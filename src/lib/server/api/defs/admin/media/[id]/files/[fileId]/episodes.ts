// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/media/[id]/files/[fileId]/episodes.ts
 *
 * GET    /api/admin/media/[id]/files/[fileId]/episodes — the file's episode links
 *        in file order, its chapters and the episodes of [id]'s series.
 * PUT    — link the file to an ordered list of episodes with a window each, by
 *        hand. Survives rescans and segment refreshes (manual-file-links.service).
 * DELETE — hand the file back to automatic segments (links stay).
 *
 * [id] is the media item whose Files tab the admin is in (series, season or
 * episode); it fixes the series the episodes must come from.
 *
 * Auth: admin.  Surface: internal-only.
 * 404 unknown item/file; 422 invalid list or windows; 503 when the DB is down.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { adminMediaId } from '$lib/server/utils/admin-media-id.js';
import { isUuid } from '$lib/server/utils/media-key-parser.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    getFileEpisodeEditorData,
    resolveSeriesIdForItem,
} from '$lib/server/database/queries/manual-file-links.queries.js';
import {
    undoManualFileEpisodes,
    clearReviewedManualFileEpisodes,
    setManualFileEpisodes,
} from '$lib/server/services/manual-file-links.service.js';
import {
    FileEpisodesResponseSchema,
    SetFileEpisodesRequestSchema,
} from '$lib/schemas/admin-file-episodes.js';
import type { ManualWindow } from '$lib/shared/manual-file-segments.js';
import type postgres from 'postgres';
import { latestMediaChange } from '$lib/server/database/queries/admin-media-change.queries.js';
import { auditActor } from '$lib/server/utils/audit-log.js';

async function respond(sql: postgres.Sql, fileId: string, seriesId: string): Promise<Response> {
    const data = await getFileEpisodeEditorData(sql, fileId, seriesId);
    if (!data) return ApiProblem.notFound('File not found');
    return json(
        FileEpisodesResponseSchema.parse({
            ...data,
            undoId: await latestMediaChange(sql, seriesId, `file-mapping:${fileId}`),
        }),
    );
}

interface Scope {
    sql: postgres.Sql;
    fileId: string;
    seriesId: string;
}

async function scope(event: {
    params: Partial<Record<string, string>>;
}): Promise<Scope | Response> {
    const sql = getDb();
    if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');
    const internalId = adminMediaId(event);
    const fileId = event.params.fileId;
    if (!internalId || !fileId || !isUuid(fileId)) return ApiProblem.notFound('File not found');
    const seriesId = await resolveSeriesIdForItem(sql, internalId);
    if (!seriesId) return ApiProblem.notFound('Not part of a series');
    return { sql, fileId, seriesId };
}

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        // Partial: the same def serves DELETE, whose empty body decodes to {}.
        body: SetFileEpisodesRequestSchema.partial(),
    },
    handlers: {
        GET: async (event) => {
            const s = await scope(event);
            if (s instanceof Response) return s;
            return respond(s.sql, s.fileId, s.seriesId);
        },
        PUT: async (event, ctx) => {
            const s = await scope(event);
            if (s instanceof Response) return s;

            if (ctx.input!.body.undoReceiptId) {
                const result = await undoManualFileEpisodes(
                    s.sql,
                    s.fileId,
                    s.seriesId,
                    ctx.input!.body.undoReceiptId,
                );
                if (!result.ok)
                    return ApiProblem.conflict(
                        'The file or mapping changed. Reload before undoing.',
                    );
                return respond(s.sql, s.fileId, s.seriesId);
            }
            const entries = ctx.input!.body.episodes;
            const revision = ctx.input!.body.revision;
            if (!revision) return ApiProblem.conflict('Reload the file mapping before saving.');
            if (!entries) return ApiProblem.validationFailed('episodes is required.');
            const withWindow = entries.filter(
                (e) => e.startMs !== undefined && e.endMs !== undefined,
            );
            if (withWindow.length !== 0 && withWindow.length !== entries.length) {
                return ApiProblem.validationFailed('Give every episode a window, or none.');
            }
            const windows: ManualWindow[] | null =
                withWindow.length === 0
                    ? null
                    : entries.map((e) => ({
                          startMs: e.startMs!,
                          endMs: e.endMs!,
                          boundaryOrigin: e.boundaryOrigin,
                      }));

            const result = await setManualFileEpisodes(
                s.sql,
                s.fileId,
                entries.map((e) => e.mediaItemId),
                windows,
                {
                    seriesId: s.seriesId,
                    revision,
                    actor: auditActor(event),
                    restoreDismissedEpisodeIds: ctx.input!.body.restoreDismissedEpisodeIds,
                },
            );
            if (!result.ok) {
                return result.reason === 'file_not_found'
                    ? ApiProblem.notFound('File not found')
                    : result.reason === 'conflict'
                      ? ApiProblem.conflict(
                            'The file mapping changed. Reload it and review your draft before saving.',
                        )
                      : ApiProblem.validationFailed(result.message);
            }
            return respond(s.sql, s.fileId, s.seriesId);
        },
        DELETE: async (event, ctx) => {
            const s = await scope(event);
            if (s instanceof Response) return s;
            const revision = ctx.input!.body.revision;
            if (!revision) return ApiProblem.conflict('Reload the file mapping before resetting.');
            const result = await clearReviewedManualFileEpisodes(s.sql, s.fileId, {
                seriesId: s.seriesId,
                revision,
                actor: auditActor(event),
            });
            if (!result.ok) {
                return result.reason === 'file_not_found'
                    ? ApiProblem.notFound('File not found')
                    : ApiProblem.conflict(
                          'The file mapping changed. Reload it and review before resetting.',
                      );
            }
            return respond(s.sql, s.fileId, s.seriesId);
        },
    },
});
