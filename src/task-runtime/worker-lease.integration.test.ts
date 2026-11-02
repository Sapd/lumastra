// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../tests/integration/setup/test-database.js';
import { WorkerLease, type WorkerLeaseOptions } from './worker-lease.js';

let sql: postgres.Sql;
const names = new Set<string>();
const leases = new Set<WorkerLease>();

function leaseName(): string {
    const name = `test-${randomUUID()}`.slice(0, 60);
    names.add(name);
    return name;
}

function lease(
    name: string,
    holderId: string,
    options: WorkerLeaseOptions = {},
    client: postgres.Sql = sql,
): WorkerLease {
    const value = new WorkerLease(client, {
        name,
        holderId,
        hostname: `host-${holderId}`,
        pid: 4242,
        leaseMs: 30_000,
        renewMs: 1_000,
        retryMs: 100,
        ...options,
    });
    leases.add(value);
    return value;
}

beforeAll(() => {
    sql = getTestDb();
});

afterEach(async () => {
    for (const value of leases) value.stop();
    leases.clear();
    if (names.size) await sql`DELETE FROM task_worker_lease WHERE name = ANY(${[...names]})`;
    names.clear();
});

afterAll(async () => {
    await closeTestDb();
});

describe('WorkerLease against PostgreSQL', () => {
    it('refuses a second worker while the first holds the lease, then hands over on release', async () => {
        const name = leaseName();
        const first = lease(name, 'worker-a');
        const second = lease(name, 'worker-b');

        expect(await first.tryAcquire()).toEqual({ acquired: true });
        const refused = await second.tryAcquire();
        expect(refused.acquired).toBe(false);
        if (!refused.acquired) {
            expect(refused.holder?.holderId).toBe('worker-a');
            expect(refused.holder?.hostname).toBe('host-worker-a');
        }
        expect(second.isHeld()).toBe(false);
        expect(second.state()).toMatchObject({
            held: false,
            holder: expect.stringContaining('worker-a'),
            since: expect.any(String),
        });
        expect(first.state()).toMatchObject({ held: true, holder: expect.stringContaining('worker-a') });

        // A waiting worker keeps retrying and takes over once the holder releases.
        const waiting = second.acquire();
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(second.isHeld()).toBe(false);
        await first.release();
        await waiting;
        expect(second.isHeld()).toBe(true);
        const [row] = await sql<{ holder_id: string }[]>`
            SELECT holder_id FROM task_worker_lease WHERE name = ${name}
        `;
        expect(row.holder_id).toBe('worker-b');
    });

    it('lets a successor take an expired lease of a worker that stopped renewing', async () => {
        const name = leaseName();
        const crashed = lease(name, 'worker-a', { leaseMs: 1_000, renewMs: 200 });
        const successor = lease(name, 'worker-b', { leaseMs: 1_000, renewMs: 200 });
        expect((await crashed.tryAcquire()).acquired).toBe(true);
        crashed.stop(); // a crash: the row stays but is no longer renewed
        expect((await successor.tryAcquire()).acquired).toBe(false);
        await new Promise((resolve) => setTimeout(resolve, 1_200));
        expect((await successor.tryAcquire()).acquired).toBe(true);
    });

    it('keeps a renewed lease beyond its initial duration', async () => {
        const name = leaseName();
        const holder = lease(name, 'worker-a', { leaseMs: 1_500, renewMs: 300 });
        const peer = lease(name, 'worker-b', { leaseMs: 1_500, renewMs: 300 });
        expect((await holder.tryAcquire()).acquired).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 2_500));
        expect(holder.isHeld()).toBe(true);
        expect((await peer.tryAcquire()).acquired).toBe(false);
    });

    it('reports a takeover to the holder through onLost', async () => {
        const name = leaseName();
        const reasons: string[] = [];
        const holder = lease(name, 'worker-a', {
            renewMs: 200,
            onLost: (reason) => reasons.push(reason),
        });
        expect((await holder.tryAcquire()).acquired).toBe(true);
        await sql`UPDATE task_worker_lease SET holder_id = 'worker-b' WHERE name = ${name}`;
        await new Promise((resolve) => setTimeout(resolve, 600));
        expect(reasons).toEqual(['lease expired or taken over']);
        expect(holder.isHeld()).toBe(false);
        // Release never deletes a row another worker now owns.
        await holder.release();
        const [row] = await sql<{ holder_id: string }[]>`
            SELECT holder_id FROM task_worker_lease WHERE name = ${name}
        `;
        expect(row.holder_id).toBe('worker-b');
    });

    it('fences a takeover by generation even when the holder id is the same', async () => {
        const name = leaseName();
        const reasons: string[] = [];
        const holder = lease(name, 'worker-a', {
            renewMs: 200,
            onLost: (reason) => reasons.push(reason),
        });
        expect((await holder.tryAcquire()).acquired).toBe(true);
        const [before] = await sql<{ generation: string }[]>`
            SELECT generation::text AS generation FROM task_worker_lease WHERE name = ${name}
        `;
        // Same id, newer generation: e.g. a restarted process reusing its id.
        await sql`UPDATE task_worker_lease SET generation = generation + 1 WHERE name = ${name}`;
        await new Promise((resolve) => setTimeout(resolve, 600));
        expect(reasons).toEqual(['lease expired or taken over']);
        expect(holder.isHeld()).toBe(false);
        // Release never deletes the newer generation's row.
        await holder.release();
        const [after] = await sql<{ generation: string }[]>`
            SELECT generation::text AS generation FROM task_worker_lease WHERE name = ${name}
        `;
        expect(BigInt(after.generation)).toBe(BigInt(before.generation) + 1n);
    });

    it('bumps the generation on every takeover', async () => {
        const name = leaseName();
        const first = lease(name, 'worker-a');
        const second = lease(name, 'worker-b');
        expect((await first.tryAcquire()).acquired).toBe(true);
        await first.release();
        expect((await second.tryAcquire()).acquired).toBe(true);
        const [row] = await sql<{ generation: string }[]>`
            SELECT generation::text AS generation FROM task_worker_lease WHERE name = ${name}
        `;
        // release deleted the row, so the successor starts a fresh row at 1;
        // an expiry takeover (row kept) must increment instead.
        expect(row.generation).toBe('1');
        const third = lease(name, 'worker-c', { leaseMs: 1_000, renewMs: 200 });
        second.stop();
        await sql`UPDATE task_worker_lease SET lease_until = clock_timestamp() WHERE name = ${name}`;
        expect((await third.tryAcquire()).acquired).toBe(true);
        const [taken] = await sql<{ generation: string; holder_id: string }[]>`
            SELECT generation::text AS generation, holder_id FROM task_worker_lease WHERE name = ${name}
        `;
        expect(taken).toEqual({ generation: '2', holder_id: 'worker-c' });
    });

    it('reports a local renewal time next to the database one', async () => {
        const name = leaseName();
        const holder = lease(name, 'worker-a', { renewMs: 200 });
        const before = Date.now();
        expect((await holder.tryAcquire()).acquired).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 500));
        const state = holder.state();
        expect(state.held).toBe(true);
        const local = Date.parse(state.lastRenewLocalAt ?? '');
        expect(local).toBeGreaterThanOrEqual(before);
        expect(local).toBeLessThanOrEqual(Date.now());
    });

    it('bounds release on a hung connection and reports UNKNOWN', async () => {
        const name = leaseName();
        let paused = false;
        const hung = ((...args: Parameters<postgres.Sql>) =>
            paused
                ? new Promise<never>(() => {})
                : (sql as unknown as (...a: Parameters<postgres.Sql>) => unknown)(
                      ...args,
                  )) as unknown as postgres.Sql;
        const holder = lease(name, 'worker-a', { leaseMs: 1_500, renewMs: 200 }, hung);
        expect((await holder.tryAcquire()).acquired).toBe(true);
        paused = true;
        const started = performance.now();
        await expect(holder.release()).rejects.toThrow('UNKNOWN');
        expect(performance.now() - started).toBeLessThan(4_000);
        // The row is left to expire by itself.
        const [row] = await sql<{ holder_id: string }[]>`
            SELECT holder_id FROM task_worker_lease WHERE name = ${name}
        `;
        expect(row.holder_id).toBe('worker-a');
    }, 10_000);

    it('declares loss before the lease can expire while renewals hang', async () => {
        const name = leaseName();
        let paused = false;
        // After acquisition the holder's connection stops answering.
        const hung = ((...args: Parameters<postgres.Sql>) =>
            paused
                ? new Promise<never>(() => {})
                : (sql as unknown as (...a: Parameters<postgres.Sql>) => unknown)(
                      ...args,
                  )) as unknown as postgres.Sql;
        let lostAt: number | null = null;
        // lease 3s, threshold 3s - max(1s, 0.6s) = 2s.
        const holder = lease(
            name,
            'worker-a',
            {
                leaseMs: 3_000,
                renewMs: 300,
                onLost: () => {
                    lostAt = performance.now();
                },
            },
            hung,
        );
        const peer = lease(name, 'worker-b', { leaseMs: 3_000 });
        const start = performance.now();
        expect((await holder.tryAcquire()).acquired).toBe(true);
        paused = true;
        let peerAt: number | null = null;
        while (performance.now() - start < 6_000) {
            if ((await peer.tryAcquire()).acquired) {
                peerAt = performance.now();
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(peerAt).not.toBeNull();
        expect(lostAt).not.toBeNull();
        expect(lostAt!).toBeLessThan(peerAt!);
        expect(lostAt! - start).toBeLessThan(3_000);
        expect(holder.isHeld()).toBe(false);
    }, 15_000);
});
