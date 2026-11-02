// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for StateMachine — mocks luaLoader and getClient.
 * No live Valkey required.
 *
 * Run with: npx vitest run src/lib/server/tasks/state-machine.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StateMachine } from './state-machine.js';

// ── Mock luaLoader ────────────────────────────────────────────────────────────

vi.mock('./lua/loader.js', () => ({
    luaLoader: {
        invoke: vi.fn(),
    },
}));

vi.mock('$lib/server/config.js', () => ({
    LUMASTRA_RUN_STATE_TTL_ACTIVE_MS: 900_000,
    LUMASTRA_RUN_STATE_TTL_TERMINAL_MS: 3_600_000,
}));

import { luaLoader } from './lua/loader.js';
const mockInvoke = vi.mocked(luaLoader.invoke);

// ── Helpers ───────────────────────────────────────────────────────────────────

type ValkeyLike = { customCommand: (cmd: string[]) => Promise<unknown> };

function makeClient(): ValkeyLike {
    return { customCommand: vi.fn() };
}

function makeMachine(): StateMachine {
    const client = makeClient();
    return new StateMachine(() => client);
}

// ── transitionRun ─────────────────────────────────────────────────────────────

describe('StateMachine.transitionRun', () => {
    beforeEach(() => {
        mockInvoke.mockReset();
    });

    it('returns ok:true on successful transition', async () => {
        mockInvoke.mockResolvedValue(['pending', 'active']);
        const sm = makeMachine();
        const result = await sm.transitionRun({
            runId: 'r1',
            from: 'pending',
            to: 'active',
        });
        expect(result).toEqual({
            ok: true,
            fromState: 'pending',
            toState: 'active',
        });
    });

    it('returns ok:false with error on Lua error', async () => {
        mockInvoke.mockResolvedValue({
            err: 'state mismatch: expected pending got active',
        });
        const sm = makeMachine();
        const result = await sm.transitionRun({
            runId: 'r1',
            from: 'pending',
            to: 'active',
        });
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/state mismatch/);
    });

    it('returns ok:false with error on run not found', async () => {
        mockInvoke.mockResolvedValue({ err: 'run not found' });
        const sm = makeMachine();
        const result = await sm.transitionRun({
            runId: 'missing',
            from: 'pending',
            to: 'active',
        });
        expect(result.ok).toBe(false);
        expect(result.error).toBe('run not found');
    });

    it('returns ok:false on unexpected return shape', async () => {
        mockInvoke.mockResolvedValue(42);
        const sm = makeMachine();
        const result = await sm.transitionRun({
            runId: 'r1',
            from: 'pending',
            to: 'active',
        });
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/Unexpected/);
    });

    it('passes correct KEYS and ARGV to luaLoader.invoke', async () => {
        mockInvoke.mockResolvedValue(['active', 'completed']);
        const sm = makeMachine();
        await sm.transitionRun({
            runId: 'abc',
            from: 'active',
            to: 'completed',
        });

        expect(mockInvoke).toHaveBeenCalledOnce();
        const [scriptName, keys, argv] = mockInvoke.mock.calls[0];
        expect(scriptName).toBe('transition-run');
        expect(keys).toEqual(['task:run:active:abc', 'task:run:terminal:abc']);
        expect(argv[0]).toBe('active');
        expect(argv[1]).toBe('completed');
        expect(argv[2]).toBe('900000');
        expect(argv[3]).toBe('3600000');
    });

    it('flattens extra fields into ARGV', async () => {
        mockInvoke.mockResolvedValue(['active', 'cancelling']);
        const sm = makeMachine();
        await sm.transitionRun({
            runId: 'r1',
            from: 'active',
            to: 'cancelling',
            extra: { heartbeatAt: 12345, reason: 'user' },
        });

        const [, , argv] = mockInvoke.mock.calls[0];
        expect(argv).toContain('heartbeatAt');
        expect(argv).toContain('12345');
        expect(argv).toContain('reason');
        expect(argv).toContain('user');
    });
});

