// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * task-history-retention — index self-heal (ensureStartedIdIndex).
 *
 * Migration 16.126.0 SKIPS building idx_task_history_started_id on a very large
 * task_history and is then marked applied, so the index can be silently missing
 * forever. The daily retention task closes that loop by ensuring the index after
 * each trim. These tests verify:
 *
 *   1. Absent index  → builds it CONCURRENTLY (simple protocol, no transaction).
 *   2. Present+valid → no-ops (single catalog SELECT, NO DDL) — idempotent daily.
 *   3. Present+INVALID (interrupted CONCURRENTLY build) → DROPs then rebuilds.
 *   4. A DDL failure is swallowed (non-fatal) and reported as 'error'.
 *
 * The sql double distinguishes the catalog probe (tagged template containing
 * pg_index) from the CONCURRENTLY DDL (`sql.unsafe(...).simple()`).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';
import type { Logger } from '@sapd/lumastra-plugin-sdk';

// Suppress the module-load self-registration side effect.
vi.mock('$lib/server/tasks/registry.js', () => ({
    registry: { registerTask: vi.fn() },
    TaskRegistry: vi.fn(),
}));

// config.ts is huge — stub only what the module imports at load.
vi.mock('$lib/server/config.js', () => ({ LUMASTRA_TASK_HISTORY_HOT_DAYS: 30 }));

// Avoid pulling the real trim service (touches DB imports) into the unit test.
vi.mock('$lib/server/services/task-history-trim.service.js', () => ({
    trimTaskHistory: vi.fn(),
}));

import { ensureStartedIdIndex } from '../task-history-retention.js';

/**
 * Build an sql double.
 * @param probeRows rows the catalog probe (pg_index SELECT) returns.
 * @param opts.failUnsafe make `.simple()` reject (simulates a DDL failure).
 */
function makeSql(
    probeRows: Array<{ indisvalid: boolean }>,
    opts: { failUnsafe?: boolean } = {},
): { sql: postgres.Sql; unsafeCalls: string[] } {
    const unsafeCalls: string[] = [];
    const tag = (strings: TemplateStringsArray): Promise<unknown[]> => {
        const q = strings.join('?');
        if (q.includes('pg_index')) return Promise.resolve(probeRows);
        return Promise.resolve([]);
    };
    (tag as unknown as { unsafe: (q: string) => { simple: () => Promise<unknown> } }).unsafe = (
        q: string,
    ) => {
        unsafeCalls.push(q);
        return {
            simple: () =>
                opts.failUnsafe ? Promise.reject(new Error('DDL blew up')) : Promise.resolve([]),
        };
    };
    return { sql: tag as unknown as postgres.Sql, unsafeCalls };
}

function makeLogger(): Logger {
    return {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    } as unknown as Logger;
}

describe('task-history-retention: ensureStartedIdIndex', () => {
    beforeEach(() => vi.clearAllMocks());

    it('builds the index CONCURRENTLY when it is absent', async () => {
        const { sql, unsafeCalls } = makeSql([]); // no catalog row → absent
        const outcome = await ensureStartedIdIndex(sql, makeLogger());

        expect(outcome).toBe('created');
        expect(unsafeCalls).toHaveLength(1);
        expect(unsafeCalls[0]).toContain('CREATE INDEX CONCURRENTLY IF NOT EXISTS');
        expect(unsafeCalls[0]).toContain('idx_task_history_started_id');
        // Must NOT drop when there was nothing there.
        expect(unsafeCalls.some((q) => q.includes('DROP INDEX'))).toBe(false);
    });

    it('no-ops (no DDL) when the index already exists and is valid — idempotent daily run', async () => {
        const { sql, unsafeCalls } = makeSql([{ indisvalid: true }]);
        const outcome = await ensureStartedIdIndex(sql, makeLogger());

        expect(outcome).toBe('valid');
        // The steady-state path is a single catalog SELECT — zero DDL statements.
        expect(unsafeCalls).toHaveLength(0);
    });

    it('drops then rebuilds an INVALID index left by an interrupted CONCURRENTLY build', async () => {
        const logger = makeLogger();
        const { sql, unsafeCalls } = makeSql([{ indisvalid: false }]);
        const outcome = await ensureStartedIdIndex(sql, logger);

        expect(outcome).toBe('rebuilt');
        expect(unsafeCalls).toHaveLength(2);
        expect(unsafeCalls[0]).toContain('DROP INDEX CONCURRENTLY IF EXISTS');
        expect(unsafeCalls[1]).toContain('CREATE INDEX CONCURRENTLY IF NOT EXISTS');
        expect(logger.warn).toHaveBeenCalled();
    });

    it('swallows a DDL failure (non-fatal) and reports error', async () => {
        const logger = makeLogger();
        const { sql } = makeSql([], { failUnsafe: true });
        const outcome = await ensureStartedIdIndex(sql, logger);

        expect(outcome).toBe('error');
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('self-heal failed'),
            expect.objectContaining({ error: expect.stringContaining('DDL blew up') }),
        );
    });
});
