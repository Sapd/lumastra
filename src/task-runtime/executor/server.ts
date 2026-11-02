// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { timingSafeEqual } from 'node:crypto';
import { chmod, lstat, unlink } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import path from 'node:path';
import { encodeTaskFrame, TaskFrameDecoder, TASK_MAX_FRAME_BYTES } from '../protocol.js';
import {
    EXECUTOR_PROTOCOL_VERSION,
    ExecutorRequestSchema,
    ExecutionAdmissionRejectedError,
    normalizeExecutionOutcome,
    type ExecutionBackend,
    type ExecutionCommand,
    type ExecutionOutcome,
    type ExecutionRejectionReason,
} from './protocol.js';

export interface ExecutorServerOptions {
    /** An already-created, process-owned 0700 directory. Never remove arbitrary stale sockets. */
    directory: string;
    secret: string;
    executor: ExecutionBackend;
    catalogRevision: () => string;
    /** Must durably admit exact invocation before any job/context mutation. */
    authorize: (command: ExecutionCommand) => Promise<void>;
    /** Called only when every real runner continuation is quiescent. */
    settled?: (command: ExecutionCommand, outcome: ExecutionOutcome) => Promise<void>;
    maxConcurrent?: number;
    idleTimeoutMs?: number;
    /** Retained settled results before eviction is considered (default 256). */
    finishedLimit?: number;
    /** Read-only durable admission lookup, consulted for an invocation id that is
     * not in memory so a retried id after eviction/restart never runs again. */
    lookupAdmission?: (
        command: ExecutionCommand,
    ) => Promise<
        { state: 'absent' } | { state: 'active' } | { state: 'settled'; outcome: ExecutionOutcome }
    >;
    reconcile?: (
        command: ExecutionCommand,
    ) => Promise<
        { state: 'absent' } | { state: 'active' } | { state: 'settled'; outcome: ExecutionOutcome }
    >;
}

