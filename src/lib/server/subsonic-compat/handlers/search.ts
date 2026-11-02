// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// OpenSubsonic Compatibility Layer — Search Handlers
// search2, search3, getSimilarSongs, getSimilarSongs2, getTopSongs, getRandomSongs, getSongsByGenre.

import type { RequestEvent } from '@sveltejs/kit';
import type postgres from 'postgres';
import { subsonicError, subsonicOk } from '$lib/server/subsonic-compat/serializers/response.js';
import { serializeSong } from '$lib/server/subsonic-compat/serializers/song.js';
import { serializeAlbum } from '$lib/server/subsonic-compat/serializers/album.js';
import type {
    SubsonicAuthContext,
    SubsonicHandler,
    SubsonicAlbum,
    SubsonicArtist,
    SubsonicSong,
} from '$lib/server/subsonic-compat/types.js';
import {
    getParam,
    getIntParam,
    clampInt,
    normalizeSearchQuery,
} from '$lib/server/subsonic-compat/helpers.js';
import {
    getArtistTracks,
    getSimilarTracks,
    getTrackPairSimilarity,
    getTracksByGenre,
    findArtistByName,
    getTrackDetail,
    getTrackPlayCounts,
    getTracksPaged,
    getArtists,
    getAlbums,
} from '$lib/server/database/queries/music.queries.js';
import { getRandomTracks } from '$lib/server/database/queries/music-quick-picks.queries.js';
import { searchMusic } from '$lib/server/database/queries/search.queries.js';
import {
    getDeniedLibraryGroups,
    toLibraryAccessUser,
} from '$lib/server/cache/library-group-permissions-cache.js';
import {
    checkSubsonicMediaAccess,
    filterAccessibleTracks,
    ageRatingFromAuth,
    subsonicAccessBoundary,
    subsonicBoundary,
} from '$lib/server/subsonic-compat/media-access.js';
export const handleSearch3: SubsonicHandler = async (
    event: RequestEvent,
    auth: SubsonicAuthContext,
    sql: postgres.Sql,
): Promise<Response> => {
    const query = getParam(event, 'query');
    if (query === null) {
        return subsonicError(10, 'Required parameter "query" is missing.', auth.format);
    }
    // Empty (incl. the quoted-empty forms clients send) = enumerate the library.
    const term = normalizeSearchQuery(query);
    const artistCount = clampInt(getIntParam(event, 'artistCount', 20), 0, 500);
    const albumCount = clampInt(getIntParam(event, 'albumCount', 20), 0, 500);
    const songCount = clampInt(getIntParam(event, 'songCount', 20), 0, 500);
    const artistOffset = Math.max(0, getIntParam(event, 'artistOffset', 0));
    const albumOffset = Math.max(0, getIntParam(event, 'albumOffset', 0));
    const songOffset = Math.max(0, getIntParam(event, 'songOffset', 0));

    const denied = await getDeniedLibraryGroups(sql, toLibraryAccessUser(auth));

    if (term === '') {
        const age = ageRatingFromAuth(auth);
        const [artistRows, albumRows, songRows] = await Promise.all([
            artistCount > 0
                ? getArtists(sql, {
                      limit: artistCount,
                      offset: artistOffset,
                      access: subsonicBoundary(denied, age),
                  })
                : Promise.resolve([]),
            albumCount > 0
                ? getAlbums(sql, {
                      limit: albumCount,
                      offset: albumOffset,
                      sort: 'alpha',
                      access: subsonicBoundary(denied, age),
                  })
                : Promise.resolve([]),
            songCount > 0
                ? getTracksPaged(
                      sql,
                      auth.userId,
                      songCount,
                      songOffset,
                      subsonicBoundary(denied, age),
                  )
                : Promise.resolve([]),
        ]);

        const artist: SubsonicArtist[] = artistRows.map((a) => {
            const r: SubsonicArtist = { id: a.id, name: a.title };
            if (a.custom_poster_url) r.coverArt = a.id;
            return r;
        });
        const album: SubsonicAlbum[] = albumRows.map(serializeAlbum);
        const song: SubsonicSong[] = songRows.map((t) => serializeSong(t));

        return subsonicOk({ searchResult3: { artist, album, song } }, auth.format);
    }

    const totalLimit = Math.min(1500, (artistCount + albumCount + songCount) * 3);
    const results = await searchMusic(
        sql,
        term,
        totalLimit,
        // Translation-only: /subsonic auth semantics are out of scope for the
        // access-boundary migration, so the existing pair is adapted verbatim.
        subsonicBoundary(denied, ageRatingFromAuth(auth)),
    );

    const artist: SubsonicArtist[] = [];
    const album: SubsonicAlbum[] = [];
    const song: SubsonicSong[] = [];

    for (const row of results) {
        if (row.media_type === 'artist' && artist.length < artistCount) {
            const a: SubsonicArtist = {
                id: row.id,
                name: row.title,
            };
            if (row.image_source_id) a.coverArt = row.image_source_id;
            artist.push(a);
        } else if (row.media_type === 'album' && album.length < albumCount) {
            const a: SubsonicAlbum = {
                id: row.id,
                name: row.title,
                songCount: 0,
                duration: 0,
            };
            if (row.artist_name) a.artist = row.artist_name;
            if (row.artist_id) a.artistId = row.artist_id;
            if (row.year != null) a.year = row.year;
            if (row.created_at) a.created = row.created_at;
            a.coverArt = row.id;
            album.push(a);
        } else if (row.media_type === 'track' && song.length < songCount) {
            const s: SubsonicSong = {
                id: row.id,
                title: row.title,
                isDir: false,
                type: 'music',
                isVideo: false,
                duration: Math.round(row.runtime_seconds ?? 0),
            };
            if (row.album_title) s.album = row.album_title;
            if (row.album_id) s.albumId = row.album_id;
            if (row.artist_name) s.artist = row.artist_name;
            if (row.artist_id) s.artistId = row.artist_id;
            if (row.year != null) s.year = row.year;
            s.coverArt = row.id;
            song.push(s);
        }
    }

    return subsonicOk({ searchResult3: { artist, album, song } }, auth.format);
};

