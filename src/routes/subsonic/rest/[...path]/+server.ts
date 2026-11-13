// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// OpenSubsonic Compatibility Layer — Route Dispatcher
//
// Handles all `/subsonic/rest/<method>(.view)?` requests. Each handler maps a
// Subsonic endpoint to a Lumastra query module / service and serializes the
// result into the Subsonic JSON or XML envelope.

import {
    AuthDependencyUnavailableError,
    isDependencyError,
} from '$lib/server/auth/dependency-unavailable.js';
import type { RequestEvent, RequestHandler } from './$types';
import { features } from '$lib/server/config.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { Logger } from '$lib/server/utils/logger.js';
import {
    getSubsonicFormat,
    parseSubsonicAuth,
    recordSubsonicAuthFailure,
} from '$lib/server/subsonic-compat/middleware.js';
import {
    BODY_TOO_LARGE,
    DEFAULT_MAX_BODY_BYTES,
    isDeclaredContentLengthOverCap,
    readBoundedBodyText,
} from '$lib/server/utils/bounded-body-reader.js';
import { subsonicError } from '$lib/server/subsonic-compat/serializers/response.js';
import type { SubsonicHandler, SubsonicAuthContext } from '$lib/server/subsonic-compat/types.js';
import { validateApiKey } from '$lib/server/subsonic-compat/auth.js';
import { ensureUserProfileExists } from '$lib/server/database/queries/user-ratings.queries.js';
import { toUserId } from '$lib/shared/user-id.js';

// Handlers
import {
    handlePing,
    handleGetLicense,
    handleGetOpenSubsonicExtensions,
    handleGetMusicFolders,
    handleGetPodcasts,
    handleGetScanStatus,
    handleGetNowPlaying,
    handleGetInternetRadioStations,
    handleCreateInternetRadioStation,
    handleUpdateInternetRadioStation,
    handleDeleteInternetRadioStation,
    handleGetChatMessages,
    handleAddChatMessage,
    handleGetVideos,
    handleGetVideoInfo,
    handleGetCaptions,
    handleChangePassword,
    handleCreateUser,
    handleUpdateUser,
    handleDeleteUser,
    handleGetAvatar,
    handleJukeboxControl,
    handleGetShares,
    handleCreateShare,
    handleUpdateShare,
    handleDeleteShare,
    handleGetNewestPodcasts,
    handleCreatePodcastChannel,
    handleDeletePodcastChannel,
    handleGetPodcastEpisode,
    handleDeletePodcastEpisode,
    handleDownloadPodcastEpisode,
    handleRefreshPodcasts,
} from '$lib/server/subsonic-compat/handlers/stubs.js';
import {
    handleGetTranscodeDecision,
    handleGetTranscodeStream,
} from '$lib/server/subsonic-compat/handlers/transcode.js';
import {
    handleGetArtists,
    handleGetArtist,
    handleGetAlbum,
    handleGetSong,
    handleGetGenres,
    handleGetMusicDirectory,
    handleGetIndexes,
    handleGetAlbumList,
    handleGetAlbumList2,
} from '$lib/server/subsonic-compat/handlers/browse.js';
import {
    handleSearch2,
    handleSearch3,
    handleGetSimilarSongs,
    handleGetSimilarSongs2,
    handleGetTopSongs,
    handleGetRandomSongs,
    handleGetSongsByGenre,
    handleGetSonicSimilarTracks,
    handleFindSonicPath,
} from '$lib/server/subsonic-compat/handlers/search.js';
import {
    handleStream,
    handleDownload,
    handleGetCoverArt,
    handleGetLyricsBySongId,
} from '$lib/server/subsonic-compat/handlers/stream.js';
import {
    handleGetPlaylists,
    handleGetPlaylist,
    handleCreatePlaylist,
    handleUpdatePlaylist,
    handleDeletePlaylist,
    handleGetPlayQueue,
    handleSavePlayQueue,
    handleGetPlayQueueByIndex,
    handleSavePlayQueueByIndex,
} from '$lib/server/subsonic-compat/handlers/playlists.js';
import { handleGetUser, handleGetUsers } from '$lib/server/subsonic-compat/handlers/user.js';
import {
    handleGetStarred,
    handleGetStarred2,
    handleStar,
    handleUnstar,
    handleSetRating,
    handleScrobble,
} from '$lib/server/subsonic-compat/handlers/ratings.js';
import {
    handleGetArtistInfo,
    handleGetArtistInfo2,
    handleGetAlbumInfo,
    handleGetAlbumInfo2,
    handleGetLyrics,
} from '$lib/server/subsonic-compat/handlers/info.js';
import {
    handleGetBookmarks,
    handleCreateBookmark,
    handleDeleteBookmark,
} from '$lib/server/subsonic-compat/handlers/bookmarks.js';
import {
    handleReportPlayback,
    handleTokenInfo,
    handleSearch,
} from '$lib/server/subsonic-compat/handlers/playback.js';

