// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { JellyfinBaseItemDto, JellyfinSessionInfo } from '../types';
import type { ActiveSessionWithMedia } from '$lib/server/database/queries/play-sessions.queries';
import { JELLYFIN_SERVER_ID } from '$lib/server/proprietary/jellyfin-compat/constants';
import { toJellyfinId } from './user';

const FRESHNESS_MS = {
    lumastra: { ACTIVE: 30_000, PAUSED: 300_000 },
    external: { ACTIVE: 15_000, PAUSED: 300_000 },
} as const;

export function isSessionFresh(session: ActiveSessionWithMedia): boolean {
    // Mirror SessionReadModel exactly: only source==='lumastra' uses heartbeat_at + lumastra thresholds.
    // All other sources (music, jellyfin, livetv) use last_seen_at + external thresholds.
    const isLumastraSource = session.source === 'lumastra';
    const thresholds = isLumastraSource ? FRESHNESS_MS.lumastra : FRESHNESS_MS.external;
    const threshold = session.status === 'PAUSED' ? thresholds.PAUSED : thresholds.ACTIVE;
    const lastSeen = isLumastraSource
        ? session.last_heartbeat_at
        : (session.last_seen_at ?? session.last_heartbeat_at);
    return Date.now() - new Date(lastSeen).getTime() <= threshold;
}

export function mapPlayMethod(method: string): 'DirectPlay' | 'DirectStream' | 'Transcode' {
    if (method === 'remux') return 'DirectStream';
    if (method === 'audio_transcode' || method === 'full_transcode') return 'Transcode';
    return 'DirectPlay';
}

export function serializeJellyfinSession(
    session: ActiveSessionWithMedia,
    nowPlayingItem: JellyfinBaseItemDto | null,
): JellyfinSessionInfo {
    // Jellyfin has ONE name per user, and clients pair /Users with /Sessions by
    // it — jellyfin-rpc filters sessions with `s['UserName'] == user['Name']`.
    // /Users emits `Name: display_name || username` (serializeUser), so a user
    // with a display name set ("Testuser" over login "testuser") never matched and the
    // client sat connected but idle forever. Emit the same identity here.
    //
    // Same reasoning for UserId: /Users returns the users.id UUID as 32-hex, so
    // clients matching on UserId need that value, not a hash of the name.
    // session.user_id is the stable users.id UUID (mig 16.46.0). Fall back to
    // the raw user_id when a caller passes a row without the JOIN (e.g. ghost
    // rows from getRecentlyEndedSessions).
    const username = session.owner_display_name || session.owner_username || session.user_id;
    const userId = toJellyfinId(session.user_id);
    const activityAt =
        session.source === 'lumastra'
            ? session.last_heartbeat_at
            : (session.last_seen_at ?? session.last_heartbeat_at);
    const lastActivity = new Date(activityAt).toISOString();

    return {
        Id: session.id.replace(/-/g, ''),
        UserId: userId,
        UserName: username,
        ServerId: JELLYFIN_SERVER_ID,
        Client: session.client_name ?? 'Lumastra Web',
        DeviceName: session.user_agent ?? 'Unknown',
        DeviceId: session.device_id,
        ApplicationVersion: session.client_version ?? '1.0.0',
        IsActive: true,
        SupportsRemoteControl: false,
        SupportsMediaControl: false,
        HasCustomDeviceName: false,
        PlayableMediaTypes: [],
        SupportedCommands: [],
        AdditionalUsers: [],
        NowPlayingQueue: [],
        NowPlayingQueueFullItems: [],
        PlayState: {
            PositionTicks: session.position_ms * 10000,
            IsPaused: session.status === 'PAUSED',
            IsMuted: false,
            CanSeek: true,
            RepeatMode: 'RepeatNone',
            PlaybackOrder: 'Default',
            PlayMethod: mapPlayMethod(session.play_method),
        },
        LastActivityDate: lastActivity,
        LastPlaybackCheckIn: lastActivity,
        ...(nowPlayingItem !== null ? { NowPlayingItem: nowPlayingItem } : {}),
    };
}

/** Remote-control state of the device behind a session (see remote-control/device-registry). */
export interface RemoteControlOverlay {
    /** Remote session id — what `/Sessions/{sessionId}/…` commands address. */
    id: string;
    supportsRemoteControl: boolean;
    playableMediaTypes: string[];
    supportedCommands: string[];
}

/**
 * Apply a device's remote-control state to a serialized session: the same
 * device then carries the same `Id` whether it is idle or playing, as one
 * Jellyfin `SessionInfo` does.
 */
export function applyRemoteControlOverlay(
    session: JellyfinSessionInfo,
    overlay: RemoteControlOverlay,
): JellyfinSessionInfo {
    return {
        ...session,
        Id: overlay.id,
        SupportsRemoteControl: overlay.supportsRemoteControl,
        SupportsMediaControl: overlay.supportsRemoteControl,
        PlayableMediaTypes: overlay.playableMediaTypes,
        SupportedCommands: overlay.supportedCommands,
    };
}

/** An idle (nothing playing) /j device known from its capabilities report or socket. */
export interface IdleDeviceSessionInput {
    id: string;
    userId: string;
    userName: string;
    deviceId: string;
    deviceName: string;
    client: string;
    clientVersion: string;
    lastActivityAt: number;
    overlay: RemoteControlOverlay;
}

export function serializeIdleDeviceSession(input: IdleDeviceSessionInput): JellyfinSessionInfo {
    const lastActivity = new Date(input.lastActivityAt).toISOString();
    return applyRemoteControlOverlay(
        {
            Id: input.id,
            UserId: toJellyfinId(input.userId),
            UserName: input.userName,
            ServerId: JELLYFIN_SERVER_ID,
            Client: input.client,
            DeviceName: input.deviceName,
            DeviceId: input.deviceId,
            ApplicationVersion: input.clientVersion,
            IsActive: true,
            SupportsRemoteControl: false,
            SupportsMediaControl: false,
            HasCustomDeviceName: false,
            PlayableMediaTypes: [],
            SupportedCommands: [],
            AdditionalUsers: [],
            NowPlayingQueue: [],
            NowPlayingQueueFullItems: [],
            PlayState: {
                IsPaused: false,
                IsMuted: false,
                CanSeek: false,
                RepeatMode: 'RepeatNone',
                PlaybackOrder: 'Default',
            },
            LastActivityDate: lastActivity,
            LastPlaybackCheckIn: lastActivity,
        },
        input.overlay,
    );
}
