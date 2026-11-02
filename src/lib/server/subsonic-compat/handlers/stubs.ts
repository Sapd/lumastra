// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// OpenSubsonic Compatibility Layer — Stub Handlers
// Endpoints that return static or minimal responses, not-supported errors,
// or empty collections for features Lumastra doesn't implement.

import type { RequestEvent } from '@sveltejs/kit';
import type postgres from 'postgres';
import {
    subsonicOk,
    subsonicPing,
    subsonicError,
} from '$lib/server/subsonic-compat/serializers/response.js';
import type { SubsonicAuthContext, SubsonicHandler } from '$lib/server/subsonic-compat/types.js';
import { config } from '$lib/server/config.js';
import * as m from '$lib/paraglide/messages';

interface RadioStationRow {
    id: string;
    title: string;
    custom_metadata: Record<string, unknown>;
    custom_poster_url: string | null;
}

export const handlePing: SubsonicHandler = async (
    _event: RequestEvent,
    auth: SubsonicAuthContext,
): Promise<Response> => {
    return subsonicPing(auth.format);
};

export const handleGetLicense: SubsonicHandler = async (
    _event: RequestEvent,
    auth: SubsonicAuthContext,
): Promise<Response> => {
    return subsonicOk(
        {
            license: {
                valid: true,
                email: '',
                licenseExpires: '2099-12-31T00:00:00.000Z',
                trialExpires: '2099-12-31T00:00:00.000Z',
            },
        },
        auth.format,
    );
};

export const handleGetOpenSubsonicExtensions: SubsonicHandler = async (
    _event: RequestEvent,
    auth: SubsonicAuthContext,
): Promise<Response> => {
    return subsonicOk(
        {
            openSubsonicExtensions: [
                { name: 'formPost', versions: [1] },
                { name: 'songLyrics', versions: [1] },
                { name: 'sonicSimilarity', versions: [1] },
                { name: 'playbackReport', versions: [1] },
                { name: 'indexBasedQueue', versions: [1] },
                { name: 'apiKeyAuthentication', versions: [1] },
                { name: 'transcodeOffset', versions: [1] },
                { name: 'transcoding', versions: [1] },
            ],
        },
        auth.format,
    );
};

export const handleGetMusicFolders: SubsonicHandler = async (
    _event: RequestEvent,
    auth: SubsonicAuthContext,
): Promise<Response> => {
    return subsonicOk(
        {
            musicFolders: {
                musicFolder: [{ id: 1, name: m.subsonic_music_library() }],
            },
        },
        auth.format,
    );
};

export const handleGetPodcasts: SubsonicHandler = async (
    _event: RequestEvent,
    auth: SubsonicAuthContext,
): Promise<Response> => {
    return subsonicOk({ podcasts: { channel: [] } }, auth.format);
};

export const handleGetScanStatus: SubsonicHandler = async (
    _event: RequestEvent,
    auth: SubsonicAuthContext,
): Promise<Response> => {
    return subsonicOk({ scanStatus: { scanning: false, count: 0 } }, auth.format);
};

export const handleGetNowPlaying: SubsonicHandler = async (
    _event: RequestEvent,
    auth: SubsonicAuthContext,
    _sql: postgres.Sql,
): Promise<Response> => {
    return subsonicOk({ nowPlaying: {} }, auth.format);
};

// ─── Internet Radio (read-only) ───────────────────────────────────────────────

export const handleGetInternetRadioStations: SubsonicHandler = async (
    _event: RequestEvent,
    auth: SubsonicAuthContext,
    sql: postgres.Sql,
): Promise<Response> => {
    const ageFilter =
        auth.isAgeRestricted && auth.maxAgeRating !== null
            ? sql`AND (
                (age_rating IS NULL AND ${config.UNRATED_CONTENT_VISIBLE}::boolean)
                OR age_rating <= ${auth.maxAgeRating}
            )`
            : sql``;

    const rows = await sql<RadioStationRow[]>`
        SELECT
            id,
            title,
            COALESCE(custom_metadata, '{}'::jsonb) AS custom_metadata,
            custom_poster_url
        FROM media_items
        WHERE media_type = 'radio'
          ${ageFilter}
        ORDER BY title ASC
    `;

    const stations = rows.map((row) => {
        const streamUrl = (row.custom_metadata.stream_url as string | undefined) ?? '';
        const station: Record<string, unknown> = {
            id: row.id,
            name: row.title,
            streamUrl,
        };
        if (row.custom_metadata.home_page_url) {
            station.homePageUrl = row.custom_metadata.home_page_url;
        }
        return station;
    });

    return subsonicOk({ internetRadioStations: { internetRadioStation: stations } }, auth.format);
};

export const handleCreateInternetRadioStation: SubsonicHandler = async (
    _event: RequestEvent,
    auth: SubsonicAuthContext,
): Promise<Response> => {
    return subsonicError(0, m.subsonic_internet_radio_not_supported(), auth.format);
};

export const handleUpdateInternetRadioStation: SubsonicHandler = async (
    _event: RequestEvent,
    auth: SubsonicAuthContext,
): Promise<Response> => {
    return subsonicError(0, m.subsonic_internet_radio_not_supported(), auth.format);
};

export const handleDeleteInternetRadioStation: SubsonicHandler = async (
    _event: RequestEvent,
    auth: SubsonicAuthContext,
): Promise<Response> => {
    return subsonicError(0, m.subsonic_internet_radio_not_supported(), auth.format);
};

// ─── Chat (not supported) ─────────────────────────────────────────────────────

export const handleGetChatMessages: SubsonicHandler = async (
    _event: RequestEvent,
    auth: SubsonicAuthContext,
): Promise<Response> => {
    return subsonicOk({ chatMessages: { chatMessage: [] } }, auth.format);
};

