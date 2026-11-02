// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi } from 'vitest';
import type postgres from 'postgres';
import {
    assertTaskValkeyData,
    assertTaskValkeyPolicy,
    configValue,
    keyspaceDatabases,
    TaskValkeyGuardError,
    type GuardValkeyDb,
} from './task-valkey-guard.js';

interface FakeServer {
    runId: string;
    /** INFO memory body; absent = the command fails. */
    memory?: string;
    config: Record<string, string>;
    dbs: Map<number, string[]>;
}

/** Enough of CONFIG GET / INFO / SCAN / DBSIZE for the guard. */
function fakeClient(server: FakeServer, db = 0): GuardValkeyDb {
    return {
        close: vi.fn(),
        customCommand: async (args: string[]): Promise<unknown> => {
            const [cmd, a1, , a3] = args;
            if (cmd === 'CONFIG') {
                if (!(a1 === 'GET' && args[2] in server.config)) return [];
                return [args[2], server.config[args[2]]];
            }
            if (cmd === 'INFO' && a1 === 'memory' && server.memory) return server.memory;
            if (cmd === 'INFO' && a1 === 'server') return `# Server\r\nrun_id:${server.runId}\r\n`;
            if (cmd === 'INFO' && a1 === 'keyspace') {
                const lines = ['# Keyspace'];
                for (const [n, keys] of server.dbs)
                    if (keys.length) lines.push(`db${n}:keys=${keys.length},expires=0`);
                return lines.join('\r\n');
            }
            if (cmd === 'DBSIZE') return (server.dbs.get(db) ?? []).length;
            if (cmd === 'SCAN') {
                const prefix = a3.replace(/\*$/, '');
                return ['0', (server.dbs.get(db) ?? []).filter((k) => k.startsWith(prefix))];
            }
            throw new Error(`unexpected ${args.join(' ')}`);
        },
    };
}

function server(overrides: Partial<FakeServer> = {}): FakeServer {
    return {
        runId: 'task-run',
        config: { 'maxmemory-policy': 'noeviction', appendonly: 'yes' },
        dbs: new Map(),
        ...overrides,
    };
}

function sqlReturning(row: { runs: number; owned: boolean }): postgres.Sql {
    return vi.fn(async () => [row]) as unknown as postgres.Sql;
}

describe('task Valkey policy guard', () => {
    it('passes for noeviction + AOF on a separate server', async () => {
        const warn = vi.fn();
        await assertTaskValkeyPolicy({
            task: fakeClient(server()),
            cache: fakeClient(server({ runId: 'cache-run' })),
            taskDatabase: 0,
            warn,
        });
        expect(warn).not.toHaveBeenCalled();
    });

    it('refuses an evicting task Valkey', async () => {
        const task = fakeClient(
            server({ config: { 'maxmemory-policy': 'allkeys-lru', appendonly: 'yes' } }),
        );
        await expect(
            assertTaskValkeyPolicy({ task, cache: null, taskDatabase: 0, env: {} }),
        ).rejects.toThrow(/maxmemory-policy is "allkeys-lru".*noeviction/);
    });

    it('refuses when CONFIG is unavailable, unless overridden', async () => {
        const task = fakeClient(server({ config: {} }));
        await expect(
            assertTaskValkeyPolicy({ task, cache: null, taskDatabase: 0, env: {} }),
        ).rejects.toBeInstanceOf(TaskValkeyGuardError);
        const warn = vi.fn();
        await assertTaskValkeyPolicy({
            task,
            cache: null,
            taskDatabase: 0,
            env: { LUMASTRA_ALLOW_EVICTING_TASK_VALKEY: 'true' },
            warn,
        });
        expect(warn).toHaveBeenCalled();
    });

    it('falls back to INFO memory when CONFIG is disabled (managed services)', async () => {
        const task = fakeClient(
            server({
                config: {},
                memory: '# Memory\r\nmaxmemory:1073741824\r\nmaxmemory_policy:noeviction\r\n',
            }),
        );
        await expect(
            assertTaskValkeyPolicy({ task, cache: null, taskDatabase: 0, env: {} }),
        ).resolves.toBeUndefined();
    });

    it('only warns for an evicting policy without any maxmemory limit', async () => {
        const warn = vi.fn();
        const task = fakeClient(
            server({
                config: { 'maxmemory-policy': 'allkeys-lru', maxmemory: '0', appendonly: 'yes' },
            }),
        );
        await assertTaskValkeyPolicy({ task, cache: null, taskDatabase: 0, env: {}, warn });
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('no maxmemory limit'));
    });

    it('warns (does not refuse) when AOF is off', async () => {
        const warn = vi.fn();
        await assertTaskValkeyPolicy({
            task: fakeClient(
                server({ config: { 'maxmemory-policy': 'noeviction', appendonly: 'no' } }),
            ),
            cache: null,
            taskDatabase: 0,
            warn,
        });
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining('without AOF'),
            expect.anything(),
        );
    });

    it('refuses two URLs that reach the same server (same run_id)', async () => {
        const shared = server();
        await expect(
            assertTaskValkeyPolicy({
                task: fakeClient(shared),
                cache: fakeClient(shared),
                taskDatabase: 0,
            }),
        ).rejects.toThrow(/SAME Valkey server/);
    });

    it('parses CONFIG GET replies in array, Map and record form', () => {
        expect(configValue(['maxmemory-policy', 'noeviction'], 'maxmemory-policy')).toBe(
            'noeviction',
        );
        expect(configValue(new Map([['appendonly', 'yes']]), 'appendonly')).toBe('yes');
        expect(configValue({ appendonly: 'no' }, 'appendonly')).toBe('no');
        // GLIDE's GlideRecord (RESP3 map form).
        expect(
            configValue([{ key: 'maxmemory-policy', value: 'noeviction' }], 'maxmemory-policy'),
        ).toBe('noeviction');
    });
});

