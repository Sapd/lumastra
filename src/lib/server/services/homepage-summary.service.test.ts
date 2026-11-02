// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';
import type { Run } from '@sapd/lumastra-plugin-sdk';
import type { LiveClusterNode } from '$lib/server/services/cluster-heartbeat.service.js';
import type { StreamingSummary } from '$lib/schemas/api-streaming-responses.js';
import { HomepageSummarySchema } from '$lib/schemas/api-homepage-responses.js';

const mocks = vi.hoisted(() => ({
    getStreamingSummary: vi.fn(),
    readClusterNodes: vi.fn(),
    getInstancesExpectedOnline: vi.fn(),
    getHomepageLibrarySnapshot: vi.fn(),
    getHomepageTaskCounts: vi.fn(),
    listRuns: vi.fn(),
    getQueueDepths: vi.fn(),
    buildComponentHealth: vi.fn(),
}));

vi.mock('$lib/server/services/streaming-summary.service.js', () => ({
    getStreamingSummary: mocks.getStreamingSummary,
}));
vi.mock('$lib/server/services/cluster-heartbeat.service.js', () => ({
    readClusterNodes: mocks.readClusterNodes,
}));
vi.mock('$lib/server/database/queries/cluster-nodes.queries.js', () => ({
    getInstancesExpectedOnline: mocks.getInstancesExpectedOnline,
}));
vi.mock('$lib/server/database/queries/homepage-tasks.queries.js', () => ({
    getHomepageTaskCounts: mocks.getHomepageTaskCounts,
}));
vi.mock('$lib/server/database/queries/homepage-library.queries.js', () => ({
    getHomepageLibrarySnapshot: mocks.getHomepageLibrarySnapshot,
}));
vi.mock('$lib/server/tasks/orchestrator.js', () => ({
    orchestrator: { listRuns: mocks.listRuns, getQueueDepths: mocks.getQueueDepths },
}));
vi.mock('$lib/server/health/component-health.js', () => ({
    buildComponentHealth: mocks.buildComponentHealth,
}));
vi.mock('$lib/utils/admin/task-names.js', () => ({
    taskDisplayName: (id: string, fallback?: string | null) => fallback || id,
}));
vi.mock('$lib/server/config.js', () => ({ config: { APP_VERSION: '9.9.9' } }));

import {
    buildHomepageSummary,
    formatUptime,
    getHomepageSummary,
    __resetHomepageCachesForTests,
    type HomepageInputs,
} from './homepage-summary.service.js';

const NOW = new Date('2026-10-02T12:00:00.000Z');
const GIB = 1024 ** 3;

function streaming(overrides: Partial<StreamingSummary> = {}): StreamingSummary {
    return {
        streamCount: 2,
        userCount: 2,
        transcodeCount: 1,
        bandwidthMbps: 20.5,
        streams: [
            {
                user: 'u1',
                username: 'alex',
                title: 'Dawn',
                method: 'transcode',
                bitrateMbps: 12.4,
                progress: 0.42,
            },
            {
                user: 'u2',
                username: 'sam',
                title: 'The Beacon · S04E02',
                method: 'direct',
                paused: true,
            },
        ],
        ...overrides,
    };
}

function node(overrides: Partial<LiveClusterNode> = {}): LiveClusterNode {
    return {
        instanceId: 'web-0-abc',
        role: 'web',
        version: '1.0.0',
        hostname: 'lumastra-web-0',
        startedAt: '2026-09-29T12:00:00.000Z',
        uptimeSeconds: 3 * 86_400 + 5,
        keyFingerprint: '',
        ...overrides,
    };
}

function run(overrides: Partial<Run> = {}): Run {
    return {
        id: 'r1',
        taskId: 'library-scan',
        label: 'Library scan',
        state: 'active',
        input: {},
        trigger: { kind: 'manual' },
        startedAt: NOW.toISOString(),
        stages: [{ id: 's1', label: 'Probing files', state: 'active', processed: 63, total: 100 }],
        ...overrides,
    } as Run;
}

function inputs(overrides: Partial<HomepageInputs> = {}): HomepageInputs {
    return {
        streaming: streaming(),
        nodes: [node()],
        nodesExpected: 1,
        runs: [run()],
        taskCounts: { running: 1, failed24h: 0 },
        queues: { waiting: 4, paused: [] },
        components: { database: { status: 'pass' }, valkey: { status: 'pass' } },
        library: {
            counts: {
                movies: 3,
                series: 1,
                episodes: 10,
                artists: 0,
                albums: 0,
                tracks: 0,
                audiobooks: 0,
            },
            recent: [
                { title: 'Dawn', media_type: 'movie', year: 2021, added_at: NOW },
                { title: 'The Beacon', media_type: 'tv', year: 2022, added_at: NOW },
            ],
        },
        version: '1.0.0',
        now: NOW,
        taskName: (id, fallback) => fallback || id,
        ...overrides,
    };
}