export const handleAddChatMessage: SubsonicHandler = async (
    _event: RequestEvent,
    auth: SubsonicAuthContext,
): Promise<Response> => {
    return subsonicPing(auth.format);
};

// ─── Video (not supported) ────────────────────────────────────────────────────

export const handleGetVideos: SubsonicHandler = async (
    _event: RequestEvent,
    auth: SubsonicAuthContext,
): Promise<Response> => {
    return subsonicOk({ videos: { video: [] } }, auth.format);
};

export const handleGetVideoInfo: SubsonicHandler = async (
    _event: RequestEvent,
    auth: SubsonicAuthContext,
): Promise<Response> => {
    return subsonicError(70, m.subsonic_video_not_found(), auth.format);
};

export const handleGetCaptions: SubsonicHandler = async (
    _event: RequestEvent,
    auth: SubsonicAuthContext,
): Promise<Response> => {
    return subsonicError(70, m.subsonic_video_not_found(), auth.format);
};

// ─── User management (forward-auth only — can't change passwords via Subsonic) ─

export const handleChangePassword: SubsonicHandler = async (
    _event: RequestEvent,
    auth: SubsonicAuthContext,
): Promise<Response> => {
    return subsonicError(50, m.subsonic_password_managed_by_idp(), auth.format);
};

export const handleCreateUser: SubsonicHandler = async (
    _event: RequestEvent,
    auth: SubsonicAuthContext,
): Promise<Response> => {
    return subsonicError(50, m.subsonic_user_management_by_idp(), auth.format);
};

export const handleUpdateUser: SubsonicHandler = async (
    _event: RequestEvent,
    auth: SubsonicAuthContext,
): Promise<Response> => {
    return subsonicError(50, m.subsonic_user_management_by_idp(), auth.format);
};

export const handleDeleteUser: SubsonicHandler = async (
    _event: RequestEvent,
    auth: SubsonicAuthContext,
): Promise<Response> => {
    return subsonicError(50, m.subsonic_user_management_by_idp(), auth.format);
};

// ─── Avatar (not implemented) ─────────────────────────────────────────────────

export const handleGetAvatar: SubsonicHandler = async (
    _event: RequestEvent,
    auth: SubsonicAuthContext,
): Promise<Response> => {
    return subsonicError(70, m.subsonic_avatar_not_found(), auth.format);
};

// ─── Jukebox (not supported) ──────────────────────────────────────────────────

export const handleJukeboxControl: SubsonicHandler = async (
    _event: RequestEvent,
    auth: SubsonicAuthContext,
): Promise<Response> => {
    return subsonicError(0, m.subsonic_jukebox_not_supported(), auth.format);
};

// ─── Sharing (not implemented) ────────────────────────────────────────────────

export const handleGetShares: SubsonicHandler = async (
    _event: RequestEvent,
    auth: SubsonicAuthContext,
): Promise<Response> => {
    return subsonicOk({ shares: { share: [] } }, auth.format);
};

export const handleCreateShare: SubsonicHandler = async (
    _event: RequestEvent,
    auth: SubsonicAuthContext,
): Promise<Response> => {
    return subsonicError(0, m.subsonic_sharing_not_supported(), auth.format);
};

export const handleUpdateShare: SubsonicHandler = async (
    _event: RequestEvent,
    auth: SubsonicAuthContext,
): Promise<Response> => {
    return subsonicError(0, m.subsonic_sharing_not_supported(), auth.format);
};

export const handleDeleteShare: SubsonicHandler = async (
    _event: RequestEvent,
    auth: SubsonicAuthContext,
): Promise<Response> => {
    return subsonicError(0, m.subsonic_sharing_not_supported(), auth.format);
};

// ─── Podcast management stubs ─────────────────────────────────────────────────

export const handleGetNewestPodcasts: SubsonicHandler = async (
    _event: RequestEvent,
    auth: SubsonicAuthContext,
): Promise<Response> => {
    return subsonicOk({ newestPodcasts: { episode: [] } }, auth.format);
};

export const handleCreatePodcastChannel: SubsonicHandler = async (
    _event: RequestEvent,
    auth: SubsonicAuthContext,
): Promise<Response> => {
    return subsonicError(0, m.subsonic_podcasts_not_supported(), auth.format);
};

export const handleDeletePodcastChannel: SubsonicHandler = async (
    _event: RequestEvent,
    auth: SubsonicAuthContext,
): Promise<Response> => {
    return subsonicError(0, m.subsonic_podcasts_not_supported(), auth.format);
};

export const handleGetPodcastEpisode: SubsonicHandler = async (
    _event: RequestEvent,
    auth: SubsonicAuthContext,
): Promise<Response> => {
    return subsonicError(70, m.subsonic_podcast_episode_not_found(), auth.format);
};

export const handleDeletePodcastEpisode: SubsonicHandler = async (
    _event: RequestEvent,
    auth: SubsonicAuthContext,
): Promise<Response> => {
    return subsonicError(70, m.subsonic_podcast_episode_not_found(), auth.format);
};

export const handleDownloadPodcastEpisode: SubsonicHandler = async (
    _event: RequestEvent,
    auth: SubsonicAuthContext,
): Promise<Response> => {
    return subsonicError(70, m.subsonic_podcast_episode_not_found(), auth.format);
};

export const handleRefreshPodcasts: SubsonicHandler = async (
    _event: RequestEvent,
    auth: SubsonicAuthContext,
): Promise<Response> => {
    return subsonicPing(auth.format);
};

// handleGetTranscodeDecision and handleGetTranscodeStream are implemented in handlers/transcode.ts.
// handleGetSonicSimilarTracks and handleFindSonicPath are implemented in handlers/search.ts.
