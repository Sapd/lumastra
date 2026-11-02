// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { hostname } from 'node:os';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LiveClusterNode } from '$lib/server/services/cluster-heartbeat.service.js';

const mockDetect = vi.fn();
const mockSafeExists = vi.fn();
const mockSafeReaddir = vi.fn();
const mockSafeReadFile = vi.fn();
const mockReadNodes = vi.fn();
const heartbeat = vi.hoisted(() => ({ ttlSeconds: 30 }));

vi.mock('$lib/server/services/cluster-heartbeat.service.js', () => ({
    readClusterNodes: (...args: unknown[]) => mockReadNodes(...args),
    get HEARTBEAT_TTL_SECONDS() {
        return heartbeat.ttlSeconds;
    },
}));

vi.mock('$lib/server/services/transcoding/gpu-detection.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/services/transcoding/gpu-detection.js')>()),
    detectGpuForOnboarding: (...args: unknown[]) => mockDetect(...args),
}));

vi.mock('$lib/server/middleware/auth.js', () => ({
    requireAdmin: (fn: (event: unknown) => unknown) => fn,
}));

vi.mock('$lib/server/middleware/error-handler.js', () => ({
    withErrorHandler: (fn: (event: unknown) => unknown) => fn,
}));

vi.mock('$lib/server/utils/safe-fs.js', () => ({
    safeExists: (...args: unknown[]) => mockSafeExists(...args),
    safeReaddir: (...args: unknown[]) => mockSafeReaddir(...args),
    safeReadFile: (...args: unknown[]) => mockSafeReadFile(...args),
}));

const GPU_RESULT = {
    ffmpegReady: true,
    recommended: 'nvenc',
    recommendedVendor: 'NVIDIA GeForce RTX 4070',
    candidates: [{ accel: 'nvenc', encoder: 'h264_nvenc', vendor: 'NVIDIA', works: true }],
};

function worker(hostname: string, overrides: Partial<LiveClusterNode> = {}): LiveClusterNode {
    return {
        instanceId: hostname,
        hostname,
        role: 'worker',
        version: 'test',
        startedAt: '2026-10-29T00:00:00Z',
        uptimeSeconds: 10,
        keyFingerprint: '',
        heartbeatAgeMs: 0,
        ...overrides,
    };
}

