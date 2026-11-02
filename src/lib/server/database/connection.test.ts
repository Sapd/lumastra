// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Characterization tests for getDb()/getTaskDb()'s try/catch.
 *
 * `postgres()` is lazy: it never opens a socket or validates the connection
 * string synchronously — it just builds a callable "sql" tag function. That
 * means a bad DATABASE_URL can NEVER be caught by getDb()/getTaskDb()'s
 * try/catch (which only guards the synchronous `connectPool()` call); the
 * failure only surfaces later, on the first real query. These tests document
 * that behavior (no behavior change) so it doesn't get "fixed" by accident in
 * a way that changes the null-vs-throw contract callers rely on.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const queryImpl = vi.fn();
const poolEnds: Array<ReturnType<typeof vi.fn<() => Promise<void>>>> = [];

vi.mock('postgres', () => {
    const factory = vi.fn((_url: string, _opts: unknown) => {
        // Mimic postgres.js: calling the returned handle as a tagged template
        // issues a query. We route it through `queryImpl` so tests can control
        // whether it resolves or rejects.
        const sql = (strings: TemplateStringsArray, ...values: unknown[]): unknown =>
            queryImpl(strings, values);
        const end = vi.fn(async (): Promise<void> => {});
        poolEnds.push(end);
        return Object.assign(sql, { end });
    });
    return { default: factory };
});

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

