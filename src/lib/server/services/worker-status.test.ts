// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A cluster read that throws is `probe-failed`, not `none`: the stuck guide
 * names a missing worker as the cause only when absence was measured.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
    inProcess: false,
    nodes: [] as Array<{ role: string; runtime?: Record<string, unknown> }>,
    fails: false,
}));

vi.mock('$lib/server/config.js', () => ({ shouldStartWorkers: () => state.inProcess }));
vi.mock('$lib/server/services/cluster-heartbeat.service.js', () => ({
    readClusterNodes: async () => {
        if (state.fails) throw new Error('valkey down');
        return state.nodes;
    },
}));

import { getBackgroundWorkerStatus } from './worker-status.js';

beforeEach(() => {
    state.inProcess = false;
    state.nodes = [];
    state.fails = false;
});

describe('getBackgroundWorkerStatus', () => {
    it('in-process when this server runs the worker', async () => {
        state.inProcess = true;
        expect(await getBackgroundWorkerStatus()).toMatchObject({
            available: true,
            source: 'in-process',
        });
    });

    it('cluster when a worker node heartbeats', async () => {
        state.nodes = [{ role: 'web' }, { role: 'worker' }];
        expect(await getBackgroundWorkerStatus()).toMatchObject({
            available: true,
            source: 'cluster',
        });
    });

    it('cluster-unavailable, with the reason, when every worker is prepared for an upgrade', async () => {
        state.nodes = [{ role: 'worker', runtime: { upgradeState: 'prepared' } }];
        const status = await getBackgroundWorkerStatus();
        expect(status).toMatchObject({
            available: false,
            source: 'cluster-unavailable',
            reasons: ['upgrade_prepared'],
        });
        expect(status.detail).toContain('upgrade is prepared');
    });

    it('available when one worker is healthy and another has its consumers stopped', async () => {
        state.nodes = [
            { role: 'worker', runtime: { consumers: { running: 0, paused: 0 } } },
            {
                role: 'worker',
                runtime: { consumers: { running: 4, paused: 0 }, lease: { held: true } },
            },
        ];
        expect(await getBackgroundWorkerStatus()).toMatchObject({
            available: true,
            source: 'cluster',
        });
    });

    it('none when the cluster answered without a worker', async () => {
        state.nodes = [{ role: 'web' }];
        expect(await getBackgroundWorkerStatus()).toMatchObject({
            available: false,
            source: 'none',
        });
    });

    it('probe-failed when the cluster read throws', async () => {
        state.fails = true;
        expect(await getBackgroundWorkerStatus()).toMatchObject({
            available: false,
            source: 'probe-failed',
        });
    });
});