export async function startExecutorServer(options: ExecutorServerOptions) {
    if (!/^[a-f0-9]{64}$/.test(options.secret)) throw new Error('Invalid executor session secret');
    const directory = await lstat(options.directory);
    if (
        !directory.isDirectory() ||
        directory.isSymbolicLink() ||
        (directory.mode & 0o777) !== 0o700 ||
        directory.uid !== process.getuid?.()
    )
        throw new Error('Executor socket directory must be owned and private');
    const max = options.maxConcurrent ?? 8;
    if (!Number.isInteger(max) || max < 1 || max > 32) throw new Error('Invalid executor capacity');
    const idleTimeoutMs = options.idleTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 10 || idleTimeoutMs > 300_000)
        throw new Error('Invalid executor idle timeout');
    const socketPath = path.join(options.directory, 'executor.sock');
    const controlSocketPath = path.join(options.directory, 'executor-control.sock');
    // Unix sockets have a platform-specific length cap; keep below macOS/Linux minima.
    if (Buffer.byteLength(controlSocketPath) > 100)
        throw new Error('Executor socket path too long');
    const sockets = new Set<Socket>();
    const dataSockets = new Set<Socket>();
    const controlSockets = new Set<Socket>();
    type Admission = 'admitted' | 'duplicate' | ExecutionRejectionReason;
    const executions = new Map<
        string,
        { command: ExecutionCommand; abort: AbortController; admission: Promise<Admission> }
    >();
    interface Receipt {
        command: ExecutionCommand;
        outcome: ExecutionOutcome;
        abort: AbortController;
        uncertain: boolean;
        work?: Promise<void>;
        retryAt: number;
    }
    const receipts = new Map<string, Receipt>();
    const runs = new Set<string>();
    // Memory of settled invocations so a late `result` poll or a retried `execute`
    // for the same id is answered idempotently. An entry is evicted only once its
    // result was fetched or it is old; a hard cap bounds memory regardless.
    const FINISHED_LIMIT = options.finishedLimit ?? 256;
    const FINISHED_MAX_AGE_MS = 60 * 60 * 1000;
    interface Finished {
        runId: string;
        outcome: ExecutionOutcome;
        at: number;
        fetched: boolean;
    }
    const finished = new Map<string, Finished>();
    const rememberFinished = (id: string, runId: string, outcome: ExecutionOutcome): void => {
        finished.delete(id);
        finished.set(id, { runId, outcome, at: Date.now(), fetched: false });
        const now = Date.now();
        while (finished.size > FINISHED_LIMIT) {
            let victim: string | undefined;
            for (const [key, entry] of finished)
                if (entry.fetched || now - entry.at > FINISHED_MAX_AGE_MS) {
                    victim = key;
                    break;
                }
            if (victim === undefined && finished.size > FINISHED_LIMIT * 4)
                victim = finished.keys().next().value;
            if (victim === undefined) break;
            finished.delete(victim);
        }
    };
    const retire = (id: string, entry: Receipt): void => {
        receipts.delete(id);
        runs.delete(entry.command.runId);
        rememberFinished(id, entry.command.runId, entry.outcome);
    };
    const runQuiescent = (entry: Receipt): boolean =>
        options.executor.isRunQuiescent
            ? options.executor.isRunQuiescent(entry.command.runId)
            : executions.size === 0 && options.executor.isQuiescent();
    let draining = false;
    let closed = false;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const status = () => ({
        draining,
        active: executions.size + receipts.size,
        quiescent: executions.size === 0 && receipts.size === 0 && options.executor.isQuiescent(),
    });
    const scheduleFlush = (): void => {
        if (closed || flushTimer || receipts.size === 0) return;
        flushTimer = setTimeout(() => {
            flushTimer = undefined;
            kickFlush();
        }, 100);
        flushTimer.unref();
    };
    const kickFlush = (): void => {
        if (closed) return;
        for (const [id, entry] of receipts) {
            // Each receipt settles as soon as ITS run is quiescent; another
            // still-executing run must not hold it back. Checked afresh because
            // an asynchronous settlement can interleave with surviving work.
            if (entry.work || performance.now() < entry.retryAt || !runQuiescent(entry)) continue;
            entry.work = (async () => {
                if (entry.uncertain) {
                    if (!options.reconcile) throw new Error('Admission reconciliation unavailable');
                    const recovered = await options.reconcile(entry.command);
                    if (recovered.state === 'absent') {
                        retire(id, entry);
                        return;
                    }
                    if (recovered.state === 'settled') {
                        entry.outcome = normalizeExecutionOutcome(recovered.outcome);
                        retire(id, entry);
                        return;
                    }
                    entry.uncertain = false;
                }
                if (!runQuiescent(entry)) return;
                if (options.settled) await options.settled(entry.command, entry.outcome);
                retire(id, entry);
            })()
                .catch(() => {
                    // One unavailable receipt must not prevent another from settling.
                    entry.retryAt = performance.now() + 1000;
                })
                .finally(() => {
                    entry.work = undefined;
                    scheduleFlush();
                });
        }
        scheduleFlush();
    };
    const runInvocation = async (
        execution: ExecutionCommand,
        abort: AbortController,
        settleAdmission: (value: Admission) => void,
    ): Promise<void> => {
        let admitted = false;
        let rejection: ExecutionRejectionReason | undefined;
        let duplicate = false;
        let uncertain = true;
        let outcome: ExecutionOutcome = { status: 'unknown' };
        try {
            if (options.lookupAdmission) {
                // Fail closed: an unreadable durable record must not admit a re-run.
                let known: Awaited<ReturnType<NonNullable<typeof options.lookupAdmission>>>;
                try {
                    known = await options.lookupAdmission(execution);
                } catch {
                    rejection = 'admission_denied';
                    return;
                }
                if (known.state === 'active') {
                    rejection = 'invocation_conflict';
                    return;
                }
                if (known.state === 'settled') {
                    duplicate = true;
                    rememberFinished(
                        execution.invocationId,
                        execution.runId,
                        normalizeExecutionOutcome(known.outcome),
                    );
                    return;
                }
            }
            // Admission can commit then lose its acknowledgement.
            // Retain an UNKNOWN receipt until the durable hook reconciles it.
            admitted = true;
            await options.authorize(execution);
            uncertain = false;
            settleAdmission('admitted');
            if (
                !abort.signal.aborted &&
                !draining &&
                execution.catalogRevision === options.catalogRevision()
            )
                outcome = await options.executor.execute(execution, abort.signal);
        } catch (error) {
            if (uncertain && error instanceof ExecutionAdmissionRejectedError) {
                admitted = false;
                rejection = 'admission_denied';
            }
            // Ambiguous admission/execution is never success.
        } finally {
            outcome = normalizeExecutionOutcome(outcome);
            executions.delete(execution.invocationId);
            // Keep the run reserved until actual continuation teardown.
            if (admitted && !rejection && !duplicate)
                receipts.set(execution.invocationId, {
                    command: execution,
                    outcome,
                    abort,
                    uncertain,
                    retryAt: 0,
                });
            else runs.delete(execution.runId);
            settleAdmission(rejection ?? (duplicate ? 'duplicate' : 'admitted'));
            kickFlush();
        }
    };
    const beginDrain = (): void => {
        draining = true;
        for (const { command, abort } of [...executions.values(), ...receipts.values()]) {
            abort.abort();
            options.executor.cancel(command.runId);
        }
    };
    const accept =
        (control: boolean) =>
        (socket: Socket): void => {
            const capacity = control ? controlSockets : dataSockets;
            if (closed || capacity.size >= (control ? 2 : 4)) {
                socket.destroy();
                return;
            }
            sockets.add(socket);
            capacity.add(socket);
            socket.setTimeout(idleTimeoutMs, () => socket.destroy());
            socket.on('error', () => {});
            socket.once('close', () => {
                sockets.delete(socket);
                capacity.delete(socket);
            });
            const decoder = new TaskFrameDecoder();
            let pending = 0;
            let pendingExecutions = 0;
            const reply = (value: unknown): void => {
                if (socket.destroyed) return;
                try {
                    const frame = encodeTaskFrame(value);
                    if (socket.writableLength + frame.length > TASK_MAX_FRAME_BYTES * 2) {
                        socket.destroy();
                        return;
                    }
                    socket.write(frame);
                } catch {
                    socket.destroy();
                }
            };
            socket.on('data', (chunk: Buffer) => {
                try {
                    for (const value of decoder.push(chunk)) {
                        const request = ExecutorRequestSchema.parse(value);
                        if (
                            !timingSafeEqual(
                                Buffer.from(request.secret, 'hex'),
                                Buffer.from(options.secret, 'hex'),
                            ) ||
                            pending >= max + 2
                        ) {
                            socket.destroy();
                            return;
                        }
                        pending++;
                        void (async () => {
                            const envelope = {
                                version: EXECUTOR_PROTOCOL_VERSION,
                                requestId: request.requestId,
                            };
                            const rejectWith = (reason: ExecutionRejectionReason): void =>
                                reply({ ...envelope, status: 'rejected', reason });
                            const command = request.command;
                            if (control && command.operation === 'execute') {
                                rejectWith('control_channel');
                                return;
                            }
                            if (command.operation === 'status') {
                                kickFlush();
                                reply({ ...envelope, status: status() });
                                return;
                            }
                            if (command.operation === 'drain') {
                                beginDrain();
                                kickFlush();
                                reply({ ...envelope, status: status() });
                                return;
                            }
                            if (command.operation === 'result') {
                                const id = command.invocationId;
                                const receipt = receipts.get(id);
                                const settledEntry = finished.get(id);
                                if (settledEntry && !executions.has(id) && !receipt)
                                    settledEntry.fetched = true;
                                reply({
                                    ...envelope,
                                    // An unreconciled receipt has no trustworthy outcome yet.
                                    result:
                                        executions.has(id) || receipt?.uncertain
                                            ? { state: 'running' }
                                            : receipt
                                              ? {
                                                    state: 'done',
                                                    outcome: receipt.outcome,
                                                    quiescent: false,
                                                }
                                              : settledEntry
                                                ? {
                                                      state: 'done',
                                                      outcome: settledEntry.outcome,
                                                      quiescent: true,
                                                  }
                                                : { state: 'unknown_invocation' },
                                });
                                return;
                            }
                            if (command.operation === 'cancel') {
                                const active =
                                    executions.get(command.invocationId) ??
                                    receipts.get(command.invocationId);
                                if (active) {
                                    active.abort.abort();
                                    options.executor.cancel(active.command.runId);
                                }
                                reply({
                                    ...envelope,
                                    status: active ? 'cancellation_requested' : 'not_active',
                                });
                                return;
                            }
                            const execution = command.execution;
                            // A repeated invocation id is the same admission, not a
                            // fresh rejection; the caller continues with `result`.
                            const inFlight = executions.get(execution.invocationId);
                            const known =
                                inFlight?.command ??
                                receipts.get(execution.invocationId)?.command ??
                                finished.get(execution.invocationId);
                            if (known) {
                                if (known.runId !== execution.runId) {
                                    rejectWith('invocation_conflict');
                                    return;
                                }
                                if (inFlight) {
                                    const settledAdmission = await inFlight.admission;
                                    if (
                                        settledAdmission !== 'admitted' &&
                                        settledAdmission !== 'duplicate'
                                    ) {
                                        rejectWith(settledAdmission);
                                        return;
                                    }
                                }
                                reply({ ...envelope, status: 'admitted', duplicate: true });
                                return;
                            }
                            const refusal: ExecutionRejectionReason | undefined = draining
                                ? 'draining'
                                : executions.size + receipts.size >= max
                                  ? 'capacity'
                                  : runs.has(execution.runId)
                                    ? 'run_busy'
                                    : execution.catalogRevision !== options.catalogRevision()
                                      ? 'catalog_mismatch'
                                      : undefined;
                            if (refusal) {
                                rejectWith(refusal);
                                return;
                            }
                            const abort = new AbortController();
                            let settleAdmission!: (value: Admission) => void;
                            const admission = new Promise<Admission>((resolve) => {
                                settleAdmission = resolve;
                            });
                            // Reserve synchronously before the asynchronous admission check.
                            executions.set(execution.invocationId, {
                                command: execution,
                                abort,
                                admission,
                            });
                            runs.add(execution.runId);
                            void runInvocation(execution, abort, settleAdmission).catch(() => {});
                            pendingExecutions++;
                            socket.setTimeout(0);
                            let verdict: Admission;
                            try {
                                verdict = await admission;
                            } finally {
                                pendingExecutions--;
                                if (pendingExecutions === 0 && !socket.destroyed)
                                    socket.setTimeout(idleTimeoutMs);
                            }
                            if (verdict === 'admitted' || verdict === 'duplicate')
                                reply({
                                    ...envelope,
                                    status: 'admitted',
                                    duplicate: verdict === 'duplicate',
                                });
                            else rejectWith(verdict);
                        })()
                            .catch(() => socket.destroy())
                            .finally(() => {
                                pending--;
                            });
                    }
                } catch {
                    socket.destroy();
                }
            });
            socket.once('end', () => {
                try {
                    decoder.finish();
                } catch {
                    socket.destroy();
                }
            });
            // Disconnect is not cancellation or proof of termination. Supervisors
            // reconnect/query or explicitly terminate the process before handoff.
        };
    const server = createServer(accept(false));
    const controlServer = createServer(accept(true));
    const closeListener = async (listener: ReturnType<typeof createServer>): Promise<void> => {
        if (!listener.listening) return;
        await new Promise<void>((resolve, reject) =>
            listener.close((error) => (error ? reject(error) : resolve())),
        );
    };
    try {
        for (const [listener, address] of [
            [server, socketPath],
            [controlServer, controlSocketPath],
        ] as const) {
            await new Promise<void>((resolve, reject) => {
                listener.once('error', reject);
                listener.listen(address, () => {
                    listener.off('error', reject);
                    resolve();
                });
            });
            await chmod(address, 0o600);
        }
    } catch (error) {
        for (const socket of sockets) socket.destroy();
        await Promise.all([closeListener(server), closeListener(controlServer)]);
        throw error;
    }
    return {
        socketPath,
        controlSocketPath,
        async drain(timeoutMs: number) {
            if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000)
                throw new Error('Invalid drain deadline');
            beginDrain();
            const deadline = performance.now() + timeoutMs;
            do {
                kickFlush();
                if (status().quiescent || performance.now() >= deadline) return status();
                await new Promise((resolve) => setTimeout(resolve, 10));
            } while (performance.now() < deadline);
            return status();
        },
        async close(): Promise<void> {
            beginDrain();
            kickFlush();
            if (!status().quiescent) throw new Error('Executor teardown not confirmed');
            closed = true;
            if (flushTimer) clearTimeout(flushTimer);
            for (const socket of sockets) socket.destroy();
            await Promise.all([closeListener(server), closeListener(controlServer)]);
            await options.executor.close();
            // Node normally unlinks its socket; tolerate that specific case only.
            for (const address of [socketPath, controlSocketPath]) {
                await unlink(address).catch((error: unknown) => {
                    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
                        throw error;
                });
            }
        },
    };
}
