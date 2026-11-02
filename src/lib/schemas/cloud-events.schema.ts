// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

/**
 * Run/cost CloudEvent types. These are the strongly-typed events the admin
 * UI's `runSSEBus` actually consumes — each one carries a Run payload that
 * `RunSchema` can parse.
 */
export const CloudEventTypeSchema = z.enum([
    'org.lumastra.task.run.started',
    'org.lumastra.task.run.completed',
    'org.lumastra.task.run.failed',
    'org.lumastra.task.run.cancelled',
    'org.lumastra.task.run.cancelling',
    'org.lumastra.task.run.progress',
    'org.lumastra.task.run.stage.completed',
    'org.lumastra.task.cost.threshold.exceeded',
    'org.lumastra.media.item.added',
]);

export type CloudEventType = z.infer<typeof CloudEventTypeSchema>;

/**
 * Meta CloudEvent types — emitted by the orchestrator / runner /
 * boot-recovery sweep over the `task:events:meta` channel and wrapped
 * server-side into a CloudEvent envelope by the SSE bridge. These are
 * informational only; the admin UI ignores them at the `extractRun` step
 * but the envelope must still parse against `CloudEventSchema` so we
 * don't silently drop the frame in `applyCloudEvent`.
 */
export const CloudEventMetaTypeSchema = z.enum([
    'org.lumastra.task.meta.leader-elected',
    'org.lumastra.task.meta.leader-reacquired',
    'org.lumastra.task.meta.subscription-lost',
    'org.lumastra.task.meta.transition-conflict',
    'org.lumastra.task.meta.node-registered',
    'org.lumastra.task.meta.scheduler-tick',
    'org.lumastra.task.meta.recovery-reclaimed',
    'org.lumastra.task.meta.pipeline-when-skip',
    'org.lumastra.task.meta.unknown',
]);

export type CloudEventMetaType = z.infer<typeof CloudEventMetaTypeSchema>;

/**
 * Combined enum used for envelope validation. Includes every type the SSE
 * bridge may forward — run/cost transitions AND wrapped meta events.
 */
export const CloudEventAnyTypeSchema = z.union([CloudEventTypeSchema, CloudEventMetaTypeSchema]);

export const CloudEventSchema = z.object({
    specversion: z.literal('1.0'),
    id: z.string(),
    source: z.string(),
    type: CloudEventAnyTypeSchema,
    subject: z.string(),
    time: z.string(),
    datacontenttype: z.literal('application/json'),
    dataschema: z.string().optional(),
    data: z.unknown(),
});

export type CloudEvent = z.infer<typeof CloudEventSchema>;
