// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the Lua scripts.
 * Requires a live Valkey instance (CACHE_URL env or redis://localhost:6379).
 *
 * Run with: npm run test:integration src/lib/server/tasks/lua/scripts.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { GlideClient } from '@valkey/valkey-glide';
import { luaLoader } from './loader.js';

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

let client: GlideClient;

beforeAll(async () => {
    const url = process.env.CACHE_URL || 'redis://localhost:6379';
    const cfg = parseUrl(url);
    if (!cfg) throw new Error(`Cannot parse CACHE_URL: ${url}`);

    const glideConfig: Parameters<typeof GlideClient.createClient>[0] = {
        addresses: [{ host: cfg.host, port: cfg.port }],
        requestTimeout: 10_000,
        clientName: 'lua-script-tests',
    };
    if (cfg.password) {
        glideConfig.credentials = {
            username: cfg.username ?? 'default',
            password: cfg.password,
        };
    }
    client = await GlideClient.createClient(glideConfig);
    await luaLoader.load();
}, 30_000);

afterAll(async () => {
    if (client) client.close();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const PREFIX = 'test:lua:' + Date.now() + ':';
const ACTIVE_TTL = '900000';
const TERMINAL_TTL = '3600000';

function activeKey(runId: string): string {
    return `task:run:active:${PREFIX}${runId}`;
}
function terminalKey(runId: string): string {
    return `task:run:terminal:${PREFIX}${runId}`;
}
function identityKey(formula: string): string {
    return `task:identity:${PREFIX}${formula}`;
}

async function del(...keys: string[]): Promise<void> {
    if (keys.length) await client.del(keys);
}

async function hset(key: string, fields: Record<string, string>): Promise<void> {
    for (const [f, v] of Object.entries(fields)) {
        await client.hset(key, { [f]: v });
    }
}

async function hget(key: string, field: string): Promise<string | null> {
    const result = await client.hget(key, field);
    if (result === null || result === undefined) return null;
    return typeof result === 'string' ? result : String(result);
}

async function invoke(
    name: Parameters<typeof luaLoader.invoke>[0],
    keys: string[],
    argv: (string | number)[],
): Promise<unknown> {
    return luaLoader.invoke(
        name,
        keys,
        argv,
        client as unknown as {
            customCommand: (cmd: string[]) => Promise<unknown>;
        },
    );
}

// ── transition-run ────────────────────────────────────────────────────────────

describe('transition-run.lua', () => {
    const runId = 'run-tr-1';

    beforeEach(async () => {
        await del(activeKey(runId), terminalKey(runId));
    });

    it('transitions pending → active', async () => {
        await hset(activeKey(runId), { state: 'pending' });
        const result = await invoke(
            'transition-run',
            [activeKey(runId), terminalKey(runId)],
            ['pending', 'active', ACTIVE_TTL, TERMINAL_TTL],
        );
        expect(result).toEqual(['pending', 'active']);
        const state = await hget(activeKey(runId), 'state');
        expect(state).toBe('active');
    });

    it('transitions active → completed and moves to terminal key', async () => {
        await hset(activeKey(runId), { state: 'active', taskId: 'my-task' });
        const result = await invoke(
            'transition-run',
            [activeKey(runId), terminalKey(runId)],
            ['active', 'completed', ACTIVE_TTL, TERMINAL_TTL],
        );
        expect(result).toEqual(['active', 'completed']);

        const activeExists = await client.exists([activeKey(runId)]);
        expect(activeExists).toBe(0);

        const terminalState = await hget(terminalKey(runId), 'state');
        expect(terminalState).toBe('completed');
    });

    it('returns error on state mismatch', async () => {
        await hset(activeKey(runId), { state: 'pending' });
        const result = (await invoke(
            'transition-run',
            [activeKey(runId), terminalKey(runId)],
            ['active', 'completed', ACTIVE_TTL, TERMINAL_TTL],
        )) as [string, string];
        expect(result[0]).toBe('err');
        expect(result[1]).toMatch(/state mismatch/);
    });

    it('rejects invalid transition pending → completed', async () => {
        await hset(activeKey(runId), { state: 'pending' });
        const result = (await invoke(
            'transition-run',
            [activeKey(runId), terminalKey(runId)],
            ['pending', 'completed', ACTIVE_TTL, TERMINAL_TTL],
        )) as [string, string];
        expect(result[0]).toBe('err');
        expect(result[1]).toMatch(/invalid transition/);
    });

    it('returns error when run not found', async () => {
        const result = (await invoke(
            'transition-run',
            [activeKey(runId), terminalKey(runId)],
            ['pending', 'active', ACTIVE_TTL, TERMINAL_TTL],
        )) as [string, string];
        expect(result[0]).toBe('err');
        expect(result[1]).toMatch(/run not found/);
    });

    it('passes additional fields through to the hash', async () => {
        await hset(activeKey(runId), { state: 'active' });
        await invoke(
            'transition-run',
            [activeKey(runId), terminalKey(runId)],
            ['active', 'cancelling', ACTIVE_TTL, TERMINAL_TTL, 'heartbeatAt', '12345'],
        );
        const heartbeat = await hget(activeKey(runId), 'heartbeatAt');
        expect(heartbeat).toBe('12345');
    });

    it('sets TTL on active key after non-terminal transition', async () => {
        await hset(activeKey(runId), { state: 'pending' });
        await invoke(
            'transition-run',
            [activeKey(runId), terminalKey(runId)],
            ['pending', 'active', ACTIVE_TTL, TERMINAL_TTL],
        );
        const ttl = await client.pttl(activeKey(runId));
        expect(ttl).toBeGreaterThan(800_000);
    });
});

// ── transition-stage ──────────────────────────────────────────────────────────

describe('transition-stage.lua', () => {
    const runId = 'run-ts-1';
    const stageId = 'stage-0';

    beforeEach(async () => {
        await del(activeKey(runId));
    });

    it('transitions stage waiting → active', async () => {
        await hset(activeKey(runId), {
            state: 'active',
            [`stage:${stageId}:state`]: 'waiting',
        });
        const result = await invoke(
            'transition-stage',
            [activeKey(runId)],
            [stageId, 'waiting', 'active', ACTIVE_TTL],
        );
        expect(result).toEqual(['waiting', 'active']);
        const stageState = await hget(activeKey(runId), `stage:${stageId}:state`);
        expect(stageState).toBe('active');
    });

    it('transitions stage active → completed', async () => {
        await hset(activeKey(runId), {
            state: 'active',
            [`stage:${stageId}:state`]: 'active',
        });
        const result = await invoke(
            'transition-stage',
            [activeKey(runId)],
            [stageId, 'active', 'completed', ACTIVE_TTL],
        );
        expect(result).toEqual(['active', 'completed']);
    });

    it('transitions stage waiting → skipped', async () => {
        await hset(activeKey(runId), {
            state: 'active',
            [`stage:${stageId}:state`]: 'waiting',
        });
        const result = await invoke(
            'transition-stage',
            [activeKey(runId)],
            [stageId, 'waiting', 'skipped', ACTIVE_TTL],
        );
        expect(result).toEqual(['waiting', 'skipped']);
    });

    it('rejects invalid stage transition active → waiting', async () => {
        await hset(activeKey(runId), {
            state: 'active',
            [`stage:${stageId}:state`]: 'active',
        });
        const result = (await invoke(
            'transition-stage',
            [activeKey(runId)],
            [stageId, 'active', 'waiting', ACTIVE_TTL],
        )) as [string, string];
        expect(result[0]).toBe('err');
        expect(result[1]).toMatch(/invalid stage transition/);
    });
});

// ── increment-stage ───────────────────────────────────────────────────────────

describe('increment-stage.lua', () => {
    const runId = 'run-is-1';
    const stageId = 'stage-0';

    beforeEach(async () => {
        await del(activeKey(runId));
    });

    it('increments processed count', async () => {
        await hset(activeKey(runId), {
            state: 'active',
            [`stage:${stageId}:state`]: 'active',
        });
        const [n, completed] = (await invoke(
            'increment-stage',
            [activeKey(runId)],
            [stageId, '5', '0', ACTIVE_TTL],
        )) as [number, number];
        expect(n).toBe(5);
        expect(completed).toBe(0);
    });

    it('auto-completes stage when processed >= total', async () => {
        await hset(activeKey(runId), {
            state: 'active',
            [`stage:${stageId}:state`]: 'active',
        });
        await invoke('increment-stage', [activeKey(runId)], [stageId, '8', '10', ACTIVE_TTL]);
        const [n, completed] = (await invoke(
            'increment-stage',
            [activeKey(runId)],
            [stageId, '2', '10', ACTIVE_TTL],
        )) as [number, number];
        expect(n).toBe(10);
        expect(completed).toBe(1);
        const stageState = await hget(activeKey(runId), `stage:${stageId}:state`);
        expect(stageState).toBe('completed');
    });

    it('does not auto-complete when total is 0', async () => {
        await hset(activeKey(runId), {
            state: 'active',
            [`stage:${stageId}:state`]: 'active',
        });
        const [, completed] = (await invoke(
            'increment-stage',
            [activeKey(runId)],
            [stageId, '999', '0', ACTIVE_TTL],
        )) as [number, number];
        expect(completed).toBe(0);
    });

    // BUG FIX (increment-stage.lua @version 2): a late increment arriving
    // after the run's terminal transition already DEL'd the active hash
    // used to silently HINCRBY into a fresh key, recreating
    // task:run:active:<runId> as a half-populated hash with a new TTL. The
    // script now mirrors the HEXISTS guard every sibling transition script
    // already has.
    it('returns error when run not found (no key recreation)', async () => {
        // activeKey(runId) is guaranteed absent — del()'d in beforeEach and
        // never written to in this test.
        const result = (await invoke(
            'increment-stage',
            [activeKey(runId)],
            [stageId, '1', '0', ACTIVE_TTL],
        )) as [string, string];
        expect(result[0]).toBe('err');
        expect(result[1]).toMatch(/run not found/);

        // The guard must reject BEFORE any HINCRBY/PEXPIRE — confirm the key
        // was not silently recreated.
        const exists = await client.exists([activeKey(runId)]);
        expect(exists).toBe(0);
    });
});

// ── claim-run ─────────────────────────────────────────────────────────────────

describe('claim-run.lua', () => {
    const runId = 'run-cr-1';

    beforeEach(async () => {
        await del(activeKey(runId));
    });

    it('claims unclaimed run', async () => {
        await hset(activeKey(runId), { state: 'active' });
        const result = (await invoke(
            'claim-run',
            [activeKey(runId)],
            ['active', 'instance-1', 'boot-abc', '1234567890'],
        )) as [string, string];
        expect(result[0]).toBe('ok');
        expect(result[1]).toBe('claimed');
        const owner = await hget(activeKey(runId), 'ownerInstanceId');
        expect(owner).toBe('instance-1');
    });

    it('allows re-claim by same instance', async () => {
        await hset(activeKey(runId), {
            state: 'active',
            ownerInstanceId: 'instance-1',
        });
        const result = (await invoke(
            'claim-run',
            [activeKey(runId)],
            ['active', 'instance-1', 'boot-abc', '1234567890'],
        )) as [string, string];
        expect(result[0]).toBe('ok');
        expect(result[1]).toBe('claimed');
    });

    it('rejects claim by different instance', async () => {
        await hset(activeKey(runId), {
            state: 'active',
            ownerInstanceId: 'instance-1',
        });
        const result = (await invoke(
            'claim-run',
            [activeKey(runId)],
            ['active', 'instance-2', 'boot-xyz', '1234567890'],
        )) as [string, string];
        expect(result[0]).toBe('err');
        expect(result[1]).toMatch(/already claimed/);
    });

    it('rejects claim when run not found', async () => {
        const result = (await invoke(
            'claim-run',
            [activeKey(runId)],
            ['active', 'instance-1', 'boot-abc', '1234567890'],
        )) as [string, string];
        expect(result[0]).toBe('err');
        expect(result[1]).toMatch(/run not found/);
    });

    it('rejects claim when state mismatch', async () => {
        await hset(activeKey(runId), { state: 'pending' });
        const result = (await invoke(
            'claim-run',
            [activeKey(runId)],
            ['active', 'instance-1', 'boot-abc', '1234567890'],
        )) as [string, string];
        expect(result[0]).toBe('err');
        expect(result[1]).toMatch(/state mismatch/);
    });
});

// ── reseed-for-retry ──────────────────────────────────────────────────────────

describe('reseed-for-retry.lua', () => {
    const runId = 'run-rfr-1';

    beforeEach(async () => {
        await del(activeKey(runId), terminalKey(runId));
    });

    // C1 — a cancelled run reached terminal state: transition-run.lua DEL'd the
    // active hash and copied its fields into the terminal hash with
    // state='cancelled'. reseed-for-retry MUST refuse to resurrect it even
    // though the active hash is missing.
    it("returns skipped when the terminal hash records state='cancelled' (C1)", async () => {
        await hset(terminalKey(runId), {
            state: 'cancelled',
            taskId: 'my-task',
        });
        const result = (await invoke(
            'reseed-for-retry',
            [activeKey(runId), terminalKey(runId)],
            [ACTIVE_TTL, String(Date.now())],
        )) as [string, string];
        expect(result).toEqual(['ok', 'skipped']);

        // CRITICAL: the active hash must NOT have been re-seeded.
        const activeExists = await client.exists([activeKey(runId)]);
        expect(activeExists).toBe(0);
    });

    it("re-seeds state='pending' when the active hash is missing and no cancelled terminal", async () => {
        const result = (await invoke(
            'reseed-for-retry',
            [activeKey(runId), terminalKey(runId)],
            [ACTIVE_TTL, String(Date.now())],
        )) as [string, string];
        expect(result).toEqual(['ok', 'reseeded']);

        const state = await hget(activeKey(runId), 'state');
        expect(state).toBe('pending');
        const owner = await hget(activeKey(runId), 'ownerInstanceId');
        expect(owner).toBe('');
        const ttl = await client.pttl(activeKey(runId));
        expect(ttl).toBeGreaterThan(800_000);
    });

    it("re-seeds when the active hash holds a non-cancelled terminal state ('failed')", async () => {
        await hset(activeKey(runId), { state: 'failed' });
        const result = (await invoke(
            'reseed-for-retry',
            [activeKey(runId), terminalKey(runId)],
            [ACTIVE_TTL, String(Date.now())],
        )) as [string, string];
        expect(result).toEqual(['ok', 'reseeded']);
        expect(await hget(activeKey(runId), 'state')).toBe('pending');
    });

    it("returns skipped WITHOUT clobbering when a cancel is in flight (state='cancelling')", async () => {
        await hset(activeKey(runId), { state: 'cancelling' });
        const result = (await invoke(
            'reseed-for-retry',
            [activeKey(runId), terminalKey(runId)],
            [ACTIVE_TTL, String(Date.now())],
        )) as [string, string];
        expect(result).toEqual(['ok', 'skipped']);
        // Must NOT have been overwritten to 'pending'.
        expect(await hget(activeKey(runId), 'state')).toBe('cancelling');
    });

    it("returns kept-active without writing when state='active'", async () => {
        await hset(activeKey(runId), {
            state: 'active',
            ownerInstanceId: 'instance-1',
        });
        const result = (await invoke(
            'reseed-for-retry',
            [activeKey(runId), terminalKey(runId)],
            [ACTIVE_TTL, String(Date.now())],
        )) as [string, string];
        expect(result).toEqual(['ok', 'kept-active']);
        expect(await hget(activeKey(runId), 'state')).toBe('active');
        expect(await hget(activeKey(runId), 'ownerInstanceId')).toBe('instance-1');
    });

    it("returns kept-active without writing when state='pending' (no-op safe)", async () => {
        await hset(activeKey(runId), { state: 'pending' });
        const result = (await invoke(
            'reseed-for-retry',
            [activeKey(runId), terminalKey(runId)],
            [ACTIVE_TTL, String(Date.now())],
        )) as [string, string];
        expect(result).toEqual(['ok', 'kept-active']);
    });
});

// ── enqueue-with-identity ─────────────────────────────────────────────────────

describe('enqueue-with-identity.lua', () => {
    const formula = 'file-scan::lib-1';

    beforeEach(async () => {
        await del(identityKey(formula));
    });

    it('first enqueue returns enqueued with runId', async () => {
        const result = (await invoke(
            'enqueue-with-identity',
            [identityKey(formula)],
            ['run_01', '86400000'],
        )) as [string, string];
        expect(result[0]).toBe('enqueued');
        expect(result[1]).toBe('run_01');
    });

    it('second enqueue with same key returns duplicate with first runId', async () => {
        await invoke('enqueue-with-identity', [identityKey(formula)], ['run_01', '86400000']);
        const result = (await invoke(
            'enqueue-with-identity',
            [identityKey(formula)],
            ['run_02', '86400000'],
        )) as [string, string];
        expect(result[0]).toBe('duplicate');
        expect(result[1]).toBe('run_01');
    });

    it('sets TTL on the identity key', async () => {
        await invoke('enqueue-with-identity', [identityKey(formula)], ['run_01', '86400000']);
        const ttl = await client.pttl(identityKey(formula));
        expect(ttl).toBeGreaterThan(80_000_000);
    });
});

// ── release-identity ──────────────────────────────────────────────────────────

describe('release-identity.lua', () => {
    const formula = 'file-scan::lib-release';
    const normalize = async (key: string): Promise<string | null> => {
        const v = await client.get(key);
        if (v === null || v === undefined) return null;
        return typeof v === 'string' ? v : String(v);
    };

    beforeEach(async () => {
        await del(identityKey(formula));
    });

    it('deletes the key when the stored value matches the runId', async () => {
        await invoke('enqueue-with-identity', [identityKey(formula)], ['run_owner', '86400000']);
        const result = await invoke('release-identity', [identityKey(formula)], ['run_owner']);
        expect(Number(result)).toBe(1);
        expect(await normalize(identityKey(formula))).toBeNull();
    });

    it('does NOT delete when the stored value differs — successor lock survives', async () => {
        // A successor re-claimed the identity after the predecessor's key expired.
        await invoke(
            'enqueue-with-identity',
            [identityKey(formula)],
            ['run_successor', '86400000'],
        );
        // Predecessor tries to release with its OWN (stale) runId.
        const result = await invoke(
            'release-identity',
            [identityKey(formula)],
            ['run_predecessor'],
        );
        expect(Number(result)).toBe(0);
        expect(await normalize(identityKey(formula))).toBe('run_successor');
    });

    it('returns 0 when the key is absent', async () => {
        const result = await invoke('release-identity', [identityKey(formula)], ['whatever']);
        expect(Number(result)).toBe(0);
    });
});

// NOTE: the daily-run quota moved off Valkey into Postgres (`task_quota_usage`)
// for TASK-C4 — see task-quota.queries.integration.test.ts. The former
// `quota-incr.lua` script and its tests were removed with that change.

// A stalled BullMQ delivery owns a NEW queue lock; the old run hash may survive.
describe('reseed-for-retry: stalled delivery ownership', () => {
    it('resets a stranded active hash only with the current BullMQ lock token', async () => {
        const key = activeKey('stalled-redelivery');
        const terminal = terminalKey('stalled-redelivery');
        const lock = `${PREFIX}queue-lock`;
        await client.customCommand([
            'HSET',
            key,
            'state',
            'active',
            'ownerInstanceId',
            'dead-worker',
            'ownerBootId',
            'dead-boot',
        ]);
        await client.customCommand(['SET', lock, 'new-token', 'PX', '30000']);
        try {
            expect(
                await luaLoader.invoke(
                    'reseed-for-retry',
                    [key, terminal, lock],
                    [ACTIVE_TTL, String(Date.now()), 'wrong-token'],
                    client,
                ),
            ).toEqual(['ok', 'kept-active']);
            expect(
                await luaLoader.invoke(
                    'reseed-for-retry',
                    [key, terminal, lock],
                    [ACTIVE_TTL, String(Date.now()), 'new-token'],
                    client,
                ),
            ).toEqual(['ok', 'reseeded']);
            expect(await client.customCommand(['HGET', key, 'state'])).toBe('pending');
            expect(await client.customCommand(['HGET', key, 'ownerBootId'])).toBe('');
        } finally {
            await client.customCommand(['DEL', key, terminal, lock]);
        }
    });
    it('keeps an active predecessor with a fresh heartbeat despite a new queue token', async () => {
        const key = activeKey('fresh-predecessor');
        const lock = `${PREFIX}fresh-lock`;
        const terminal = terminalKey('fresh-predecessor');
        await hset(key, {
            state: 'active',
            heartbeatAt: String(Date.now()),
            ownerBootId: 'old-boot',
        });
        await client.customCommand(['SET', lock, 'token', 'PX', '30000']);
        try {
            expect(
                await invoke(
                    'reseed-for-retry',
                    [key, terminal, lock],
                    [ACTIVE_TTL, String(Date.now()), 'token'],
                ),
            ).toEqual(['ok', 'kept-active']);
            expect(await hget(key, 'ownerBootId')).toBe('old-boot');
        } finally {
            await del(key, terminal, lock);
        }
    });
    it('does not resurrect completed work on a stalled redelivery', async () => {
        const key = activeKey('completed-redelivery');
        const terminal = terminalKey('completed-redelivery');
        const lock = `${PREFIX}completed-lock`;
        await client.customCommand(['HSET', terminal, 'state', 'completed']);
        await client.customCommand(['SET', lock, 'token', 'PX', '30000']);
        try {
            expect(
                await luaLoader.invoke(
                    'reseed-for-retry',
                    [key, terminal, lock],
                    [ACTIVE_TTL, String(Date.now()), 'token'],
                    client,
                ),
            ).toEqual(['ok', 'skipped']);
            expect(await client.customCommand(['HEXISTS', key, 'state'])).toBe(false);
        } finally {
            await client.customCommand(['DEL', key, terminal, lock]);
        }
    });
});

describe('identity TTL renewal', () => {
    it('refreshes only the owning run, never a successor', async () => {
        const key = identityKey('renew');
        await client.customCommand(['SET', key, 'run-one', 'PX', '1000']);
        try {
            expect(
                await invoke(
                    'refresh-identity' as Parameters<typeof invoke>[0],
                    [key],
                    ['run-one', '7800000'],
                ),
            ).toBe(1);
            expect(Number(await client.customCommand(['PTTL', key]))).toBeGreaterThan(7790000);
            await client.customCommand(['SET', key, 'run-two', 'PX', '1000']);
            expect(
                await invoke(
                    'refresh-identity' as Parameters<typeof invoke>[0],
                    [key],
                    ['run-one', '7800000'],
                ),
            ).toBe(0);
            expect(Number(await client.customCommand(['PTTL', key]))).toBeLessThanOrEqual(1000);
            expect(await client.customCommand(['GET', key])).toBe('run-two');
        } finally {
            await del(key);
        }
    });
});
