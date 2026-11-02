// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// OpenSubsonic Compatibility Layer — Ratings Handlers
// star, unstar, setRating, scrobble, getStarred, getStarred2.

import type { RequestEvent } from '@sveltejs/kit';
import { toUserId } from '$lib/shared/user-id.js';
import type postgres from 'postgres';
import { batchGetAvailability } from '$lib/server/database/queries/availability.queries.js';
import {
    subsonicError,
    subsonicOk,
    subsonicPing,
} from '$lib/server/subsonic-compat/serializers/response.js';
import { serializeArtist } from '$lib/server/subsonic-compat/serializers/artist.js';
import { serializeAlbum } from '$lib/server/subsonic-compat/serializers/album.js';
import { serializeSong } from '$lib/server/subsonic-compat/serializers/song.js';
import type {
    SubsonicAuthContext,
    SubsonicHandler,
    SubsonicArtist,
    SubsonicAlbum,
    SubsonicSong,
} from '$lib/server/subsonic-compat/types.js';
import { getParam, getAllParam } from '$lib/server/subsonic-compat/helpers.js';
import {
    getArtists,
    getAlbumWithTracks,
    getTrackDetail,
} from '$lib/server/database/queries/music.queries.js';
import {
    deleteUserRating,
    upsertUserRating,
    getStarredItemIds,
} from '$lib/server/database/queries/user-ratings.queries.js';
import {
    isUnrestricted,
    unrestrictedAccess,
} from '$lib/server/database/queries/builders/media-access-boundary.js';
import { stopSubsonicPlay } from '../play-tracking.js';
import {
    checkSubsonicMediaAccess,
    filterAccessibleTracks,
    getVisibleArtistWithAlbums,
    subsonicAccessBoundary,
    withVisibleTrackCounts,
} from '$lib/server/subsonic-compat/media-access.js';
import {
    upsertExternalSession,
    stopOtherActiveMusicSessions,
} from '$lib/server/database/queries/play-sessions.queries.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('SubsonicRatings');
import { musicInteractionManager } from '$lib/server/services/music-interaction-manager.service.js';
import { registerSubsonicDevice } from '../utils/device-registration.js';

// Shared starred data fetcher for getStarred and getStarred2.
async function buildStarredData(
    auth: SubsonicAuthContext,
    sql: postgres.Sql,
): Promise<{
    artist: SubsonicArtist[];
    album: SubsonicAlbum[];
    song: SubsonicSong[];
}> {
    // auth.userId is the stable users.id UUID (mig 16.46.0); user_ratings.user_id is now uuid.
    // Deliberately unfiltered at the query: this handler applies the Subsonic
    // access gate per item below (`checkSubsonicMediaAccess`), which is a
    // different and stricter predicate than the media_items boundary. Passing a
    // boundary here would double-filter without changing the outcome; the
    // explicit constructor keeps the bypass greppable.
    const rows = await getStarredItemIds(sql, auth.userId, unrestrictedAccess());
    const availability = await batchGetAvailability(
        sql,
        rows.map((row) => row.id),
    );

    const artistIds: string[] = [];
    const albumIds: string[] = [];
    const songIds: string[] = [];

    for (const row of rows) {
        if (row.media_type !== 'artist' && !availability.get(row.id)) continue;
        if (row.media_type === 'artist') artistIds.push(row.id);
        else if (row.media_type === 'album') albumIds.push(row.id);
        else if (row.media_type === 'track') songIds.push(row.id);
    }

    const access = await subsonicAccessBoundary(sql, auth);
    const [artistRows, albumResults, songResults] = await Promise.all([
        // Under the caller's boundary: a restricted caller's starred artist is
        // listed only while one of its tracks is playable for them, and its
        // album/song counts cover only those.
        artistIds.length > 0
            ? getArtists(sql, { limit: 9999, access }).then((all) =>
                  all.filter((a) => artistIds.includes(a.id)),
              )
            : Promise.resolve([]),
        Promise.all(albumIds.map((id) => getAlbumWithTracks(sql, id))),
        Promise.all(songIds.map((id) => getTrackDetail(sql, id))),
    ]);

    // Filter tracks the user can no longer access (policy changed after starring).
    const accessibleSongs: typeof songResults = [];
    for (const r of songResults) {
        if (!r) continue;
        if (!(await checkSubsonicMediaAccess(sql, r.id, auth))) continue;
        accessibleSongs.push(r);
    }

    // Albums with at least one accessible track, counted over those tracks.
    const album: SubsonicAlbum[] = [];
    for (const r of albumResults) {
        // getAlbumWithTracks also resolves a retained album whose tracks are all
        // gone (tracks: []); starred lists show playable albums only, and an
        // album with tracks is gated through them below (C14, 2026-09-16
        // security review 3 — a track-less album never bypasses the gate).
        if (!r || r.tracks.length === 0) continue;
        const accessible = await filterAccessibleTracks(sql, r.tracks, auth);
        if (accessible.length > 0)
            album.push(serializeAlbum(withVisibleTrackCounts(r.album, accessible)));
    }

    // A restricted caller also gets the same artist gate as getArtist. This
    // used to run only for callers with denied library groups, so an
    // age-limited caller kept a starred artist whose music is all over their
    // limit.
    let accessibleArtistRows = artistRows;
    if (!isUnrestricted(access)) {
        const filtered = [];
        for (const a of artistRows) {
            if (await getVisibleArtistWithAlbums(sql, a.id, auth)) filtered.push(a);
        }
        accessibleArtistRows = filtered;
    }

    const artist = accessibleArtistRows.map((a) => serializeArtist(a));
    const song = accessibleSongs.flatMap((r) => (r ? [serializeSong(r)] : []));

    return { artist, album, song };
}

