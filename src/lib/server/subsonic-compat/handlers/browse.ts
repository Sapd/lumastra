// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// OpenSubsonic Compatibility Layer — Browse Handlers
// Endpoints for browsing artists, albums, songs, and directories.

import type { RequestEvent } from '@sveltejs/kit';
import type postgres from 'postgres';
import { subsonicError, subsonicOk } from '$lib/server/subsonic-compat/serializers/response.js';
import {
    groupArtistsByIndex,
    serializeArtist,
} from '$lib/server/subsonic-compat/serializers/artist.js';
import {
    serializeAlbum,
    serializeAlbumWithSongs,
} from '$lib/server/subsonic-compat/serializers/album.js';
import { serializeSong } from '$lib/server/subsonic-compat/serializers/song.js';
import { serializeGenre } from '$lib/server/subsonic-compat/serializers/genre.js';
import type { SubsonicAuthContext, SubsonicHandler } from '$lib/server/subsonic-compat/types.js';
import { getParam, getIntParam, clampInt } from '$lib/server/subsonic-compat/helpers.js';
import {
    getAlbums,
    getAlbumWithTracks,
    getArtists,
    getDistinctMusicGenres,
    getTrackDetail,
    getTrackPlayCounts,
    getMostPlayedAlbums,
    getTracksForAlbums,
    type MusicAlbumRow,
    type MusicQueryOptions,
} from '$lib/server/database/queries/music.queries.js';
import { getStarredAlbumIds } from '$lib/server/database/queries/user-ratings.queries.js';
import { unrestrictedAccess } from '$lib/server/database/queries/builders/media-access-boundary.js';
import {
    checkSubsonicMediaAccess,
    filterAccessibleTracks,
    getVisibleArtistWithAlbums,
    withVisibleTrackCounts,
    toUserContext,
    ageRatingFromAuth,
    subsonicBoundary,
} from '$lib/server/subsonic-compat/media-access.js';
import { buildSearchAccessContext } from '$lib/server/utils/search-access-context.js';
import {
    getDeniedLibraryGroups,
    toLibraryAccessUser,
} from '$lib/server/cache/library-group-permissions-cache.js';

export const handleGetArtists: SubsonicHandler = async (
    _event: RequestEvent,
    auth: SubsonicAuthContext,
    sql: postgres.Sql,
): Promise<Response> => {
    const denied = await getDeniedLibraryGroups(sql, toLibraryAccessUser(auth));
    const rows = await getArtists(sql, {
        limit: 9999,
        access: subsonicBoundary(denied, ageRatingFromAuth(auth)),
    });
    const artists = groupArtistsByIndex(rows);
    return subsonicOk({ artists }, auth.format);
};

// Legacy ID1 directory endpoint — id can be an artist or album UUID.
// Tries album first (more common in SubFire browsing), then artist.
export const handleGetMusicDirectory: SubsonicHandler = async (
    event: RequestEvent,
    auth: SubsonicAuthContext,
    sql: postgres.Sql,
): Promise<Response> => {
    const id = getParam(event, 'id');
    if (!id) {
        return subsonicError(10, 'Required parameter "id" is missing.', auth.format);
    }

    // Try as album first
    const albumResult = await getAlbumWithTracks(sql, id);
    if (albumResult) {
        // C14 (follow-up): the album id itself was never checked — a zero-track
        // album row naming a denied library group fell through the
        // `tracks.length > 0 && accessibleTracks.length === 0` guard below,
        // which is vacuously false when there are no tracks at all. An album
        // row is accessible to checkMediaAccess when ANY descendant track file
        // is non-denied, so a partially-accessible album still passes here.
        if (!(await checkSubsonicMediaAccess(sql, id, auth))) {
            return subsonicError(70, 'Directory not found.', auth.format);
        }
        const { album, tracks } = albumResult;
        const accessibleTracks = await filterAccessibleTracks(sql, tracks, auth);
        if (tracks.length > 0 && accessibleTracks.length === 0) {
            return subsonicError(70, 'Directory not found.', auth.format);
        }
        const children = accessibleTracks.map((t) => ({
            ...serializeSong(t, album.id, album.artist_id ?? undefined, album.title),
            parent: album.id,
            isDir: false,
        }));
        return subsonicOk(
            {
                directory: {
                    id: album.id,
                    parent: album.artist_id ?? '1',
                    name: album.title,
                    child: children,
                },
            },
            auth.format,
        );
    }

    // Try as artist
    const artistResult = await getVisibleArtistWithAlbums(sql, id, auth);
    if (artistResult) {
        const { artist, albums } = artistResult;
        const children = albums.map((a) => ({
            ...serializeAlbum(a),
            parent: artist.id,
            isDir: true,
        }));
        return subsonicOk(
            {
                directory: {
                    id: artist.id,
                    parent: '1',
                    name: artist.title,
                    child: children,
                },
            },
            auth.format,
        );
    }

    return subsonicError(70, 'Directory not found.', auth.format);
};

