// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * "What changed?" correlation view — Zod response schema.
 *
 * SINGLE SOURCE OF TRUTH for GET /api/admin/system/change-timeline
 * (and its /api/v1 mirror).
 *
 * Sourced from `audit_log WHERE source = 'admin'` (`admin-audit.queries.ts`,
 * written by `src/lib/server/utils/audit-log.ts` on every sensitive admin
 * action — config saves, task pause/resume, licensing, cache clears, plugin
 * installs). That table is a REAL, already-recorded admin audit trail; this
 * endpoint filters it to the subset that plausibly explains "it worked last
 * week" and enriches it with human-readable labels.
 *
 * What is NOT included, and why: there is no persisted history of the
 * running app version over time — `config.APP_VERSION` is a boot-time value
 * read from the build, never written to a table with a timestamp. A
 * "version changed" row would have to be invented. `versionTrackingAvailable`
 * is `false` so the UI can say so plainly instead of fabricating one.
 */

import { z } from 'zod';

export const ChangeTimelineEventKindSchema = z.enum([
    'settings',
    'task-pause',
    'task-resume',
    'task-settings',
    'licensing',
    'cache',
    'plugin',
    'secret',
    'other',
]);
export type ChangeTimelineEventKind = z.infer<typeof ChangeTimelineEventKindSchema>;

export const ChangeTimelineEventSchema = z.object({
    id: z.number(),
    ts: z.string(),
    actor: z.string(),
    action: z.string(),
    target: z.string(),
    kind: ChangeTimelineEventKindSchema,
    /** Resolved `TaskDefinition.name` for task-* kinds; falls back to the raw task id. */
    taskName: z.string().optional(),
    /** Human labels for `detail.changedKeys` on a `settings.save` event, capped. */
    changedLabels: z.array(z.string()).optional(),
    /** True when `changedLabels` was truncated (more keys changed than shown). */
    changedLabelsTruncated: z.boolean().optional(),
});
export type ChangeTimelineEvent = z.infer<typeof ChangeTimelineEventSchema>;

export const ChangeTimelineResponseSchema = z.object({
    generatedAt: z.string(),
    window: z.object({ sinceHours: z.number() }),
    /** Newest first. */
    events: z.array(ChangeTimelineEventSchema),
    /** Always `false` today — see module doc. */
    versionTrackingAvailable: z.literal(false),
});
export type ChangeTimelineResponse = z.infer<typeof ChangeTimelineResponseSchema>;
