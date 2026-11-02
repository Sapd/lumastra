// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { TaskFrameDecoder, encodeTaskFrame } from './protocol.js';
import {
    EXECUTOR_PROTOCOL_VERSION,
    ExecutorRequestSchema,
    ExecutorResponseSchema,
    type ExecutionCommand,
    type ExecutionOutcome,
    type ExecutionRejectionReason,
    type ExecutorRequest,
} from './executor/protocol.js';
import type { z } from 'zod';

export class ExecutorTransportError extends Error {
    /** A dispatched mutation may have committed despite timeout/disconnect. */
    readonly outcome = 'unknown';
    constructor() {
        super('Executor transport outcome is unknown; reconcile before retry');
    }
}
export type ExecutorResponse = z.infer<typeof ExecutorResponseSchema>;

export type ExecuteResult =
    | { admitted: false; reason?: ExecutionRejectionReason }
    | { admitted: true; duplicate: boolean; outcome: ExecutionOutcome; quiescent: boolean };

/** One bounded RPC per connection. Never replays a lost execute acknowledgment.
 * `timeoutMs` bounds each single RPC (admission ack, status, result poll), never
 * the total run time: see `execute()`. */
export class ExecutorClient {
    private executing = 0;
    private controlling = 0;
    constructor(
        private readonly options: {
            socketPath: string;
            controlSocketPath?: string;
            secret: string;
            timeoutMs?: number;
        },
    ) {
        if (!/^[a-f0-9]{64}$/.test(options.secret))
            throw new Error('Invalid executor client credential');
        const timeout = options.timeoutMs ?? 30_000;
        if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300_000)
            throw new Error('Invalid executor client deadline');
    }
    /** Submits an execution and waits for its outcome. Only the admission ack and
     * each poll are time-bounded; the run itself may take hours. A rejection is
     * returned as `{ admitted: false }`. Anything ambiguous (lost ack, lost
     * invocation, aborted wait, unreachable executor) throws
     * ExecutorTransportError and must be reconciled, never blindly re-run. */
    async execute(
        execution: ExecutionCommand,
        options: { pollIntervalMs?: number; signal?: AbortSignal; maxPollFailures?: number } = {},
    ): Promise<ExecuteResult> {
        const interval = options.pollIntervalMs ?? 250;
        const maxFailures = options.maxPollFailures ?? 5;
        const ack = await this.request({ operation: 'execute', execution });
        if (!('status' in ack)) throw new ExecutorTransportError();
        if (ack.status === 'rejected')
            return { admitted: false, reason: 'reason' in ack ? ack.reason : undefined };
        if (ack.status !== 'admitted' || !('duplicate' in ack)) throw new ExecutorTransportError();
        const duplicate = ack.duplicate;
        let failures = 0;
        for (;;) {
            if (options.signal?.aborted) throw new ExecutorTransportError();
            let response: ExecutorResponse;
            try {
                response = await this.pollSlot(
                    () =>
                        this.request({
                            operation: 'result',
                            invocationId: execution.invocationId,
                        }),
                    options.signal,
                );
            } catch (error) {
                if (options.signal?.aborted) throw new ExecutorTransportError();
                // A result poll is read-only and safe to repeat.
                if (++failures >= maxFailures) throw error;
                await sleep(interval, options.signal);
                continue;
            }
            failures = 0;
            if (!('result' in response)) throw new ExecutorTransportError();
            if (response.result.state === 'done')
                return {
                    admitted: true,
                    duplicate,
                    outcome: response.result.outcome as ExecutionOutcome,
                    quiescent: response.result.quiescent,
                };
            if (response.result.state === 'unknown_invocation') throw new ExecutorTransportError();
            await sleep(interval, options.signal);
        }
    }
    /** Polls share one control-channel slot so concurrent executions never
     * exhaust the connection budget that status/cancel/drain need. */
    private pollTail: Promise<unknown> = Promise.resolve();
    private pollSlot<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
        const next = this.pollTail.then(() => {
            // An entry that aborted while queued never reaches the wire.
            if (signal?.aborted) throw new ExecutorTransportError();
            return run();
        });
        this.pollTail = next.catch(() => {});
        if (!signal) return next;
        // Abort rejects immediately, even while waiting behind other polls.
        return new Promise<T>((resolve, reject) => {
            const onAbort = (): void => reject(new ExecutorTransportError());
            if (signal.aborted) return onAbort();
            signal.addEventListener('abort', onAbort, { once: true });
            next.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
        });
    }
    async request(command: ExecutorRequest['command']): Promise<ExecutorResponse> {
        const requestId = randomUUID();
        const frame = encodeTaskFrame(
            ExecutorRequestSchema.parse({
                version: EXECUTOR_PROTOCOL_VERSION,
                requestId,
                secret: this.options.secret,
                command,
            }),
        );
        const executing = command.operation === 'execute';
        if (executing ? this.executing >= 4 : this.controlling >= 2)
            throw new Error('Executor client capacity exceeded');
        if (executing) this.executing++;
        else this.controlling++;
        try {
            return await new Promise<ExecutorResponse>((resolve, reject) => {
                const decoder = new TaskFrameDecoder();
                const socket = createConnection(
                    command.operation === 'execute'
                        ? this.options.socketPath
                        : (this.options.controlSocketPath ?? this.options.socketPath),
                );
                let finished = false;
                const timer = setTimeout(() => fail(), this.options.timeoutMs ?? 30_000);
                const fail = (): void => {
                    if (finished) return;
                    finished = true;
                    clearTimeout(timer);
                    socket.destroy();
                    reject(new ExecutorTransportError());
                };
                socket.once('error', fail);
                socket.once('close', () => {
                    if (!finished) fail();
                });
                socket.once('connect', () => socket.write(frame));
                socket.on('data', (chunk: Buffer) => {
                    try {
                        const messages = decoder.push(chunk);
                        if (messages.length === 0) return;
                        if (messages.length !== 1) return fail();
                        const response = ExecutorResponseSchema.parse(messages[0]);
                        if (response.requestId !== requestId) return fail();
                        decoder.finish();
                        finished = true;
                        clearTimeout(timer);
                        socket.end();
                        resolve(response);
                    } catch {
                        fail();
                    }
                });
                socket.once('end', () => {
                    if (!finished) fail();
                });
            });
        } finally {
            if (executing) this.executing--;
            else this.controlling--;
        }
    }
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolve) => {
        const timer = setTimeout(done, ms);
        function done(): void {
            clearTimeout(timer);
            signal?.removeEventListener('abort', done);
            resolve();
        }
        signal?.addEventListener('abort', done, { once: true });
    });
}
