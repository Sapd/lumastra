// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { createServer, type Socket } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { ExecutorClient, ExecutorTransportError } from './executor-client.js';
import { TaskFrameDecoder, encodeTaskFrame } from './protocol.js';

async function fixture(
    handle: (socket: Socket, request: Record<string, unknown>) => void,
): Promise<{ path: string; close(): Promise<void> }> {
    const directory = await mkdtemp(path.join(tmpdir(), 'ec-'));
    const socketPath = path.join(directory, 'e.sock');
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
        socket.on('error', () => {});
        const decoder = new TaskFrameDecoder();
        socket.on('data', (chunk: Buffer) => {
            for (const request of decoder.push(chunk))
                handle(socket, request as Record<string, unknown>);
        });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    return {
        path: socketPath,
        async close() {
            for (const socket of sockets) socket.destroy();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await rm(directory, { recursive: true, force: true });
        },
    };
}
const secret = 'a'.repeat(64);
it('correlates and validates an actual framed executor response', async () => {
    const f = await fixture((socket, request) =>
        socket.write(
            encodeTaskFrame({
                version: 2,
                requestId: request.requestId,
                status: { draining: false, active: 0, quiescent: true },
            }),
        ),
    );
    try {
        expect(
            await new ExecutorClient({ socketPath: f.path, secret }).request({
                operation: 'status',
            }),
        ).toMatchObject({ status: { quiescent: true } });
    } finally {
        await f.close();
    }
});
it('treats lost acknowledgment as UNKNOWN and sends no automatic replay', async () => {
    let commands = 0;
    const f = await fixture((socket) => {
        commands++;
        socket.destroy();
    });
    try {
        const client = new ExecutorClient({ socketPath: f.path, secret, timeoutMs: 100 });
        await expect(client.request({ operation: 'status' })).rejects.toMatchObject({
            outcome: 'unknown',
        });
        expect(commands).toBe(1);
    } finally {
        await f.close();
    }
});
it('rejects mismatched response identity and protocol version', async () => {
    const f = await fixture((socket) =>
        socket.write(
            encodeTaskFrame({
                version: 1,
                requestId: '00000000-0000-4000-8000-000000000000',
                status: 'rejected',
            }),
        ),
    );
    try {
        await expect(
            new ExecutorClient({ socketPath: f.path, secret }).request({ operation: 'status' }),
        ).rejects.toBeInstanceOf(ExecutorTransportError);
    } finally {
        await f.close();
    }
});
it('bounds deadlines and releases capacity after a silent transport times out', async () => {
    const f = await fixture(() => {});
    try {
        const client = new ExecutorClient({ socketPath: f.path, secret, timeoutMs: 25 });
        for (let i = 0; i < 2; i++)
            await expect(client.request({ operation: 'status' })).rejects.toMatchObject({
                outcome: 'unknown',
            });
    } finally {
        await f.close();
    }
});

it('uses the reserved control transport independently of execution connections', async () => {
    let executionRequests = 0;
    const data = await fixture(() => {
        executionRequests++;
    });
    const control = await fixture((socket, request) =>
        socket.write(
            encodeTaskFrame({
                version: 2,
                requestId: request.requestId,
                status: { draining: false, active: 4, quiescent: false },
            }),
        ),
    );
    try {
        const client = new ExecutorClient({
            socketPath: data.path,
            controlSocketPath: control.path,
            secret,
        });
        expect(await client.request({ operation: 'status' })).toMatchObject({
            status: { active: 4 },
        });
        expect(executionRequests).toBe(0);
    } finally {
        await data.close();
        await control.close();
    }
});

const command = (): Parameters<ExecutorClient['execute']>[0] => ({
    invocationId: randomUUID(),
    dispatchId: randomUUID(),
    authority: { partition: 'task:fixture-task', generation: '1', ownerId: randomUUID() },
    catalogRevision: 'a'.repeat(64),
    taskId: 'fixture-task',
    queueName: 'fixture-task',
    runId: `run_${randomUUID()}`,
    jobId: randomUUID(),
    lockToken: randomUUID(),
    lockDurationMs: 30_000,
});
it('waits for a run far longer than the per-RPC timeout via admission ack plus polling', async () => {
    let polls = 0;
    const f = await fixture((socket, request) => {
        const operation = (request.command as { operation: string }).operation;
        const base = { version: 2, requestId: request.requestId };
        if (operation === 'execute')
            return void socket.write(
                encodeTaskFrame({ ...base, status: 'admitted', duplicate: false }),
            );
        polls++;
        socket.write(
            encodeTaskFrame({
                ...base,
                result:
                    polls < 6
                        ? { state: 'running' }
                        : { state: 'done', outcome: { status: 'completed' }, quiescent: true },
            }),
        );
    });
    try {
        const started = performance.now();
        const result = await new ExecutorClient({
            socketPath: f.path,
            secret,
            timeoutMs: 40,
        }).execute(command(), { pollIntervalMs: 20 });
        expect(performance.now() - started).toBeGreaterThan(80);
        expect(result).toMatchObject({
            admitted: true,
            duplicate: false,
            outcome: { status: 'completed' },
            quiescent: true,
        });
    } finally {
        await f.close();
    }
});
it('reports a rejection distinctly and never polls', async () => {
    let requests = 0;
    const f = await fixture((socket, request) => {
        requests++;
        socket.write(
            encodeTaskFrame({
                version: 2,
                requestId: request.requestId,
                status: 'rejected',
                reason: 'capacity',
            }),
        );
    });
    try {
        expect(await new ExecutorClient({ socketPath: f.path, secret }).execute(command())).toEqual(
            { admitted: false, reason: 'capacity' },
        );
        expect(requests).toBe(1);
    } finally {
        await f.close();
    }
});
it('treats an unknown invocation after admission as an UNKNOWN outcome', async () => {
    const f = await fixture((socket, request) => {
        const operation = (request.command as { operation: string }).operation;
        const base = { version: 2, requestId: request.requestId };
        socket.write(
            encodeTaskFrame(
                operation === 'execute'
                    ? { ...base, status: 'admitted', duplicate: false }
                    : { ...base, result: { state: 'unknown_invocation' } },
            ),
        );
    });
    try {
        await expect(
            new ExecutorClient({ socketPath: f.path, secret }).execute(command(), {
                pollIntervalMs: 10,
            }),
        ).rejects.toBeInstanceOf(ExecutorTransportError);
    } finally {
        await f.close();
    }
});
it('rejects an aborted execution that is queued behind another execution poll', async () => {
    const f = await fixture((socket, request) => {
        const operation = (request.command as { operation: string }).operation;
        // Result polls are never answered, so the first poll holds the shared slot.
        if (operation === 'execute')
            socket.write(
                encodeTaskFrame({
                    version: 2,
                    requestId: request.requestId,
                    status: 'admitted',
                    duplicate: false,
                }),
            );
    });
    try {
        const client = new ExecutorClient({ socketPath: f.path, secret, timeoutMs: 5000 });
        const holder = client.execute(command(), { pollIntervalMs: 10 });
        holder.catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 100));
        const controller = new AbortController();
        const queued = client.execute(command(), {
            pollIntervalMs: 10,
            signal: controller.signal,
        });
        const outcome = queued.then(
            () => 'resolved',
            (error: unknown) => error,
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        const started = performance.now();
        controller.abort();
        expect(await outcome).toBeInstanceOf(ExecutorTransportError);
        expect(performance.now() - started).toBeLessThan(1000);
    } finally {
        await f.close();
    }
});