describe('getDb/getTaskDb — postgres() laziness characterization', () => {
    beforeEach(() => {
        vi.resetModules();
        queryImpl.mockReset();
        poolEnds.length = 0;
        // Default: the lazy timezone-verification query inside connectPool()
        // resolves so it doesn't spam warnings unrelated to the assertion.
        queryImpl.mockResolvedValue([{ tz: 'UTC', current_time: '2026-01-01' }]);
    });

    afterEach(() => {
        if (ORIGINAL_DATABASE_URL === undefined) {
            delete process.env.DATABASE_URL;
        } else {
            process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
        }
    });

    test('a bad DATABASE_URL does NOT throw in getDb() — postgres() never validates the URL synchronously', async () => {
        process.env.DATABASE_URL = 'postgres://bad-user:bad-pass@nonexistent-host:5432/nope';

        const { getDb } = await import('./connection.js');

        let sql: unknown;
        expect(() => {
            sql = getDb();
        }).not.toThrow();
        expect(sql).not.toBeNull();
    });

    test('the returned handle errors on first query, not on getDb()', async () => {
        process.env.DATABASE_URL = 'postgres://bad-user:bad-pass@nonexistent-host:5432/nope';
        const connectionError = new Error('getaddrinfo ENOTFOUND nonexistent-host');

        const { getDb } = await import('./connection.js');
        const sql = getDb();
        expect(sql).not.toBeNull();

        // Now simulate the real failure mode: the first actual query issued
        // through the handle rejects — this is where a bad URL truly surfaces.
        queryImpl.mockRejectedValueOnce(connectionError);
        type TaggedSql = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
        const taggedSql = sql as unknown as TaggedSql;
        await expect(taggedSql(Object.assign([''], { raw: [''] }))).rejects.toThrow(
            'getaddrinfo ENOTFOUND nonexistent-host',
        );
    });

    test('same laziness holds for getTaskDb()', async () => {
        process.env.DATABASE_URL = 'postgres://bad-user:bad-pass@nonexistent-host:5432/nope';

        const { getTaskDb } = await import('./connection.js');

        let sql: unknown;
        expect(() => {
            sql = getTaskDb();
        }).not.toThrow();
        expect(sql).not.toBeNull();
    });

    test('getDb() returns null (not throw) when DATABASE_URL is unset — unrelated to the laziness gap', async () => {
        delete process.env.DATABASE_URL;

        const { getDb } = await import('./connection.js');
        expect(getDb()).toBeNull();
    });

    test('a missing pool has a structured dependency error for auth callers', async () => {
        delete process.env.DATABASE_URL;
        const { Database } = await import('./connection.js');
        expect(() => new Database()).toThrow(
            expect.objectContaining({ code: 'CONNECTION_CLOSED' }),
        );
    });

    test('getDb() catch branch still guards a synchronous connectPool() failure (e.g. postgres() itself throwing)', async () => {
        process.env.DATABASE_URL = 'postgres://user:pass@host:5432/db';
        const postgresModule = await import('postgres');
        const factory = postgresModule.default as unknown as ReturnType<typeof vi.fn>;
        factory.mockImplementationOnce(() => {
            throw new Error('synchronous connectPool failure');
        });

        const { getDb } = await import('./connection.js');
        let sql: unknown;
        expect(() => {
            sql = getDb();
        }).not.toThrow();
        expect(sql).toBeNull();
    });

    test('terminal close joins pending closure and refuses every lazy getter before and after acknowledgement', async () => {
        process.env.DATABASE_URL = 'postgres://user:pass@host:5432/db';
        const db = await import('./connection.js');
        const getters = [db.getDb, db.getTaskDb, db.getAdminDb, db.getHeartbeatDb];
        for (const get of getters) expect(get()).not.toBeNull();
        let finish!: () => void;
        poolEnds[1].mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    finish = resolve;
                }),
        );
        const first = db.closeDb();
        const second = db.closeDb();
        expect(second).toBe(first);
        let settled = false;
        void first.then(() => {
            settled = true;
        });
        try {
            await Promise.resolve();
            expect(settled).toBe(false);
            for (const get of getters) expect(get()).toBeNull();
            expect(poolEnds).toHaveLength(4);
        } finally {
            finish();
            await first;
        }
        for (const get of getters) expect(get()).toBeNull();
        await db.closeDb();
        for (const end of poolEnds) expect(end).toHaveBeenCalledOnce();
        expect(poolEnds).toHaveLength(4);
    });

    test('awaits independent closures and retries only failed ownership after synchronous and asynchronous errors', async () => {
        process.env.DATABASE_URL = 'postgres://user:pass@host:5432/db';
        const db = await import('./connection.js');
        db.getDb();
        db.getTaskDb();
        db.getAdminDb();
        db.getHeartbeatDb();
        const webError = new Error('web close rejected');
        const adminError = new Error('admin close threw');
        poolEnds[0].mockRejectedValueOnce(webError);
        poolEnds[2].mockImplementationOnce(() => {
            throw adminError;
        });
        let finish!: () => void;
        poolEnds[3].mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    finish = resolve;
                }),
        );
        const closing = db.closeDb();
        const result = closing.catch((error: unknown) => error);
        let settled = false;
        void result.then(() => {
            settled = true;
        });
        try {
            await Promise.resolve();
            await Promise.resolve();
            expect(settled).toBe(false);
            expect(db.getTaskDb()).toBeNull();
        } finally {
            finish();
        }
        expect(await result).toMatchObject({ errors: [webError, adminError] });
        expect(poolEnds).toHaveLength(4);
        await db.closeDb();
        expect(poolEnds.map((end) => end.mock.calls.length)).toEqual([2, 1, 2, 1]);
        await db.closeDb();
        expect(poolEnds.map((end) => end.mock.calls.length)).toEqual([2, 1, 2, 1]);
        expect(db.getDb()).toBeNull();
    });

    test('closing before first use creates no pool and remains terminal', async () => {
        process.env.DATABASE_URL = 'postgres://user:pass@host:5432/db';
        const db = await import('./connection.js');
        await db.closeDb();
        expect([db.getDb(), db.getTaskDb(), db.getAdminDb(), db.getHeartbeatDb()]).toEqual([
            null,
            null,
            null,
            null,
        ]);
        await db.closeDb();
        expect(poolEnds).toHaveLength(0);
    });
});
