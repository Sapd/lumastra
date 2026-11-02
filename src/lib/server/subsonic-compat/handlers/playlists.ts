// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// OpenSubsonic Compatibility Layer — Playlist Handlers
// Playlists, play queue.

import type { RequestEvent } from '@sveltejs/kit';
import type postgres from 'postgres';
import {
    subsonicError,
    subsonicOk,
    subsonicPing,
} from '$lib/server/subsonic-compat/serializers/response.js';
import {
    serializeStation,
    serializeStationWithSongs,
} from '$lib/server/subsonic-compat/serializers/playlist.js';
import { serializeSong } from '$lib/server/subsonic-compat/serializers/song.js';
import type {
    SubsonicAuthContext,
    SubsonicHandler,
    SubsonicSong,
} from '$lib/server/subsonic-compat/types.js';
import { getParam, getAllParam } from '$lib/server/subsonic-compat/helpers.js';
import {
    PLAY_QUEUE_CACHE_PREFIX,
    PLAY_QUEUE_TTL_SECONDS,
} from '$lib/server/subsonic-compat/constants.js';
import {
    getTrackDetail,
    getTrackPlayCounts,
    type TrackDetailRow,
} from '$lib/server/database/queries/music.queries.js';
import { batchGetAvailability } from '$lib/server/database/queries/availability.queries.js';
import {
    getOwnedPlaylists,
    getSharedPlaylists,
    getPlaylistById,
    getPlaylistItems,
    createPlaylist,
    updatePlaylist,
    deletePlaylist,
    insertPlaylistItem,
    getNextPosition,
    bulkDeletePlaylistItems,
    touchPlaylist,
    type PlaylistItemRow,
} from '$lib/server/database/queries/playlists.queries.js';
import {
    getStationQueue,
    getUserStations,
    parseStationId,
    type StationQueueResult,
    type StationSummary,
} from '$lib/server/services/music/stations.service.js';
import { cacheGet, cacheSet } from '$lib/server/cache/valkey.js';
import {
    checkSubsonicMediaAccess,
    toUserContext,
} from '$lib/server/subsonic-compat/media-access.js';
import { getUserRole } from '$lib/server/utils/playlist-utils.js';
import {
    getDeniedLibraryGroups,
    toLibraryAccessUser,
} from '$lib/server/cache/library-group-permissions-cache.js';
import { config } from '$lib/server/config.js';
import {
    restrictedAccess,
    unrestrictedAccess,
} from '$lib/server/database/queries/builders/media-access-boundary.js';
import { sanitizeDisplayName } from '$lib/server/utils/display-name.js';
import { withTx } from '$lib/server/database/with-tx.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('SubsonicPlaylists');

/**
 * Boundary for the playlist-LIST queries below.
 *
 * Deliberately unrestricted, and observably a no-op: the boundary on
 * `getOwnedPlaylists` / `getSharedPlaylists` filters only the cover collage
 * (`cover_items`), and the Subsonic serializers never read that column — they
 * project playlist metadata; visible track counts are loaded separately. Per-track access on this
 * surface is enforced separately by `checkSubsonicMediaAccess`.
 *
 * `/subsonic` is out of scope for the access-boundary migration (it bypasses
 * the central gate by design — see docs/architecture/jellyfin-compat-security.md),
 * so this states the pre-existing behaviour explicitly rather than changing it.
 */
const PLAYLIST_LIST_ACCESS = unrestrictedAccess();

/** Full storage is read only to retain hidden rows; writes target the visible view. */
const MUTATION_ACCESS = unrestrictedAccess();

