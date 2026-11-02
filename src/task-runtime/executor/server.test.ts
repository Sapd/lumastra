// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeTaskFrame, TaskFrameDecoder } from '../protocol.js';
import { startExecutorServer } from './server.js';
import {
    ExecutionAdmissionRejectedError,
    type ExecutionBackend,
    type ExecutionCommand,
    type ExecutionOutcome,
} from './protocol.js';

const revision = 'a'.repeat(64);
const secret = randomBytes(32).toString('hex');
function execution(): ExecutionCommand {
    return {
        invocationId: randomUUID(),
        dispatchId: randomUUID(),
        authority: { partition: 'task:fixture-task', generation: '1', ownerId: randomUUID() },
        catalogRevision: revision,
        taskId: 'fixture-task',
        queueName: 'fixture-task',
        runId: `run_${randomUUID()}`,
        jobId: randomUUID(),
        lockToken: randomUUID(),
        lockDurationMs: 30_000,
    };
}
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(
    execute: ExecutionBackend['execute'] = async () => ({
        status: 'completed',
        result: { success: true },
    }),
    maxConcurrent = 1,
    idleTimeoutMs = 30_000,
    isRunQuiescent?: (runId: string) => boolean,
    extra: Partial<Parameters<typeof startExecutorServer>[0]> = {},
) {
    const directory = await mkdtemp(path.join(tmpdir(), 'exec-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    let quiet = true;
    const backend: ExecutionBackend = {
        execute: vi.fn(execute),
        cancel: vi.fn(),
        isQuiescent: () => quiet,
        ...(isRunQuiescent ? { isRunQuiescent } : {}),
        close: vi.fn(async () => {}),
    };
    const authorize = vi.fn(async () => {});
    const settled = vi.fn(async (_command: ExecutionCommand, _outcome: ExecutionOutcome) => {});
    const reconcile = vi.fn(
        async (): Promise<
            | { state: 'active' }
            | { state: 'absent' }
            | { state: 'settled'; outcome: ExecutionOutcome }
        > => ({ state: 'active' }),
    );
    const server = await startExecutorServer({
        directory,
        secret,
        executor: backend,
        catalogRevision: () => revision,
        authorize,
        settled,
        maxConcurrent,
        idleTimeoutMs,
        reconcile,
        ...extra,
    });
    cleanup.push(async () => {
        quiet = true;
        settled.mockResolvedValue(undefined);
        reconcile.mockResolvedValue({ state: 'active' });
        await server.drain(2000);
        await server.close();
    });
    const socket = createConnection(server.socketPath);
    socket.on('error', () => {});
    await once(socket, 'connect');
    cleanup.push(async () => {
        socket.destroy();
    });
    const decoder = new TaskFrameDecoder();
    const replies: Array<Record<string, unknown>> = [];
    socket.on('data', (data: Buffer) => {
        replies.push(...(decoder.push(data) as Array<Record<string, unknown>>));
    });
    const send = (command: unknown, session = secret) => {
        const requestId = randomUUID();
        socket.write(encodeTaskFrame({ version: 2, secret: session, requestId, command }));
        return requestId;
    };
    const reply = async (id: string) => {
        await vi.waitFor(() => {
            expect(replies.find((item) => item.requestId === id)).toBeDefined();
        });
        return replies.find((item) => item.requestId === id)!;
    };
    /** Executes through the real two-step protocol: admission ack, then polled result. */
    const run = async (
        command: ExecutionCommand,
        settle = true,
    ): Promise<Record<string, unknown>> => {
        const ack = await reply(send({ operation: 'execute', execution: command }));
        if (ack.status !== 'admitted') return ack;
        let result: Record<string, unknown> = {};
        await vi.waitFor(async () => {
            result = (
                await reply(send({ operation: 'result', invocationId: command.invocationId }))
            ).result as Record<string, unknown>;
            expect(result.state === 'done' && (!settle || result.quiescent === true)).toBe(true);
        });
        return result;
    };
    return {
        run,
        directory,
        server,
        backend,
        authorize,
        settled,
        reconcile,
        send,
        reply,
        socket,
        setQuiet: (value: boolean) => {
            quiet = value;
        },
    };
}

describe('private executor IPC', () => {
    it('uses a private socket, authorizes before execution and settles after actual quiescence', async () => {
        const f = await fixture();
        expect((await stat(f.server.socketPath)).mode & 0o777).toBe(0o600);
        const command = execution();
        expect(await f.run(command)).toMatchObject({
            state: 'done',
            outcome: { status: 'completed', result: { success: true } },
            quiescent: true,
        });
        expect(f.authorize).toHaveBeenCalledWith(command);
        expect(f.settled).toHaveBeenCalledWith(command, {
            status: 'completed',
            result: { success: true },
        });
    });
    it('rejects a mismatched session before authorization', async () => {
        const f = await fixture();
        const closed = once(f.socket, 'close');
        f.send({ operation: 'execute', execution: execution() }, 'b'.repeat(64));
        await closed;
        expect(f.authorize).not.toHaveBeenCalled();
        expect(f.backend.execute).not.toHaveBeenCalled();
    });
    it('bounds capacity and rejects stale catalogs before admission', async () => {
        let finish!: (outcome: ExecutionOutcome) => void;
        const f = await fixture(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const wrong = execution();
        wrong.catalogRevision = 'b'.repeat(64);
        expect(await f.reply(f.send({ operation: 'execute', execution: wrong }))).toMatchObject({
            status: 'rejected',
            reason: 'catalog_mismatch',
        });
        const first = execution();
        const id = f.send({ operation: 'execute', execution: first });
        await vi.waitFor(() => expect(f.backend.execute).toHaveBeenCalledTimes(1));
        expect(
            await f.reply(f.send({ operation: 'execute', execution: execution() })),
        ).toMatchObject({ status: 'rejected', reason: 'capacity' });
        finish({ status: 'completed' });
        expect(await f.reply(id)).toMatchObject({ status: 'admitted', duplicate: false });
        await vi.waitFor(() => expect(f.settled).toHaveBeenCalledTimes(1));
        expect(f.authorize).toHaveBeenCalledTimes(1);
    });
    it('keeps logical completion reserved while a plugin continuation remains and refuses close', async () => {
        const f = await fixture();
        f.setQuiet(false);
        const command = execution();
        expect(await f.run(command, false)).toMatchObject({ state: 'done', quiescent: false });
        expect(f.settled).not.toHaveBeenCalled();
        expect(await f.server.drain(0)).toMatchObject({ active: 1, quiescent: false });
        await expect(f.server.close()).rejects.toThrow('teardown not confirmed');
        f.setQuiet(true);
        expect(await f.server.drain(1000)).toMatchObject({ active: 0, quiescent: true });
        expect(f.settled).toHaveBeenCalledTimes(1);
    });
    it('requests cancellation but waits for actual execution settlement before reporting drained', async () => {
        let finish!: (outcome: ExecutionOutcome) => void;
        let signal!: AbortSignal;
        const f = await fixture((_command, incoming) => {
            signal = incoming;
            return new Promise((resolve) => {
                finish = resolve;
            });
        });
        const command = execution();
        await f.reply(f.send({ operation: 'execute', execution: command }));
        await vi.waitFor(() => expect(f.backend.execute).toHaveBeenCalledTimes(1));
        expect(
            await f.reply(f.send({ operation: 'cancel', invocationId: command.invocationId })),
        ).toMatchObject({ status: 'cancellation_requested' });
        expect(signal.aborted).toBe(true);
        expect(await f.server.drain(0)).toMatchObject({ quiescent: false });
        finish({ status: 'unknown' });
        expect(await f.server.drain(1000)).toMatchObject({ quiescent: true });
    });
    it('does not start a plugin when cancellation arrives during durable admission', async () => {
        const f = await fixture();
        let admit!: () => void;
        f.authorize.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    admit = resolve;
                }),
        );
        const command = execution();
        const id = f.send({ operation: 'execute', execution: command });
        await vi.waitFor(() => expect(f.authorize).toHaveBeenCalledTimes(1));
        await f.reply(f.send({ operation: 'cancel', invocationId: command.invocationId }));
        admit();
        expect(await f.reply(id)).toMatchObject({ status: 'admitted' });
        expect(
            await f.reply(f.send({ operation: 'result', invocationId: command.invocationId })),
        ).toMatchObject({ result: { state: 'done', outcome: { status: 'unknown' } } });
        await vi.waitFor(() => expect(f.settled).toHaveBeenCalledTimes(1));
        expect(f.backend.execute).not.toHaveBeenCalled();
        expect(f.settled).toHaveBeenCalledWith(command, { status: 'unknown' });
    });
    it('does not consume capacity after a known rolled-back admission denial', async () => {
        const f = await fixture();
        f.authorize.mockRejectedValueOnce(new ExecutionAdmissionRejectedError());
        expect(
            await f.reply(f.send({ operation: 'execute', execution: execution() })),
        ).toMatchObject({ status: 'rejected', reason: 'admission_denied' });
        expect(f.backend.execute).not.toHaveBeenCalled();
        expect(f.settled).not.toHaveBeenCalled();
        expect(await f.run(execution())).toMatchObject({ outcome: { status: 'completed' } });
    });
    it('retains ambiguous admission as UNKNOWN for durable reconciliation without invoking a plugin', async () => {
        const f = await fixture();
        f.authorize.mockRejectedValueOnce(new Error('connection lost after commit'));
        const command = execution();
        expect(await f.run(command)).toMatchObject({ outcome: { status: 'unknown' } });
        expect(f.backend.execute).not.toHaveBeenCalled();
        expect(f.settled).toHaveBeenCalledWith(command, { status: 'unknown' });
    });
    it('keeps authenticated control reachable while all data sockets execute long jobs', async () => {
        const pending = new Map<
            string,
            { signal: AbortSignal; finish: (outcome: ExecutionOutcome) => void }
        >();
        const f = await fixture(
            (command, signal) =>
                new Promise((resolve) => {
                    pending.set(command.invocationId, { signal, finish: resolve });
                }),
            4,
        );
        const connect = async (address: string) => {
            const socket = createConnection(address);
            socket.on('error', () => {});
            await once(socket, 'connect');
            cleanup.push(async () => {
                socket.destroy();
            });
            const decoder = new TaskFrameDecoder();
            const replies = new Map<string, Record<string, unknown>>();
            socket.on('data', (data: Buffer) => {
                for (const item of decoder.push(data) as Array<Record<string, unknown>>)
                    replies.set(item.requestId as string, item);
            });
            return async (command: unknown) => {
                const id = randomUUID();
                socket.write(encodeTaskFrame({ version: 2, secret, requestId: id, command }));
                await vi.waitFor(() => expect(replies.has(id)).toBe(true));
                return replies.get(id)!;
            };
        };
        const commands = Array.from({ length: 4 }, execution);
        const jobs: Array<Promise<unknown>> = [];
        try {
            const first = f.send({ operation: 'execute', execution: commands[0] });
            jobs.push(f.reply(first));
            for (const command of commands.slice(1)) {
                const request = await connect(f.server.socketPath);
                jobs.push(request({ operation: 'execute', execution: command }));
            }
            await Promise.all(jobs);
            await vi.waitFor(() => expect(pending.size).toBe(4));
            expect((await stat(f.server.controlSocketPath)).mode & 0o777).toBe(0o600);
            const control = await connect(f.server.controlSocketPath);
            expect(await control({ operation: 'status' })).toMatchObject({
                status: { active: 4, quiescent: false },
            });
            expect(await control({ operation: 'execute', execution: execution() })).toMatchObject({
                status: 'rejected',
                reason: 'control_channel',
            });
            expect(f.authorize).toHaveBeenCalledTimes(4);
            expect(
                await control({ operation: 'cancel', invocationId: commands[0].invocationId }),
            ).toMatchObject({ status: 'cancellation_requested' });
            expect(pending.get(commands[0].invocationId)?.signal.aborted).toBe(true);
            expect(await control({ operation: 'drain' })).toMatchObject({
                status: { draining: true, active: 4, quiescent: false },
            });
            expect([...pending.values()].every((entry) => entry.signal.aborted)).toBe(true);
        } finally {
            for (const entry of pending.values()) entry.finish({ status: 'unknown' });
            await Promise.all(jobs);
            await f.server.drain(2000);
        }
    });
    it('automatically flushes a late continuation and retains its cancellation metadata', async () => {
        const f = await fixture();
        f.setQuiet(false);
        const command = execution();
        await f.run(command, false);
        expect(
            await f.reply(f.send({ operation: 'cancel', invocationId: command.invocationId })),
        ).toMatchObject({ status: 'cancellation_requested' });
        expect(f.backend.cancel).toHaveBeenCalledWith(command.runId);
        f.setQuiet(true);
        // No status query or another job is needed to release the receipt.
        await vi.waitFor(() => expect(f.settled).toHaveBeenCalledTimes(1));
        expect(await f.server.drain(0)).toMatchObject({ quiescent: true });
    });
    it('isolates one failed receipt while another settles', async () => {
        const f = await fixture(undefined, 2);
        const first = execution();
        const second = execution();
        f.settled.mockImplementation(async (command?: ExecutionCommand) => {
            if (command?.invocationId === first.invocationId)
                throw new Error('temporary database loss');
        });
        await f.run(first, false);
        await f.run(second);
        expect(f.settled).toHaveBeenCalledWith(second, {
            status: 'completed',
            result: { success: true },
        });
        expect(await f.server.drain(0)).toMatchObject({ active: 1, quiescent: false });
    });
    it('keeps status and drain bounded while a durable settlement is hung', async () => {
        const f = await fixture();
        let finish!: () => void;
        f.settled.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    finish = resolve;
                }),
        );
        await f.run(execution(), false);
        await vi.waitFor(() => expect(f.settled).toHaveBeenCalledTimes(1));
        const started = performance.now();
        expect(await f.reply(f.send({ operation: 'status' }))).toMatchObject({
            status: { active: 1, quiescent: false },
        });
        expect(await f.reply(f.send({ operation: 'drain' }))).toMatchObject({
            status: { quiescent: false },
        });
        expect(await f.server.drain(30)).toMatchObject({ quiescent: false });
        expect(performance.now() - started).toBeLessThan(500);
        finish();
        expect(await f.server.drain(1000)).toMatchObject({ quiescent: true });
    });
    it('reconciles a proven-absent ambiguous admission without mutating a receipt', async () => {
        const f = await fixture();
        f.authorize.mockRejectedValueOnce(new Error('admission acknowledgement lost'));
        f.reconcile.mockResolvedValueOnce({ state: 'absent' });
        expect(await f.run(execution())).toMatchObject({
            outcome: { status: 'unknown' },
            quiescent: true,
        });
        expect(f.settled).not.toHaveBeenCalled();
        expect(f.backend.execute).not.toHaveBeenCalled();
    });
    it('keeps an authenticated long execution connected beyond the idle timeout', async () => {
        let finish!: (outcome: ExecutionOutcome) => void;
        const f = await fixture(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
            1,
            40,
        );
        const command = execution();
        expect(await f.reply(f.send({ operation: 'execute', execution: command }))).toMatchObject({
            status: 'admitted',
        });
        await vi.waitFor(() => expect(f.backend.execute).toHaveBeenCalledTimes(1));
        // The ack is already delivered, so the connection idles out while the run goes on.
        await vi.waitFor(() => expect(f.socket.destroyed).toBe(true));
        finish({ status: 'completed' });
    });
    it('settles invalid plugin output as bounded UNKNOWN and leaves capacity reusable', async () => {
        const f = await fixture(async () => ({ status: 'completed', result: 1n }));
        for (let index = 0; index < 2; index++) {
            expect(await f.run(execution())).toMatchObject({
                outcome: { status: 'unknown', reason: 'invalid_result' },
                quiescent: true,
            });
        }
        expect(f.settled).toHaveBeenCalledTimes(2);
        expect(f.socket.destroyed).toBe(false);
    });
    it('reads a matched settled admission after a lost acknowledgement without re-executing', async () => {
        const f = await fixture();
        f.authorize.mockRejectedValueOnce(new Error('lost acknowledgement'));
        f.reconcile.mockResolvedValueOnce({
            state: 'settled',
            outcome: { status: 'completed', result: { durable: true } },
        });
        expect(await f.run(execution())).toMatchObject({
            outcome: { status: 'completed', result: { durable: true } },
            quiescent: true,
        });
        expect(f.backend.execute).not.toHaveBeenCalled();
        expect(f.settled).not.toHaveBeenCalled();
    });
    it('rechecks quiescence when a prior settlement interleaves with a surviving continuation', async () => {
        const f = await fixture(undefined, 2);
        let finishFirst!: () => void;
        f.settled.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    finishFirst = resolve;
                }),
        );
        await f.run(execution(), false);
        await vi.waitFor(() => expect(f.settled).toHaveBeenCalledTimes(1));
        vi.mocked(f.backend.execute).mockImplementationOnce(async () => {
            f.setQuiet(false);
            return { status: 'completed' };
        });
        const second = execution();
        await f.run(second, false);
        finishFirst();
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(f.settled).toHaveBeenCalledTimes(1);
        f.setQuiet(true);
        await vi.waitFor(() =>
            expect(f.settled).toHaveBeenCalledWith(second, { status: 'completed' }),
        );
    });
    it('answers a repeated invocation id idempotently instead of rejecting it', async () => {
        let finish!: (outcome: ExecutionOutcome) => void;
        const f = await fixture(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
            2,
        );
        const command = execution();
        expect(await f.reply(f.send({ operation: 'execute', execution: command }))).toMatchObject({
            status: 'admitted',
            duplicate: false,
        });
        expect(await f.reply(f.send({ operation: 'execute', execution: command }))).toMatchObject({
            status: 'admitted',
            duplicate: true,
        });
        expect(
            await f.reply(f.send({ operation: 'result', invocationId: command.invocationId })),
        ).toMatchObject({ result: { state: 'running' } });
        // Same id, different run: a genuine conflict, distinguishable from a duplicate.
        expect(
            await f.reply(
                f.send({
                    operation: 'execute',
                    execution: { ...command, runId: `run_${randomUUID()}` },
                }),
            ),
        ).toMatchObject({ status: 'rejected', reason: 'invocation_conflict' });
        finish({ status: 'completed' });
        expect(await f.run(command)).toMatchObject({ outcome: { status: 'completed' } });
        await vi.waitFor(() => expect(f.settled).toHaveBeenCalledTimes(1));
        // After settlement the retried id still resolves to the stored result.
        expect(await f.reply(f.send({ operation: 'execute', execution: command }))).toMatchObject({
            status: 'admitted',
            duplicate: true,
        });
        expect(f.backend.execute).toHaveBeenCalledTimes(1);
        expect(f.authorize).toHaveBeenCalledTimes(1);
        expect(
            await f.reply(f.send({ operation: 'result', invocationId: randomUUID() })),
        ).toMatchObject({ result: { state: 'unknown_invocation' } });
    });
    it('settles a finished run while another run is still executing', async () => {
        const finishers = new Map<string, (outcome: ExecutionOutcome) => void>();
        const live = new Set<string>();
        const f = await fixture(
            (command) =>
                new Promise((resolve) => {
                    live.add(command.runId);
                    finishers.set(command.invocationId, (outcome) => {
                        resolve(outcome);
                    });
                }),
            2,
            30_000,
            (runId) => !live.has(runId),
        );
        const slow = execution();
        const quick = execution();
        await f.reply(f.send({ operation: 'execute', execution: slow }));
        await f.reply(f.send({ operation: 'execute', execution: quick }));
        await vi.waitFor(() => expect(finishers.size).toBe(2));
        finishers.get(quick.invocationId)?.({ status: 'completed' });
        live.delete(quick.runId);
        // The slow run is still executing; the quick receipt must not wait for it.
        await vi.waitFor(() =>
            expect(f.settled).toHaveBeenCalledWith(quick, { status: 'completed' }),
        );
        expect(f.settled).toHaveBeenCalledTimes(1);
        live.delete(slow.runId);
        finishers.get(slow.invocationId)?.({ status: 'completed' });
        await vi.waitFor(() => expect(f.settled).toHaveBeenCalledTimes(2));
    });
    it('keeps unfetched settled results past the limit and evicts only fetched ones', async () => {
        const f = await fixture(undefined, 3, 30_000, undefined, { finishedLimit: 1 });
        const [a, b, c] = [execution(), execution(), execution()];
        for (const command of [a, b]) {
            expect(
                await f.reply(f.send({ operation: 'execute', execution: command })),
            ).toMatchObject({ status: 'admitted' });
            await vi.waitFor(() =>
                expect(f.settled).toHaveBeenCalledWith(command, expect.anything()),
            );
        }
        // Over the limit, but neither result has been fetched: both survive.
        await vi.waitFor(async () =>
            expect(
                await f.reply(f.send({ operation: 'result', invocationId: a.invocationId })),
            ).toMatchObject({ result: { state: 'done' } }),
        );
        await f.reply(f.send({ operation: 'execute', execution: c }));
        await vi.waitFor(() => expect(f.settled).toHaveBeenCalledWith(c, expect.anything()));
        expect(
            await f.reply(f.send({ operation: 'result', invocationId: a.invocationId })),
        ).toMatchObject({ result: { state: 'unknown_invocation' } });
        expect(
            await f.reply(f.send({ operation: 'result', invocationId: b.invocationId })),
        ).toMatchObject({ result: { state: 'done' } });
    });
    it('consults durable admission for an id that is not in memory and never re-executes it', async () => {
        const lookup = vi.fn(
            async (): Promise<
                | { state: 'absent' }
                | { state: 'active' }
                | { state: 'settled'; outcome: ExecutionOutcome }
            > => ({ state: 'absent' }),
        );
        const f = await fixture(undefined, 2, 30_000, undefined, {
            lookupAdmission: lookup,
        });
        const command = execution();
        await f.run(command);
        expect(lookup).toHaveBeenCalledTimes(1);
        expect(f.backend.execute).toHaveBeenCalledTimes(1);
        // Durable record says it already settled: same admission, no second run.
        const evicted = execution();
        lookup.mockResolvedValueOnce({
            state: 'settled',
            outcome: { status: 'completed', result: { durable: true } },
        });
        expect(await f.reply(f.send({ operation: 'execute', execution: evicted }))).toMatchObject({
            status: 'admitted',
            duplicate: true,
        });
        expect(
            await f.reply(f.send({ operation: 'result', invocationId: evicted.invocationId })),
        ).toMatchObject({
            result: {
                state: 'done',
                outcome: { status: 'completed', result: { durable: true } },
                quiescent: true,
            },
        });
        expect(f.backend.execute).toHaveBeenCalledTimes(1);
        expect(f.authorize).toHaveBeenCalledTimes(1);
        // Durably active elsewhere: refuse rather than start a second copy.
        lookup.mockResolvedValueOnce({ state: 'active' });
        expect(
            await f.reply(f.send({ operation: 'execute', execution: execution() })),
        ).toMatchObject({ status: 'rejected', reason: 'invocation_conflict' });
        // Unreadable durable record fails closed.
        lookup.mockRejectedValueOnce(new Error('db down'));
        expect(
            await f.reply(f.send({ operation: 'execute', execution: execution() })),
        ).toMatchObject({ status: 'rejected', reason: 'admission_denied' });
        expect(f.backend.execute).toHaveBeenCalledTimes(1);
    });
    it('rejects oversized framing before invoking application code', async () => {
        const f = await fixture();
        const closed = once(f.socket, 'close');
        const header = Buffer.alloc(4);
        header.writeUInt32BE(1024 * 1024);
        f.socket.write(header);
        await closed;
        expect(f.authorize).not.toHaveBeenCalled();
    });
});