// search2 — legacy alias for search3 with response key "searchResult2".
export const handleSearch2: SubsonicHandler = async (
    event: RequestEvent,
    auth: SubsonicAuthContext,
    sql: postgres.Sql,
): Promise<Response> => {
    const query = getParam(event, 'query');
    if (query === null) {
        return subsonicError(10, 'Required parameter "query" is missing.', auth.format);
    }
    // Empty (incl. the quoted-empty forms clients send) = enumerate the library.
    const term = normalizeSearchQuery(query);
    const artistCount = clampInt(getIntParam(event, 'artistCount', 20), 0, 500);
    const albumCount = clampInt(getIntParam(event, 'albumCount', 20), 0, 500);
    const songCount = clampInt(getIntParam(event, 'songCount', 20), 0, 500);
    const artistOffset = Math.max(0, getIntParam(event, 'artistOffset', 0));
    const albumOffset = Math.max(0, getIntParam(event, 'albumOffset', 0));
    const songOffset = Math.max(0, getIntParam(event, 'songOffset', 0));

    const denied = await getDeniedLibraryGroups(sql, toLibraryAccessUser(auth));

    if (term === '') {
        const age = ageRatingFromAuth(auth);
        const [artistRows, albumRows, songRows] = await Promise.all([
            artistCount > 0
                ? getArtists(sql, {
                      limit: artistCount,
                      offset: artistOffset,
                      access: subsonicBoundary(denied, age),
                  })
                : Promise.resolve([]),
            albumCount > 0
                ? getAlbums(sql, {
                      limit: albumCount,
                      offset: albumOffset,
                      sort: 'alpha',
                      access: subsonicBoundary(denied, age),
                  })
                : Promise.resolve([]),
            songCount > 0
                ? getTracksPaged(
                      sql,
                      auth.userId,
                      songCount,
                      songOffset,
                      subsonicBoundary(denied, age),
                  )
                : Promise.resolve([]),
        ]);

        const artist: SubsonicArtist[] = artistRows.map((a) => {
            const r: SubsonicArtist = { id: a.id, name: a.title };
            if (a.custom_poster_url) r.coverArt = a.id;
            return r;
        });
        const album: SubsonicAlbum[] = albumRows.map(serializeAlbum);
        const song: SubsonicSong[] = songRows.map((t) => serializeSong(t));

        return subsonicOk({ searchResult2: { artist, album, song } }, auth.format);
    }

    const totalLimit = Math.min(1500, (artistCount + albumCount + songCount) * 3);
    const results = await searchMusic(
        sql,
        term,
        totalLimit,
        // Translation-only: /subsonic auth semantics are out of scope for the
        // access-boundary migration, so the existing pair is adapted verbatim.
        subsonicBoundary(denied, ageRatingFromAuth(auth)),
    );

    const artist: SubsonicArtist[] = [];
    const album: SubsonicAlbum[] = [];
    const song: SubsonicSong[] = [];

    for (const row of results) {
        if (row.media_type === 'artist' && artist.length < artistCount) {
            const a: SubsonicArtist = { id: row.id, name: row.title };
            if (row.image_source_id) a.coverArt = row.image_source_id;
            artist.push(a);
        } else if (row.media_type === 'album' && album.length < albumCount) {
            const a: SubsonicAlbum = {
                id: row.id,
                name: row.title,
                songCount: 0,
                duration: 0,
            };
            if (row.artist_name) a.artist = row.artist_name;
            if (row.artist_id) a.artistId = row.artist_id;
            if (row.year != null) a.year = row.year;
            if (row.created_at) a.created = row.created_at;
            a.coverArt = row.id;
            album.push(a);
        } else if (row.media_type === 'track' && song.length < songCount) {
            const s: SubsonicSong = {
                id: row.id,
                title: row.title,
                isDir: false,
                type: 'music',
                isVideo: false,
                duration: Math.round(row.runtime_seconds ?? 0),
            };
            if (row.album_title) s.album = row.album_title;
            if (row.album_id) s.albumId = row.album_id;
            if (row.artist_name) s.artist = row.artist_name;
            if (row.artist_id) s.artistId = row.artist_id;
            if (row.year != null) s.year = row.year;
            s.coverArt = row.id;
            song.push(s);
        }
    }

    return subsonicOk({ searchResult2: { artist, album, song } }, auth.format);
};

