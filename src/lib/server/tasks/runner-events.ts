// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Run lifecycle event emission from the writer side.
 *
 * The runner — not the orchestrator's QueueEvents observer — is the actual
 * writer of terminal rows for normally-finishing runs. The orchestrator's
 * guarded UPDATE matches zero rows in that case and its emit is skipped, so
 * emission has to live next to the write that really happens.
 *
 * `row` is the `RETURNING` payload: `undefined` means the guarded UPDATE
 * matched nothing (someone else already terminalized the run), and we publish
 * nothing. That is what makes double-writes idempotent.
 */

import { publishMessage } from '$lib/server/cache/valkey.js';
import { cloudEvents } from './cloud-events.js';
import { toRunEvent } from './run-event.js';
import { Logger } from '$lib/server/utils/logger.js';
import type { Run } from '@sapd/lumastra-plugin-sdk';

const log = Logger.for('RunnerEvents');

export interface TerminalRunRow {
    id: string;
    task_id: string;
    /** Selected-file identity only; never part of an emitted frame. */
    recheck_input?: unknown;
    label: string;
    state: 'completed' | 'failed' | 'cancelled' | 'active';
    scope: Record<string, string> | null;
    trigger: unknown;
    actor: unknown;
    started_at: Date;
    execution_started_at?: Date | null;
    completed_at: Date | null;
    heartbeat_at: Date | null;
    stages: unknown;
    /** Persisted task result is internal input to safe count normalization only. */
    result?: unknown;
    error: { message: string; kind?: string; stack?: string } | null;
}

function rowToRunLike(row: TerminalRunRow): Run {
    return {
        id: row.id,
        taskId: row.task_id,
        label: row.label,
        state: row.state,
        input: row.recheck_input,
        scope: (row.scope ?? undefined) as Run['scope'],
        trigger: row.trigger as Run['trigger'],
        actor: row.actor as Run['actor'],
        startedAt: row.started_at.toISOString(),
        executionStartedAt: row.execution_started_at?.toISOString(),
        admissionObservation:
            row.state === 'active' && row.execution_started_at ? 'active' : undefined,
        completedAt: row.completed_at?.toISOString(),
        heartbeatAt: row.heartbeat_at?.toISOString(),
        stages: (row.stages ?? []) as Run['stages'],
        result: row.result as Run['result'],
        error: (row.error ?? undefined) as Run['error'],
    };
}

export async function emitTerminalRunEvent(args: {
    resourceClass: string;
    row: TerminalRunRow | undefined;
}): Promise<void> {
    const { resourceClass, row } = args;
    // No row → the guarded UPDATE matched nothing → another writer already
    // terminalized this run and already published. Idempotent by construction.
    if (!row) return;

    const data = toRunEvent(rowToRunLike(row));
    const event =
        row.state === 'completed'
            ? cloudEvents.runCompleted(row.task_id, row.id, data)
            : row.state === 'cancelled'
              ? cloudEvents.runCancelled(row.task_id, row.id, data)
              : cloudEvents.runFailed(row.task_id, row.id, data);

    try {
        await publishMessage(`task:events:${resourceClass}`, JSON.stringify(event));
    } catch (err) {
        // Emission is best-effort: the durable state is already in Postgres and
        // the client's reconnect path re-seeds from REST.
        log.warn('emitTerminalRunEvent publish failed', { runId: row.id, err: String(err) });
    }
}

export async function emitActiveRunEvent(args: {
    resourceClass: string;
    row: TerminalRunRow | undefined;
}): Promise<void> {
    const { resourceClass, row } = args;
    if (!row) return;
    const data = toRunEvent(rowToRunLike(row));
    const event = cloudEvents.runStarted(row.task_id, row.id, data);
    try {
        await publishMessage(`task:events:${resourceClass}`, JSON.stringify(event));
    } catch (err) {
        log.warn('emitActiveRunEvent publish failed', { runId: row.id, err: String(err) });
    }
}
