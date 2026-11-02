// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import type postgres from 'postgres';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import { Scheduler, parseDurationMs } from './scheduler.js';
import { TaskRegistry } from './registry.js';
import type { StartRunOpts } from './orchestrator.js';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('$lib/server/config.js', () => ({
    config: { INSTANCE_ID: 'test-node-1' },
    // registry.ts (imported transitively) reads this at module load.
    FEATURE_PER_TASK_QUEUES: false,
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

vi.mock('./scheduler-state.js', () => ({
    getSchedulerState: vi.fn(async () => null),
    upsertSchedulerState: vi.fn(async () => undefined),
    // Default: behave like a winning INSERT — echo back the caller's proposed
    // state (fresh DB, no prior row). Tests that model a concurrent replica
    // override the implementation to return a persisted (already-seeded) row.
    seedSchedulerStateIfAbsent: vi.fn(async (_sql: unknown, state: unknown) => state),
    // Default: no operator triggers — every existing test (all written before
    // triggers existed) keeps exercising the envOverride/declared `every`
    // fallback unchanged.
    listAllTaskTriggers: vi.fn(async () => new Map()),
    setNextFireAt: vi.fn(async () => undefined),
}));

import {
    getSchedulerState,
    upsertSchedulerState,
    seedSchedulerStateIfAbsent,
    listAllTaskTriggers,
    setNextFireAt,
    type SchedulerState,
} from './scheduler-state.js';
import type { TaskTrigger } from '$lib/schemas/task-definition.schema.js';

const mockGetState = vi.mocked(getSchedulerState);
const mockUpsert = vi.mocked(upsertSchedulerState);
const mockSeed = vi.mocked(seedSchedulerStateIfAbsent);
const mockListTriggers = vi.mocked(listAllTaskTriggers);
const mockSetNext = vi.mocked(setNextFireAt);

function triggersFor(taskId: string, triggers: TaskTrigger[]) {
    return new Map([[taskId, { triggers, updatedBy: 'admin', updatedAt: new Date() }]]);
}

// Root-level reset: the per-describe beforeEach blocks reset getState/upsert but
// not seed. Re-apply the default echo-back implementation before every test so
// call history never leaks across tests and the default survives mockReset.
beforeEach(() => {
    mockSeed.mockReset();
    mockSeed.mockImplementation(async (_sql: unknown, state: SchedulerState) => state);
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSql(): postgres.Sql {
    return {} as postgres.Sql;
}

interface FakeClient {
    _store: Map<string, { value: string; expiresAt: number }>;
    customCommand: (cmd: string[]) => Promise<unknown>;
}

function makeFakeClient(): FakeClient {
    const store = new Map<string, { value: string; expiresAt: number }>();
    return {
        _store: store,
        customCommand: vi.fn(async (cmd: string[]) => {
            const [op, key, value, flag, , ttlStr] = cmd;
            if (op === 'SET' && flag === 'NX') {
                if (store.has(key)) {
                    const entry = store.get(key)!;
                    if (entry.expiresAt > Date.now()) return null;
                }
                const ttlMs = ttlStr ? Number(ttlStr) : 30_000;
                store.set(key, {
                    value: String(value),
                    expiresAt: Date.now() + ttlMs,
                });
                return 'OK';
            }
            return null;
        }),
    };
}

function makeTask(id: string, every: string, envOverride?: string, runOnStartup?: boolean) {
    return defineTask({
        id,
        name: id,
        version: '1.0.0',
        processingVersion: 1,
        minAppVersion: '1.0.0',
        capabilities: {},
        resourceClass: 'io' as const,
        inputSchema: z.object({}),
        identityFor: () => 'identity',
        schedule: {
            every,
            ...(envOverride ? { envOverride } : {}),
            ...(runOnStartup ? { runOnStartup: true } : {}),
        },
        execute: async () => ({ success: true }),
    });
}

function makeOrchestrator() {
    return {
        startRun: vi.fn<
            (taskId: string, input: unknown, opts?: StartRunOpts) => Promise<{ runId: string }>
        >(async () => ({ runId: 'run_test' })),
    };
}

// ── parseDurationMs ───────────────────────────────────────────────────────────

describe('parseDurationMs', () => {
    it('parses seconds', () => expect(parseDurationMs('30s')).toBe(30_000));
    it('parses minutes', () => expect(parseDurationMs('15m')).toBe(900_000));
    it('parses hours', () => expect(parseDurationMs('1h')).toBe(3_600_000));
    it('parses days', () => expect(parseDurationMs('7d')).toBe(604_800_000));
    it('parses weeks', () => expect(parseDurationMs('1w')).toBe(7 * 86_400_000));
    it('returns null for empty string', () => expect(parseDurationMs('')).toBeNull());
    it('returns null for invalid unit', () => expect(parseDurationMs('5x')).toBeNull());
    it('returns null for plain number', () => expect(parseDurationMs('100')).toBeNull());
    it('returns null for zero', () => expect(parseDurationMs('0m')).toBeNull());
    it('handles whitespace', () => expect(parseDurationMs(' 2h ')).toBe(7_200_000));

    // Compound forms — added when metadata-sync regression revealed the
    // single-token-only limitation (silent registration failure).
    it('parses compound h+m', () =>
        expect(parseDurationMs('3h45m')).toBe(3 * 3_600_000 + 45 * 60_000));
    it('parses compound d+h', () =>
        expect(parseDurationMs('1d12h')).toBe(86_400_000 + 12 * 3_600_000));
    it('parses compound w+d+h', () =>
        expect(parseDurationMs('1w2d3h')).toBe(7 * 86_400_000 + 2 * 86_400_000 + 3 * 3_600_000));
    it('parses compound with whitespace between tokens', () =>
        expect(parseDurationMs('3h 45m')).toBe(3 * 3_600_000 + 45 * 60_000));
    it('returns null on duplicate units (1h1h)', () => expect(parseDurationMs('1h1h')).toBeNull());
    it('returns null on fractional input', () => expect(parseDurationMs('3.5h')).toBeNull());
    it('returns null on trailing garbage', () => expect(parseDurationMs('3h abc')).toBeNull());
    it('returns null on negative-like form', () => expect(parseDurationMs('-1h')).toBeNull());
    it('returns null when all components are zero', () =>
        expect(parseDurationMs('0h0m')).toBeNull());
});

// ── Scheduler.tick() ──────────────────────────────────────────────────────────

describe('Scheduler.tick()', () => {
    let registry: TaskRegistry;
    let orch: ReturnType<typeof makeOrchestrator>;
    let client: FakeClient;
    let scheduler: Scheduler;

    beforeEach(() => {
        registry = new TaskRegistry();
        orch = makeOrchestrator();
        client = makeFakeClient();
        scheduler = new Scheduler(registry, orch, makeSql(), async () => client);
        mockGetState.mockReset();
        mockUpsert.mockReset();
        mockGetState.mockResolvedValue(null);
        mockUpsert.mockResolvedValue(undefined);
    });

    it('no-op when registry has no scheduled tasks', async () => {
        registry.registerTask(
            defineTask({
                id: 'unscheduled',
                name: 'unscheduled',
                version: '1.0.0',
                processingVersion: 1,
                minAppVersion: '1.0.0',
                capabilities: {},
                resourceClass: 'io' as const,
                inputSchema: z.object({}),
                identityFor: () => 'x',
                execute: async () => ({ success: true }),
            }),
        );
        await scheduler.tick();
        expect(orch.startRun).not.toHaveBeenCalled();
    });

    it('fires when nextFireAt is in the past and claim succeeds', async () => {
        registry.registerTask(makeTask('sync-tmdb', '1h'));
        const past = Date.now() - 10;
        mockGetState.mockResolvedValue({
            taskId: 'sync-tmdb',
            lastFiredAt: new Date(past - 3_600_000),
            nextFireAt: new Date(past),
            paused: false,
            pausedBy: null,
            pausedAt: null,
        });

        await scheduler.tick();

        expect(orch.startRun).toHaveBeenCalledOnce();
        expect(orch.startRun).toHaveBeenCalledWith(
            'sync-tmdb',
            {},
            // Skew-immune dedup key anchored on nextFireAt (shared DB state),
            // so two clock-skewed replicas collapse to one DB-deduped fire.
            {
                trigger: { kind: 'scheduled' },
                idempotencyKey: `sched:sync-tmdb:${past}`,
            },
        );
        expect(mockUpsert).toHaveBeenCalledOnce();
    });

    it('skips when task is paused', async () => {
        registry.registerTask(makeTask('sync-tmdb', '1h'));
        mockGetState.mockResolvedValue({
            taskId: 'sync-tmdb',
            lastFiredAt: new Date(Date.now() - 7_200_000),
            nextFireAt: new Date(Date.now() - 100),
            paused: true,
            pausedBy: 'admin',
            pausedAt: new Date(),
        });

        await scheduler.tick();
        expect(orch.startRun).not.toHaveBeenCalled();
    });

    it('skips when nextFireAt is in the future', async () => {
        registry.registerTask(makeTask('sync-tmdb', '1h'));
        mockGetState.mockResolvedValue({
            taskId: 'sync-tmdb',
            lastFiredAt: new Date(Date.now() - 1_000),
            nextFireAt: new Date(Date.now() + 3_600_000),
            paused: false,
            pausedBy: null,
            pausedAt: null,
        });

        await scheduler.tick();
        expect(orch.startRun).not.toHaveBeenCalled();
    });

    it('skips when claim fails (another replica wins)', async () => {
        registry.registerTask(makeTask('sync-tmdb', '1h'));
        mockGetState.mockResolvedValue({
            taskId: 'sync-tmdb',
            lastFiredAt: new Date(Date.now() - 7_200_000),
            nextFireAt: new Date(Date.now() - 100),
            paused: false,
            pausedBy: null,
            pausedAt: null,
        });

        // Simulate another replica having claimed the bucket.
        const now = Date.now();
        const interval = 3_600_000;
        const bucket = Math.floor(now / interval);
        client._store.set(`lock:scheduler:sync-tmdb:${bucket}`, {
            value: 'other-replica',
            expiresAt: now + 30_000,
        });

        await scheduler.tick();
        expect(orch.startRun).not.toHaveBeenCalled();
    });

    it('does NOT fire on the first tick when no state exists and not runOnStartup (seeds next boundary)', async () => {
        // Fresh-deploy guard: catchUpAtBoot skips a no-state non-runOnStartup task
        // to avoid every scheduled drain firing at once on a fresh install. The
        // tick must honour the same guard — previously the `?? now` default fired
        // it ~10s after boot anyway. Instead it seeds next_fire_at at the next
        // bucket boundary and waits.
        registry.registerTask(makeTask('embed-metadata', '24h'));
        mockGetState.mockResolvedValue(null);

        await scheduler.tick();

        expect(orch.startRun).not.toHaveBeenCalled();
        expect(mockUpsert).toHaveBeenCalledOnce();
        const seeded = mockUpsert.mock.calls[0][1] as {
            lastFiredAt: Date | null;
            nextFireAt: Date;
        };
        expect(seeded.lastFiredAt).toBeNull();
        expect(seeded.nextFireAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('fires on the first tick when no state exists and runOnStartup is true', async () => {
        registry.registerTask(makeTask('startup-task', '24h', undefined, true));
        mockGetState.mockResolvedValue(null);

        await scheduler.tick();

        expect(orch.startRun).toHaveBeenCalledOnce();
        // Pre-fire seed goes through seedSchedulerStateIfAbsent (INSERT ... ON
        // CONFLICT DO NOTHING + read-back) so clock-skewed replicas converge on
        // one shared anchor; the post-fire advance is the single upsert. Seeding
        // via insert-if-absent (not a blind upsert) is what makes the dedup key
        // skew-immune.
        const seed = mockSeed.mock.calls[0][1] as { lastFiredAt: Date | null };
        expect(seed.lastFiredAt).toBeNull();
        expect(mockSeed).toHaveBeenCalledOnce();
        expect(mockUpsert).toHaveBeenCalledOnce();
    });

    it('anchors the first runOnStartup tick fire on a bucket-aligned key (skew-immune)', async () => {
        registry.registerTask(makeTask('startup-task', '1h', undefined, true));
        mockGetState.mockResolvedValue(null);

        await scheduler.tick();

        const anchor = Math.floor(Date.now() / 3_600_000) * 3_600_000;
        expect(orch.startRun).toHaveBeenCalledWith(
            'startup-task',
            {},
            {
                trigger: { kind: 'scheduled' },
                idempotencyKey: `sched:startup-task:${anchor}`,
            },
        );
    });
});

// ── Scheduler.catchUpAtBoot() ─────────────────────────────────────────────────

describe('Scheduler.catchUpAtBoot()', () => {
    let registry: TaskRegistry;
    let orch: ReturnType<typeof makeOrchestrator>;
    let client: FakeClient;
    let scheduler: Scheduler;

    beforeEach(() => {
        registry = new TaskRegistry();
        orch = makeOrchestrator();
        client = makeFakeClient();
        scheduler = new Scheduler(registry, orch, makeSql(), async () => client);
        mockGetState.mockReset();
        mockUpsert.mockReset();
        mockGetState.mockResolvedValue(null);
        mockUpsert.mockResolvedValue(undefined);
    });

    it('fires once when last_fired_at is more than one interval ago', async () => {
        registry.registerTask(makeTask('daily-task', '24h'));
        const twoDaysAgo = Date.now() - 2 * 86_400_000;
        mockGetState.mockResolvedValue({
            taskId: 'daily-task',
            lastFiredAt: new Date(twoDaysAgo),
            nextFireAt: new Date(twoDaysAgo + 86_400_000),
            paused: false,
            pausedBy: null,
            pausedAt: null,
        });

        await scheduler.catchUpAtBoot();

        // Must fire exactly once, not twice (two missed intervals).
        expect(orch.startRun).toHaveBeenCalledOnce();
        expect(mockUpsert).toHaveBeenCalledOnce();
    });

    it('anchors the catch-up idempotency key on the missed scheduled fire time (matches the tick key)', async () => {
        // Crash-safety: fire-before-state ordering means a crash between this
        // startRun and the upsert leaves next_fire_at un-advanced. A later tick
        // re-fires the same cycle with key `sched:<id>:<nextFireAt>`; the
        // catch-up key MUST match so the DB dedup collapses the re-fire onto
        // the in-flight run instead of starting a duplicate.
        registry.registerTask(makeTask('daily-task', '24h'));
        const twoDaysAgo = Date.now() - 2 * 86_400_000;
        const missedNextFire = twoDaysAgo + 86_400_000;
        mockGetState.mockResolvedValue({
            taskId: 'daily-task',
            lastFiredAt: new Date(twoDaysAgo),
            nextFireAt: new Date(missedNextFire),
            paused: false,
            pausedBy: null,
            pausedAt: null,
        });

        await scheduler.catchUpAtBoot();

        expect(orch.startRun).toHaveBeenCalledWith(
            'daily-task',
            {},
            {
                trigger: { kind: 'scheduled' },
                idempotencyKey: `sched:daily-task:${missedNextFire}`,
            },
        );
    });

    it('first-ever runOnStartup catch-up (no state row) seeds a bucket-aligned anchor key', async () => {
        // No state row → seed one first (bucket-aligned nextFireAt) so the
        // catch-up key anchors on shared state instead of a per-replica bucket
        // fallback. This is the skew-immune first-fire dedup: two replicas
        // booting together compute the same anchor and the DB dedups the dup.
        registry.registerTask(makeTask('fresh-task', '1h', undefined, true));
        mockGetState.mockResolvedValue(null);

        await scheduler.catchUpAtBoot();

        const anchor = Math.floor(Date.now() / 3_600_000) * 3_600_000;
        // Row is seeded before the fire (lastFiredAt null) via the insert-if-
        // absent convergence primitive, then advanced by the post-fire upsert.
        const seed = mockSeed.mock.calls[0][1] as {
            lastFiredAt: Date | null;
            nextFireAt: Date;
        };
        expect(seed.lastFiredAt).toBeNull();
        expect(seed.nextFireAt.getTime()).toBe(anchor);
        expect(orch.startRun).toHaveBeenCalledWith(
            'fresh-task',
            {},
            {
                trigger: { kind: 'scheduled' },
                idempotencyKey: `sched:fresh-task:${anchor}`,
            },
        );
    });

    it('does not fire when within the interval window', async () => {
        registry.registerTask(makeTask('daily-task', '24h'));
        const thirtyMinutesAgo = Date.now() - 30 * 60_000;
        mockGetState.mockResolvedValue({
            taskId: 'daily-task',
            lastFiredAt: new Date(thirtyMinutesAgo),
            nextFireAt: new Date(thirtyMinutesAgo + 86_400_000),
            paused: false,
            pausedBy: null,
            pausedAt: null,
        });

        await scheduler.catchUpAtBoot();
        expect(orch.startRun).not.toHaveBeenCalled();
    });

    it('does not fire when task is paused', async () => {
        registry.registerTask(makeTask('daily-task', '24h'));
        mockGetState.mockResolvedValue({
            taskId: 'daily-task',
            lastFiredAt: new Date(Date.now() - 2 * 86_400_000),
            nextFireAt: new Date(Date.now() - 86_400_000),
            paused: true,
            pausedBy: 'admin',
            pausedAt: new Date(),
        });

        await scheduler.catchUpAtBoot();
        expect(orch.startRun).not.toHaveBeenCalled();
    });

    it('does not fire catch-up when another replica wins the claim', async () => {
        registry.registerTask(makeTask('daily-task', '24h'));
        mockGetState.mockResolvedValue({
            taskId: 'daily-task',
            lastFiredAt: new Date(Date.now() - 2 * 86_400_000),
            nextFireAt: new Date(Date.now() - 86_400_000),
            paused: false,
            pausedBy: null,
            pausedAt: null,
        });

        // Simulate the current bucket already being claimed (whether by the
        // regular tick on a peer or by another catch-up — both share the key).
        const now = Date.now();
        const interval = 86_400_000;
        const bucket = Math.floor(now / interval);
        client._store.set(`lock:scheduler:daily-task:${bucket}`, {
            value: 'other-replica',
            expiresAt: now + 30_000,
        });

        await scheduler.catchUpAtBoot();
        expect(orch.startRun).not.toHaveBeenCalled();
    });

    it('uses same bucket key as tick so catch-up and tick cannot double-fire', async () => {
        // runOnStartup: true so the no-state catch-up actually fires — the
        // bucket-sharing invariant being tested is orthogonal to whether the
        // task opts in to first-boot firing.
        registry.registerTask(makeTask('fresh-task', '1h', undefined, true));
        mockGetState.mockResolvedValue(null);

        await scheduler.catchUpAtBoot();
        expect(orch.startRun).toHaveBeenCalledOnce();

        // The same bucket key should now be held — a subsequent tick must NOT
        // fire again.
        await scheduler.tick();
        expect(orch.startRun).toHaveBeenCalledOnce();
    });

    it('fires when no state exists (never fired before) and runOnStartup is true', async () => {
        registry.registerTask(makeTask('fresh-task', '1h', undefined, true));
        mockGetState.mockResolvedValue(null);

        await scheduler.catchUpAtBoot();
        expect(orch.startRun).toHaveBeenCalledOnce();
    });

    it('does NOT fire when no state exists and runOnStartup is unset', async () => {
        registry.registerTask(makeTask('fresh-task', '1h'));
        mockGetState.mockResolvedValue(null);

        await scheduler.catchUpAtBoot();
        // Without runOnStartup: true a fresh-DB task waits for the steady-
        // state tick loop to pick it up at the next bucket boundary, instead
        // of mass-firing every scheduled task on first boot.
        expect(orch.startRun).not.toHaveBeenCalled();
    });
});

// ── First-fire skew convergence (runOnStartup, no prior state) ────────────────
//
// Two clock-skewed replicas booting together, with `now` values that straddle a
// bucket boundary, compute DIFFERENT local anchors. The bug: each blindly
// upserts and fires on its OWN anchor, producing DIFFERENT `sched:<id>:<anchor>`
// idempotency keys the DB partial-unique index cannot collapse → a double-fire.
//
// The fix: seed via INSERT ... ON CONFLICT DO NOTHING, then RE-READ, so both
// replicas converge on the ONE persisted anchor (whichever insert won) and build
// an identical key. This suite proves both replicas emit the SAME key even when
// their local anchors differ.

describe('Scheduler first-fire skew convergence', () => {
    let dateNow: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        mockGetState.mockReset();
        mockUpsert.mockReset();
        // Both replicas read no state before either commits — the exact
        // concurrent-boot race that used to double-fire.
        mockGetState.mockResolvedValue(null);
        mockUpsert.mockResolvedValue(undefined);
    });

    afterEach(() => {
        dateNow?.mockRestore();
    });

    it('two divergent `now` values straddling a bucket boundary converge on one idempotency key', async () => {
        const interval = 3_600_000; // '1h'
        const boundary = 100 * interval;

        // Shared "DB row" backing the seed: first INSERT wins and persists; a
        // later INSERT conflicts and reads back the persisted (winning) anchor.
        let storedRow: SchedulerState | null = null;
        mockSeed.mockImplementation(async (_sql: unknown, state: SchedulerState) => {
            if (storedRow) return storedRow; // ON CONFLICT DO NOTHING → read-back
            storedRow = state; // insert landed
            return state;
        });

        // Replica B (clock behind): now just before the boundary → local anchor
        // is the PREVIOUS bucket. It boots first and wins the insert.
        const orchB = makeOrchestrator();
        const registryB = new TaskRegistry();
        registryB.registerTask(makeTask('skew-task', '1h', undefined, true));
        const schedulerB = new Scheduler(registryB, orchB, makeSql(), async () => makeFakeClient());

        // Replica A (clock ahead): now just past the boundary → local anchor is
        // the CURRENT bucket. It boots second and its insert conflicts.
        const orchA = makeOrchestrator();
        const registryA = new TaskRegistry();
        registryA.registerTask(makeTask('skew-task', '1h', undefined, true));
        const schedulerA = new Scheduler(registryA, orchA, makeSql(), async () => makeFakeClient());

        dateNow = vi.spyOn(Date, 'now');

        dateNow.mockReturnValue(boundary - 1); // B: previous bucket
        await schedulerB.tick();

        dateNow.mockReturnValue(boundary + 1); // A: current bucket
        await schedulerA.tick();

        // Both replicas fired (both anchors <= their own `now`)…
        expect(orchB.startRun).toHaveBeenCalledOnce();
        expect(orchA.startRun).toHaveBeenCalledOnce();

        const keyB = (orchB.startRun.mock.calls[0]![2] as { idempotencyKey: string })
            .idempotencyKey;
        const keyA = (orchA.startRun.mock.calls[0]![2] as { idempotencyKey: string })
            .idempotencyKey;

        // …on the SINGLE persisted anchor (B's winning previous-bucket anchor),
        // NOT their divergent local anchors — so the DB dedups to one run.
        expect(keyB).toBe(`sched:skew-task:${boundary - interval}`);
        expect(keyA).toBe(keyB);
    });
});

// ── F2: fire-before-state ordering (no silent cycle loss on throw) ────────────
//
// Regression suite for the ordering contract. The scheduler MUST call
// orchestrator.startRun BEFORE upsertSchedulerState, and advance next_fire_at
// only after startRun returns. startRun throws on backpressure / circuit-open
// / quota — all normal conditions that enqueue nothing — so a throw must leave
// next_fire_at unadvanced and let the next tick retry, rather than burning the
// cycle while last_fired_at marches forward. Crash double-fires (a crash
// between claim and startRun) are instead prevented by the nextFireAt-anchored
// idempotency key, which DB-dedups a re-fire onto the in-flight run.

describe('Scheduler F2: fire-before-state ordering', () => {
    let registry: TaskRegistry;
    let orch: ReturnType<typeof makeOrchestrator>;
    let client: FakeClient;
    let scheduler: Scheduler;

    beforeEach(() => {
        registry = new TaskRegistry();
        orch = makeOrchestrator();
        client = makeFakeClient();
        scheduler = new Scheduler(registry, orch, makeSql(), async () => client);
        mockGetState.mockReset();
        mockUpsert.mockReset();
        mockGetState.mockResolvedValue(null);
        mockUpsert.mockResolvedValue(undefined);
    });

    it('maybeFireTask: orchestrator.startRun is invoked BEFORE upsertSchedulerState', async () => {
        registry.registerTask(makeTask('sync-tmdb', '1h'));
        mockGetState.mockResolvedValue({
            taskId: 'sync-tmdb',
            lastFiredAt: new Date(Date.now() - 7_200_000),
            nextFireAt: new Date(Date.now() - 100),
            paused: false,
            pausedBy: null,
            pausedAt: null,
        });

        const callOrder: string[] = [];
        mockUpsert.mockImplementationOnce(async () => {
            callOrder.push('upsert');
        });
        orch.startRun.mockImplementationOnce(async () => {
            callOrder.push('startRun');
            return { runId: 'run_test' };
        });

        await scheduler.tick();

        expect(callOrder).toEqual(['startRun', 'upsert']);
    });

    it('catchUpAtBoot fireCatchUp: startRun is invoked BEFORE upsertSchedulerState', async () => {
        registry.registerTask(makeTask('daily-task', '24h'));
        const twoDaysAgo = Date.now() - 2 * 86_400_000;
        mockGetState.mockResolvedValue({
            taskId: 'daily-task',
            lastFiredAt: new Date(twoDaysAgo),
            nextFireAt: new Date(twoDaysAgo + 86_400_000),
            paused: false,
            pausedBy: null,
            pausedAt: null,
        });

        const callOrder: string[] = [];
        mockUpsert.mockImplementationOnce(async () => {
            callOrder.push('upsert');
        });
        orch.startRun.mockImplementationOnce(async () => {
            callOrder.push('startRun');
            return { runId: 'run_test' };
        });

        await scheduler.catchUpAtBoot();

        expect(callOrder).toEqual(['startRun', 'upsert']);
    });

    it('startRun failure leaves next_fire_at unadvanced so the next tick retries the cycle', async () => {
        // Fire-before-state contract: startRun throws on backpressure /
        // circuit-open / quota — none of which enqueue a run — so the upsert
        // must NOT happen and the cycle must be retried, not burned.
        registry.registerTask(makeTask('sync-tmdb', '1h'));

        const past = Date.now() - 100;
        const interval = 3_600_000;
        const stateBefore = {
            taskId: 'sync-tmdb',
            lastFiredAt: new Date(past - interval),
            nextFireAt: new Date(past),
            paused: false,
            pausedBy: null as string | null,
            pausedAt: null as Date | null,
        };
        mockGetState.mockResolvedValue(stateBefore);

        // First tick: startRun throws (e.g. BackpressureError). The upsert
        // must NOT run, so next_fire_at stays in the past.
        orch.startRun.mockRejectedValueOnce(new Error('backpressure drop'));

        await scheduler.tick();

        expect(orch.startRun).toHaveBeenCalledOnce();
        expect(mockUpsert).not.toHaveBeenCalled();

        // Clear the Valkey bucket lock to simulate its TTL elapsing. State is
        // still un-advanced (mockGetState persistently returns stateBefore), so
        // the next tick re-fires; this time backpressure has cleared and the
        // cycle both fires and advances.
        for (const key of Array.from(client._store.keys())) {
            if (key.startsWith('lock:scheduler:sync-tmdb:')) client._store.delete(key);
        }
        orch.startRun.mockClear();

        await scheduler.tick();
        expect(orch.startRun).toHaveBeenCalledOnce();
        expect(mockUpsert).toHaveBeenCalledOnce();
    });

    it('crash-between-fires: another replica seeing the same bucket cannot re-fire it', async () => {
        // Replica A fires: startRun is invoked, then the upsert advances
        // next_fire_at, then A "crashes" (we stop the test flow). Replica B's
        // scheduler ticks within the same bucket window — it must NOT re-fire.
        //
        // The defence is twofold once A's tick has fully completed:
        //   1. The Valkey bucket lock is still held (TTL ≈ interval).
        //   2. scheduler_state.nextFireAt was advanced to (now + interval).
        // Either alone is sufficient; both together are belt-and-braces.
        // (If A had crashed BETWEEN startRun and the upsert, next_fire_at would
        // stay put and the nextFireAt-anchored idempotency key would DB-dedup
        // B's re-fire onto A's in-flight run instead.)

        registry.registerTask(makeTask('sync-tmdb', '1h'));
        const past = Date.now() - 100;
        const interval = 3_600_000;
        mockGetState.mockResolvedValueOnce({
            taskId: 'sync-tmdb',
            lastFiredAt: new Date(past - interval),
            nextFireAt: new Date(past),
            paused: false,
            pausedBy: null,
            pausedAt: null,
        });

        // Capture what A wrote.
        let advancedState: {
            lastFiredAt: Date | null;
            nextFireAt: Date;
        } | null = null;
        mockUpsert.mockImplementationOnce(async (_sql, args) => {
            advancedState = {
                lastFiredAt: args.lastFiredAt,
                nextFireAt: args.nextFireAt,
            };
        });

        // Replica A's tick — fires successfully, then "crashes" (we just
        // stop the test flow after the await).
        await scheduler.tick();
        expect(orch.startRun).toHaveBeenCalledOnce();
        expect(advancedState).not.toBeNull();

        // Replica B uses its OWN scheduler instance (separate process model)
        // but SHARES the Valkey store and the scheduler_state row.
        const orchB = makeOrchestrator();
        const schedulerB = new Scheduler(registry, orchB, makeSql(), async () => client);

        // B's view of scheduler_state is the row A just wrote.
        mockGetState.mockResolvedValueOnce({
            taskId: 'sync-tmdb',
            lastFiredAt: advancedState!.lastFiredAt,
            nextFireAt: advancedState!.nextFireAt,
            paused: false,
            pausedBy: null,
            pausedAt: null,
        });

        await schedulerB.tick();

        // B saw nextFireAt in the future and skipped — no startRun, no upsert.
        expect(orchB.startRun).not.toHaveBeenCalled();
    });

    it('upsert-throws path leaves next_fire_at unadvanced and recoverable on next interval', async () => {
        // Fire-before-state order: startRun fires FIRST (succeeds), then the
        // upsert throws (transient DB blip). next_fire_at never lands, so the
        // next tick (once the bucket lock TTL elapses) re-fires. In production
        // the nextFireAt-anchored idempotency key collapses that re-fire onto
        // the still-in-flight run; here we just prove the scheduler stays live
        // and re-attempts rather than wedging.
        registry.registerTask(makeTask('sync-tmdb', '1h'));
        const past = Date.now() - 100;
        const stateBefore = {
            taskId: 'sync-tmdb',
            lastFiredAt: new Date(past - 3_600_000),
            nextFireAt: new Date(past),
            paused: false,
            pausedBy: null as string | null,
            pausedAt: null as Date | null,
        };
        mockGetState.mockResolvedValue(stateBefore);

        // First tick: startRun fires, then the upsert throws.
        mockUpsert.mockRejectedValueOnce(new Error('db unreachable'));
        await scheduler.tick();
        expect(orch.startRun).toHaveBeenCalledOnce();
        expect(mockUpsert).toHaveBeenCalledOnce();

        // Simulate Valkey bucket TTL expiry by clearing the lock key.
        for (const key of Array.from(client._store.keys())) {
            if (key.startsWith('lock:scheduler:sync-tmdb:')) client._store.delete(key);
        }
        orch.startRun.mockClear();
        mockUpsert.mockClear();

        // Second tick: getSchedulerState still returns the pre-fire state
        // (the upsert never landed). Both startRun and upsert fire now.
        await scheduler.tick();
        expect(orch.startRun).toHaveBeenCalledOnce();
        expect(mockUpsert).toHaveBeenCalledOnce();
    });

    it('crash-between-fires: even if state row were not yet visible, Valkey bucket lock blocks re-fire', async () => {
        // Pathological case: imagine A's upsert had not yet propagated to B's
        // read replica — defence-in-depth: the per-bucket lock in Valkey blocks
        // B regardless of what B's stale scheduler_state view shows.
        registry.registerTask(makeTask('sync-tmdb', '1h'));
        const past = Date.now() - 100;

        mockGetState.mockResolvedValueOnce({
            taskId: 'sync-tmdb',
            lastFiredAt: new Date(past - 3_600_000),
            nextFireAt: new Date(past),
            paused: false,
            pausedBy: null,
            pausedAt: null,
        });

        await scheduler.tick();
        expect(orch.startRun).toHaveBeenCalledOnce();

        // Replica B — assume B's DB view is STALE and still shows the old
        // state (next_fire_at in the past). Even so, the Valkey lock for the
        // current bucket is held by A.
        const orchB = makeOrchestrator();
        const schedulerB = new Scheduler(registry, orchB, makeSql(), async () => client);
        mockGetState.mockResolvedValueOnce({
            taskId: 'sync-tmdb',
            lastFiredAt: new Date(past - 3_600_000),
            nextFireAt: new Date(past), // STALE: pre-fire view
            paused: false,
            pausedBy: null,
            pausedAt: null,
        });

        await schedulerB.tick();

        // B tried the claim, lost, skipped — no startRun.
        expect(orchB.startRun).not.toHaveBeenCalled();
    });
});

// ── envOverride ───────────────────────────────────────────────────────────────

describe('Scheduler envOverride', () => {
    let registry: TaskRegistry;
    let orch: ReturnType<typeof makeOrchestrator>;
    let client: FakeClient;
    let scheduler: Scheduler;

    beforeEach(() => {
        registry = new TaskRegistry();
        orch = makeOrchestrator();
        client = makeFakeClient();
        scheduler = new Scheduler(registry, orch, makeSql(), async () => client);
        mockGetState.mockReset();
        mockUpsert.mockReset();
        mockGetState.mockResolvedValue(null);
        mockUpsert.mockResolvedValue(undefined);
    });

    afterEach(() => {
        delete process.env.SYNC_TMDB_METADATA_INTERVAL;
    });

    it('uses task every when env var is not set', async () => {
        registry.registerTask(makeTask('sync-tmdb', '1h', 'SYNC_TMDB_METADATA_INTERVAL'));
        // No env var — interval resolves to the task's 1h. A past-due state row
        // forces the fire (a no-state task no longer fires on its first tick).
        mockGetState.mockResolvedValue({
            taskId: 'sync-tmdb',
            lastFiredAt: new Date(Date.now() - 7_200_000),
            nextFireAt: new Date(Date.now() - 1),
            paused: false,
            pausedBy: null,
            pausedAt: null,
        });
        await scheduler.tick();
        expect(orch.startRun).toHaveBeenCalledOnce();
        // Post-fire next_fire_at advanced by the resolved 1h interval.
        const advanced = mockUpsert.mock.calls[0][1] as { nextFireAt: Date };
        expect(advanced.nextFireAt.getTime() - Date.now()).toBeGreaterThan(3_500_000);
    });

    it('env var overrides task every for bucket computation', async () => {
        // Task says 1h but env says 30m.
        process.env.SYNC_TMDB_METADATA_INTERVAL = '30m';
        registry.registerTask(makeTask('sync-tmdb', '1h', 'SYNC_TMDB_METADATA_INTERVAL'));

        const state = {
            taskId: 'sync-tmdb',
            lastFiredAt: new Date(Date.now() - 7_200_000),
            nextFireAt: new Date(Date.now() - 100),
            paused: false,
            pausedBy: null as string | null,
            pausedAt: null as Date | null,
        };
        mockGetState.mockResolvedValue(state);

        await scheduler.tick();
        expect(orch.startRun).toHaveBeenCalledOnce();

        // Bucket is floor(now / 30min), not floor(now / 1h).
        const now = Date.now();
        const interval30m = 30 * 60_000;
        const expectedBucket = Math.floor(now / interval30m);
        const calledKey = (client.customCommand as ReturnType<typeof vi.fn>).mock.calls.find(
            (call: string[][]) => call[0][0] === 'SET',
        )?.[0];
        if (calledKey) {
            expect(calledKey[1]).toContain(String(expectedBucket));
        }
    });
});

// ── Scheduler operator triggers (admin UI PUT/DELETE .../triggers) ─────────────────

describe('Scheduler operator triggers (spec 2026-09-27 Part 2)', () => {
    let registry: TaskRegistry;
    let orch: ReturnType<typeof makeOrchestrator>;
    let client: FakeClient;
    let scheduler: Scheduler;

    const dueState = (taskId: string, overrides: Partial<SchedulerState> = {}): SchedulerState => ({
        taskId,
        lastFiredAt: new Date(Date.now() - 7_200_000),
        nextFireAt: new Date(Date.now() - 100),
        paused: false,
        pausedBy: null,
        pausedAt: null,
        ...overrides,
    });

    beforeEach(() => {
        registry = new TaskRegistry();
        orch = makeOrchestrator();
        client = makeFakeClient();
        scheduler = new Scheduler(registry, orch, makeSql(), async () => client);
        mockGetState.mockReset();
        mockUpsert.mockReset();
        mockListTriggers.mockReset();
        mockSetNext.mockReset();
        mockGetState.mockResolvedValue(null);
        mockUpsert.mockResolvedValue(undefined);
        mockListTriggers.mockResolvedValue(new Map());
    });

    it('an interval trigger takes precedence over the declared every', async () => {
        registry.registerTask(makeTask('library-scan', '1h'));
        mockListTriggers.mockResolvedValue(
            triggersFor('library-scan', [{ kind: 'interval', every: '6h' }]),
        );
        mockGetState.mockResolvedValue(dueState('library-scan'));

        await scheduler.tick();
        expect(orch.startRun).toHaveBeenCalledOnce();
        const advanced = mockUpsert.mock.calls[0][1] as { nextFireAt: Date };
        expect(advanced.nextFireAt.getTime() - Date.now()).toBeGreaterThan(6 * 3_600_000 - 5_000);
    });

    it('a trigger takes precedence over envOverride', async () => {
        process.env.SYNC_TMDB_METADATA_INTERVAL = '30m';
        registry.registerTask(makeTask('sync-tmdb', '1h', 'SYNC_TMDB_METADATA_INTERVAL'));
        mockListTriggers.mockResolvedValue(
            triggersFor('sync-tmdb', [{ kind: 'interval', every: '24h' }]),
        );
        mockGetState.mockResolvedValue(dueState('sync-tmdb'));

        await scheduler.tick();
        expect(orch.startRun).toHaveBeenCalledOnce();
        const advanced = mockUpsert.mock.calls[0][1] as { nextFireAt: Date };
        expect(advanced.nextFireAt.getTime() - Date.now()).toBeGreaterThan(24 * 3_600_000 - 5_000);
        delete process.env.SYNC_TMDB_METADATA_INTERVAL;
    });

    it('a due daily trigger fires and schedules its next occurrence within a day', async () => {
        registry.registerTask(makeTask('library-scan', '1h'));
        mockListTriggers.mockResolvedValue(
            triggersFor('library-scan', [{ kind: 'daily', at: '03:00' }]),
        );
        const state = dueState('library-scan');
        mockGetState.mockResolvedValue(state);

        await scheduler.tick();
        expect(orch.startRun).toHaveBeenCalledWith(
            'library-scan',
            {},
            expect.objectContaining({
                idempotencyKey: `sched:library-scan:${state.nextFireAt.getTime()}`,
            }),
        );
        const next = (mockUpsert.mock.calls[0][1] as { nextFireAt: Date }).nextFireAt;
        expect(next.getTime()).toBeGreaterThan(Date.now());
        expect(next.getTime() - Date.now()).toBeLessThanOrEqual(25 * 3_600_000);
        expect(next.getHours()).toBe(3);
    });

    it('a startup-only task never fires on a tick', async () => {
        registry.registerTask(makeTask('library-scan', '1h'));
        mockListTriggers.mockResolvedValue(triggersFor('library-scan', [{ kind: 'startup' }]));
        mockGetState.mockResolvedValue(dueState('library-scan'));

        await scheduler.tick();
        expect(orch.startRun).not.toHaveBeenCalled();
    });

    it('a paused task with triggers does not fire', async () => {
        registry.registerTask(makeTask('library-scan', '1h'));
        mockListTriggers.mockResolvedValue(
            triggersFor('library-scan', [{ kind: 'interval', every: '6h' }]),
        );
        mockGetState.mockResolvedValue(dueState('library-scan', { paused: true }));

        await scheduler.tick();
        expect(orch.startRun).not.toHaveBeenCalled();
    });

    it('falls back to the declared every when the trigger lookup throws', async () => {
        registry.registerTask(makeTask('library-scan', '1h'));
        mockListTriggers.mockRejectedValue(new Error('db unavailable'));
        mockGetState.mockResolvedValue(dueState('library-scan'));

        await scheduler.tick();
        expect(orch.startRun).toHaveBeenCalledOnce();
        const advanced = mockUpsert.mock.calls[0][1] as { nextFireAt: Date };
        expect(advanced.nextFireAt.getTime() - Date.now()).toBeGreaterThan(3_500_000);
        expect(advanced.nextFireAt.getTime() - Date.now()).toBeLessThan(2 * 3_600_000);
    });

    it('at boot, a daily time missed while down is skipped, not fired late', async () => {
        registry.registerTask(makeTask('library-scan', '1h'));
        mockListTriggers.mockResolvedValue(
            triggersFor('library-scan', [{ kind: 'daily', at: '03:00' }]),
        );
        // Last fired two days ago; its next_fire_at is long past.
        mockGetState.mockResolvedValue(
            dueState('library-scan', {
                lastFiredAt: new Date(Date.now() - 2 * 86_400_000),
                nextFireAt: new Date(Date.now() - 86_400_000),
            }),
        );

        await scheduler.catchUpAtBoot();
        expect(orch.startRun).not.toHaveBeenCalled();
        const [, , next] = mockSetNext.mock.calls[0] as [unknown, string, Date];
        expect(next.getTime()).toBeGreaterThan(Date.now());
    });

    it('at boot, an On startup trigger fires once, even with two replicas', async () => {
        registry.registerTask(makeTask('library-scan', '1h'));
        mockListTriggers.mockResolvedValue(
            triggersFor('library-scan', [{ kind: 'startup' }, { kind: 'daily', at: '03:00' }]),
        );
        mockGetState.mockResolvedValue(dueState('library-scan'));

        await scheduler.catchUpAtBoot();
        const second = new Scheduler(registry, orch, makeSql(), async () => client);
        await second.catchUpAtBoot();
        expect(orch.startRun).toHaveBeenCalledOnce();
        expect(orch.startRun).toHaveBeenCalledWith(
            'library-scan',
            {},
            expect.objectContaining({ idempotencyKey: expect.stringMatching(/:startup:/) }),
        );
    });
});

// ── Scheduler dynamicSchedule path ────────────────────────────────────────────

describe('Scheduler.tick() — dynamicSchedule', () => {
    let registry: TaskRegistry;
    let orch: ReturnType<typeof makeOrchestrator>;
    let client: FakeClient;
    let scheduler: Scheduler;

    beforeEach(() => {
        vi.resetAllMocks();
        registry = new TaskRegistry();
        orch = makeOrchestrator();
        client = makeFakeClient();
        scheduler = new Scheduler(registry, orch, makeSql(), async () => client);
    });

    afterEach(async () => {
        await scheduler.stop();
    });

    function makeDynTask(
        id: string,
        loader: () => Promise<Array<{ rowId: string; bucket: string; input: unknown }>>,
        sweepEvery = '5m',
    ) {
        return defineTask({
            id,
            name: id,
            version: '1.0.0',
            processingVersion: 1,
            minAppVersion: '1.0.0',
            capabilities: {},
            resourceClass: 'io' as const,
            inputSchema: z.object({}).passthrough(),
            identityFor: () => 'identity',
            dynamicSchedule: {
                loader,
                sweepEvery,
            },
            execute: async () => ({ success: true }),
        });
    }

    it('fires once per due row returned by loader', async () => {
        const loader = vi.fn(async () => [
            { rowId: 'src-a', bucket: '100', input: { sourceId: 'src-a' } },
            { rowId: 'src-b', bucket: '100', input: { sourceId: 'src-b' } },
        ]);
        registry.registerTask(makeDynTask('refresh-things', loader));

        await scheduler.tick();

        expect(loader).toHaveBeenCalledOnce();
        expect(orch.startRun).toHaveBeenCalledTimes(2);
        expect(orch.startRun).toHaveBeenCalledWith(
            'refresh-things',
            { sourceId: 'src-a' },
            expect.objectContaining({
                idempotencyKey: 'dyn-sched:refresh-things:src-a:100',
            }),
        );
        expect(orch.startRun).toHaveBeenCalledWith(
            'refresh-things',
            { sourceId: 'src-b' },
            expect.objectContaining({
                idempotencyKey: 'dyn-sched:refresh-things:src-b:100',
            }),
        );
    });

    it('skips entirely when loader returns empty array', async () => {
        const loader = vi.fn(async () => []);
        registry.registerTask(makeDynTask('refresh-things', loader));

        await scheduler.tick();

        expect(loader).toHaveBeenCalledOnce();
        expect(orch.startRun).not.toHaveBeenCalled();
    });

    it('does NOT call loader twice when two replicas tick in the same bucket', async () => {
        // Sweep lock is per-bucket: lock:scheduler-dynamic:<taskId>:<bucket>.
        // The second replica should see the claim already held and skip.
        const loader = vi.fn(async () => [{ rowId: 'r1', bucket: '999', input: {} }]);
        registry.registerTask(makeDynTask('rep-test', loader, '5m'));

        await scheduler.tick();
        await scheduler.tick();

        expect(loader).toHaveBeenCalledOnce();
        expect(orch.startRun).toHaveBeenCalledOnce();
    });

    it('survives loader throwing — does not fire and does not crash tick', async () => {
        const loader = vi.fn(async () => {
            throw new Error('loader boom');
        });
        registry.registerTask(makeDynTask('boom-task', loader));

        await expect(scheduler.tick()).resolves.toBeUndefined();
        expect(orch.startRun).not.toHaveBeenCalled();
    });

    it('skips malformed loader entries (missing rowId or bucket)', async () => {
        const loader = vi.fn(async () => [
            { rowId: 'good', bucket: 'b1', input: {} },
            // missing rowId
            { bucket: 'b2', input: {} } as unknown as {
                rowId: string;
                bucket: string;
                input: unknown;
            },
            // missing bucket
            { rowId: 'r3', input: {} } as unknown as {
                rowId: string;
                bucket: string;
                input: unknown;
            },
        ]);
        registry.registerTask(makeDynTask('partial', loader));

        await scheduler.tick();

        expect(orch.startRun).toHaveBeenCalledTimes(1);
        expect(orch.startRun).toHaveBeenCalledWith(
            'partial',
            {},
            expect.objectContaining({
                idempotencyKey: 'dyn-sched:partial:good:b1',
            }),
        );
    });

    it('honours envOverride for sweepEvery', async () => {
        process.env.TEST_SWEEP_OVERRIDE = '1m';
        const loader = vi.fn(async () => []);
        const task = defineTask({
            id: 'env-override',
            name: 'env-override',
            version: '1.0.0',
            processingVersion: 1,
            minAppVersion: '1.0.0',
            capabilities: {},
            resourceClass: 'io' as const,
            inputSchema: z.object({}),
            identityFor: () => 'identity',
            dynamicSchedule: {
                loader,
                sweepEvery: '1h',
                envOverride: 'TEST_SWEEP_OVERRIDE',
            },
            execute: async () => ({ success: true }),
        });
        registry.registerTask(task);

        await scheduler.tick();

        expect(loader).toHaveBeenCalledOnce();
        // Bucket key should reflect the 1m override, not 1h:
        const calls = (client.customCommand as ReturnType<typeof vi.fn>).mock.calls;
        const setCall = calls.find((c: string[][]) => c[0][0] === 'SET');
        const key = setCall?.[0]?.[1] as string;
        const expectedBucket = Math.floor(Date.now() / 60_000);
        expect(key).toContain(String(expectedBucket));

        delete process.env.TEST_SWEEP_OVERRIDE;
    });
});

describe('unitForBareNumber', () => {
    it('gives a bare number the unit its setting name promises', async () => {
        const { unitForBareNumber } = await import('./scheduler.js');
        expect(unitForBareNumber('SYNC_CURATED_LISTS_HOURS', '6')).toBe('6h');
        expect(unitForBareNumber('X_MINUTES', '15')).toBe('15m');
        expect(unitForBareNumber('X_DAYS', '2')).toBe('2d');
        // Already a duration, or a name without a unit suffix: untouched.
        expect(unitForBareNumber('SYNC_CURATED_LISTS_HOURS', '90m')).toBe('90m');
        expect(unitForBareNumber('SYNC_METADATA_INTERVAL', '6')).toBe('6');
    });
});

// ── Upgrade suspension never burns a claim ────────────────────────────────────

describe('Scheduler upgrade suspension', () => {
    let registry: TaskRegistry;
    let orch: ReturnType<typeof makeOrchestrator>;
    let client: FakeClient;
    let scheduler: Scheduler;

    function dueState(taskId: string): SchedulerState {
        const past = Date.now() - 10;
        return {
            taskId,
            lastFiredAt: new Date(past - 3_600_000),
            nextFireAt: new Date(past),
            paused: false,
            pausedBy: null,
            pausedAt: null,
        };
    }

    function claimKeys(): string[] {
        return [...client._store.keys()].filter((key) => key.startsWith('lock:scheduler:'));
    }

    beforeEach(() => {
        registry = new TaskRegistry();
        orch = makeOrchestrator();
        client = makeFakeClient();
        // Compare-and-delete used to hand back a claim won while suspended.
        const base = client.customCommand;
        client.customCommand = vi.fn(async (cmd: string[]) => {
            if (cmd[0] === 'EVAL') {
                const [, , , key, owner] = cmd;
                if (client._store.get(key)?.value !== owner) return 0;
                client._store.delete(key);
                return 1;
            }
            return base(cmd);
        });
        scheduler = new Scheduler(registry, orch, makeSql(), async () => client);
        mockGetState.mockReset();
        mockUpsert.mockReset();
        mockUpsert.mockResolvedValue(undefined);
        mockListTriggers.mockReset();
        mockListTriggers.mockResolvedValue(new Map());
        mockSetNext.mockReset();
    });

    function dynTask(
        id: string,
        loader: () => Promise<Array<{ rowId: string; bucket: string; input: unknown }>>,
    ) {
        return defineTask({
            id,
            name: id,
            version: '1.0.0',
            processingVersion: 1,
            minAppVersion: '1.0.0',
            capabilities: {},
            resourceClass: 'io' as const,
            inputSchema: z.object({}).passthrough(),
            identityFor: () => 'identity',
            dynamicSchedule: { loader, sweepEvery: '5m' },
            execute: async () => ({ success: true }),
        });
    }

    function sweepKeys(): string[] {
        return [...client._store.keys()].filter((key) =>
            key.startsWith('lock:scheduler-dynamic:'),
        );
    }

    const rows = [
        { rowId: 'a', bucket: '1', input: { id: 'a' } },
        { rowId: 'b', bucket: '1', input: { id: 'b' } },
    ];

    it('takes no claim when suspension starts mid-tick and fires once it lifts', async () => {
        registry.registerTask(makeTask('sync-tmdb', '1h'));
        let resume: (() => void) | undefined;
        mockGetState.mockImplementationOnce(async () => {
            resume = scheduler.suspendForUpgrade();
            return dueState('sync-tmdb');
        });
        mockGetState.mockResolvedValue(dueState('sync-tmdb'));

        await scheduler.tick();
        expect(orch.startRun).not.toHaveBeenCalled();
        expect(claimKeys()).toEqual([]);

        resume!();
        await scheduler.tick();
        expect(orch.startRun).toHaveBeenCalledOnce();
    });

    it('does not claim during a suspended boot catch-up; the next tick after resume fires', async () => {
        registry.registerTask(makeTask('sync-tmdb', '1h'));
        mockGetState.mockResolvedValue({
            ...dueState('sync-tmdb'),
            lastFiredAt: new Date(Date.now() - 3 * 3_600_000),
        });
        const resume = scheduler.suspendForUpgrade();

        await scheduler.catchUpAtBoot();
        expect(orch.startRun).not.toHaveBeenCalled();
        expect(claimKeys()).toEqual([]);

        resume();
        await scheduler.tick();
        expect(orch.startRun).toHaveBeenCalledOnce();
    });

    it('hands back a claim won while the gate closed during the SET', async () => {
        registry.registerTask(makeTask('sync-tmdb', '1h'));
        mockGetState.mockResolvedValue(dueState('sync-tmdb'));
        const withEval = client.customCommand;
        let resume: (() => void) | undefined;
        client.customCommand = vi.fn(async (cmd: string[]) => {
            const result = await withEval(cmd);
            if (cmd[0] === 'SET' && !resume) resume = scheduler.suspendForUpgrade();
            return result;
        });

        await scheduler.tick();
        expect(orch.startRun).not.toHaveBeenCalled();
        expect(claimKeys()).toEqual([]);

        resume!();
        await scheduler.tick();
        expect(orch.startRun).toHaveBeenCalledOnce();
    });
    it('dynamic sweep suspended before its first row: no fire, claim released, rows fire once after resume', async () => {
        let resume: (() => void) | undefined;
        const loader = vi.fn(async () => {
            resume ??= scheduler.suspendForUpgrade();
            return rows;
        });
        registry.registerTask(dynTask('refresh-dyn', loader));

        await scheduler.tick();
        expect(orch.startRun).not.toHaveBeenCalled();
        expect(sweepKeys()).toEqual([]);

        resume!();
        await scheduler.tick();
        expect(loader).toHaveBeenCalledTimes(2);
        expect(orch.startRun).toHaveBeenCalledTimes(2);
        expect(orch.startRun.mock.calls.map((call) => call[1])).toEqual([{ id: 'a' }, { id: 'b' }]);
    });

    it('dynamic sweep suspended after a row fired keeps its claim (no re-sweep double fire)', async () => {
        const loader = vi.fn(async () => rows);
        registry.registerTask(dynTask('refresh-dyn', loader));
        let resume: (() => void) | undefined;
        orch.startRun.mockImplementationOnce(async () => {
            resume = scheduler.suspendForUpgrade();
            return { runId: 'run_a' };
        });

        await scheduler.tick();
        expect(orch.startRun).toHaveBeenCalledTimes(1);
        expect(sweepKeys()).toHaveLength(1);

        resume!();
        await scheduler.tick();
        expect(loader).toHaveBeenCalledOnce();
        expect(orch.startRun).toHaveBeenCalledTimes(1);
    });

    it('startup trigger: a claim won while the gate closed is released and the startup run fires after resume', async () => {
        registry.registerTask(makeTask('library-scan', '1h'));
        mockListTriggers.mockResolvedValue(triggersFor('library-scan', [{ kind: 'startup' }]));
        mockGetState.mockResolvedValue(dueState('library-scan'));
        const withEval = client.customCommand;
        let resume: (() => void) | undefined;
        client.customCommand = vi.fn(async (cmd: string[]) => {
            const result = await withEval(cmd);
            if (cmd[0] === 'SET' && !resume) resume = scheduler.suspendForUpgrade();
            return result;
        });

        await scheduler.catchUpAtBoot();
        expect(orch.startRun).not.toHaveBeenCalled();
        expect(client._store.has('lock:scheduler:library-scan:startup')).toBe(false);

        resume!();
        await scheduler.catchUpAtBoot();
        expect(orch.startRun).toHaveBeenCalledOnce();
        expect(orch.startRun).toHaveBeenCalledWith(
            'library-scan',
            {},
            expect.objectContaining({ idempotencyKey: expect.stringMatching(/:startup:/) }),
        );
    });
});
