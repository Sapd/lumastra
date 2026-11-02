// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Music Embedding Generation API Endpoint
 */

import { readBoundedJson } from '$lib/server/utils/bounded-body-reader.js';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { mount } from '$lib/server/api/mount.js';
import { orchestrator } from '$lib/server/tasks/orchestrator.js';
import { z } from 'zod';

const JobNameResponseSchema = z.object({ jobName: z.string() });

const TaskStartedResponseSchema = z.object({
    started: z.boolean(),
    jobId: z.string(),
});

const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    handlers: {
        GET: async () => {
            return json(JobNameResponseSchema.parse({ jobName: 'music-embedding-generation' }));
        },

        POST: async (event) => {
            // Options are passed through to the orchestrator as-is; the set of
            // valid keys is task-specific and not enumerable at the API layer.
            let options: Record<string, unknown> = {};
            try {
                const body = (await readBoundedJson(event.request)) as Record<string, unknown>;
                if (body.options && typeof body.options === 'object') {
                    options = body.options as Record<string, unknown>;
                }
            } catch {
                /* no body — proceed with empty options */
            }

            const result = await orchestrator.startRun('music-embedding-generation', options, {
                trigger: {
                    kind: 'manual',
                    by: event.locals.user?.username,
                    sourceRoute: 'ai/generate-music-embeddings',
                },
            });

            return json(TaskStartedResponseSchema.parse({ started: true, jobId: result.runId }));
        },
    },
});

const { GET, POST } = mount(def, { surface: 'internal' });
export { GET, POST };
