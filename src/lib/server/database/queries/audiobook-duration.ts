// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';

/** Canonical book duration; provider metadata wins over runtime and viewer state. */
export function audiobookDurationMs(sql: postgres.Sql): postgres.PendingQuery<postgres.Row[]> {
    return sql`round(COALESCE(
        CASE WHEN jsonb_typeof(mi.custom_metadata #> '{audiobookshelf,duration}') = 'number'
            THEN (mi.custom_metadata #>> '{audiobookshelf,duration}')::numeric * 1000 END,
        mi.runtime_seconds::numeric * 1000, ums.runtime_ms::numeric
    ))::bigint`;
}
