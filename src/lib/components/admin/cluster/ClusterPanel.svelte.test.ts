// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * `nodes` holds LIVE nodes only. A three-node cluster down to one survivor is a
 * degraded cluster, not "Single node — clustering is not in use"; and a failed
 * status fetch is an error, not an empty panel.
 */

import { tick } from 'svelte';
import { render, screen, cleanup, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('$lib/stores/toast.store', () => ({ toasts }));

const getClusterStatus = vi.hoisted(() => vi.fn());
vi.mock('$lib/api/admin', () => ({ getClusterStatus }));

import ClusterPanel from './ClusterPanel.svelte';

const GiB = 1024 ** 3;
const GENERATED_AT = '2026-10-20T12:00:00.000Z';

function node(instanceId: string) {
    return {
        instanceId,
        role: 'general',
        version: '1.0.0',
        hostname: `${instanceId}.local`,
        startedAt: '2026-10-06T10:00:00.000Z',
        uptimeSeconds: 3600,
        lastSeenAt: '2026-10-20T11:59:55.000Z',
    };
}

afterEach(() => {
    cleanup();
    getClusterStatus.mockReset();
    toasts.error.mockReset();
    vi.useRealTimers();
});

describe('ClusterPanel', () => {
    it('one survivor of three registered nodes is degraded, not single-node', async () => {
        getClusterStatus.mockResolvedValue({
            data: {
                nodes: [node('a')],
                events: [],
                totalOnline: 1,
                totalRegistered: 3,
                selfInstanceId: 'a',
            },
            error: null,
        });
        render(ClusterPanel);

        await waitFor(() =>
            expect(screen.getByText(/2 registered node\(s\) not responding/)).toBeTruthy(),
        );
        expect(screen.queryByText(/Single node/)).toBeNull();
    });

    it('a pinned Live TV proxy is not a version mismatch; proxyCompat decides its notice', async () => {
        const compat = { proxyProtocol: 1, serverProtocol: 1, serverVersion: '1.0.0' };
        getClusterStatus.mockResolvedValue({
            data: {
                nodes: [
                    { ...node('web-1'), role: 'web' },
                    {
                        ...node('proxy-1'),
                        role: 'proxy',
                        implementation: 'node',
                        version: '0.9.0',
                        proxyCompat: { ...compat, state: 'update', reason: 'build_differs' },
                    },
                    {
                        ...node('proxy-2'),
                        role: 'proxy',
                        implementation: 'rust',
                        version: '0.8.0',
                        proxyCompat: {
                            ...compat,
                            proxyProtocol: 0,
                            state: 'incompatible',
                            reason: 'protocol_too_old',
                        },
                    },
                ],
                events: [],
                totalOnline: 3,
                totalRegistered: 3,
                selfInstanceId: 'web-1',
            },
            error: null,
        });
        render(ClusterPanel);

        await waitFor(() => expect(screen.getAllByTestId('cluster-proxy-notice')).toHaveLength(2));
        const [changed, tooOld] = screen.getAllByTestId('cluster-proxy-notice');
        expect(changed.textContent).toContain(
            'The Live TV proxy runs 0.9.0 and has changed since. Update the Live TV proxy image to 1.0.0.',
        );
        expect(changed.className).toContain('amber');
        expect(tooOld.textContent).toContain('Update the Live TV proxy image to 1.0.0.');
        expect(tooOld.className).toContain('red');
        expect(screen.queryByText(/Version mismatch/)).toBeNull();
    });

    it('no proxy notice when the proxy is current', async () => {
        getClusterStatus.mockResolvedValue({
            data: {
                nodes: [
                    { ...node('web-1'), role: 'web' },
                    {
                        ...node('proxy-1'),
                        role: 'proxy',
                        proxyCompat: {
                            state: 'current',
                            proxyProtocol: 1,
                            serverProtocol: 1,
                            serverVersion: '1.0.0',
                        },
                    },
                ],
                events: [],
                totalOnline: 2,
                totalRegistered: 2,
                selfInstanceId: 'web-1',
            },
            error: null,
        });
        render(ClusterPanel);

        await waitFor(() =>
            expect(screen.getAllByTestId('cluster-service').length).toBeGreaterThan(0),
        );
        expect(screen.queryAllByTestId('cluster-proxy-notice')).toHaveLength(0);
    });

    it('a genuine single-node install keeps the calm notice', async () => {
        getClusterStatus.mockResolvedValue({
            data: {
                nodes: [node('a')],
                events: [],
                totalOnline: 1,
                totalRegistered: 1,
                selfInstanceId: 'a',
            },
            error: null,
        });
        render(ClusterPanel);

        await waitFor(() => expect(screen.getByText(/Single node/)).toBeTruthy());
    });

    it('same host: web, worker, Rust proxy and sonic share ONE host card', async () => {
        const host = {
            id: 'boot:0123456789abcdef',
            memTotalBytes: 32 * GiB,
            memAvailableBytes: 24 * GiB,
            cpuCount: 8,
            load1: 0.5,
            load5: 0.4,
            load15: 0.3,
            disks: [
                {
                    role: 'cache',
                    path: '/config/cache',
                    freeBytes: 100 * GiB,
                    totalBytes: 200 * GiB,
                },
            ],
        };
        getClusterStatus.mockResolvedValue({
            data: {
                nodes: [
                    { ...node('web-1'), role: 'web', host, process: { rssBytes: GiB } },
                    {
                        ...node('worker-1'),
                        role: 'worker',
                        host,
                        process: { rssBytes: GiB, childRssBytes: GiB, childRssPeakBytes: 2 * GiB, childCount: 1 },
                    },
                    {
                        ...node('proxy-1'),
                        role: 'proxy',
                        implementation: 'rust',
                        version: '0.4.2',
                        host,
                        process: { rssBytes: GiB },
                    },
                ],
                sidecars: [
                    {
                        kind: 'sonic',
                        state: 'healthy',
                        checkedAt: GENERATED_AT,
                        implementation: 'python',
                        host,
                        process: { rssBytes: 2 * GiB },
                    },
                ],
                expected: { proxy: true },
                generatedAt: GENERATED_AT,
                events: [],
                totalOnline: 3,
                totalRegistered: 3,
                selfInstanceId: 'web-1',
            },
            error: null,
        });
        render(ClusterPanel);
        expect(await screen.findByText('Child memory peak (1 min)')).toBeTruthy();

        await waitFor(() => expect(screen.getAllByTestId('cluster-host')).toHaveLength(1));
        const services = screen.getAllByTestId('cluster-service');
        expect(services.map((s) => s.dataset.kind)).toEqual(['web', 'worker', 'proxy', 'sonic']);
        expect(services.every((s) => s.dataset.state === 'healthy')).toBe(true);
        // Host memory once (32 GiB), Lumastra's own memory summed incl. the watcher child.
        expect(screen.getByTestId('cluster-host-memory').textContent).toContain('8.0 GiB');
        expect(screen.getByTestId('cluster-host-memory').textContent).toContain('32.0 GiB');
        expect(screen.getByTestId('cluster-host-services-rss').textContent).toContain('6.0 GiB');
        expect(screen.getByText('Rust')).toBeTruthy();
        expect(screen.getByText('Python')).toBeTruthy();
        expect(screen.queryByTestId('cluster-unplaced')).toBeNull();
    });

    it('multi host: separate cards per machine, stale and not-configured services are visible', async () => {
        const hostA = {
            id: 'k8s:node-a',
            name: 'node-a',
            memTotalBytes: 16 * GiB,
            memAvailableBytes: 8 * GiB,
        };
        const hostB = {
            id: 'k8s:node-b',
            name: 'node-b',
            memTotalBytes: 64 * GiB,
            memAvailableBytes: 60 * GiB,
        };
        getClusterStatus.mockResolvedValue({
            data: {
                nodes: [
                    {
                        ...node('web-1'),
                        role: 'web',
                        host: hostA,
                        placement: { nodeName: 'node-a' },
                        resources: { memoryUsedBytes: GiB, memoryLimitBytes: 2 * GiB },
                    },
                    {
                        ...node('worker-1'),
                        role: 'worker',
                        host: hostB,
                        lastSeenAt: '2026-10-20T11:59:00.000Z',
                    },
                ],
                sidecars: [{ kind: 'sonic', state: 'notConfigured', checkedAt: GENERATED_AT }],
                expected: { proxy: true },
                generatedAt: GENERATED_AT,
                events: [],
                totalOnline: 2,
                totalRegistered: 2,
                selfInstanceId: 'web-1',
            },
            error: null,
        });
        render(ClusterPanel);

        await waitFor(() => expect(screen.getAllByTestId('cluster-host')).toHaveLength(2));
        expect(
            screen.getAllByTestId('cluster-host-name').map((n) => n.textContent?.trim()),
        ).toEqual(['node-a', 'node-b']);
        const byKind = Object.fromEntries(
            screen.getAllByTestId('cluster-service').map((s) => [s.dataset.kind, s.dataset.state]),
        );
        expect(byKind).toEqual({
            web: 'healthy',
            worker: 'stale',
            proxy: 'stale',
            sonic: 'notConfigured',
        });
        // The container's cgroup limit is shown next to the node figures.
        expect(screen.getByText('Container memory')).toBeTruthy();
        expect(screen.getByText(/Last heartbeat 60 s ago/)).toBeTruthy();
        expect(screen.getByTestId('cluster-unplaced')).toBeTruthy();
    });

    it('a failed first fetch shows the error instead of an empty panel', async () => {
        getClusterStatus.mockResolvedValue({ data: null, error: 'Service unavailable' });
        render(ClusterPanel);

        await waitFor(() =>
            expect(screen.getByRole('alert').textContent).toContain(
                'Failed to load cluster status.',
            ),
        );
    });

    it('a service card shows its 24 h memory peak and the OOM kills, and only when reported', async () => {
        const host = {
            id: 'boot:peaks',
            memTotalBytes: 16 * GiB,
            memAvailableBytes: 8 * GiB,
            cpuCount: 4,
            load5: 0.5,
        };
        getClusterStatus.mockResolvedValue({
            data: {
                nodes: [
                    {
                        ...node('web-1'),
                        role: 'web',
                        host,
                        resources: {
                            memoryUsedBytes: GiB,
                            memoryLimitBytes: 4 * GiB,
                            memoryPeakBytes: 3 * GiB,
                            memoryOomKills: 2,
                        },
                    },
                    {
                        ...node('worker-1'),
                        role: 'worker',
                        host,
                        resources: { memoryUsedBytes: GiB, memoryLimitBytes: 4 * GiB },
                    },
                ],
                events: [],
                totalOnline: 2,
                totalRegistered: 2,
                selfInstanceId: 'web-1',
            },
            error: null,
        });
        render(ClusterPanel);

        await waitFor(() => expect(screen.getAllByTestId('cluster-service')).toHaveLength(2));
        const services = screen.getAllByTestId('cluster-service');
        const web = services.find((s) => s.dataset.kind === 'web');
        const worker = services.find((s) => s.dataset.kind === 'worker');
        expect(web?.textContent).toContain('peak 24 h 3.0 GiB');
        expect(web?.textContent).toContain('Stopped for lack of memory: 2');
        expect(worker?.textContent).not.toContain('peak 24 h');
        expect(worker?.textContent).not.toContain('stopped for lack of memory');
    });
});

describe('ClusterPanel — GPU per host', () => {
    it('shows the media host GPU with engine bars summed over its services and the encoder probe', async () => {
        const media = {
            id: 'boot:media',
            name: 'media',
            cpuCount: 16,
            cpuPercent: 37,
            memTotalBytes: 64 * GiB,
            memAvailableBytes: 40 * GiB,
            gpus: [
                {
                    kind: 'dri',
                    device: 'renderD128',
                    driver: 'i915',
                    name: 'Intel Arc A380',
                    awakePercent: 100,
                    freqMhz: 2400,
                    freqMaxMhz: 2450,
                    powerWatts: 24.6,
                },
            ],
        };
        getClusterStatus.mockResolvedValue({
            data: {
                nodes: [
                    {
                        ...node('web-1'),
                        role: 'web',
                        host: media,
                        process: {
                            rssBytes: GiB,
                            gpu: { clients: 1, engines: { video: 20, render: 2 } },
                        },
                    },
                    {
                        ...node('worker-1'),
                        role: 'worker',
                        host: media,
                        process: {
                            rssBytes: GiB,
                            gpu: { clients: 2, engines: { video: 35, render: 1 } },
                        },
                        gpuAccess: {
                            configured: 'qsv',
                            accessible: true,
                            capabilities: ['QSV Encode'],
                        },
                    },
                ],
                events: [],
                totalOnline: 2,
                totalRegistered: 2,
                selfInstanceId: 'web-1',
                generatedAt: GENERATED_AT,
            },
            error: null,
        });
        render(ClusterPanel);

        const gpu = await screen.findByTestId('cluster-host-gpu');
        expect(gpu.textContent).toContain('Intel Arc A380');
        expect(gpu.textContent).toContain('2400 / 2450 MHz');
        expect(screen.getByTestId('cluster-host-gpu-encodes').textContent).toContain(
            '3 FFmpeg on the GPU',
        );
        const video = screen.getByTestId('cluster-host-gpu-engine-video');
        expect(video.textContent).toContain('55 %');
        expect(video.querySelector('[role="meter"]')?.getAttribute('aria-valuenow')).toBe('55');
        expect(screen.getByTestId('cluster-host-gpu-engine-render').textContent).toContain('3 %');
        expect(screen.getByTestId('cluster-host-gpu-access').textContent).toContain('QSV ready');
        expect(screen.getByTestId('cluster-host-cpu').textContent).toContain('37 % of 16 CPUs');
        // Awake time is shown muted and is never a load bar.
        expect(screen.getByTestId('cluster-host-gpu-awake').textContent).toContain('100 %');
        expect(screen.queryByTestId('cluster-host-gpu-awake-other')).toBeNull();
    });

    it('says something else keeps the GPU awake when no Lumastra FFmpeg runs on it', async () => {
        const media = {
            id: 'boot:media',
            gpus: [{ kind: 'dri', device: 'renderD128', driver: 'i915', awakePercent: 100 }],
        };
        getClusterStatus.mockResolvedValue({
            data: {
                nodes: [{ ...node('web-1'), role: 'web', host: media, process: { rssBytes: GiB } }],
                events: [],
                totalOnline: 1,
                totalRegistered: 1,
                selfInstanceId: 'web-1',
                generatedAt: GENERATED_AT,
            },
            error: null,
        });
        render(ClusterPanel);
        expect((await screen.findByTestId('cluster-host-gpu-awake-other')).textContent).toContain(
            'Awake time is not load',
        );
        expect(screen.getByTestId('cluster-host-gpu-encodes').textContent).toContain(
            '0 FFmpeg on the GPU',
        );
    });

    it('a host without a GPU shows no GPU block', async () => {
        getClusterStatus.mockResolvedValue({
            data: {
                nodes: [
                    {
                        ...node('web-1'),
                        role: 'web',
                        host: { id: 'boot:a', memTotalBytes: 8 * GiB, memAvailableBytes: 4 * GiB },
                        process: { rssBytes: GiB },
                    },
                ],
                events: [],
                totalOnline: 1,
                totalRegistered: 1,
                selfInstanceId: 'web-1',
                generatedAt: GENERATED_AT,
            },
            error: null,
        });
        render(ClusterPanel);
        await screen.findByTestId('cluster-host');
        expect(screen.queryByTestId('cluster-host-gpu')).toBeNull();
    });
});

it('preserves the earlier measurements and shows a stale warning when the next refresh fails', async () => {
    vi.useFakeTimers();
    getClusterStatus
        .mockResolvedValueOnce({
            data: {
                nodes: [
                    {
                        ...node('media'),
                        host: {
                            id: 'name:media',
                            name: 'media',
                            gpus: [{ kind: 'dri', device: 'renderD128', name: 'Intel Arc A380' }],
                        },
                        process: { rssBytes: GiB, gpu: { clients: 1, engines: { video: 55 } } },
                    },
                ],
                events: [],
                totalOnline: 1,
                totalRegistered: 1,
                selfInstanceId: 'media',
                generatedAt: GENERATED_AT,
            },
            error: null,
        })
        .mockResolvedValue({ data: null, error: 'Unavailable' });
    render(ClusterPanel);
    await tick();
    await vi.advanceTimersByTimeAsync(0);
    await tick();
    expect(screen.getByText('Intel Arc A380')).toBeTruthy();
    await vi.advanceTimersByTimeAsync(10_000);
    await tick();
    expect(screen.getByRole('status').textContent).toContain('Failed to load cluster status.');
    expect(screen.getByTestId('cluster-host-gpu-engine-video').textContent).toContain('55 %');
    expect(getClusterStatus).toHaveBeenCalledTimes(2);
});

it('failure followed by recovery leaves a gap in the measured GPU history', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-23T12:00:00Z'));
    const data = {
        nodes: [
            {
                ...node('media'),
                host: { id: 'name:media', gpus: [{ kind: 'dri', device: 'renderD128' }] },
                process: { rssBytes: GiB, gpu: { clients: 1, engines: { video: 55 } } },
            },
        ],
        events: [],
        totalOnline: 1,
        totalRegistered: 1,
        selfInstanceId: 'media',
        generatedAt: GENERATED_AT,
    };
    getClusterStatus
        .mockResolvedValueOnce({ data, error: null })
        .mockResolvedValueOnce({ data: null, error: 'Unavailable' })
        .mockResolvedValue({
            data: {
                ...data,
                nodes: [
                    {
                        ...data.nodes[0],
                        process: { rssBytes: GiB, gpu: { clients: 1, engines: { video: 75 } } },
                    },
                ],
            },
            error: null,
        });
    render(ClusterPanel);
    await tick();
    await vi.advanceTimersByTimeAsync(0);
    await tick();
    await vi.advanceTimersByTimeAsync(10_000);
    await tick();
    expect(screen.getByRole('status').textContent).toContain('Failed to load cluster status.');
    await vi.advanceTimersByTimeAsync(10_000);
    await tick();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByTestId('cluster-host-gpu-engine-video').textContent).toContain('75 %');
    expect(screen.getByTestId('cluster-host-gpu-sparkline').querySelector('polyline')).toBeNull();
    expect(screen.getByTestId('cluster-host-gpu-history-values').textContent).toContain(
        'Not measured',
    );
});