// getStarred — legacy file-structure alias for getStarred2.
export const handleGetStarred: SubsonicHandler = async (
    _event: RequestEvent,
    auth: SubsonicAuthContext,
    sql: postgres.Sql,
): Promise<Response> => {
    const data = await buildStarredData(auth, sql);
    return subsonicOk({ starred: data }, auth.format);
};

// getStarred2 — return items the user has starred (rating == 10).
// Returns artist, album, and song buckets as per the Subsonic spec.
export const handleGetStarred2: SubsonicHandler = async (
    _event: RequestEvent,
    auth: SubsonicAuthContext,
    sql: postgres.Sql,
): Promise<Response> => {
    const data = await buildStarredData(auth, sql);
    return subsonicOk({ starred2: data }, auth.format);
};

export const handleStar: SubsonicHandler = async (
    event: RequestEvent,
    auth: SubsonicAuthContext,
    sql: postgres.Sql,
): Promise<Response> => {
    const ids = [
        ...getAllParam(event, 'id'),
        ...getAllParam(event, 'albumId'),
        ...getAllParam(event, 'artistId'),
    ];
    if (ids.length === 0) {
        return subsonicError(10, 'Required parameter "id" is missing.', auth.format);
    }
    for (const mediaId of ids) {
        if (!mediaId) continue;
        if (!(await checkSubsonicMediaAccess(sql, mediaId, auth))) continue;
        // auth.userId is the stable users.id UUID (mig 16.46.0)
        await upsertUserRating.execute(sql, {
            userId: auth.userId,
            mediaId,
            rating: 10,
        });
    }
    return subsonicPing(auth.format);
};

export const handleUnstar: SubsonicHandler = async (
    event: RequestEvent,
    auth: SubsonicAuthContext,
    sql: postgres.Sql,
): Promise<Response> => {
    const ids = [
        ...getAllParam(event, 'id'),
        ...getAllParam(event, 'albumId'),
        ...getAllParam(event, 'artistId'),
    ];
    if (ids.length === 0) {
        return subsonicError(10, 'Required parameter "id" is missing.', auth.format);
    }
    for (const mediaId of ids) {
        if (!mediaId) continue;
        if (!(await checkSubsonicMediaAccess(sql, mediaId, auth))) continue;
        // auth.userId is the stable users.id UUID (mig 16.46.0)
        await deleteUserRating.execute(sql, {
            userId: auth.userId,
            mediaId,
        });
    }
    return subsonicPing(auth.format);
};

