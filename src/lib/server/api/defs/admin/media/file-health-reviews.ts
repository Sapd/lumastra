// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    FileHealthReviewRequestSchema,
    FileHealthReviewResponseSchema,
} from '$lib/schemas/file-health-review.js';
import {
    FileHealthReviewError,
    previewFileHealthReview,
    writeFileHealthReview,
} from '$lib/server/services/file-health-review.service.js';
export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: { body: FileHealthReviewRequestSchema, maxBodyBytes: 24576 },
    handlers: {
        POST: async (event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');
            const actor = event.locals.principal?.username ?? event.locals.user?.username;
            if (!actor) return ApiProblem.unauthorized();
            const request = ctx.input!.body;
            try {
                const result =
                    request.action === 'preview'
                        ? {
                              action: 'preview',
                              preview: await previewFileHealthReview(sql, request.fileId),
                          }
                        : request.action === 'confirm'
                          ? {
                                action: 'confirm',
                                reviewed: await writeFileHealthReview(
                                    sql,
                                    request,
                                    actor,
                                    event.locals.principal
                                        ? {
                                              userId: event.locals.principal.userId,
                                              kind: event.locals.principal.kind,
                                              credentialId: event.locals.principal.credentialId,
                                          }
                                        : undefined,
                                ),
                            }
                          : {
                                action: 'revoke',
                                revoked: await writeFileHealthReview(
                                    sql,
                                    request,
                                    actor,
                                    event.locals.principal
                                        ? {
                                              userId: event.locals.principal.userId,
                                              kind: event.locals.principal.kind,
                                              credentialId: event.locals.principal.credentialId,
                                          }
                                        : undefined,
                                ),
                            };
                return json(FileHealthReviewResponseSchema.parse(result));
            } catch (error) {
                if (!(error instanceof FileHealthReviewError)) throw error;
                if (error.kind === 'missing') return ApiProblem.notFound(error.message);
                if (error.kind === 'conflict') return ApiProblem.conflict(error.message);
                return ApiProblem.validationFailed(error.message);
            }
        },
    },
});
