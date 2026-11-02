// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for CircuitBreaker.
 *
 * All DB and Valkey interactions are replaced with in-memory stubs.
 * No live infrastructure required.
 *
 * Run with: npx vitest run src/lib/server/tasks/circuit-breaker.test.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type postgres from 'postgres';
import { CircuitBreaker } from './circuit-breaker.js';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('$lib/server/config.js', () => ({
    LUMASTRA_CIRCUIT_FAILURE_THRESHOLD: 5,
    LUMASTRA_CIRCUIT_FAILURE_RATE_WINDOW_MS: 1_800_000,
    LUMASTRA_CIRCUIT_FORCE_ENABLE_TTL_MS: 86_400_000,
    // CircuitBreaker now records audit events; audit-log lazily loads the DB
    // layer, but the registry singleton in the import graph still reads this
    // load-time flag. Provide it so registry construction doesn't throw.
    FEATURE_PER_TASK_QUEUES: false,
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

// ── In-memory DB stub ─────────────────────────────────────────────────────────

type Row = {
    task_id: string;
    state: 'closed' | 'open' | 'half_open';
    consecutive_failures: number;
    failure_rate_window_count: number;
    failure_rate_window_started_at: Date | null;
    opened_at: Date | null;
    opened_reason: string | null;
    next_probe_at: Date | null;
    manual_override: string | null;
    override_by: string | null;
    override_at: Date | null;
};

function makeDefaultRow(taskId: string): Row {
    return {
        task_id: taskId,
        state: 'closed',
        consecutive_failures: 0,
        failure_rate_window_count: 0,
        failure_rate_window_started_at: null,
        opened_at: null,
        opened_reason: null,
        next_probe_at: null,
        manual_override: null,
        override_by: null,
        override_at: null,
    };
}

function makeMemorySql(store: Map<string, Row>) {
    // Minimal postgres.Sql tag-function stub.
    // Matches each UPDATE by its fixed string skeleton to apply values correctly.
    const sql = (strings: TemplateStringsArray, ...values: unknown[]): Promise<Row[]> => {
        const skeleton = strings.join('\x00').trim().replace(/\s+/g, ' ');

        // SELECT — last value is the taskId filter.
        if (skeleton.startsWith('SELECT')) {
            const taskId = values[0] as string;
            const row = store.get(taskId);
            return Promise.resolve(row ? [{ ...row }] : []);
        }

        // INSERT ON CONFLICT DO NOTHING — first value is taskId.
        if (skeleton.startsWith('INSERT')) {
            const taskId = values[0] as string;
            if (!store.has(taskId)) {
                store.set(taskId, makeDefaultRow(taskId));
            }
            return Promise.resolve([]);
        }

        if (skeleton.startsWith('UPDATE')) {
            const taskId = values[values.length - 1] as string;
            const row = store.get(taskId);
            if (!row) return Promise.resolve([]);

            // Identify UPDATE shape by skeleton content and apply values.

            // Match by most-specific pattern first to avoid CASE-WHEN false matches.

            if (skeleton.includes('consecutive_failures = 0')) {
                // reportSuccess: reset counters. CASE WHEN state='half_open'→'closed'.
                row.consecutive_failures = 0;
                if (row.state === 'half_open') {
                    row.state = 'closed';
                    row.next_probe_at = null;
                    row.opened_at = null;
                    row.opened_reason = null;
                }
            } else if (skeleton.includes("SET state = 'half_open'")) {
                // Half-open probe transition from check(). Must be matched
                // BEFORE the generic "state = 'open'" branch below, because
                // the new SQL contains `state = 'open'` in its WHERE clause
                // (for the open→half_open guard).
                if (row.state === 'open') {
                    row.state = 'half_open';
                }
            } else if (
                skeleton.includes("SET state = 'open'") ||
                skeleton.includes("state                          = 'open'")
            ) {
                row.state = 'open';
                row.consecutive_failures = values[0] as number;
                row.failure_rate_window_count = values[1] as number;
                row.failure_rate_window_started_at = values[2] as Date;
                row.opened_at = values[3] as Date;
                if (skeleton.includes("opened_reason = 'probe_failure'")) {
                    // Probe-failure path: opened_reason is a literal in the SQL, not a param.
                    // Values: consecutive_failures, windowCount, windowStarted, now, nextProbeAt, taskId
                    row.opened_reason = 'probe_failure';
                    row.next_probe_at = values[4] as Date;
                } else {
                    // Normal open path: opened_reason is param[4], nextProbeAt is param[5].
                    // Values: consecutive_failures, windowCount, windowStarted, now, openedReason, nextProbeAt, taskId
                    row.opened_reason = values[4] as string;
                    row.next_probe_at = values[5] as Date;
                }
            } else if (skeleton.includes('manual_override =')) {
                // forceEnable: override_by=$1, NOW() literal, WHERE task_id=$2
                row.manual_override = 'force_enabled';
                row.override_by = values[0] as string;
                row.override_at = new Date();
            } else {
                // Counter-only update: consecutive_failures=$1, window_count=$2, window_started=$3
                row.consecutive_failures = values[0] as number;
                row.failure_rate_window_count = values[1] as number;
                row.failure_rate_window_started_at = values[2] as Date | null;
            }

            return Promise.resolve([]);
        }

        return Promise.resolve([]);
    };

    return sql as unknown as postgres.Sql;
}

// ── Valkey stub ───────────────────────────────────────────────────────────────

function makeValkeyStub(allowProbe: boolean) {
    return {
        customCommand: vi.fn(async (cmd: string[]): Promise<unknown> => {
            if (cmd[0] === 'SET' && cmd.includes('NX')) {
                return allowProbe ? 'OK' : null;
            }
            return null;
        }),
    };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function openedRow(taskId: string, overrides: Partial<Row> = {}): Row {
    return {
        ...makeDefaultRow(taskId),
        state: 'open',
        consecutive_failures: 5,
        opened_at: new Date(),
        opened_reason: 'consecutive_failures',
        next_probe_at: new Date(Date.now() + 60_000), // probe in 1 min
        ...overrides,
    };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('CircuitBreaker', () => {
    let store: Map<string, Row>;

    beforeEach(() => {
        store = new Map();
    });

    it('first check on unknown task: creates row in closed state and allows', async () => {
        const sql = makeMemorySql(store);
        const cb = new CircuitBreaker(sql, () => makeValkeyStub(true) as never);

        const result = await cb.check('my-task');

        expect(result.allowed).toBe(true);
        expect(result.state).toBe('closed');
        expect(store.get('my-task')?.state).toBe('closed');
    });

    it('5 consecutive failures: opens the circuit', async () => {
        const sql = makeMemorySql(store);
        store.set('my-task', makeDefaultRow('my-task'));
        const cb = new CircuitBreaker(sql, () => makeValkeyStub(false) as never);

        for (let i = 0; i < 5; i++) {
            await cb.reportFailure('my-task', { kind: 'transient' });
        }

        expect(store.get('my-task')?.state).toBe('open');
        expect(store.get('my-task')?.opened_reason).toBe('consecutive_failures');
        expect(store.get('my-task')?.next_probe_at).not.toBeNull();
    });

    it('open with cooldown: denies until probe time', async () => {
        const sql = makeMemorySql(store);
        store.set(
            'my-task',
            openedRow('my-task', {
                next_probe_at: new Date(Date.now() + 30_000), // 30s in future
            }),
        );
        const cb = new CircuitBreaker(sql, () => makeValkeyStub(false) as never);

        const result = await cb.check('my-task');

        expect(result.allowed).toBe(false);
        expect(result.reason).toBe('open_with_cooldown');
    });

    it('after cooldown: acquires probe lock and transitions to half_open', async () => {
        const sql = makeMemorySql(store);
        store.set(
            'my-task',
            openedRow('my-task', {
                next_probe_at: new Date(Date.now() - 1), // expired
            }),
        );
        const cb = new CircuitBreaker(sql, () => makeValkeyStub(true) as never);

        const result = await cb.check('my-task');

        expect(result.allowed).toBe(true);
        expect(result.reason).toBe('half_open_probe_taken');
        expect(store.get('my-task')?.state).toBe('half_open');
    });

    it('after cooldown: denies if probe lock already taken by another replica', async () => {
        const sql = makeMemorySql(store);
        store.set(
            'my-task',
            openedRow('my-task', {
                next_probe_at: new Date(Date.now() - 1),
            }),
        );
        const cb = new CircuitBreaker(sql, () => makeValkeyStub(false) as never);

        const result = await cb.check('my-task');

        expect(result.allowed).toBe(false);
    });

    it('stuck half_open with a FREE probe lock (orphaned probe): re-probes instead of denying forever', async () => {
        // Self-heal gap: a half_open row whose probe RUN was orphaned (worker
        // died before reportSuccess/reportFailure) leaves the row half_open with
        // no probe lock. Pre-fix this denied every caller forever. Now a caller
        // re-acquires the free lock and re-probes.
        const sql = makeMemorySql(store);
        store.set('my-task', { ...makeDefaultRow('my-task'), state: 'half_open' });
        const cb = new CircuitBreaker(sql, () => makeValkeyStub(true) as never); // lock free

        const result = await cb.check('my-task');

        expect(result.allowed).toBe(true);
        expect(result.reason).toBe('half_open_probe_taken');
    });

    it('half_open with a HELD probe lock (probe genuinely in flight): still denies', async () => {
        const sql = makeMemorySql(store);
        store.set('my-task', { ...makeDefaultRow('my-task'), state: 'half_open' });
        const cb = new CircuitBreaker(sql, () => makeValkeyStub(false) as never); // lock held

        const result = await cb.check('my-task');

        expect(result.allowed).toBe(false);
        expect(result.reason).toBe('circuit_open');
    });

    it('after cooldown: fails closed when Valkey client is unavailable', async () => {
        const sql = makeMemorySql(store);
        store.set(
            'my-task',
            openedRow('my-task', {
                next_probe_at: new Date(Date.now() - 1),
            }),
        );
        // getClient returns null → no probe lock can be obtained →
        // breaker must deny (NOT fail open).
        const cb = new CircuitBreaker(sql, () => null);

        const result = await cb.check('my-task');

        expect(result.allowed).toBe(false);
        expect(result.state).toBe('open');
        // State NOT promoted to half_open since the probe wasn't granted.
        expect(store.get('my-task')?.state).toBe('open');
    });

    it('after cooldown: fails closed when Valkey throws', async () => {
        const sql = makeMemorySql(store);
        store.set(
            'my-task',
            openedRow('my-task', {
                next_probe_at: new Date(Date.now() - 1),
            }),
        );
        const throwingClient = {
            customCommand: vi.fn(async () => {
                throw new Error('valkey down');
            }),
        };
        const cb = new CircuitBreaker(sql, () => throwingClient as never);

        const result = await cb.check('my-task');

        expect(result.allowed).toBe(false);
        expect(store.get('my-task')?.state).toBe('open');
    });

    it('probe success: transitions to closed', async () => {
        const sql = makeMemorySql(store);
        store.set('my-task', {
            ...makeDefaultRow('my-task'),
            state: 'half_open',
            consecutive_failures: 5,
        });
        const cb = new CircuitBreaker(sql, () => makeValkeyStub(true) as never);

        await cb.reportSuccess('my-task');

        expect(store.get('my-task')?.state).toBe('closed');
        expect(store.get('my-task')?.consecutive_failures).toBe(0);
    });

    it('probe failure: transitions back to open with longer cooldown', async () => {
        const sql = makeMemorySql(store);
        store.set('my-task', {
            ...makeDefaultRow('my-task'),
            state: 'half_open',
            consecutive_failures: 5,
        });
        const cb = new CircuitBreaker(sql, () => makeValkeyStub(false) as never);

        await cb.reportFailure('my-task', { kind: 'transient' });

        const row = store.get('my-task');
        expect(row?.state).toBe('open');
        expect(row?.opened_reason).toBe('probe_failure');
        expect(row?.next_probe_at).not.toBeNull();
    });

    it('force-enable: bypasses circuit for 24h', async () => {
        const sql = makeMemorySql(store);
        store.set(
            'my-task',
            openedRow('my-task', {
                next_probe_at: new Date(Date.now() + 999_999),
            }),
        );
        const cb = new CircuitBreaker(sql, () => makeValkeyStub(false) as never);

        await cb.forceEnable('my-task', 'admin-user');
        // Simulate the override_at being set to now so check() sees it as active.
        store.get('my-task')!.manual_override = 'force_enabled';
        store.get('my-task')!.override_at = new Date();

        const result = await cb.check('my-task');

        expect(result.allowed).toBe(true);
        expect(result.reason).toBe('force_enabled');
    });

    it('force-enable past 24h: respects circuit again', async () => {
        const sql = makeMemorySql(store);
        const expiredAt = new Date(Date.now() - 86_400_001); // just past 24h
        store.set('my-task', {
            ...openedRow('my-task', {
                next_probe_at: new Date(Date.now() + 60_000),
            }),
            manual_override: 'force_enabled',
            override_at: expiredAt,
        });
        const cb = new CircuitBreaker(sql, () => makeValkeyStub(false) as never);

        const result = await cb.check('my-task');

        expect(result.allowed).toBe(false);
    });

    it('closed circuit: always allows', async () => {
        const sql = makeMemorySql(store);
        store.set('my-task', makeDefaultRow('my-task'));
        const cb = new CircuitBreaker(sql, () => makeValkeyStub(false) as never);

        const result = await cb.check('my-task');

        expect(result.allowed).toBe(true);
        expect(result.state).toBe('closed');
    });

    describe('peek (read-only status)', () => {
        it('open past its cooldown: reports eligible without taking the probe lock or flipping state', async () => {
            const sql = makeMemorySql(store);
            store.set('my-task', openedRow('my-task', { next_probe_at: new Date(Date.now() - 1) }));
            const valkey = makeValkeyStub(true);
            const cb = new CircuitBreaker(sql, () => valkey as never);

            const result = await cb.peek('my-task');

            expect(result).toMatchObject({ allowed: true, state: 'open' });
            expect(store.get('my-task')?.state).toBe('open');
            expect(valkey.customCommand).not.toHaveBeenCalled();

            // The real admission check still gets the probe afterwards.
            const admitted = await cb.check('my-task');
            expect(admitted).toMatchObject({ allowed: true, state: 'half_open' });
        });

        it('open inside its cooldown: denies with the probe time', async () => {
            const sql = makeMemorySql(store);
            const probeAt = new Date(Date.now() + 30_000);
            store.set('my-task', openedRow('my-task', { next_probe_at: probeAt }));
            const cb = new CircuitBreaker(sql, () => makeValkeyStub(true) as never);

            const result = await cb.peek('my-task');

            expect(result).toMatchObject({
                allowed: false,
                state: 'open',
                reason: 'open_with_cooldown',
            });
            expect(result.nextProbeAt?.getTime()).toBe(probeAt.getTime());
        });

        it('half_open: reports blocked without reclaiming the probe', async () => {
            const sql = makeMemorySql(store);
            store.set('my-task', openedRow('my-task', { state: 'half_open' }));
            const valkey = makeValkeyStub(true);
            const cb = new CircuitBreaker(sql, () => valkey as never);

            const result = await cb.peek('my-task');

            expect(result).toMatchObject({ allowed: false, state: 'half_open' });
            expect(valkey.customCommand).not.toHaveBeenCalled();
        });

        it('unknown task: closed, and no row is created', async () => {
            const sql = makeMemorySql(store);
            const cb = new CircuitBreaker(sql, () => makeValkeyStub(true) as never);

            const result = await cb.peek('new-task');

            expect(result).toMatchObject({ allowed: true, state: 'closed' });
            expect(store.has('new-task')).toBe(false);
        });
    });
});
