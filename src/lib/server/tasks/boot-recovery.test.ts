// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';
import { BootRecovery } from './boot-recovery.js';
import type { StateMachine } from './state-machine.js';
import type { TaskRegistry } from './registry.js';

// ── Module mocks ──────────────────────────────────────────────────────────────

// Since the valkey two-instance refactor (34cc76835), boot-recovery's
// `emitMeta` PUBLISHes through the module-level `publishMessage` (the cache
// client SSE subscribes to) instead of the injected coordination client. Capture
// those publishes here so the reclaim/pubsub assertions still observe them.
const publishedMeta = vi.hoisted(() => [] as Array<{ channel: string; message: string }>);
const publishMessageMock = vi.hoisted(() =>
    vi.fn(async (channel: string, message: string | Buffer) => {
        publishedMeta.push({ channel, message: String(message) });
        return 1;
    }),
);
vi.mock('$lib/server/cache/valkey.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/cache/valkey.js')>();
    return { ...actual, publishMessage: publishMessageMock };
});

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

// Spy on the Lua loader so the identity-key release path (release-identity) is
// observable. `load()` is a no-op; `invoke()` records calls.
const luaInvoke = vi.hoisted(() => vi.fn(async () => 1 as unknown));
vi.mock('./lua/loader.js', () => ({
    luaLoader: { invoke: luaInvoke, load: vi.fn(async () => {}) },
}));

// ── Stub helpers ──────────────────────────────────────────────────────────────

type CandidateRow = {
    id: string;
    task_id: string;
    state: 'active' | 'cancelling' | 'pending';
    owner_instance_id: string | null;
    input?: Record<string, unknown> | null;
    heartbeat_at?: Date | null;
};

/**
 * Build a minimal postgres.Sql-shaped mock that handles template-literal calls.
 * Each call receives the template strings array as args[0]. We match on the
 * concatenated template string to decide what to return.
 */
