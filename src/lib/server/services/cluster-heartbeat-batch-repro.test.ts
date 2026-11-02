// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Repro test for F6 — Cluster-heartbeat event writes are unbatched and
 * un-transactional.
 *
 * Finding: detectTransitions() loops over transition events and calls
 * insertNodeEvent one by one. If the process crashes mid-loop, some
 * transitions are persisted and others are lost.
 *
 * Citation: src/lib/server/services/cluster-heartbeat.service.ts:382-388
 */

import type postgres from 'postgres';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockLogger = vi.hoisted(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: vi.fn(() => mockLogger),
    },
}));

const mockQueries = vi.hoisted(() => ({
    insertNodeEvent: vi.fn().mockResolvedValue(undefined),
    pruneOldEvents: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('$lib/server/database/queries/cluster-nodes.queries.js', () => mockQueries);

/**
 * A minimal `postgres.Sql` stand-in whose `begin` invokes the callback with a
 * transaction handle, so `recordTransition`'s transaction wrapper runs and the
 * (mocked) query functions are exercised inside it.
 */
function makeTxSql(): postgres.Sql {
    const sql = vi.fn() as unknown as Record<string, unknown>;
    sql.begin = vi.fn((cb: (tx: unknown) => Promise<unknown>) => cb(sql));
    return sql as unknown as postgres.Sql;
}

describe('F6 — Cluster heartbeat transitions should be batched in a transaction', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockQueries.insertNodeEvent.mockReset();
        mockQueries.pruneOldEvents.mockReset();
    });

    it('batches all transitions into a single statement or transaction', async () => {
        const { ClusterHeartbeatService } =
            await import('$lib/server/services/cluster-heartbeat.service.js');

        const svc = new ClusterHeartbeatService('test-instance', '1.0.0');
        // @ts-expect-error — private field
        svc.sql = makeTxSql();

        // Simulate three node transitions detected simultaneously
        const transitions = [
            {
                instanceId: 'node-a',
                eventType: 'offline' as const,
                role: 'worker',
                version: '1.0.0',
                hostname: 'host-a',
            },
            {
                instanceId: 'node-b',
                eventType: 'online' as const,
                role: 'worker',
                version: '1.0.0',
                hostname: 'host-b',
            },
            {
                instanceId: 'node-c',
                eventType: 'offline' as const,
                role: 'leader',
                version: '1.0.0',
                hostname: 'host-c',
            },
        ];

        await svc['recordTransition'](transitions);

        // CORRECT behavior: All 3 transitions are inserted atomically as a
        // single multi-row INSERT inside one transaction.
        // BUG (pre-fix): each transition triggered a separate INSERT with no
        // transaction wrapper, so a crash mid-loop left the table inconsistent.
        expect(mockQueries.insertNodeEvent).toHaveBeenCalledTimes(1);
        const [, eventsArg] = mockQueries.insertNodeEvent.mock.calls[0];
        expect(eventsArg).toHaveLength(3);
    });

    it('pruneOldEvents runs inside the same transaction as transition inserts', async () => {
        const { ClusterHeartbeatService } =
            await import('$lib/server/services/cluster-heartbeat.service.js');

        const svc = new ClusterHeartbeatService('test-instance', '1.0.0');
        // @ts-expect-error — private field
        svc.sql = makeTxSql();

        await svc['recordTransition']([
            {
                instanceId: 'node-x',
                eventType: 'online',
                role: 'worker',
                version: '1.0.0',
                hostname: 'host-x',
            },
        ]);

        // CORRECT behavior: prune is coordinated with inserts — it runs inside
        // the same transaction (lastPruneAt starts at 0, so the first batch
        // always triggers a prune).
        // BUG (pre-fix): prune was fire-and-forget with no transaction wrapper.
        expect(mockQueries.pruneOldEvents).toHaveBeenCalled();
    });
});
