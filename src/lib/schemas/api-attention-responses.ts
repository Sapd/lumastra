// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

export const AttentionSeveritySchema = z
    .enum(['critical', 'warning', 'info'])
    .describe('Attention severity level')
    .meta({ id: 'AttentionSeverity' });
export type AttentionSeverity = z.infer<typeof AttentionSeveritySchema>;

export const AttentionTypeSchema = z
    .enum([
        'circuit-open',
        'dead-letter',
        'needs-reidentification',
        'stuck-items',
        'degraded-component',
        'setup-incomplete',
        'failed-run-spike',
        'overdue-schedule',
        'optional-integration',
        'unmatched-files',
        'file-health',
        'integrity',
        'livetv-import',
        'repeated-recovery',
        'cluster-key-mismatch',
    ])
    .describe(
        'DEPRECATED — read `AttentionItem.domain` instead. A closed vocabulary that is redundant ' +
            'with the item id prefix and degenerate where it matters (24 health invariants all land ' +
            'on `degraded-component`). Still populated on every item for one release so no existing ' +
            'client decode breaks; removed once the iOS client no longer reads it.',
    )
    .meta({ id: 'AttentionType' });
export type AttentionType = z.infer<typeof AttentionTypeSchema>;

/**
 * The `domain` an item carries when nothing more specific is known.
 *
 * Lives here rather than in `shared/attention-domain.ts` so the schema does not
 * depend on the mapping module (the dependency runs shared → schemas, matching
 * `attention-section-map.ts`). `system` mirrors the column default this value's
 * migration installs (16.231.0) and the Health page's catch-all section.
 */
export const ATTENTION_DOMAIN_FALLBACK = 'system';

/**
 * Action handler keys that exist today.
 *
 * `AttentionAction.kind` is NO LONGER a closed enum on the wire (design §7): a
 * producer references a registered handler by string, so a new subsystem can
 * offer an action without a schema change. This list is kept for two things
 * only — autocomplete at the call site, and `isKnownAttentionActionKind` for
 * consumers that want to know whether they can dispatch a value. Nothing here
 * is ever renamed: renaming a member breaks decode in the generated Swift
 * client, whereas adding one is safe.
 */
export const KNOWN_ATTENTION_ACTION_KINDS = [
    'investigate',
    'cancel-run',
    'trigger-run',
    'reset-circuit',
    'retry-item',
    'stop',
    'pause',
    'bulk-retry',
    'release-stuck',
    'accept-expected',
    'requeue-dead-letter',
] as const;

export type KnownAttentionActionKind = (typeof KNOWN_ATTENTION_ACTION_KINDS)[number];

const KNOWN_ACTION_KIND_SET: ReadonlySet<string> = new Set(KNOWN_ATTENTION_ACTION_KINDS);

/** True when `kind` names a handler this build knows how to dispatch. */
export function isKnownAttentionActionKind(kind: string): kind is KnownAttentionActionKind {
    return KNOWN_ACTION_KIND_SET.has(kind);
}

/**
 * A dispatchable action. `kind` selects the client handler; ids scope it.
 */
export const AttentionActionSchema = z
    .object({
        kind: z
            .string()
            .min(1)
            .describe(
                'Action handler key — selects the client handler. OPEN vocabulary, not an enum: a ' +
                    'client that does not recognise a key MUST render the action inert (or hide it) ' +
                    'rather than fail. `KNOWN_ATTENTION_ACTION_KINDS` lists the keys this build ships.',
            ),
        label: z.string().describe('Action display label'),
        href: z.string().optional().describe('Optional navigation link'),
        taskId: z.string().optional().describe('Task ID scope'),
        runId: z.string().optional().describe('Run ID scope'),
        itemId: z.string().optional().describe('Item ID scope'),
        stageId: z
            .string()
            .optional()
            .describe('Pipeline stage ID scope (bulk-retry / release-stuck)'),
    })
    .meta({
        id: 'AttentionAction',
        description: 'An inline action that resolves an attention item',
    });
/**
 * `kind` is `string` on the wire. The `string & Record<never, never>` arm keeps
 * editor autocomplete on the known handler keys while still accepting a key a
 * plugin or a newer producer registered — the whole point of opening it.
 */
export type AttentionAction = Omit<z.infer<typeof AttentionActionSchema>, 'kind'> & {
    kind: KnownAttentionActionKind | (string & Record<never, never>);
};

/**
 * How an aggregate alert is moving.
 *
 * The problem this answers: a coverage-gap alert once sat CRITICAL for 23 hours
 * while its own remediation was visibly succeeding, because the threshold was
 * static and the alert had no memory of its own previous value. An operator
 * could not tell a draining backlog from a growing one.
 *
 * `direction` is the answer to "right now"; `sinceFirst` is the answer to "has
 * this been worth worrying about at all". Both are needed — a backlog can tick
 * upward inside an overall recovery, and reporting only the instantaneous
 * direction would make that read as a regression.
 */
