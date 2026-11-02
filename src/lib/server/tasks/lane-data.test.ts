// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import type postgres from 'postgres';
import {
    classifyLane,
    summarizeLanes,
    computeStaleEdges,
    getTaskLaneData,
    type TaskLaneInfo,
} from './lane-data.js';

// ── classifyLane ──────────────────────────────────────────────────────────────

const base: Omit<TaskLaneInfo, 'lane'> = {
    activeCount: 0,
    lastStartedAt: null,
    lastCompletedAt: null,
    backlogRemaining: 0,
    recentFailCount: 0,
    circuitState: 'closed',
    itemsPerHour: null,
    lastFailedError: null,
    lastDurationMs: null,
};

describe('classifyLane', () => {
    it('active-only → active', () => {
        expect(classifyLane({ ...base, activeCount: 1 })).toBe('active');
    });

    it('active with failures and backlog → active (active wins)', () => {
        expect(
            classifyLane({
                ...base,
                activeCount: 2,
                recentFailCount: 3,
                backlogRemaining: 100,
            }),
        ).toBe('active');
    });

    it('failed-only (recentFailCount > 0) → failed', () => {
        expect(classifyLane({ ...base, recentFailCount: 1 })).toBe('failed');
    });

    it('failed with backlog → failed (failed beats pending)', () => {
        expect(classifyLane({ ...base, recentFailCount: 1, backlogRemaining: 50 })).toBe('failed');
    });

    it('circuit open with no recent failures → failed', () => {
        expect(classifyLane({ ...base, circuitState: 'open' })).toBe('failed');
    });

    it('circuit half_open → failed', () => {
        expect(classifyLane({ ...base, circuitState: 'half_open' })).toBe('failed');
    });

    it('pending-only (backlog > 0, no fails, circuit closed) → pending', () => {
        expect(classifyLane({ ...base, backlogRemaining: 42 })).toBe('pending');
    });

    it('all zeros, circuit closed → healthy', () => {
        expect(classifyLane(base)).toBe('healthy');
    });
});

// ── summarizeLanes ────────────────────────────────────────────────────────────

function makeInfo(
    lane: TaskLaneInfo['lane'],
    overrides: Partial<Omit<TaskLaneInfo, 'lane'>> = {},
): TaskLaneInfo {
    return { ...base, lane, ...overrides };
}

describe('summarizeLanes', () => {
    it('empty map → zeros', () => {
        const result = summarizeLanes(new Map());
        expect(result).toEqual({
            activeCount: 0,
            pendingItems: 0,
            failedLast24h: 0,
        });
    });

    it('mixed lanes → correct counts', () => {
        const map = new Map<string, TaskLaneInfo>([
            ['a', makeInfo('active', { backlogRemaining: 10, recentFailCount: 1 })],
            ['b', makeInfo('pending', { backlogRemaining: 25 })],
            ['c', makeInfo('failed', { recentFailCount: 3 })],
            ['d', makeInfo('healthy')],
        ]);
        const result = summarizeLanes(map);
        expect(result.activeCount).toBe(1);
        expect(result.failedLast24h).toBe(4); // 1 from active task + 3 from failed task
        // pendingItems is total backlogRemaining across ALL tasks, not just pending-lane tasks
        expect(result.pendingItems).toBe(35);
    });

    it('pendingItems sums backlogRemaining across all lanes, not just pending lane', () => {
        const map = new Map<string, TaskLaneInfo>([
            ['a', makeInfo('active', { backlogRemaining: 100 })],
            ['b', makeInfo('failed', { backlogRemaining: 50 })],
            ['c', makeInfo('pending', { backlogRemaining: 200 })],
            ['d', makeInfo('healthy', { backlogRemaining: 0 })],
        ]);
        expect(summarizeLanes(map).pendingItems).toBe(350);
    });
});

// ── computeStaleEdges ─────────────────────────────────────────────────────────

function makeTaskInfo(lastCompletedAt: string | null): TaskLaneInfo {
    return { ...base, lane: 'healthy', lastCompletedAt };
}

function minsAgo(minutes: number): string {
    return new Date(Date.now() - minutes * 60_000).toISOString();
}

