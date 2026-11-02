// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MDBList Sync API Endpoint (BullMQ)
 *
 * Manages MDBList sync via BullMQ job queue.
 * Job processed by embedding-processor wrapping MDBListSyncGenerator.
 *
 * GET                    → { jobName }
 * GET ?status=true       → sync status with DB stats + API availability flag
 * GET ?raw=true          → raw samples from database
 * POST                   → enqueue mdblist-sync job
 *
 * Auth:    admin
 * Surface: internal
 *
 * 503 dependency_unavailable on DB/orchestrator down.
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { mount } from '$lib/server/api/mount.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { orchestrator } from '$lib/server/tasks/orchestrator.js';
import { getMDBListSyncStatus, getMDBListRawSamples } from '$lib/server/ai/mdblist-sync';
import { mdblistApi } from '$lib/server/services/mdblist-api';
import { MdblistSyncOptionsSchema } from '$lib/schemas/ai-tasks.js';

const MDBLIST_SYNC_JOB = 'mdblist-sync';

// ---------------------------------------------------------------------------
// Query schema
// ---------------------------------------------------------------------------

const GetQuerySchema = z.object({
    status: z.enum(['true', 'false']).optional(),
    raw: z.enum(['true', 'false']).optional(),
});

// ---------------------------------------------------------------------------
// Raw sample item schema (mirrors MDBListRawSampleRow from mdblist-sync.ts)
// ---------------------------------------------------------------------------

const RawSampleSchema = z.object({
    tmdb_id: z.number(),
    title: z.string(),
    media_type: z.string(),
    release_date: z.string().nullable(),
    genres: z.array(z.string()).nullable(),
    imdb_id: z.string().nullable(),
    imdb_rating: z.union([z.number(), z.string()]).nullable(),
    rt_rating: z.number().nullable(),
    certification: z.string().nullable(),
    runtime_minutes: z.number().nullable(),
    actors: z.array(z.string()).nullable(),
    directors: z.array(z.string()).nullable(),
    mdblist_score: z.number().nullable(),
    letterboxd_rating: z.union([z.number(), z.string()]).nullable(),
    letterboxd_votes: z.number().nullable(),
    metacritic_score: z.number().nullable(),
    rt_audience_score: z.number().nullable(),
    trakt_score: z.number().nullable(),
    mal_score: z.union([z.number(), z.string()]).nullable(),
    mal_votes: z.number().nullable(),
    streaming_services: z.array(z.string()).nullable(),
    anime_genres: z.array(z.string()).nullable(),
    mdblist_keywords: z.array(z.string()).nullable(),
    mdblist_last_updated: z.union([z.date(), z.string()]).nullable(),
});

// ---------------------------------------------------------------------------
// Sync status schema (mirrors getMDBListSyncStatus return shape + apiConfigured)
// ---------------------------------------------------------------------------

const SyncStatusSchema = z.object({
    apiConfigured: z.boolean(),
    total_items: z.number(),
    with_mdblist: z.number(),
    without_mdblist: z.number(),
    stale_data: z.number(),
    coverage_percent: z.number(),
    movies_without: z.number(),
    tv_without: z.number(),
    samples: z
        .array(
            z.object({
                tmdb_id: z.number(),
                title: z.string(),
                media_type: z.string(),
                year: z.number().nullable(),
                mdblist_score: z.number().nullable(),
                imdb_rating: z.number().nullable(),
                letterboxd_rating: z.number().nullable(),
                letterboxd_votes: z.number().nullable(),
                metacritic_score: z.number().nullable(),
                rt_rating: z.number().nullable(),
                rt_audience_score: z.number().nullable(),
                trakt_score: z.number().nullable(),
                mal_score: z.number().nullable(),
                mal_votes: z.number().nullable(),
                streaming_services: z.array(z.string()).nullable(),
                anime_genres: z.array(z.string()).nullable(),
                mdblist_keywords: z.array(z.string()).nullable(),
            }),
        )
        .optional(),
});

// ---------------------------------------------------------------------------
// POST body schema — typed options forwarded to the mdblist-sync task
// ---------------------------------------------------------------------------

const PostBodySchema = z.object({
    options: MdblistSyncOptionsSchema.partial().optional(),
});

// ---------------------------------------------------------------------------
// Def
// ---------------------------------------------------------------------------

const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        query: GetQuerySchema,
        body: PostBodySchema,
    },
    handlers: {
        GET: async (_event, ctx) => {
            const statusOnly = ctx.input?.query?.status === 'true';
            const rawSamples = ctx.input?.query?.raw === 'true';

            if (rawSamples) {
                let samples: Awaited<ReturnType<typeof getMDBListRawSamples>>;
                try {
                    samples = await getMDBListRawSamples();
                } catch (err) {
                    return ApiProblem.dependencyUnavailable(
                        err instanceof Error ? err.message : 'Failed to get raw samples',
                    );
                }
                // Validate output shape — strips any unexpected DB fields
                const parsed = z.array(RawSampleSchema).safeParse(samples);
                if (!parsed.success) {
                    return ApiProblem.internalError('Unexpected raw sample shape from database');
                }
                return json({ rawSamples: parsed.data });
            }

            if (statusOnly) {
                let status: Awaited<ReturnType<typeof getMDBListSyncStatus>>;
                try {
                    status = await getMDBListSyncStatus();
                } catch (err) {
                    return ApiProblem.dependencyUnavailable(
                        err instanceof Error ? err.message : 'Failed to get sync status',
                    );
                }
                const parsed = SyncStatusSchema.safeParse({
                    apiConfigured: mdblistApi.isAvailable(),
                    ...status,
                });
                if (!parsed.success) {
                    return ApiProblem.internalError('Unexpected sync status shape from service');
                }
                return json(parsed.data);
            }

            return json({ jobName: MDBLIST_SYNC_JOB });
        },

        POST: async (event, ctx) => {
            const options = ctx.input?.body?.options ?? {};

            let result: Awaited<ReturnType<typeof orchestrator.startRun>>;
            try {
                result = await orchestrator.startRun(MDBLIST_SYNC_JOB, options, {
                    trigger: {
                        kind: 'manual',
                        by: event.locals.user?.username,
                        sourceRoute: 'ai/sync-mdblist',
                    },
                });
            } catch (err) {
                return ApiProblem.dependencyUnavailable(
                    err instanceof Error ? err.message : 'Orchestrator unavailable',
                );
            }

            return json({ started: true, jobId: result.runId });
        },
    },
});

export const { GET, POST } = mount(def, { surface: 'internal' });
