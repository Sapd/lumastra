// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/me/manual-runs?since=<ISO>
 *
 * The caller's own manually-started runs — live ones, plus those that finished
 * after `since` — for the app-wide tracker that shows their progress on every
 * page and a success/failure notice when they end, across navigation and full
 * reloads (the client keeps `since` per user).
 *
 * Auth: {kind:'user'} — self-only: rows are matched on the caller's own
 * username / user id, never a parameter. Surface: internal.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getTaskDb } from '$lib/server/database/connection.js';
import {
    listMyManualRuns,
    loadRunLibraryNames,
    type ManualRunRow,
} from '$lib/server/database/queries/my-manual-runs.queries.js';
import { orchestrator } from '$lib/server/tasks/orchestrator.js';
import { registry } from '$lib/server/tasks/registry.js';
import { ManualRunsResponseSchema, type ManualRun } from '$lib/schemas/manual-runs.js';
import { resolveRunMediaItems } from '$lib/server/api/defs/runs/index.js';
import { resolveScopeGatedAccessBoundary } from '$lib/server/utils/scope-gated-access-boundary.js';
import type { Run } from '@sapd/lumastra-plugin-sdk';
import { taskDisplayName } from '$lib/utils/admin/task-names.js';

const QuerySchema = z.object({
    since: z.string().min(1).optional(),
});

/** How far back a stale `since` may reach — older completions are not "news". */
const MAX_LOOKBACK_MS = 24 * 60 * 60 * 1000;
/** Window when no `since` is given (first visit: the client only records, never announces). */
const DEFAULT_LOOKBACK_MS = 10 * 60 * 1000;
/** A failure reason is a notice, not a log: cap what reaches the toast. */
const MAX_ERROR_CHARS = 300;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type StageProgress = { state?: string; processed?: number; total?: number };

/**
 * The progress of the stage doing the work. Live progress is merged into the
 * stage NUMBERS but not always into a stage's `state`, so prefer a stage whose
 * numbers say it is mid-way; then an `active` one; then the last with numbers.
 */
function stageProgress(stages: unknown): { processed?: number; total?: number } {
    if (!Array.isArray(stages) || stages.length === 0) return {};
    const withNumbers = (stages as StageProgress[]).filter(
        (s) => typeof s.total === 'number' && s.total > 0 && typeof s.processed === 'number',
    );
    const stage =
        withNumbers.find((s) => (s.processed ?? 0) < (s.total ?? 0)) ??
        withNumbers.find((s) => s.state === 'active') ??
        withNumbers[withNumbers.length - 1];
    return stage ? { processed: stage.processed, total: stage.total } : {};
}

function errorMessage(error: unknown): string | undefined {
    let message: unknown = error;
    if (error && typeof error === 'object') message = (error as { message?: unknown }).message;
    if (typeof message !== 'string' || message.length === 0) return undefined;
    return message.length > MAX_ERROR_CHARS ? `${message.slice(0, MAX_ERROR_CHARS)}…` : message;
}

function inputField(input: unknown, key: string): string | undefined {
    if (!input || typeof input !== 'object') return undefined;
    const value = (input as Record<string, unknown>)[key];
    return typeof value === 'string' ? value : undefined;
}

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',
    request: { query: QuerySchema },
    handlers: {
        GET: async (event) => {
            const user = event.locals.user;
            const userId =
                (event.locals.principal?.userId as string | undefined) ?? user?.userId ?? null;
            const username = event.locals.principal?.username ?? user?.username ?? null;
            if (!userId && !username) return ApiProblem.unauthorized();

            const sql = getTaskDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const now = Date.now();
            const sinceRaw = event.url.searchParams.get('since');
            const parsed = sinceRaw ? Date.parse(sinceRaw) : Number.NaN;
            const since = new Date(
                Math.max(
                    Number.isNaN(parsed) ? now - DEFAULT_LOOKBACK_MS : parsed,
                    now - MAX_LOOKBACK_MS,
                ),
            );

            const rows = await listMyManualRuns(
                sql,
                [userId, username].filter((v): v is string => !!v),
                since,
            );

            // Live runs: the DB row only carries progress at terminal transitions,
            // so read those through the orchestrator (live Valkey progress merged).
            const live = new Map<string, Run>();
            await Promise.all(
                rows
                    .filter(
                        (r) =>
                            r.state === 'pending' ||
                            r.state === 'active' ||
                            r.state === 'cancelling',
                    )
                    .map(async (r) => {
                        const run = await orchestrator.getRun(r.id).catch(() => null);
                        if (run) live.set(r.id, run);
                    }),
            );

            const groupIds = new Set<string>();
            const pathIds = new Set<string>();
            for (const r of rows) {
                const groupId = r.scope?.libraryGroupId;
                if (groupId && UUID_RE.test(groupId)) groupIds.add(groupId);
                const pathId = inputField(r.input, 'libraryPathId');
                if (pathId && UUID_RE.test(pathId)) pathIds.add(pathId);
            }
            const subjectRows = rows.filter(
                (r) => r.scope?.subjectId ?? inputField(r.input, 'mediaItemId'),
            );
            const [names, mediaItems] = await Promise.all([
                loadRunLibraryNames(sql, [...groupIds], [...pathIds]),
                subjectRows.length === 0
                    ? new Map<string, { title: string }>()
                    : resolveRunMediaItems(
                          sql,
                          subjectRows.map(
                              (r) =>
                                  ({
                                      scope: r.scope ?? undefined,
                                      input: r.input,
                                  }) as unknown as Run,
                          ),
                          await resolveScopeGatedAccessBoundary(sql, user),
                      ),
            ]);

            const detailFor = (r: ManualRunRow): string | undefined => {
                const pathId = inputField(r.input, 'libraryPathId');
                if (pathId && names.paths.has(pathId)) return names.paths.get(pathId);
                const groupId = r.scope?.libraryGroupId;
                if (groupId && names.groups.has(groupId)) return names.groups.get(groupId);
                const subject = r.scope?.subjectId ?? inputField(r.input, 'mediaItemId');
                return subject ? mediaItems.get(subject)?.title : undefined;
            };

            const runs: ManualRun[] = rows.map((r) => {
                const liveRun = live.get(r.id);
                const state = (liveRun?.state ?? r.state) as ManualRun['state'];
                const progress = stageProgress(liveRun?.stages ?? r.stages);
                return {
                    id: r.id,
                    parentRunId: r.parent_run_id ?? undefined,
                    taskId: r.task_id,
                    title: taskDisplayName(r.task_id, registry.getTask(r.task_id)?.name ?? r.label),
                    detail: detailFor(r),
                    state,
                    startedAt: r.started_at.toISOString(),
                    completedAt: r.completed_at?.toISOString(),
                    processed: progress.processed,
                    total: progress.total,
                    error: state === 'failed' ? errorMessage(r.error) : undefined,
                };
            });

            return json(
                ManualRunsResponseSchema.parse({ runs, serverTime: new Date(now).toISOString() }),
            );
        },
    },
});