describe('formatUptime', () => {
    it('uses the largest whole unit', () => {
        expect(formatUptime(3 * 86_400 + 10)).toBe('3d');
        expect(formatUptime(5 * 3_600 + 59)).toBe('5h');
        expect(formatUptime(12 * 60 + 30)).toBe('12m');
        expect(formatUptime(-4)).toBe('0m');
    });
});

describe('buildHomepageSummary', () => {
    it('builds a schema-valid payload with session, node and task labels', () => {
        const out = buildHomepageSummary(inputs());
        expect(HomepageSummarySchema.parse(out)).toEqual(out);

        expect(out.sessions).toEqual([
            { name: 'alex · Dawn', label: 'transcode · 12.4 Mbps · 42%' },
            { name: 'sam · The Beacon · S04E02', label: 'direct · paused' },
        ]);
        expect(out.nodes).toEqual([{ name: 'lumastra-web-0', label: 'web · up 3d' }]);
        expect(out.tasks).toEqual([{ name: 'Library scan', label: 'Probing files · 63%' }]);
        expect(out.summary).toMatchObject({
            streams: 2,
            transcodes: 1,
            directPlays: 1,
            users: 2,
            bandwidthMbps: 20.5,
            nodesUp: 1,
            nodesExpected: 1,
            tasksRunning: 1,
            tasksQueued: 4,
            tasksFailed24h: 0,
            alerts: 0,
            health: 'ok',
            version: '1.0.0',
        });
        expect(out.recentlyAdded).toEqual([
            { name: 'Dawn (2021)', addedAt: NOW.toISOString() },
            { name: 'The Beacon', addedAt: NOW.toISOString() },
        ]);
        expect(out.generatedAt).toBe(NOW.toISOString());
    });

    it('shows node CPU and memory when the node publishes resources', () => {
        const out = buildHomepageSummary(
            inputs({
                nodes: [
                    node({
                        resources: {
                            cpuUsedCores: 0.37,
                            memoryUsedBytes: 1.2 * GIB,
                            memoryLimitBytes: 4 * GIB,
                        },
                    }),
                    node({
                        instanceId: 'worker-x',
                        hostname: '',
                        role: 'worker',
                        uptimeSeconds: 600,
                        resources: { memoryUsedBytes: 2 * GIB },
                    }),
                ],
            }),
        );
        expect(out.nodes).toEqual([
            { name: 'lumastra-web-0', label: 'web · 0.4 cores · 1.2/4.0 GiB · up 3d' },
            { name: 'worker-x', label: 'worker · 2.0 GiB · up 10m' },
        ]);
    });

    it('labels cancelling runs and runs without an active stage', () => {
        const out = buildHomepageSummary(
            inputs({
                runs: [
                    run({ state: 'cancelling' }),
                    run({ id: 'r2', label: 'Trickplay', stages: [] }),
                    run({
                        id: 'r3',
                        label: 'Analyse',
                        stages: [{ id: 's', label: 'Embedding', state: 'active' }],
                    }),
                ],
            }),
        );
        expect(out.tasks.map((t) => t.label)).toEqual(['cancelling', 'running', 'Embedding']);
    });

    it('is degraded on a warn and down when the database or valkey fails', () => {
        const warn = buildHomepageSummary(
            inputs({
                components: {
                    database: { status: 'pass' },
                    transcoder: { status: 'warn', reason: 'GPU unavailable' },
                },
            }),
        );
        expect(warn.summary.health).toBe('degraded');
        expect(warn.alerts).toEqual([{ name: 'transcoder', label: 'warn: GPU unavailable' }]);

        const down = buildHomepageSummary(
            inputs({ components: { valkey: { status: 'fail', error: 'ECONNREFUSED' } } }),
        );
        expect(down.summary.health).toBe('down');
        expect(down.alerts).toEqual([{ name: 'valkey', label: 'fail: ECONNREFUSED' }]);
    });

    it('turns an unreadable section into an alert and zero values', () => {
        const out = buildHomepageSummary(
            inputs({
                streaming: null,
                nodes: null,
                nodesExpected: null,
                runs: null,
                taskCounts: null,
                queues: null,
                library: null,
            }),
        );
        expect(out.summary).toMatchObject({
            streams: 0,
            transcodes: 0,
            directPlays: 0,
            nodesUp: 0,
            tasksRunning: 0,
            health: 'degraded',
        });
        expect(out.sessions).toEqual([]);
        expect(out.library.movies).toBe(0);
        expect(out.alerts.map((a) => a.name)).toEqual([
            'homepage:sessions',
            'homepage:nodes',
            'homepage:nodesExpected',
            'homepage:tasks',
            'homepage:taskCounts',
            'homepage:queues',
            'homepage:library',
        ]);
        expect(HomepageSummarySchema.safeParse(out).success).toBe(true);
    });

    it('caps every list at 10 and never reports fewer expected nodes than live ones', () => {
        const many = Array.from({ length: 15 }, (_, i) => i);
        const out = buildHomepageSummary(
            inputs({
                streaming: streaming({
                    streamCount: 15,
                    streams: many.map((i) => ({
                        user: `u${i}`,
                        username: `u${i}`,
                        title: 't',
                        method: 'direct' as const,
                    })),
                }),
                nodes: many.map((i) =>
                    node({ instanceId: `n${i}`, hostname: `n${String(i).padStart(2, '0')}` }),
                ),
                nodesExpected: 3,
                runs: many.map((i) => run({ id: `r${i}` })),
                components: Object.fromEntries(
                    many.map((i) => [`c${i}`, { status: 'warn' as const }]),
                ),
                taskCounts: { running: 15, failed24h: 250 },
            }),
        );
        expect(out.sessions).toHaveLength(10);
        expect(out.nodes).toHaveLength(10);
        expect(out.tasks).toHaveLength(10);
        expect(out.alerts).toHaveLength(10);
        expect(out.summary.streams).toBe(15);
        expect(out.summary.nodesUp).toBe(15);
        expect(out.summary.nodesExpected).toBe(15);
        expect(out.summary.tasksRunning).toBe(15);
        expect(out.summary.tasksFailed24h).toBe(250);
        expect(out.summary.alerts).toBe(15);
        expect(out.alerts[0].label).toBe('warn: no detail');
    });

    it('sanitises numbers the wire schema would reject instead of failing the response', () => {
        const out = buildHomepageSummary(
            inputs({
                streaming: streaming({
                    streamCount: 2,
                    transcodeCount: 5,
                    userCount: Number.NaN,
                    bandwidthMbps: Number.POSITIVE_INFINITY,
                    streams: [
                        { user: 'u', username: 'u', title: 't', method: 'direct', progress: 2.5 },
                        {
                            user: 'v',
                            username: 'v',
                            title: 't',
                            method: 'direct',
                            progress: Number.NaN,
                        },
                    ],
                }),
                nodes: [
                    node({
                        hostname: '  ',
                        resources: { memoryUsedBytes: Number.NaN, memoryLimitBytes: 0 },
                    }),
                ],
                runs: [
                    run({
                        stages: [
                            { id: 's', label: 'Probe', state: 'active', processed: -5, total: 10 },
                        ],
                    }),
                ],
                taskCounts: { running: -1, failed24h: 1.7 },
                library: {
                    counts: { ...inputs().library!.counts, movies: Number.NaN },
                    recent: [
                        { title: 'Bad', media_type: 'movie', year: null, added_at: new Date('x') },
                    ],
                },
                version: '',
            }),
        );
        expect(HomepageSummarySchema.safeParse(out).success).toBe(true);
        expect(out.summary).toMatchObject({
            streams: 2,
            transcodes: 2,
            directPlays: 0,
            users: 0,
            bandwidthMbps: 0,
            tasksRunning: 0,
            tasksFailed24h: 1,
            version: 'unknown',
        });
        expect(out.sessions.map((x) => x.label)).toEqual(['direct · 100%', 'direct']);
        expect(out.nodes).toEqual([{ name: 'web-0-abc', label: 'web · up 3d' }]);
        expect(out.tasks[0].label).toBe('Probe · 0%');
        expect(out.library.movies).toBe(0);
        expect(out.recentlyAdded).toEqual([]);
    });

    it('alerts on missing cluster nodes and paused queues, and truncates long details', () => {
        const out = buildHomepageSummary(
            inputs({
                nodesExpected: 3,
                queues: { waiting: 0, paused: ['io'] },
                components: { jellyfin: { status: 'warn', reason: 'x'.repeat(200) } },
            }),
        );
        expect(out.summary.health).toBe('degraded');
        expect(out.alerts.map((a) => a.name)).toEqual(['jellyfin', 'cluster', 'queue:io']);
        expect(out.alerts[0].label).toHaveLength(80);
        expect(out.alerts[1].label).toBe('warn: 1 of 3 nodes up');
        expect(out.alerts[2].label).toBe('warn: paused');
    });

    it('ignores component states other than warn and fail', () => {
        const out = buildHomepageSummary(
            inputs({
                components: {
                    database: { status: 'pass' },
                    gpu: { status: 'skipped' as unknown as 'pass' },
                },
            }),
        );
        expect(out.alerts).toEqual([]);
        expect(out.summary.health).toBe('ok');
    });
});

