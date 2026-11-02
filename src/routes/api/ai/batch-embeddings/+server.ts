// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// API endpoint for OpenAI Batch Embeddings management
import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { mount } from '$lib/server/api/mount.js';
import { batchEmbeddingsBodySchema } from '$lib/schemas/ai';

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

const BatchRequestCountsSchema = z.object({
    total: z.number(),
    completed: z.number(),
    failed: z.number(),
});

const BatchJobMetadataSchema = z.object({
    created_at: z.number(),
});

const BatchJobSchema = z.object({
    id: z.string(),
    status: z.string(),
    requestCounts: BatchRequestCountsSchema,
    metadata: BatchJobMetadataSchema,
    created_at_formatted: z.string(),
    progress_percentage: z.number(),
});

const BatchJobsListResponseSchema = z.object({
    jobs: z.array(BatchJobSchema),
});

const BatchJobProgressResponseSchema = BatchJobSchema;

/**
 * OpenAI batch result item.
 *
 * The `response.body` field is the raw OpenAI response body whose exact schema
 * varies by request type (embeddings, chat, etc.). We expose the known structural
 * envelope; the inner body is an opaque provider object.
 *
 * This is a deliberate boundary exception: we are reflecting a third-party
 * provider API response whose schema we do not own and which changes independently.
 */
const BatchResultItemSchema = z.object({
    id: z.string().optional(),
    custom_id: z.string().optional(),
    response: z
        .object({
            status_code: z.number().optional(),
            // OpenAI batch response body — provider-opaque; structure varies by endpoint type.
            body: z
                .object({
                    object: z.string().optional(),
                    model: z.string().optional(),
                    usage: z
                        .object({
                            prompt_tokens: z.number().optional(),
                            total_tokens: z.number().optional(),
                        })
                        .optional(),
                })
                .optional(),
        })
        .optional(),
    error: z
        .object({
            code: z.string().optional(),
            message: z.string().optional(),
        })
        .nullable()
        .optional(),
});

const BatchResultsResponseSchema = z.object({
    batchId: z.string(),
    resultCount: z.number(),
    results: z.array(BatchResultItemSchema),
    hasMore: z.boolean(),
});

const BatchCancelResponseSchema = z.object({
    message: z.string(),
});

// ---------------------------------------------------------------------------
// Query schema for GET
// ---------------------------------------------------------------------------

const BatchEmbeddingsQuerySchema = z.object({
    action: z.enum(['list', 'progress', 'results']).optional().default('list'),
    batchId: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional().default(10),
});

// ---------------------------------------------------------------------------
// Endpoint definition
// ---------------------------------------------------------------------------

const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        query: BatchEmbeddingsQuerySchema,
        body: batchEmbeddingsBodySchema,
    },
    handlers: {
        GET: async (_event, ctx) => {
            const { action, batchId, limit } = ctx.input!.query;
            const { listBatchJobs, getBatchJobProgress, getBatchResults } =
                await import('$lib/server/ai/batch-embeddings');

            if (action === 'list') {
                const jobs = await listBatchJobs(limit);

                return json(
                    BatchJobsListResponseSchema.parse({
                        jobs: jobs.map((job) => ({
                            ...job,
                            created_at_formatted: new Date(
                                job.metadata.created_at * 1000,
                            ).toISOString(),
                            progress_percentage:
                                job.requestCounts.total > 0
                                    ? Math.round(
                                          (job.requestCounts.completed / job.requestCounts.total) *
                                              100,
                                      )
                                    : 0,
                        })),
                    }),
                );
            }

            if (action === 'progress') {
                if (!batchId) {
                    return ApiProblem.validationFailed([
                        { field: 'batchId', message: 'batchId is required for action=progress' },
                    ]);
                }
                const progress = await getBatchJobProgress(batchId);
                if (!progress) {
                    return ApiProblem.notFound('Batch job not found');
                }

                return json(
                    BatchJobProgressResponseSchema.parse({
                        ...progress,
                        created_at_formatted: new Date(
                            progress.metadata.created_at * 1000,
                        ).toISOString(),
                        progress_percentage:
                            progress.requestCounts.total > 0
                                ? Math.round(
                                      (progress.requestCounts.completed /
                                          progress.requestCounts.total) *
                                          100,
                                  )
                                : 0,
                    }),
                );
            }

            if (action === 'results') {
                if (!batchId) {
                    return ApiProblem.validationFailed([
                        { field: 'batchId', message: 'batchId is required for action=results' },
                    ]);
                }
                const results = await getBatchResults(batchId);
                if (!results) {
                    return ApiProblem.notFound('Batch results not found');
                }

                return json(
                    BatchResultsResponseSchema.parse({
                        batchId,
                        resultCount: results.length,
                        // Limit response size — return first 100 results
                        results: results.slice(0, 100),
                        hasMore: results.length > 100,
                    }),
                );
            }

            // Should not be reachable due to enum validation, but be explicit
            return ApiProblem.validationFailed([{ field: 'action', message: 'Invalid action' }]);
        },

        POST: async (_event, ctx) => {
            const { action, batchId } = ctx.input!.body;
            const { cancelBatchJob } = await import('$lib/server/ai/batch-embeddings');

            if (action === 'cancel') {
                const success = await cancelBatchJob(batchId);

                if (success) {
                    return json(
                        BatchCancelResponseSchema.parse({
                            message: 'Batch job cancelled successfully',
                        }),
                    );
                } else {
                    return ApiProblem.dependencyUnavailable('Failed to cancel batch job');
                }
            }

            // Should not be reachable due to enum validation
            return ApiProblem.validationFailed([{ field: 'action', message: 'Invalid action' }]);
        },
    },
});

const { GET, POST } = mount(def, { surface: 'internal' });
export { GET, POST };
