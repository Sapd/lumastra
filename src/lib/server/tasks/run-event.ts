// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Single redaction point for run lifecycle events and REST run bodies.
 *
 * Both the SSE publisher and `GET /api/runs` must strip the same fields;
 * keeping one helper is what stops the two surfaces drifting apart (they
 * already had, which is how stack traces reached one and not the other).
 */

import type { Run, RunEvent } from '@sapd/lumastra-plugin-sdk';
import { z } from 'zod';
import {
    FileHealthRecheckRequestSchema,
    FileHealthRecheckResultSchema,
} from '$lib/schemas/file-health-recheck.js';

const MAX_RUN_COUNT = 1_000_000_000;
const MAX_REMAINING_SOURCES = 1_000_000;

function isBoundedCount(value: unknown, maximum = MAX_RUN_COUNT): value is number {
    return (
        typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum
    );
}

/** Derives the only result-derived data allowed through both run projections. */
export function runCountSummary(
    run: Pick<Run, 'taskId' | 'result' | 'state' | 'error'>,
): Run['countSummary'] {
    if (typeof run.result !== 'object' || run.result === null || Array.isArray(run.result))
        return undefined;
    const envelope = run.result as Record<string, unknown>;
    const count = envelope.itemsProcessed;
    if (!isBoundedCount(count)) return undefined;

    if (run.taskId === 'trickplay-generation') {
        const generatedResult = envelope.result;
        if (
            typeof generatedResult !== 'object' ||
            generatedResult === null ||
            Array.isArray(generatedResult)
        )
            return undefined;
        const generated = generatedResult as Record<string, unknown>;
        // `generated` is the generator's decoded-frame counter. Equality with
        // the TaskResult counter validates both new envelopes and historical
        // preview runs without guessing from source or manifest counts.
        if (
            !isBoundedCount(generated.generated) ||
            generated.generated !== count ||
            (generated.countUnit !== undefined && generated.countUnit !== 'frames')
        )
            return undefined;

        const sourcesRemaining = generated.sourcesRemaining;
        const continuation =
            run.state === 'completed' &&
            !run.error &&
            envelope.success === false &&
            envelope.stopReason === 'budget' &&
            isBoundedCount(sourcesRemaining, MAX_REMAINING_SOURCES) &&
            sourcesRemaining > 0
                ? { kind: 'source-check' as const, remainingSources: sourcesRemaining }
                : undefined;
        return { count, unit: 'frames', ...(continuation ? { continuation } : {}) };
    }

    return { count, unit: 'items' };
}

// This is the selected media-probe executor's native envelope. Generic task
// results remain opaque; the public selected-file payload has no native counters.
const SelectedFileTaskResultSchema = z
    .object({
        success: z.literal(true),
        itemsProcessed: z.number().int().nonnegative(),
        stopReason: z.undefined().optional(),
        result: z.object({ recheck: FileHealthRecheckResultSchema }),
    })
    .refine(({ itemsProcessed, result: { recheck } }) => {
        // Match the native selected executor, including its zero-work refusals.
        // Cancellation throws and is represented by the OUTER terminal state.
        if (recheck.outcome === 'busy')
            return (
                itemsProcessed === 0 && recheck.issues.length === 0 && recheck.reason === undefined
            );
        if (recheck.reason === 'disabled')
            return (
                itemsProcessed === 0 &&
                recheck.outcome === 'inconclusive' &&
                recheck.issues.length === 0
            );
        if (itemsProcessed !== 1) return false;
        switch (recheck.outcome) {
            case 'healthy':
                return recheck.issues.length === 0 && recheck.reason === undefined;
            case 'warning':
                return recheck.issues.length > 0 && recheck.reason === 'warnings_remain';
            case 'inconclusive':
                return recheck.reason === 'inconclusive';
            case 'error':
                return recheck.reason === undefined || recheck.reason === 'probe_failed';
            default:
                return false;
        }
    });

/**
 * `idempotencyKey` is the internal enqueue de-dup token. The run schema never
 * declared it, so production stripped it silently and the conformance counter
 * flagged it; it must not leave the server through any run surface.
 */
export function publicTrigger<T extends object>(trigger: T): T {
    if (!('idempotencyKey' in trigger)) return trigger;
    const { idempotencyKey: _internal, ...rest } = trigger as Record<string, unknown>;
    return rest as T;
}

/**
 * HTTP view of an orchestrator run: drops `error.stack` (internal file paths)
 * and `trigger.idempotencyKey`.
 */
export function toPublicRun<
    T extends {
        error?: { message: string; kind?: unknown; stack?: string };
        trigger: object;
        taskId?: string;
        state?: string;
        input?: unknown;
        result?: unknown;
    },
>(run: T): T {
    let out = run;
    if (run.error?.stack) {
        out = { ...out, error: { message: run.error.message, kind: run.error.kind } };
    }
    if ('idempotencyKey' in run.trigger) {
        out = { ...out, trigger: publicTrigger(run.trigger) };
    }
    // Physical-file diagnostics belong to the admin Health surface. Older or
    // malformed selected results must not leak through ordinary runs:read.
    if (
        run.taskId === 'media-probe' &&
        run.input &&
        typeof run.input === 'object' &&
        'fileId' in run.input
    ) {
        // The runner persists the entire native TaskResult, not just its
        // inner `result`. Unwrap ONLY this selected task and fail closed for
        // legacy direct results, unsuccessful/unfinished envelopes and bad IDs.
        const input = FileHealthRecheckRequestSchema.safeParse(run.input);
        const envelope = SelectedFileTaskResultSchema.safeParse(run.result);
        const verified =
            run.state === 'completed' &&
            !run.error &&
            input.success &&
            envelope.success &&
            envelope.data.result.recheck.fileId === input.data.fileId;
        const errorKind = z.enum(['transient', 'permanent', 'fatal']).safeParse(run.error?.kind);
        out = {
            ...out,
            input: input.success ? input.data : {},
            result: verified ? { recheck: envelope.data.result.recheck } : undefined,
            ...(run.error
                ? {
                      error: {
                          message: 'Selected-file recheck did not complete',
                          kind: errorKind.success ? errorKind.data : undefined,
                      },
                  }
                : {}),
        };
    }
    // Derive after the selected-file redaction above: its native itemsProcessed
    // counter is not part of the public result and must not reappear as a
    // summary if that result failed validation.
    const countSummary = runCountSummary(out as Pick<Run, 'taskId' | 'result' | 'state' | 'error'>);
    if (countSummary || 'countSummary' in out) out = { ...out, countSummary };
    return out;
}

export function toRunEvent(run: Run): RunEvent {
    const safe = toPublicRun(run);
    return {
        id: run.id,
        taskId: run.taskId,
        parentRunId: run.parentRunId,
        label: run.label,
        state: run.state,
        scope: run.scope,
        trigger: publicTrigger(run.trigger),
        actor: run.actor,
        startedAt: run.startedAt,
        executionStartedAt: run.executionStartedAt,
        admissionObservation: run.admissionObservation,
        completedAt: run.completedAt,
        heartbeatAt: run.heartbeatAt,
        stages: run.stages,
        costBreakdown: run.costBreakdown,
        countSummary: safe.countSummary,
        ownerInstanceId: run.ownerInstanceId,
        error: safe.error ? { message: safe.error.message, kind: safe.error.kind } : undefined,
    };
}