const logger = Logger.for('SubsonicCompat');

/**
 * The codebase's standard 413 oversize-body response — matches
 * `src/lib/server/plugins/runtime/webhook-dispatch.ts:184-191` byte for byte
 * (same status, same `{ error: 'payload too large' }` shape). The sibling
 * pre-handler dispatch layer `src/lib/server/plugins/runtime/feature-dispatch.ts:199`
 * uses the same 413 status but a differently-capitalized `Response.json({
 * error: 'Payload too large' })` — noted here so a future reader doesn't
 * assume the two are byte-identical. Used rather than a Subsonic protocol
 * error envelope because this rejection happens before the request's
 * Subsonic auth/format handling is even reached.
 */
function oversizeBodyResponse(): Response {
    return new Response(JSON.stringify({ error: 'payload too large' }), {
        status: 413,
        headers: { 'content-type': 'application/json' },
    });
}

// =============================================================================
// Dispatcher
// =============================================================================

const HANDLERS: Record<string, SubsonicHandler> = {
    ping: handlePing,
    getLicense: handleGetLicense,
    getOpenSubsonicExtensions: handleGetOpenSubsonicExtensions,
    getMusicFolders: handleGetMusicFolders,
    getMusicDirectory: handleGetMusicDirectory,
    getIndexes: handleGetIndexes,
    getArtists: handleGetArtists,
    getArtist: handleGetArtist,
    getStarred2: handleGetStarred2,
    getNowPlaying: handleGetNowPlaying,
    getAlbum: handleGetAlbum,
    getAlbumList: handleGetAlbumList,
    getAlbumList2: handleGetAlbumList2,
    getSong: handleGetSong,
    getGenres: handleGetGenres,
    search3: handleSearch3,
    stream: handleStream,
    download: handleDownload,
    getCoverArt: handleGetCoverArt,
    getLyricsBySongId: handleGetLyricsBySongId,
    getRandomSongs: handleGetRandomSongs,
    getSimilarSongs2: handleGetSimilarSongs2,
    getSongsByGenre: handleGetSongsByGenre,
    getTopSongs: handleGetTopSongs,
    getPlaylists: handleGetPlaylists,
    getPlaylist: handleGetPlaylist,
    createPlaylist: handleCreatePlaylist,
    updatePlaylist: handleUpdatePlaylist,
    deletePlaylist: handleDeletePlaylist,
    getPlayQueue: handleGetPlayQueue,
    savePlayQueue: handleSavePlayQueue,
    scrobble: handleScrobble,
    setRating: handleSetRating,
    star: handleStar,
    unstar: handleUnstar,
    getUser: handleGetUser,
    getUsers: handleGetUsers,
    getPodcasts: handleGetPodcasts,
    getScanStatus: handleGetScanStatus,
    startScan: handleGetScanStatus,
    getStarred: handleGetStarred,
    getSimilarSongs: handleGetSimilarSongs,
    search2: handleSearch2,
    getArtistInfo: handleGetArtistInfo,
    getArtistInfo2: handleGetArtistInfo2,
    getAlbumInfo: handleGetAlbumInfo,
    getAlbumInfo2: handleGetAlbumInfo2,
    getLyrics: handleGetLyrics,
    getBookmarks: handleGetBookmarks,
    createBookmark: handleCreateBookmark,
    deleteBookmark: handleDeleteBookmark,

    // OpenSubsonic extensions
    reportPlayback: handleReportPlayback,
    tokenInfo: handleTokenInfo,
    getPlayQueueByIndex: handleGetPlayQueueByIndex,
    savePlayQueueByIndex: handleSavePlayQueueByIndex,

    // Legacy deprecated search
    search: handleSearch,

    // Internet radio (not supported)
    getInternetRadioStations: handleGetInternetRadioStations,
    createInternetRadioStation: handleCreateInternetRadioStation,
    updateInternetRadioStation: handleUpdateInternetRadioStation,
    deleteInternetRadioStation: handleDeleteInternetRadioStation,

    // Chat
    getChatMessages: handleGetChatMessages,
    addChatMessage: handleAddChatMessage,

    // Video (not implemented)
    getVideos: handleGetVideos,
    getVideoInfo: handleGetVideoInfo,
    getCaptions: handleGetCaptions,

    // User management (forward-auth only)
    changePassword: handleChangePassword,
    createUser: handleCreateUser,
    updateUser: handleUpdateUser,
    deleteUser: handleDeleteUser,

    // Misc
    getAvatar: handleGetAvatar,
    jukeboxControl: handleJukeboxControl,

    // Sharing (not implemented)
    getShares: handleGetShares,
    createShare: handleCreateShare,
    updateShare: handleUpdateShare,
    deleteShare: handleDeleteShare,

    // Podcast management stubs
    getNewestPodcasts: handleGetNewestPodcasts,
    createPodcastChannel: handleCreatePodcastChannel,
    deletePodcastChannel: handleDeletePodcastChannel,
    getPodcastEpisode: handleGetPodcastEpisode,
    deletePodcastEpisode: handleDeletePodcastEpisode,
    downloadPodcastEpisode: handleDownloadPodcastEpisode,
    refreshPodcasts: handleRefreshPodcasts,

    // OpenSubsonic transcoding extension
    getTranscodeDecision: handleGetTranscodeDecision,
    getTranscodeStream: handleGetTranscodeStream,

    // OpenSubsonic sonic-similarity (served by handlers/search.ts)
    getSonicSimilarTracks: handleGetSonicSimilarTracks,
    findSonicPath: handleFindSonicPath,
};

