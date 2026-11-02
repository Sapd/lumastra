// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import type postgres from 'postgres';
import {
    listDueFileHealthRechecks,
    claimFileHealthRecheck,
    settleFileHealthRecheck,
} from '../database/queries/file-health-recheck.queries.js';

/** Runs inside the existing cancellable scheduled probe; never creates untracked child jobs. */
export async function recheckChangedFileHealth(
    sql: postgres.Sql,
    signal: AbortSignal,
    check: (fileId: string) => Promise<boolean>,
): Promise<number> {
    signal.throwIfAborted();
    const candidates = await listDueFileHealthRechecks(sql);
    let checked = 0;
    for (const candidate of candidates) {
        signal.throwIfAborted();
        if (!(await claimFileHealthRecheck(sql, candidate))) continue;
        signal.throwIfAborted();
        // Consume the receipt even on process failure/cancellation: unchanged bad files back off.
        const settled = await check(candidate.fileId);
        signal.throwIfAborted();
        if (settled) await settleFileHealthRecheck(sql, candidate);
        checked++;
    }
    return checked;
}
