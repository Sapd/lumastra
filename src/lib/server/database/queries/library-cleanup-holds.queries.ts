// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Library paths whose stale-file cleanup a scanner safety guard refused
 * (`library_cleanup_holds`, migration 16.405.0).
 *
 * The scanner refuses to remove missing files when its walk found far fewer
 * files than the database knows, or none: that is what an offline or
 * half-mounted share looks like. Before this table the refusal was a log line,
 * so a library whose files were really deleted kept its dead rows forever and
 * nobody saw why. A hold is recorded on every refused scan and deleted by the
 * first scan that is not held; an admin can confirm it, which lets the next
 * scan remove the missing files once.
 */

import type postgres from 'postgres';

export type CleanupHoldReason = 'few_files' | 'no_files';

export interface CleanupHoldRow {
    library_path_id: string;
    reason: CleanupHoldReason;
    walked: number;
    known: number;
    first_held_at: Date;
    last_held_at: Date;
    confirmed_at: Date | null;
    confirmed_by: string | null;
    confirmed_walked: number | null;
    confirmed_known: number | null;
}

/** How long an admin's confirmation stays valid without a scan consuming it. */
export const CLEANUP_CONFIRMATION_TTL_HOURS = 24;

/**
 * Whether a confirmed hold lets a scan with these counts remove the missing
 * files: same reason, exactly the walk the admin saw, no more known files than
 * then, and confirmed within the last day. Anything else is a different
 * situation (the share degraded further, or came back partly) and is held.
 */
export function holdConfirmsCleanup(
    hold: CleanupHoldRow | null,
    scan: { reason: CleanupHoldReason; walked: number; known: number },
    now: Date = new Date(),
): boolean {
    if (!hold?.confirmed_at || hold.reason !== scan.reason) return false;
    if (hold.confirmed_walked !== scan.walked) return false;
    if (hold.confirmed_known === null || scan.known > hold.confirmed_known) return false;
    return now.getTime() - hold.confirmed_at.getTime() <= CLEANUP_CONFIRMATION_TTL_HOURS * 3600_000;
}

/** SQL twin of {@link holdConfirmsCleanup} for the upsert below. */
function keepConfirmation(sql: postgres.Sql): postgres.PendingQuery<postgres.Row[]> {
    return sql`(
        library_cleanup_holds.reason = EXCLUDED.reason
        AND library_cleanup_holds.confirmed_walked = EXCLUDED.walked
        AND EXCLUDED.known <= library_cleanup_holds.confirmed_known
        AND library_cleanup_holds.confirmed_at > now() - make_interval(hours => ${CLEANUP_CONFIRMATION_TTL_HOURS})
    )`;
}

/**
 * Record (or refresh) a refused cleanup. A walk the confirmation does not
 * cover (see {@link holdConfirmsCleanup}) drops it: it was given for a
 * different situation.
 */
export async function recordCleanupHold(
    sql: postgres.Sql,
    hold: { libraryPathId: string; reason: CleanupHoldReason; walked: number; known: number },
): Promise<void> {
    await sql`
        INSERT INTO library_cleanup_holds (library_path_id, reason, walked, known)
        VALUES (${hold.libraryPathId}, ${hold.reason}, ${hold.walked}, ${hold.known})
        ON CONFLICT (library_path_id) DO UPDATE SET
            reason = EXCLUDED.reason,
            walked = EXCLUDED.walked,
            known = EXCLUDED.known,
            last_held_at = now(),
            first_held_at = CASE WHEN library_cleanup_holds.reason = EXCLUDED.reason
                THEN library_cleanup_holds.first_held_at ELSE now() END,
            confirmed_at = CASE WHEN ${keepConfirmation(sql)} THEN library_cleanup_holds.confirmed_at END,
            confirmed_by = CASE WHEN ${keepConfirmation(sql)} THEN library_cleanup_holds.confirmed_by END,
            confirmed_walked = CASE WHEN ${keepConfirmation(sql)}
                THEN library_cleanup_holds.confirmed_walked END,
            confirmed_known = CASE WHEN ${keepConfirmation(sql)}
                THEN library_cleanup_holds.confirmed_known END
    `;
}

/** The hold of one library path, or null when its cleanup is not held. */
export async function getCleanupHold(
    sql: postgres.Sql,
    libraryPathId: string,
): Promise<CleanupHoldRow | null> {
    const [row] = await sql<CleanupHoldRow[]>`
        SELECT * FROM library_cleanup_holds WHERE library_path_id = ${libraryPathId}
    `;
    return row ?? null;
}

/** Every held, enabled library path, with its path, oldest first. */
export async function listCleanupHolds(
    sql: postgres.Sql,
): Promise<Array<CleanupHoldRow & { path: string }>> {
    return sql<Array<CleanupHoldRow & { path: string }>>`
        SELECT h.*, lp.path
          FROM library_cleanup_holds h
          JOIN library_paths lp ON lp.id = h.library_path_id AND lp.enabled
         ORDER BY h.first_held_at
    `;
}

/**
 * Held, enabled library paths waiting for the admin: never confirmed, or a
 * confirmation that expired before a scan used it.
 */
export async function countUnconfirmedCleanupHolds(sql: postgres.Sql): Promise<number> {
    const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n
          FROM library_cleanup_holds h
          JOIN library_paths lp ON lp.id = h.library_path_id AND lp.enabled
         WHERE h.confirmed_at IS NULL
            OR h.confirmed_at <= now() - make_interval(hours => ${CLEANUP_CONFIRMATION_TTL_HOURS})
    `;
    return row?.n ?? 0;
}

/**
 * The admin confirms that the files are gone. Only the hold the admin looked
 * at (`expectedWalked`) is confirmed: if a scan has since recorded a different
 * walk, nothing changes and false is returned.
 */
export async function confirmCleanupHold(
    sql: postgres.Sql,
    params: { libraryPathId: string; expectedWalked: number; confirmedBy: string },
): Promise<boolean> {
    const rows = await sql`
        UPDATE library_cleanup_holds
           SET confirmed_at = now(),
               confirmed_by = ${params.confirmedBy},
               confirmed_walked = walked,
               confirmed_known = known
         WHERE library_path_id = ${params.libraryPathId}
           AND walked = ${params.expectedWalked}
    `;
    return rows.count === 1;
}

/** The scan was not held (or the confirmed cleanup ran): forget the hold. */
export async function clearCleanupHold(sql: postgres.Sql, libraryPathId: string): Promise<void> {
    await sql`DELETE FROM library_cleanup_holds WHERE library_path_id = ${libraryPathId}`;
}
