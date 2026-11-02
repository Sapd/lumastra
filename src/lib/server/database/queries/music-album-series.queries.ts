// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Album series ("Future Trance Vol. 61 … 70") for the album modal.
 *
 * The series stem comes from the title (see `$lib/shared/music-album-series`),
 * which SQL can't reproduce faithfully, so this reads every album title under
 * the seed's album artist (one indexed parent_id lookup — Various Artists is a
 * single artist row) and matches in TypeScript. Only albums with at least one
 * playable track and inside the caller's access boundary are returned.
 */

import type postgres from 'postgres';
import { albumSeriesKey } from '$lib/shared/music-album-series.js';
import { buildLibraryAccessFilter } from './builders/library-access.builder.js';
import { buildAgeRatingFilter } from './builders/age-rating.builder.js';
import { deniesEverything, type MediaAccessBoundary } from './builders/media-access-boundary.js';

export interface AlbumSeriesRow {
    album_id: string;
    title: string;
    year: number | null;
    volume: number;
    track_count: number;
}

/** A series needs at least this many distinct volume numbers to be worth showing. */
const MIN_SERIES_VOLUMES = 2;

/**
 * The series the seed album belongs to, including the seed itself, ordered by
 * volume then year. Empty when the album has no series or is not playable itself.
 */
export async function getAlbumSeries(
    sql: postgres.Sql,
    albumId: string,
    access: MediaAccessBoundary,
): Promise<AlbumSeriesRow[]> {
    if (deniesEverything(access)) return [];

    const [seed] = await sql<{ title: string; parent_id: string | null }[]>`
        SELECT mi.title, mi.parent_id::text AS parent_id
        FROM media_items mi
        WHERE mi.id = ${albumId} AND mi.media_type = 'album'
        ${buildLibraryAccessFilter(sql, access.library)}
        ${buildAgeRatingFilter(sql, access.age)}
    `;
    if (!seed?.parent_id) return [];
    const seedKey = albumSeriesKey(seed.title);
    if (!seedKey) return [];

    const siblings = await sql<{ id: string; title: string }[]>`
        SELECT mi.id::text AS id, mi.title
        FROM media_items mi
        WHERE mi.parent_id = ${seed.parent_id} AND mi.media_type = 'album'
        ${buildLibraryAccessFilter(sql, access.library)}
        ${buildAgeRatingFilter(sql, access.age)}
    `;
    const volumeById = new Map<string, number>();
    for (const row of siblings) {
        const k = albumSeriesKey(row.title);
        if (k?.key === seedKey.key) volumeById.set(row.id, k.volume);
    }
    if (new Set(volumeById.values()).size < MIN_SERIES_VOLUMES) return [];

    const rows = await sql<Omit<AlbumSeriesRow, 'volume'>[]>`
        SELECT
            mi.id::text AS album_id,
            mi.title,
            COALESCE(
                mi.year,
                CASE WHEN mi.custom_metadata->>'year' ~ '^[0-9]{4}$'
                     THEN (mi.custom_metadata->>'year')::int END
            ) AS year,
            tracks.n AS track_count
        FROM media_items mi
        CROSS JOIN LATERAL (
            SELECT COUNT(*)::int AS n
            FROM media_items t
            WHERE t.parent_id = mi.id AND t.media_type = 'track' AND t.has_files = true
        ) tracks
        WHERE mi.id = ANY(${[...volumeById.keys()]}::uuid[])
          AND mi.media_type = 'album'
          AND tracks.n > 0
        ${buildLibraryAccessFilter(sql, access.library)}
        ${buildAgeRatingFilter(sql, access.age)}
    `;

    const series = rows.map((r) => ({ ...r, volume: volumeById.get(r.album_id) ?? 0 }));
    // The open album must itself be listed (it is the highlighted row), and the
    // playable/accessible members must still span two volumes.
    if (!series.some((r) => r.album_id === albumId)) return [];
    if (new Set(series.map((r) => r.volume)).size < MIN_SERIES_VOLUMES) return [];
    return series.sort(
        (a, b) =>
            a.volume - b.volume || (a.year ?? 0) - (b.year ?? 0) || a.title.localeCompare(b.title),
    );
}
