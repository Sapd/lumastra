// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// API endpoint for resetting embeddings
import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { mount } from '$lib/server/api/mount.js';
import { Logger } from '$lib/server/utils/logger';
import { aiDbService } from '$lib/server/services/database.service';
import { deleteProviderMetadataByProviders } from '$lib/server/database/queries/ai-admin.queries.js';
import { orchestrator } from '$lib/server/tasks/orchestrator.js';
import { resetEmbeddingsBodySchema } from '$lib/schemas/ai';

const logger = Logger.for('ResetEmbeddings');

const ResetEmbeddingsResponseSchema = z.object({
    type: z.string(),
    // Present for synchronous resets (tmdb). Embedding resets run as a
    // background task, so they report `started` + `run_id` instead.
    deleted_count: z.number().optional(),
    started: z.boolean().optional(),
    run_id: z.string().optional(),
    message: z.string(),
});

const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        body: resetEmbeddingsBodySchema,
    },
    handlers: {
        POST: async (event, ctx) => {
            const { type } = ctx.input!.body;

            const sql = await aiDbService.getSql();
            if (!sql) {
                return ApiProblem.dependencyUnavailable(
                    'AI admin database is currently unavailable',
                );
            }

            logger.info('Starting embedding reset', { type });

            if (type === 'tmdb') {
                // Reset TMDB metadata from provider_metadata table. Kept
                // synchronous (smaller table, no embedding artifact).
                //
                // NOTE / known gap: regeneration of provider_metadata is
                // driven by the metadata stages' stage-state, which are
                // re-enrolled only by `identity.*` events — NOT by a
                // provider_metadata delete. So a bare delete here leaves
                // `tmdb-metadata-sync` (movies) / `series-sync` /
                // `mdblist-sync` `completed`, and metadata is not
                // re-fetched automatically. This is the same bug class as
                // the embedding reset below; fixing it correctly needs the
                // full movie/series/mdblist stage mapping and is tracked
                // separately. The embedding sources (library/discovery/all)
                // ARE fixed — they re-enroll atomically via the
                // `embedding-reset` task.
                const result = await deleteProviderMetadataByProviders(sql, [
                    'tmdb',
                    'aggregated',
                    'mdblist',
                ]);
                logger.info('Reset TMDB metadata', { deletedCount: result.deletedCount });

                return json(
                    ResetEmbeddingsResponseSchema.parse({
                        type,
                        deleted_count: result.deletedCount,
                        message: `Successfully reset ${result.deletedCount} ${type} metadata rows`,
                    }),
                );
            }

            // library | discovery | all → background task. The task
            // deletes the embedding artifacts AND re-enrolls the matching
            // stage(s) atomically, so the missingOnly generators actually
            // rebuild them (the prior inline path deleted embeddings but
            // left stage-state `completed`, permanently orphaning them —
            // and timed out on large sources before committing at all).
            const run = await orchestrator.startRun(
                'embedding-reset',
                { source: type },
                {
                    trigger: {
                        kind: 'manual',
                        by: event.locals.user?.username,
                        sourceRoute: 'ai/reset-embeddings',
                    },
                },
            );

            logger.info('Enqueued embedding reset task', { type, runId: run.runId });

            return json(
                ResetEmbeddingsResponseSchema.parse({
                    type,
                    started: true,
                    run_id: run.runId,
                    message: `Reset of ${type} embeddings started — they will be deleted and regenerated in the background.`,
                }),
            );
        },
    },
});

const { POST } = mount(def, { surface: 'internal' });
export { POST };
