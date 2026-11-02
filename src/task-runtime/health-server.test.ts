// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import { connect, type Socket } from 'node:net';
import {
    startTaskHealthServer,
    type TaskHealthServer,
    type TaskHealthOptions,
} from './health-server.js';

let running: TaskHealthServer | undefined;
afterEach(async () => {
    await running?.close();
    running = undefined;
});

async function start(overrides: Partial<TaskHealthOptions> = {}): Promise<string> {
    running = await startTaskHealthServer({
        host: '127.0.0.1',
        port: 0,
        basePath: '',
        ready: async () => true,
        metrics: async () => 'lumastra_task_active_runs 0\n',
        metricsContentType: 'text/plain',
        metricsPublic: false,
        metricsToken: '',
        metricsAuthorized: async () => false,
        ...overrides,
    });
    const address = running.server.address();
    if (!address || typeof address === 'string') throw new Error('Test server address missing');
    return `http://127.0.0.1:${address.port}`;
}

describe('standalone task HTTP probes over actual TCP', () => {
    it('keeps liveness independent of readiness and rejects web/task mutation routes', async () => {
        const base = await start({ ready: async () => false });
        const alive = await fetch(`${base}/api/health?detail=true`);
        expect(alive.status).toBe(200);
        expect(alive.headers.get('content-type')).toBe('application/health+json');
        expect(await alive.json()).toEqual({ status: 'pass' });
        expect((await fetch(`${base}/api/health/ready`)).status).toBe(503);
        expect((await fetch(`${base}/api/v1/tasks`)).status).toBe(404);
        expect(
            (await fetch(`${base}/api/health`, { method: 'POST', body: 'ignored' })).status,
        ).toBe(405);
    });
    it('coalesces readiness probes, respects URL base and drops readiness immediately while draining', async () => {
        const check = vi.fn(async () => true);
        const base = await start({ basePath: '/lumastra', ready: check });
        const responses = await Promise.all(
            Array.from({ length: 8 }, () => fetch(`${base}/lumastra/api/health/ready`)),
        );
        expect(responses.every((response) => response.status === 200)).toBe(true);
        expect(check).toHaveBeenCalledTimes(1);
        expect((await fetch(`${base}/api/health`)).status).toBe(404);
        running?.drain();
        expect((await fetch(`${base}/lumastra/api/health/ready`)).status).toBe(503);
        expect((await fetch(`${base}/lumastra/api/health`)).status).toBe(200);
    });
    it('blocks a memoized healthy readiness immediately and restores it after postponement', async () => {
        let blocked = false;
        const check = vi.fn(async () => true);
        const base = await start({ ready: check, readinessBlocked: () => blocked });
        expect((await fetch(`${base}/api/health/ready`)).status).toBe(200);
        blocked = true;
        expect((await fetch(`${base}/api/health/ready`)).status).toBe(503);
        expect((await fetch(`${base}/api/health`)).status).toBe(200);
        blocked = false;
        expect((await fetch(`${base}/api/health/ready`)).status).toBe(200);
        expect(check).toHaveBeenCalledOnce();
    });
    it('protects metrics with constant-time static bearer or the existing credential validator', async () => {
        const authorize = vi.fn(async (request: Request, _url: URL, peer: string) => {
            expect(peer).toBe('127.0.0.1');
            expect(request.headers.get('x-forwarded-for')).toBe('192.0.2.12');
            return request.headers.get('authorization') === 'Bearer pat_fixture';
        });
        const base = await start({ metricsToken: 'static-fixture', metricsAuthorized: authorize });
        const staticResponse = await fetch(`${base}/metrics`, {
            headers: { authorization: 'Bearer static-fixture' },
        });
        expect(staticResponse.status).toBe(200);
        expect(await staticResponse.text()).toContain('lumastra_task_active_runs');
        expect(authorize).not.toHaveBeenCalled();
        const patResponse = await fetch(`${base}/metrics`, {
            headers: { authorization: 'Bearer pat_fixture', 'x-forwarded-for': '192.0.2.12' },
        });
        expect(patResponse.status).toBe(200);
        expect(
            (
                await fetch(`${base}/metrics`, {
                    headers: { authorization: 'Bearer wrong', 'x-forwarded-for': '192.0.2.12' },
                })
            ).status,
        ).toBe(401);
    });
    it('allows public metrics only by explicit selection', async () => {
        const base = await start({ metricsPublic: true });
        expect((await fetch(`${base}/metrics`)).status).toBe(200);
    });

    it('fails liveness with a reason code when the runtime reports stalled loops, readiness unaffected', async () => {
        let alive = true;
        const base = await start({
            liveness: () =>
                alive ? { alive: true } : { alive: false, reason: 'progress_stalled' },
        });
        expect((await fetch(`${base}/api/health`)).status).toBe(200);
        alive = false;
        const stalled = await fetch(`${base}/api/health`);
        expect(stalled.status).toBe(503);
        expect(await stalled.json()).toEqual({ status: 'fail', reason: 'progress_stalled' });
        expect((await fetch(`${base}/api/health/ready`)).status).toBe(200);
    });
    it('returns non-secret readiness reasons and drops anything that is not a reason code', async () => {
        const base = await start({
            ready: async () => ({
                ready: false,
                reasons: [
                    'database_unavailable',
                    'task_valkey_unavailable',
                    'connect ECONNREFUSED redis://user:pw@10.0.0.5:6379',
                ],
            }),
        });
        const response = await fetch(`${base}/api/health/ready`);
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({
            status: 'fail',
            ready: false,
            reasons: ['database_unavailable', 'task_valkey_unavailable'],
        });
    });
    it('reports upgrade, drain and a throwing check as reasons', async () => {
        let blocked: boolean | string = 'upgrade_prepared';
        const base = await start({
            readinessBlocked: () => blocked,
            ready: async () => {
                throw new Error('postgres://secret@db/x');
            },
        });
        expect(await (await fetch(`${base}/api/health/ready`)).json()).toMatchObject({
            reasons: ['upgrade_prepared'],
        });
        blocked = false;
        const failed = await (await fetch(`${base}/api/health/ready`)).json();
        expect(failed.reasons).toEqual(['readiness_check_failed']);
        expect(JSON.stringify(failed)).not.toContain('secret');
        running?.drain();
        expect(await (await fetch(`${base}/api/health/ready`)).json()).toMatchObject({
            reasons: ['draining'],
        });
    });
    it('reads the metrics token and public flag on every request', async () => {
        let token = 'first-token';
        let isPublic = false;
        const base = await start({ metricsToken: () => token, metricsPublic: () => isPublic });
        const get = (bearer: string): Promise<number> =>
            fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${bearer}` } }).then(
                (r) => r.status,
            );
        expect(await get('first-token')).toBe(200);
        token = 'rotated-token';
        expect(await get('first-token')).toBe(401);
        expect(await get('rotated-token')).toBe(200);
        isPublic = true;
        expect((await fetch(`${base}/metrics`)).status).toBe(200);
    });
    it('rejects absolute-form, authority-form, asterisk and protocol-relative targets with 400', async () => {
        const base = await start();
        const port = Number(new URL(base).port);
        const raw = (target: string, method = 'GET'): Promise<string> =>
            new Promise((resolve) => {
                const socket = connect(port, '127.0.0.1', () => {
                    socket.write(
                        `${method} ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`,
                    );
                });
                let data = '';
                socket.on('data', (chunk) => (data += chunk.toString()));
                socket.on('close', () => resolve(data.split('\r\n')[0] ?? ''));
                socket.on('error', () => resolve(data.split('\r\n')[0] ?? ''));
            });
        expect(await raw('http://evil.example/api/health')).toContain(' 400 ');
        expect(await raw('*', 'OPTIONS')).toContain(' 400 ');
        expect(await raw('//evil.example/api/health')).toContain(' 400 ');
        expect(await raw('/\\evil.example/api/health')).toContain(' 400 ');
        expect(await raw('/api/health')).toContain(' 200 ');
    });
    it('keeps the last connections for probes: metrics are refused there, probes still answer', async () => {
        const base = await start();
        const port = Number(new URL(base).port);
        const idle: Socket[] = [];
        // 24 idle connections fill the budget available to everything but probes.
        for (let i = 0; i < 24; i++) {
            idle.push(
                await new Promise<Socket>((resolve) => {
                    const socket = connect(port, '127.0.0.1', () => resolve(socket));
                    socket.on('error', () => {});
                }),
            );
        }
        try {
            const metrics = await fetch(`${base}/metrics`, {
                headers: { authorization: 'Bearer nope' },
            });
            expect(metrics.status).toBe(503);
            expect((await fetch(`${base}/api/health`)).status).toBe(200);
            expect((await fetch(`${base}/api/health/ready`)).status).toBe(200);
        } finally {
            for (const socket of idle) socket.destroy();
        }
    });
    it('drops idle connections that never send a request and keeps answering probes under a flood', async () => {
        const base = await start();
        const port = Number(new URL(base).port);
        const flood: Socket[] = [];
        for (let i = 0; i < 40; i++) {
            const socket = connect(port, '127.0.0.1');
            socket.on('error', () => {});
            flood.push(socket);
        }
        try {
            await new Promise((resolve) => setTimeout(resolve, 900));
            expect(flood.filter((socket) => !socket.destroyed).length).toBe(0);
            expect((await fetch(`${base}/api/health`)).status).toBe(200);
            expect((await fetch(`${base}/api/health/ready`)).status).toBe(200);
        } finally {
            for (const socket of flood) socket.destroy();
        }
    });
    it('caps connections per non-exempt peer', async () => {
        const base = await start({ maxConnectionsPerPeer: 2, exemptLoopbackFromPeerLimit: false });
        const port = Number(new URL(base).port);
        const sockets: Socket[] = [];
        for (let i = 0; i < 3; i++) {
            const socket = connect(port, '127.0.0.1');
            socket.on('error', () => {});
            sockets.push(socket);
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        try {
            expect(sockets.map((socket) => socket.destroyed)).toEqual([false, false, true]);
        } finally {
            for (const socket of sockets) socket.destroy();
        }
    });
});
