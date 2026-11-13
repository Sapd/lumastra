// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Build the Jellyfin `/Sessions` list for one viewer. Shared by
 * `GET /Sessions` and the WebSocket `SessionsStart` feed.
 *
 * Sources:
 *   - play sessions (fresh ones with their NowPlayingItem; stale and
 *     recently-ended ones as one "ghost" per user, see below);
 *   - /j devices from the remote-control registry. A device that is also
 *     playing is merged into its play session (same Id either way); one that
 *     is idle is listed on its own while its socket is open or it reported
 *     capabilities recently;
 *   - native Lumastra devices (device sessions announcing commands), merged
 *     into their play session the same way, or listed on their own.
 */

import type postgres from 'postgres';
import {
    getAllActiveSessionsWithMedia,
    getRecentlyEndedSessions,
    type ActiveSessionWithMedia,
} from '$lib/server/database/queries/play-sessions.queries';
import { getItemDetail } from '$lib/server/database/queries/jellyfin-item-detail.queries';
import { toUserIdOrUndefined } from '$lib/shared/user-id';
import type { UserContext } from '$lib/server/types';
import {
    serializeBaseItem,
    mapRowToMediaItem,
    type MediaItemForSerialization,
} from '../serializers/base-item';
import { applyJellyfinContentLanguage } from '../content-language';
import { enrichItemsWithProviderIds } from '../provider-ids-enrichment';
import { enrichItemsWithMusicArtists } from '../music-artists-enrichment';
import { enrichItemsWithImages } from '../image-enrichment';
import {
    applyRemoteControlOverlay,
    isSessionFresh,
    serializeIdleDeviceSession,
    serializeJellyfinSession,
    type RemoteControlOverlay,
} from '../serializers/session';
import type { JellyfinSessionInfo } from '../types';
import { toJellyfinId } from '../serializers/user';
import {
    getOnlineSessionIds,
    listDevices,
    supportsRemoteControl,
    type RemoteDeviceRecord,
} from './device-registry';
import { canControl } from './access';
import {
    listNativeDevices,
    nativeOverlay,
    serializeNativeSession,
    type NativeDeviceView,
} from './native-devices';

/** An idle device without an open socket stays listed this long after its last report. */
export const IDLE_DEVICE_WINDOW_MS = 10 * 60 * 1000;

export interface SessionListFilters {
    /** `deviceId` — exact (case-insensitive) DeviceId match. */
    deviceId?: string | null;
    /** `controllableByUserId` — only sessions that user may remote control. */
    controllableByUserId?: string | null;
    /** `activeWithinSeconds` — LastActivityDate within the window. */
    activeWithinSeconds?: number | null;
}

type Viewer = Pick<UserContext, 'userId' | 'ownerIsAdmin'>;

const deviceKey = (userId: string, deviceId: string): string =>
    `${userId.toLowerCase()}|${deviceId}`;

function overlayFor(record: RemoteDeviceRecord, online: Set<string>): RemoteControlOverlay {
    return {
        id: record.id,
        supportsRemoteControl: supportsRemoteControl(record, online),
        playableMediaTypes: record.playableMediaTypes,
        supportedCommands: record.supportedCommands,
    };
}

export { canControl };