export const handleGetArtist: SubsonicHandler = async (
    event: RequestEvent,
    auth: SubsonicAuthContext,
    sql: postgres.Sql,
): Promise<Response> => {
    const id = getParam(event, 'id');
    if (!id) {
        return subsonicError(10, 'Required parameter "id" is missing.', auth.format);
    }
    const result = await getVisibleArtistWithAlbums(sql, id, auth);
    if (!result) {
        return subsonicError(70, 'Artist not found.', auth.format);
    }
    const artist = serializeArtist(result.artist);
    const album = result.albums.map((a) => serializeAlbum(a));
    return subsonicOk(
        {
            artist: { ...artist, album },
        },
        auth.format,
    );
};

export const handleGetAlbum: SubsonicHandler = async (
    event: RequestEvent,
    auth: SubsonicAuthContext,
    sql: postgres.Sql,
): Promise<Response> => {
    const id = getParam(event, 'id');
    if (!id) {
        return subsonicError(10, 'Required parameter "id" is missing.', auth.format);
    }
    const result = await getAlbumWithTracks(sql, id);
    if (!result) {
        return subsonicError(70, 'Album not found.', auth.format);
    }
    // C14 (follow-up): the album id itself was never checked — a zero-track
    // album row naming a denied library group fell through the
    // `tracks.length > 0 && accessibleTracks.length === 0` guard below, which
    // is vacuously false when there are no tracks at all, so its name/year/
    // cover were served to a restricted caller. An album row is accessible to
    // checkMediaAccess when ANY descendant track file is non-denied, so a
    // partially-accessible album still passes this gate.
    if (!(await checkSubsonicMediaAccess(sql, id, auth))) {
        return subsonicError(70, 'Album not found.', auth.format);
    }
    const accessibleTracks = await filterAccessibleTracks(sql, result.tracks, auth);
    if (result.tracks.length > 0 && accessibleTracks.length === 0) {
        return subsonicError(70, 'Album not found.', auth.format);
    }
    const playCounts =
        accessibleTracks.length > 0
            ? await getTrackPlayCounts(
                  sql,
                  auth.userId,
                  accessibleTracks.map((t) => t.id),
              )
            : undefined;
    return subsonicOk(
        {
            album: serializeAlbumWithSongs(
                withVisibleTrackCounts(result.album, accessibleTracks),
                accessibleTracks,
                playCounts,
            ),
        },
        auth.format,
    );
};

export const handleGetSong: SubsonicHandler = async (
    event: RequestEvent,
    auth: SubsonicAuthContext,
    sql: postgres.Sql,
): Promise<Response> => {
    const id = getParam(event, 'id');
    if (!id) {
        return subsonicError(10, 'Required parameter "id" is missing.', auth.format);
    }
    if (!(await checkSubsonicMediaAccess(sql, id, auth))) {
        return subsonicError(70, 'Song not found.', auth.format);
    }
    const track = await getTrackDetail(sql, id);
    if (!track) {
        return subsonicError(70, 'Song not found.', auth.format);
    }
    const playCounts = await getTrackPlayCounts(sql, auth.userId, [id]);
    return subsonicOk(
        {
            song: serializeSong(track, undefined, undefined, undefined, playCounts.get(id)),
        },
        auth.format,
    );
};

