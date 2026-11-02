// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Library → Fix matches personal media decisions: Keep and Restore coordinate
 * with automatic matching, while the dismiss restore helper remains the undo
 * half of `dismissMediaItemWithChildren` in media-items.queries.ts.
 */

import type postgres from 'postgres';
import { withTx } from '$lib/server/database/with-tx.js';
import { recomputeHasFilesBatch } from './media-files.queries.js';

export type KeepPersonalMediaResult = 'kept' | 'not_found' | 'ineligible' | 'rematch_busy';

/**
 * Persist an explicit Keep decision without changing the media item or its files.
 * The item row lock is shared with automatic matching and dedup merge guards.
 */
export async function keepPersonalMediaItem(
    sql: postgres.Sql,
    id: string,
    decidedBy: string,
): Promise<KeepPersonalMediaResult> {
    const normalizedId = id.toLowerCase();
    return withTx(sql, async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        // Match scanner rematch's connection-scoped claim. If a provider lookup
        // is underway, Keep must fail truthfully and leave the row available for
        // retry rather than racing a later automatic link/detach.
        const [claim] = await tx<{ acquired: boolean }[]>`
            SELECT pg_try_advisory_xact_lock(hashtext(${'personal-media-rematch:' + normalizedId})) AS acquired
        `;
        if (!claim?.acquired) return 'rematch_busy';
        // eslint-disable-next-line callback-safety/no-unscoped-media-items -- admin-only Keep endpoint: this locked identity lookup enforces the operator's explicit disposition and is not a viewer catalog query.
        const [item] = await tx<{ id: string }[]>`
            SELECT id FROM media_items WHERE id = ${normalizedId} FOR UPDATE
        `;
        if (!item) return 'not_found';

        const [existing] = await tx<{ media_id: string }[]>`
            SELECT media_id FROM personal_media_dispositions
            WHERE media_id = ${normalizedId} AND disposition = 'kept'
        `;
        if (existing) return 'kept';

        // eslint-disable-next-line callback-safety/no-unscoped-media-items -- admin-only Keep endpoint: eligibility must inspect the full owned tree and file links so the explicit operator decision is not scoped to the requesting viewer.
        const eligible = await tx<{ id: string }[]>`
            SELECT mi.id
            FROM media_items mi
            WHERE mi.id = ${normalizedId}
              AND mi.parent_id IS NULL
              AND mi.status = 'active'
              AND NOT mi.is_dismissed
              AND NOT EXISTS (SELECT 1 FROM external_ids ei WHERE ei.media_id = mi.id AND ei.source IS DISTINCT FROM 'watch-sync-file')
              AND (
                  EXISTS (SELECT 1 FROM media_file_items mfi WHERE mfi.media_item_id = mi.id)
                  OR EXISTS (
                      SELECT 1 FROM media_items season
                      JOIN media_items ep ON ep.parent_id = season.id AND ep.media_type = 'episode'
                      JOIN media_file_items mfi ON mfi.media_item_id = ep.id
                      WHERE season.parent_id = mi.id AND season.media_type = 'season'
                  )
              )
        `;
        if (!eligible.length) return 'ineligible';

        await tx`
            INSERT INTO personal_media_dispositions (media_id, disposition, decided_by)
            VALUES (${normalizedId}, 'kept', ${decidedBy})
            ON CONFLICT (media_id) DO NOTHING
        `;
        return 'kept';
    });
}