export const handleGetSimilarSongs2: SubsonicHandler = async (
    event: RequestEvent,
    auth: SubsonicAuthContext,
    sql: postgres.Sql,
): Promise<Response> => {
    const id = getParam(event, 'id');
    if (!id) {
        return subsonicError(10, 'Required parameter "id" is missing.', auth.format);
    }
    const count = clampInt(getIntParam(event, 'count', 50), 1, 500);

    // Submariner passes artist UUID, not track UUID. Detect by trying to load
    // the artist's tracks; if found, use the most-played as the embedding seed
    // and exclude the artist's own catalogue from results.
    const artistTracks = await getArtistTracks(
        sql,
        id,
        auth.userId,
        await subsonicAccessBoundary(sql, auth),
    );
    if (artistTracks.length > 0) {
        // Filter seed candidates so the embedding query isn't built from a
        // restricted track — otherwise the recommendation set is biased
        // toward content the user is not allowed to see.
        const accessibleSeeds = await filterAccessibleTracks(sql, artistTracks, auth);
        if (accessibleSeeds.length === 0) {
            return subsonicOk({ similarSongs2: { song: [] } }, auth.format);
        }
        const seed = [...accessibleSeeds].sort((a, b) => b.play_count - a.play_count)[0];
        const excludeIds = artistTracks.map((t) => t.id);
        const tracks = await getSimilarTracks(sql, seed.id, count, excludeIds);
        const playCounts = await getTrackPlayCounts(
            sql,
            auth.userId,
            tracks.map((t) => t.id),
        );
        const accessible = await filterAccessibleTracks(sql, tracks, auth);
        return subsonicOk(
            {
                similarSongs2: {
                    song: accessible.map((t) =>
                        serializeSong(t, undefined, undefined, undefined, playCounts.get(t.id)),
                    ),
                },
            },
            auth.format,
        );
    }

    // Fallback: treat id as a track UUID (Subsonic spec default).
    if (!(await checkSubsonicMediaAccess(sql, id, auth))) {
        return subsonicOk({ similarSongs2: { song: [] } }, auth.format);
    }
    const tracks = await getSimilarTracks(sql, id, count);
    const playCounts = await getTrackPlayCounts(
        sql,
        auth.userId,
        tracks.map((t) => t.id),
    );
    const accessibleTracks = await filterAccessibleTracks(sql, tracks, auth);
    return subsonicOk(
        {
            similarSongs2: {
                song: accessibleTracks.map((t) =>
                    serializeSong(t, undefined, undefined, undefined, playCounts.get(t.id)),
                ),
            },
        },
        auth.format,
    );
};