describe('getHomepageSummary', () => {
    const sql = {} as postgres.Sql;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.useRealTimers();
        __resetHomepageCachesForTests();
        mocks.getStreamingSummary.mockResolvedValue(streaming());
        mocks.readClusterNodes.mockResolvedValue([node()]);
        mocks.getInstancesExpectedOnline.mockResolvedValue(['web-0-abc']);
        mocks.getHomepageLibrarySnapshot.mockResolvedValue(inputs().library);
        mocks.listRuns.mockResolvedValue({ runs: [run()] });
        mocks.getHomepageTaskCounts.mockResolvedValue({ running: 7, failed24h: 3 });
        mocks.getQueueDepths.mockResolvedValue({
            io: { waiting: 3, active: 1, delayed: 0, paused: true },
            cpu: { waiting: 2, active: 0, delayed: 0, paused: false },
        });
        mocks.buildComponentHealth.mockResolvedValue({
            timestamp: NOW.toISOString(),
            database: { status: 'pass' },
            valkey: { status: 'pass' },
        });
    });

    it('assembles every section from its source', async () => {
        const out = await getHomepageSummary(sql);
        expect(HomepageSummarySchema.parse(out)).toEqual(out);
        expect(out.summary).toMatchObject({
            tasksRunning: 7,
            tasksQueued: 5,
            tasksFailed24h: 3,
            nodesExpected: 1,
            health: 'degraded',
            version: '9.9.9',
        });
        expect(out.alerts).toEqual([{ name: 'queue:io', label: 'warn: paused' }]);
        expect(mocks.getStreamingSummary).toHaveBeenCalledWith(sql, 10);
        expect(mocks.getHomepageTaskCounts).toHaveBeenCalledWith(sql);
        expect(mocks.listRuns).toHaveBeenCalledWith({ state: ['active', 'cancelling'], limit: 10 });
    });

    it('shares one build between concurrent callers and caches it for 5 s', async () => {
        vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
        await Promise.all([getHomepageSummary(sql), getHomepageSummary(sql)]);
        expect(mocks.getStreamingSummary).toHaveBeenCalledTimes(1);

        vi.setSystemTime(NOW.getTime() + 4_000);
        await getHomepageSummary(sql);
        expect(mocks.getStreamingSummary).toHaveBeenCalledTimes(1);

        vi.setSystemTime(NOW.getTime() + 6_000);
        await getHomepageSummary(sql);
        expect(mocks.getStreamingSummary).toHaveBeenCalledTimes(2);
        // The library snapshot has its own 5-minute cache.
        expect(mocks.getHomepageLibrarySnapshot).toHaveBeenCalledTimes(1);

        vi.setSystemTime(NOW.getTime() + 6 * 60_000);
        await getHomepageSummary(sql);
        expect(mocks.getHomepageLibrarySnapshot).toHaveBeenCalledTimes(2);
    });

    it('degrades a failing section to an alert instead of failing', async () => {
        mocks.readClusterNodes.mockRejectedValue(new Error('valkey down'));
        const out = await getHomepageSummary(sql);
        expect(out.nodes).toEqual([]);
        expect(out.alerts).toContainEqual({ name: 'homepage:nodes', label: 'fail: unavailable' });
        expect(out.summary.health).toBe('degraded');
    });

    it('reports a hung section as unavailable instead of stalling the response', async () => {
        vi.useFakeTimers({ now: NOW });
        mocks.readClusterNodes.mockReturnValue(new Promise(() => {}));
        const pending = getHomepageSummary(sql);
        await vi.advanceTimersByTimeAsync(3_000);
        const out = await pending;
        expect(out.alerts).toContainEqual({ name: 'homepage:nodes', label: 'fail: unavailable' });
        expect(out.summary.streams).toBe(2);
    });
});