describe('computeStaleEdges', () => {
    const edge = [{ upstream: 'up', downstream: 'down' }];

    it('no schedule on downstream → no alert', () => {
        const laneMap = new Map([
            ['up', makeTaskInfo(minsAgo(5))],
            ['down', makeTaskInfo(minsAgo(30))],
        ]);
        const schedules = new Map([
            ['up', { everyMs: 600_000 }],
            ['down', { everyMs: null }],
        ]);
        expect(computeStaleEdges(edge, laneMap, schedules)).toHaveLength(0);
    });

    it('upstream never ran → no alert', () => {
        const laneMap = new Map([
            ['up', makeTaskInfo(null)],
            ['down', makeTaskInfo(minsAgo(30))],
        ]);
        const schedules = new Map([['down', { everyMs: 900_000 }]]);
        expect(computeStaleEdges(edge, laneMap, schedules)).toHaveLength(0);
    });

    it('downstream never ran, upstream completed recently (within 2x) → no alert', () => {
        // downstream every=15m → threshold=30m; upstream ran 10m ago → staleBy=10m < 30m
        const laneMap = new Map([
            ['up', makeTaskInfo(minsAgo(10))],
            ['down', makeTaskInfo(null)],
        ]);
        const schedules = new Map([['down', { everyMs: 15 * 60_000 }]]);
        expect(computeStaleEdges(edge, laneMap, schedules)).toHaveLength(0);
    });

    it('downstream never ran, upstream completed long ago (> 2x) → alert', () => {
        // downstream every=15m → threshold=30m; upstream ran 60m ago → staleBy=60m > 30m
        const laneMap = new Map([
            ['up', makeTaskInfo(minsAgo(60))],
            ['down', makeTaskInfo(null)],
        ]);
        const schedules = new Map([['down', { everyMs: 15 * 60_000 }]]);
        const alerts = computeStaleEdges(edge, laneMap, schedules);
        expect(alerts).toHaveLength(1);
        expect(alerts[0].downstreamCompletedAt).toBeNull();
    });

    it('downstream ran AFTER upstream → no alert', () => {
        const laneMap = new Map([
            ['up', makeTaskInfo(minsAgo(30))],
            ['down', makeTaskInfo(minsAgo(5))],
        ]);
        const schedules = new Map([['down', { everyMs: 10 * 60_000 }]]);
        expect(computeStaleEdges(edge, laneMap, schedules)).toHaveLength(0);
    });

    it('downstream ran 30m ago, upstream ran 5m ago, downstream every=15m → no alert (5m gap < 30m threshold)', () => {
        const laneMap = new Map([
            ['up', makeTaskInfo(minsAgo(5))],
            ['down', makeTaskInfo(minsAgo(30))],
        ]);
        const schedules = new Map([['down', { everyMs: 15 * 60_000 }]]);
        // gap = upMs - downMs = (now-5m) - (now-30m) = 25m; threshold = 30m → no alert
        expect(computeStaleEdges(edge, laneMap, schedules)).toHaveLength(0);
    });

    it('downstream ran 1h ago, upstream ran 5m ago, downstream every=10m → alert (55m > 20m)', () => {
        const laneMap = new Map([
            ['up', makeTaskInfo(minsAgo(5))],
            ['down', makeTaskInfo(minsAgo(60))],
        ]);
        const schedules = new Map([['down', { everyMs: 10 * 60_000 }]]);
        // gap = (now-5m) - (now-60m) = 55m; threshold = 20m → alert
        const alerts = computeStaleEdges(edge, laneMap, schedules);
        expect(alerts).toHaveLength(1);
        expect(alerts[0].upstreamId).toBe('up');
        expect(alerts[0].downstreamId).toBe('down');
        expect(alerts[0].staleByMs).toBeGreaterThan(50 * 60_000);
    });
});

// ── getTaskLaneData: backlogRemaining live-source precedence ──────────────────

interface SqlRow {
    [key: string]: unknown;
}

// Routes by joined-template-text substring, matching the pattern used in
// secrets.test.ts / reconciler.test.ts. `.array()` is stubbed as identity so
// the `ANY(${idArray})` / `ANY(${sql.array(allCoveredStages)})` call sites
// don't need a real postgres connection.
function makeFakeSql(rowsByQuery: Map<string, SqlRow[]>): postgres.Sql {
    const sqlFn = ((strings: TemplateStringsArray) => {
        const text = Array.from(strings).join(' ');
        for (const [key, rows] of rowsByQuery) {
            if (text.includes(key)) return Promise.resolve(rows);
        }
        return Promise.resolve([]);
    }) as unknown as postgres.Sql;
    (sqlFn as unknown as { array: (v: unknown) => unknown }).array = (v: unknown) => v;
    return sqlFn;
}