// getSimilarSongs — legacy alias for getSimilarSongs2 with response key
// "similarSongs". Identical artist-UUID detection logic.
export const handleGetSimilarSongs: SubsonicHandler = async (
    event: RequestEvent,
    auth: SubsonicAuthContext,
    sql: postgres.Sql,
): Promise<Response> => {
    const id = getParam(event, 'id');
    if (!id) {
        return subsonicError(10, 'Required parameter "id" is missing.', auth.format);
    }
    const count = clampInt(getIntParam(event, 'count', 50), 1, 500);

    const artistTracks = await getArtistTracks(
        sql,
        id,
        auth.userId,
        await subsonicAccessBoundary(sql, auth),
    );
    if (artistTracks.length > 0) {
        const accessibleSeeds = await filterAccessibleTracks(sql, artistTracks, auth);
        if (accessibleSeeds.length === 0) {
            return subsonicOk({ similarSongs: { song: [] } }, auth.format);
        }
        const seed = [...accessibleSeeds].sort((a, b) => b.play_count - a.play_count)[0];
        const excludeIds = artistTracks.map((t) => t.id);
        const tracks = await getSimilarTracks(sql, seed.id, count, excludeIds);
        const playCounts = await getTrackPlayCounts(
            sql,
            auth.userId,
            tracks.map((t) => t.id),
        );
        const accessible = await filterAccessibleTracks(sql, tracks, auth);
        return subsonicOk(
            {
                similarSongs: {
                    song: accessible.map((t) =>
                        serializeSong(t, undefined, undefined, undefined, playCounts.get(t.id)),
                    ),
                },
            },
            auth.format,
        );
    }

    if (!(await checkSubsonicMediaAccess(sql, id, auth))) {
        return subsonicOk({ similarSongs: { song: [] } }, auth.format);
    }
    const tracks = await getSimilarTracks(sql, id, count);
    const playCounts = await getTrackPlayCounts(
        sql,
        auth.userId,
        tracks.map((t) => t.id),
    );
    const accessibleTracks = await filterAccessibleTracks(sql, tracks, auth);
    return subsonicOk(
        {
            similarSongs: {
                song: accessibleTracks.map((t) =>
                    serializeSong(t, undefined, undefined, undefined, playCounts.get(t.id)),
                ),
            },
        },
        auth.format,
    );
};

export const handleGetTopSongs: SubsonicHandler = async (
    event: RequestEvent,
    auth: SubsonicAuthContext,
    sql: postgres.Sql,
): Promise<Response> => {
    const artist = getParam(event, 'artist');
    if (!artist) {
        return subsonicError(10, 'Required parameter "artist" is missing.', auth.format);
    }
    const count = clampInt(getIntParam(event, 'count', 50), 1, 500);

    const target = await findArtistByName(sql, artist);
    if (!target) {
        return subsonicOk({ topSongs: {} }, auth.format);
    }

    const tracks = await getArtistTracks(
        sql,
        target.id,
        auth.userId,
        await subsonicAccessBoundary(sql, auth),
    );
    const accessible = await filterAccessibleTracks(sql, tracks, auth);
    // Nothing visible answers exactly like an unknown artist, so the name
    // lookup cannot confirm that a hidden artist exists.
    if (accessible.length === 0) {
        return subsonicOk({ topSongs: {} }, auth.format);
    }
    const sorted = [...accessible].sort((a, b) => b.play_count - a.play_count);
    const top = sorted.slice(0, count);

    return subsonicOk(
        {
            topSongs: {
                song: top.map((t) =>
                    serializeSong(
                        {
                            id: t.id,
                            title: t.title,
                            sort_order: t.sort_order,
                            runtime_seconds: t.runtime_seconds,
                            custom_poster_url: t.custom_poster_url,
                            custom_metadata: t.custom_metadata,
                            album_id: t.album_id,
                            album_title: t.album_title,
                            album_custom_poster_url: t.album_custom_poster_url,
                            artist_id: target.id,
                            artist_title: target.title,
                            year: t.year,
                            file_path: t.file_path,
                        },
                        t.album_id,
                        target.id,
                        undefined,
                        t.play_count,
                    ),
                ),
            },
        },
        auth.format,
    );
};

export const handleGetRandomSongs: SubsonicHandler = async (
    event: RequestEvent,
    auth: SubsonicAuthContext,
    sql: postgres.Sql,
): Promise<Response> => {
    const size = clampInt(getIntParam(event, 'size', 10), 1, 500);
    const denied = await getDeniedLibraryGroups(sql, toLibraryAccessUser(auth));
    const tracks = await getRandomTracks(sql, auth.userId, size, denied, ageRatingFromAuth(auth));
    const playCounts = await getTrackPlayCounts(
        sql,
        auth.userId,
        tracks.map((t) => t.id),
    );
    return subsonicOk(
        {
            randomSongs: {
                song: tracks.map((t) =>
                    serializeSong(t, undefined, undefined, undefined, playCounts.get(t.id)),
                ),
            },
        },
        auth.format,
    );
};

