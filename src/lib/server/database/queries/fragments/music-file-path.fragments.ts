// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Music File Path SQL Fragments
//
// Shared JOIN for resolving a track's file path via the media_file_items /
// media_files normalised table pair. Every track query that needs `file_path`
// (for suffix/contentType derivation in the Subsonic layer) interpolates this
// fragment instead of repeating the lookup inline.
//
// Usage in a SELECT list: add `mf.file_path AS file_path` after interpolating
// the join — `mf` is always the alias, and it exposes `file_path` and `duration_seconds`.
// Anything needing another media_files column (e.g. `library_group_id` for a
// library gate) must use its own EXISTS subquery, which is what all of the
// current callers already do.

import type postgres from 'postgres';
import { deniesEverything } from '../builders/media-access-boundary.js';
import type { MediaAccessBoundary } from '../builders/media-access-boundary.js';

export type MusicTrackAlias = 'track' | 't' | 'mi';

/**
 * Resolve ONE file path per track.
 *
 * This used to be two plain LEFT JOINs, which is a row multiplier:
 * `media_file_items` is many-to-one onto a track, and on prod 358 tracks
 * carry two rows — sometimes the same path twice, sometimes the same song on
 * two compilation CDs. Every listing built on it therefore emitted those
 * tracks twice, and the damage went well past a cosmetic duplicate:
 *
 * - `getTracksPaged` walked 28147 rows while `countTracksPaged` (no join)
 *   reported 27789, so `total` under-counted the pages it described.
 * - `/music/alpha-index` counts one row per track, so every offset it handed
 *   out was short by the number of duplicated tracks ahead of it — the Songs
 *   rail landed most of a letter early (bucket S → "Rock That City").
 * - Two rows for one track means two `file_path` values with no ORDER BY, so
 *   which one a caller saw was unspecified — and `getTrackDetail` feeds the
 *   Subsonic stream handler's suffix/contentType.
 *
 * A LATERAL ... LIMIT 1 makes it one row per track and, because every caller
 * shares this fragment, makes the path the browse reports the same one the
 * streamer plays.
 *
 * The pick is `is_default` first, which is the schema's own answer to "which
 * file is THE file" — `idx_media_file_items_one_default` is a unique partial
 * index, so at most one row per item can claim it, and on prod all 358
 * multi-file tracks have exactly one (and no track has none). `sort_order`,
 * then `file_path`, then `id` are deterministic backstops for data that does
 * not: never `id` alone, since a re-scan that re-inserts the row would
 * silently flip which file a track reports. Ignoring `is_default` in a
 * resolver is a mistake this codebase has made before — see the split-episode
 * range mis-link, where four resolvers did the same thing.
 */
export function trackFilePathJoin(
    sql: postgres.Sql,
    alias: MusicTrackAlias = 'track',
    access?: MediaAccessBoundary,
): postgres.PendingQuery<postgres.Row[]> {
    // Unscoped legacy callers retain their original default-file choice. Only
    // an explicit boundary may choose an alternate: generic postfilters can
    // otherwise accept a missing allowed link while exposing a denied file.
    const availableFileFilter = access
        ? sql`AND f.is_missing = false
              AND LOWER(f.file_path) ~ '\\.(mp3|flac|m4a|opus|ogg|wav|aac|aiff|alac|wma)$'`
        : sql``;
    const denied = access?.library.kind === 'denyGroups' ? access.library.ids : [];
    const accessFilter =
        access && deniesEverything(access)
            ? sql`AND false`
            : denied.length
              ? sql`AND (f.library_group_id IS NULL OR f.library_group_id != ALL(${denied}::uuid[]))`
              : sql``;
    if (alias === 't')
        return sql`
        LEFT JOIN LATERAL (
            SELECT f.file_path, f.duration_seconds
            FROM media_file_items fi
            JOIN media_files f ON f.id = fi.file_id
            WHERE fi.media_item_id = t.id
              ${availableFileFilter}
              ${accessFilter}
            ORDER BY fi.is_default DESC, fi.sort_order, f.file_path, f.id
            LIMIT 1
        ) mf ON true`;
    if (alias === 'mi')
        return sql`
        LEFT JOIN LATERAL (
            SELECT f.file_path, f.duration_seconds
            FROM media_file_items fi
            JOIN media_files f ON f.id = fi.file_id
            WHERE fi.media_item_id = mi.id
              ${availableFileFilter}
              ${accessFilter}
            ORDER BY fi.is_default DESC, fi.sort_order, f.file_path, f.id
            LIMIT 1
        ) mf ON true`;
    return sql`
        LEFT JOIN LATERAL (
            SELECT f.file_path, f.duration_seconds
            FROM media_file_items fi
            JOIN media_files f ON f.id = fi.file_id
            WHERE fi.media_item_id = track.id
              ${availableFileFilter}
              ${accessFilter}
            ORDER BY fi.is_default DESC, fi.sort_order, f.file_path, f.id
            LIMIT 1
        ) mf ON true`;
}