describe('getTaskLaneData', () => {
    it('a task with covered stages uses the LIVE media_item_stage_state pending count, not the stale terminal-run snapshot', async () => {
        // Mirrors the mal-anime-id-enrichment bug: the task keeps failing
        // (circuit open, 15 fails), so its last terminal run's self-reported
        // `stages` snapshot reads 0 — but the live pending count (what the
        // catalog card and /api/admin/coverage/backlog show) is 794.
        const rowsByQuery = new Map<string, SqlRow[]>([
            ['active_count', []],
            [
                "INTERVAL '7 days'",
                [
                    {
                        task_id: 'mal-anime-id-enrichment',
                        state: 'failed',
                        completed_at: new Date(),
                        stages: [{ id: 'remaining', count: 0 }],
                    },
                ],
            ],
            ['fail_count', [{ task_id: 'mal-anime-id-enrichment', fail_count: '15' }]],
            ['task_circuit_state', [{ task_id: 'mal-anime-id-enrichment', state: 'open' }]],
            ['AS last_error', [{ task_id: 'mal-anime-id-enrichment', last_error: 'boom' }]],
            ["status = 'completed'", []],
            ['itemsProcessed', []],
            ['failed_transient', [{ stage_id: 'mal-anime-id-enrichment', n: '794' }]],
        ]);
        const sql = makeFakeSql(rowsByQuery);

        const stagesByTask = new Map([['mal-anime-id-enrichment', ['mal-anime-id-enrichment']]]);
        const result = await getTaskLaneData(['mal-anime-id-enrichment'], stagesByTask, sql);

        expect(result).not.toBeNull();
        const info = result?.get('mal-anime-id-enrichment');
        expect(info?.backlogRemaining).toBe(794);
        expect(info?.lane).toBe('failed');
    });

    it('reports execution duration only when an admission timestamp was recorded', async () => {
        const rowsByQuery = new Map<string, SqlRow[]>([
            [
                "INTERVAL '7 days'",
                [
                    {
                        task_id: 'timed-task',
                        state: 'completed',
                        completed_at: new Date(),
                        stages: [],
                        duration_ms: '15000',
                    },
                    {
                        task_id: 'odd-task',
                        state: 'completed',
                        completed_at: new Date(),
                        stages: [],
                        duration_ms: 'not-a-number',
                    },
                ],
            ],
        ]);
        const sql = makeFakeSql(rowsByQuery);
        const result = await getTaskLaneData(
            ['timed-task', 'odd-task', 'never-ran'],
            undefined,
            sql,
        );
        expect(result?.get('timed-task')?.lastDurationMs).toBe(15_000);
        // NaN never reaches the "took …" text.
        expect(result?.get('odd-task')?.lastDurationMs).toBeNull();
        expect(result?.get('never-ran')?.lastDurationMs).toBeNull();
    });

    it('keeps recorded in-flight count separate from observed worker admission', async () => {
        const sql = makeFakeSql(
            new Map<string, SqlRow[]>([
                [
                    'active_count',
                    [
                        {
                            task_id: 'intro',
                            active_count: '3',
                            last_started_at: new Date(),
                            sample_run_ids: ['run_active', 'run_pending', 'run_missing'],
                        },
                    ],
                ],
            ]),
        );
        const client = {
            customCommand: async (cmd: string[]): Promise<unknown> => {
                if (cmd[1]?.endsWith('run_active'))
                    return cmd[2] === 'state' ? 'active' : '2026-10-25T10:00:00.000Z';
                if (cmd[1]?.endsWith('run_pending'))
                    return cmd[2] === 'state' ? 'pending' : undefined;
                return undefined;
            },
        };
        const result = await getTaskLaneData(['intro'], undefined, sql, client);
        expect(result?.get('intro')).toMatchObject({
            lane: 'active',
            activeCount: 3,
            observedActiveCount: 1,
        });
    });

    it('a task without covered stages falls back to the terminal-run snapshot sum', async () => {
        const rowsByQuery = new Map<string, SqlRow[]>([
            ['active_count', []],
            [
                "INTERVAL '7 days'",
                [
                    {
                        task_id: 'no-coverage-task',
                        state: 'completed',
                        completed_at: new Date(),
                        stages: [
                            { id: 'a', count: 12 },
                            { id: 'b', count: 8 },
                        ],
                    },
                ],
            ],
            ['fail_count', []],
            ['task_circuit_state', []],
            ['AS last_error', []],
            ["status = 'completed'", []],
            ['itemsProcessed', []],
            ['failed_transient', []],
        ]);
        const sql = makeFakeSql(rowsByQuery);

        // No stagesByTask entry for this id — legacy fallback path.
        const result = await getTaskLaneData(['no-coverage-task'], undefined, sql);

        expect(result).not.toBeNull();
        const info = result?.get('no-coverage-task');
        expect(info?.backlogRemaining).toBe(20);
        expect(info?.lane).toBe('pending');
    });
});