async function visiblePlaylistTracks(
    sql: postgres.Sql,
    playlistId: number,
    auth: SubsonicAuthContext,
): Promise<Array<{ item: PlaylistItemRow; track: TrackDetailRow }>> {
    const denied = await getDeniedLibraryGroups(sql, toLibraryAccessUser(auth));
    const items = await getPlaylistItems(
        sql,
        playlistId,
        auth.userId,
        'music',
        restrictedAccess({
            deniedGroupIds: denied ?? [],
            maxAgeRating: auth.isAgeRestricted ? (auth.maxAgeRating ?? 0) : null,
            allowUnrated: config.UNRATED_CONTENT_VISIBLE,
        }),
        { mode: 'offset', availableOnly: true },
    );
    const tracks = [];
    for (const item of items) {
        if (!(await checkSubsonicMediaAccess(sql, item.media_id, auth))) continue;
        const track = await getTrackDetail(sql, item.media_id);
        if (track) tracks.push({ item, track });
    }
    return tracks;
}

interface StoredPlayQueue {
    entries: string[];
    current?: string;
    currentIndex?: number;
    position?: number;
    changedBy?: string;
    changed: string;
}

export const handleGetPlaylists: SubsonicHandler = async (
    _event: RequestEvent,
    auth: SubsonicAuthContext,
    sql: postgres.Sql,
): Promise<Response> => {
    const [stations, owned, shared] = await Promise.all([
        getUserStations(sql, auth.userId, toUserContext(auth)).then((s) => s ?? []),
        getOwnedPlaylists(sql, auth.userId, 'music', PLAYLIST_LIST_ACCESS),
        getSharedPlaylists(sql, auth.userId, 'music', PLAYLIST_LIST_ACCESS),
    ]);

    const toIso = (d: string | Date): string => (d instanceof Date ? d.toISOString() : d);

    const userPlaylists = await Promise.all(
        [...owned, ...shared].map(async (p) => ({
            id: `playlist:${p.id}`,
            name: p.name,
            owner: p.owner_username ?? p.user_id,
            public: p.visibility === 'public',
            songCount: (await visiblePlaylistTracks(sql, p.id, auth)).length,
            duration: 0,
            created: toIso(p.created_at),
            changed: toIso(p.updated_at),
        })),
    );

    return subsonicOk(
        {
            playlists: {
                playlist: [
                    ...stations.map((s) => serializeStation(s, auth.username)),
                    ...userPlaylists,
                ],
            },
        },
        auth.format,
    );
};

