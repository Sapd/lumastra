// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shutdown ordering of the orchestrator's coordinator-gated loops against real
 * PostgreSQL + Valkey: stop() must hold (and keep renewing) the coordinator
 * lock until the in-flight reconciler sweep has finished, so a successor can
 * never start a sweep that overlaps ours.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import { z } from 'zod';
import { TaskRegistry } from './registry.js';
import { stateMachine } from './state-machine.js';
import { TaskOrchestrator } from './orchestrator.js';
import { Reconciler, type SweepResult } from './reconciler.js';
import { LeaderLock } from './leader-lock.js';
import { PendingWriteDrain } from './pending-write-drain.js';
import { WebhookOutbox } from './webhook-outbox.js';
import { PushOutbox } from './push-outbox.js';
import { requireClient } from './valkey-types.js';
import { connectValkey, disconnectValkey } from '$lib/server/cache/valkey.js';
import { LUMASTRA_ORCHESTRATOR_LEADER_TTL_MS } from '$lib/server/config.js';

// Config snapshots the environment at import; shorten only this file's leases.
vi.hoisted(() => {
    process.env.LUMASTRA_ORCHESTRATOR_LEADER_TTL_MS = '3000';
    process.env.LUMASTRA_ORCHESTRATOR_LEADER_RENEW_MS = '1000';
});

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const CACHE_URL = process.env.CACHE_URL ?? '';
const COORDINATOR_KEY = 'lock:orch:coordinator';