export const handleSetRating: SubsonicHandler = async (
    event: RequestEvent,
    auth: SubsonicAuthContext,
    sql: postgres.Sql,
): Promise<Response> => {
    const id = getParam(event, 'id');
    if (!id) {
        return subsonicError(10, 'Required parameter "id" is missing.', auth.format);
    }
    const ratingRaw = getParam(event, 'rating');
    if (ratingRaw === null) {
        return subsonicError(10, 'Required parameter "rating" is missing.', auth.format);
    }
    const subsonic = parseInt(ratingRaw, 10);
    if (!Number.isFinite(subsonic) || subsonic < 0 || subsonic > 5) {
        return subsonicError(10, 'rating must be 0–5.', auth.format);
    }

    if (!(await checkSubsonicMediaAccess(sql, id, auth))) {
        return subsonicError(70, 'Song not found.', auth.format);
    }

    // auth.userId is the stable users.id UUID (mig 16.46.0)
    if (subsonic === 0) {
        await deleteUserRating.execute(sql, {
            userId: auth.userId,
            mediaId: id,
        });
    } else {
        // Subsonic 1-5 → internal 2-10 (multiply by 2)
        await upsertUserRating.execute(sql, {
            userId: auth.userId,
            mediaId: id,
            rating: subsonic * 2,
        });
    }
    return subsonicPing(auth.format);
};

export const handleScrobble: SubsonicHandler = async (
    event: RequestEvent,
    auth: SubsonicAuthContext,
    sql: postgres.Sql,
): Promise<Response> => {
    // Since 1.8.0 multiple id (and optional time) params are allowed.
    const ids = getAllParam(event, 'id');
    if (ids.length === 0) {
        return subsonicError(10, 'Required parameter "id" is missing.', auth.format);
    }
    const submissionParam = getParam(event, 'submission');
    // Subsonic spec: submission defaults to true when absent.
    const isSubmission =
        submissionParam === null ? true : submissionParam !== 'false' && submissionParam !== '0';

    for (const id of ids) {
        if (!id) continue;
        if (!(await checkSubsonicMediaAccess(sql, id, auth))) continue;
        const sourceSessionId = `${auth.userId}:${id}`;

        if (!isSubmission) {
            // Now-playing notification: record play start and create/refresh the session.
            await musicInteractionManager.reportPlayStart(
                toUserId(auth.userId),
                id,
                'subsonic',
                sql,
            );
            await upsertExternalSession(sql, {
                source: 'subsonic',
                surface: 'subsonic',
                source_session_id: sourceSessionId,
                media_id: id,
                // auth.userId is the stable users.id UUID (mig 16.46.0 — play_sessions.user_id is now uuid)
                user_id: auth.userId,
                device_id: `subsonic-${auth.userId}`,
                client_name: auth.clientName || 'Subsonic',
                status: 'ACTIVE',
                position_ms: 0,
                play_method: 'direct',
            });
            await registerSubsonicDevice(sql, auth.userId, auth.clientName);
            // Close any prior music session for this user that wasn't explicitly
            // scrobbled complete — happens on every client-side skip.
            const closed = await stopOtherActiveMusicSessions(
                sql,
                auth.userId,
                'subsonic',
                sourceSessionId,
            );
            if (closed.length > 0) {
                logger.debug('Closed superseded music sessions on new track start (scrobble)', {
                    // auth.userId is the stable users.id UUID (mig 16.46.0)
                    userId: auth.userId,
                    newTrackId: id,
                    closedCount: closed.length,
                    closedIds: closed.map((c) => c.id),
                });
            }
        } else {
            await stopSubsonicPlay(sql, auth, id, 'scrobbled').catch((err: unknown) => {
                logger.warn('Subsonic scrobble could not record a play end', {
                    mediaId: id,
                    error: err instanceof Error ? err.message : String(err),
                });
            });
        }
    }

    return subsonicPing(auth.format);
};
