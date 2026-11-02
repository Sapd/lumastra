// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';

/** Repeated application is a no-op. A concurrent self-service UPDATE either
 * wins afterwards or makes this predicate fail after the row lock is acquired. */
export async function applyActivitySharingDefault(
    sql: postgres.Sql,
    sharing: boolean,
): Promise<number> {
    const rows = await sql<{ id: string }[]>`
        UPDATE users
        SET hide_streams = ${!sharing},
            share_listening_activity = ${sharing},
            share_audiobook_activity = ${sharing},
            updated_at = NOW()
        WHERE sharing_explicitly_set_by_user = false
          AND deleted_at IS NULL
          AND (hide_streams IS DISTINCT FROM ${!sharing}
            OR share_listening_activity IS DISTINCT FROM ${sharing}
            OR share_audiobook_activity IS DISTINCT FROM ${sharing})
        RETURNING id
    `;
    return rows.length;
}