export const handleGetSongsByGenre: SubsonicHandler = async (
    event: RequestEvent,
    auth: SubsonicAuthContext,
    sql: postgres.Sql,
): Promise<Response> => {
    const genre = getParam(event, 'genre');
    if (!genre) {
        return subsonicError(10, 'Required parameter "genre" is missing.', auth.format);
    }
    const count = clampInt(getIntParam(event, 'count', 10), 1, 500);
    const offset = Math.max(0, getIntParam(event, 'offset', 0));

    const denied = await getDeniedLibraryGroups(sql, toLibraryAccessUser(auth));
    const all = await getTracksByGenre(
        sql,
        genre,
        subsonicBoundary(denied, ageRatingFromAuth(auth)),
        count + offset,
    );
    const slice = all.slice(offset, offset + count);
    const playCounts = await getTrackPlayCounts(
        sql,
        auth.userId,
        slice.map((t) => t.id),
    );
    return subsonicOk(
        {
            songsByGenre: {
                song: slice.map((t) =>
                    serializeSong(t, undefined, undefined, undefined, playCounts.get(t.id)),
                ),
            },
        },
        auth.format,
    );
};

// ─── OpenSubsonic sonic-similarity extension ─────────────────────────────────

// getSonicSimilarTracks (OpenSubsonic sonic-similarity extension)
// Returns tracks with per-track cosine similarity scores using pgvector embeddings.
export const handleGetSonicSimilarTracks: SubsonicHandler = async (
    event: RequestEvent,
    auth: SubsonicAuthContext,
    sql: postgres.Sql,
): Promise<Response> => {
    const id = getParam(event, 'id');
    if (!id) {
        return subsonicError(10, 'Required parameter "id" is missing.', auth.format);
    }
    const count = clampInt(getIntParam(event, 'count', 10), 1, 200);

    if (!(await checkSubsonicMediaAccess(sql, id, auth))) {
        return subsonicError(70, 'Song not found.', auth.format);
    }

    const similar = await getSimilarTracks(sql, id, count);
    const sonicMatch: Array<{ entry: SubsonicSong; similarity: number }> = [];

    for (const row of similar) {
        if (!(await checkSubsonicMediaAccess(sql, row.id, auth))) continue;
        const track = await getTrackDetail(sql, row.id);
        if (!track) continue;
        sonicMatch.push({
            entry: serializeSong(track),
            similarity: Math.max(0, Math.min(1, row.similarity_score ?? 0)),
        });
    }

    return subsonicOk({ sonicMatch }, auth.format);
};

// findSonicPath — ordered path from startSongId to endSongId through embedding space.
// Spec requires: first entry = startSongId (similarity 1.0), last = endSongId.
// Intermediates are the tracks most similar to startSongId that aren't start/end.
export const handleFindSonicPath: SubsonicHandler = async (
    event: RequestEvent,
    auth: SubsonicAuthContext,
    sql: postgres.Sql,
): Promise<Response> => {
    const startId = getParam(event, 'startSongId');
    const endId = getParam(event, 'endSongId');
    if (!startId)
        return subsonicError(10, 'Required parameter "startSongId" is missing.', auth.format);
    if (!endId) return subsonicError(10, 'Required parameter "endSongId" is missing.', auth.format);
    const count = clampInt(getIntParam(event, 'count', 25), 1, 200);

    const [startAccessible, endAccessible] = await Promise.all([
        checkSubsonicMediaAccess(sql, startId, auth),
        checkSubsonicMediaAccess(sql, endId, auth),
    ]);
    if (!startAccessible) return subsonicError(70, 'Start song not found.', auth.format);
    if (!endAccessible) return subsonicError(70, 'End song not found.', auth.format);

    const [startTrack, endTrack] = await Promise.all([
        getTrackDetail(sql, startId),
        getTrackDetail(sql, endId),
    ]);
    if (!startTrack) return subsonicError(70, 'Start song not found.', auth.format);
    if (!endTrack) return subsonicError(70, 'End song not found.', auth.format);

    const sonicMatch: Array<{ entry: SubsonicSong; similarity: number }> = [];
    sonicMatch.push({ entry: serializeSong(startTrack), similarity: 1.0 });

    if (count > 2) {
        const intermediates = await getSimilarTracks(sql, startId, count - 2, [endId]);
        for (const row of intermediates) {
            if (!(await checkSubsonicMediaAccess(sql, row.id, auth))) continue;
            const track = await getTrackDetail(sql, row.id);
            if (!track) continue;
            sonicMatch.push({
                entry: serializeSong(track),
                similarity: Math.max(0, Math.min(1, row.similarity_score ?? 0)),
            });
        }
    }

    if (count > 1) {
        const endSimilarity = await getTrackPairSimilarity(sql, startId, endId);
        sonicMatch.push({
            entry: serializeSong(endTrack),
            similarity: endSimilarity !== null ? Math.max(0, Math.min(1, endSimilarity)) : -1,
        });
    }

    return subsonicOk({ sonicMatch }, auth.format);
};