export const handleGetPlaylist: SubsonicHandler = async (
    event: RequestEvent,
    auth: SubsonicAuthContext,
    sql: postgres.Sql,
): Promise<Response> => {
    const id = getParam(event, 'id');
    if (!id) {
        return subsonicError(10, 'Required parameter "id" is missing.', auth.format);
    }

    // Lumastra user playlist: playlist:{numeric_id}
    if (id.startsWith('playlist:')) {
        const playlistId = parseInt(id.slice('playlist:'.length), 10);
        if (!Number.isFinite(playlistId)) {
            return subsonicError(70, 'Playlist not found.', auth.format);
        }
        // Playlist IDs are sequential integers — enforce visibility before
        // returning items so a caller can't enumerate other users'
        // playlists. Owner, accepted member, and viewers of public
        // playlists are all allowed; everyone else gets a 70 (not found),
        // matching the Subsonic error code for an unknown playlist so
        // existence isn't revealed.
        const { role } = await getUserRole(sql, playlistId, null, auth.userId);
        if (!role) {
            return subsonicError(70, 'Playlist not found.', auth.format);
        }
        const tracks = await visiblePlaylistTracks(sql, playlistId, auth);
        const playCounts = await getTrackPlayCounts(
            sql,
            auth.userId,
            tracks.map(({ item }) => item.media_id),
        );
        const songs = tracks.map(({ item, track }) =>
            serializeSong(track, undefined, undefined, undefined, playCounts.get(item.media_id)),
        );
        const toIso = (d: string | Date): string => (d instanceof Date ? d.toISOString() : d);
        const [owned, shared] = await Promise.all([
            getOwnedPlaylists(sql, auth.userId, 'music', PLAYLIST_LIST_ACCESS),
            getSharedPlaylists(sql, auth.userId, 'music', PLAYLIST_LIST_ACCESS),
        ]);
        // Public-playlist readers pass the gate via role='readonly' but are
        // neither owner nor a member, so the merged list above doesn't
        // contain them. Fall back to a direct lookup so the response
        // reports the real owner/visibility/timestamps instead of falsely
        // attributing the playlist to the caller.
        const meta =
            [...owned, ...shared].find((p) => p.id === playlistId) ??
            (await getPlaylistById(sql, playlistId));
        return subsonicOk(
            {
                playlist: {
                    id,
                    name: meta?.name ?? 'Playlist',
                    owner: meta?.owner_username ?? meta?.user_id ?? auth.username,
                    public: meta?.visibility === 'public',
                    songCount: songs.length,
                    duration: songs.reduce((sum, s) => sum + (s.duration ?? 0), 0),
                    created: meta ? toIso(meta.created_at) : new Date().toISOString(),
                    changed: meta ? toIso(meta.updated_at) : new Date().toISOString(),
                    entry: songs,
                },
            },
            auth.format,
        );
    }

    // Station playlist: station:{id}
    const parts = id.split(':');
    if (parts.length !== 2 || parts[0] !== 'station') {
        return subsonicError(70, 'Playlist not found.', auth.format);
    }
    const stationId = parts[1];
    const parsedStation = parseStationId(stationId);
    if (!parsedStation) {
        return subsonicError(70, 'Playlist not found.', auth.format);
    }

    let queue: StationQueueResult;
    try {
        queue = await getStationQueue(sql, auth.userId, stationId, undefined, toUserContext(auth));
    } catch (err) {
        logger.error('Station queue failed', err instanceof Error ? err : new Error(String(err)), {
            stationId,
        });
        return subsonicError(0, 'An internal error occurred.', auth.format);
    }
    if (queue.kind === 'unavailable') {
        return subsonicError(0, 'An internal error occurred.', auth.format);
    }
    if (queue.kind !== 'ok') {
        return subsonicError(70, 'Playlist not found.', auth.format);
    }
    // The label comes from the current list when the id is still in it; a
    // stored id from an older clustering keeps working with a positional label.
    let listed: StationSummary | undefined;
    try {
        const stations = (await getUserStations(sql, auth.userId, toUserContext(auth))) ?? [];
        listed = stations.find((s) => s.id === stationId);
    } catch (err) {
        logger.warn('Station list for label failed', {
            error: err instanceof Error ? err.message : String(err),
        });
    }
    const stationTracks = queue.tracks;
    const station: StationSummary = listed ?? {
        id: stationId,
        label: `Station ${parsedStation.n + 1}`,
        playedTrackCount: stationTracks.length,
        tagline: `${stationTracks.length} tracks you love + more like them`,
        coverTrackIds: [],
    };
    const [detailed, playCounts] = await Promise.all([
        Promise.all(stationTracks.map((t) => getTrackDetail(sql, t.id))),
        getTrackPlayCounts(
            sql,
            auth.userId,
            stationTracks.map((t) => t.id),
        ),
    ]);
    const songs: SubsonicSong[] = [];
    for (const row of detailed) {
        if (row)
            songs.push(serializeSong(row, undefined, undefined, undefined, playCounts.get(row.id)));
    }

    return subsonicOk(
        { playlist: serializeStationWithSongs(station, songs, auth.username) },
        auth.format,
    );
};