export const AttentionTrendSchema = z
    .object({
        direction: z
            .enum(['falling', 'rising', 'flat'])
            .describe('Change since the previous derive tick'),
        current: z.number().int().describe('Count now'),
        previous: z.number().int().describe('Count at the previous tick'),
        first: z.number().int().describe('Count when this incident first fired'),
        sinceFirst: z
            .enum(['better', 'worse', 'same'])
            .describe('Change since the incident first fired'),
    })
    .meta({ id: 'AttentionTrend', description: 'Direction of an aggregate alert' });
export type AttentionTrend = z.infer<typeof AttentionTrendSchema>;

export const AttentionItemSchema = z
    .object({
        id: z.string().describe('Stable key, e.g. circuit:metadata-sync'),
        fingerprint: z.string().describe('Hash of the incident defining state'),
        type: AttentionTypeSchema,
        domain: z
            .string()
            .default(ATTENTION_DOMAIN_FALLBACK)
            .describe(
                'Which subsystem this problem belongs to — `storage`, `auth`, `transcoding`, ' +
                    '`network`, `plugins`, `updates`, `tasks`, `library`, … Used for grouping and ' +
                    'icon selection ONLY. Free text by design, so a new producer needs no schema ' +
                    'change: consumers MUST degrade gracefully on a value they do not know (see ' +
                    '`prettifyDomain` in shared/attention-domain.ts) rather than switch exhaustively.',
            ),
        severity: AttentionSeveritySchema,
        title: z.string().describe('Item title'),
        detail: z.string().optional().describe('Detailed explanation'),
        sourceRef: z.string().optional().describe('Deep link to the advanced surface'),
        term: z.string().optional().describe('Glossary key for the headline jargon'),
        actions: z.array(AttentionActionSchema).describe('Available actions'),
        firstSeen: z.string().describe('ISO 8601 timestamp'),
        lastSeen: z.string().describe('ISO 8601 timestamp'),
        acked: z.boolean().describe('Whether the admin has acknowledged this item'),
        snoozed: z
            .boolean()
            .optional()
            .describe('Whether the item is currently snoozed (time-boxed suppression)'),
        snoozedUntil: z.string().optional().describe('ISO 8601 — when the snooze expires'),
        resolvedAt: z
            .string()
            .optional()
            .describe('ISO 8601 — when the item resolved (history only)'),
        trend: AttentionTrendSchema.optional().describe(
            'Direction of an aggregate alert since the previous derive tick, and since it ' +
                'first fired. Absent for scalar alerts (circuits, schedules) which carry no ' +
                'count, and on the first tick of a new incident. OPTIONAL on purpose: a ' +
                'required response field is a one-way door for strict clients.',
        ),
    })
    .meta({
        id: 'AttentionItem',
        description: 'One thing needing the admin attention',
    });
/**
 * `z.input`, NOT `z.infer` — deliberately.
 *
 * `domain` is required ON THE WIRE and carries a schema default, which makes it
 * optional on the *producing* side and guaranteed on the *parsed* side. Every
 * admin response is emitted through `AdminStatusPayloadSchema.parse(...)`
 * (defs/admin/ops/status.ts), so the default is applied at the serialization
 * boundary and a client can never see the field missing — while the derivation
 * code that builds items may adopt `domain` on its own schedule instead of
 * having to fill it the moment this field lands.
 *
 * `AdminStatusPayload` stays on `z.infer`, so the boundary that assembles it is
 * type-forced to supply a real domain rather than silently relying on the
 * fallback (see `withAttentionDomain` in shared/attention-domain.ts).
 */
export type AttentionItem = z.input<typeof AttentionItemSchema>;

export const AttentionVerdictSchema = z
    .enum(['healthy', 'degraded', 'critical'])
    .describe('Overall system health verdict')
    .meta({ id: 'AttentionVerdict' });
export type AttentionVerdict = z.infer<typeof AttentionVerdictSchema>;

/**
 * Image href map for a recently-added item.
 * Keys are roles (e.g. `poster`, `backdrop`); values are absolute API hrefs.
 * Clients MUST use these hrefs rather than constructing image URLs from fields.
 */
export const RecentlyAddedImagesSchema = z
    .object({
        poster: z.string().optional(),
        backdrop: z.string().optional(),
        thumb: z.string().optional(),
    })
    .meta({ id: 'RecentlyAddedImages' });
export type RecentlyAddedImages = z.infer<typeof RecentlyAddedImagesSchema>;

export const RecentlyAddedItemSchema = z
    .object({
        id: z.string(),
        title: z.string(),
        /** Canonical type discriminator — `movie | series | season | episode | track | album | artist`. */
        type: z.string(),
        year: z.number().optional(),
        /** Self-describing image hrefs — use `images.poster` instead of a flat posterUrl. */
        images: RecentlyAddedImagesSchema.optional(),
        addedAt: z.string().describe('ISO timestamp — library_added_at fallback created_at'),
        seriesTitle: z.string().optional().describe('Series name — episodes only'),
        seasonNumber: z.number().optional().describe('Season number — episodes only'),
        episodeNumber: z.number().optional().describe('Episode number — episodes only'),
        seriesId: z.string().optional().describe('Internal UUID of the series — episodes only'),
        episodeCount: z
            .number()
            .int()
            .optional()
            .describe(
                'Set when this row stands for several episodes of one series added together; the item fields describe the newest of them',
            ),
        seasons: z
            .array(
                z.object({
                    season: z.number().int(),
                    episodes: z
                        .array(z.number().int())
                        .describe('Episode numbers, ascending and unique'),
                }),
            )
            .optional()
            .describe('Grouped rows only: the added episodes per season, seasons ascending'),
    })
    .meta({
        id: 'RecentlyAddedItem',
        description: 'A recently-ingested library item',
    });
