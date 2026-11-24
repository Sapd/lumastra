// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';

/**
 * Scalar SQL expression: the revision of a radio station's displayed logo, or
 * NULL when the station has none.
 *
 * A station's logo is its selected, non-hidden local poster candidate — the
 * same row the byte route (`getLocalArtwork`) serves. Do NOT read
 * `media_items.custom_poster_url` for this: the storage layer stamps it once on
 * the first upload and the admin "Remove" (which hides the candidate) never
 * clears it, so a removed logo kept its ✕ button and stayed on every radio
 * surface (prod 2026-11-24, TechnoBase FM).
 *
 * The revision changes whenever another file becomes the logo, so a replaced
 * logo gets a new image URL (`?v=`) instead of the copy the browser cached
 * under the old one (the byte route allows an hour plus a day of
 * stale-while-revalidate).
 *
 * @param alias the `media_items` alias of the outer query
 */
export function radioLogoRevisionSql(
    sql: postgres.Sql,
    alias: string,
): postgres.PendingQuery<postgres.Row[]> {
    return sql`(
        SELECT left(md5(concat_ws(':', ic.id, ic.updated_at, ic.file_path, ic.remote_url,
                                  ic.local_content_hash)), 12)
        FROM image_candidates ic
        WHERE ic.media_item_id = ${sql(alias)}.id
          AND ic.artwork_type = 'poster'
          AND ic.source = 'local'
          AND ic.selected
          AND NOT ic.suppressed
        ORDER BY ic.selection_order, ic.sort_order, ic.created_at, ic.id
        LIMIT 1
    )`;
}
