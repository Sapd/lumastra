// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// OpenSubsonic Compatibility Layer — Info Handlers
// getArtistInfo, getArtistInfo2, getAlbumInfo, getAlbumInfo2, getLyrics.

import type { RequestEvent } from '@sveltejs/kit';
import type postgres from 'postgres';
import { subsonicError, subsonicOk } from '$lib/server/subsonic-compat/serializers/response.js';
import type { SubsonicAuthContext, SubsonicHandler } from '$lib/server/subsonic-compat/types.js';
import { getParam } from '$lib/server/subsonic-compat/helpers.js';
import {
    getAlbumWithTracks,
    getTrackDetail,
    findTracksByTitle,
} from '$lib/server/database/queries/music.queries.js';
import {
    checkSubsonicMediaAccess,
    filterAccessibleTracks,
    getVisibleArtistWithAlbums,
} from '$lib/server/subsonic-compat/media-access.js';

// getArtistInfo2 — return artist biography from the DB.
export const handleGetArtistInfo2: SubsonicHandler = async (
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
    return subsonicOk(
        {
            artistInfo2: {
                biography: result.artist.overview ?? '',
                musicBrainzId: '',
                lastFmUrl: '',
                smallImageUrl: '',
                mediumImageUrl: '',
                largeImageUrl: '',
                similarArtist: [],
            },
        },
        auth.format,
    );
};

// getArtistInfo — legacy alias for getArtistInfo2 with response key "artistInfo".
export const handleGetArtistInfo: SubsonicHandler = async (
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
    return subsonicOk(
        {
            artistInfo: {
                biography: result.artist.overview ?? '',
                musicBrainzId: '',
                lastFmUrl: '',
                smallImageUrl: '',
                mediumImageUrl: '',
                largeImageUrl: '',
                similarArtist: [],
            },
        },
        auth.format,
    );
};

// getAlbumInfo2 — return album notes from the DB.
export const handleGetAlbumInfo2: SubsonicHandler = async (
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
    if (result.tracks.length > 0) {
        const accessible = await filterAccessibleTracks(sql, result.tracks, auth);
        if (accessible.length === 0) return subsonicError(70, 'Album not found.', auth.format);
    } else if (!(await checkSubsonicMediaAccess(sql, id, auth))) {
        return subsonicError(70, 'Album not found.', auth.format);
    }
    return subsonicOk(
        {
            albumInfo2: {
                notes: result.album.overview ?? '',
                musicBrainzId: '',
                lastFmUrl: '',
                smallImageUrl: '',
                mediumImageUrl: '',
                largeImageUrl: '',
            },
        },
        auth.format,
    );
};

// getAlbumInfo — legacy alias for getAlbumInfo2 with response key "albumInfo".
export const handleGetAlbumInfo: SubsonicHandler = async (
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
    if (result.tracks.length > 0) {
        const accessible = await filterAccessibleTracks(sql, result.tracks, auth);
        if (accessible.length === 0) return subsonicError(70, 'Album not found.', auth.format);
    } else if (!(await checkSubsonicMediaAccess(sql, id, auth))) {
        return subsonicError(70, 'Album not found.', auth.format);
    }
    return subsonicOk(
        {
            albumInfo: {
                notes: result.album.overview ?? '',
                musicBrainzId: '',
                lastFmUrl: '',
                smallImageUrl: '',
                mediumImageUrl: '',
                largeImageUrl: '',
            },
        },
        auth.format,
    );
};

// getLyrics — find a track by title match and return its plain lyrics text.
export const handleGetLyrics: SubsonicHandler = async (
    event: RequestEvent,
    auth: SubsonicAuthContext,
    sql: postgres.Sql,
): Promise<Response> => {
    const artist = getParam(event, 'artist') ?? '';
    const title = getParam(event, 'title') ?? '';

    if (!title) {
        return subsonicOk({ lyrics: {} }, auth.format);
    }

    const rows = await findTracksByTitle(sql, title, artist || undefined);

    for (const row of rows) {
        if (!(await checkSubsonicMediaAccess(sql, row.id, auth))) continue;
        const track = await getTrackDetail(sql, row.id);
        if (!track) continue;
        const meta = track.custom_metadata as Record<string, unknown>;
        const lyricsRaw = meta.lyrics;
        if (!lyricsRaw || typeof lyricsRaw !== 'object' || Array.isArray(lyricsRaw)) continue;
        const lyrics = lyricsRaw as Record<string, unknown>;
        const plain = typeof lyrics.plain === 'string' ? lyrics.plain : null;
        if (!plain) continue;
        return subsonicOk({ lyrics: { artist, title, _text: plain } }, auth.format);
    }

    return subsonicOk({ lyrics: {} }, auth.format);
};
