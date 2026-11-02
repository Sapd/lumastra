// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/system/change-timeline.ts
 *
 * GET /api/v1/admin/system/change-timeline
 *
 * "What changed?" — the admin-caused changes an operator would want to
 * correlate against a failure timeline: config saves, task pause/resume,
 * licensing, cache clears, plugin installs, secret rotation. Reads the real
 * `audit_log` (source='admin') table via `listAdminAuditFeed` — no new
 * writer, no new table.
 *
 * Does NOT include app-version changes: there is no persisted history of
 * the running version over time (`config.APP_VERSION` is a boot-time value,
 * never written to a table with a timestamp). `versionTrackingAvailable` is
 * `false` on every response so the UI states that gap plainly instead of
 * inventing a version row. See the response schema's module doc for detail.
 *
 * Query params:
 *   sinceHours — lookback window (default 168 = 7 days, clamped 1..720)
 *
 * Auth: admin.
 * Surface: internal-only (human-dashboard correlation view, no automation value).
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { listAdminAuditFeed } from '$lib/server/database/queries/admin-audit.queries.js';
import { registry } from '$lib/server/tasks/registry.js';
import { getConfigForAdmin } from '$lib/server/config/index.js';
import { Logger } from '$lib/server/utils/logger.js';
import {
    ChangeTimelineResponseSchema,
    type ChangeTimelineEvent,
    type ChangeTimelineEventKind,
} from '$lib/schemas/admin-change-timeline.schema.js';
import { taskDisplayName } from '$lib/utils/admin/task-names.js';

const log = Logger.for('api.admin.system.change-timeline');

// The subset of admin-audit actions that plausibly explain "it worked last
// week": config saves, task enable/disable, licensing, cache clears, plugin
// installs, secret rotation. Deliberately excludes user-management, session,
// and run-control actions — those don't change SYSTEM behaviour going
// forward the way these do.
const RELEVANT_ACTIONS = [
    'settings.save',
    'task.pause',
    'task.resume',
    'task.settings.update',
    'licensing.*',
    'cache.clear',
    'plugin.external.*',
    'secret.rotate',
];

const MAX_CHANGED_LABELS = 6;
const MAX_EVENTS = 100;

function classify(action: string): ChangeTimelineEventKind {
    if (action === 'settings.save') return 'settings';
    if (action === 'task.pause') return 'task-pause';
    if (action === 'task.resume') return 'task-resume';
    if (action === 'task.settings.update') return 'task-settings';
    if (action.startsWith('licensing.')) return 'licensing';
    if (action.startsWith('cache.')) return 'cache';
    if (action.startsWith('plugin.')) return 'plugin';
    if (action.startsWith('secret.')) return 'secret';
    return 'other';
}

/** Best-effort settingKey → admin-facing label map. Falls back to raw keys on failure. */
function loadSettingLabels(): Map<string, string> {
    const map = new Map<string, string>();
    try {
        const { schema } = getConfigForAdmin();
        for (const setting of schema.settings) {
            map.set(setting.key, setting.label);
        }
    } catch (err) {
        log.warn('change-timeline: config schema unavailable for setting labels (best-effort)', {
            err: err instanceof Error ? err.message : String(err),
        });
    }
    return map;
}

const QuerySchema = z.object({
    sinceHours: z.coerce.number().int().positive().max(720).optional(),
});

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    request: { query: QuerySchema },
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Admin'],
            summary: 'List recent admin-caused changes for failure correlation',
            stability: 'stable',
            auth: 'bearer',
            query: QuerySchema,
            description:
                'Config saves, task pause/resume, licensing, cache clears, plugin installs and ' +
                'secret rotations from the real admin audit trail, for overlaying onto a failure ' +
                'timeline. Does not include app-version changes — those are not currently tracked ' +
                '(`versionTrackingAvailable: false`).',
            responses: {
                200: {
                    schema: ChangeTimelineResponseSchema,
                    description: 'Recent admin-caused changes, newest first',
                },
                401: 'Authentication required',
                403: 'Admin access required',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },
    handlers: {
        GET: async (_event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            // `ctx.input` is optional on the endpoint context — a GET with no
            // query string never populates it, so reaching through it unguarded
            // throws before the handler can answer. Default window: 7 days.
            const sinceHours = ctx.input?.query?.sinceHours ?? 168;
            const since = new Date(Date.now() - sinceHours * 3_600_000);

            const { events: rows } = await listAdminAuditFeed(sql, {
                actions: RELEVANT_ACTIONS,
                since,
                limit: MAX_EVENTS,
            });

            const settingLabels = loadSettingLabels();

            const events: ChangeTimelineEvent[] = rows.map((row) => {
                const kind = classify(row.action);
                const out: ChangeTimelineEvent = {
                    id: row.id,
                    ts: row.ts,
                    actor: row.actor,
                    action: row.action,
                    target: row.target,
                    kind,
                };

                if (kind === 'task-pause' || kind === 'task-resume' || kind === 'task-settings') {
                    out.taskName = taskDisplayName(row.target, registry.getTask(row.target)?.name);
                }

                if (kind === 'settings') {
                    const changedKeys = Array.isArray(row.detail?.changedKeys)
                        ? (row.detail.changedKeys as unknown[]).filter(
                              (k): k is string => typeof k === 'string',
                          )
                        : [];
                    const labels = changedKeys.map((k) => settingLabels.get(k) ?? k);
                    out.changedLabels = labels.slice(0, MAX_CHANGED_LABELS);
                    out.changedLabelsTruncated = labels.length > MAX_CHANGED_LABELS;
                }

                return out;
            });

            return json(
                ChangeTimelineResponseSchema.parse({
                    generatedAt: new Date().toISOString(),
                    window: { sinceHours },
                    events,
                    versionTrackingAvailable: false,
                }),
            );
        },
    },
});
