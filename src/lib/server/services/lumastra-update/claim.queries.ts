// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';

const CLAIM_KEY = 'claim';

/**
 * Take the right to contact the outside world for this install, atomically.
 * One statement: the row is written only when no claim exists or the previous
 * one has run out, so several processes (replicas, a restart overlapping a
 * run) that all find the check due make exactly one request between them. The
 * claim holds for `holdMs`; the caller picks the retry window, so a failed
 * attempt is not repeated by every process at once.
 *
 * `nowMs` is the caller's clock (tests drive it); expiry is compared with the
 * same value, never with the database clock, so every process agrees.
 */
export async function claimUpdateCheck(
    sql: postgres.Sql,
    opts: { pluginId: string; nowMs: number; holdMs: number },
): Promise<boolean> {
    const nowIso = new Date(opts.nowMs).toISOString();
    const untilIso = new Date(opts.nowMs + opts.holdMs).toISOString();
    const rows = await sql<{ one: number }[]>`
        INSERT INTO plugin_settings (plugin_id, key, value, updated_at)
        VALUES (${opts.pluginId}, ${CLAIM_KEY}, jsonb_build_object('until', ${untilIso}::text), NOW())
        ON CONFLICT (plugin_id, key) DO UPDATE SET
            value = EXCLUDED.value,
            updated_at = NOW()
        WHERE jsonb_typeof(plugin_settings.value) <> 'object'
           OR plugin_settings.value->>'until' IS NULL
           OR plugin_settings.value->>'until' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
           OR (plugin_settings.value->>'until')::timestamptz <= ${nowIso}::timestamptz
        RETURNING 1 AS one
    `;
    return rows.length > 0;
}
