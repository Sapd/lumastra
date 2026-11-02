// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// OpenSubsonic Compatibility Layer — Playback Handlers
// reportPlayback (OpenSubsonic playbackReport extension), tokenInfo, and legacy search.

import type { RequestEvent } from '@sveltejs/kit';
import { toUserId } from '$lib/shared/user-id.js';
import type postgres from 'postgres';
import {
    subsonicError,
    subsonicOk,
    subsonicPing,
} from '$lib/server/subsonic-compat/serializers/response.js';
import { serializeSong } from '$lib/server/subsonic-compat/serializers/song.js';
import type {
    SubsonicAuthContext,
    SubsonicHandler,
    SubsonicSong,
} from '$lib/server/subsonic-compat/types.js';
import { getParam, getIntParam, clampInt } from '$lib/server/subsonic-compat/helpers.js';
import { stopSubsonicPlay } from '../play-tracking.js';
import {
    upsertExternalSession,
    refreshExternalSessionPresence,
    stopOtherActiveMusicSessions,
} from '$lib/server/database/queries/play-sessions.queries.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('SubsonicPlayback');
import { musicInteractionManager } from '$lib/server/services/music-interaction-manager.service.js';
import { getTrackDetail } from '$lib/server/database/queries/music.queries.js';
import { searchMusic } from '$lib/server/database/queries/search.queries.js';
import { subsonicBoundary } from '$lib/server/subsonic-compat/media-access.js';
import { checkSubsonicMediaAccess } from '$lib/server/subsonic-compat/media-access.js';
import {
    getDeniedLibraryGroups,
    toLibraryAccessUser,
} from '$lib/server/cache/library-group-permissions-cache.js';
import { config } from '$lib/server/config.js';
import type { AgeRatingFilterParams } from '$lib/server/database/queries/builders/age-rating.builder.js';
import { registerSubsonicDevice } from '../utils/device-registration.js';

// reportPlayback (OpenSubsonic extension: playbackReport)
// Clients call this on state changes to report real-time playback position.
export const handleReportPlayback: SubsonicHandler = async (
    event: RequestEvent,
    auth: SubsonicAuthContext,
    sql: postgres.Sql,
): Promise<Response> => {
    const mediaId = getParam(event, 'mediaId');
    if (!mediaId) {
        return subsonicError(10, 'Required parameter "mediaId" is missing.', auth.format);
    }
    const mediaType = getParam(event, 'mediaType');
    if (!mediaType) {
        return subsonicError(10, 'Required parameter "mediaType" is missing.', auth.format);
    }
    const positionMsRaw = getParam(event, 'positionMs');
    if (positionMsRaw === null) {
        return subsonicError(10, 'Required parameter "positionMs" is missing.', auth.format);
    }
    const state = getParam(event, 'state');
    if (!state) {
        return subsonicError(10, 'Required parameter "state" is missing.', auth.format);
    }
    const ignoreScrobbleRaw = getParam(event, 'ignoreScrobble');
    const ignoreScrobble = ignoreScrobbleRaw === 'true' || ignoreScrobbleRaw === '1';
    const positionMs = Math.max(0, parseInt(positionMsRaw, 10) || 0);
    const sourceSessionId = `${auth.userId}:${mediaId}`;

    if (!(await checkSubsonicMediaAccess(sql, mediaId, auth))) {
        return subsonicError(70, 'Song not found.', auth.format);
    }

    if (state === 'starting') {
        await musicInteractionManager.reportPlayStart(
            toUserId(auth.userId),
            mediaId,
            'subsonic',
            sql,
        );
        await upsertExternalSession(sql, {
            source: 'subsonic',
            surface: 'subsonic',
            source_session_id: sourceSessionId,
            media_id: mediaId,
            user_id: auth.userId,
            device_id: `subsonic-${auth.userId}`,
            client_name: auth.clientName || 'Subsonic',
            status: 'ACTIVE',
            position_ms: positionMs,
            play_method: 'direct',
        });
        await registerSubsonicDevice(sql, auth.userId, auth.clientName);
        // Close any prior music session for this user that wasn't explicitly stopped.
        const closed = await stopOtherActiveMusicSessions(
            sql,
            auth.userId,
            'subsonic',
            sourceSessionId,
        );
        if (closed.length > 0) {
            logger.debug('Closed superseded music sessions on new track start (reportPlayback)', {
                userId: auth.userId,
                newMediaId: mediaId,
                closedCount: closed.length,
                closedIds: closed.map((c) => c.id),
            });
        }
    } else if (state === 'playing' || state === 'paused') {
        // PAUSED maps to the existing PAUSED status; PLAYING re-activates.
        await upsertExternalSession(sql, {
            source: 'subsonic',
            surface: 'subsonic',
            source_session_id: sourceSessionId,
            media_id: mediaId,
            user_id: auth.userId,
            device_id: `subsonic-${auth.userId}`,
            client_name: auth.clientName || 'Subsonic',
            status: state === 'paused' ? 'PAUSED' : 'ACTIVE',
            position_ms: positionMs,
            play_method: 'direct',
        });
    } else if (state === 'stopped') {
        await stopSubsonicPlay(sql, auth, mediaId, 'reportPlayback-stopped', ignoreScrobble).catch(
            (err: unknown) => {
                logger.warn('Subsonic scrobble could not record a play end', {
                    mediaId,
                    error: err instanceof Error ? err.message : String(err),
                });
            },
        );
    } else {
        // Unknown state — just keep the session alive.
        void refreshExternalSessionPresence(sql, 'subsonic', sourceSessionId).catch(() => {});
    }

    return subsonicPing(auth.format);
};