export const handleCreatePlaylist: SubsonicHandler = async (
    event: RequestEvent,
    auth: SubsonicAuthContext,
    sql: postgres.Sql,
): Promise<Response> => {
    // Playlists can be made public, so this label is rendered to OTHER users
    // and stored permanently. The REST endpoint enforces max(255); this
    // surface enforced nothing.
    const rawName = getParam(event, 'name');
    const name = rawName === null ? null : sanitizeDisplayName(rawName);
    const existingId = getParam(event, 'playlistId');
    const songIds = getAllParam(event, 'songId');

    // If playlistId is given, replace its song list (Subsonic spec dual-mode).
    if (existingId) {
        const playlistId = parseInt(existingId.replace('playlist:', ''), 10);
        if (!Number.isFinite(playlistId)) {
            return subsonicError(70, 'Playlist not found.', auth.format);
        }
        const ownedCheck = await getOwnedPlaylists(sql, auth.userId, 'music', PLAYLIST_LIST_ACCESS);
        if (!ownedCheck.find((p) => p.id === playlistId)) {
            return subsonicError(50, 'Not authorized to modify this playlist.', auth.format);
        }
        await withTx(sql, async (tx) => {
            await tx`SELECT pg_advisory_xact_lock(${playlistId})`;
            const existing = await getPlaylistItems(
                tx,
                playlistId,
                null,
                undefined,
                MUTATION_ACCESS,
            );
            const visible = await visiblePlaylistTracks(tx, playlistId, auth);
            await bulkDeletePlaylistItems(
                tx,
                playlistId,
                visible.map(({ item }) => item.id),
            );
            const appendAt = Math.max(-1, ...existing.map((item) => item.position)) + 1;
            let index = 0;
            for (const songId of songIds) {
                if (!(await checkSubsonicMediaAccess(tx, songId, auth))) continue;
                const track = await getTrackDetail(tx, songId);
                if (!track) continue;
                const inserted = await insertPlaylistItem(tx, {
                    playlistId,
                    mediaId: songId,
                    seasonNumber: null,
                    episodeNumber: null,
                    title: track.title,
                    seriesName: null,
                    overview: null,
                    posterPath: null,
                    position: visible[index]?.item.position ?? appendAt + index,
                });
                if (inserted) index++;
            }
            await touchPlaylist(tx, playlistId);
        });
        return subsonicPing(auth.format);
    }

    if (!name) {
        return subsonicError(10, 'Required parameter "name" is missing.', auth.format);
    }

    const playlist = await createPlaylist(sql, auth.userId, name, null, 'private', 'music');

    for (let i = 0; i < songIds.length; i++) {
        if (!(await checkSubsonicMediaAccess(sql, songIds[i], auth))) continue;
        const track = await getTrackDetail(sql, songIds[i]);
        if (!track) continue;
        await insertPlaylistItem(sql, {
            playlistId: playlist.id,
            mediaId: songIds[i],
            seasonNumber: null,
            episodeNumber: null,
            title: track.title,
            seriesName: null,
            overview: null,
            posterPath: null,
            position: i,
        });
    }

    return subsonicOk(
        {
            playlist: {
                id: `playlist:${playlist.id}`,
                name: playlist.name,
                owner: auth.username,
                public: false,
                songCount: (await visiblePlaylistTracks(sql, playlist.id, auth)).length,
                duration: 0,
                created:
                    playlist.created_at instanceof Date
                        ? playlist.created_at.toISOString()
                        : String(playlist.created_at),
            },
        },
        auth.format,
    );
};