// ── transitionStage ───────────────────────────────────────────────────────────

describe('StateMachine.transitionStage', () => {
    beforeEach(() => {
        mockInvoke.mockReset();
    });

    it('returns ok:true on success', async () => {
        mockInvoke.mockResolvedValue(['waiting', 'active']);
        const sm = makeMachine();
        const result = await sm.transitionStage({
            runId: 'r1',
            stageId: 's0',
            from: 'waiting',
            to: 'active',
        });
        expect(result).toEqual({
            ok: true,
            fromState: 'waiting',
            toState: 'active',
        });
    });

    it('returns ok:false on invalid stage transition', async () => {
        mockInvoke.mockResolvedValue({
            err: 'invalid stage transition: completed -> active',
        });
        const sm = makeMachine();
        const result = await sm.transitionStage({
            runId: 'r1',
            stageId: 's0',
            from: 'completed',
            to: 'active',
        });
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/invalid stage transition/);
    });

    it('passes stageId as first ARGV element', async () => {
        mockInvoke.mockResolvedValue(['waiting', 'skipped']);
        const sm = makeMachine();
        await sm.transitionStage({
            runId: 'r2',
            stageId: 'stage-1',
            from: 'waiting',
            to: 'skipped',
        });
        const [, keys, argv] = mockInvoke.mock.calls[0];
        expect(keys).toEqual(['task:run:active:r2']);
        expect(argv[0]).toBe('stage-1');
        expect(argv[1]).toBe('waiting');
        expect(argv[2]).toBe('skipped');
        expect(argv[3]).toBe('900000');
    });

    it('flattens extra fields for stage transitions', async () => {
        mockInvoke.mockResolvedValue(['active', 'completed']);
        const sm = makeMachine();
        await sm.transitionStage({
            runId: 'r1',
            stageId: 's0',
            from: 'active',
            to: 'completed',
            extra: { 'stage:s0:completedAt': '9999' },
        });
        const [, , argv] = mockInvoke.mock.calls[0];
        expect(argv).toContain('stage:s0:completedAt');
        expect(argv).toContain('9999');
    });
});

// ── incrementStage ────────────────────────────────────────────────────────────

describe('StateMachine.incrementStage', () => {
    beforeEach(() => {
        mockInvoke.mockReset();
    });

    it('returns processed count and autoCompleted=false', async () => {
        mockInvoke.mockResolvedValue([5, 0]);
        const sm = makeMachine();
        const result = await sm.incrementStage({
            runId: 'r1',
            stageId: 's0',
            increment: 5,
        });
        expect(result).toEqual({
            ok: true,
            processed: 5,
            autoCompleted: false,
        });
    });

    it('returns autoCompleted=true when Lua returns 1', async () => {
        mockInvoke.mockResolvedValue([10, 1]);
        const sm = makeMachine();
        const result = await sm.incrementStage({
            runId: 'r1',
            stageId: 's0',
            increment: 2,
            total: 10,
        });
        expect(result.autoCompleted).toBe(true);
        expect(result.processed).toBe(10);
    });

    it('defaults increment=1 and total=0 when omitted', async () => {
        mockInvoke.mockResolvedValue([1, 0]);
        const sm = makeMachine();
        await sm.incrementStage({ runId: 'r1', stageId: 's0' });
        const [, , argv] = mockInvoke.mock.calls[0];
        expect(argv[1]).toBe('1');
        expect(argv[2]).toBe('0');
    });

    it('returns ok:false on unexpected return', async () => {
        mockInvoke.mockResolvedValue(null);
        const sm = makeMachine();
        const result = await sm.incrementStage({ runId: 'r1', stageId: 's0' });
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/Unexpected/);
    });

    it('returns ok:false with error on positional ["err", msg] shape (v2 Lua)', async () => {
        // increment-stage.lua v2 returns positional ['err', msg] on failure —
        // regression guard for the misparse that read this as
        // {ok:true, processed:NaN} before isPositionalErr was added here.
        mockInvoke.mockResolvedValue(['err', 'run not found']);
        const sm = makeMachine();
        const result = await sm.incrementStage({ runId: 'missing', stageId: 's0' });
        expect(result).toEqual({
            ok: false,
            processed: 0,
            autoCompleted: false,
            error: 'run not found',
        });
    });

    it('returns ok:false with error on legacy {err: ...} shape', async () => {
        mockInvoke.mockResolvedValue({ err: 'stage not found' });
        const sm = makeMachine();
        const result = await sm.incrementStage({ runId: 'r1', stageId: 's0' });
        expect(result.ok).toBe(false);
        expect(result.error).toBe('stage not found');
    });
});

