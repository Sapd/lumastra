// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for Reconciler — threshold boundary coverage.
 *
 * Requires:
 *   - TEST_DATABASE_URL pointing at lumastra_tests (migrated).
 *   - CACHE_URL pointing at a Valkey instance.
 *
 * These tests are skipped automatically when those env vars are missing so
 * `npx vitest run` still works in unit-only mode. See docs/dev/QUICK-START.md
 * "Integration Testing" for setup.
 *
 * Pins the SQL threshold boundaries in queryStaleCandidates:
 *   - active/cancelling: stale when heartbeat_at < NOW() - 5 min
 *   - pending:           stale when started_at  < NOW() - 3 min
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import postgres from 'postgres';
import { Reconciler } from './reconciler.js';
import { stateMachine } from './state-machine.js';
import {
    getCoordinationClient,
    connectValkey,
    disconnectValkey,
} from '$lib/server/cache/valkey.js';
import type { OrphanSweep } from './orphan-sweep.js';
import type { PendingWriteDrain } from './pending-write-drain.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const CACHE_URL = process.env.CACHE_URL ?? '';

const RUN = Boolean(TEST_DATABASE_URL && CACHE_URL);

// Unique prefix so afterEach cleanup only deletes rows we inserted.
const ID_PREFIX = 'run_test_reconciler_';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeNoopOrphanSweep(): OrphanSweep {
    return {
        run: async () => ({ swept: 0, queuesScanned: 0 }),
    } as unknown as OrphanSweep;
}

