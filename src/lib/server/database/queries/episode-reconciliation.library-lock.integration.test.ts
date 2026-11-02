// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getTestDatabaseUrl } from '../../../../../tests/integration/setup/test-database.js';
import { truncateAllTestTables } from '../../../../../tests/integration/helpers/cleanup.js';
import { lockReconciliationEvidence } from './episode-reconciliation.queries.js';
import { backfillLibraryGroupIdIfNull } from './media-items.queries.js';
import { restampLibraryPathFileGroups } from './library-paths.queries.js';
import { lockAncestorChain, propagateHasFiles } from './media-files.queries.js';

const url = getTestDatabaseUrl();

interface Gate {
    promise: Promise<void>;
    open: () => void;
}
function gate(): Gate {
    let open!: () => void;
    const promise = new Promise<void>((r) => (open = r));
    return { promise, open };
}

interface Series {
    seriesId: string;
    episodeId: string;
    fileId: string;
    filePath: string;
}

interface Reconciliation {
    pid: Promise<number>;
    /** Resolves once lockReconciliationEvidence returned (all locks held). */
    locked: Promise<void>;
    timeout: Promise<string>;
    release: () => void;
    done: Promise<void>;
}

describe('lockReconciliationEvidence library queue (real PostgreSQL)', () => {
    let sql: postgres.Sql; // fixtures + observer ("third connection")
    let conns: postgres.Sql[] = [];
    let groupId: string;

    function conn(): postgres.Sql {
        const c = postgres(url, { max: 1, onnotice: () => {} });
        conns.push(c);
        return c;
    }

    beforeAll(() => {
        sql = postgres(url, { max: 1, onnotice: () => {} });
    });
    beforeEach(async () => {
        await truncateAllTestTables(sql);
        groupId = randomUUID();
        await sql`INSERT INTO library_groups (id, name) VALUES (${groupId}, 'recon-lib-lock')`;
    });
    afterAll(async () => {
        await Promise.all([sql.end(), ...conns.map((c) => c.end())]);
    });

    async function seedSeries(name: string): Promise<Series> {
        const [{ id: seriesId }] = await sql<
            { id: string }[]
        >`INSERT INTO media_items (title, media_type, status, library_group_id) VALUES (${name}, 'tv', 'active', ${groupId}) RETURNING id`;
        const [{ id: seasonId }] = await sql<
            { id: string }[]
        >`INSERT INTO media_items (title, media_type, status, parent_id, season_number) VALUES ('Season', 'season', 'active', ${seriesId}, 1) RETURNING id`;
        const [{ id: episodeId }] = await sql<
            { id: string }[]
        >`INSERT INTO media_items (title, media_type, status, parent_id, season_number, episode_number) VALUES ('Ep', 'episode', 'active', ${seasonId}, 1, 1) RETURNING id`;
        const filePath = `/recon-lib/${name}/${episodeId}.mkv`;
        const [{ id: fileId }] = await sql<
            { id: string }[]
        >`INSERT INTO media_files (file_path, library_group_id) VALUES (${filePath}, ${groupId}) RETURNING id`;
        await sql`INSERT INTO media_file_items (media_item_id, file_id, is_default) VALUES (${episodeId}, ${fileId}, true)`;
        return { seriesId, episodeId, fileId, filePath };
    }

    /** Same preamble as the services: series advisory lock, then the evidence locks. */
    function reconcile(seriesId: string, lockTimeout = '10s'): Reconciliation {
        const db = conn();
        const hold = gate();
        const lockedGate = gate();
        let resolveTimeout!: (timeout: string) => void;
        const timeout = new Promise<string>((r) => (resolveTimeout = r));
        let resolvePid!: (pid: number) => void;
        const pid = new Promise<number>((r) => (resolvePid = r));
        const done = db
            .begin(async (txRaw) => {
                const tx = txRaw as unknown as postgres.Sql;
                const [{ pid: p }] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
                resolvePid(p);
                await tx`SELECT set_config('lock_timeout', ${lockTimeout}, true)`;
                await tx`SELECT pg_advisory_xact_lock(hashtext(${seriesId})::bigint)`;
                await lockReconciliationEvidence(tx, seriesId);
                const [setting] = await tx<{ lock_timeout: string }[]>`SHOW lock_timeout`;
                resolveTimeout(setting.lock_timeout);
                lockedGate.open();
                await hold.promise;
            })
            .then(() => undefined);
        // An unobserved rejection must not crash the runner before the test asserts on it.
        done.catch(() => lockedGate.open());
        return { pid, locked: lockedGate.promise, timeout, release: hold.open, done };
    }

    async function waitFor(check: () => Promise<boolean>, what: string): Promise<void> {
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
            if (await check()) return;
            await new Promise((r) => setTimeout(r, 50));
        }
        throw new Error(`timed out waiting for ${what}`);
    }

    async function waitingOnLock(pid: number): Promise<boolean> {
        const [{ n }] = await sql<
            { n: number }[]
        >`SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = ${pid} AND wait_event_type = 'Lock'`;
        return n > 0;
    }

    it('queues a second reconciliation of the same library on the advisory lock, holding no row locks', async () => {
        const a = await seedSeries('A');
        const b = await seedSeries('B');

        const r1 = reconcile(a.seriesId);
        await r1.locked;
        const r2 = reconcile(b.seriesId);
        const r2pid = await r2.pid;
        await waitFor(() => waitingOnLock(r2pid), 'R2 to queue');

        // R2 is waiting on an advisory lock ...
        const waits = await sql<
            { locktype: string }[]
        >`SELECT locktype FROM pg_locks WHERE pid = ${r2pid} AND NOT granted`;
        expect(waits.map((w) => w.locktype)).toEqual(['advisory']);

        // ... and holds no row locks: FOR UPDATE assigns an xid and holds a
        // `transactionid` lock on it. R1 (positive control) has one, R2 has none.
        const held = async (pid: number): Promise<number> =>
            (
                await sql<
                    { n: number }[]
                >`SELECT count(*)::int AS n FROM pg_locks WHERE pid = ${pid} AND locktype = 'transactionid' AND granted`
            )[0].n;
        expect(await held(await r1.pid)).toBeGreaterThan(0);
        expect(await held(r2pid)).toBe(0);

        // Behavioural proof: a provider_metadata write for B's episode (needs FOR KEY SHARE on
        // the episode row, which a FOR UPDATE would block) completes immediately.
        const writer = conn();
        await writer.begin(async (tx) => {
            await tx`SELECT set_config('lock_timeout', '2s', true)`;
            await tx`INSERT INTO provider_metadata (media_id, provider, metadata) VALUES (${b.episodeId}, 'tmdb', '{}'::jsonb)`;
        });
        // R2 is still queued behind R1 afterwards.
        expect(await waitingOnLock(r2pid)).toBe(true);

        r1.release();
        await r1.done;
        await r2.locked;
        r2.release();
        await r2.done;
    });

    it("waits beyond the caller's 10s timeout in the library queue and restores it", async () => {
        const a = await seedSeries('long-A');
        const b = await seedSeries('long-B');
        const r1 = reconcile(a.seriesId);
        let r2: Reconciliation | undefined;
        try {
            await r1.locked;
            r2 = reconcile(b.seriesId);
            const pid = await r2.pid;
            await waitFor(() => waitingOnLock(pid), 'R2 to queue');
            const queuedAt = Date.now();
            await new Promise((r) => setTimeout(r, 11_000));
            expect(await waitingOnLock(pid)).toBe(true);
            r1.release();
            await r1.done;
            await r2.locked;
            expect(Date.now() - queuedAt).toBeGreaterThan(10_000);
            await expect(r2.timeout).resolves.toBe('10s');
            r2.release();
            await r2.done;
        } finally {
            r1.release();
            r2?.release();
            await Promise.allSettled([r1.done, ...(r2 ? [r2.done] : [])]);
        }
    }, 25_000);

    it('restores the shorter caller timeout before waiting on evidence row locks', async () => {
        const a = await seedSeries('row-timeout');
        const blocker = conn();
        const held = gate();
        const release = gate();
        const blocking = blocker.begin(async (tx) => {
            await tx`SELECT id FROM media_items WHERE id = ${a.seriesId} FOR UPDATE`;
            held.open();
            await release.promise;
        });
        let reconciliation: Reconciliation | undefined;
        try {
            await held.promise;
            const startedAt = Date.now();
            reconciliation = reconcile(a.seriesId, '100ms');
            await expect(reconciliation.done).rejects.toMatchObject({ code: '55P03' });
            expect(Date.now() - startedAt).toBeLessThan(2_000);
        } finally {
            release.open();
            reconciliation?.release();
            await blocking;
        }
    });

    it('does not make reconciliations of different libraries wait for each other', async () => {
        const a = await seedSeries('A');
        const otherGroup = randomUUID();
        await sql`INSERT INTO library_groups (id, name) VALUES (${otherGroup}, 'recon-lib-lock-other')`;
        const c = await seedSeries('C');
        await sql`UPDATE media_items SET library_group_id = ${otherGroup} WHERE id = ${c.seriesId}`;
        await sql`UPDATE media_files SET library_group_id = ${otherGroup} WHERE id = ${c.fileId}`;

        const r1 = reconcile(a.seriesId);
        await r1.locked;
        const r2 = reconcile(c.seriesId);
        await r2.locked; // would hang if the key were not per library
        r1.release();
        r2.release();
        await Promise.all([r1.done, r2.done]);
    });

    it('does not deadlock with writers that lock media rows first and FK-check the group', async () => {
        const a = await seedSeries('A');
        const b = await seedSeries('B');
        // A discovery stub with no group, adopted by the scanner (backfill).
        const [{ id: stubId }] = await sql<
            { id: string }[]
        >`INSERT INTO media_items (title, media_type, status) VALUES ('Stub', 'movie', 'active') RETURNING id`;

        // R1 holds everything, including library_groups ... FOR UPDATE.
        const r1 = reconcile(a.seriesId);
        await r1.locked;

        // Writers: row lock on a media row first, then FK KEY SHARE on the group -> they wait on R1.
        const restamp = conn();
        const backfill = conn();
        // The restamp only touches rows whose group differs, so unstamp B's file first.
        await sql`UPDATE media_files SET library_group_id = NULL WHERE id = ${b.fileId}`;
        const restampRealDone = restampLibraryPathFileGroups(restamp, b.filePath, groupId);
        const backfillDone = backfillLibraryGroupIdIfNull(backfill, stubId, groupId);
        await waitFor(async () => {
            const [{ n }] = await sql<
                { n: number }[]
            >`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%UPDATE media_%'`;
            return n >= 2;
        }, 'writers to block on the group');

        // R2 (series B, same library) now queues behind R1 on the advisory lock only.
        const r2 = reconcile(b.seriesId);
        const r2pid = await r2.pid;
        await waitFor(() => waitingOnLock(r2pid), 'R2 to queue');

        r1.release();
        const results = await Promise.allSettled([
            r1.done,
            restampRealDone,
            backfillDone,
            r2.locked,
        ]);
        r2.release();
        results.push(...(await Promise.allSettled([r2.done])));
        const failures = results.filter((r) => r.status === 'rejected');
        expect(failures.map((f) => String((f as PromiseRejectedResult).reason))).toEqual([]);
        expect(await restampRealDone).toBe(1);
        const [stub] = await sql<
            { library_group_id: string | null }[]
        >`SELECT library_group_id FROM media_items WHERE id = ${stubId}`;
        expect(stub.library_group_id).toBe(groupId);
    });

    /** Series whose ids sort episode < season < series, the order that exposed the cycle. */
    async function seedOrderedSeries(n: number): Promise<{ seriesId: string; episodeId: string }> {
        const id = (part: string): string => `${part}000000-0000-4000-8000-00000000000${n}`;
        const seriesId = id('ff');
        const seasonId = id('88');
        const episodeId = id('00');
        await sql`INSERT INTO media_items (id, title, media_type, status, library_group_id) VALUES (${seriesId}, ${`O${n}`}, 'tv', 'active', ${groupId})`;
        await sql`INSERT INTO media_items (id, title, media_type, status, parent_id, season_number) VALUES (${seasonId}, 'Season', 'season', 'active', ${seriesId}, 1)`;
        await sql`INSERT INTO media_items (id, title, media_type, status, parent_id, season_number, episode_number, has_files) VALUES (${episodeId}, 'Ep', 'episode', 'active', ${seasonId}, 1, 1, false)`;
        return { seriesId, episodeId };
    }

    it('takes the lowest-id media row first and holds no other row lock while waiting for it', async () => {
        const a = await seedOrderedSeries(1);
        // A chain writer holds the episode (lowest id) and has not yet reached season/series.
        const writer = conn();
        const held = gate();
        const release = gate();
        const writing = writer.begin(async (tx) => {
            await tx`SELECT id FROM media_items WHERE id = ${a.episodeId} FOR NO KEY UPDATE`;
            held.open();
            await release.promise;
        });
        let r: Reconciliation | undefined;
        try {
            await held.promise;
            r = reconcile(a.seriesId);
            const pid = await r.pid;
            await waitFor(() => waitingOnLock(pid), 'reconciliation to wait on the episode');
            const [{ n }] = await sql<
                { n: number }[]
            >`SELECT count(*)::int AS n FROM pg_locks WHERE pid = ${pid} AND locktype = 'transactionid' AND granted`;
            // Old order: it held series + season rows here and the writer's next step deadlocked.
            expect(n).toBe(0);
        } finally {
            release.open();
            await writing;
            await r?.locked;
            r?.release();
            await Promise.allSettled(r ? [r.done] : []);
        }
    });

    it('reconciliations and chain writers on one library all succeed, repeatedly', async () => {
        const a = await seedOrderedSeries(1);
        const b = await seedOrderedSeries(2);
        for (let round = 0; round < 5; round++) {
            const run = (seriesId: string): Promise<void> =>
                conn().begin(async (txRaw) => {
                    const tx = txRaw as unknown as postgres.Sql;
                    await tx`SELECT set_config('lock_timeout', '10s', true)`;
                    await tx`SELECT pg_advisory_xact_lock(hashtext(${seriesId})::bigint)`;
                    await lockReconciliationEvidence(tx, seriesId);
                }) as unknown as Promise<void>;
            const write = (episodeId: string): Promise<void> =>
                conn().begin(async (tx) => {
                    await tx`SELECT set_config('lock_timeout', '10s', true)`;
                    await lockAncestorChain(tx, [episodeId]);
                    await propagateHasFiles(tx, episodeId);
                }) as unknown as Promise<void>;
            const results = await Promise.allSettled([
                run(a.seriesId),
                run(b.seriesId),
                write(a.episodeId),
                write(b.episodeId),
                run(a.seriesId),
            ]);
            expect(
                results.flatMap((x) => (x.status === 'rejected' ? [String(x.reason)] : [])),
            ).toEqual([]);
            await sql`UPDATE media_items SET has_files = false WHERE id IN (${a.episodeId}, ${b.episodeId})`;
        }
    });
});
