// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ExecutionCommandSchema, ExecutorResponseSchema } from './protocol.js';

describe('executor protocol compatibility', () => {
    it('accepts durable expired-owner UNKNOWN outcomes without accepting arbitrary reasons', () => {
        const response = {
            version: 2,
            requestId: randomUUID(),
            result: {
                state: 'done',
                outcome: { status: 'unknown', reason: 'owner_lease_expired' },
                quiescent: true,
            },
        };
        expect(ExecutorResponseSchema.parse(response)).toEqual(response);
        expect(
            ExecutorResponseSchema.safeParse({
                ...response,
                result: {
                    state: 'done',
                    outcome: { status: 'unknown', reason: 'unrecognized' },
                    quiescent: true,
                },
            }).success,
        ).toBe(false);
    });

    it('retains existing taskId#runId BullMQ IDs and SDK task ID alphabet', () => {
        const command = {
            invocationId: randomUUID(),
            dispatchId: randomUUID(),
            authority: { partition: 'task:fixture', generation: '1', ownerId: randomUUID() },
            catalogRevision: 'a'.repeat(64),
            runId: 'run_01ABC',
            taskId: 'fixture-task',
            queueName: 'fixture-task',
            jobId: 'fixture-task#run_01ABC',
            lockToken: randomUUID(),
            lockDurationMs: 30_000,
        };
        expect(ExecutionCommandSchema.parse(command).jobId).toBe(command.jobId);
        for (const taskId of ['fixture_task', 'fixture.task', 'Fixture-task'])
            expect(ExecutionCommandSchema.safeParse({ ...command, taskId }).success).toBe(false);
        expect(ExecutionCommandSchema.safeParse({ ...command, jobId: 'bad\njob' }).success).toBe(
            false,
        );
    });
    it('strictly validates complete replies and refuses unknown protocol versions or leaked fields', () => {
        const response = {
            version: 2,
            requestId: randomUUID(),
            result: {
                state: 'done',
                outcome: { status: 'completed', result: { success: true } },
                quiescent: true,
            },
        };
        expect(ExecutorResponseSchema.parse(response)).toEqual(response);
        expect(ExecutorResponseSchema.safeParse({ ...response, version: 1 }).success).toBe(false);
        expect(
            ExecutorResponseSchema.safeParse({ ...response, secret: 'a'.repeat(64) }).success,
        ).toBe(false);
        expect(
            ExecutorResponseSchema.safeParse({
                ...response,
                result: { state: 'done', outcome: { status: 'made_up' }, quiescent: true },
            }).success,
        ).toBe(false);
        expect(
            ExecutorResponseSchema.parse({
                version: 2,
                requestId: randomUUID(),
                status: { active: 0, draining: true, quiescent: true },
            }),
        ).toMatchObject({ status: { quiescent: true } });
    });
});

describe('bounded plugin results', () => {
    it('normalizes cycles, non-JSON values, excessive depth and size to bounded UNKNOWN', async () => {
        const { normalizeExecutionOutcome, ExecutionOutcomeSchema } = await import('./protocol.js');
        const cycle: Record<string, unknown> = {};
        cycle.self = cycle;
        let deep: unknown = null;
        for (let index = 0; index < 40; index++) deep = { nested: deep };
        for (const result of [
            cycle,
            1n,
            undefined,
            () => {},
            Number.NaN,
            deep,
            'x'.repeat(256 * 1024),
            new Array(1_000_000),
        ]) {
            expect(normalizeExecutionOutcome({ status: 'completed', result })).toEqual({
                status: 'unknown',
                reason: 'invalid_result',
            });
        }
        expect(
            ExecutionOutcomeSchema.safeParse({ status: 'completed', result: deep }).success,
        ).toBe(false);
        expect(
            normalizeExecutionOutcome({
                status: 'completed',
                result: { unicode: '日本語', values: [1, true, null] },
            }),
        ).toMatchObject({ status: 'completed' });
    });
});