export const handleUpdatePlaylist: SubsonicHandler = async (
    event: RequestEvent,
    auth: SubsonicAuthContext,
    sql: postgres.Sql,
): Promise<Response> => {
    const id = getParam(event, 'playlistId');
    if (!id) return subsonicError(10, 'Required parameter "playlistId" is missing.', auth.format);
    const playlistId = parseInt(id.replace('playlist:', ''), 10);
    if (!Number.isFinite(playlistId)) return subsonicError(70, 'Playlist not found.', auth.format);

    const ownedCheck = await getOwnedPlaylists(sql, auth.userId, 'music', PLAYLIST_LIST_ACCESS);
    if (!ownedCheck.find((p) => p.id === playlistId)) {
        return subsonicError(50, 'Not authorized to modify this playlist.', auth.format);
    }

    const name = sanitizeDisplayName(getParam(event, 'name') ?? '') || undefined;
    const comment = sanitizeDisplayName(getParam(event, 'comment') ?? '') || undefined;
    const publicParam = getParam(event, 'public');
    const visibility =
        publicParam === 'true' ? 'public' : publicParam === 'false' ? 'private' : undefined;

    if (name !== undefined || comment !== undefined || visibility !== undefined) {
        await updatePlaylist(sql, playlistId, {
            name,
            description: comment,
            visibility,
        });
    }

    // Resolve removal indexes in the same visible order returned by getPlaylist.
    const removeIndices = getAllParam(event, 'songIndexToRemove')
        .map(Number)
        .filter(Number.isFinite);

    let entriesChanged = false;
    if (removeIndices.length > 0) {
        entriesChanged = await withTx(sql, async (tx) => {
            await tx`SELECT pg_advisory_xact_lock(${playlistId})`;
            const visible = await visiblePlaylistTracks(tx, playlistId, auth);
            const removeIds = removeIndices
                .map((idx) => visible[idx]?.item.id)
                .filter((id): id is number => id !== undefined);
            if (removeIds.length === 0) return false;
            await bulkDeletePlaylistItems(tx, playlistId, removeIds);
            return true;
        });
    }

    // songIdToAdd — append new tracks
    const addIds = getAllParam(event, 'songIdToAdd');
    for (const songId of addIds) {
        if (!(await checkSubsonicMediaAccess(sql, songId, auth))) continue;
        const track = await getTrackDetail(sql, songId);
        if (!track) continue;
        const pos = await getNextPosition(sql, playlistId);
        const inserted = await insertPlaylistItem(sql, {
            playlistId,
            mediaId: songId,
            seasonNumber: null,
            episodeNumber: null,
            title: track.title,
            seriesName: null,
            overview: null,
            posterPath: null,
            position: pos,
        });
        if (inserted) entriesChanged = true;
    }
    if (entriesChanged) await touchPlaylist(sql, playlistId);

    return subsonicPing(auth.format);
};

export const handleDeletePlaylist: SubsonicHandler = async (
    event: RequestEvent,
    auth: SubsonicAuthContext,
    sql: postgres.Sql,
): Promise<Response> => {
    const id = getParam(event, 'id');
    if (!id) return subsonicError(10, 'Required parameter "id" is missing.', auth.format);
    const playlistId = parseInt(id.replace('playlist:', ''), 10);
    if (!Number.isFinite(playlistId)) return subsonicError(70, 'Playlist not found.', auth.format);

    // deletePlaylist() refuses is_system rows in SQL, so a Subsonic client
    // cannot delete a watchlist — it gets "not found", which is the right
    // answer for a playlist this surface never lists.
    const deleted = await deletePlaylist(sql, playlistId, auth.userId);
    if (!deleted) return subsonicError(70, 'Playlist not found or not owned by you.', auth.format);

    return subsonicPing(auth.format);
};

export const handleGetPlayQueue: SubsonicHandler = async (
    _event: RequestEvent,
    auth: SubsonicAuthContext,
    sql: postgres.Sql,
): Promise<Response> => {
    const raw = await cacheGet(`${PLAY_QUEUE_CACHE_PREFIX}${auth.userId}`);
    if (!raw) {
        return subsonicOk({ playQueue: {} }, auth.format);
    }

    let stored: StoredPlayQueue;
    try {
        stored = JSON.parse(raw) as StoredPlayQueue;
    } catch {
        // best-effort: corrupt cached play queue → return empty queue.
        return subsonicOk({ playQueue: {} }, auth.format);
    }
    if (!Array.isArray(stored.entries)) {
        return subsonicOk({ playQueue: {} }, auth.format);
    }

    const [detailed, playCounts, availability] = await Promise.all([
        Promise.all(
            stored.entries.map((trackId) => getTrackDetail(sql, trackId).catch(() => null)),
        ),
        getTrackPlayCounts(sql, auth.userId, stored.entries),
        batchGetAvailability(sql, stored.entries),
    ]);
    const entry: SubsonicSong[] = [];
    for (const row of detailed) {
        if (!row) continue;
        if (!availability.get(row.id)) continue;
        if (!(await checkSubsonicMediaAccess(sql, row.id, auth))) continue;
        entry.push(serializeSong(row, undefined, undefined, undefined, playCounts.get(row.id)));
    }

    const playQueue: Record<string, unknown> = {
        username: auth.username,
        changed: stored.changed,
        entry,
    };
    // Only restore current if the track is still present (it may have been
    // deleted from the library since the queue was saved).
    if (stored.current !== undefined && entry.some((s) => s.id === stored.current)) {
        playQueue.current = stored.current;
    }
    if (stored.position !== undefined)
        playQueue.position = playQueue.current === undefined ? 0 : stored.position;
    if (stored.changedBy !== undefined) playQueue.changedBy = stored.changedBy;

    return subsonicOk({ playQueue }, auth.format);
};

