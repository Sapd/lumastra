// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/admin/worker-status
 *
 * Is a background worker available to process scans/metadata/recommendations?
 * Surfaced in onboarding so a fresh deploy with no worker does not silently fail.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { getBackgroundWorkerStatus } from '$lib/server/services/worker-status.js';

const WorkerStatusResponseSchema = z.object({
    available: z.boolean(),
    source: z.string(),
    detail: z.string().optional(),
    reasons: z.array(z.string()).optional(),
});

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    handlers: {
        GET: async (_event, _ctx) => {
            const status = await getBackgroundWorkerStatus();
            return json(
                WorkerStatusResponseSchema.parse({
                    available: status.available,
                    source: status.source,
                    detail: status.detail,
                    reasons: status.reasons,
                }),
            );
        },
    },
});