// tokenInfo (OpenSubsonic extension: apiKeyAuthentication)
// Returns information about the currently authenticated token/user.
export const handleTokenInfo: SubsonicHandler = async (
    _event: RequestEvent,
    auth: SubsonicAuthContext,
    _sql: postgres.Sql,
): Promise<Response> => {
    return subsonicOk({ tokenInfo: { username: auth.username } }, auth.format);
};

// search — deprecated since 1.4.0, superseded by search2/search3.
// Returns a flat searchResult with only songs.
export const handleSearch: SubsonicHandler = async (
    event: RequestEvent,
    auth: SubsonicAuthContext,
    sql: postgres.Sql,
): Promise<Response> => {
    const query =
        getParam(event, 'any') ??
        getParam(event, 'title') ??
        getParam(event, 'artist') ??
        getParam(event, 'album') ??
        '';
    const count = clampInt(getIntParam(event, 'count', 20), 1, 500);

    if (!query.trim()) {
        return subsonicOk({ searchResult: { match: 0, song: [] } }, auth.format);
    }

    const denied = await getDeniedLibraryGroups(sql, toLibraryAccessUser(auth));
    const ageRating: AgeRatingFilterParams | null =
        auth.isAgeRestricted && auth.maxAgeRating !== null
            ? {
                  maxAgeRating: auth.maxAgeRating,
                  allowUnrated: config.UNRATED_CONTENT_VISIBLE,
              }
            : null;
    const rows = await searchMusic(
        sql,
        query,
        count * 3,
        // Translation-only: /subsonic auth semantics are out of scope for the
        // access-boundary migration, so the existing pair is adapted verbatim.
        subsonicBoundary(denied, ageRating),
    );
    const songs: SubsonicSong[] = [];
    for (const row of rows) {
        if (row.media_type !== 'track') continue;
        if (songs.length >= count) break;
        if (!(await checkSubsonicMediaAccess(sql, row.id, auth))) continue;
        const track = await getTrackDetail(sql, row.id);
        if (track) songs.push(serializeSong(track));
    }

    return subsonicOk({ searchResult: { match: songs.length, song: songs } }, auth.format);
};