export type RecentlyAddedItem = z.infer<typeof RecentlyAddedItemSchema>;

export const AttentionActivitySchema = z.object({ running: z.number().int().min(0) }).meta({
    id: 'AttentionActivity',
    description: 'Active manual-operation summary',
});
export type AttentionActivity = z.infer<typeof AttentionActivitySchema>;

/**
 * Producing shape of the operations-spine attention payload. This was a zod object
 * once; nothing parsed with it (the only consumers cast a cached JSON body and read
 * fields), so it is now a plain type over the nested schemas' input shapes — same
 * `z.input` reasoning as `AttentionItem`.
 */
export type AttentionResponse = {
    /** Overall health verdict */
    verdict: z.input<typeof AttentionVerdictSchema>;
    /** Items needing attention */
    items: AttentionItem[];
    /** Count of unacknowledged items */
    unreadCount: number;
    activity?: z.input<typeof AttentionActivitySchema>;
    recentlyAdded?: z.input<typeof RecentlyAddedItemSchema>[];
    /** Recently auto-resolved items ("what happened while away") */
    resolvedHistory?: AttentionItem[];
    /**
     * True when the attention block could not be computed — verdict is a conservative
     * fallback and items/activity/recentlyAdded are not authoritative (empty, not "all clear")
     */
    unavailable?: boolean;
};

export const AttentionAckRequestSchema = z
    .object({
        id: z.string().describe('Item ID'),
        fingerprint: z.string().describe('Item fingerprint'),
    })
    .meta({
        id: 'AttentionAckRequest',
        description: 'Request to acknowledge an attention item',
    });
export type AttentionAckRequest = z.infer<typeof AttentionAckRequestSchema>;

export const AttentionAckResponseSchema = z
    .object({
        ok: z.boolean().describe('Success flag'),
    })
    .meta({
        id: 'AttentionAckResponse',
        description: 'Acknowledgment result',
    });
export type AttentionAckResponse = z.infer<typeof AttentionAckResponseSchema>;

export const AttentionSnoozeRequestSchema = z
    .object({
        id: z.string().describe('Item ID'),
        fingerprint: z.string().describe('Item fingerprint'),
        durationMs: z
            .number()
            .int()
            .positive()
            .max(30 * 24 * 60 * 60 * 1000)
            .describe('Snooze duration in milliseconds (capped at 30 days)'),
    })
    .meta({
        id: 'AttentionSnoozeRequest',
        description: 'Request to snooze (time-box suppress) an attention item',
    });
export type AttentionSnoozeRequest = z.infer<typeof AttentionSnoozeRequestSchema>;

export const AttentionSnoozeResponseSchema = z
    .object({
        ok: z.boolean().describe('Success flag'),
    })
    .meta({
        id: 'AttentionSnoozeResponse',
        description: 'Snooze result',
    });
export type AttentionSnoozeResponse = z.infer<typeof AttentionSnoozeResponseSchema>;

export const TaskStopResponseSchema = z
    .object({
        cancelled: z.number().int().describe('Runs cancelled'),
        orphaned: z.number().int().describe('Runs orphaned'),
    })
    .meta({
        id: 'TaskStopResponse',
        description: 'Result of nuclear-stopping a task',
    });
export type TaskStopResponse = z.infer<typeof TaskStopResponseSchema>;

export const TaskPauseResponseSchema = z.object({ ok: z.boolean().describe('Success flag') }).meta({
    id: 'TaskPauseResponse',
    description: 'Result of pausing/resuming a task schedule',
});
export type TaskPauseResponse = z.infer<typeof TaskPauseResponseSchema>;

export const StageActionResponseSchema = z
    .object({ count: z.number().int().describe('Rows affected') })
    .meta({
        id: 'StageActionResponse',
        description: 'Result of a stage-wide pipeline action',
    });
export type StageActionResponse = z.infer<typeof StageActionResponseSchema>;

export const StageActionRequestSchema = z
    .object({ stageId: z.string().min(1).describe('Pipeline stage id') })
    .meta({
        id: 'StageActionRequest',
        description: 'Target a pipeline stage for a bulk action',
    });
export type StageActionRequest = z.infer<typeof StageActionRequestSchema>;

export const ItemStageActionRequestSchema = z
    .object({
        mediaItemId: z.string().guid().describe('media_items.id'),
        stageId: z.string().min(1).describe('Pipeline stage id'),
    })
    .meta({
        id: 'ItemStageActionRequest',
        description: 'Target a single (media item, pipeline stage) for an action',
    });
export type ItemStageActionRequest = z.infer<typeof ItemStageActionRequestSchema>;