describe.runIf(TEST_DATABASE_URL && CACHE_URL)('TaskOrchestrator shutdown ordering', () => {
    let sql: postgres.Sql;
    let orch: TaskOrchestrator | undefined;
    let peer: LeaderLock | undefined;

    beforeAll(async () => {
        sql = postgres(TEST_DATABASE_URL, { max: 4 });
        await connectValkey();
    }, 30_000);

    afterEach(async () => {
        await orch?.stop().catch(() => {});
        orch = undefined;
        await peer?.release().catch(() => {});
        peer = undefined;
        vi.restoreAllMocks();
    });

    afterAll(async () => {
        await disconnectValkey();
        await sql.end();
    });

    async function startOrchestrator(): Promise<TaskOrchestrator> {
        const coordination = requireClient();
        await coordination.customCommand(['DEL', COORDINATOR_KEY]);
        const registry = new TaskRegistry();
        registry.registerTask(
            defineTask({
                id: 'shutdown-ordering-noop',
                name: 'Shutdown Ordering Noop',
                version: '1.0.0',
                processingVersion: 1,
                minAppVersion: '1.0.0',
                capabilities: {},
                resourceClass: 'io',
                inputSchema: z.object({}),
                identityFor: () => 'global',
                async execute() {
                    return { success: true };
                },
            }),
        );
        return TaskOrchestrator.start(['io'], {
            registry,
            stateMachine,
            getSql: () => sql,
            getClient: () => coordination,
        });
    }

    it('leaves the coordinator lock to expire when a loop tick outlives its stop timeout', async () => {
        let entered!: () => void;
        const sweepStarted = new Promise<void>((resolve) => {
            entered = resolve;
        });
        vi.spyOn(Reconciler.prototype, 'sweepOnce').mockImplementation(() => {
            entered();
            return new Promise<SweepResult>(() => {});
        });
        const realStop = Reconciler.prototype.stop;
        vi.spyOn(Reconciler.prototype, 'stop').mockImplementation(function (this: Reconciler) {
            return realStop.call(this, 200);
        });
        const coordination = requireClient();
        orch = await startOrchestrator();
        await sweepStarted;
        const holder = await coordination.customCommand(['GET', COORDINATOR_KEY]);
        expect(holder).toEqual(expect.any(String));

        await expect(orch.stop({ strict: true })).rejects.toThrow();
        // Not released: a successor would overlap the still-running sweep.
        expect(await coordination.customCommand(['GET', COORDINATOR_KEY])).toBe(holder);
        peer = new LeaderLock(coordination, COORDINATOR_KEY, 'successor-instance', 5_000, 2_000);
        expect(await peer.acquire()).toBe(false);
        // Renewal stopped, so the key expires by its TTL.
        await new Promise((resolve) =>
            setTimeout(resolve, LUMASTRA_ORCHESTRATOR_LEADER_TTL_MS + 500),
        );
        expect(await coordination.customCommand(['GET', COORDINATOR_KEY])).toBeNull();
    }, 40_000);

    it('stops every coordinator-gated loop when the coordinator lock is lost', async () => {
        const reconcilerStop = vi.spyOn(Reconciler.prototype, 'stop');
        const drainStop = vi.spyOn(PendingWriteDrain.prototype, 'stop');
        const webhookStop = vi.spyOn(WebhookOutbox.prototype, 'stopDelivery');
        const pushStop = vi.spyOn(PushOutbox.prototype, 'stopDelivery');
        const drainStart = vi.spyOn(PendingWriteDrain.prototype, 'start');
        const coordination = requireClient();
        orch = await startOrchestrator();
        expect(drainStart).toHaveBeenCalled();
        // A peer takes the key: the next renewal sees it and fires the loss path.
        await coordination.customCommand(['SET', COORDINATOR_KEY, 'someone-else', 'PX', '60000']);
        await vi.waitFor(
            () => {
                expect(reconcilerStop).toHaveBeenCalled();
                expect(drainStop).toHaveBeenCalled();
                expect(webhookStop).toHaveBeenCalled();
                expect(pushStop).toHaveBeenCalled();
            },
            { timeout: 20_000, interval: 100 },
        );
        await coordination.customCommand(['DEL', COORDINATOR_KEY]);
    }, 30_000);

    it('keeps the coordinator lock until the in-flight reconciler sweep finishes', async () => {
        let entered!: () => void;
        const sweepStarted = new Promise<void>((resolve) => {
            entered = resolve;
        });
        let finishSweep!: () => void;
        const sweep = new Promise<SweepResult>((resolve) => {
            finishSweep = () =>
                resolve({
                    orphansReclaimed: 0,
                    childrenSwept: 0,
                    pendingDrained: 0,
                    wedgedStageRowsReclaimed: 0,
                });
        });
        const sweepSpy = vi.spyOn(Reconciler.prototype, 'sweepOnce').mockImplementation(() => {
            entered();
            return sweep;
        });

        const coordination = requireClient();
        await coordination.customCommand(['DEL', COORDINATOR_KEY]);
        const registry = new TaskRegistry();
        registry.registerTask(
            defineTask({
                id: 'shutdown-ordering-noop',
                name: 'Shutdown Ordering Noop',
                version: '1.0.0',
                processingVersion: 1,
                minAppVersion: '1.0.0',
                capabilities: {},
                resourceClass: 'io',
                inputSchema: z.object({}),
                identityFor: () => 'global',
                async execute() {
                    return { success: true };
                },
            }),
        );
        orch = await TaskOrchestrator.start(['io'], {
            registry,
            stateMachine,
            getSql: () => sql,
            getClient: () => coordination,
        });
        // Coordinator acquisition starts the reconciler with an immediate tick.
        await sweepStarted;
        const holder = await coordination.customCommand(['GET', COORDINATOR_KEY]);
        expect(holder).toEqual(expect.any(String));

        let stopped = false;
        const stopping = orch.stop({ strict: true }).then(() => {
            stopped = true;
        });
        try {
            // Longer than the lock TTL: the lock survives only if it is still
            // being renewed while stop() waits for the sweep.
            await new Promise((resolve) =>
                setTimeout(resolve, LUMASTRA_ORCHESTRATOR_LEADER_TTL_MS + 1_000),
            );
            expect(stopped).toBe(false);
            expect(await coordination.customCommand(['GET', COORDINATOR_KEY])).toBe(holder);
            peer = new LeaderLock(coordination, COORDINATOR_KEY, 'successor-instance', 5_000, 2_000);
            expect(await peer.acquire()).toBe(false);
        } finally {
            finishSweep();
        }
        await stopping;
        expect(stopped).toBe(true);
        expect(sweepSpy).toHaveBeenCalledTimes(1);
        expect(await coordination.customCommand(['GET', COORDINATOR_KEY])).toBeNull();
        expect(await peer.acquire()).toBe(true);
        orch = undefined;
    }, 30_000);
});
