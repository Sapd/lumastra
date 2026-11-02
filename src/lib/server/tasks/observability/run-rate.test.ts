// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';

const registryMock = vi.hoisted(() => ({ getAllTasks: vi.fn() }));
const runsMock = vi.hoisted(() => ({ listRunsGrouped: vi.fn() }));
const backlogMock = vi.hoisted(() => ({
    countSweepBacklog: vi.fn(),
    BACKLOG_COUNT_CEILING: 10001,
}));

vi.mock('../registry.js', () => ({ getRegistry: () => registryMock }));
vi.mock('$lib/server/database/queries/runs-grouped.queries.js', () => runsMock);
vi.mock('$lib/server/database/queries/stage-sweep.queries.js', () => backlogMock);

import { computeTaskRunRates } from './run-rate.js';

const sql = {} as never;

function task(over: Record<string, unknown>): Record<string, unknown> {
    return { id: 'x', name: 'X', ...over };
}

describe('computeTaskRunRates', () => {
    beforeEach(() => {
        registryMock.getAllTasks.mockReset();
        runsMock.listRunsGrouped.mockReset();
        backlogMock.countSweepBacklog.mockReset();
        backlogMock.countSweepBacklog.mockResolvedValue(0);
    });

    it('flags the mdblist shape: 1037 runs against a 12h schedule → alert', async () => {
        registryMock.getAllTasks.mockReturnValue([
            task({
                id: 'mdblist-sync',
                name: 'MDBList Sync',
                schedule: { every: '12h' },
                coversStages: [{ id: 'mdblist-sync', enqueueable: true }],
            }),
        ]);
        runsMock.listRunsGrouped.mockResolvedValue([{ taskId: 'mdblist-sync', count: 1037 }]);
        backlogMock.countSweepBacklog.mockResolvedValue(828);

        const [row] = await computeTaskRunRates(sql);
        expect(row.expectedPerDay).toBe(2); // 24h / 12h
        expect(row.ratio).toBeGreaterThan(500);
        expect(row.severity).toBe('alert');
        expect(row.backlog).toBe(828);
    });

    it('a task firing at its schedule is ok', async () => {
        registryMock.getAllTasks.mockReturnValue([task({ id: 't', schedule: { every: '1h' } })]);
        runsMock.listRunsGrouped.mockResolvedValue([{ taskId: 't', count: 24 }]);

        const [row] = await computeTaskRunRates(sql);
        expect(row.expectedPerDay).toBe(24);
        expect(row.ratio).toBeCloseTo(1);
        expect(row.severity).toBe('ok');
    });

    it('1.5–3× over schedule is a warning', async () => {
        registryMock.getAllTasks.mockReturnValue([task({ id: 't', schedule: { every: '1h' } })]);
        runsMock.listRunsGrouped.mockResolvedValue([{ taskId: 't', count: 48 }]); // 2× of 24
        const [row] = await computeTaskRunRates(sql);
        expect(row.severity).toBe('warn');
    });

    it('a schedule-less task driven by the sweep into 100+ runs is an alert', async () => {
        // metadata-update: no schedule, admin-triggered only, but stage-sweep fired it.
        registryMock.getAllTasks.mockReturnValue([
            task({
                id: 'metadata-update',
                coversStages: [{ id: 'metadata-update', enqueueable: true }],
            }),
        ]);
        runsMock.listRunsGrouped.mockResolvedValue([{ taskId: 'metadata-update', count: 3075 }]);

        const [row] = await computeTaskRunRates(sql);
        expect(row.expectedPerDay).toBeNull();
        expect(row.ratio).toBeNull();
        expect(row.scheduleEvery).toBeNull();
        expect(row.severity).toBe('alert');
    });

    it('flags an unparseable schedule.every (config bug that would blind detection)', async () => {
        registryMock.getAllTasks.mockReturnValue([
            task({ id: 'typo', schedule: { every: '12hh' } }), // malformed
        ]);
        runsMock.listRunsGrouped.mockResolvedValue([{ taskId: 'typo', count: 40 }]);

        const [row] = await computeTaskRunRates(sql);
        expect(row.expectedPerDay).toBeNull();
        expect(row.severity).toBe('alert'); // firing + can't compute cadence
    });

    it('does not double-count backlog when a task lists a stage id twice', async () => {
        registryMock.getAllTasks.mockReturnValue([
            task({
                id: 't',
                schedule: { every: '6h' },
                coversStages: [
                    { id: 'dup', enqueueable: true },
                    { id: 'dup', enqueueable: true }, // accidental duplicate
                ],
            }),
        ]);
        runsMock.listRunsGrouped.mockResolvedValue([{ taskId: 't', count: 4 }]);
        backlogMock.countSweepBacklog.mockResolvedValue(50);

        const [row] = await computeTaskRunRates(sql);
        expect(backlogMock.countSweepBacklog).toHaveBeenCalledTimes(1); // deduped
        expect(row.backlog).toBe(50); // not 100
    });

    it('omits tasks that neither ran nor drive a coverage stage', async () => {
        registryMock.getAllTasks.mockReturnValue([task({ id: 'idle', schedule: { every: '1h' } })]);
        runsMock.listRunsGrouped.mockResolvedValue([]);
        expect(await computeTaskRunRates(sql)).toEqual([]);
    });

    it('marks a ceiling-pinned backlog with backlogAtCeiling', async () => {
        registryMock.getAllTasks.mockReturnValue([
            task({
                id: 't',
                schedule: { every: '6h' },
                coversStages: [{ id: 't', enqueueable: true }],
            }),
        ]);
        runsMock.listRunsGrouped.mockResolvedValue([{ taskId: 't', count: 4 }]);
        backlogMock.countSweepBacklog.mockResolvedValue(10001);

        const [row] = await computeTaskRunRates(sql);
        expect(row.backlogAtCeiling).toBe(true);
    });

    it('is fail-soft: a backlog probe error leaves backlog defined but the page intact', async () => {
        registryMock.getAllTasks.mockReturnValue([
            task({
                id: 't',
                schedule: { every: '6h' },
                coversStages: [{ id: 't', enqueueable: true }],
            }),
        ]);
        runsMock.listRunsGrouped.mockResolvedValue([{ taskId: 't', count: 4 }]);
        backlogMock.countSweepBacklog.mockRejectedValue(new Error('probe down'));

        const [row] = await computeTaskRunRates(sql);
        expect(row.backlog).toBe(0); // started at 0, probe failed, stays 0 — no throw
        expect(row.severity).toBe('ok');
    });
});
