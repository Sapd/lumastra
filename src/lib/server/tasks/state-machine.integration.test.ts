// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for StateMachine — requires a live Valkey instance.
 *
 * Run with: npm run test:integration src/lib/server/tasks/state-machine.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { GlideClient } from '@valkey/valkey-glide';
import { luaLoader } from './lua/loader.js';
import { StateMachine } from './state-machine.js';

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

let glideClient: GlideClient;
let sm: StateMachine;

type ValkeyLike = { customCommand: (cmd: string[]) => Promise<unknown> };

beforeAll(async () => {
    const url = process.env.CACHE_URL || 'redis://localhost:6379';
    const cfg = parseUrl(url);
    if (!cfg) throw new Error(`Cannot parse CACHE_URL: ${url}`);

    const glideConfig: Parameters<typeof GlideClient.createClient>[0] = {
        addresses: [{ host: cfg.host, port: cfg.port }],
        requestTimeout: 10_000,
        clientName: 'state-machine-integration-tests',
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

// ── Test key helpers ──────────────────────────────────────────────────────────

const PREFIX = `test:sm:${Date.now()}:`;

function runId(suffix: string): string {
    return `${PREFIX}${suffix}`;
}

function activeKey(id: string): string {
    return `task:run:active:${id}`;
}

async function seed(id: string, fields: Record<string, string>): Promise<void> {
    for (const [f, v] of Object.entries(fields)) {
        await glideClient.hset(activeKey(id), { [f]: v });
    }
}

async function del(...keys: string[]): Promise<void> {
    if (keys.length) await glideClient.del(keys);
}

async function hget(key: string, field: string): Promise<string | null> {
    const result = await glideClient.hget(key, field);
    if (result === null || result === undefined) return null;
    return typeof result === 'string' ? result : String(result);
}

// ── transitionRun tests ───────────────────────────────────────────────────────

describe('StateMachine.transitionRun — integration', () => {
    const id = runId('run-tr');

    beforeEach(async () => {
        await del(activeKey(id), `task:run:terminal:${id}`);
    });

    it('pending → active succeeds', async () => {
        await seed(id, { state: 'pending' });
        const result = await sm.transitionRun({
            runId: id,
            from: 'pending',
            to: 'active',
        });
        expect(result.ok).toBe(true);
        expect(result.fromState).toBe('pending');
        expect(result.toState).toBe('active');
        const state = await hget(activeKey(id), 'state');
        expect(state).toBe('active');
    });

    it('preserves the active hash while hard-kill queue cleanup is pending', async () => {
        for (const state of ['completed', 'failed', 'cancelled'] as const) {
            const from = state === 'cancelled' ? 'cancelling' : 'active';
            await del(activeKey(id), `task:run:terminal:${id}`);
            await seed(id, { state: from, hardKillQueuePending: '1', taskId: 'task' });
            const result = await sm.transitionRun({ runId: id, from, to: state });
            expect(result).toMatchObject({ ok: false, error: 'hard kill queue cleanup pending' });
            expect(await hget(activeKey(id), 'state')).toBe(from);
            expect(await hget(activeKey(id), 'hardKillQueuePending')).toBe('1');
            expect(await glideClient.exists([`task:run:terminal:${id}`])).toBe(0);
        }
    });

    it('active → completed moves hash to terminal key', async () => {
        await seed(id, { state: 'active', taskId: 'test-task' });
        const result = await sm.transitionRun({
            runId: id,
            from: 'active',
            to: 'completed',
        });
        expect(result.ok).toBe(true);

        const activeExists = await glideClient.exists([activeKey(id)]);
        expect(activeExists).toBe(0);

        const terminalState = await hget(`task:run:terminal:${id}`, 'state');
        expect(terminalState).toBe('completed');
    });

    it('active → cancelling succeeds', async () => {
        await seed(id, { state: 'active' });
        const result = await sm.transitionRun({
            runId: id,
            from: 'active',
            to: 'cancelling',
        });
        expect(result.ok).toBe(true);
    });

    it('cancelling → cancelled moves hash to terminal key', async () => {
        await seed(id, { state: 'cancelling' });
        const result = await sm.transitionRun({
            runId: id,
            from: 'cancelling',
            to: 'cancelled',
        });
        expect(result.ok).toBe(true);

        const terminalState = await hget(`task:run:terminal:${id}`, 'state');
        expect(terminalState).toBe('cancelled');
    });

    it('completed → active is rejected with ok:false (no throw)', async () => {
        await seed(id, { state: 'active' });
        await sm.transitionRun({ runId: id, from: 'active', to: 'completed' });
        // run is now in terminal key; active key is gone — re-seed for next call
        await seed(id, { state: 'completed' });
        const result = await sm.transitionRun({
            runId: id,
            from: 'completed',
            to: 'active',
        });
        expect(result.ok).toBe(false);
        expect(result.error).toBeDefined();
    });

    it('sets TTL on active key after non-terminal transition', async () => {
        await seed(id, { state: 'pending' });
        await sm.transitionRun({ runId: id, from: 'pending', to: 'active' });
        const ttl = await glideClient.pttl(activeKey(id));
        expect(ttl).toBeGreaterThan(800_000);
        expect(ttl).toBeLessThanOrEqual(900_000);
    });

    it('sets terminal TTL on terminal key after completed transition', async () => {
        await seed(id, { state: 'active' });
        await sm.transitionRun({ runId: id, from: 'active', to: 'completed' });
        const ttl = await glideClient.pttl(`task:run:terminal:${id}`);
        expect(ttl).toBeGreaterThan(3_000_000);
        expect(ttl).toBeLessThanOrEqual(3_600_000);
    });
});

// ── transitionStage tests ─────────────────────────────────────────────────────

describe('StateMachine.transitionStage — integration', () => {
    const id = runId('run-ts');
    const stageId = 'stage-0';

    beforeEach(async () => {
        await del(activeKey(id));
    });

    it('waiting → active succeeds', async () => {
        await seed(id, {
            state: 'active',
            [`stage:${stageId}:state`]: 'waiting',
        });
        const result = await sm.transitionStage({
            runId: id,
            stageId,
            from: 'waiting',
            to: 'active',
        });
        expect(result.ok).toBe(true);
        const stageState = await hget(activeKey(id), `stage:${stageId}:state`);
        expect(stageState).toBe('active');
    });

    it('active → completed succeeds', async () => {
        await seed(id, {
            state: 'active',
            [`stage:${stageId}:state`]: 'active',
        });
        const result = await sm.transitionStage({
            runId: id,
            stageId,
            from: 'active',
            to: 'completed',
        });
        expect(result.ok).toBe(true);
    });

    it('waiting → skipped succeeds', async () => {
        await seed(id, {
            state: 'active',
            [`stage:${stageId}:state`]: 'waiting',
        });
        const result = await sm.transitionStage({
            runId: id,
            stageId,
            from: 'waiting',
            to: 'skipped',
        });
        expect(result.ok).toBe(true);
    });

    it('completed → active is rejected with ok:false (no throw)', async () => {
        await seed(id, {
            state: 'active',
            [`stage:${stageId}:state`]: 'completed',
        });
        const result = await sm.transitionStage({
            runId: id,
            stageId,
            from: 'completed',
            to: 'active',
        });
        expect(result.ok).toBe(false);
        expect(result.error).toBeDefined();
    });
});

// ── incrementStage tests ──────────────────────────────────────────────────────

describe('StateMachine.incrementStage — integration', () => {
    const id = runId('run-is');
    const stageId = 'stage-0';

    beforeEach(async () => {
        await del(activeKey(id));
    });

    it('increments processed count', async () => {
        await seed(id, {
            state: 'active',
            [`stage:${stageId}:state`]: 'active',
        });
        const result = await sm.incrementStage({
            runId: id,
            stageId,
            increment: 3,
        });
        expect(result.ok).toBe(true);
        expect(result.processed).toBe(3);
        expect(result.autoCompleted).toBe(false);
    });

    it('auto-completes stage when processed >= total', async () => {
        await seed(id, {
            state: 'active',
            [`stage:${stageId}:state`]: 'active',
        });
        await sm.incrementStage({
            runId: id,
            stageId,
            increment: 8,
            total: 10,
        });
        const result = await sm.incrementStage({
            runId: id,
            stageId,
            increment: 2,
            total: 10,
        });
        expect(result.ok).toBe(true);
        expect(result.processed).toBe(10);
        expect(result.autoCompleted).toBe(true);
        const stageState = await hget(activeKey(id), `stage:${stageId}:state`);
        expect(stageState).toBe('completed');
    });

    it('does not auto-complete when total is 0 (unknown)', async () => {
        await seed(id, {
            state: 'active',
            [`stage:${stageId}:state`]: 'active',
        });
        const result = await sm.incrementStage({
            runId: id,
            stageId,
            increment: 999,
            total: 0,
        });
        expect(result.autoCompleted).toBe(false);
    });
});

// ── claimRun tests ────────────────────────────────────────────────────────────

describe('StateMachine.claimRun — integration', () => {
    const id = runId('run-cr');

    beforeEach(async () => {
        await del(activeKey(id));
    });

    it('claims unclaimed run', async () => {
        await seed(id, { state: 'active' });
        const result = await sm.claimRun({
            runId: id,
            expectedState: 'active',
            instanceId: 'instance-1',
            bootId: 'boot-abc',
        });
        expect(result.ok).toBe(true);
        const owner = await hget(activeKey(id), 'ownerInstanceId');
        expect(owner).toBe('instance-1');
    });

    it('same instance can re-claim', async () => {
        await seed(id, { state: 'active', ownerInstanceId: 'instance-1' });
        const result = await sm.claimRun({
            runId: id,
            expectedState: 'active',
            instanceId: 'instance-1',
            bootId: 'boot-abc',
        });
        expect(result.ok).toBe(true);
    });

    it('different instance is rejected with ok:false (no throw)', async () => {
        await seed(id, { state: 'active', ownerInstanceId: 'instance-1' });
        const result = await sm.claimRun({
            runId: id,
            expectedState: 'active',
            instanceId: 'instance-2',
            bootId: 'boot-xyz',
        });
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/already claimed/);
    });

    it('run not found returns ok:false (no throw)', async () => {
        const result = await sm.claimRun({
            runId: `${id}:nonexistent`,
            expectedState: 'active',
            instanceId: 'i1',
            bootId: 'b1',
        });
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/run not found/);
    });
});
