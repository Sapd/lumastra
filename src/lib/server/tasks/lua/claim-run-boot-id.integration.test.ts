// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the bootId fence in claim-run.lua (version 3).
 *
 * The bootId fence (added in v3) covers a specific HA failure mode: an instance
 * that restarts (or whose INSTANCE_ID is recycled) gets a new bootId. The stale
 * process's run must NOT be claimed by the restarted process using the same
 * instanceId with a different bootId — it should be treated as a foreign claim
 * so that the watchdog / boot-recovery can rescue the run after the stale
 * heartbeat lapses.
 *
 * Cases verified against the real Lua script via StateMachine.claimRun:
 *
 * 1. Same (instanceId, bootId) re-claim on an already-claimed run → ok:true
 *    (idempotent: the runner retrying its own run is always safe).
 *
 * 2. Same instanceId but different bootId → ok:false, error contains
 *    'different boot' (or 'already claimed') — fail closed.
 *
 * 3. Fresh unclaimed run → ok:true (baseline sanity check).
 *
 * Requires a live Valkey instance at CACHE_URL or redis://localhost:6379.
 * Skipped automatically when CACHE_URL is absent (same posture as the rest of
 * the integration suite).
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
        clientName: 'claim-run-boot-id-tests',
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

const PREFIX = `test:bootid:${Date.now()}:`;

function runKey(id: string): string {
    return `task:run:active:${PREFIX}${id}`;
}

async function seedRun(id: string, extra?: Record<string, string>): Promise<void> {
    const key = runKey(id);
    await glideClient.hset(key, { state: 'active', taskId: 'test-task', ...extra });
    await glideClient.pexpire(key, 900_000);
}

async function del(...keys: string[]): Promise<void> {
    if (keys.length) await glideClient.del(keys);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe.runIf(RUN)('claim-run.lua bootId fence (plan §HA-boot-fence)', () => {
    it('claims an unclaimed run — baseline sanity check', async () => {
        const runId = 'run-fresh';
        await seedRun(runId);

        const result = await sm.claimRun({
            runId: `${PREFIX}${runId}`,
            expectedState: 'active',
            instanceId: 'instance-A',
            bootId: 'boot-1',
        });

        expect(result.ok).toBe(true);
        await del(runKey(runId));
    }, 10_000);

    it('same (instanceId, bootId) re-claim succeeds — idempotent', async () => {
        const runId = 'run-reclaim';
        // Seed with an existing owner so the hash is already claimed.
        await seedRun(runId, {
            ownerInstanceId: 'instance-X',
            ownerBootId: 'boot-X',
        });

        const result = await sm.claimRun({
            runId: `${PREFIX}${runId}`,
            expectedState: 'active',
            instanceId: 'instance-X',
            bootId: 'boot-X',
        });

        expect(result.ok).toBe(true);
        await del(runKey(runId));
    }, 10_000);

    it('same instanceId but different bootId is rejected (different boot fence)', async () => {
        const runId = 'run-different-boot';
        // Seed as already claimed by instance-Y on boot-OLD.
        await seedRun(runId, {
            ownerInstanceId: 'instance-Y',
            ownerBootId: 'boot-OLD',
        });

        // A new process using the same instanceId but a new bootId must be denied.
        const result = await sm.claimRun({
            runId: `${PREFIX}${runId}`,
            expectedState: 'active',
            instanceId: 'instance-Y',
            bootId: 'boot-NEW',
        });

        expect(result.ok).toBe(false);
        // The error must reference the instance and indicate the boot mismatch.
        // claim-run.lua returns 'already claimed by <owner> (different boot)'.
        expect(result.error).toBeDefined();
        expect(result.error).toMatch(/already claimed by instance-Y/i);
        expect(result.error).toMatch(/different boot/i);
        await del(runKey(runId));
    }, 10_000);

    it('different instanceId is also rejected (existing cross-instance test)', async () => {
        const runId = 'run-diff-instance';
        await seedRun(runId, {
            ownerInstanceId: 'instance-A',
            ownerBootId: 'boot-A',
        });

        const result = await sm.claimRun({
            runId: `${PREFIX}${runId}`,
            expectedState: 'active',
            instanceId: 'instance-B',
            bootId: 'boot-B',
        });

        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/already claimed by instance-A/i);
        await del(runKey(runId));
    }, 10_000);

    it('bootId stored in hash matches the claimedAt timestamp after a fresh claim', async () => {
        const runId = 'run-bootid-written';
        await seedRun(runId);

        const nowMs = Date.now();
        const result = await sm.claimRun({
            runId: `${PREFIX}${runId}`,
            expectedState: 'active',
            instanceId: 'instance-Z',
            bootId: 'boot-Z',
            nowMs,
        });

        expect(result.ok).toBe(true);

        // Verify the Lua script wrote ownerBootId into the hash.
        const key = runKey(runId);
        const storedBootId = await glideClient.hget(key, 'ownerBootId');
        const storedBootStr =
            storedBootId === null || storedBootId === undefined
                ? null
                : typeof storedBootId === 'string'
                  ? storedBootId
                  : String(storedBootId);
        expect(storedBootStr).toBe('boot-Z');

        // And the ownerInstanceId.
        const storedOwner = await glideClient.hget(key, 'ownerInstanceId');
        const storedOwnerStr =
            storedOwner === null || storedOwner === undefined
                ? null
                : typeof storedOwner === 'string'
                  ? storedOwner
                  : String(storedOwner);
        expect(storedOwnerStr).toBe('instance-Z');

        await del(key);
    }, 10_000);
});

// ── Skip notice when Valkey is absent ────────────────────────────────────────

describe.skipIf(RUN)('claim-run.lua bootId fence — SKIPPED (no CACHE_URL)', () => {
    it.todo(
        'Set CACHE_URL=redis://localhost:6379 (or point to the lumastra-test-valkey container) to run these tests',
    );
});