describe('task Valkey data guard', () => {
    it('lists only databases holding keys', () => {
        expect(
            keyspaceDatabases(
                '# Keyspace\r\ndb0:keys=3,expires=0\r\ndb4:keys=0,expires=0\r\ndb7:keys=1,expires=1\r\n',
            ),
        ).toEqual([0, 7]);
    });

    it('refuses when the queues sit in another DB than TASK_CACHE_URL selects', async () => {
        // The web container already wrote a task:* key to the newly selected DB.
        const s = server({
            dbs: new Map([
                [0, ['task:queue-paused:io']],
                [1, ['bull:task:io:1', 'task:run:active:x']],
            ]),
        });
        const openDatabase = vi.fn(async (db: number) => fakeClient(s, db));
        await expect(
            assertTaskValkeyData({
                task: fakeClient(s, 0),
                cache: null,
                taskDatabase: 0,
                sql: sqlReturning({ runs: 0, owned: false }),
                openDatabase,
                env: {},
            }),
        ).rejects.toThrow(/selects database 0.*in database 1.*\.\.\.\/1/s);
        expect(openDatabase).toHaveBeenCalledWith(1);
    });

    it('passes when the selected DB holds the task data', async () => {
        const s = server({
            dbs: new Map([
                [0, ['bull:task:io:1']],
                [1, ['bull:old']],
            ]),
        });
        const openDatabase = vi.fn(async (db: number) => fakeClient(s, db));
        await assertTaskValkeyData({
            task: fakeClient(s, 0),
            cache: null,
            taskDatabase: 0,
            sql: sqlReturning({ runs: 5, owned: true }),
            openDatabase,
        });
        expect(openDatabase).not.toHaveBeenCalled();
    });

    it('refuses an EMPTY task store while Postgres has in-flight runs', async () => {
        const s = server();
        await expect(
            assertTaskValkeyData({
                task: fakeClient(s, 0),
                cache: null,
                taskDatabase: 0,
                sql: sqlReturning({ runs: 3, owned: false }),
                openDatabase: async (db) => fakeClient(s, db),
                env: {},
            }),
        ).rejects.toThrow(/holds no task data.*but 3 run\(s\).*--appendonly yes starts empty/s);
    });

    it('refuses a store holding only non-task keys (web/proxy wrote heartbeats first)', async () => {
        const s = server({
            dbs: new Map([
                [0, ['cluster:node:web-1', 'ratelimit:login:x:1', 'task:queue-paused:x']],
            ]),
        });
        await expect(
            assertTaskValkeyData({
                task: fakeClient(s, 0),
                cache: null,
                taskDatabase: 0,
                sql: sqlReturning({ runs: 1, owned: true }),
                openDatabase: async (db) => fakeClient(s, db),
                env: {},
            }),
        ).rejects.toThrow(/holds no task data/);
    });

    it('refuses an EMPTY task store when Postgres records task ownership', async () => {
        const s = server();
        await expect(
            assertTaskValkeyData({
                task: fakeClient(s, 0),
                cache: null,
                taskDatabase: 0,
                sql: sqlReturning({ runs: 0, owned: true }),
                openDatabase: async (db) => fakeClient(s, db),
                env: {},
            }),
        ).rejects.toThrow(/task_runtime_authorities/);
    });

    it('allows a fresh install (empty store, nothing in Postgres)', async () => {
        const s = server();
        await assertTaskValkeyData({
            task: fakeClient(s, 0),
            cache: null,
            taskDatabase: 0,
            sql: sqlReturning({ runs: 0, owned: false }),
            openDatabase: async (db) => fakeClient(s, db),
        });
    });

    it('LUMASTRA_ALLOW_EMPTY_TASK_VALKEY=true accepts the loss with a warning', async () => {
        const s = server();
        const warn = vi.fn();
        await assertTaskValkeyData({
            task: fakeClient(s, 0),
            cache: null,
            taskDatabase: 0,
            sql: sqlReturning({ runs: 2, owned: true }),
            openDatabase: async (db) => fakeClient(s, db),
            env: { LUMASTRA_ALLOW_EMPTY_TASK_VALKEY: 'true' },
            warn,
        });
        expect(warn).toHaveBeenCalledOnce();
    });
});
