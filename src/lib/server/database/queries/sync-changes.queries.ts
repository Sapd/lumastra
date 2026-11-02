// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import { withTx } from '../with-tx.js';

/** Delete a position prefix, never timestamp-shaped holes in the retained log. */
export async function pruneSyncChanges(
    sql: postgres.Sql,
    cutoff: Date,
    batch = 10_000,
): Promise<number> {
    const [result] = await sql<{ count: number }[]>`
        WITH boundary AS MATERIALIZED (
            SELECT xid, seq FROM sync_changes WHERE recorded_at < ${cutoff}
            ORDER BY xid DESC, seq DESC LIMIT 1
        ), candidates AS MATERIALIZED (
            SELECT c.xid, c.seq FROM sync_changes c, boundary b
            WHERE (c.xid, c.seq) <= (b.xid, b.seq)
            ORDER BY c.xid, c.seq LIMIT ${batch}
        ), d AS (
            DELETE FROM sync_changes c USING candidates b
            WHERE c.xid = b.xid AND c.seq = b.seq RETURNING c.xid, c.seq
        ), last AS (
            SELECT xid, seq FROM d ORDER BY xid DESC, seq DESC LIMIT 1
        ), watermark AS (
            UPDATE sync_state s SET
                pruned_xid = GREATEST(s.pruned_xid, last.xid),
                pruned_seq = CASE
                    WHEN s.pruned_xid IS NULL OR (s.pruned_xid, s.pruned_seq) < (last.xid, last.seq)
                    THEN last.seq ELSE s.pruned_seq END
            FROM last WHERE s.id = 1 RETURNING s.id
        ) SELECT count(*)::int AS count FROM d
    `;
    return result.count;
}

/**
 * Run `fn` with change capture off and bump the epoch in the same transaction.
 * The bump comes last: it locks the single `sync_state` row until commit, and
 * taken first it serialised every concurrent caller for the whole of `fn`.
 */
export async function withSyncReset<T>(
    sql: postgres.Sql,
    fn: (sql: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
    return await withTx(sql, async (raw) => {
        const tx = raw as postgres.TransactionSql;
        await tx`SET LOCAL lumastra.sync_capture = 'off'`;
        const result = await fn(tx);
        await tx`UPDATE sync_state SET epoch = epoch + 1 WHERE id = 1`;
        return result;
    });
}

/**
 * Without pg_control_* permission, only xid regression can detect a restore;
 * a failover that preserves or advances the xid is then undetectable.
 */
export async function checkSyncInstance(sql: postgres.Sql): Promise<void> {
    await withTx(sql, async (tx) => {
        // Serialize boot checks before assigning an xid, including across replicas.
        await tx`SELECT pg_advisory_xact_lock(1937337955)`;
        let control: { system_identifier: string; timeline: number } | undefined;
        try {
            control = await withTx(tx, async (sp) => {
                const [row] = await sp<{ system_identifier: string; timeline: number }[]>`
                    SELECT s.system_identifier::text, c.timeline_id::int AS timeline
                    FROM pg_control_system() s, pg_control_checkpoint() c
                `;
                return row;
            });
        } catch (error) {
            if (
                typeof error !== 'object' ||
                error === null ||
                !('code' in error) ||
                error.code !== '42501'
            ) {
                throw error;
            }
        }
        const [state] = await tx<
            {
                system_identifier: string | null;
                timeline: number | null;
                last_seen_xid: string | null;
                current_xid: string;
            }[]
        >`
            SELECT system_identifier, timeline, last_seen_xid::text,
                pg_current_xact_id()::text AS current_xid
            FROM sync_state WHERE id = 1 FOR UPDATE
        `;
        if (!state) throw new Error('Library sync state is missing');
        const changed =
            (control !== undefined &&
                ((state.system_identifier !== null &&
                    state.system_identifier !== control.system_identifier) ||
                    (state.timeline !== null && state.timeline !== control.timeline))) ||
            (state.last_seen_xid !== null &&
                BigInt(state.current_xid) < BigInt(state.last_seen_xid));
        if (changed) {
            await tx`UPDATE sync_state SET epoch = epoch + 1, pruned_xid = NULL, pruned_seq = 0 WHERE id = 1`;
            await tx`DELETE FROM sync_changes`;
        }
        await tx`
            UPDATE sync_state SET last_seen_xid = ${state.current_xid}::xid8,
                system_identifier = COALESCE(${control?.system_identifier ?? null}, system_identifier),
                timeline = COALESCE(${control?.timeline ?? null}, timeline)
            WHERE id = 1
        `;
    });
}

export async function deleteSyncChangesForUser(sql: postgres.Sql, userId: string): Promise<number> {
    const rows = await sql`DELETE FROM sync_changes WHERE user_id = ${userId}::uuid`;
    return rows.count;
}
