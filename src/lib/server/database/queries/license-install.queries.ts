// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * License Install Identity Query Module
 *
 * Reads the per-DEPLOYMENT install UUID from the one-row `license_install`
 * table (migration 16.48.0). This is deployment identity only — the operator's
 * "license identity" shown on /admin/system/instance and sent (and ONLY this) to the
 * licensing server on refresh. It carries no enforcement on its own; license
 * verification lives in the proprietary modules.
 *
 * The UUID is allocated once by the migration's seed INSERT and shared across
 * all replicas. `getInstallUuid` defensively re-seeds (idempotently) if the row
 * is somehow missing, so it always returns a stable value.
 */

import type postgres from 'postgres';

interface InstallRow {
    install_uuid: string;
    created_at: Date;
}

export interface InstallClockObservation {
    installUuid: string;
    /** Monotonic reference time after initialisation / capped advancement, in ms. */
    effectiveNowMs: number;
}

/**
 * Get the stable per-deployment install UUID, seeding the singleton row if it
 * is somehow absent (idempotent / race-safe via ON CONFLICT).
 */
export async function getInstallUuid(sql: postgres.Sql): Promise<string> {
    const rows = await sql<InstallRow[]>`
        SELECT install_uuid, created_at FROM license_install WHERE singleton = true
    `;
    if (rows[0]?.install_uuid) {
        return rows[0].install_uuid;
    }
    // Defensive seed — should only happen if the migration row was removed.
    const seeded = await sql<InstallRow[]>`
        INSERT INTO license_install (singleton)
        VALUES (true)
        ON CONFLICT (singleton) DO NOTHING
        RETURNING install_uuid, created_at
    `;
    if (seeded[0]?.install_uuid) {
        return seeded[0].install_uuid;
    }
    // Lost the race to a concurrent seeder — read the now-present row.
    const after = await sql<InstallRow[]>`
        SELECT install_uuid, created_at FROM license_install WHERE singleton = true
    `;
    if (!after[0]?.install_uuid) {
        throw new Error('license_install row missing after seed');
    }
    return after[0].install_uuid;
}

/**
 * How far ahead of the stored high-water mark a new `now` observation is
 * allowed to advance the floor in a single call (6 hours).
 *
 * Purpose: prevent a single forward clock excursion (NTP jump, VM migration,
 * daylight-saving edge case) from permanently advancing the anti-rollback floor
 * so far that a valid license is judged expired-beyond-grace and stays that way
 * even after the clock self-corrects.
 *
 * The cap is applied as a ceiling on the stored value: the new high-water mark
 * is at most `previous + MAX_ADVANCE_MS`, even if `now` is much further ahead.
 * On the next normal call (clock back to reality) the floor stays put; on each
 * subsequent normal call it may advance by up to MAX_ADVANCE_MS again, so the
 * floor eventually catches up without a single catastrophic jump.
 *
 * Anti-rollback is preserved: the GREATEST() still prevents the floor from
 * moving backward (clock rollback / NTP step-back cannot reduce the mark).
 */
export const CLOCK_MAX_ADVANCE_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * Advance and read the monotonic time mark in one round-trip: sets
 * a NULL reference to `now`, otherwise
 * `time_reference = GREATEST(previous, LEAST(now, previous + cap))`, and
 * returns the result as `effectiveNowMs`. `nowIso` is passed in (not `now()`)
 * for deterministic tests.
 *
 * After initialisation, the cap limits each advance to `CLOCK_MAX_ADVANCE_MS`.
 * The first observation is accepted as-is; first-boot clock skew is intentional.
 */
export async function observeInstallClock(
    sql: postgres.Sql,
    nowIso: string,
): Promise<InstallClockObservation> {
    const rows = await sql<{ install_uuid: string; time_reference: Date }[]>`
        UPDATE license_install
        SET time_reference = CASE
            WHEN time_reference IS NULL THEN ${nowIso}::timestamptz
            ELSE GREATEST(
                time_reference,
                LEAST(
                    ${nowIso}::timestamptz,
                    time_reference + (${CLOCK_MAX_ADVANCE_MS}::bigint * interval '1 millisecond')
                )
            )
        END
        WHERE singleton = true
        RETURNING install_uuid, time_reference
    `;
    if (rows[0]?.install_uuid) {
        return {
            installUuid: rows[0].install_uuid,
            effectiveNowMs: rows[0].time_reference.getTime(),
        };
    }
    // Row missing — seed it (defensive), then retry once.
    const uuid = await getInstallUuid(sql);
    const retry = await sql<{ install_uuid: string; time_reference: Date }[]>`
        UPDATE license_install
        SET time_reference = CASE
            WHEN time_reference IS NULL THEN ${nowIso}::timestamptz
            ELSE GREATEST(
                time_reference,
                LEAST(
                    ${nowIso}::timestamptz,
                    time_reference + (${CLOCK_MAX_ADVANCE_MS}::bigint * interval '1 millisecond')
                )
            )
        END
        WHERE singleton = true
        RETURNING install_uuid, time_reference
    `;
    return {
        installUuid: retry[0]?.install_uuid ?? uuid,
        effectiveNowMs: retry[0]?.time_reference.getTime() ?? Date.parse(nowIso),
    };
}