async function dispatch(event: RequestEvent): Promise<Response> {
    const { url, params } = event;
    const format = getSubsonicFormat(url);

    if (!features.subsonicCompat) {
        return subsonicError(0, 'Subsonic API is not enabled.', format);
    }

    const rawPath = Array.isArray(params.path)
        ? (params.path as string[]).join('/')
        : (params.path ?? '');
    const tail = rawPath.split('/').pop() ?? '';
    const method = tail.replace(/\.view$/, '');

    if (!method) {
        return subsonicError(70, 'Unknown method.', format);
    }

    // Parse POST form body once and stash in locals so getParam/getAllParam
    // helpers (and parseSubsonicAuth) can read it without re-consuming the stream.
    //
    // C15 (2026-09-17 review 4): this body is read to find u/p/t/s/apiKey —
    // BEFORE any credential is checked — so it must go through the same
    // bounded reader every other pre-auth body read in this codebase uses
    // (`utils/bounded-body-reader.ts`), never a bare `request.text()`. The
    // shared default cap (256 KB) is used rather than a tighter one like
    // `transcode.ts`'s 16 KB `ClientInfo` cap: the largest KNOWN legitimate
    // body is `handleSavePlayQueue`/`handleSavePlayQueueByIndex`
    // (`playlists.ts:500,532`), which cap their `id` param at
    // `.slice(0, 2000)` — ~86 KB of form-encoded UUIDs. `createPlaylist`'s
    // `songId` (`playlists.ts:283`) and `updatePlaylist`'s `songIdToAdd`
    // (`playlists.ts:407`) go through `getAllParam` (`helpers.ts:15-19`),
    // which applies NO cap of its own — those lists are effectively
    // uncapped up to whatever this 256 KB body cap allows (~5,900 tracks
    // per POST, far past any real client's playlist size).
    if (event.request.method === 'POST') {
        const ct = event.request.headers.get('content-type') ?? '';
        if (ct.includes('application/x-www-form-urlencoded')) {
            if (isDeclaredContentLengthOverCap(event.request, DEFAULT_MAX_BODY_BYTES)) {
                return oversizeBodyResponse();
            }
            const text = await readBoundedBodyText(event.request, DEFAULT_MAX_BODY_BYTES);
            if (text === BODY_TOO_LARGE) {
                return oversizeBodyResponse();
            }
            // Deliberately NOT wrapped in try/catch: `new URLSearchParams(text)`
            // on a string cannot throw, and a stream-read failure above
            // already propagates out of `dispatch()` to `safeDispatch`'s
            // catch, which returns Subsonic error 0 — a behavior change from
            // the pre-C15 code's bare `.text()` inside try/catch, which
            // silently fell back to URL-only params on any read failure.
            // A failed body read means a broken request either way; a loud
            // error 0 is more honest than a silent fallback that could mask
            // a genuinely malformed/truncated body as "no body sent".
            event.locals.subsonicBodyParams = new URLSearchParams(text);
        }
    }

    // getOpenSubsonicExtensions MUST work without authentication per the spec.
    if (method === 'getOpenSubsonicExtensions') {
        const fakeAuth: SubsonicAuthContext = {
            userId: toUserId('00000000-0000-0000-0000-000000000000'),
            username: '',
            ownerIsAdmin: false,
            displayName: null,
            clientName: 'unknown',
            format,
            userGroups: [],
            maxAgeRating: null,
            isAgeRestricted: false,
        };
        return handleGetOpenSubsonicExtensions(event, fakeAuth, null as never);
    }

    // Helper to read a param from POST body or URL (body already parsed above).
    const getP = (key: string): string | null =>
        event.locals.subsonicBodyParams?.get(key) ?? event.url.searchParams.get(key);

    // Resolve auth. apiKeyAuthentication extension takes precedence; error 43
    // if the client mixes apiKey with legacy u/p/t/s params.
    const apiKey = getP('apiKey');
    let auth: SubsonicAuthContext;
    let sql: Awaited<ReturnType<typeof aiDbService.getSql>>;

    if (apiKey !== null) {
        const hasLegacyAuth =
            getP('u') !== null || getP('p') !== null || getP('t') !== null || getP('s') !== null;
        if (hasLegacyAuth) {
            return subsonicError(
                43,
                'Multiple conflicting authentication mechanisms provided.',
                format,
            );
        }
        sql = await aiDbService.getSql().catch((error: unknown) => {
            if (isDependencyError(error)) throw new AuthDependencyUnavailableError(error);
            throw error;
        });
        if (!sql) throw new AuthDependencyUnavailableError();
        let result: Awaited<ReturnType<typeof validateApiKey>>;
        try {
            result = await validateApiKey(apiKey, sql);
        } catch (err) {
            if (isDependencyError(err)) throw new AuthDependencyUnavailableError(err);
            logger.error('apiKey validation error', err as Error);
            return subsonicError(0, 'An internal error occurred.', format);
        }
        if (!result) return await recordSubsonicAuthFailure(event, format);
        auth = {
            userId: result.userId,
            username: result.username,
            ownerIsAdmin: result.isAdmin,
            displayName: result.displayName,
            clientName: getP('c') ?? 'unknown',
            format: getP('f') === 'json' ? 'json' : 'xml',
            userGroups: result.userGroups,
            maxAgeRating: result.maxAgeRating,
            isAgeRestricted: result.isAgeRestricted,
        };
    } else {
        const parsedAuth = await parseSubsonicAuth(event).catch((error: unknown) => {
            if (isDependencyError(error)) throw new AuthDependencyUnavailableError(error);
            throw error;
        });
        if (!parsedAuth) return await recordSubsonicAuthFailure(event, format);
        auth = parsedAuth;
        sql = await aiDbService.getSql();
        if (!sql)
            throw Object.assign(new Error('Database unavailable'), { code: 'CONNECTION_CLOSED' });
    }

    // Subsonic requests bypass forward-auth, so the user_profiles row may not
    // exist yet. Ensure it exists fire-and-forget so star/scrobble don't hit
    // FK violations on first use.
    void ensureUserProfileExists(sql, toUserId(auth.userId)).catch(() => {});

    const handler = Object.hasOwn(HANDLERS, method) ? HANDLERS[method] : undefined;
    if (!handler) {
        // security review 2026-09-13, C17: `method` is an unauthenticated,
        // URL-decoded route path segment (SvelteKit decodes %0D%0A before
        // this handler sees it) — never interpolate it into the log MESSAGE
        // string, which is written to console verbatim. Passing it as a
        // `data` field lets JSON.stringify escape any CR/LF/control bytes.
        logger.warn('Unknown Subsonic method', {
            method,
            username: auth.username,
        });
        return subsonicError(70, `Unknown method: ${method}`, auth.format);
    }

    try {
        return await handler(event, auth, sql);
    } catch (err) {
        if (isDependencyError(err))
            throw new Error('Subsonic handler dependency unavailable', { cause: err });
        logger.error('Subsonic handler error', err as Error, {
            method,
            username: auth.username,
        });
        return subsonicError(0, 'An internal error occurred.', auth.format);
    }
}

async function withCors(response: Response): Promise<Response> {
    if (response.headers.has('Access-Control-Allow-Origin')) return response;
    const headers = new Headers(response.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
}

function safeDispatch(event: RequestEvent): Promise<Response> {
    return dispatch(event).catch((error: unknown) => {
        const response = subsonicError(
            0,
            isDependencyError(error)
                ? 'Service temporarily unavailable. Retry shortly.'
                : 'An internal error occurred.',
            getSubsonicFormat(event.url),
        );
        if (!isDependencyError(error)) return response;
        response.headers.set('Retry-After', '5');
        response.headers.set('Cache-Control', 'no-store');
        if (error instanceof AuthDependencyUnavailableError)
            response.headers.set('X-Lumastra-Auth-Unavailable', 'true');
        return new Response(response.body, { status: 503, headers: response.headers });
    });
}

export const GET: RequestHandler = (event) => safeDispatch(event).then(withCors);
export const POST: RequestHandler = (event) => safeDispatch(event).then(withCors);

// CORS preflight for web-based Subsonic clients (e.g. SubFire, Airsonic Web)
export const OPTIONS: RequestHandler = () =>
    new Response(null, {
        status: 204,
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Accept',
            'Access-Control-Max-Age': '86400',
        },
    });