function buildSqlMock(candidates: CandidateRow[]): postgres.Sql {
    const tag = vi.fn((...args: unknown[]) => {
        const parts = args[0] as TemplateStringsArray | string[];
        const query = Array.from(parts).join('?');
        if (query.includes('task_history') && query.includes('SELECT')) {
            return Promise.resolve(candidates);
        }
        // markFailed's reclaim UPDATE uses `RETURNING id` and treats an empty
        // result as "already transitioned" (returns false). Simulate a matched
        // row so the reclaim path is exercised.
        if (
            query.includes('task_history') &&
            query.includes('UPDATE') &&
            query.includes('RETURNING')
        ) {
            return Promise.resolve([{ id: 'reclaimed' }]);
        }
        // Other UPDATEs / queries.
        return Promise.resolve([]);
    });

    // Attach .json helper used by BootRecovery for UPDATE.
    (tag as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;

    return tag as unknown as postgres.Sql;
}

function makeStateMachine(): Pick<StateMachine, 'transitionRun'> {
    return {
        transitionRun: vi.fn(async () => ({ ok: true as const })),
    };
}

interface FakeClient {
    _published: Array<{ channel: string; message: string }>;
    customCommand: ReturnType<typeof vi.fn>;
}

// ValkeyLike-compatible client stub
interface ValkeyLikeClient {
    customCommand: (cmd: string[]) => Promise<unknown>;
}

function makeClient(
    hashAliveOrOpts: boolean | { hashAlive?: boolean; glideBooleans?: boolean } = false,
): {
    client: FakeClient;
    getClient: () => Promise<ValkeyLikeClient>;
} {
    const opts =
        typeof hashAliveOrOpts === 'boolean'
            ? { hashAlive: hashAliveOrOpts, glideBooleans: false }
            : {
                  hashAlive: hashAliveOrOpts.hashAlive ?? false,
                  glideBooleans: hashAliveOrOpts.glideBooleans ?? false,
              };
    const published: Array<{ channel: string; message: string }> = [];

    const client: FakeClient = {
        _published: published,
        customCommand: vi.fn(async (cmd: string[]) => {
            const [op] = cmd;
            // valkeyHashAlive: HEXISTS task:run:active:<runId> state
            if (op === 'HEXISTS') {
                // The real valkey-glide client answers HEXISTS with a boolean.
                if (opts.glideBooleans) return opts.hashAlive;
                return opts.hashAlive ? 1 : 0;
            }
            if (op === 'PUBLISH') {
                published.push({
                    channel: String(cmd[1]),
                    message: String(cmd[2]),
                });
                return 1;
            }
            return null;
        }),
    };
    return { client, getClient: async () => client as ValkeyLikeClient };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('BootRecovery', () => {
    beforeEach(() => {
        // Reset the captured publishes between tests — the array is shared across
        // the whole file, so a stale entry would leak into the next assertion.
        publishedMeta.length = 0;
    });

    describe('no active runs', () => {
        it('returns empty report', async () => {
            const sql = buildSqlMock([]);
            const sm = makeStateMachine();
            const { getClient } = makeClient();

            const recovery = new BootRecovery(sql, sm, getClient, () => undefined);

            const report = await recovery.run();
            expect(report).toEqual({ inspected: 0, reclaimed: 0, runIds: [] });
            expect(sm.transitionRun).not.toHaveBeenCalled();
        });
    });

    describe('active run with Valkey hash present (signal 2)', () => {
        it('is not reclaimed', async () => {
            const candidates: CandidateRow[] = [
                {
                    id: 'run_hash',
                    task_id: 'sync-tmdb',
                    state: 'active',
                    owner_instance_id: null,
                },
            ];
            const sql = buildSqlMock(candidates);
            const sm = makeStateMachine();
            // hashAlive=true → HEXISTS returns 1
            const { getClient } = makeClient(true);

            const recovery = new BootRecovery(sql, sm, getClient, () => undefined);

            const report = await recovery.run();
            expect(report.reclaimed).toBe(0);
        });
    });

    describe('genuine orphan — no heartbeat, no Valkey hash', () => {
        it('is reclaimed as failed', async () => {
            const candidates: CandidateRow[] = [
                {
                    id: 'run_orphan',
                    task_id: 'sync-tmdb',
                    state: 'active',
                    owner_instance_id: null,
                },
            ];
            const sql = buildSqlMock(candidates);
            const sm = makeStateMachine();
            const { getClient } = makeClient(false);

            const recovery = new BootRecovery(sql, sm, getClient, () => undefined);

            const report = await recovery.run();
            expect(report.reclaimed).toBe(1);
            expect(report.runIds).toEqual(['run_orphan']);
            expect(report.inspected).toBe(1);

            // Emits to pubsub (via the cache-client publish seam).
            const pub = publishedMeta.find((p) => p.channel === 'task:events:meta');
            expect(pub).toBeDefined();
            const payload = JSON.parse(pub!.message) as {
                type: string;
                count: number;
            };
            expect(payload.type).toBe('recovery-reclaimed');
            expect(payload.count).toBe(1);
        });
    });

    // ── ZOMBIE: 2h-stale heartbeat with BullMQ job still parked 'active' ────────
    //
    // The prod incident: 3 stage-sweep runs sat 'active' for 1-2.5 hours. Their
    // BullMQ jobs were parked 'active' (no live worker polling the queue) and the
    // Valkey run hash had expired after >15 min. The old three-signal classifier
    // let Signal 1 ('alive' BullMQ state) short-circuit the reclaim even though
    // the per-run heartbeat was hours stale.
    //
    // Post-fix: Signal 1 is deleted. The hash check (Signal 2) is the sole
    // per-row guard. Hash absent + heartbeat stale → reclaim.
    describe('ZOMBIE: 2h-stale heartbeat with stuck BullMQ job IS reclaimed', () => {
        it('reclaims a zombie run whose heartbeat is 2h stale, hash absent, BullMQ job parked active', async () => {
            const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
            const candidates: CandidateRow[] = [
                {
                    id: 'run_zombie',
                    task_id: 'fake-task',
                    state: 'active',
                    owner_instance_id: 'web-1',
                    input: { mediaItemId: 'z' },
                    heartbeat_at: twoHoursAgo,
                },
            ];
            const sql = buildSqlMock(candidates);
            const sm = makeStateMachine();
            // Hash absent → HEXISTS returns 0.
            const { getClient } = makeClient({ hashAlive: false });

            // BullMQ queue has the job still parked 'active' — this is the exact
            // zombie scenario. With Signal 1 deleted, the queue is not consulted.
            // We pass a queue getter that would return an 'active' job to confirm
            // it is never called (Signal 1 is gone).
            const getJob = vi.fn(async (id: string) => ({
                id,
                data: { runId: 'run_zombie' },
                getState: vi.fn(async () => 'active'),
            }));
            const queue = {
                getJob,
                getActive: vi.fn(async () => []),
                getWaiting: vi.fn(async () => []),
                getDelayed: vi.fn(async () => []),
                getPrioritized: vi.fn(async () => []),
                getWaitingChildren: vi.fn(async () => []),
            };
            const fakeTask = {
                id: 'fake-task',
                identityFor: (i: { mediaItemId: string }) => `item-${i.mediaItemId}`,
            };
            const registryMock = {
                getTask: vi.fn((id: string) => (id === 'fake-task' ? fakeTask : undefined)),
                getAllTasks: () => [],
            } as unknown as TaskRegistry;

            const recovery = new BootRecovery(
                sql,
                sm,
                getClient,
                () => queue as unknown as import('bullmq').Queue,
                registryMock,
            );
            const report = await recovery.run();

            // The zombie IS reclaimed: pre-fix this was 0 (Signal-1 alive short-circuit).
            expect(report.reclaimed).toBe(1);
            expect(report.runIds).toEqual(['run_zombie']);
            // BullMQ queue was NOT consulted — Signal 1 is deleted.
            expect(getJob).not.toHaveBeenCalled();
        });
    });

    describe('F69 Signal-3 partition: fail closed when Valkey client is unavailable', () => {
        // A run that would be reclaimed under healthy Valkey (hash absent,
        // heartbeat stale) must NOT be reclaimed when getClient() throws —
        // a partition makes classification unsafe. Fail closed: skip the cycle,
        // reclaimed = 0 (even though rows were fetched from Postgres).
        it('does NOT reclaim any run when getClient() throws (Valkey partition)', async () => {
            const candidates: CandidateRow[] = [
                {
                    id: 'run_partition',
                    task_id: 'sync-tmdb',
                    state: 'active',
                    owner_instance_id: 'web-1',
                    input: null,
                    heartbeat_at: null,
                },
                {
                    id: 'run_partition_2',
                    task_id: 'sync-tmdb',
                    state: 'active',
                    owner_instance_id: 'web-2',
                    input: null,
                    heartbeat_at: null,
                },
                {
                    id: 'run_partition_3',
                    task_id: 'sync-tmdb',
                    state: 'active',
                    owner_instance_id: 'web-3',
                    input: null,
                    heartbeat_at: null,
                },
            ];
            const sql = buildSqlMock(candidates);
            const sm = makeStateMachine();
            // getClient() throws — simulates a Valkey partition/outage.
            const getClient = async (): Promise<ValkeyLikeClient> => {
                throw new Error('CONNECTION_BROKEN');
            };

            const recovery = new BootRecovery(sql, sm, getClient, () => undefined);
            const report = await recovery.run();

            // All 3 candidates skipped: inspected=0 (cycle was skipped entirely,
            // not inspected-and-skipped), reclaimed=0.
            expect(report.reclaimed).toBe(0);
            expect(report.inspected).toBe(0);
            expect(report.runIds).toHaveLength(0);
            // No terminal transition fired.
            expect(sm.transitionRun).not.toHaveBeenCalled();
        });
    });

    describe('CPU-burst worker: hash alive protects stale-heartbeat run (Signal 2)', () => {
        it('does NOT reclaim a run with stale heartbeat when the Valkey hash is present', async () => {
            // A CPU-burst worker that let heartbeat lag still has its
            // `task:run:active:<id>` hash present. Signal 2 protects it.
            const staleHeartbeat = new Date(Date.now() - 6 * 60 * 1000); // 6 min > 5-min threshold
            const candidates: CandidateRow[] = [
                {
                    id: 'run_cpu_burst',
                    task_id: 'sync-tmdb',
                    state: 'active',
                    owner_instance_id: 'worker-1',
                    heartbeat_at: staleHeartbeat,
                },
            ];
            const sql = buildSqlMock(candidates);
            const sm = makeStateMachine();
            // Hash present → HEXISTS returns 1.
            const { getClient } = makeClient({ hashAlive: true });

            const recovery = new BootRecovery(sql, sm, getClient, () => undefined);
            const report = await recovery.run();

            expect(report.reclaimed).toBe(0);
        });

        it('keeps a live run when HEXISTS answers with a boolean (valkey-glide)', async () => {
            // Regression 2026-10-06: glide returns `true`, and the guard only
            // recognised 1/'1', so a live run with a lagging Postgres
            // heartbeat was reclaimed.
            const staleHeartbeat = new Date(Date.now() - 6 * 60 * 1000);
            const candidates: CandidateRow[] = [
                {
                    id: 'run_glide_alive',
                    task_id: 'sync-tmdb',
                    state: 'active',
                    owner_instance_id: 'worker-1',
                    heartbeat_at: staleHeartbeat,
                },
            ];
            const alive = makeClient({ hashAlive: true, glideBooleans: true });
            const kept = await new BootRecovery(
                buildSqlMock(candidates),
                makeStateMachine(),
                alive.getClient,
                () => undefined,
            ).run();
            expect(kept.reclaimed).toBe(0);

            const gone = makeClient({ hashAlive: false, glideBooleans: true });
            const reclaimed = await new BootRecovery(
                buildSqlMock(candidates),
                makeStateMachine(),
                gone.getClient,
                () => undefined,
            ).run();
            expect(reclaimed.reclaimed).toBe(1);
        });
    });

    describe('F1.2 follow-up: identity-key release on reclaim', () => {
        function exclusiveRegistry(hasExclusive: boolean): TaskRegistry {
            return {
                getTask: (id: string) =>
                    id === 'excl-task'
                        ? {
                              id: 'excl-task',
                              resourceClass: 'io',
                              identityFor: () => 'global',
                              ...(hasExclusive ? { exclusiveWith: { scope: 'global' } } : {}),
                          }
                        : undefined,
                getAllTasks: () => [],
            } as unknown as TaskRegistry;
        }

        it('releases the exclusiveWith identity key when an orphan is reclaimed', async () => {
            luaInvoke.mockClear();
            const candidates: CandidateRow[] = [
                {
                    id: 'run_excl',
                    task_id: 'excl-task',
                    state: 'active',
                    owner_instance_id: null,
                    input: { id: 'x' },
                    heartbeat_at: null,
                },
            ];
            const sql = buildSqlMock(candidates);
            const { getClient } = makeClient(false);
            const recovery = new BootRecovery(
                sql,
                makeStateMachine(),
                getClient,
                () => undefined,
                exclusiveRegistry(true),
            );

            const report = await recovery.run();
            expect(report.reclaimed).toBe(1);
            expect(luaInvoke).toHaveBeenCalledWith(
                'release-identity',
                ['task:identity:excl-task:excl-task~~global'],
                ['run_excl'],
                expect.anything(),
                undefined,
            );
        });

        it('does NOT release for a task without exclusiveWith', async () => {
            luaInvoke.mockClear();
            const candidates: CandidateRow[] = [
                {
                    id: 'run_plain',
                    task_id: 'excl-task',
                    state: 'active',
                    owner_instance_id: null,
                    input: { id: 'x' },
                    heartbeat_at: null,
                },
            ];
            const sql = buildSqlMock(candidates);
            const { getClient } = makeClient(false);
            const recovery = new BootRecovery(
                sql,
                makeStateMachine(),
                getClient,
                () => undefined,
                exclusiveRegistry(false),
            );

            const report = await recovery.run();
            expect(report.reclaimed).toBe(1);
            expect(luaInvoke).not.toHaveBeenCalled();
        });
    });

    // ── PENDING orphan: BullMQ job-existence guard ──────────────────────────────
    //
    // Consolidation #1 deleted the BullMQ job-state signal for ALL states. For
    // ACTIVE runs that was correct (the parked-job veto WAS the zombie bug). For
    // PENDING runs it regressed a previously-fixed footgun: a pending run never
    // heartbeats, so its run hash expires at ~15min even while it sits
    // legitimately enqueued behind a backlog — hash-only reclaim would then drop
    // live queued work ("pending_orphan_at_recovery every 15-30min on a live
    // job"). The guard is restored narrowly: pending + hash-absent consults
    // BullMQ; a still-queued job is not an orphan. ACTIVE never consults BullMQ.
    describe('PENDING orphan: BullMQ job-existence guard', () => {
        function taskRegistry(): TaskRegistry {
            return {
                getTask: (id: string) =>
                    id === 'sched-task'
                        ? { id: 'sched-task', resourceClass: 'io', identityFor: () => 'global' }
                        : undefined,
                getAllTasks: () => [],
            } as unknown as TaskRegistry;
        }

        function makeQueueResolver(jobState: string | 'absent') {
            const getJob = vi.fn(async (_jobId: string) =>
                jobState === 'absent' ? null : { getState: async () => jobState },
            );
            const resolver = (_taskId: string) => ({ getJob });
            return { resolver, getJob };
        }

        function pendingRow(): CandidateRow[] {
            return [
                {
                    id: 'run_pending',
                    task_id: 'sched-task',
                    state: 'pending',
                    owner_instance_id: null,
                    input: { libraryGroupId: 'g1' },
                    heartbeat_at: null,
                },
            ];
        }

        it('does NOT reclaim a pending run whose BullMQ job is still waiting (hash expired, job alive)', async () => {
            const sql = buildSqlMock(pendingRow());
            const { getClient } = makeClient(false); // HEXISTS=0 → hash expired
            const { resolver, getJob } = makeQueueResolver('waiting');
            const recovery = new BootRecovery(
                sql,
                makeStateMachine(),
                getClient,
                resolver,
                taskRegistry(),
            );
            const report = await recovery.run();
            expect(getJob).toHaveBeenCalledWith('sched-task~~global#run_pending');
            expect(report.reclaimed).toBe(0);
        });

        it('reclaims a pending run whose BullMQ job is absent (genuine orphan)', async () => {
            const sql = buildSqlMock(pendingRow());
            const { getClient } = makeClient(false);
            const { resolver } = makeQueueResolver('absent');
            const recovery = new BootRecovery(
                sql,
                makeStateMachine(),
                getClient,
                resolver,
                taskRegistry(),
            );
            const report = await recovery.run();
            expect(report.reclaimed).toBe(1);
        });

        it('reclaims a pending run whose BullMQ job is terminal/failed (maxConcurrent bounce)', async () => {
            const sql = buildSqlMock(pendingRow());
            const { getClient } = makeClient(false);
            const { resolver } = makeQueueResolver('failed');
            const recovery = new BootRecovery(
                sql,
                makeStateMachine(),
                getClient,
                resolver,
                taskRegistry(),
            );
            const report = await recovery.run();
            expect(report.reclaimed).toBe(1);
        });

        it('does NOT apply the BullMQ guard to ACTIVE zombies — they reclaim on heartbeat staleness even with a live job', async () => {
            const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
            const sql = buildSqlMock([
                {
                    id: 'run_zombie',
                    task_id: 'sched-task',
                    state: 'active',
                    owner_instance_id: null,
                    input: { libraryGroupId: 'g1' },
                    heartbeat_at: twoHoursAgo,
                },
            ]);
            const { getClient } = makeClient(false); // hash expired
            const { resolver, getJob } = makeQueueResolver('active'); // BullMQ says job alive
            const recovery = new BootRecovery(
                sql,
                makeStateMachine(),
                getClient,
                resolver,
                taskRegistry(),
            );
            const report = await recovery.run();
            // The active path never consults BullMQ — the consolidation #1 win.
            expect(getJob).not.toHaveBeenCalled();
            expect(report.reclaimed).toBe(1);
        });
    });

    describe('multiple orphans', () => {
        it('reclaims all in a single pass and emits one pubsub event', async () => {
            const candidates: CandidateRow[] = [
                {
                    id: 'run_a',
                    task_id: 'sync-tmdb',
                    state: 'active',
                    owner_instance_id: null,
                },
                {
                    id: 'run_b',
                    task_id: 'embed-metadata',
                    state: 'active',
                    owner_instance_id: null,
                },
                {
                    id: 'run_c',
                    task_id: 'library-scan',
                    state: 'active',
                    owner_instance_id: null,
                },
            ];
            const sql = buildSqlMock(candidates);
            const sm = makeStateMachine();
            const { getClient } = makeClient(false);

            const recovery = new BootRecovery(sql, sm, getClient, () => undefined);

            const report = await recovery.run();
            expect(report.inspected).toBe(3);
            expect(report.reclaimed).toBe(3);
            expect(report.runIds).toHaveLength(3);
            expect(report.runIds).toEqual(expect.arrayContaining(['run_a', 'run_b', 'run_c']));

            // Only one pubsub emit for the batch.
            const pubs = publishedMeta.filter((p) => p.channel === 'task:events:meta');
            expect(pubs).toHaveLength(1);
            const payload = JSON.parse(pubs[0].message) as { count: number };
            expect(payload.count).toBe(3);
        });
    });

    describe('pending orphan (HSET/enqueue crashed at startRun)', () => {
        it('reclaims pending row with pending_orphan_at_recovery', async () => {
            const candidates: CandidateRow[] = [
                {
                    id: 'run_pending',
                    task_id: 'sync-tmdb',
                    state: 'pending',
                    owner_instance_id: null,
                },
            ];
            const sql = buildSqlMock(candidates);
            const sm = makeStateMachine();
            const { getClient } = makeClient(false);

            const recovery = new BootRecovery(sql, sm, getClient, () => undefined);

            const report = await recovery.run();
            expect(report.reclaimed).toBe(1);
            expect(report.runIds).toEqual(['run_pending']);

            // Pending → failed is not a legal Lua transition, so Valkey mirror
            // must NOT be invoked for pending orphans (Postgres write only).
            expect(sm.transitionRun).not.toHaveBeenCalled();

            const pub = publishedMeta.find((p) => p.channel === 'task:events:meta');
            expect(pub).toBeDefined();
            const payload = JSON.parse(pub!.message) as {
                type: string;
                runIds: string[];
            };
            expect(payload.type).toBe('recovery-reclaimed');
            expect(payload.runIds).toEqual(['run_pending']);
        });
    });

    describe('Critical-1: stale maxConcurrent counter sweep', () => {
        // Build a Valkey mock that drives SCAN results, tracks counter VALUES,
        // and simulates the atomic reconcile EVAL (read cur, DECRBY the proven
        // excess over the DB target, DEL when target is 0). SCAN returns
        // [cursor, keys]; we drain in a single batch for simplicity.
        function makeSweepClient(opts: {
            activeCountKeys: string[];
            activeHashKeys: string[];
            /** Current leaked value of each `task:active-count:*` counter. */
            counterValues?: Record<string, number>;
        }): {
            client: FakeClient & {
                _deleted: string[];
                _values: Map<string, number>;
                _ttls: Map<string, number>;
                _rebuilt: string[];
            };
            getClient: () => Promise<ValkeyLikeClient>;
        } {
            const published: Array<{ channel: string; message: string }> = [];
            const deleted: string[] = [];
            const values = new Map<string, number>(Object.entries(opts.counterValues ?? {}));
            // TTLs SET via the budget rebuild branch (C4) and keys it reconstructed.
            const ttls = new Map<string, number>();
            const rebuilt: string[] = [];

            const client = {
                _published: published,
                _deleted: deleted,
                _values: values,
                _ttls: ttls,
                _rebuilt: rebuilt,
                customCommand: vi.fn(async (cmd: string[]) => {
                    const op = cmd[0]?.toUpperCase();
                    if (op === 'HEXISTS' || op === 'EXISTS') return 0;
                    if (op === 'PUBLISH') {
                        published.push({
                            channel: String(cmd[1]),
                            message: String(cmd[2]),
                        });
                        return 1;
                    }
                    if (op === 'SCAN') {
                        const pattern = String(cmd[3]);
                        if (pattern === 'task:active-count:*') {
                            return ['0', opts.activeCountKeys];
                        }
                        if (pattern === 'task:run:active:*') {
                            return ['0', opts.activeHashKeys];
                        }
                        return ['0', []];
                    }
                    if (op === 'GET') {
                        const v = values.get(String(cmd[1]));
                        return v === undefined ? null : String(v);
                    }
                    if (op === 'DEL') {
                        const k = String(cmd[1]);
                        deleted.push(k);
                        values.delete(k);
                        return 1;
                    }
                    // Simulate RECONCILE_LUA. Two shapes share this EVAL:
                    //   - per-task sweep:  EVAL <script> 1 <key> <target>     (cmd[5] absent)
                    //   - budget reconcile: EVAL <script> 1 <key> <target> <ttl> (cmd[5] present)
                    // Only the budget Lua has the C4 rebuild-from-absent branch
                    // and the negative-counter SET-to-target heal, so we gate
                    // those on the TTL ARGV being present.
                    if (op === 'EVAL') {
                        const key = String(cmd[3]);
                        const target = Number(cmd[4]);
                        const hasTtl = cmd[5] !== undefined;
                        const ttl = hasTtl ? Number(cmd[5]) : undefined;
                        const cur = values.get(key);
                        if (cur === undefined) {
                            // Budget Lua only: rebuild the key from the DB target
                            // (C4). Per-task Lua keeps the historical `nil → 0` no-op.
                            if (hasTtl && target > 0) {
                                values.set(key, target);
                                if (ttl !== undefined) ttls.set(key, ttl);
                                rebuilt.push(key);
                                return -target;
                            }
                            return 0;
                        }
                        if (cur < 0) {
                            // Negative-counter self-heal (both Lua variants).
                            if (target > 0) values.set(key, target);
                            else {
                                deleted.push(key);
                                values.delete(key);
                            }
                            return cur;
                        }
                        if (cur <= target) return 0;
                        if (target <= 0) {
                            deleted.push(key);
                            values.delete(key);
                        } else {
                            values.set(key, target);
                        }
                        return cur - target;
                    }
                    return null;
                }),
            };
            return {
                client,
                getClient: async () => client as unknown as ValkeyLikeClient,
            };
        }

        /**
         * Sql mock that returns per-task active-run counts for the
         * `GROUP BY task_id` reconcile query, and [] for the candidate SELECT.
         */
        function buildActiveCountSql(rows: Array<{ task_id: string; n: number }>): postgres.Sql {
            const tag = vi.fn((...args: unknown[]) => {
                const parts = args[0] as TemplateStringsArray | string[];
                const query = Array.from(parts).join('?');
                if (query.includes('GROUP BY task_id')) return Promise.resolve(rows);
                return Promise.resolve([]);
            });
            (tag as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
            return tag as unknown as postgres.Sql;
        }

        /**
         * Registry mock whose getAllTasks() returns tasks declaring
         * quotas.maxConcurrent — the sweep derives counter keys from this, NOT
         * from a SCAN (the Valkey keyspace is too large to SCAN reliably).
         *
         * `byId` lets per-task budget-class lookups resolve a task to its
         * resourceClass — the budget reconcile needs it to roll up active
         * task_history rows into per-class targets.
         */
        function makeRegistry(
            taskIds: string[],
            byId?: Record<string, { resourceClass?: string }>,
        ): TaskRegistry {
            return {
                getAllTasks: () =>
                    taskIds.map((id) => ({
                        id,
                        quotas: { maxConcurrent: 4 },
                        resourceClass: byId?.[id]?.resourceClass,
                    })),
                getTask: (id: string) =>
                    taskIds.includes(id)
                        ? {
                              id,
                              quotas: { maxConcurrent: 4 },
                              resourceClass: byId?.[id]?.resourceClass,
                          }
                        : undefined,
            } as unknown as TaskRegistry;
        }

        it('clears a fully-leaked counter (DB shows 0 active → DEL)', async () => {
            const sql = buildActiveCountSql([]); // no active runs anywhere
            const sm = makeStateMachine();
            const { client, getClient } = makeSweepClient({
                activeCountKeys: [],
                activeHashKeys: [],
                counterValues: {
                    'task:active-count:sync-tmdb': 1,
                    'task:active-count:embed-metadata': 3,
                },
            });

            // perTaskQueues=false isolates the active-count sweep; the budget
            // counter reset (flag-on) is covered by its own tests below.
            const recovery = new BootRecovery(
                sql,
                sm,
                getClient,
                () => undefined,
                makeRegistry(['sync-tmdb', 'embed-metadata']),
                false,
            );
            await recovery.run();

            expect(client._deleted).toEqual(
                expect.arrayContaining([
                    'task:active-count:sync-tmdb',
                    'task:active-count:embed-metadata',
                ]),
            );
            expect(client._deleted).toHaveLength(2);
        });

        it('clears an idle leak even while ANOTHER task is active (per-task, not all-or-nothing)', async () => {
            // This is the regression test for the wedge bug: the old sweep
            // skipped EVERYTHING when any active hash existed, so a busy cluster
            // never cleared leaks. The reconcile is now per-task: sync-tmdb is
            // idle (DB 0 → cleared) while embed-metadata is genuinely active
            // (DB 1 → preserved), and an active hash is present.
            const sql = buildActiveCountSql([{ task_id: 'embed-metadata', n: 1 }]);
            const sm = makeStateMachine();
            const { client, getClient } = makeSweepClient({
                activeCountKeys: [],
                activeHashKeys: ['task:run:active:run_live'],
                counterValues: {
                    'task:active-count:sync-tmdb': 1,
                    'task:active-count:embed-metadata': 1,
                },
            });

            const recovery = new BootRecovery(
                sql,
                sm,
                getClient,
                () => undefined,
                makeRegistry(['sync-tmdb', 'embed-metadata']),
                false,
            );
            await recovery.run();

            // Idle leak cleared; active task's counter untouched.
            expect(client._deleted).toEqual(['task:active-count:sync-tmdb']);
            expect(client._values.get('task:active-count:embed-metadata')).toBe(1);
        });

        it('DECRBYs a partial leak down to the DB-authoritative count', async () => {
            // Counter leaked to 4 but only 1 run is genuinely active → reconcile
            // to 1 (DECRBY 3), not DEL. Prevents wedging a task that is running
            // below its ceiling behind phantom slots.
            const sql = buildActiveCountSql([{ task_id: 'media-probe', n: 1 }]);
            const sm = makeStateMachine();
            const { client, getClient } = makeSweepClient({
                activeCountKeys: [],
                activeHashKeys: [],
                counterValues: { 'task:active-count:media-probe': 4 },
            });

            const recovery = new BootRecovery(
                sql,
                sm,
                getClient,
                () => undefined,
                makeRegistry(['media-probe']),
                false,
            );
            await recovery.run();

            expect(client._deleted).toHaveLength(0);
            expect(client._values.get('task:active-count:media-probe')).toBe(1);
        });

        it("no-op when a counter key does not exist (registered task, never INCR'd)", async () => {
            // Registry has a task but its counter was never created (GET → nil),
            // so the reconcile EVAL is a no-op and nothing is deleted.
            const sql = buildActiveCountSql([]);
            const sm = makeStateMachine();
            const { client, getClient } = makeSweepClient({
                activeCountKeys: [],
                activeHashKeys: [],
                // no counterValues → GET returns nil for every key
            });

            const recovery = new BootRecovery(
                sql,
                sm,
                getClient,
                () => undefined,
                makeRegistry(['sync-tmdb']),
                false,
            );
            await recovery.run();

            expect(client._deleted).toHaveLength(0);
        });

        // ── Wave 8.5: per-class budget counter reconciliation (flag-on) ────────
        it('reconciles a fully-leaked class budget (DB shows 0 active → DEL)', async () => {
            // No active runs anywhere → every non-empty class budget should DEL.
            const sql = buildActiveCountSql([]);
            const { client, getClient } = makeSweepClient({
                activeCountKeys: [],
                activeHashKeys: [],
                counterValues: {
                    'task:resource-budget:cpu': 2,
                    'task:resource-budget:maintenance': 1,
                },
            });
            const recovery = new BootRecovery(
                sql,
                makeStateMachine(),
                getClient,
                () => undefined,
                makeRegistry(['trickplay', 'cache-cleanup'], {
                    trickplay: { resourceClass: 'cpu' },
                    'cache-cleanup': { resourceClass: 'maintenance' },
                }),
                true, // FEATURE_PER_TASK_QUEUES on
            );
            await recovery.run();
            expect(client._deleted).toEqual(
                expect.arrayContaining([
                    'task:resource-budget:cpu',
                    'task:resource-budget:maintenance',
                ]),
            );
        });

        it('REGRESSION: heals a leaked maintenance budget even while cpu is genuinely active', async () => {
            // The old all-or-nothing behaviour skipped EVERY class whenever ANY
            // active hash existed. With trickplay (cpu) routinely running for
            // minutes, a leaked maintenance counter could never self-heal. This
            // regression test pins the per-class fix: cpu legitimately holds 1
            // token (matched by the DB), maintenance has 0 active runs in the
            // DB but the counter shows 1, so maintenance reconciles to 0.
            const sql = buildActiveCountSql([{ task_id: 'trickplay', n: 1 }]);
            const { client, getClient } = makeSweepClient({
                activeCountKeys: [],
                activeHashKeys: ['task:run:active:run_live_cpu'],
                counterValues: {
                    'task:resource-budget:cpu': 1, // matches DB → preserved
                    'task:resource-budget:maintenance': 1, // no DB rows → cleared
                },
            });
            const recovery = new BootRecovery(
                sql,
                makeStateMachine(),
                getClient,
                () => undefined,
                makeRegistry(['trickplay', 'cache-cleanup'], {
                    trickplay: { resourceClass: 'cpu' },
                    'cache-cleanup': { resourceClass: 'maintenance' },
                }),
                true,
            );
            await recovery.run();
            // Maintenance gets DEL'd; cpu stays at 1.
            expect(client._deleted).toContain('task:resource-budget:maintenance');
            expect(client._deleted).not.toContain('task:resource-budget:cpu');
            expect(client._values.get('task:resource-budget:cpu')).toBe(1);
        });

        it('reconciles class budget down to its proven target (DECRBY excess)', async () => {
            // DB: 1 active cpu run. Counter: 3. Reconcile should DECRBY 2 leaving 1.
            const sql = buildActiveCountSql([{ task_id: 'trickplay', n: 1 }]);
            const { client, getClient } = makeSweepClient({
                activeCountKeys: [],
                activeHashKeys: [],
                counterValues: { 'task:resource-budget:cpu': 3 },
            });
            const recovery = new BootRecovery(
                sql,
                makeStateMachine(),
                getClient,
                () => undefined,
                makeRegistry(['trickplay'], {
                    trickplay: { resourceClass: 'cpu' },
                }),
                true,
            );
            await recovery.run();
            expect(client._values.get('task:resource-budget:cpu')).toBe(1);
            expect(client._deleted).not.toContain('task:resource-budget:cpu');
        });

        it('rolls multiple active tasks under the same class into one target', async () => {
            // Two distinct cpu tasks each with 1 active run → cpu target is 2.
            // Counter at 3 → DECRBY 1 leaving 2.
            const sql = buildActiveCountSql([
                { task_id: 'trickplay', n: 1 },
                { task_id: 'media-probe', n: 1 },
            ]);
            const { client, getClient } = makeSweepClient({
                activeCountKeys: [],
                activeHashKeys: [],
                counterValues: { 'task:resource-budget:cpu': 3 },
            });
            const recovery = new BootRecovery(
                sql,
                makeStateMachine(),
                getClient,
                () => undefined,
                makeRegistry(['trickplay', 'media-probe'], {
                    trickplay: { resourceClass: 'cpu' },
                    'media-probe': { resourceClass: 'cpu' },
                }),
                true,
            );
            await recovery.run();
            expect(client._values.get('task:resource-budget:cpu')).toBe(2);
        });

        it('does NOT touch budget counters when the flag is off', async () => {
            const sql = buildActiveCountSql([]);
            const { client, getClient } = makeSweepClient({
                activeCountKeys: [],
                activeHashKeys: [],
                counterValues: { 'task:resource-budget:cpu': 5 },
            });
            const recovery = new BootRecovery(
                sql,
                makeStateMachine(),
                getClient,
                () => undefined,
                makeRegistry(['trickplay'], {
                    trickplay: { resourceClass: 'cpu' },
                }),
                false,
            );
            await recovery.run();
            expect(
                client._deleted.filter((k) => k.startsWith('task:resource-budget:')),
            ).toHaveLength(0);
            expect(client._values.get('task:resource-budget:cpu')).toBe(5);
        });

        // ── C4: rebuild an EXPIRED class-budget key from the DB target ─────────
        // After a >5min Valkey outage the TTL'd budget key expires (GET → nil)
        // while real runs still hold tokens in Postgres. The old `cur == nil →
        // return 0` no-op left the key gone, so the next fresh acquire re-created
        // it at 1, IGNORING the N live holders → over-admission up to the class
        // cap. The reconcile must reconstruct the key to the authoritative target
        // (with the semaphore TTL) before any acquire races it.
        it('rebuilds an expired class budget from the DB active count (C4)', async () => {
            // DB proves 2 active cpu runs, but the counter key has expired
            // (no counterValues entry → GET returns nil).
            const sql = buildActiveCountSql([
                { task_id: 'trickplay', n: 1 },
                { task_id: 'media-probe', n: 1 },
            ]);
            const { client, getClient } = makeSweepClient({
                activeCountKeys: [],
                activeHashKeys: [],
                // No counterValues for cpu → simulates the expired (absent) key.
            });
            const recovery = new BootRecovery(
                sql,
                makeStateMachine(),
                getClient,
                () => undefined,
                makeRegistry(['trickplay', 'media-probe'], {
                    trickplay: { resourceClass: 'cpu' },
                    'media-probe': { resourceClass: 'cpu' },
                }),
                true, // FEATURE_PER_TASK_QUEUES on
            );
            await recovery.run();
            // Reconstructed to the true holder count (2) …
            expect(client._values.get('task:resource-budget:cpu')).toBe(2);
            expect(client._rebuilt).toContain('task:resource-budget:cpu');
            // … with a TTL set so it ages out again on the next outage …
            expect(client._ttls.get('task:resource-budget:cpu')).toBe(300);
            // … and NOT deleted (the old no-op left it absent).
            expect(client._deleted).not.toContain('task:resource-budget:cpu');
        });

        it('does NOT rebuild an expired key when the DB shows zero active (C4 guard)', async () => {
            // Key expired AND no live runs → leave it absent (nothing to hold).
            const sql = buildActiveCountSql([]);
            const { client, getClient } = makeSweepClient({
                activeCountKeys: [],
                activeHashKeys: [],
            });
            const recovery = new BootRecovery(
                sql,
                makeStateMachine(),
                getClient,
                () => undefined,
                makeRegistry(['trickplay'], { trickplay: { resourceClass: 'cpu' } }),
                true,
            );
            await recovery.run();
            expect(client._values.has('task:resource-budget:cpu')).toBe(false);
            expect(client._rebuilt).not.toContain('task:resource-budget:cpu');
        });

        // ── H4: cancelling runs still hold their slot/token ────────────────────
        // A run holds its maxConcurrent slot and class-budget token from acquire
        // until the terminal DECR (runner `releaseConcurrent` in the finally). A
        // run in `cancelling` has NOT terminated, so it still holds both. If the
        // held-slot target query counted only `state = 'active'`, the sweep would
        // claw back the live slot of every in-flight cancel, then double-DECR when
        // the run terminates → the counter goes negative / churns and worker
        // death during cancel leaks a slot. These pin the `IN ('active',
        // 'cancelling')` target on BOTH sweeps.
        //
        // The sql mock returns whatever rows the test provides regardless of the
        // WHERE clause, so we capture the generated query text and assert it
        // selects cancelling rows — the regression signal for a revert to
        // `state = 'active'`.
        function buildQueryCapturingSql(rows: Array<{ task_id: string; n: number }>): {
            sql: postgres.Sql;
            heldSlotQueries: string[];
        } {
            const heldSlotQueries: string[] = [];
            const tag = vi.fn((...args: unknown[]) => {
                const parts = args[0] as TemplateStringsArray | string[];
                const query = Array.from(parts).join('?');
                if (query.includes('GROUP BY task_id')) {
                    heldSlotQueries.push(query);
                    return Promise.resolve(rows);
                }
                return Promise.resolve([]);
            });
            (tag as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
            return { sql: tag as unknown as postgres.Sql, heldSlotQueries };
        }

        it('REPRO H4: maxConcurrent held-slot target counts cancelling, not just active', async () => {
            const { sql, heldSlotQueries } = buildQueryCapturingSql([]);
            const { getClient } = makeSweepClient({
                activeCountKeys: [],
                activeHashKeys: [],
                counterValues: { 'task:active-count:media-probe': 1 },
            });
            const recovery = new BootRecovery(
                sql,
                makeStateMachine(),
                getClient,
                () => undefined,
                makeRegistry(['media-probe']),
                false,
            );
            await recovery.run();

            expect(heldSlotQueries.length).toBeGreaterThan(0);
            for (const q of heldSlotQueries) {
                expect(q).toContain('cancelling');
                // A bare `state = 'active'` (without cancelling) is the bug.
                expect(q).not.toMatch(/state\s*=\s*'active'/);
            }
        });

        it('REPRO H4: a cancelling run preserves its maxConcurrent slot (not clawed back)', async () => {
            // DB reports 1 cancelling media-probe run (it still holds its slot).
            // Counter is at 1. The reconcile target must be 1, so the slot is
            // preserved — NOT DEL'd/DECR'd out from under the live cancel.
            const sql = buildActiveCountSql([{ task_id: 'media-probe', n: 1 }]);
            const { client, getClient } = makeSweepClient({
                activeCountKeys: [],
                activeHashKeys: [],
                counterValues: { 'task:active-count:media-probe': 1 },
            });
            const recovery = new BootRecovery(
                sql,
                makeStateMachine(),
                getClient,
                () => undefined,
                makeRegistry(['media-probe']),
                false,
            );
            await recovery.run();

            expect(client._deleted).not.toContain('task:active-count:media-probe');
            expect(client._values.get('task:active-count:media-probe')).toBe(1);
        });

        it('REPRO H4: class-budget held-token target counts cancelling, not just active', async () => {
            const { sql, heldSlotQueries } = buildQueryCapturingSql([]);
            const { getClient } = makeSweepClient({
                activeCountKeys: [],
                activeHashKeys: [],
                counterValues: { 'task:resource-budget:cpu': 1 },
            });
            const recovery = new BootRecovery(
                sql,
                makeStateMachine(),
                getClient,
                () => undefined,
                makeRegistry(['trickplay'], {
                    trickplay: { resourceClass: 'cpu' },
                }),
                true, // FEATURE_PER_TASK_QUEUES on → budget reconcile runs
            );
            await recovery.run();

            // Both sweeps run with the flag on; every held-slot query must count
            // cancelling.
            expect(heldSlotQueries.length).toBeGreaterThan(0);
            for (const q of heldSlotQueries) {
                expect(q).toContain('cancelling');
                expect(q).not.toMatch(/state\s*=\s*'active'/);
            }
        });

        it('REPRO H4: a cancelling cpu run preserves its class-budget token', async () => {
            const sql = buildActiveCountSql([{ task_id: 'trickplay', n: 1 }]);
            const { client, getClient } = makeSweepClient({
                activeCountKeys: [],
                activeHashKeys: [],
                counterValues: { 'task:resource-budget:cpu': 1 },
            });
            const recovery = new BootRecovery(
                sql,
                makeStateMachine(),
                getClient,
                () => undefined,
                makeRegistry(['trickplay'], {
                    trickplay: { resourceClass: 'cpu' },
                }),
                true,
            );
            await recovery.run();

            expect(client._deleted).not.toContain('task:resource-budget:cpu');
            expect(client._values.get('task:resource-budget:cpu')).toBe(1);
        });
    });

    // ── T6: cancelling-orphan reclaimed as 'cancelled', not 'failed' ─────────
    //
    // A candidate row with state='cancelling' that is orphaned (all liveness
    // signals absent) must be written to Postgres as terminal 'cancelled', not
    // 'failed'. Mislabelling it 'failed' inflates failure metrics and admin UI
    // shows an operator-cancelled run as errored.

    describe('T6: cancelling-orphan → terminal cancelled (not failed)', () => {
        it('reclaims a cancelling orphan as cancelled with errorCode cancelling_orphan_at_recovery', async () => {
            const candidates: CandidateRow[] = [
                {
                    id: 'run_cancelling',
                    task_id: 'sync-tmdb',
                    state: 'cancelling',
                    owner_instance_id: null,
                },
            ];

            // Capture what the sql UPDATE writes so we can assert terminalState.
            const updateCalls: Array<{ state: unknown; jsonErr: unknown }> = [];
            const tag = vi.fn((...args: unknown[]) => {
                const parts = args[0] as TemplateStringsArray | string[];
                const query = Array.from(parts).join('?');
                if (query.includes('task_history') && query.includes('SELECT')) {
                    return Promise.resolve(candidates);
                }
                if (query.includes('UPDATE task_history')) {
                    updateCalls.push({ state: args[1], jsonErr: args[2] });
                    return Promise.resolve([{ id: 'reclaimed' }]);
                }
                return Promise.resolve([]);
            });
            (tag as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
            const sql = tag as unknown as postgres.Sql;

            const sm = makeStateMachine();
            const { getClient } = makeClient(false);

            const recovery = new BootRecovery(sql, sm, getClient, () => undefined);
            const report = await recovery.run();

            // The run must be reclaimed.
            expect(report.reclaimed).toBe(1);
            expect(report.runIds).toEqual(['run_cancelling']);

            // The Postgres UPDATE must have written 'cancelled', not 'failed'.
            expect(updateCalls.length).toBeGreaterThanOrEqual(1);
            const termUpdate = updateCalls[0];
            expect(termUpdate.state).toBe('cancelled');

            const errorObj = termUpdate.jsonErr as { message?: string } | null;
            expect(errorObj?.message).toBe('cancelling_orphan_at_recovery');

            // Valkey state-machine transition must NOT be called for a 'cancelling'
            // row — the Lua script only allows active→failed.
            expect(sm.transitionRun).not.toHaveBeenCalled();
        });
    });

    // ── #01 Phase 0: reclaimed runs emit the terminal CloudEvent/webhook ──────
    describe('#01 Phase 0: terminal emit on reclaim', () => {
        function buildEmitSqlMock(
            candidates: CandidateRow[],
            updateReturnsRow: boolean,
        ): postgres.Sql {
            const tag = vi.fn((...args: unknown[]) => {
                const parts = args[0] as TemplateStringsArray | string[];
                const query = Array.from(parts).join('?');
                if (query.includes('task_history') && query.includes('SELECT')) {
                    return Promise.resolve(candidates);
                }
                if (query.includes('UPDATE task_history') && query.includes('RETURNING')) {
                    return Promise.resolve(updateReturnsRow ? [{ id: 'reclaimed' }] : []);
                }
                return Promise.resolve([]);
            });
            (tag as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
            return tag as unknown as postgres.Sql;
        }

        it('calls emitTerminal with the reclaimed terminal state + errorCode', async () => {
            const candidates: CandidateRow[] = [
                {
                    id: 'run_a',
                    task_id: 'sync-tmdb',
                    state: 'active',
                    owner_instance_id: null,
                },
            ];
            const emitTerminal = vi.fn(async () => undefined);
            const { getClient } = makeClient(false);
            const recovery = new BootRecovery(
                buildEmitSqlMock(candidates, true),
                makeStateMachine(),
                getClient,
                () => undefined,
                undefined,
                undefined,
                emitTerminal,
            );

            const report = await recovery.run();

            expect(report.reclaimed).toBe(1);
            expect(emitTerminal).toHaveBeenCalledTimes(1);
            expect(emitTerminal).toHaveBeenCalledWith(
                'sync-tmdb',
                'run_a',
                'failed',
                {
                    errorMessage: 'orphaned_at_recovery',
                },
                undefined,
            );
        });

        it('does NOT emit (or count) when the reclaim UPDATE matches no row', async () => {
            // Row already transitioned by a concurrent path → markFailed reads 0
            // rows and returns false, so emit/count must NOT fire (no double-emit).
            const candidates: CandidateRow[] = [
                {
                    id: 'run_b',
                    task_id: 'sync-tmdb',
                    state: 'active',
                    owner_instance_id: null,
                },
            ];
            const emitTerminal = vi.fn(async () => undefined);
            const { getClient } = makeClient(false);
            const recovery = new BootRecovery(
                buildEmitSqlMock(candidates, false),
                makeStateMachine(),
                getClient,
                () => undefined,
                undefined,
                undefined,
                emitTerminal,
            );

            const report = await recovery.run();

            expect(report.reclaimed).toBe(0);
            expect(emitTerminal).not.toHaveBeenCalled();
        });
    });

    // ── T1: heartbeat_at gate — stale heartbeat bypasses Valkey hash ──────────
    //
    // When heartbeat_at is non-null and stale (the candidate query already
    // filtered to > threshold), the hash check is the SOLE per-row guard.
    // A stale heartbeat + absent hash → reclaim.
    // A stale heartbeat + present hash → NOT reclaim (CPU burst protection).

    describe('T1: heartbeat_at stale-run reclaim', () => {
        it('reclaims a run when heartbeat_at is non-null/stale and hash is absent', async () => {
            const candidates: CandidateRow[] = [
                {
                    id: 'run_stale_hb',
                    task_id: 'sync-tmdb',
                    state: 'active',
                    owner_instance_id: 'web-1',
                    heartbeat_at: new Date(0), // epoch — unambiguously stale
                },
            ];
            const sql = buildSqlMock(candidates);
            const sm = makeStateMachine();
            // Hash absent.
            const { getClient } = makeClient({ hashAlive: false });

            const recovery = new BootRecovery(sql, sm, getClient, () => undefined);
            const report = await recovery.run();

            expect(report.reclaimed).toBe(1);
            expect(report.runIds).toEqual(['run_stale_hb']);
        });

        it('does NOT reclaim a run when heartbeat_at is stale but hash is present (CPU burst)', async () => {
            const candidates: CandidateRow[] = [
                {
                    id: 'run_null_hb',
                    task_id: 'sync-tmdb',
                    state: 'active',
                    owner_instance_id: 'web-1',
                    heartbeat_at: new Date(0),
                },
            ];
            const sql = buildSqlMock(candidates);
            const sm = makeStateMachine();
            // Hash present → CPU burst worker.
            const { getClient } = makeClient({ hashAlive: true });

            const recovery = new BootRecovery(sql, sm, getClient, () => undefined);
            const report = await recovery.run();

            expect(report.reclaimed).toBe(0);
            expect(report.runIds).toHaveLength(0);
        });
    });
});

// Keep behavior fixtures independent of the SQL boundary; recovery-fencing.integration
// exercises the real transactions and ownership rejection.
vi.mock('../../../task-runtime/authority/existing-write.js', () => ({
    withExistingTaskWrite: async <T>(
        sql: import('postgres').Sql,
        _authority: unknown,
        mutate: (tx: import('postgres').Sql) => Promise<T>,
    ): Promise<T> => mutate(sql),
}));

vi.mock('./lua/fenced.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./lua/fenced.js')>();
    return {
        ...actual,
        invokeFencedValkey: async (
            source: string,
            keys: string[],
            args: (string | number)[],
            client: { customCommand(cmd: string[]): Promise<unknown> },
        ): Promise<unknown> =>
            client.customCommand(
                source === "return redis.call('DEL', KEYS[1])"
                    ? ['DEL', ...keys]
                    : ['EVAL', source, String(keys.length), ...keys, ...args.map(String)],
            ),
    };
});
