// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Metadata Sync API Endpoint
 *
 * GET:  returns the job name (status probe).
 * POST: enqueues a metadata-sync job.
 *
 * Auth:    admin
 * Surface: internal
 *
 * GET  200 { jobName: string }
 * POST 200 { started: true, jobId: string }
 * 503 dependency_unavailable on orchestrator down.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { mount } from '$lib/server/api/mount.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { orchestrator } from '$lib/server/tasks/orchestrator.js';
import { z } from 'zod';
import { MetadataSyncOptionsSchema } from '$lib/schemas/ai-tasks.js';

const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        body: z.object({
            options: MetadataSyncOptionsSchema.partial().optional(),
        }),
    },
    handlers: {
        GET: async () => {
            return json({ jobName: 'metadata-sync' });
        },

        POST: async (event, ctx) => {
            const options = ctx.input?.body?.options ?? {};

            let result: Awaited<ReturnType<typeof orchestrator.startRun>>;
            try {
                result = await orchestrator.startRun('metadata-sync', options, {
                    trigger: {
                        kind: 'manual',
                        by: event.locals.user?.username,
                        sourceRoute: 'ai/sync-metadata',
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