export const handleGetGenres: SubsonicHandler = async (
    _event: RequestEvent,
    auth: SubsonicAuthContext,
    sql: postgres.Sql,
): Promise<Response> => {
    // Scope the taxonomy by the caller's access — without this, restricted
    // genres still appear in the list with track/album counts that hint
    // at restricted catalog size.
    const accessCtx = await buildSearchAccessContext(sql, toUserContext(auth));
    const rows = await getDistinctMusicGenres(sql, {
        deniedGroupIds: accessCtx.deniedGroupIds,
        ageRating: accessCtx.ageRating,
    });
    return subsonicOk({ genres: { genre: rows.map((g) => serializeGenre(g)) } }, auth.format);
};

// getIndexes — legacy file-system view. Structurally identical to getArtists
// but wrapped in "indexes" with a lastModified timestamp and an empty "child"
// array. Many older clients (Submariner, DSub, etc.) call this instead of
// getArtists on startup.
export const handleGetIndexes: SubsonicHandler = async (
    _event: RequestEvent,
    auth: SubsonicAuthContext,
    sql: postgres.Sql,
): Promise<Response> => {
    const denied = await getDeniedLibraryGroups(sql, toLibraryAccessUser(auth));
    const rows = await getArtists(sql, {
        limit: 9999,
        access: subsonicBoundary(denied, ageRatingFromAuth(auth)),
    });
    const { ignoredArticles, index } = groupArtistsByIndex(rows);
    return subsonicOk(
        {
            indexes: {
                lastModified: 0,
                ignoredArticles,
                index,
                child: [],
            },
        },
        auth.format,
    );
};

