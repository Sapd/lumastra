// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';
import { RunLivenessAuthority } from './run-liveness-authority.js';
import type { StateMachine } from './state-machine.js';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('$lib/server/cache/valkey.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/cache/valkey.js')>();
    return { ...actual, publishMessage: vi.fn(async () => 1) };
});

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
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
 * Minimal postgres.Sql-shaped mock. The reclaim UPDATE uses `RETURNING id`;
 * simulate a matched row so the reclaim path (and the terminal-hash write
 * under test) is actually exercised.
 */
function buildSqlMock(candidates: CandidateRow[]): postgres.Sql {
    const tag = vi.fn((...args: unknown[]) => {
        const parts = args[0] as TemplateStringsArray | string[];
        const query = Array.from(parts).join('?');
        if (query.includes('task_history') && query.includes('SELECT')) {
            return Promise.resolve(candidates);
        }
        if (
            query.includes('task_history') &&
            query.includes('UPDATE') &&
            query.includes('RETURNING')
        ) {
            return Promise.resolve([{ id: 'reclaimed' }]);
        }
        return Promise.resolve([]);
    });
    (tag as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
    (tag as unknown as { array: (v: unknown) => unknown }).array = (v: unknown) => v;
    return tag as unknown as postgres.Sql;
}

function makeStateMachine(): Pick<StateMachine, 'transitionRun'> {
    return {
        transitionRun: vi.fn(async () => ({ ok: true as const })),
    };
}

interface ValkeyLikeClient {
    customCommand: (cmd: string[]) => Promise<unknown>;
}

/**
 * Fake Valkey client. Tracks every EVAL of the orphan terminal-write script
 * (identified by the `task:run:terminal:` KEYS[1] arg) so tests can assert on
 * the exact state/error fields written, and every DEL of the active hash.
 */
function makeClient(): {
    getClient: () => Promise<ValkeyLikeClient>;
    terminalWrites: Array<{ key: string; state: string; errorMessage: string; ttlMs: string }>;
    activeDeletes: string[];
} {
    const terminalWrites: Array<{
        key: string;
        state: string;
        errorMessage: string;
        ttlMs: string;
    }> = [];
    const activeDeletes: string[] = [];

    const client: ValkeyLikeClient = {
        customCommand: vi.fn(async (cmd: string[]) => {
            const [op] = cmd;
            if (op === 'HEXISTS') {
                // Orphan: active hash is always absent by the time markFailed runs.
                return 0;
            }
            if (op === 'EVAL') {
                // cmd = ['EVAL', script, '1', key, state, errorMessage, ttlMs]
                const [, , , key, state, errorMessage, ttlMs] = cmd;
                terminalWrites.push({ key, state, errorMessage, ttlMs });
                return 1;
            }
            if (op === 'DEL') {
                activeDeletes.push(cmd[1]);
                return 1;
            }
            return null;
        }),
    };
    return { getClient: async () => client, terminalWrites, activeDeletes };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('RunLivenessAuthority — orphan reclaim terminal-hash write', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('cancelling-orphan reclaim writes the terminal hash with state=cancelled', async () => {
        const candidates: CandidateRow[] = [
            {
                id: 'run_cancelling_orphan',
                task_id: 'fake-task',
                state: 'cancelling',
                owner_instance_id: 'web-1',
            },
        ];
        const sql = buildSqlMock(candidates);
        const sm = makeStateMachine();
        const { getClient, terminalWrites, activeDeletes } = makeClient();

        const authority = new RunLivenessAuthority(sql, sm, getClient, () => undefined);

        const report = await authority.reclaimStaleRuns(['run_cancelling_orphan'], 'test');

        expect(report.reclaimed).toBe(1);
        expect(report.runIds).toEqual(['run_cancelling_orphan']);

        // The bug: this write never happened for the cancelling path, so
        // reseed-for-retry.lua's cancelled-run guard (which reads ONLY the
        // terminal hash) never saw state='cancelled' and a redelivered BullMQ
        // job could reseed the run 'pending' and re-execute it.
        expect(terminalWrites).toHaveLength(1);
        expect(terminalWrites[0].key).toBe('task:run:terminal:run_cancelling_orphan');
        expect(terminalWrites[0].state).toBe('cancelled');
        expect(terminalWrites[0].errorMessage).toBe('cancelling_orphan_at_recovery');

        // The active hash is still DEL'd, same as before the fix.
        expect(activeDeletes).toEqual(['task:run:active:run_cancelling_orphan']);

        // Dead-guard removal: transitionRun must never be called from markFailed
        // for an orphan reclaim (the active hash is already gone, so it would
        // only ever fail with 'run not found').
        expect(sm.transitionRun).not.toHaveBeenCalled();
    });

    it('active-orphan reclaim writes the terminal hash with state=failed (formerly dead branch)', async () => {
        const candidates: CandidateRow[] = [
            {
                id: 'run_active_orphan',
                task_id: 'fake-task',
                state: 'active',
                owner_instance_id: 'web-1',
                heartbeat_at: new Date(Date.now() - 2 * 60 * 60 * 1000),
            },
        ];
        const sql = buildSqlMock(candidates);
        const sm = makeStateMachine();
        const { getClient, terminalWrites } = makeClient();

        const authority = new RunLivenessAuthority(sql, sm, getClient, () => undefined);

        const report = await authority.reclaimStaleRuns(['run_active_orphan'], 'test');

        expect(report.reclaimed).toBe(1);
        expect(terminalWrites).toHaveLength(1);
        expect(terminalWrites[0].state).toBe('failed');
        expect(terminalWrites[0].errorMessage).toBe('orphaned_at_recovery');
        expect(sm.transitionRun).not.toHaveBeenCalled();
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
