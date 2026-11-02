// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import { noOperatorCurationSql } from './media-retention.queries.js';
import { classifiedMediaReferenceGuard } from './never-owned-media-gc.queries.js';

/** Snapshot the artists affected by an expired music unit, before its rows disappear. */
export async function findRetentionArtists(sql: postgres.Sql, ids: string[]): Promise<string[]> {
    // Admin maintenance, restricted to the unit already checked by retention.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    const rows = await sql<{ id: string }[]>`
        WITH affected AS (
            SELECT parent_id AS id FROM media_items WHERE id = ANY(${ids}::uuid[])
            UNION
            SELECT unnest(music_track_credit_artist_ids(custom_metadata))
            FROM media_items WHERE id = ANY(${ids}::uuid[]) AND media_type = 'track'
        )
        SELECT a.id FROM affected JOIN media_items a ON a.id = affected.id
        WHERE a.media_type = 'artist'
    `;
    return rows.map((r) => r.id);
}

/**
 * Batch-check artists left by an expired unit. Reverse credit existence uses
 * idx_music_track_credit_artist_ids; JSON is expanded on index writes, never
 * across the library for each artist. Caller holds the music retention table
 * and reference locks, so a child, JSON credit or user reference cannot race this proof.
 * Derived provider metadata/artwork does not protect; operator curation does.
 */
export async function findEmptyRetentionArtists(
    sql: postgres.Sql,
    ids: string[],
): Promise<string[]> {
    if (!ids.length) return [];
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    const rows = await sql<{ id: string }[]>`
        SELECT a.id FROM media_items a
        WHERE a.id = ANY(${ids}::uuid[]) AND a.media_type = 'artist'
          AND a.status IN ('active', 'deleted') AND a.canonical_id IS NULL
          AND NOT (a.is_dismissed AND a.dismissed_at IS NULL)
          AND COALESCE(a.custom_metadata->>'no_split', '') <> 'true'
          AND NOT EXISTS (SELECT 1 FROM media_items c WHERE c.parent_id = a.id)
          AND NOT EXISTS (
              SELECT 1 FROM media_items t
              WHERE t.media_type = 'track'
                AND music_track_credit_artist_ids(t.custom_metadata) @> ARRAY[a.id]
          )
          AND ${noOperatorCurationSql(sql, 'a')}
          AND ${classifiedMediaReferenceGuard(sql, 'a')}
        ORDER BY a.id
        FOR UPDATE
    `;
    return rows.map((r) => r.id);
}
