// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Artist / album enrichment for Jellyfin compat music items.
 *
 * Real Jellyfin sends, for every `Audio` item, `Artists` (the track's own
 * artist credits), `ArtistItems` ([{ Name, Id }] for those credits),
 * `AlbumArtist`, `AlbumArtists`, `Album` and `AlbumId`; a `MusicAlbum` carries
 * the album artist in all four artist fields. The base serializer only sees one
 * `media_items` row and so emitted none of them — Findroid, Jellyfin Android
 * and Finamp then showed every track and album without an artist.
 *
 * One batched query per response, mirroring `enrichItemsWithProviderIds`.
 * Non-music items are skipped before any SQL runs, so calling this from a
 * mixed browse response costs nothing when there is no music on the page.
 *
 * The track credit resolution reuses the web player's fragments so both
 * surfaces name (and link) the same artist:
 *   - `trackArtistsSql` — the structured multi-artist list from the scanner's
 *     `additional_artist_ids`, Various Artists excluded;
 *   - `trackDisplayArtistSql` / `trackArtistIdSql` — the single credited artist
 *     when the track has no additional ids (its tag equals the album artist),
 *     with the id guarded so it never points at an artist the name doesn't name.
 */
import type postgres from 'postgres';
import type { JellyfinBaseItemDto, JellyfinNameIdPair } from './types';
import { isUuid } from '$lib/server/utils/media-key-parser.js';
import {
    trackArtistIdSql,
    trackArtistsSql,
    trackDisplayArtistSql,
} from '$lib/server/database/queries/fragments/music-artist.fragments.js';

interface MusicArtistRow {
    id: string;
    media_type: 'track' | 'album';
    album_id: string | null;
    album_title: string | null;
    album_artist_id: string | null;
    album_artist_title: string | null;
    track_artists: Array<{ id: string; title: string }> | null;
    display_artist: string | null;
    display_artist_id: string | null;
}

/**
 * Mutates each `Audio` / `MusicAlbum` item in place to carry its artist and
 * album fields. Items of any other type are left untouched.
 */
export async function enrichItemsWithMusicArtists(
    sql: postgres.Sql,
    items: JellyfinBaseItemDto[],
): Promise<void> {
    const music = items.filter(
        (i) => (i.Type === 'Audio' || i.Type === 'MusicAlbum') && isUuid(i.Id),
    );
    if (music.length === 0) return;
    const ids = [...new Set(music.map((i) => i.Id))];

    // Access: every id here is an item the calling route already scoped and
    // serialized. The joined rows are that item's own album and artist
    // (`parent_id` chain) plus artist rows, which own no files — see the access
    // note on `trackArtistsSql`. No row outside what the caller returned is
    // reachable from this query.
    const rows = (await sql`
        SELECT t.id,
               t.media_type,
               album.id    AS album_id,
               album.title AS album_title,
               artist.id   AS album_artist_id,
               artist.title AS album_artist_title,
               ${trackArtistsSql(sql, 't')} AS track_artists,
               ${trackDisplayArtistSql(sql, 't')} AS display_artist,
               ${trackArtistIdSql(sql, 't')} AS display_artist_id
        FROM media_items t
        LEFT JOIN media_items album
               ON t.media_type = 'track'
              AND album.id = t.parent_id
              AND album.media_type = 'album'
        LEFT JOIN media_items artist
               ON artist.id = CASE WHEN t.media_type = 'album' THEN t.parent_id
                                   ELSE album.parent_id END
              AND artist.media_type = 'artist'
        WHERE t.id = ANY(${ids}::uuid[])
          AND t.media_type IN ('track', 'album')
    `) as unknown as MusicArtistRow[];

    const byId = new Map(rows.map((r) => [String(r.id), r]));
    for (const item of music) {
        const row = byId.get(item.Id);
        if (!row) continue;

        const albumArtists: JellyfinNameIdPair[] =
            row.album_artist_id && row.album_artist_title
                ? [{ Name: row.album_artist_title, Id: String(row.album_artist_id) }]
                : [];
        item.AlbumArtists = albumArtists;
        if (albumArtists.length > 0) item.AlbumArtist = albumArtists[0].Name;

        if (row.media_type === 'album') {
            item.Artists = albumArtists.map((a) => a.Name);
            item.ArtistItems = albumArtists;
            continue;
        }

        let artistItems: JellyfinNameIdPair[] = (row.track_artists ?? []).map((a) => ({
            Name: a.title,
            Id: String(a.id),
        }));
        let artistNames = artistItems.map((a) => a.Name);
        if (artistItems.length === 0 && row.display_artist) {
            artistNames = [row.display_artist];
            // Jellyfin's ArtistItems are NameGuidPair (Id required): an unresolved
            // credit stays a name in `Artists` but gets no ArtistItems entry.
            artistItems = row.display_artist_id
                ? [{ Name: row.display_artist, Id: String(row.display_artist_id) }]
                : [];
        }
        item.Artists = artistNames;
        item.ArtistItems = artistItems;
        if (row.album_id) {
            item.AlbumId = String(row.album_id);
            item.Album = row.album_title ?? undefined;
        }
    }
}
