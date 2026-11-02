// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';

/** Fixed advisory-lock keys reserved for media-segment writes. */
const WRITE_GATE_NAMESPACE = 0x5e66;
const WRITE_GATE_KEY = 0;
const RESOLVE_LOCK_NAMESPACE = 0x5e67;
const ANALYZER_PLUGIN_ID = 'lumastra-intro-analyzer';
const GLOBAL_GENERATION_KEY = '__media_segment_generation';

/**
 * Block global destructive operations while a per-item segment writer runs.
 * Every writer takes this shared gate before any item lock or segment row.
 */
async function acquireSharedMediaSegmentWriteGate(tx: postgres.Sql): Promise<void> {
    await tx`
        SELECT pg_advisory_xact_lock_shared(
            ${WRITE_GATE_NAMESPACE},
            ${WRITE_GATE_KEY}
        )
    `;
}

/**
 * Exclude all per-item writers for a global wipe. The caller must acquire this
 * before selecting affected IDs, so first-time evidence writers cannot be
 * missed by the wipe snapshot.
 */
export async function acquireExclusiveMediaSegmentWriteGate(tx: postgres.Sql): Promise<void> {
    await tx`
        SELECT pg_advisory_xact_lock(
            ${WRITE_GATE_NAMESPACE},
            ${WRITE_GATE_KEY}
        )
    `;
}

/** Serialize candidate mutation and resolution for one media item. */
export async function acquireMediaSegmentResolutionLock(
    tx: postgres.Sql,
    mediaId: string,
): Promise<void> {
    await acquireMediaSegmentResolutionLocks(tx, [mediaId]);
}

/**
 * Acquire the shared global gate, then several per-media locks in stable order.
 * This order is load-bearing: every segment writer must take the gate before
 * item locks, and overlapping bulk writers must acquire item locks identically.
 */
export async function acquireMediaSegmentResolutionLocks(
    tx: postgres.Sql,
    mediaIds: readonly string[],
): Promise<void> {
    const orderedIds = [...new Set(mediaIds)].sort();
    if (orderedIds.length === 0) return;

    await acquireSharedMediaSegmentWriteGate(tx);
    await tx`
        SELECT pg_advisory_xact_lock(
            ${RESOLVE_LOCK_NAMESPACE},
            hashtext(lock_target.media_id)
        )
        FROM unnest(${orderedIds}::text[]) AS lock_target(media_id)
        ORDER BY lock_target.media_id
    `;
}

/** Invalidate detector work that started before a clear or file change. */
export async function bumpMediaSegmentAnalysisGeneration(
    tx: postgres.Sql,
    mediaIds: readonly string[],
): Promise<void> {
    if (mediaIds.length === 0) return;
    // Lock the rows in id order first: a bare multi-row UPDATE locks in plan
    // order, so two transactions bumping overlapping id sets could deadlock
    // (same ordering rule as lockArtworkOwners / the ancestor-chain writers).
    await tx`
        WITH locked AS MATERIALIZED (
            SELECT id FROM media_items
            WHERE id = ANY(${[...new Set(mediaIds)]}::uuid[])
            ORDER BY id
            FOR NO KEY UPDATE
        )
        UPDATE media_items
        SET media_segment_generation = gen_random_uuid(), updated_at = clock_timestamp()
        FROM locked
        WHERE media_items.id = locked.id
    `;
}

/** Durable fence for destructive operations that are not scoped to known IDs. */
export async function bumpGlobalMediaSegmentAnalysisGeneration(tx: postgres.Sql): Promise<void> {
    await tx`
        INSERT INTO plugin_settings (plugin_id, key, value, updated_at)
        VALUES (
            ${ANALYZER_PLUGIN_ID},
            ${GLOBAL_GENERATION_KEY},
            to_jsonb(gen_random_uuid()::text),
            clock_timestamp()
        )
        ON CONFLICT (plugin_id, key) DO UPDATE
        SET value = EXCLUDED.value,
            updated_at = EXCLUDED.updated_at
    `;
}

export async function getGlobalMediaSegmentAnalysisGeneration(
    sql: postgres.Sql,
): Promise<string | null> {
    const rows = await sql<Array<{ generation: string }>>`
        SELECT updated_at::text AS generation
        FROM plugin_settings
        WHERE plugin_id = ${ANALYZER_PLUGIN_ID}
          AND key = ${GLOBAL_GENERATION_KEY}
    `;
    return rows[0]?.generation ?? null;
}
