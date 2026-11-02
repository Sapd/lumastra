// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The task-store boot guard against the real servers: both Valkeys up (passes),
 * two URLs that reach ONE server (run_id refusal, which URL comparison cannot
 * see), and the empty-store refusal driven by real in-flight task_history rows.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import IORedis from 'ioredis';
import postgres from 'postgres';
import { getTestDatabaseUrl } from '../../../../tests/integration/setup/test-database.js';
import {
    assertTaskValkeyData,
    assertTaskValkeyPolicy,
    type GuardValkey,
} from './task-valkey-guard.js';

type ValkeyModule = typeof import('./valkey.js');

const sql = postgres(getTestDatabaseUrl(), { max: 2 });
const historyIds: string[] = [];
const redises: IORedis[] = [];
let valkey: ValkeyModule;

function guardClient(redis: IORedis): GuardValkey {
    return {
        customCommand: (args: string[]) => redis.call(args[0], ...args.slice(1)),
    };
}

/** An empty task store: DBSIZE 0, no keys anywhere. */
const emptyStore: GuardValkey & { close(): void } = {
    close: () => undefined,
    customCommand: async (args: string[]): Promise<unknown> => {
        if (args[0] === 'DBSIZE') return 0;
        if (args[0] === 'SCAN') return ['0', []];
        if (args[0] === 'INFO') return '# Keyspace\r\n';
        throw new Error(`unexpected ${args[0]}`);
    },
};

beforeAll(async () => {
    expect(process.env.TEST_TASK_CACHE_URL, 'An isolated task store is required').toBeTruthy();
    vi.resetModules();
    valkey = await import('./valkey.js');
    expect(await valkey.connectValkey()).toBe(true);
});

afterAll(async () => {
    for (const id of historyIds) await sql`DELETE FROM task_history WHERE id = ${id}`;
    for (const redis of redises) redis.disconnect();
    await valkey?.disconnectValkey();
    await sql.end();
});

describe('task Valkey boot guard (real servers)', () => {
    it('passes the policy checks against the configured task + cache Valkeys', async () => {
        // The runner's task Valkey is noeviction; AOF may be off (warning only).
        await expect(valkey.guardTaskValkey()).resolves.toBeUndefined();
    });

    it('refuses two connections that reach the SAME server (identical run_id)', async () => {
        const url = process.env.TEST_TASK_CACHE_URL!;
        const a = new IORedis(url);
        const b = new IORedis(url.replace('127.0.0.1', 'localhost'));
        redises.push(a, b);
        await expect(
            assertTaskValkeyPolicy({
                task: guardClient(a),
                cache: guardClient(b),
                taskDatabase: 0,
            }),
        ).rejects.toThrow(/SAME Valkey server/);
    });

    it('refuses an empty task store while Postgres has an in-flight run', async () => {
        const runId = randomUUID();
        historyIds.push(runId);
        await sql`INSERT INTO task_history (id, task_id, label, state, input, trigger, actor, processing_version)
            VALUES (${runId}, 'guard-fixture', 'fixture', 'pending', '{}', '{"kind":"manual"}', '{"type":"system"}', 1)`;
        await expect(
            assertTaskValkeyData({
                task: emptyStore,
                cache: null,
                taskDatabase: 0,
                sql,
                openDatabase: async () => emptyStore,
                env: {},
            }),
        ).rejects.toThrow(/holds no task data.*but \d+ run\(s\)/s);
    });

    it('does not refuse a non-empty task store (the real one)', async () => {
        const redis = new IORedis(process.env.TEST_TASK_CACHE_URL!);
        redises.push(redis);
        const key = `task:run:active:guard-itest-${randomUUID()}`;
        await redis.set(key, '1', 'EX', 60);
        try {
            await expect(
                assertTaskValkeyData({
                    task: guardClient(redis),
                    cache: null,
                    taskDatabase: Number(
                        new URL(process.env.TEST_TASK_CACHE_URL!).pathname.slice(1) || 0,
                    ),
                    sql,
                    // Other slots' databases are not ours to judge; treat them as empty.
                    openDatabase: async () => emptyStore,
                }),
            ).resolves.toBeUndefined();
        } finally {
            await redis.del(key);
        }
    });
});
