// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import { SYNC_KIND_BY_MEDIA_TYPE } from '$lib/server/sync/capture-registry';

/** Shared with the initial library list: availability is independent of access scope. */
export function buildSyncSetFilter(
    sql: postgres.Sql,
    alias = 'mi',
): postgres.PendingQuery<postgres.Row[]> {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(alias)) throw new Error('Invalid sync-set alias');
    const mi = sql(alias);
    return sql`AND ${mi}.status = 'active' AND NOT ${mi}.is_dismissed
        AND ${mi}.has_files AND ${mi}.media_type = ANY(${Object.keys(SYNC_KIND_BY_MEDIA_TYPE)}::text[])`;
}