describe('GET /api/setup/gpu-detect', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockDetect.mockResolvedValue(GPU_RESULT);
        mockSafeExists.mockResolvedValue(false);
        mockSafeReaddir.mockResolvedValue([]);
        mockSafeReadFile.mockRejectedValue(new Error('ENOENT'));
        mockReadNodes.mockResolvedValue([]);
        heartbeat.ttlSeconds = 30;
    });

    it('returns the detection result fields', async () => {
        const { GET } = await import('./+server.js');
        const res = await (GET as (event: unknown) => Promise<Response>)({});
        const body = await res.json();

        expect(body.hostname).toBe(hostname());
        expect(body.ffmpegReady).toBe(true);
        expect(body.recommended).toBe('nvenc');
        expect(body.recommendedVendor).toBe('NVIDIA GeForce RTX 4070');
        expect(body.candidates).toHaveLength(1);
        expect(body.hosts).toEqual([
            expect.objectContaining({ hostname: hostname(), local: true, recommended: 'nvenc' }),
        ]);
        expect(body.onlyLocalHost).toBe(true);
    });

    it('surfaces the no-GPU result', async () => {
        mockDetect.mockResolvedValue({
            ffmpegReady: true,
            recommended: null,
            recommendedVendor: null,
            candidates: [],
        });

        const { GET } = await import('./+server.js');
        const res = await (GET as (event: unknown) => Promise<Response>)({});
        const body = await res.json();

        expect(body.recommended).toBeNull();
        expect(body.candidates).toEqual([]);
        expect(body.hosts).toEqual([
            expect.objectContaining({ hostname: hostname(), recommended: null }),
        ]);
    });

    it('recommends the GPU on a worker even before GPU_ACCELERATION is configured', async () => {
        mockDetect.mockResolvedValue({
            ffmpegReady: true,
            recommended: null,
            recommendedVendor: null,
            candidates: [],
        });
        mockReadNodes.mockResolvedValue([
            {
                instanceId: 'web',
                role: 'web',
                hostname: hostname(),
                host: { id: 'web-host', name: 'web-host' },
            },
            {
                instanceId: 'worker',
                role: 'worker',
                heartbeatAgeMs: 0,
                hostname: 'worker',
                host: {
                    id: 'worker-host',
                    name: 'worker-host',
                    gpus: [{ kind: 'nvidia', device: 'nvidia0', name: 'NVIDIA RTX 4070' }],
                },
            },
        ]);

        const { GET } = await import('./+server.js');
        const body = await (await (GET as (event: unknown) => Promise<Response>)({})).json();

        expect(body.recommended).toBe('nvenc');
        expect(body.recommendedHost).toBe('worker-host');
        expect(body.recommendationVerified).toBe(false);
        expect(body.onlyLocalHost).toBe(false);
        expect(body.hosts).toEqual([
            expect.objectContaining({ hostname: 'web-host', recommended: null }),
            expect.objectContaining({
                hostname: 'worker-host',
                recommended: 'nvenc',
                transcodeEligible: true,
            }),
        ]);
    });

    it('shows every known host when no GPU exists anywhere', async () => {
        mockDetect.mockResolvedValue({
            ffmpegReady: true,
            recommended: null,
            recommendedVendor: null,
            candidates: [],
        });
        mockReadNodes.mockResolvedValue([
            { instanceId: 'web', role: 'web', hostname: hostname() },
            { instanceId: 'worker', role: 'worker', hostname: 'cpu-worker' },
        ]);

        const { GET } = await import('./+server.js');
        const body = await (await (GET as (event: unknown) => Promise<Response>)({})).json();

        expect(body.recommended).toBeNull();
        expect(body.hosts).toHaveLength(2);
        expect(
            body.hosts.every((host: { recommended: unknown }) => host.recommended === null),
        ).toBe(true);
        expect(body.onlyLocalHost).toBe(false);
    });

    it('does not recommend GPUs on proxy-only hosts or web-only hosts', async () => {
        mockReadNodes.mockResolvedValue([
            { instanceId: 'web', role: 'web', hostname: hostname() },
            { instanceId: 'worker', role: 'worker', hostname: 'cpu-worker' },
            ...['proxy', 'web'].map((role) => ({
                instanceId: role + '-remote',
                role,
                hostname: role + '-host',
                host: { id: role + '-host', gpus: [{ kind: 'nvidia', device: 'nvidia0' }] },
                gpuAccess: { configured: 'nvenc', accessible: true },
            })),
        ]);
        const { GET } = await import('./+server.js');
        const body = await (await (GET as (event: unknown) => Promise<Response>)({})).json();
        expect(body.recommended).toBeNull();
        expect(body.hosts).toHaveLength(4);
    });

    it('does not recommend a global mode when eligible hosts disagree or return raw probe errors', async () => {
        mockDetect.mockResolvedValue({
            ffmpegReady: true,
            recommended: null,
            recommendedVendor: null,
            candidates: [],
        });
        mockReadNodes.mockResolvedValue([
            {
                instanceId: 'intel',
                role: 'worker',
                heartbeatAgeMs: 0,
                hostname: 'intel-worker',
                gpuAccess: { configured: 'qsv', accessible: true, name: 'Intel' },
            },
            {
                instanceId: 'nvidia',
                role: 'worker',
                heartbeatAgeMs: 0,
                hostname: 'nvidia-worker',
                gpuAccess: { configured: 'nvenc', accessible: true, name: 'NVIDIA' },
            },
            {
                instanceId: 'broken',
                role: 'worker',
                heartbeatAgeMs: 0,
                hostname: 'broken-worker',
                host: { id: 'broken', gpus: [{ kind: 'nvidia', device: 'nvidia0' }] },
                gpuAccess: {
                    configured: 'nvenc',
                    accessible: false,
                    error: 'https://user:secret@host/key',
                },
            },
        ]);
        const { GET } = await import('./+server.js');
        const body = await (await (GET as (event: unknown) => Promise<Response>)({})).json();
        expect(body.recommended).toBeNull();
        expect(body.recommendedHost).toBeNull();
        expect(body.recommendationVerified).toBe(false);
        expect(body.modeConflict).toBe(true);
        expect(
            body.hosts.find((host: { hostname: string }) => host.hostname === 'broken-worker')
                .recommended,
        ).toBeNull();
        expect(JSON.stringify(body)).not.toContain('secret');
    });

    it('keeps local detection usable when cluster discovery fails and can be re-run', async () => {
        mockReadNodes.mockRejectedValueOnce(new Error('unavailable')).mockResolvedValueOnce([]);
        const { GET } = await import('./+server.js');
        for (const attempt of [1, 2]) {
            const body = await (await (GET as (event: unknown) => Promise<Response>)({})).json();
            expect(body.recommended).toBe('nvenc');
            expect(body.onlyLocalHost).toBe(true);
            expect(mockDetect).toHaveBeenCalledTimes(attempt);
        }
    });

    it.each([
        ['i915', 'qsv'],
        ['xe', 'qsv'],
        ['amdgpu', 'vaapi'],
    ])(
        'maps a worker with %s to %s and groups services on the same physical host',
        async (driver, recommended) => {
            mockDetect.mockResolvedValue({
                ffmpegReady: true,
                recommended: null,
                recommendedVendor: null,
                candidates: [],
            });
            mockReadNodes.mockResolvedValue([
                ...['worker', 'proxy'].map((role) => ({
                    instanceId: role,
                    role,
                    heartbeatAgeMs: 0,
                    hostname: role + '-container',
                    host: {
                        id: 'shared-host',
                        name: 'gpu-host',
                        gpus: [{ kind: 'dri', device: 'renderD128', driver }],
                    },
                })),
            ]);
            const { GET } = await import('./+server.js');
            const body = await (await (GET as (event: unknown) => Promise<Response>)({})).json();
            expect(body.recommended).toBe(recommended);
            expect(body.recommendedHost).toBe('gpu-host');
            expect(body.hosts).toHaveLength(2);
            expect(body.hosts[1].gpus).toEqual([driver]);
        },
    );

    it('shows but does not recommend a stale or paused GPU worker', async () => {
        mockDetect.mockResolvedValue({
            ffmpegReady: true,
            recommended: null,
            recommendedVendor: null,
            candidates: [],
        });
        mockReadNodes.mockResolvedValue([
            {
                instanceId: 'stale',
                role: 'worker',
                hostname: 'stale-worker',
                heartbeatAgeMs: 31_000,
                host: { id: 'stale', gpus: [{ kind: 'nvidia', device: 'nvidia0' }] },
            },
            {
                instanceId: 'paused',
                role: 'worker',
                heartbeatAgeMs: 0,
                hostname: 'paused-worker',
                runtime: { consumers: { running: 0, paused: 1 } },
                gpuAccess: { configured: 'nvenc', accessible: true, name: 'NVIDIA' },
            },
        ]);
        const { GET } = await import('./+server.js');
        const body = await (await (GET as (event: unknown) => Promise<Response>)({})).json();
        expect(body.recommended).toBeNull();
        expect(body.hosts).toHaveLength(3);
        expect(
            body.hosts.every((host: { transcodeEligible: boolean }) => !host.transcodeEligible),
        ).toBe(true);
    });

    it('shows an unnamed GPU when the worker only reports a successful encoder probe', async () => {
        mockReadNodes.mockResolvedValue([
            {
                instanceId: 'worker',
                role: 'worker',
                hostname: 'gpu-worker',
                heartbeatAgeMs: 0,
                gpuAccess: { configured: 'nvenc', accessible: true },
            },
        ]);
        const { GET } = await import('./+server.js');
        const body = await (await (GET as (event: unknown) => Promise<Response>)({})).json();
        expect(body.hosts[1].gpus).toEqual(['nvenc']);
        expect(body.hosts[1].verified).toBe(true);
    });

    it('prefers a verified QSV encoder to a merely reported NVENC device on the same host', async () => {
        mockReadNodes.mockResolvedValue([
            worker('gpu-worker', {
                host: { id: 'gpu-host', gpus: [{ kind: 'nvidia', device: 'nvidia0' }] },
                gpuAccess: { configured: 'qsv', accessible: true, name: 'Intel' },
            }),
        ]);
        const { GET } = await import('./+server.js');
        const body = await (await (GET as (event: unknown) => Promise<Response>)({})).json();
        expect(body.recommended).toBe('qsv');
        expect(body.recommendationVerified).toBe(true);
    });

    it('withholds a global recommendation for verified QSV and unverified NVENC on different hosts', async () => {
        mockReadNodes.mockResolvedValue([
            worker('intel-worker', { gpuAccess: { configured: 'qsv', accessible: true } }),
            worker('nvidia-worker', {
                host: { id: 'nvidia-host', gpus: [{ kind: 'nvidia', device: 'nvidia0' }] },
            }),
        ]);
        const { GET } = await import('./+server.js');
        const body = await (await (GET as (event: unknown) => Promise<Response>)({})).json();
        expect(body.recommended).toBeNull();
        expect(body.modeConflict).toBe(true);
        expect(body.hosts).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    hostname: 'intel-worker',
                    recommended: 'qsv',
                    verified: true,
                }),
                expect.objectContaining({
                    hostname: 'nvidia-worker',
                    recommended: 'nvenc',
                    verified: false,
                }),
            ]),
        );
    });

    it('withholds a global GPU mode when another eligible host only supports CPU transcoding', async () => {
        mockReadNodes.mockResolvedValue([
            worker('gpu-worker', { gpuAccess: { configured: 'nvenc', accessible: true } }),
            worker('cpu-worker'),
        ]);
        const { GET } = await import('./+server.js');
        const body = await (await (GET as (event: unknown) => Promise<Response>)({})).json();
        expect(body.recommended).toBeNull();
        expect(body.modeConflict).toBe(true);
    });

    it('does not borrow global verification from one host when another only reports the same mode', async () => {
        mockReadNodes.mockResolvedValue([
            worker('verified-worker', { gpuAccess: { configured: 'nvenc', accessible: true } }),
            worker('unverified-worker', {
                host: { id: 'unverified', gpus: [{ kind: 'nvidia', device: 'nvidia0' }] },
            }),
        ]);
        const { GET } = await import('./+server.js');
        const body = await (await (GET as (event: unknown) => Promise<Response>)({})).json();
        expect(body.recommended).toBe('nvenc');
        expect(body.recommendedHost).toBe('verified-worker');
        expect(body.recommendationVerified).toBe(false);
    });

    it.each(['bochs', 'virtio', 'nouveau', undefined])(
        'does not infer an encoder for DRI driver %s',
        async (driver) => {
            mockReadNodes.mockResolvedValue([
                worker('display-worker', {
                    host: { id: 'display-host', gpus: [{ kind: 'dri', device: 'card0', driver }] },
                }),
            ]);
            const { GET } = await import('./+server.js');
            const body = await (await (GET as (event: unknown) => Promise<Response>)({})).json();
            expect(body.recommended).toBeNull();
            expect(body.hosts[1].gpus).toHaveLength(1);
        },
    );

    it.each(['i915', 'xe', 'amdgpu', 'radeon'])(
        'allows VAAPI inference for supported DRI driver %s',
        async (driver) => {
            mockReadNodes.mockResolvedValue([
                worker('video-worker', {
                    host: {
                        id: 'video-host',
                        gpus: [{ kind: 'dri', device: 'renderD128', driver }],
                    },
                    gpuAccess: { configured: 'qsv', accessible: false },
                }),
            ]);
            const { GET } = await import('./+server.js');
            const body = await (await (GET as (event: unknown) => Promise<Response>)({})).json();
            expect(body.recommended).toBe('vaapi');
        },
    );

    it('does not transfer verification from a web container to a worker sharing its physical host', async () => {
        mockReadNodes.mockResolvedValue([
            worker(hostname(), { role: 'web', host: { id: 'shared', name: 'shared-host' } }),
            worker('worker-container', { host: { id: 'shared', name: 'shared-host' } }),
        ]);
        const { GET } = await import('./+server.js');
        const body = await (await (GET as (event: unknown) => Promise<Response>)({})).json();
        expect(body.recommended).toBe('nvenc');
        expect(body.recommendationVerified).toBe(false);
        expect(body.hosts[0].verified).toBe(false);
    });

    it('keeps the local suggestion unverified when the probing process role is unknown', async () => {
        mockReadNodes.mockResolvedValue([]);
        const { GET } = await import('./+server.js');
        const body = await (await (GET as (event: unknown) => Promise<Response>)({})).json();
        expect(body.recommended).toBe('nvenc');
        expect(body.recommendationVerified).toBe(false);
    });

    it.each([
        { upgradeState: 'preparing' },
        { consumers: { running: 0, paused: 0 } },
        { lease: { held: false } },
    ])(
        'retains a verified local general-node probe during single-host setup: %j',
        async (runtime) => {
            mockReadNodes.mockResolvedValue([worker(hostname(), { role: 'general', runtime })]);
            const { GET } = await import('./+server.js');
            const body = await (await (GET as (event: unknown) => Promise<Response>)({})).json();
            expect(body.recommended).toBe('nvenc');
            expect(body.recommendationVerified).toBe(true);
            expect(body.hosts[0].transcodeEligible).toBe(true);
        },
    );

    it('treats a missing remote heartbeat age as stale even with a successful GPU probe', async () => {
        mockReadNodes.mockResolvedValue([
            worker('unknown-age-worker', {
                heartbeatAgeMs: undefined,
                gpuAccess: { configured: 'nvenc', accessible: true },
            }),
        ]);
        const { GET } = await import('./+server.js');
        const body = await (await (GET as (event: unknown) => Promise<Response>)({})).json();
        expect(body.recommended).toBeNull();
        expect(body.hosts[1].transcodeEligible).toBe(false);
    });

    it.each([
        [30, 29_000],
        [45, 35_000],
    ])('derives freshness from a %s-second heartbeat TTL', async (ttlSeconds, heartbeatAgeMs) => {
        heartbeat.ttlSeconds = ttlSeconds;
        mockReadNodes.mockResolvedValue([
            worker('fresh-worker', {
                heartbeatAgeMs,
                gpuAccess: { configured: 'nvenc', accessible: true },
            }),
        ]);
        const { GET } = await import('./+server.js');
        const body = await (await (GET as (event: unknown) => Promise<Response>)({})).json();
        expect(body.recommended).toBe('nvenc');
        expect(body.recommendationVerified).toBe(true);
    });

    it('rejects a heartbeat at the TTL boundary', async () => {
        mockReadNodes.mockResolvedValue([
            worker('expired-worker', {
                heartbeatAgeMs: heartbeat.ttlSeconds * 1000,
                gpuAccess: { configured: 'nvenc', accessible: true },
            }),
        ]);
        const { GET } = await import('./+server.js');
        const body = await (await (GET as (event: unknown) => Promise<Response>)({})).json();
        expect(body.recommended).toBeNull();
    });

    it('reports inContainer and driPresent when in a container with a render node', async () => {
        mockSafeExists.mockImplementation(
            async (path: string) => path === '/.dockerenv' || path === '/dev/dri',
        );
        mockSafeReaddir.mockResolvedValue([{ name: 'renderD128' }]);

        const { GET } = await import('./+server.js');
        const res = await (GET as (event: unknown) => Promise<Response>)({});
        const body = await res.json();

        expect(body.inContainer).toBe(true);
        expect(body.driPresent).toBe(true);
    });

    it('reports inContainer true and driPresent false when in a container without a render node', async () => {
        mockSafeExists.mockImplementation(async (path: string) => path === '/run/.containerenv');
        mockSafeReaddir.mockResolvedValue([]);

        const { GET } = await import('./+server.js');
        const res = await (GET as (event: unknown) => Promise<Response>)({});
        const body = await res.json();

        expect(body.inContainer).toBe(true);
        expect(body.driPresent).toBe(false);
    });

    it('reports inContainer false on bare metal', async () => {
        mockSafeExists.mockResolvedValue(false);
        mockSafeReaddir.mockResolvedValue([]);
        mockSafeReadFile.mockResolvedValue(Buffer.from('0::/\n'));

        const { GET } = await import('./+server.js');
        const res = await (GET as (event: unknown) => Promise<Response>)({});
        const body = await res.json();

        expect(body.inContainer).toBe(false);
        expect(body.driPresent).toBe(false);
    });
});
