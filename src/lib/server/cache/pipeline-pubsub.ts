// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { Logger } from '$lib/server/utils/logger.js';
import { getCoordinationClient } from './valkey.js';
import type { StageStatus } from '$lib/types/pipeline.js';

const log = Logger.for('PipelinePubsub');

export const PIPELINE_STAGE_STATE_CHANNEL = 'pipeline:stage-state';

export interface StageStateChangedEvent {
    mediaItemId: string;
    stageId: string;
    /** Status the row had BEFORE this transition. Absent for fresh inserts. */
    oldStatus?: StageStatus;
    /** Status the row has AFTER this transition. */
    newStatus: StageStatus;
    processingVersion: number;
    /** ULID/UUID identifying the run that caused this transition. Absent for lifecycle-driven changes (e.g., afterCreated seeding). */
    runId?: string;
    /** ISO 8601 timestamp. */
    timestamp: string;
    /** Type of change — useful for SSE consumers to filter. */
    kind: 'transition' | 'seed' | 'invalidate' | 'delete';
}

type ValkeyLike = { customCommand: (cmd: string[]) => Promise<unknown> };

/**
 * Fire-and-forget publish to the pipeline stage-state pub/sub channel.
 * Errors are logged but never thrown — publish failure must NOT block coverage writes.
 */
export async function publishStageStateChange(event: StageStateChangedEvent): Promise<void> {
    try {
        const client = getCoordinationClient();
        if (!client) return;
        const c = client as unknown as ValkeyLike;
        await c.customCommand(['PUBLISH', PIPELINE_STAGE_STATE_CHANNEL, JSON.stringify(event)]);
    } catch (err) {
        log.warn('Failed to publish stage-state event', { event }, err as Error);
    }
}