/** Replace visible slots, retaining each hidden occurrence and mapping submitted indexes. */
async function mergeQueue(
    sql: postgres.Sql,
    auth: SubsonicAuthContext,
    ids: string[],
): Promise<{ entries: string[]; submittedIndexes: number[] }> {
    const raw = await cacheGet(`${PLAY_QUEUE_CACHE_PREFIX}${auth.userId}`);
    let previous: string[] = [];
    try {
        const stored = raw ? (JSON.parse(raw) as StoredPlayQueue) : null;
        if (Array.isArray(stored?.entries)) previous = stored.entries;
    } catch {
        /* Corrupt cache has no restorable entries. */
    }
    const availability = await batchGetAvailability(sql, previous);
    const visible = new Set<string>();
    for (const id of new Set(previous)) {
        if (
            availability.get(id) &&
            (await getTrackDetail(sql, id).catch(() => null)) &&
            (await checkSubsonicMediaAccess(sql, id, auth))
        )
            visible.add(id);
    }
    const entries: string[] = [];
    const submittedIndexes: number[] = [];
    let next = 0;
    const append = (): void => {
        submittedIndexes.push(entries.length);
        entries.push(ids[next++]);
    };
    for (const id of previous) {
        if (!visible.has(id)) entries.push(id);
        else if (next < ids.length) append();
    }
    while (next < ids.length) append();
    return { entries, submittedIndexes };
}

export const handleSavePlayQueue: SubsonicHandler = async (
    event: RequestEvent,
    auth: SubsonicAuthContext,
    sql: postgres.Sql,
): Promise<Response> => {
    const ids = getAllParam(event, 'id').slice(0, 2000);
    const current = getParam(event, 'current') ?? undefined;
    const positionRaw = getParam(event, 'position');
    const position =
        positionRaw !== null && positionRaw !== '' ? parseInt(positionRaw, 10) : undefined;

    const merged = await mergeQueue(sql, auth, ids);
    const stored: StoredPlayQueue = {
        entries: merged.entries,
        changedBy: auth.clientName,
        changed: new Date().toISOString(),
    };
    if (current) stored.current = current;
    if (position !== undefined && Number.isFinite(position) && position >= 0) {
        stored.position = position;
    }

    await cacheSet(
        `${PLAY_QUEUE_CACHE_PREFIX}${auth.userId}`,
        JSON.stringify(stored),
        PLAY_QUEUE_TTL_SECONDS,
    );

    return subsonicPing(auth.format);
};