export async function buildSessionList(
    sql: postgres.Sql,
    viewer: Viewer,
    filters: SessionListFilters = {},
    now = Date.now(),
): Promise<JellyfinSessionInfo[]> {
    const [allSessions, recentlyEnded, devices, online, nativeDevices] = await Promise.all([
        getAllActiveSessionsWithMedia(sql),
        getRecentlyEndedSessions(sql, 60),
        listDevices(now),
        getOnlineSessionIds(now),
        listNativeDevices(sql, viewer),
    ]);

    // Separate fresh (include with NowPlayingItem) from stale (ghost entry only).
    // Stale sessions stay in the response without NowPlayingItem so clients like
    // jellyfin-rpc2 can clear their Discord presence — they only clear when a
    // session is present but has no NowPlayingItem; an empty list is silently ignored.
    const freshSessions = allSessions.filter(isSessionFresh);
    const staleSessions = allSessions.filter((s) => !isSessionFresh(s));

    // Ghost sessions: stale + recently ended, one per user, only when no fresh session exists.
    const usersWithFreshSession = new Set(freshSessions.map((s) => s.user_id));
    const ghostByUser = new Map<string, ActiveSessionWithMedia>();
    for (const s of staleSessions) {
        if (!usersWithFreshSession.has(s.user_id) && !ghostByUser.has(s.user_id)) {
            ghostByUser.set(s.user_id, s);
        }
    }
    for (const s of recentlyEnded) {
        if (!usersWithFreshSession.has(s.user_id) && !ghostByUser.has(s.user_id)) {
            ghostByUser.set(s.user_id, s as unknown as ActiveSessionWithMedia);
        }
    }

    // play_sessions.user_id is the stable users.id UUID (mig 16.46.0).
    const isVisible = (userId: string): boolean => canControl(viewer, userId);

    const visibleFresh = freshSessions.filter((s) => isVisible(s.user_id));
    const visibleGhosts = [...ghostByUser.values()].filter((s) => isVisible(s.user_id));

    // Phase 1: fetch all detail rows concurrently (fresh sessions only)
    const withMediaItems = await Promise.all(
        visibleFresh.map(async (session) => {
            if (!session.media_id) return { session, mediaItem: null };
            const row = await getItemDetail(
                sql,
                session.media_id,
                toUserIdOrUndefined(session.user_id),
            );
            if (!row) return { session, mediaItem: null };
            return {
                session,
                mediaItem: mapRowToMediaItem(row as unknown as Record<string, unknown>),
            };
        }),
    );

    // Overlay the requesting viewer's resolved language onto every fresh
    // session's media item in one batch, before serializing.
    const freshMediaItems: MediaItemForSerialization[] = withMediaItems.flatMap((x) =>
        x.mediaItem ? [x.mediaItem] : [],
    );
    await applyJellyfinContentLanguage(sql, viewer.userId, freshMediaItems);

    const withMedia = withMediaItems.map(({ session, mediaItem }) => ({
        session,
        serialized: mediaItem ? serializeBaseItem(mediaItem) : null,
    }));

    // Phase 2: enrich all provider IDs in one query.
    // Deduplicate by Id before enriching — enricher's Map keeps only the last
    // item per Id, which would leave earlier duplicates with empty ProviderIds.
    // After enrichment, propagate back to any duplicate serialized objects.
    const allSerialized = withMedia.flatMap((x) => (x.serialized ? [x.serialized] : []));
    const seenById = new Map(allSerialized.map((s) => [s.Id, s]));
    await enrichItemsWithProviderIds(sql, [...seenById.values()]);
    await enrichItemsWithMusicArtists(sql, [...seenById.values()]);
    await enrichItemsWithImages(sql, [...seenById.values()]);
    for (const s of allSerialized) {
        const canonical = seenById.get(s.Id);
        if (canonical && canonical !== s) s.ProviderIds = canonical.ProviderIds;
    }

    // Remote-control registry: merge each device into its play session.
    const deviceByKey = new Map(devices.map((d) => [deviceKey(d.userId, d.deviceId), d]));
    const representedDevices = new Set<string>();
    const nativeByKey = new Map<string, NativeDeviceView>();
    for (const n of nativeDevices) {
        if (n.target.deviceId) {
            nativeByKey.set(deviceKey(n.target.ownerUserId, n.target.deviceId), n);
        }
    }
    const representedNative = new Set<string>();
    const withRemote = (
        session: ActiveSessionWithMedia,
        info: JellyfinSessionInfo,
        ghost = false,
    ): JellyfinSessionInfo => {
        if (!session.device_id) return info;
        const key = deviceKey(session.user_id, session.device_id);
        const record = deviceByKey.get(key);
        // One entry per device: a second play session of the same device
        // keeps its own Id rather than duplicating the remote one.
        if (record) {
            if (representedDevices.has(record.id)) return info;
            representedDevices.add(record.id);
            // The /j record speaks for this device: its native view must not
            // be listed again as a second entry.
            const twin = nativeByKey.get(key);
            if (twin) representedNative.add(twin.target.deviceSessionId);
            return applyRemoteControlOverlay(info, overlayFor(record, online));
        }
        // A native device reports its own state: an ended session must not hide it.
        const native = ghost ? undefined : nativeByKey.get(key);
        if (!native || representedNative.has(native.target.deviceSessionId)) return info;
        representedNative.add(native.target.deviceSessionId);
        return applyRemoteControlOverlay(info, nativeOverlay(native));
    };

    // Phase 3: patch session-join fields and assemble fresh sessions
    const freshResults = withMedia.map(({ session, serialized }) => {
        if (serialized) {
            if (session.file_path) serialized.Path = session.file_path;
            if (session.album_name) serialized.Album = session.album_name;
            if (session.album_id) serialized.AlbumId = session.album_id.replace(/-/g, '');
            if (session.artist_name) serialized.Artists = [session.artist_name];
        }
        return withRemote(session, serializeJellyfinSession(session, serialized));
    });

    // Ghost sessions: no media lookup needed — null NowPlayingItem signals "idle"
    const ghostResults = visibleGhosts.map((session) =>
        withRemote(session, serializeJellyfinSession(session, null), true),
    );

    // Idle devices: listed while their socket is open, or for a while after
    // they last reported capabilities (Jellyfin keeps such sessions too).
    const idleResults = devices
        .filter(
            (d) =>
                !representedDevices.has(d.id) &&
                isVisible(d.userId) &&
                (online.has(d.id) || now - d.lastActivityAt <= IDLE_DEVICE_WINDOW_MS),
        )
        .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
        .map((d) => {
            // Listed here, so the same device's native view is not listed again.
            const twin = nativeByKey.get(deviceKey(d.userId, d.deviceId));
            if (twin) representedNative.add(twin.target.deviceSessionId);
            return d;
        })
        .map((d) =>
            serializeIdleDeviceSession({
                id: d.id,
                userId: d.userId,
                userName: d.displayName || d.username,
                deviceId: d.deviceId,
                deviceName: d.deviceName,
                client: d.client,
                clientVersion: d.clientVersion,
                lastActivityAt: d.lastActivityAt,
                overlay: overlayFor(d, online),
            }),
        );

    // Native devices no play session represents (idle, or playing something
    // that is not a play session): their own entry, with the reported state.
    const nativeResults = nativeDevices
        .filter((n) => !representedNative.has(n.target.deviceSessionId))
        .map(serializeNativeSession);

    return applyFilters(
        [...freshResults, ...ghostResults, ...idleResults, ...nativeResults],
        viewer,
        filters,
        now,
    );
}

function applyFilters(
    sessions: JellyfinSessionInfo[],
    viewer: Viewer,
    filters: SessionListFilters,
    now: number,
): JellyfinSessionInfo[] {
    let out = sessions;
    if (filters.deviceId) {
        const wanted = filters.deviceId.toLowerCase();
        out = out.filter((s) => (s.DeviceId ?? '').toLowerCase() === wanted);
    }
    if (filters.controllableByUserId) {
        // Jellyfin: only remote-controllable sessions, and only those the
        // viewer may control (own sessions; admins any).
        out = out.filter(
            (s) =>
                s.SupportsRemoteControl &&
                (viewer.ownerIsAdmin || s.UserId === toJellyfinId(String(viewer.userId))),
        );
    }
    if (filters.activeWithinSeconds !== undefined && filters.activeWithinSeconds !== null) {
        const cutoff = now - filters.activeWithinSeconds * 1000;
        out = out.filter((s) => Date.parse(s.LastActivityDate) >= cutoff);
    }
    return out;
}
