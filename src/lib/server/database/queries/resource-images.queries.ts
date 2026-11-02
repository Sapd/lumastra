// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import { isUuid } from '$lib/server/utils/media-key-parser.js';

export async function getUserAvatarVersions(
    sql: postgres.Sql,
    ids: string[],
    includeIdp: boolean,
): Promise<{ id: string; has_avatar: boolean; version: string | null }[]> {
    const uuids = ids.filter(isUuid);
    if (!uuids.length) return [];
    return await sql<{ id: string; has_avatar: boolean; version: string | null }[]>`
        SELECT id, (avatar_data IS NOT NULL OR (${includeIdp} AND idp_avatar_data IS NOT NULL)) AS has_avatar,
            (EXTRACT(EPOCH FROM CASE WHEN avatar_data IS NOT NULL THEN avatar_updated_at
                WHEN ${includeIdp} AND idp_avatar_data IS NOT NULL THEN idp_avatar_updated_at END) * 1000)::bigint::text AS version
        FROM users WHERE id = ANY(${uuids}::uuid[])
    `;
}

/** IDs have already been access gated by the resource handler. */
export async function getAudiobookImageRevisions(
    sql: postgres.Sql,
    ids: string[],
): Promise<Map<string, string>> {
    const uuids = ids.filter(isUuid);
    if (!uuids.length) return new Map();
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- caller supplies access-gated audiobook IDs
    const rows = await sql<{ id: string; revision: string }[]>`
        SELECT id, COALESCE(custom_metadata #>> '{audiobookshelf,updatedAt}', '0') AS revision
        FROM media_items WHERE id = ANY(${uuids}::uuid[]) AND media_type = 'audiobook'
    `;
    return new Map(rows.map((row) => [row.id, row.revision]));
}
