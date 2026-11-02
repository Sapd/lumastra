// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/admin/ingest/queue-depths
 *
 * Returns the current per-resource-class queue snapshot: active count,
 * waiting (prioritized) count, configured concurrency cap, paused flag.
 * Powers the worker-pool section in the Ingest Map station tooltip.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { Logger } from '$lib/server/utils/logger.js';

const log = Logger.for('api.admin.ingest.queue-depths');

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    handlers: {
        GET: async (_event, _ctx) => {
            try {
                const { orchestrator } = await import('$lib/server/tasks/orchestrator.js');
                const [depths, caps, perTask] = await Promise.all([
                    orchestrator.getQueueDepths(),
                    Promise.resolve(orchestrator.getConcurrencyCaps()),
                    orchestrator.getPerTaskQueueDepths(),
                ]);
                const queueDepths = Object.entries(depths).map(([cls, info]) => ({
                    resourceClass: cls,
                    active: info.active,
                    waiting: info.waiting,
                    concurrencyCap: caps[cls as keyof typeof caps] ?? 0,
                    paused: info.paused,
                }));
                return json({ queueDepths, perTask, error: null });
            } catch (err) {
                // Mirror the page-server contract: return an empty array with the
                // error message so the client can render "queue info unavailable"
                // instead of silently hiding the tooltip section.
                const msg = err instanceof Error ? err.message : String(err);
                log.warn('Failed to read queue depths', { err: msg });
                return json({ queueDepths: [], error: msg });
            }
        },
    },
});