// ── claimRun ─────────────────────────────────────────────────────────────────

describe('StateMachine.claimRun', () => {
    beforeEach(() => {
        mockInvoke.mockReset();
    });

    it('returns ok:true on successful claim', async () => {
        mockInvoke.mockResolvedValue({ ok: 'claimed' });
        const sm = makeMachine();
        const result = await sm.claimRun({
            runId: 'r1',
            expectedState: 'active',
            instanceId: 'i1',
            bootId: 'b1',
        });
        expect(result).toEqual({ ok: true });
    });

    it('returns ok:false when already claimed by another instance', async () => {
        mockInvoke.mockResolvedValue({ err: 'already claimed by instance-2' });
        const sm = makeMachine();
        const result = await sm.claimRun({
            runId: 'r1',
            expectedState: 'active',
            instanceId: 'i1',
            bootId: 'b1',
        });
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/already claimed/);
    });

    it('returns ok:false when run not found', async () => {
        mockInvoke.mockResolvedValue({ err: 'run not found' });
        const sm = makeMachine();
        const result = await sm.claimRun({
            runId: 'missing',
            expectedState: 'active',
            instanceId: 'i1',
            bootId: 'b1',
        });
        expect(result.ok).toBe(false);
        expect(result.error).toBe('run not found');
    });

    it('passes instanceId, bootId, nowMs to ARGV', async () => {
        mockInvoke.mockResolvedValue({ ok: 'claimed' });
        const sm = makeMachine();
        await sm.claimRun({
            runId: 'r1',
            expectedState: 'active',
            instanceId: 'web-1',
            bootId: 'boot-abc',
            nowMs: 1234567890,
        });
        const [, keys, argv] = mockInvoke.mock.calls[0];
        expect(keys).toEqual(['task:run:active:r1']);
        expect(argv[0]).toBe('active');
        expect(argv[1]).toBe('web-1');
        expect(argv[2]).toBe('boot-abc');
        expect(argv[3]).toBe('1234567890');
    });

    it('returns ok:false on unexpected return shape', async () => {
        mockInvoke.mockResolvedValue('unexpected string');
        const sm = makeMachine();
        const result = await sm.claimRun({
            runId: 'r1',
            expectedState: 'active',
            instanceId: 'i1',
            bootId: 'b1',
        });
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/Unexpected/);
    });
});

// ── reseedForRetry ────────────────────────────────────────────────────────────
//
// F6 regression — claim-run.lua requires state='pending'. The transition-run.lua
// terminal branch DEL's the active hash on active→failed, so the second BullMQ
// attempt would either find no hash ('run not found') or, on a non-terminal
// failure path that left the hash, see state='failed' and reject with
// 'state mismatch'. reseedForRetry is the targeted fix: it puts the hash back
// into a claimable state when (and only when) the prior attempt actually
// terminated. The 'cancelling' branch is load-bearing — a cancel that arrived
// between attempts must win over the retry.

