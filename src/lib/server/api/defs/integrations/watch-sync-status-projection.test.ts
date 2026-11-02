// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import type { Run } from '@sapd/lumastra-plugin-sdk';
import { idleSyncStatus, projectRunToStatus } from './watch-sync-status-projection.js';

function makeRun(overrides: Partial<Run> = {}): Run {
    return {
        id: 'run-1',
        taskId: 'watch-sync-manual',
        label: 'Watch Sync Manual Import/Export',
        state: 'active',
        input: {},
        trigger: { kind: 'manual' },
        startedAt: '2026-07-11T00:00:00.000Z',
        stages: [{ id: 'main', label: 'Sync', state: 'active', processed: 3, total: 10 }],
        actor: { type: 'user' },
        ...overrides,
    } as Run;
}

describe('idleSyncStatus', () => {
    it('reports state:null, processed:0, and passes the activity feed through', () => {
        const activity: Parameters<typeof idleSyncStatus>[0] = [
            {
                direction: 'pull',
                outcome: 'success',
                terminal: true,
                occurredAt: '2026-07-10T00:00:00.000Z',
            },
        ];
        expect(idleSyncStatus(activity)).toEqual({
            state: null,
            processed: 0,
            recentActivity: activity,
        });
    });

    it('leaves runId undefined — there is no underlying run to correlate with', () => {
        expect(idleSyncStatus([]).runId).toBeUndefined();
    });

    it('defaults recentActivity to [] when none is given', () => {
        expect(idleSyncStatus([])).toEqual({ state: null, processed: 0, recentActivity: [] });
    });
});

describe('projectRunToStatus', () => {
    it('maps an active run: state, last-stage processed/total, and phase label', () => {
        const run = makeRun();
        const result = projectRunToStatus(run, []);
        expect(result.state).toBe('active');
        expect(result.processed).toBe(3);
        expect(result.total).toBe(10);
        expect(result.phase).toBe('Sync');
        expect(result.startedAt).toBe('2026-07-11T00:00:00.000Z');
        expect(result.recentActivity).toEqual([]);
    });

    it('threads the run id through as runId so the client can correlate a rehydrated status with its tracked run', () => {
        const run = makeRun({ id: 'run-abc-123' });
        const result = projectRunToStatus(run, []);
        expect(result.runId).toBe('run-abc-123');
    });

    it('defaults processed to 0 and leaves total/phase undefined when there are no stages', () => {
        const run = makeRun({
            state: 'completed',
            stages: [],
            completedAt: '2026-07-11T01:00:00.000Z',
        });
        const result = projectRunToStatus(run, []);
        expect(result.state).toBe('completed');
        expect(result.processed).toBe(0);
        expect(result.total).toBeUndefined();
        expect(result.phase).toBeUndefined();
        expect(result.finishedAt).toBe('2026-07-11T01:00:00.000Z');
    });

    it('surfaces the terminal error message for a failed run', () => {
        const run = makeRun({ state: 'failed', error: { message: 'boom' } });
        const result = projectRunToStatus(run, []);
        expect(result.error).toBe('boom');
    });

    it('reads the LAST stage when a run has multiple stages', () => {
        const run = makeRun({
            stages: [
                { id: 'a', label: 'First', state: 'completed', processed: 5, total: 5 },
                { id: 'b', label: 'Second', state: 'active', processed: 1, total: 20 },
            ],
        });
        const result = projectRunToStatus(run, []);
        expect(result.phase).toBe('Second');
        expect(result.processed).toBe(1);
        expect(result.total).toBe(20);
    });

    it('passes the recentActivity feed through untouched', () => {
        const activity: Parameters<typeof projectRunToStatus>[1] = [
            {
                direction: 'push',
                outcome: 'failed',
                terminal: false,
                occurredAt: '2026-07-11T00:00:00.000Z',
                error: 'rate limited',
            },
        ];
        const result = projectRunToStatus(makeRun(), activity);
        expect(result.recentActivity).toEqual(activity);
    });
});
