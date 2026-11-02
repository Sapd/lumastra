// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Two overlapping deleteStaleMediaFile transactions for sibling episodes (the
 * watcher fires handleUnlink for every file of a removed folder at once). Each
 * recomputes has_files for its chain. With the chain lock and the re-derive in
 * ONE statement, the loser of the lock race evaluated its EXISTS subqueries with
 * the pre-wait snapshot and wrote back `true` from file links the winner had
 * just deleted and committed (prod 2026-10-10: Utena, Blue Seed).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import { isInOpenTransaction } from '../with-tx.js';
import {
    deleteStaleMediaFile,
    lockAncestorChain,
    recomputeHasFilesBatch,
} from './media-files.queries.js';

describe('has_files recompute under overlapping file deletions', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
    });

    async function item(mediaType: string, parentId: string | null): Promise<string> {
        const [row] = await sql<{ id: string }[]>`
            INSERT INTO media_items (media_type, title, status, has_files, parent_id)
            VALUES (${mediaType}, 'Fixture', 'active', true, ${parentId}) RETURNING id`;
        return row.id;
    }

    // Only one link per item may be the default (idx_media_file_items_one_default).
    async function linkedFile(path: string, itemId: string, isDefault = true): Promise<void> {
        const [f] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path) VALUES (${path}) RETURNING id`;
        await sql`
            INSERT INTO media_file_items (file_id, media_item_id, is_default)
            VALUES (${f.id}, ${itemId}, ${isDefault})`;
    }

    async function hasFiles(ids: string[]): Promise<Map<string, boolean>> {
        const rows = await sql<{ id: string; has_files: boolean }[]>`
            SELECT id, has_files FROM media_items WHERE id = ANY(${ids}::uuid[])`;
        return new Map(rows.map((r) => [r.id, r.has_files]));
    }

    // Wait until THE given backend is blocked on a lock, so the test never relies on
    // a sleep to know the second transaction is queued behind the first. Matching
    // the pid (not "any ungranted lock") keeps other sessions on the same cluster,
    // e.g. other runner slots, from satisfying the wait.
    async function waitForBackendBlocked(getPid: () => number): Promise<void> {
        for (let i = 0; i < 200; i++) {
            const pid = getPid();
            if (pid !== 0) {
                // Blocked on a lock AND running the chain-lock statement (not, say, a
                // trigger inside B's DELETE), or B's snapshot would postdate A's commit.
                const [row] = await sql<{ n: number }[]>`
                    SELECT count(*)::int AS n
                    FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
                    WHERE l.pid = ${pid} AND NOT l.granted
                      AND a.query LIKE '%FOR NO KEY UPDATE%'`;
                if (row.n > 0) return;
            }
            await new Promise((r) => setTimeout(r, 20));
        }
        throw new Error('transaction B never blocked on the chain lock');
    }

    // The pre-fix implementation: chain lock and re-derive in ONE statement.
    // Kept only as the negative control that proves the harness reproduces the race.
    async function legacySingleStatementRecompute(t: postgres.Sql, ep: string): Promise<void> {
        await t`
            WITH RECURSIVE chain AS (
                SELECT id, parent_id, 1 AS depth FROM media_items WHERE id = ANY(${[ep]}::uuid[])
                UNION ALL
                SELECT mi.id, mi.parent_id, c.depth + 1
                FROM media_items mi JOIN chain c ON mi.id = c.parent_id
                WHERE c.depth < 10
            ),
            affected AS MATERIALIZED (
                SELECT id FROM media_items
                WHERE id IN (SELECT id FROM chain)
                ORDER BY id
                FOR NO KEY UPDATE
            )
            UPDATE media_items target
            SET has_files = (
                EXISTS (SELECT 1 FROM media_file_items mfi WHERE mfi.media_item_id = target.id)
                OR EXISTS (
                    SELECT 1 FROM media_items child
                    JOIN media_file_items mfi ON mfi.media_item_id = child.id
                    WHERE child.parent_id = target.id
                )
                OR EXISTS (
                    SELECT 1 FROM media_items child
                    JOIN media_items grandchild ON grandchild.parent_id = child.id
                    JOIN media_file_items mfi ON mfi.media_item_id = grandchild.id
                    WHERE child.parent_id = target.id
                )
            )
            FROM affected
            WHERE target.id = affected.id AND NOT target.is_dismissed`;
    }

    async function overlappingDeletes(
        recompute: (tx: postgres.Sql, ep: string) => Promise<void>,
    ): Promise<Record<'episode1' | 'episode2' | 'season' | 'series', boolean | undefined>> {
        const series = await item('tv', null);
        const season = await item('season', series);
        const ep1 = await item('episode', season);
        const ep2 = await item('episode', season);
        await linkedFile('/fixtures/race-1.mkv', ep1);
        await linkedFile('/fixtures/race-2.mkv', ep2);

        let releaseA!: () => void;
        const aMayCommit = new Promise<void>((r) => (releaseA = r));
        let bPid = 0;
        let aRecomputed!: () => void;
        const aDone = new Promise<void>((r) => (aRecomputed = r));

        // Tx A: delete file 1, recompute (takes the chain lock), then hold it.
        const txA = sql.begin(async (tx) => {
            const t = tx as unknown as postgres.Sql;
            await t`DELETE FROM media_files WHERE file_path = '/fixtures/race-1.mkv'`;
            await recompute(t, ep1);
            aRecomputed();
            await aMayCommit;
        });
        const results: PromiseSettledResult<unknown>[] = [];
        let txB: Promise<unknown> | undefined;
        try {
            // If A fails before holding its lock, surface that error instead of
            // waiting forever on aDone.
            const aFailed = new Promise<void>((_, reject) => {
                txA.catch(reject);
            });
            aFailed.catch(() => undefined); // never leave this branch unhandled
            await Promise.race([aDone, aFailed]);

            // Tx B: delete file 2, then recompute. Its snapshot is taken while A is
            // uncommitted, so file 1's link is still visible to it; the chain lock
            // then queues it behind A.
            txB = sql.begin(async (tx) => {
                const t = tx as unknown as postgres.Sql;
                const [me] = await t<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
                bPid = me.pid;
                await t`DELETE FROM media_files WHERE file_path = '/fixtures/race-2.mkv'`;
                await recompute(t, ep2);
            });
            const bFinishedEarly = txB.then(() => {
                throw new Error('transaction B finished without ever blocking');
            });
            await Promise.race([waitForBackendBlocked(() => bPid), bFinishedEarly]);
            releaseA();
            results.push(...(await Promise.allSettled([txA, txB])));
        } finally {
            releaseA();
            await Promise.allSettled([txA, txB ?? Promise.resolve()]);
        }
        expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);

        const byId = await hasFiles([series, season, ep1, ep2]);
        return {
            episode1: byId.get(ep1),
            episode2: byId.get(ep2),
            season: byId.get(season),
            series: byId.get(series),
        };
    }

    it('leaves no ancestor has_files=true once every file is gone', async () => {
        const state = await overlappingDeletes((t, ep) => recomputeHasFilesBatch(t, [ep]));
        expect(state).toEqual({ episode1: false, episode2: false, season: false, series: false });
    });

    it('negative control: the pre-fix single-statement SQL leaves ancestors true in this harness', async () => {
        // If this ever stops holding, the harness no longer reproduces the race and
        // the test above guards nothing.
        const state = await overlappingDeletes(legacySingleStatementRecompute);
        expect(state).toEqual({ episode1: false, episode2: false, season: true, series: true });
    });

    // Smoke test: nothing forces these twelve transactions to interleave, so this
    // can pass on the old code too. The deterministic test above is the guard.
    it('is also correct through deleteStaleMediaFile on the pool', async () => {
        const series = await item('tv', null);
        const season = await item('season', series);
        const eps: string[] = [];
        for (let i = 0; i < 12; i++) {
            const ep = await item('episode', season);
            eps.push(ep);
            await linkedFile(`/fixtures/race-del-${i}.mkv`, ep);
        }

        await Promise.all(
            eps.map((_, i) => deleteStaleMediaFile(sql, `/fixtures/race-del-${i}.mkv`)),
        );

        const byId = await hasFiles([season, series, ...eps]);
        expect([...byId.values()].every((v) => v === false)).toBe(true);
    });

    it('keeps ancestors true while any sibling file remains, then clears them', async () => {
        const series = await item('tv', null);
        const season = await item('season', series);
        const ep = await item('episode', season);
        await linkedFile('/fixtures/multi-a.mkv', ep);
        await linkedFile('/fixtures/multi-b.mkv', ep, false);

        await deleteStaleMediaFile(sql, '/fixtures/multi-a.mkv');
        expect([...(await hasFiles([series, season, ep])).values()]).toEqual([true, true, true]);

        await deleteStaleMediaFile(sql, '/fixtures/multi-b.mkv');
        expect([...(await hasFiles([series, season, ep])).values()]).toEqual([false, false, false]);
    });

    it('does not touch a dismissed ancestor', async () => {
        const series = await item('tv', null);
        const season = await item('season', series);
        const ep = await item('episode', season);
        await linkedFile('/fixtures/dismissed.mkv', ep);
        await sql`UPDATE media_items SET is_dismissed = true WHERE id = ${season}`;

        await sql`DELETE FROM media_files WHERE file_path = '/fixtures/dismissed.mkv'`;
        await recomputeHasFilesBatch(sql, [ep]);

        const byId = await hasFiles([series, season, ep]);
        expect(byId.get(ep)).toBe(false);
        expect(byId.get(series)).toBe(false);
        expect(byId.get(season)).toBe(true);
    });

    it('does not end a caller-managed transaction on a reserved connection', async () => {
        // worker-task merges and the series-sync relink run on a ReservedSql inside
        // withTx's manual BEGIN. recomputeHasFilesBatch must not open its own
        // BEGIN/COMMIT there, or it commits the caller's transaction early.
        const series = await item('tv', null);
        const season = await item('season', series);
        const ep = await item('episode', season);
        await linkedFile('/fixtures/reserved.mkv', ep);

        const reserved = await sql.reserve();
        try {
            await reserved`BEGIN`;
            await reserved`DELETE FROM media_files WHERE file_path = '/fixtures/reserved.mkv'`;
            await recomputeHasFilesBatch(reserved as unknown as postgres.Sql, [ep]);
            await reserved`ROLLBACK`;
        } catch (err) {
            await reserved`ROLLBACK`.catch(() => undefined);
            throw err;
        } finally {
            reserved.release();
        }

        // The caller's ROLLBACK must have undone both the delete and the recompute.
        const [files] = await sql<{ n: number }[]>`
            SELECT count(*)::int AS n FROM media_files WHERE file_path = '/fixtures/reserved.mkv'`;
        expect(files.n).toBe(1);
        expect([...(await hasFiles([series, season, ep])).values()]).toEqual([true, true, true]);
    });

    it('isInOpenTransaction tells the three handle kinds and both reserved states apart', async () => {
        expect(await isInOpenTransaction(sql)).toBe(false); // pool: autocommit

        await sql.begin(async (tx) => {
            expect(await isInOpenTransaction(tx as unknown as postgres.Sql)).toBe(true);
        });

        const reserved = await sql.reserve();
        try {
            const handle = reserved as unknown as postgres.Sql;
            expect(await isInOpenTransaction(handle)).toBe(false); // reserved, autocommit
            await reserved`BEGIN`;
            expect(await isInOpenTransaction(handle)).toBe(true); // reserved, manual BEGIN
            await reserved`ROLLBACK`;
            expect(await isInOpenTransaction(handle)).toBe(false);
        } finally {
            reserved.release();
        }
    });

    it('is correct on a reserved connection in autocommit', async () => {
        // e.g. mergeInto's recompute after the merge's own transaction has committed.
        const series = await item('tv', null);
        const season = await item('season', series);
        const ep = await item('episode', season);
        await linkedFile('/fixtures/reserved-auto.mkv', ep);
        await sql`DELETE FROM media_files WHERE file_path = '/fixtures/reserved-auto.mkv'`;

        const reserved = await sql.reserve();
        try {
            await recomputeHasFilesBatch(reserved as unknown as postgres.Sql, [ep]);
        } finally {
            reserved.release();
        }

        expect([...(await hasFiles([series, season, ep])).values()]).toEqual([false, false, false]);
    });

    it('rewrites only the rows whose has_files actually changes', async () => {
        const series = await item('tv', null);
        const season = await item('season', series);
        const ep = await item('episode', season);
        const other = await item('episode', season);
        await linkedFile('/fixtures/keep.mkv', ep);
        await linkedFile('/fixtures/drop.mkv', other);

        const versions = async (): Promise<Map<string, string>> => {
            const rows = await sql<{ id: string; xmin: string }[]>`
                SELECT id, xmin::text AS xmin FROM media_items
                WHERE id = ANY(${[series, season, ep, other]}::uuid[])`;
            return new Map(rows.map((x) => [x.id, x.xmin]));
        };

        // Nothing changed: every row already has the right value, none is rewritten.
        const before = await versions();
        await recomputeHasFilesBatch(sql, [ep]);
        expect(await versions()).toEqual(before);

        // One episode loses its file: only that episode is rewritten; the season
        // and series still have a file, so they keep their row versions.
        await sql`DELETE FROM media_files WHERE file_path = '/fixtures/drop.mkv'`;
        await recomputeHasFilesBatch(sql, [other]);
        const after = await versions();
        expect(after.get(other)).not.toBe(before.get(other));
        expect(after.get(ep)).toBe(before.get(ep));
        expect(after.get(season)).toBe(before.get(season));
        expect(after.get(series)).toBe(before.get(series));
        expect((await hasFiles([other])).get(other)).toBe(false);
    });

    it('is correct when called with the pool, not a transaction', async () => {
        const series = await item('tv', null);
        const season = await item('season', series);
        const ep = await item('episode', season);
        await linkedFile('/fixtures/pool.mkv', ep);

        await sql`DELETE FROM media_files WHERE file_path = '/fixtures/pool.mkv'`;
        await recomputeHasFilesBatch(sql, [ep]);

        expect([...(await hasFiles([series, season, ep])).values()]).toEqual([false, false, false]);
    });

    async function reparentWhileWaiting(dismissSeason: boolean): Promise<void> {
        // A series merge re-points a season while a file removal waits for the
        // chain lock. The waiter locked the OLD chain; the new parent must still be
        // re-derived once it notices.
        const oldSeries = await item('tv', null);
        const newSeries = await item('tv', null);
        await sql`UPDATE media_items SET has_files = false WHERE id = ${newSeries}`;
        const season = await item('season', oldSeries);
        const ep = await item('episode', season);
        await linkedFile('/fixtures/reparent.mkv', ep);
        if (dismissSeason)
            await sql`UPDATE media_items SET is_dismissed = true WHERE id = ${season}`;

        let releaseR!: () => void;
        const rMayCommit = new Promise<void>((r) => (releaseR = r));
        let rHolds!: () => void;
        const rHoldsLock = new Promise<void>((r) => (rHolds = r));
        const txR = sql.begin(async (tx) => {
            const t = tx as unknown as postgres.Sql;
            await t`UPDATE media_items SET parent_id = ${newSeries} WHERE id = ${season}`;
            rHolds();
            await rMayCommit;
        });
        let recompute: Promise<void> | undefined;
        try {
            await rHoldsLock;
            recompute = recomputeHasFilesBatch(sql, [ep]);
            // B queues behind R on the season row.
            for (let i = 0; i < 200; i++) {
                const [row] = await sql<{ n: number }[]>`
                    SELECT count(*)::int AS n
                    FROM pg_stat_activity
                    WHERE datname = current_database()
                      AND wait_event_type = 'Lock'
                      AND query LIKE '%FOR NO KEY UPDATE%'`;
                if (row.n > 0) break;
                if (i === 199) throw new Error('the recompute never blocked on the chain lock');
                await new Promise((r) => setTimeout(r, 20));
            }
        } finally {
            releaseR();
        }
        await Promise.all([txR, recompute]);

        const byId = await hasFiles([oldSeries, newSeries, season, ep]);
        expect({
            oldSeries: byId.get(oldSeries),
            newSeries: byId.get(newSeries),
            season: byId.get(season),
            episode: byId.get(ep),
        }).toEqual({ oldSeries: false, newSeries: true, season: true, episode: true });
    }

    it('re-derives the NEW parent when a season is re-parented while the lock is awaited', async () => {
        await reparentWhileWaiting(false);
    });

    it('also detects the re-parenting of a dismissed season (skipped by the UPDATE)', async () => {
        await reparentWhileWaiting(true);
    });

    it('lockAncestorChain over a union of chains never deadlocks transactions that pair them in any order', async () => {
        const series = await item('tv', null);
        const seasonA = await item('season', series);
        const seasonB = await item('season', series);
        const eps: string[] = [];
        for (let i = 0; i < 6; i++) eps.push(await item('episode', i % 2 ? seasonA : seasonB));

        const errors: unknown[] = [];
        await Promise.all(
            eps.flatMap((from, i) =>
                eps
                    .filter((_, j) => j !== i)
                    .map((to) =>
                        sql
                            .begin(async (tx) => {
                                await lockAncestorChain(tx as unknown as postgres.Sql, [from, to]);
                                await recomputeHasFilesBatch(tx as unknown as postgres.Sql, [
                                    from,
                                    to,
                                ]);
                            })
                            .catch((err: unknown) => errors.push(err)),
                    ),
            ),
        );

        expect(errors.map((e) => String(e))).toEqual([]);
    });
});