describe('StateMachine.reseedForRetry', () => {
    beforeEach(() => {
        mockInvoke.mockReset();
    });

    // The body now delegates the read+conditional-write to reseed-for-retry.lua
    // (atomic — closes audit C1 + H2). Tests mock luaLoader.invoke's positional
    // ['ok', value] return and assert the KEYS/ARGV the script receives.
    function makeMachineForReseed(): StateMachine {
        const client = makeClient();
        return new StateMachine(() => client);
    }

    it("returns 'reseeded' when the Lua script re-seeds (missing / non-cancelled terminal)", async () => {
        mockInvoke.mockResolvedValue(['ok', 'reseeded']);
        const sm = makeMachineForReseed();
        const result = await sm.reseedForRetry('run_missing');
        expect(result).toBe('reseeded');

        // Probes BOTH the active and terminal hash, atomically.
        const [scriptName, keys, argv] = mockInvoke.mock.calls[0];
        expect(scriptName).toBe('reseed-for-retry');
        expect(keys).toEqual(['task:run:active:run_missing', 'task:run:terminal:run_missing']);
        // ARGV: [activeTtlMs, nowMs]
        expect(argv[0]).toBe('900000');
        expect(String(argv[1])).toMatch(/^\d+$/);
    });

    // C1 regression — the cancelled run's active hash is DEL'd by
    // transition-run.lua and its state lives in the terminal hash. The Lua
    // script inspects the terminal hash and returns 'skipped' so the worker
    // never resurrects cancelled work.
    it("returns 'skipped' when the terminal hash records state='cancelled' (C1)", async () => {
        mockInvoke.mockResolvedValue(['ok', 'skipped']);
        const sm = makeMachineForReseed();
        const result = await sm.reseedForRetry('run_cancelled');
        expect(result).toBe('skipped');
    });

    it("returns 'skipped' when a cancel is in flight (active state='cancelling')", async () => {
        mockInvoke.mockResolvedValue(['ok', 'skipped']);
        const sm = makeMachineForReseed();
        const result = await sm.reseedForRetry('run_cancelling');
        expect(result).toBe('skipped');
    });

    it("returns 'kept-active' when the hash is already pending/active", async () => {
        mockInvoke.mockResolvedValue(['ok', 'kept-active']);
        const sm = makeMachineForReseed();
        const result = await sm.reseedForRetry('run_active');
        expect(result).toBe('kept-active');
    });

    it('throws on an unexpected Lua return shape', async () => {
        mockInvoke.mockResolvedValue(42);
        const sm = makeMachineForReseed();
        await expect(sm.reseedForRetry('run_weird')).rejects.toThrow(/unexpected Lua return/);
    });
});

// ── argument flattening ───────────────────────────────────────────────────────

describe('extra field flattening', () => {
    beforeEach(() => {
        mockInvoke.mockReset();
    });

    it('handles numeric values by coercing to string', async () => {
        mockInvoke.mockResolvedValue(['active', 'cancelling']);
        const sm = makeMachine();
        await sm.transitionRun({
            runId: 'r1',
            from: 'active',
            to: 'cancelling',
            extra: { timeout: 5000 },
        });
        const [, , argv] = mockInvoke.mock.calls[0];
        expect(argv).toContain('timeout');
        expect(argv).toContain('5000');
    });

    it('emits no extra args when extra is undefined', async () => {
        mockInvoke.mockResolvedValue(['pending', 'active']);
        const sm = makeMachine();
        await sm.transitionRun({ runId: 'r1', from: 'pending', to: 'active' });
        const [, , argv] = mockInvoke.mock.calls[0];
        expect(argv).toHaveLength(4);
    });

    it('emits no extra args when extra is empty object', async () => {
        mockInvoke.mockResolvedValue(['pending', 'active']);
        const sm = makeMachine();
        await sm.transitionRun({
            runId: 'r1',
            from: 'pending',
            to: 'active',
            extra: {},
        });
        const [, , argv] = mockInvoke.mock.calls[0];
        expect(argv).toHaveLength(4);
    });
});
