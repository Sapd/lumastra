// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/system/restart-safety.ts
 *
 * GET /api/v1/admin/system/restart-safety
 *
 * "Safe to restart?" — one honest verdict for the operator about to run
 * `docker compose up -d`: is anything in progress, and if so will
 * restarting delay it or actually lose it.
 *
 * Built entirely from existing signals, no new state:
 *   - `registry.getAllTasks()` + `getTaskLaneData()` (the same pair the task
 *     catalog endpoint uses) for what's currently active, per task.
 *   - `TaskDefinition.coversStages` to tell "per-item durable, will resume"
 *     work apart from single-pass work that restarts from zero if killed.
 *   - The `task:pending-writes` Valkey list depth (same source the health
 *     page's pendingWriteDrain component reads) — always resumable, per
 *     `pending-write-drain.ts`'s crash-safe claim/ack design.
 *
 * `status: 'unknown'` only when the task database is unreachable — that is
 * the one case where "safe" cannot be established at all.
 *
 * Auth: admin.
 * Surface: internal-only (human-dashboard indicator, no automation value).
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { registry } from '$lib/server/tasks/registry.js';
import { getTaskLaneData } from '$lib/server/tasks/lane-data.js';
import { getCoordinationClient } from '$lib/server/cache/valkey.js';
import { Logger } from '$lib/server/utils/logger.js';
import {
    RestartSafetyResponseSchema,
    type RestartSafetyItem,
} from '$lib/schemas/admin-restart-safety.schema.js';

const log = Logger.for('api.admin.system.restart-safety');

/** `null` = the queue could not be read; never report that as "nothing pending". */
async function getPendingWriteDepth(): Promise<number | null> {
    try {
        const client = getCoordinationClient();
        if (!client) return null;
        const depth = Number(await client.customCommand(['LLEN', 'task:pending-writes']));
        return Number.isFinite(depth) && depth > 0 ? depth : 0;
    } catch (err) {
        log.warn('restart-safety: pending-write depth probe failed (best-effort)', {
            err: err instanceof Error ? err.message : String(err),
        });
        return null;
    }
}

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Admin'],
            summary: 'Check whether it is safe to restart the instance right now',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Reports whether anything is currently in progress, whether restarting would ' +
                'only delay it (per-item durable work that resumes automatically) or actually ' +
                'discard it (single-pass work with no checkpoint), and how long that work has ' +
                'been running. Also reports the depth of the crash-safe pending-write queue, ' +
                'which is never lost — only delayed.',
            responses: {
                200: {
                    schema: RestartSafetyResponseSchema,
                    description: 'Restart-safety verdict',
                },
                401: 'Authentication required',
                403: 'Admin access required',
                500: 'Internal server error',
            },
        },
    },
    handlers: {
        GET: async () => {
            const isProd = process.env.NODE_ENV === 'production';
            const rawTasks = registry.getAllTasks().filter((t) => !isProd || !t.demo);
            const ids = rawTasks.map((t) => t.id);

            const stagesByTask = new Map<string, string[]>();
            for (const t of rawTasks) {
                const covered = t.coversStages;
                if (covered && covered.length > 0) {
                    stagesByTask.set(
                        t.id,
                        covered.map((s) => s.id),
                    );
                }
            }

            const [laneMap, pendingDepth] = await Promise.all([
                getTaskLaneData(ids, stagesByTask),
                getPendingWriteDepth(),
            ]);

            const generatedAt = new Date().toISOString();
            const pendingWrites = pendingDepth ?? 0;

            // Task database unreachable — the one case where we genuinely
            // cannot tell whether it's safe. Still report pendingWrites since
            // that reads from Valkey, a separate dependency.
            if (!laneMap) {
                return json(
                    RestartSafetyResponseSchema.parse({
                        generatedAt,
                        status: 'unknown',
                        pendingWrites,
                        items: [],
                    }),
                );
            }

            const items: RestartSafetyItem[] = [];
            for (const t of rawTasks) {
                const lane = laneMap.get(t.id);
                if (!lane || lane.activeCount <= 0) continue;

                const resumable = Boolean(t.coversStages && t.coversStages.length > 0);
                const elapsedMs = lane.lastStartedAt
                    ? Math.max(0, Date.now() - new Date(lane.lastStartedAt).getTime())
                    : 0;
                const etaMs =
                    lane.itemsPerHour && lane.itemsPerHour > 0 && lane.backlogRemaining > 0
                        ? Math.round((lane.backlogRemaining / lane.itemsPerHour) * 3_600_000)
                        : null;

                items.push({
                    taskId: t.id,
                    taskName: t.name,
                    resourceClass: t.resourceClass,
                    activeCount: lane.activeCount,
                    elapsedMs,
                    resumable,
                    backlogRemaining: lane.backlogRemaining > 0 ? lane.backlogRemaining : undefined,
                    unitLabel: t.backlog?.unitLabel,
                    etaMs,
                });
            }

            items.sort((a, b) => b.elapsedMs - a.elapsedMs);

            const hasLossy = items.some((i) => !i.resumable);
            const hasWait = items.some((i) => i.resumable) || pendingWrites > 0;
            // An unreadable pending-write queue can never yield 'safe'.
            const status = hasLossy
                ? 'lossy'
                : hasWait
                  ? 'wait'
                  : pendingDepth === null
                    ? 'unknown'
                    : 'safe';

            return json(
                RestartSafetyResponseSchema.parse({
                    generatedAt,
                    status,
                    pendingWrites,
                    items,
                }),
            );
        },
    },
});
