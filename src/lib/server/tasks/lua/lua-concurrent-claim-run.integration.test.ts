// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Atomicity property tests for claim-run.lua under concurrent contention.
 * Plan §16.2: concurrent claim — two replicas race claimRun.
 *
 * Properties verified:
 *   - Two concurrent claimRun calls with different instanceId/bootId on the same
 *     unclaimed run: exactly one returns ok:true, the other returns ok:false (already claimed).
 *   - Repeated ~50 times to catch flakes.
 *
 * Requires a live Valkey instance (CACHE_URL env or redis://localhost:6379).
 * Skipped automatically when CACHE_URL is absent.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GlideClient } from '@valkey/valkey-glide';
import { luaLoader } from './loader.js';
import { StateMachine } from '../state-machine.js';

// ── Valkey connection ─────────────────────────────────────────────────────────

function parseUrl(
    url: string,
): { host: string; port: number; password?: string; username?: string } | null {
    try {
        const u = new URL(url);
        return {
            host: u.hostname,
            port: parseInt(u.port || '6379', 10),
            username: u.username || undefined,
            password: u.password || undefined,
        };
    } catch {
        return null;
    }
}

const CACHE_URL = process.env.CACHE_URL ?? '';
const RUN = Boolean(CACHE_URL);

let glideClient: GlideClient;
let sm: StateMachine;

type ValkeyLike = { customCommand: (cmd: string[]) => Promise<unknown> };

beforeAll(async () => {
    if (!RUN) return;
    const url = CACHE_URL || 'redis://localhost:6379';
    const cfg = parseUrl(url);
    if (!cfg) throw new Error(`Cannot parse CACHE_URL: ${url}`);

    const glideConfig: Parameters<typeof GlideClient.createClient>[0] = {
        addresses: [{ host: cfg.host, port: cfg.port }],
        requestTimeout: 10_000,
        clientName: 'lua-concurrent-claim-tests',
    };
    if (cfg.password) {
        glideConfig.credentials = {
            username: cfg.username ?? 'default',
            password: cfg.password,
        };
    }
    glideClient = await GlideClient.createClient(glideConfig);
    await luaLoader.load();

    const clientRef = glideClient as unknown as ValkeyLike;
    sm = new StateMachine(() => clientRef);
}, 30_000);

afterAll(async () => {
    if (glideClient) glideClient.close();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const PREFIX = `test:concurrent:claim:${Date.now()}:`;

function runKey(id: string): string {
    return `task:run:active:${PREFIX}${id}`;
}

async function seedRun(id: string): Promise<void> {
    const key = runKey(id);
    await glideClient.hset(key, { state: 'active', taskId: 'test-task' });
    // TTL of 15 minutes.
    await glideClient.pexpire(key, 900_000);
}

async function del(...keys: string[]): Promise<void> {
    if (keys.length) await glideClient.del(keys);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe.runIf(RUN)('lua claim-run atomicity under concurrent contention (plan §16.2)', () => {
    it('exactly one replica wins the claim race across 50 iterations', async () => {
        const ITERATIONS = 50;

        for (let iter = 0; iter < ITERATIONS; iter++) {
            const runId = `run-race-${iter}`;
            const key = runKey(runId);

            await seedRun(runId);

            // Two replicas fire simultaneously.
            const [r1, r2] = await Promise.all([
                sm.claimRun({
                    runId: `${PREFIX}${runId}`,
                    expectedState: 'active',
                    instanceId: 'instance-A',
                    bootId: 'boot-A',
                }),
                sm.claimRun({
                    runId: `${PREFIX}${runId}`,
                    expectedState: 'active',
                    instanceId: 'instance-B',
                    bootId: 'boot-B',
                }),
            ]);

            const okCount = [r1, r2].filter((r) => r.ok).length;
            const failCount = [r1, r2].filter((r) => !r.ok).length;

            // Exactly one wins.
            expect(okCount).toBe(1);
            expect(failCount).toBe(1);

            // The loser carries an error string.
            const loser = [r1, r2].find((r) => !r.ok);
            expect(loser?.error).toBeDefined();

            await del(key);
        }
    }, 60_000);

    it('same instance can re-claim its own run', async () => {
        const runId = 'run-reclaim';
        await seedRun(runId);

        const first = await sm.claimRun({
            runId: `${PREFIX}${runId}`,
            expectedState: 'active',
            instanceId: 'instance-X',
            bootId: 'boot-X',
        });
        expect(first.ok).toBe(true);

        // Re-claim by same instance — must succeed.
        const second = await sm.claimRun({
            runId: `${PREFIX}${runId}`,
            expectedState: 'active',
            instanceId: 'instance-X',
            bootId: 'boot-X',
        });
        expect(second.ok).toBe(true);

        await del(runKey(runId));
    }, 10_000);

    it('claim on non-existent run returns ok:false with descriptive error', async () => {
        const result = await sm.claimRun({
            runId: `${PREFIX}run-nonexistent-${Date.now()}`,
            expectedState: 'active',
            instanceId: 'i1',
            bootId: 'b1',
        });
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/run not found/i);
    }, 10_000);

    it('claim with wrong expected state returns ok:false', async () => {
        const runId = 'run-wrong-state';
        await seedRun(runId);

        const result = await sm.claimRun({
            runId: `${PREFIX}${runId}`,
            expectedState: 'pending', // actual state is 'active'
            instanceId: 'i1',
            bootId: 'b1',
        });
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/state mismatch/i);

        await del(runKey(runId));
    }, 10_000);
});