/** Hold source and ancestor advisory locks across a provider rematch, without a transaction. */
export async function claimPersonalMediaRematch(
    sql: postgres.Sql,
    itemIds: string[],
): Promise<{ sql: postgres.Sql; release: () => Promise<void> } | null> {
    const reserved = await sql.reserve();
    const lockedIds: string[] = [];
    try {
        const rows = await reserved<{ id: string }[]>`
            WITH RECURSIVE item_chain AS (
                SELECT id, parent_id FROM media_items WHERE id = ANY(${itemIds}::uuid[])
                UNION
                SELECT parent.id, parent.parent_id
                FROM media_items parent
                JOIN item_chain child ON child.parent_id = parent.id
            )
            SELECT DISTINCT id FROM item_chain ORDER BY id
        `;
        for (const { id } of rows) {
            const [claim] = await reserved<{ acquired: boolean }[]>`
                SELECT pg_try_advisory_lock(hashtext(${'personal-media-rematch:' + id})) AS acquired
            `;
            if (!claim?.acquired) throw new Error('rematch_busy');
            lockedIds.push(id);
        }
        const [kept] = await reserved<{ kept: boolean }[]>`
            SELECT EXISTS (
                SELECT 1 FROM personal_media_dispositions
                WHERE media_id = ANY(${lockedIds}::uuid[]) AND disposition = 'kept'
            ) AS kept
        `;
        if (kept?.kept) throw new Error('kept');
        let released = false;
        return {
            sql: reserved as unknown as postgres.Sql,
            release: async () => {
                if (released) return;
                released = true;
                try {
                    for (const id of [...lockedIds].reverse()) {
                        await reserved`SELECT pg_advisory_unlock(hashtext(${'personal-media-rematch:' + id}))`;
                    }
                } catch (err) {
                    try {
                        await reserved`SELECT pg_terminate_backend(pg_backend_pid())`;
                    } catch {
                        // The connection may already be gone.
                    }
                    throw err;
                } finally {
                    reserved.release();
                }
            },
        };
    } catch (err) {
        try {
            for (const id of [...lockedIds].reverse()) {
                await reserved`SELECT pg_advisory_unlock(hashtext(${'personal-media-rematch:' + id}))`;
            }
        } catch {
            // Never return a connection carrying a session lock to the pool.
            // Terminating its own backend makes the pool discard that socket.
            try {
                await reserved`SELECT pg_terminate_backend(pg_backend_pid())`;
            } catch {
                // The socket may already be gone.
            }
        } finally {
            reserved.release();
        }
        if (err instanceof Error && (err.message === 'kept' || err.message === 'rematch_busy'))
            return null;
        throw err;
    }
}

/** Clear only the Keep decision; playback and user data are untouched. */
export async function restoreKeptPersonalMediaItem(
    sql: postgres.Sql,
    id: string,
): Promise<boolean> {
    return withTx(sql, async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        // eslint-disable-next-line callback-safety/no-unscoped-media-items -- admin-only Restore Keep endpoint: row lock serializes the disposition reversal with scanner rematch claims; no catalog rows are returned to a viewer.
        await tx`SELECT id FROM media_items WHERE id = ${id} FOR UPDATE`;
        const rows = await tx<{ media_id: string }[]>`
            DELETE FROM personal_media_dispositions
            WHERE media_id = ${id} AND disposition = 'kept'
            RETURNING media_id
        `;
        return rows.length > 0;
    });
}

/** Fast read used to avoid provider calls for a row kept after a run snapshot. */
export async function isPersonalMediaKept(sql: postgres.Sql, id: string): Promise<boolean> {
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- internal Auto-Identify/scanner guard: this checks the operator's Keep disposition through the full ancestor chain before a background identity write.
    const rows = await sql<{ kept: boolean }[]>`
        WITH RECURSIVE item_chain AS (
            SELECT id, parent_id FROM media_items WHERE id = ${id}::uuid
            UNION
            SELECT parent.id, parent.parent_id
            FROM media_items parent
            JOIN item_chain child ON child.parent_id = parent.id
        )
        SELECT EXISTS (
            SELECT 1
            FROM item_chain chain
            JOIN personal_media_dispositions d ON d.media_id = chain.id
            WHERE d.disposition = 'kept'
        ) AS kept
    `;
    return rows[0]?.kept === true;
}

/**
 * Restore a media item removed from the library via Fix matches, together with
 * every descendant (seasons, episodes) the removal took with it. Returns the
 * number of rows restored (0 when the item is unknown or not removed).
 *
 * Rows with a `dismissed_content_hash` are left alone: those were dismissed by
 * the scanner's rename path (file-rematch.queries.ts) and belong to the reclaim
 * window, not to the operator's removal — flipping them here would let two rows
 * claim the same renamed file.
 *
 * The removal cleared `has_files` on every row it touched, so it is re-derived
 * from the (untouched) file links in the same transaction — otherwise the
 * restored item would stay out of every library surface.
 */
export async function restoreDismissedMediaItemWithChildren(
    sql: postgres.Sql,
    id: string,
): Promise<number> {
    return withTx(sql, async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        // eslint-disable-next-line callback-safety/no-unscoped-media-items -- admin-only: the one caller (POST /api/admin/unmatched-files/[id]/restore) is gated on the media:admin scope, same as its dismiss counterpart.
        const rows = await tx<{ id: string }[]>`
            WITH RECURSIVE descendants AS (
                SELECT id FROM media_items WHERE id = ${id}
                UNION ALL
                SELECT mi.id FROM media_items mi
                JOIN descendants d ON mi.parent_id = d.id
            )
            UPDATE media_items SET is_dismissed = false, updated_at = NOW()
            WHERE id IN (SELECT id FROM descendants)
              AND is_dismissed = true
              AND dismissed_content_hash IS NULL
            RETURNING id
        `;
        await recomputeHasFilesBatch(
            tx,
            rows.map((r) => r.id),
        );
        return rows.length;
    });
}
