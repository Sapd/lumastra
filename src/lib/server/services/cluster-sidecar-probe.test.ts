// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/config.js', () => ({ config: { SONIC_EMBEDDER_URL: '' } }));

import { probeSonicSidecar, sidecarFromHealthBody } from './cluster-sidecar-probe.js';

const NOW = Date.parse('2026-10-20T12:00:00.000Z');

const node = {
    implementation: 'python',
    startedAt: '2026-10-20T11:00:00Z',
    hostname: 'sonic-ctr',
    host: { id: 'boot:abc', memTotalBytes: 100, memAvailableBytes: 40, cpuCount: 8 },
    process: { rssBytes: 50, cpuPercent: 3.5 },
};

describe('sidecarFromHealthBody', () => {
    it('a ready sidecar is healthy and carries its host block', () => {
        const s = sidecarFromHealthBody(
            200,
            { status: 'ready', memory: { limit_mb: 2048, rss_mb: 900 }, node },
            NOW,
        );
        expect(s).toMatchObject({
            kind: 'sonic',
            state: 'healthy',
            status: 'ready',
            implementation: 'python',
            hostname: 'sonic-ctr',
            uptimeSeconds: 3600,
            host: { id: 'boot:abc' },
            process: { rssBytes: 50 },
            memoryLimitBytes: 2048 * 1024 * 1024,
        });
    });

    it("a loading sidecar (FastAPI's 503 {detail}) is degraded and still placed on its host", () => {
        const s = sidecarFromHealthBody(503, { detail: { status: 'loading', node } }, NOW);
        expect(s).toMatchObject({ state: 'degraded', status: 'loading', host: { id: 'boot:abc' } });
    });

    it('an older sidecar without a node block is healthy but unplaced', () => {
        const s = sidecarFromHealthBody(200, { status: 'ready' }, NOW);
        expect(s.state).toBe('healthy');
        expect(s.host).toBeUndefined();
        expect(s.implementation).toBe('python');
    });

    it('a non-JSON 500 is degraded', () => {
        expect(sidecarFromHealthBody(500, undefined, NOW)).toMatchObject({
            state: 'degraded',
            httpStatus: 500,
        });
    });
});

describe('probeSonicSidecar', () => {
    it('a body that stalls after the headers ends as down within the deadline', async () => {
        // Like undici: the request's abort signal errors the body stream.
        const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
            let ctrl!: ReadableStreamDefaultController<Uint8Array>;
            const stalled = new ReadableStream<Uint8Array>({ start: (c) => void (ctrl = c) });
            init.signal?.addEventListener('abort', () => ctrl.error(new Error('aborted')));
            return new Response(stalled, { status: 200 });
        });
        const started = Date.now();
        const s = await probeSonicSidecar('http://sonic:8000', fetchImpl as never);
        expect(Date.now() - started).toBeLessThan(5000);
        expect(s.state).toBe('down');
    });

    it('reads at most 64 KiB of a huge body', async () => {
        const huge = 'x'.repeat(5 * 1024 * 1024);
        const fetchImpl = vi.fn().mockResolvedValue(new Response(huge, { status: 200 }));
        const s = await probeSonicSidecar('http://sonic:8000', fetchImpl);
        expect(s).toMatchObject({ state: 'degraded', httpStatus: 200 });
    });

    it('not configured without a URL, and never fetches', async () => {
        const fetchImpl = vi.fn();
        expect((await probeSonicSidecar('', fetchImpl)).state).toBe('notConfigured');
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('down when the fetch throws (timeout, refused)', async () => {
        const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
        const s = await probeSonicSidecar('http://sonic:8000/', fetchImpl);
        expect(s.state).toBe('down');
        expect(fetchImpl).toHaveBeenCalledWith(
            'http://sonic:8000/health',
            { method: 'GET', signal: expect.any(AbortSignal) },
            2000,
        );
        expect(JSON.stringify(s)).not.toContain('sonic:8000');
    });

    it('parses the live response', async () => {
        const fetchImpl = vi
            .fn()
            .mockResolvedValue(
                new Response(JSON.stringify({ status: 'ready', node }), { status: 200 }),
            );
        expect((await probeSonicSidecar('http://sonic:8000', fetchImpl)).host?.id).toBe('boot:abc');
    });
});
