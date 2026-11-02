// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import { TaskCommandSchema } from '../protocol.js';

/** Version 2: `execute` is an admission acknowledgement only; completion is
 * fetched with the `result` operation, so long tasks need no total RPC deadline. */
export const EXECUTOR_PROTOCOL_VERSION = 2;

const identifier = z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9_-]+$/);
export const ExecutionCommandSchema = z
    .object({
        invocationId: z.string().uuid(),
        dispatchId: z.string().uuid(),
        authority: TaskCommandSchema.shape.authority,
        catalogRevision: z.string().regex(/^[a-f0-9]{64}$/),
        runId: identifier,
        taskId: z.string().regex(/^[a-z][a-z0-9-]*$/),
        queueName: z.string().regex(/^[a-z][a-z0-9-]*$/),
        // Existing orchestrator IDs include taskId#runId.
        jobId: z
            .string()
            .min(1)
            .max(1024)
            .refine(
                (value) =>
                    [...value].every((character) => {
                        const code = character.charCodeAt(0);
                        return code >= 32 && code !== 127;
                    }),
                'Job ID contains control characters',
            ),
        lockToken: z.string().min(1).max(256),
        lockDurationMs: z.number().int().min(100).max(300_000),
    })
    .strict();
export type ExecutionCommand = z.infer<typeof ExecutionCommandSchema>;

export const ExecutorRequestSchema = z
    .object({
        version: z.literal(EXECUTOR_PROTOCOL_VERSION),
        secret: z.string().regex(/^[a-f0-9]{64}$/),
        requestId: z.string().uuid(),
        command: z.discriminatedUnion('operation', [
            z
                .object({ operation: z.literal('execute'), execution: ExecutionCommandSchema })
                .strict(),
            z.object({ operation: z.literal('cancel'), invocationId: z.string().uuid() }).strict(),
            z.object({ operation: z.literal('result'), invocationId: z.string().uuid() }).strict(),
            z.object({ operation: z.literal('status') }).strict(),
            z.object({ operation: z.literal('drain') }).strict(),
        ]),
    })
    .strict();
export type ExecutorRequest = z.infer<typeof ExecutorRequestSchema>;

export interface ExecutionOutcome {
    status: 'completed' | 'waiting_children' | 'delayed' | 'unrecoverable' | 'failed' | 'unknown';
    result?: unknown;
    reason?: 'invalid_result' | 'owner_lease_expired';
}
export interface ExecutionBackend {
    execute(command: ExecutionCommand, signal: AbortSignal): Promise<ExecutionOutcome>;
    cancel(runId: string): void;
    isQuiescent(): boolean;
    /** True once this run's own continuation is gone. Absent: the server falls
     * back to global quiescence, which starves under concurrent runs. */
    isRunQuiescent?(runId: string): boolean;
    close(): Promise<void>;
}

/** A positively known precommit rejection; transport/database ambiguity must
 * remain an UNKNOWN admission until the durable store reconciles it. */
export class ExecutionAdmissionRejectedError extends Error {
    constructor() {
        super('Executor admission rejected');
        this.name = 'ExecutionAdmissionRejectedError';
    }
}

export const ExecutionOutcomeSchema = z
    .unknown()
    .refine(isBoundedExecutionJson, 'Result budget exceeded')
    .pipe(
        z
            .object({
                status: z.enum([
                    'completed',
                    'waiting_children',
                    'delayed',
                    'unrecoverable',
                    'failed',
                    'unknown',
                ]),
                result: z.json().optional(),
                reason: z.enum(['invalid_result', 'owner_lease_expired']).optional(),
            })
            .strict(),
    );

export const ExecutionRejectionReasonSchema = z.enum([
    'draining',
    'capacity',
    'run_busy',
    'catalog_mismatch',
    'invocation_conflict',
    'admission_denied',
    'control_channel',
]);
export type ExecutionRejectionReason = z.infer<typeof ExecutionRejectionReasonSchema>;

const responseEnvelope = z.object({
    version: z.literal(EXECUTOR_PROTOCOL_VERSION),
    requestId: z.string().uuid(),
});
export const ExecutorResponseSchema = z.union([
    responseEnvelope
        .extend({
            status: z
                .object({
                    draining: z.boolean(),
                    active: z.number().int().min(0).max(32),
                    quiescent: z.boolean(),
                })
                .strict(),
        })
        .strict(),
    responseEnvelope
        .extend({
            status: z.enum(['cancellation_requested', 'not_active', 'rejected']),
            reason: ExecutionRejectionReasonSchema.optional(),
        })
        .strict(),
    // `duplicate: true` means this invocation id was already admitted; the reply
    // is idempotent and the caller continues with `result` for the same id.
    responseEnvelope.extend({ status: z.literal('admitted'), duplicate: z.boolean() }).strict(),
    responseEnvelope
        .extend({
            result: z.discriminatedUnion('state', [
                z.object({ state: z.literal('running') }).strict(),
                z.object({ state: z.literal('unknown_invocation') }).strict(),
                z
                    .object({
                        state: z.literal('done'),
                        outcome: ExecutionOutcomeSchema,
                        quiescent: z.boolean(),
                    })
                    .strict(),
            ]),
        })
        .strict(),
]);
export type ExecutorResponse = z.infer<typeof ExecutorResponseSchema>;

/** Validate before recursive schema parsing/stringification: plugin results are
 * untrusted graphs and must never poison durable receipts or the IPC channel. */
function isBoundedExecutionJson(outcome: unknown): boolean {
    const ancestors = new Set<object>();
    let nodes = 0;
    let bytes = 0;
    const inspect = (value: unknown, depth: number): void => {
        if (++nodes > 8192 || depth > 32) throw new Error('Result budget exceeded');
        if (value === null || typeof value === 'boolean') return;
        if (typeof value === 'number' && Number.isFinite(value)) return;
        if (typeof value === 'string') {
            bytes += Buffer.byteLength(value);
            if (bytes > 128 * 1024) throw new Error('Result size exceeded');
            return;
        }
        if (typeof value !== 'object' || value === null || ancestors.has(value))
            throw new Error('Non-JSON result');
        if (
            !Array.isArray(value) &&
            Object.getPrototypeOf(value) !== Object.prototype &&
            Object.getPrototypeOf(value) !== null
        )
            throw new Error('Non-JSON result');
        if (Array.isArray(value) && value.length > 8192 - nodes)
            throw new Error('Result array budget exceeded');
        ancestors.add(value);
        for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
            if (Array.isArray(value) && key === 'length') continue;
            if (!descriptor.enumerable) continue;
            if (!('value' in descriptor)) throw new Error('Accessor result');
            bytes += Buffer.byteLength(key);
            if (bytes > 128 * 1024) throw new Error('Result size exceeded');
            inspect(descriptor.value, depth + 1);
        }
        ancestors.delete(value);
    };
    try {
        inspect(outcome, 0);
        const serialized = JSON.stringify(outcome);
        if (Buffer.byteLength(serialized) > 128 * 1024) throw new Error('Result size exceeded');
        return true;
    } catch {
        return false;
    }
}

export function normalizeExecutionOutcome(outcome: ExecutionOutcome): ExecutionOutcome {
    if (!isBoundedExecutionJson(outcome)) return { status: 'unknown', reason: 'invalid_result' };
    try {
        return ExecutionOutcomeSchema.parse(JSON.parse(JSON.stringify(outcome)));
    } catch {
        return { status: 'unknown', reason: 'invalid_result' };
    }
}