function makeNoopPendingDrain(): PendingWriteDrain {
    return {
        drain: async () => ({ drained: 0, remaining: 0 }),
        start: () => {},
        stop: () => {},
        enqueue: async () => {},
    } as unknown as PendingWriteDrain;
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe.runIf(RUN)('Reconciler integration — queryStaleCandidates thresholds', () => {
    let sql: postgres.Sql;
    let reconciler: Reconciler;

    beforeAll(async () => {
        sql = postgres(TEST_DATABASE_URL, { max: 4 });
        await connectValkey();
        // Best-effort migration check.
        try {
            await sql`SELECT 1 FROM task_history LIMIT 0`;
        } catch (e) {
            throw new Error(
                `task_history table missing — run db:test:migrate first. ${(e as Error).message}`,
                { cause: e },
            );
        }

        reconciler = new Reconciler(
            sql,
            stateMachine,
            async () =>
                getCoordinationClient() as unknown as {
                    customCommand: (cmd: string[]) => Promise<unknown>;
                },
            () => undefined,
            makeNoopOrphanSweep(),
            makeNoopPendingDrain(),
            () => true,
            true, // perTaskQueues=true: skip aging sweep, keep test scope minimal
        );
    }, 30_000);

    afterAll(async () => {
        await disconnectValkey();
        await sql.end();
    });

    afterEach(async () => {
        await sql`DELETE FROM task_history WHERE id LIKE ${ID_PREFIX + '%'}`;
    });

    /**
     * Insert a minimal task_history row at a controlled age.
     * Only the columns the reconciler query touches are required.
     */
    async function insertRow(opts: {
        id: string;
        state: 'active' | 'cancelling' | 'pending';
        /** Offset from NOW() in seconds (negative = in the past). */
        heartbeatOffsetSeconds?: number;
        startedAtOffsetSeconds: number;
    }): Promise<void> {
        const { id, state, heartbeatOffsetSeconds, startedAtOffsetSeconds } = opts;
        if (heartbeatOffsetSeconds !== undefined) {
            await sql`
                INSERT INTO task_history
                    (id, task_id, label, state, input, trigger, actor,
                     processing_version, started_at, heartbeat_at,
                     owner_instance_id)
                VALUES (
                    ${id},
                    'reconciler-integration-test',
                    'reconciler-integration-test',
                    ${state},
                    ${sql.json({})},
                    ${sql.json({ kind: 'test' })},
                    ${sql.json({ kind: 'test' })},
                    '1',
                    NOW() + ${`${startedAtOffsetSeconds} seconds`}::interval,
                    NOW() + ${`${heartbeatOffsetSeconds} seconds`}::interval,
                    'test-instance'
                )
            `;
        } else {
            await sql`
                INSERT INTO task_history
                    (id, task_id, label, state, input, trigger, actor,
                     processing_version, started_at,
                     owner_instance_id)
                VALUES (
                    ${id},
                    'reconciler-integration-test',
                    'reconciler-integration-test',
                    ${state},
                    ${sql.json({})},
                    ${sql.json({ kind: 'test' })},
                    ${sql.json({ kind: 'test' })},
                    '1',
                    NOW() + ${`${startedAtOffsetSeconds} seconds`}::interval,
                    'test-instance'
                )
            `;
        }
    }

    it('returns only rows that cross their respective age threshold — pins 5-min active and 3-min pending boundaries', async () => {
        // active, heartbeat 3 min ago — NOT stale (5-min threshold)
        await insertRow({
            id: `${ID_PREFIX}active_fresh`,
            state: 'active',
            heartbeatOffsetSeconds: -180, // 3 min ago
            startedAtOffsetSeconds: -600,
        });

        // active, heartbeat 6 min ago — STALE
        await insertRow({
            id: `${ID_PREFIX}active_stale`,
            state: 'active',
            heartbeatOffsetSeconds: -360, // 6 min ago
            startedAtOffsetSeconds: -600,
        });

        // pending, started 2 min ago — NOT stale (3-min threshold)
        await insertRow({
            id: `${ID_PREFIX}pending_fresh`,
            state: 'pending',
            startedAtOffsetSeconds: -120, // 2 min ago
        });

        // pending, started 4 min ago — STALE
        await insertRow({
            id: `${ID_PREFIX}pending_stale`,
            state: 'pending',
            startedAtOffsetSeconds: -240, // 4 min ago
        });

        const staleIds = await reconciler._queryStaleCandidatesForTest();

        // Filter to only our test rows so concurrent runs don't flap the test.
        const ourStaleIds = staleIds.filter((id) => id.startsWith(ID_PREFIX));

        expect(ourStaleIds).toContain(`${ID_PREFIX}active_stale`);
        expect(ourStaleIds).toContain(`${ID_PREFIX}pending_stale`);
        expect(ourStaleIds).not.toContain(`${ID_PREFIX}active_fresh`);
        expect(ourStaleIds).not.toContain(`${ID_PREFIX}pending_fresh`);
    }, 30_000);

    it('result is ordered by started_at ASC and respects LIMIT 1000', async () => {
        // Insert two stale pending rows at different started_at ages.
        await insertRow({
            id: `${ID_PREFIX}order_older`,
            state: 'pending',
            startedAtOffsetSeconds: -600, // 10 min ago — older
        });
        await insertRow({
            id: `${ID_PREFIX}order_newer`,
            state: 'pending',
            startedAtOffsetSeconds: -300, // 5 min ago — newer but still stale
        });

        const staleIds = await reconciler._queryStaleCandidatesForTest();
        const ourIds = staleIds.filter((id) => id.startsWith(ID_PREFIX));

        const olderIdx = ourIds.indexOf(`${ID_PREFIX}order_older`);
        const newerIdx = ourIds.indexOf(`${ID_PREFIX}order_newer`);

        expect(olderIdx).toBeGreaterThanOrEqual(0);
        expect(newerIdx).toBeGreaterThanOrEqual(0);
        // Older started_at comes first.
        expect(olderIdx).toBeLessThan(newerIdx);

        // LIMIT: the result must never exceed 1000 rows.
        expect(staleIds.length).toBeLessThanOrEqual(1000);
    }, 30_000);
});

// ── Fix C: cancel-grace candidate query ───────────────────────────────────────
//
// Validates (a) the 16.85.0 migration column `cancel_requested_at` exists in
// lumastra_tests, and (b) queryCancelGraceCandidateIds selects ONLY runs stuck
// in 'cancelling' past CANCEL_GRACE_MS — independent of heartbeat freshness, and
// excluding NULL cancel_requested_at (legacy) rows.

describe.runIf(RUN)('queryCancelGraceCandidateIds — cancel-grace boundary', () => {
    let sql: postgres.Sql;
    const P = 'run_test_cancelgrace_';

    beforeAll(async () => {
        sql = postgres(TEST_DATABASE_URL, { max: 4 });
    }, 30_000);

    afterAll(async () => {
        await sql.end();
    });

    afterEach(async () => {
        await sql`DELETE FROM task_history WHERE id LIKE ${P + '%'}`;
    });

    async function insertCancelling(opts: {
        id: string;
        /** Offset from NOW() in seconds for cancel_requested_at; undefined = NULL. */
        cancelRequestedOffsetSeconds?: number;
        /** Keep heartbeat FRESH to prove the query ignores it. */
        heartbeatOffsetSeconds?: number;
    }): Promise<void> {
        const { id, cancelRequestedOffsetSeconds, heartbeatOffsetSeconds = -5 } = opts;
        const cancelExpr =
            cancelRequestedOffsetSeconds === undefined
                ? sql`NULL`
                : sql`NOW() + ${`${cancelRequestedOffsetSeconds} seconds`}::interval`;
        await sql`
            INSERT INTO task_history
                (id, task_id, label, state, input, trigger, actor,
                 processing_version, started_at, heartbeat_at, cancel_requested_at,
                 owner_instance_id)
            VALUES (
                ${id}, 'cancelgrace-test', 'cancelgrace-test', 'cancelling',
                ${sql.json({})}, ${sql.json({ kind: 'test' })}, ${sql.json({ kind: 'test' })},
                '1',
                NOW() - '20 minutes'::interval,
                NOW() + ${`${heartbeatOffsetSeconds} seconds`}::interval,
                ${cancelExpr},
                'test-instance'
            )
        `;
    }

    it('selects cancelling runs past the grace, ignores fresh-cancel and NULL rows, even with a fresh heartbeat', async () => {
        const { queryCancelGraceCandidateIds } = await import('./run-liveness-authority.js');
        const { CANCEL_GRACE_MS } = await import('./recovery-thresholds.js');
        const graceSecs = CANCEL_GRACE_MS / 1000;

        // Stuck: cancel requested well past the grace, but heartbeat is FRESH
        // (5s ago) — this is exactly the lock-loss zombie the stale-heartbeat
        // reclaim cannot see. Must be selected.
        await insertCancelling({
            id: `${P}stuck`,
            cancelRequestedOffsetSeconds: -(graceSecs + 120),
            heartbeatOffsetSeconds: -5,
        });
        // Fresh cancel (just requested) — within grace, must NOT be selected.
        await insertCancelling({
            id: `${P}fresh`,
            cancelRequestedOffsetSeconds: -10,
        });
        // Legacy row cancelled before the column existed (NULL) — must NOT be
        // selected (covered instead by the stale-heartbeat reclaim once dead).
        await insertCancelling({ id: `${P}legacy_null` });

        const ids = await queryCancelGraceCandidateIds(sql, CANCEL_GRACE_MS);
        const ours = ids.filter((id) => id.startsWith(P));

        expect(ours).toContain(`${P}stuck`);
        expect(ours).not.toContain(`${P}fresh`);
        expect(ours).not.toContain(`${P}legacy_null`);
    }, 30_000);
});
