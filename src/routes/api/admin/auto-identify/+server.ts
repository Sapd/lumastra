// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Auto-Identify Personal Media API Endpoint
 *
 * GET  — Returns the job name (used by the admin UI to identify the task).
 * POST — Triggers the auto-identify-personal-media task with optional options.
 *
 * Auth: tasks:admin. Surface: internal.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { mount } from '$lib/server/api/mount.js';
import { orchestrator } from '$lib/server/tasks/orchestrator.js';
import { autoIdentifyPostBodySchema } from '$lib/schemas/admin.js';

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['tasks:admin'] },
    visibility: 'internal',
    request: {
        body: autoIdentifyPostBodySchema,
    },
    handlers: {
        GET: async () => {
            return json({ jobName: 'auto-identify-personal-media' });
        },

        POST: async (event, ctx) => {
            const options = ctx.input!.body?.options ?? {};

            const result = await orchestrator.startRun('auto-identify-personal-media', options, {
                trigger: {
                    kind: 'manual',
                    by: event.locals.user?.username,
                    sourceRoute: 'admin/auto-identify',
                },
                priority: 1,
            });

            return json({ started: true, jobId: result.runId });
        },
    },
});

export const { GET, POST } = mount(def, { surface: 'internal' });
