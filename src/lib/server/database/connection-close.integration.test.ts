// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import postgres from 'postgres';
import { randomInt } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
    vi.unstubAllEnvs();
});

it('acknowledges actual owned pool session closure without lazy replacement', async () => {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error('Run with the sanctioned integration database');
    const name = new URL(url).pathname.slice(1);
    if (!name.startsWith('lumastra_t_') && name !== 'lumastra_tests')
        throw new Error('Refusing non-test database');
    vi.stubEnv('DATABASE_URL', url);
    for (const pool of ['WEB', 'TASK', 'ADMIN', 'HEARTBEAT'])
        vi.stubEnv(`LUMASTRA_DB_POOL_${pool}_MAX`, '1');
    // A fresh module lifetime owns only these test pools. The integration
    // harness retains its original module/observer handles and is not closed.
    vi.resetModules();
    const db = await import('./connection.js');
    const observer = postgres(url, { max: 1, connect_timeout: 5 });
    const lockId = randomInt(1, 2 ** 30);
    let lockHeld = false;
    const failures: unknown[] = [];
    try {
        const pools = [db.getDb(), db.getTaskDb(), db.getAdminDb(), db.getHeartbeatDb()];
        const pids: number[] = [];
        for (const pool of pools) {
            if (!pool) throw new Error('Required owned pool missing');
            const [row] = await pool<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
            pids.push(row.pid);
        }
        expect(new Set(pids).size).toBe(4);
        const [before] = await observer<{ count: number }[]>`
            SELECT count(*)::int AS count FROM pg_stat_activity WHERE pid = ANY(${pids})
        `;
        expect(before.count).toBe(4);
        // Hold a real task query at a server-side lock. This proves close waits
        // for already-issued SQL, rather than merely observing idle sockets.
        await observer`SELECT pg_advisory_lock(780914, ${lockId}::int)`;
        lockHeld = true;
        const taskPool = pools[1]!;
        const query = taskPool`SELECT pg_advisory_xact_lock(780914, ${lockId}::int)`.then(
            () => undefined,
        );
        const outcome = query.then(
            () => ({ ok: true as const }),
            (error: unknown) => ({ ok: false as const, error }),
        );
        await expect
            .poll(
                async () => {
                    const [row] = await observer<{ waiting: boolean }[]>`
                SELECT EXISTS(SELECT 1 FROM pg_stat_activity
                    WHERE pid = ${pids[1]} AND wait_event_type = 'Lock') AS waiting
            `;
                    return row.waiting;
                },
                { timeout: 5000 },
            )
            .toBe(true);
        const closing = db.closeDb();
        let closed = false;
        void closing.then(
            () => {
                closed = true;
            },
            () => {
                closed = true;
            },
        );
        expect([db.getDb(), db.getTaskDb(), db.getAdminDb(), db.getHeartbeatDb()]).toEqual([
            null,
            null,
            null,
            null,
        ]);
        await observer`SELECT 1`;
        expect(closed).toBe(false);
        await observer`SELECT pg_advisory_unlock(780914, ${lockId}::int)`;
        lockHeld = false;
        expect(await outcome).toEqual({ ok: true });
        await closing;
        // Server activity can lag socket close briefly; observe the actual
        // known sessions rather than equating a cleared JS reference with drain.
        await expect
            .poll(
                async () => {
                    const [row] = await observer<{ count: number }[]>`
                SELECT count(*)::int AS count FROM pg_stat_activity WHERE pid = ANY(${pids})
            `;
                    return row.count;
                },
                { timeout: 5000 },
            )
            .toBe(0);
        await db.closeDb();
        expect(db.getTaskDb()).toBeNull();
    } catch (error) {
        failures.push(error);
    } finally {
        if (lockHeld) {
            try {
                await observer`SELECT pg_advisory_unlock(780914, ${lockId}::int)`;
            } catch (error) {
                failures.push(error);
            }
        }
        for (const result of await Promise.allSettled([db.closeDb(), observer.end({ timeout: 5 })]))
            if (result.status === 'rejected') failures.push(result.reason as unknown);
    }
    if (failures.length) throw new AggregateError(failures, 'Owned pool fixture failed');
}, 30_000);
