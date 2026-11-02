// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { json } from '@sveltejs/kit';
import { auditActor } from '$lib/server/utils/audit-log.js';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { adminMediaId } from '$lib/server/utils/admin-media-id.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    CandidateRoleSchema,
    CandidateMutationSchema,
    ImageCandidateResultSchema,
} from '$lib/schemas/image-candidates.js';
import { latestMediaChange } from '$lib/server/database/queries/admin-media-change.queries.js';
import { ArtworkChoiceConflict } from '$lib/server/services/artwork-choice.service.js';
import { listImageCandidates } from '$lib/server/database/queries/image-candidates.queries.js';
import {
    mutateImageCandidates,
    ImageCandidateConflict,
} from '$lib/server/services/image-candidates.service.js';

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        query: z.object({ role: CandidateRoleSchema.optional() }),
        queryMethods: ['GET'],
        bodyMethods: ['POST'],
        body: CandidateMutationSchema,
    },
    docs: {
        GET: {
            summary: 'List image candidates and provenance',
            tags: ['Admin'],
            description:
                'References only; no images are downloaded. Optional role filters candidates.',
            responses: { 200: { schema: ImageCandidateResultSchema } },
        },
        POST: {
            summary: 'Curate image candidates',
            tags: ['Admin'],
            description:
                'Choose artwork, return to automatic selection, hide a source across all image types, or restore a guarded receipt. Candidates and files are retained. Curation is audit logged.',
            responses: { 200: { schema: ImageCandidateResultSchema } },
        },
    },
    handlers: {
        GET: async (event) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable();
            const id = adminMediaId(event);
            if (!id) return ApiProblem.notFound('Media item');
            const role = CandidateRoleSchema.optional().safeParse(
                event.url.searchParams.get('role') ?? undefined,
            );
            if (!role.success) return ApiProblem.validationFailed('Invalid image role');
            return json(
                ImageCandidateResultSchema.parse({
                    candidates: await listImageCandidates(sql, id, role.data),
                    applied: false,
                    undoId: await latestMediaChange(sql, id, 'artwork'),
                }),
            );
        },
        POST: async (event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable();
            const id = adminMediaId(event);
            if (!id) return ApiProblem.notFound('Media item');
            const actor = auditActor(event);
            if (!actor.username) return ApiProblem.unauthorized();
            try {
                return json(
                    ImageCandidateResultSchema.parse(
                        await mutateImageCandidates(sql, id, ctx.input!.body, actor),
                    ),
                );
            } catch (error) {
                if (
                    error instanceof ImageCandidateConflict ||
                    error instanceof ArtworkChoiceConflict
                )
                    return ApiProblem.conflict(error.message);
                throw error;
            }
        },
    },
});