// savePlayQueueByIndex (OpenSubsonic indexBasedQueue extension)
// Like savePlayQueue but uses currentIndex (0-based) instead of current track ID.
export const handleSavePlayQueueByIndex: SubsonicHandler = async (
    event: RequestEvent,
    auth: SubsonicAuthContext,
    sql: postgres.Sql,
): Promise<Response> => {
    const ids = getAllParam(event, 'id').slice(0, 2000);
    const currentIndexRaw = getParam(event, 'currentIndex');
    const positionRaw = getParam(event, 'position');
    const position = positionRaw !== null && positionRaw !== '' ? parseInt(positionRaw, 10) : 0;

    if (ids.length === 0) {
        const merged = await mergeQueue(sql, auth, ids);
        await cacheSet(
            `${PLAY_QUEUE_CACHE_PREFIX}${auth.userId}`,
            JSON.stringify({
                entries: merged.entries,
                changed: new Date().toISOString(),
                changedBy: auth.clientName,
            }),
            PLAY_QUEUE_TTL_SECONDS,
        );
        return subsonicPing(auth.format);
    }

    if (currentIndexRaw === null) {
        return subsonicError(10, 'Required parameter "currentIndex" is missing.', auth.format);
    }
    const currentIndex = parseInt(currentIndexRaw, 10);
    if (!Number.isFinite(currentIndex) || currentIndex < 0 || currentIndex >= ids.length) {
        return subsonicError(10, '"currentIndex" is out of range.', auth.format);
    }

    const merged = await mergeQueue(sql, auth, ids);
    const stored: StoredPlayQueue = {
        entries: merged.entries,
        currentIndex: merged.submittedIndexes[currentIndex],
        current: ids[currentIndex],
        position: Number.isFinite(position) && position >= 0 ? position : 0,
        changedBy: auth.clientName,
        changed: new Date().toISOString(),
    };

    await cacheSet(
        `${PLAY_QUEUE_CACHE_PREFIX}${auth.userId}`,
        JSON.stringify(stored),
        PLAY_QUEUE_TTL_SECONDS,
    );

    return subsonicPing(auth.format);
};

// getPlayQueueByIndex (OpenSubsonic indexBasedQueue extension)
// Like getPlayQueue but returns currentIndex instead of current track ID.
export const handleGetPlayQueueByIndex: SubsonicHandler = async (
    _event: RequestEvent,
    auth: SubsonicAuthContext,
    sql: postgres.Sql,
): Promise<Response> => {
    const raw = await cacheGet(`${PLAY_QUEUE_CACHE_PREFIX}${auth.userId}`);
    if (!raw) {
        return subsonicOk({ playQueueByIndex: {} }, auth.format);
    }

    let stored: StoredPlayQueue;
    try {
        stored = JSON.parse(raw) as StoredPlayQueue;
    } catch {
        // best-effort: corrupt cached play queue → return empty queue.
        return subsonicOk({ playQueueByIndex: {} }, auth.format);
    }
    if (!Array.isArray(stored.entries) || stored.entries.length === 0) {
        return subsonicOk({ playQueueByIndex: {} }, auth.format);
    }

    const [detailed, playCounts, availability] = await Promise.all([
        Promise.all(
            stored.entries.map((trackId) => getTrackDetail(sql, trackId).catch(() => null)),
        ),
        getTrackPlayCounts(sql, auth.userId, stored.entries),
        batchGetAvailability(sql, stored.entries),
    ]);
    const entry: SubsonicSong[] = [];
    const visibleIndexes: number[] = [];
    for (const [index, row] of detailed.entries()) {
        if (!row) continue;
        if (!availability.get(row.id)) continue;
        if (!(await checkSubsonicMediaAccess(sql, row.id, auth))) continue;
        entry.push(serializeSong(row, undefined, undefined, undefined, playCounts.get(row.id)));
        visibleIndexes.push(index);
    }

    // Resolve currentIndex: prefer stored currentIndex, fall back to current track ID lookup.
    let currentIndex = stored.currentIndex;
    if (currentIndex === undefined && stored.current) {
        const idx = stored.entries.indexOf(stored.current);
        if (idx >= 0) currentIndex = idx;
    }
    // Filtering retained entries changes indexes; preserve the selected occurrence.
    const visibleIndex = currentIndex === undefined ? -1 : visibleIndexes.indexOf(currentIndex);
    currentIndex = visibleIndex >= 0 ? visibleIndex : entry.length > 0 ? 0 : undefined;

    const playQueueByIndex: Record<string, unknown> = {
        username: auth.username,
        changed: stored.changed,
        entry,
    };
    if (currentIndex !== undefined) playQueueByIndex.currentIndex = currentIndex;
    if (stored.position !== undefined)
        playQueueByIndex.position = visibleIndex >= 0 ? stored.position : 0;
    if (stored.changedBy !== undefined) playQueueByIndex.changedBy = stored.changedBy;

    return subsonicOk({ playQueueByIndex }, auth.format);
};