export async function fetchAlbumListRows(
    event: RequestEvent,
    auth: SubsonicAuthContext,
    sql: postgres.Sql,
): Promise<MusicAlbumRow[] | Response> {
    const type = getParam(event, 'type');
    if (!type) {
        return subsonicError(10, 'Required parameter "type" is missing.', auth.format);
    }
    const size = clampInt(getIntParam(event, 'size', 20), 1, 500);
    const offset = Math.max(0, getIntParam(event, 'offset', 0));
    const genre = getParam(event, 'genre') ?? undefined;

    let sort: MusicQueryOptions['sort'];
    switch (type) {
        case 'alphabeticalByName':
        case 'alphabeticalByArtist':
        case 'byGenre':
            sort = 'alpha';
            break;
        case 'newest':
        case 'recent':
            sort = 'recent';
            break;
        case 'frequent': {
            const deniedF = await getDeniedLibraryGroups(sql, toLibraryAccessUser(auth));
            // Only short-circuit for a FULLY unrestricted caller. An
            // age-restricted caller with no denied library groups still needs
            // the per-track age gate (applied via checkSubsonicMediaAccess in
            // the loop below), so fall through for them.
            if ((!deniedF || deniedF.length === 0) && !auth.isAgeRestricted) {
                return getMostPlayedAlbums(sql, auth.userId, size, offset);
            }
            const candidates = await getMostPlayedAlbums(sql, auth.userId, (size + offset) * 3, 0);
            const accessibleF: MusicAlbumRow[] = [];
            for (const album of candidates) {
                if (accessibleF.length >= size + offset) break;
                const r = await getAlbumWithTracks(sql, album.id);
                if (!r || r.tracks.length === 0) {
                    // C14 (2026-09-16 security review 3): same shape as
                    // filterAccessibleAlbums' zero-track branch — gate on the
                    // album id itself instead of admitting it unconditionally.
                    if (await checkSubsonicMediaAccess(sql, album.id, auth)) {
                        accessibleF.push(album);
                    }
                    continue;
                }
                const visible = await filterAccessibleTracks(sql, r.tracks, auth);
                if (visible.length > 0) accessibleF.push(withVisibleTrackCounts(album, visible));
            }
            return accessibleF.slice(offset, offset + size);
        }
        case 'random':
            sort = 'random';
            break;
        case 'starred': {
            const deniedS = await getDeniedLibraryGroups(sql, toLibraryAccessUser(auth));
            // An age-restricted caller (even with no denied groups) needs the
            // per-track gate below, so treat them like a restricted caller for
            // both the over-fetch count and the filter loop.
            const needsFilter = (deniedS && deniedS.length > 0) || auth.isAgeRestricted;
            const fetchCount = needsFilter ? (size + offset) * 3 : size + offset;
            // Deliberately unfiltered at the query: the per-track
            // `checkSubsonicMediaAccess` loop below is the real gate, and the
            // over-fetch above exists precisely because that gate drops rows
            // after the fact. Applying a boundary here too would change how many
            // rows survive the over-fetch and so change which albums a restricted
            // caller sees.
            const starredRows = await getStarredAlbumIds(
                sql,
                auth.userId,
                fetchCount,
                unrestrictedAccess(),
            );
            const albums: MusicAlbumRow[] = [];
            for (const row of starredRows) {
                const result = await getAlbumWithTracks(sql, row.id);
                // getAlbumWithTracks also resolves a retained album whose tracks
                // are all gone (tracks: []); a starred list shows playable albums
                // only. With at least one track, the per-track gate below also
                // covers the album (C14, 2026-09-16 security review 3).
                if (!result || result.tracks.length === 0) continue;
                if (!needsFilter) {
                    albums.push(result.album);
                    continue;
                }
                const visible = await filterAccessibleTracks(sql, result.tracks, auth);
                if (visible.length > 0) albums.push(withVisibleTrackCounts(result.album, visible));
            }
            return albums.slice(offset, offset + size);
        }
        default:
            return subsonicError(
                10,
                `Unknown list type: ${type}. Supported: alphabeticalByName, alphabeticalByArtist, newest, recent, frequent, random, starred, byGenre.`,
                auth.format,
            );
    }

    const denied = await getDeniedLibraryGroups(sql, toLibraryAccessUser(auth));
    return getAlbums(sql, {
        limit: size,
        offset,
        sort,
        genre,
        access: subsonicBoundary(denied, ageRatingFromAuth(auth)),
    });
}

export const handleGetAlbumList: SubsonicHandler = async (
    event: RequestEvent,
    auth: SubsonicAuthContext,
    sql: postgres.Sql,
): Promise<Response> => {
    const result = await fetchAlbumListRows(event, auth, sql);
    if (result instanceof Response) return result;
    return subsonicOk({ albumList: { album: result.map(serializeAlbum) } }, auth.format);
};

export const handleGetAlbumList2: SubsonicHandler = async (
    event: RequestEvent,
    auth: SubsonicAuthContext,
    sql: postgres.Sql,
): Promise<Response> => {
    const type = getParam(event, 'type');
    const result = await fetchAlbumListRows(event, auth, sql);
    if (result instanceof Response) return result;

    // For type=frequent, embed songs so clients can build a flat "Tracks" section
    // without needing to call getAlbum for each album individually.
    if (type === 'frequent' && result.length > 0) {
        const albumIds = result.map((a) => a.id);
        const tracksMap = await getTracksForAlbums(sql, albumIds);
        const album = await Promise.all(
            result.map(async (a) =>
                serializeAlbumWithSongs(
                    a,
                    await filterAccessibleTracks(sql, tracksMap.get(a.id) ?? [], auth),
                ),
            ),
        );
        return subsonicOk({ albumList2: { album } }, auth.format);
    }

    return subsonicOk({ albumList2: { album: result.map(serializeAlbum) } }, auth.format);
};
