// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a device plays, guessed by the server for a device that does not report
 * its own state (an older build, a third-party client). Lumastra apps report
 * the full state themselves (`PUT /devices/{id}/state`); this is the floor.
 *
 * Sources: the Live TV viewer session of that device (`<username>:device:<id>`)
 * and the newest ACTIVE/PAUSED play session whose client `device_id` belongs
 * to the device session. Titles are not looked up: the projection only says
 * what kind of thing plays, where, and whether it is paused.
 */

import { userAllowsLiveTv } from '$lib/server/auth/livetv-user-policy.js';
import { channelImageSet } from './image-descriptor/resources.js';
import type postgres from 'postgres';
import { getDeviceIdForSession } from '$lib/server/database/queries/user-devices.queries.js';
import { getActiveSessionsForUser } from '$lib/server/database/queries/play-sessions.queries.js';
import { getChannelWithSource } from '$lib/server/database/queries/livetv-channels.queries.js';
import { getLiveTvSessionService } from '$lib/server/services/livetv/livetv-session.service.js';
import { stationIdOfFeed } from '$lib/server/services/livetv/station.service.js';
import type { DeviceNowPlaying } from '$lib/schemas/device-commands.js';
import type { UserId } from '$lib/shared/user-id.js';

const MUSIC_CLIENT_NAME = 'Lumastra Music';
const ACTIVE_FRESHNESS_MS = 60_000;
const PAUSED_FRESHNESS_MS = 30 * 60_000;

export async function projectNowPlaying(
    sql: postgres.Sql,
    user: { userId: UserId; username: string },
    deviceSessionId: string,
): Promise<DeviceNowPlaying | null> {
    const viewerKey = `${user.username}:device:${deviceSessionId}`;
    const live = await getLiveTvSessionService()
        .getSession(viewerKey)
        .catch(() => null);
    if (live && (await userAllowsLiveTv(user.username))) {
        const channel = await getChannelWithSource(sql, live.channelId).catch(() => null);
        const playback = await getLiveTvSessionService()
            .getViewerPlaybackSession(viewerKey)
            .catch(() => null);
        const stationId =
            playback?.state === 'active' && playback.feedId === live.channelId
                ? playback.stationId
                : stationIdOfFeed({
                      id: live.channelId,
                      backupGroupId: channel?.backup_group_id ?? undefined,
                  });
        return {
            kind: 'livetv',
            sessionId: `livetv:${stationId}`,
            title: channel?.name ?? '',
            paused: false,
            rate: 1,
            reported: false,
            availableCommands: [],
            livetv: {
                stationId,
                feedId: live.channelId,
                name: channel?.name ?? '',
                images: channelImageSet('internal', live.channelId, channel?.logo_url),
            },
        };
    }

    const deviceId = await getDeviceIdForSession(sql, user.userId, deviceSessionId);
    if (!deviceId) return null;
    // A playing session reports every ~10 s; a paused one stops reporting. Rows
    // the reaper has not closed yet but that went quiet are not "now playing".
    const now = Date.now();
    const rows = (await getActiveSessionsForUser(sql, user.userId)).filter((row) => {
        if (row.device_id !== deviceId) return false;
        const quietMs = now - new Date(row.last_heartbeat_at).getTime();
        return row.status === 'PAUSED'
            ? quietMs < PAUSED_FRESHNESS_MS
            : quietMs < ACTIVE_FRESHNESS_MS;
    });
    if (!rows.length) return null;
    const row = rows.reduce((a, b) => (b.last_heartbeat_at > a.last_heartbeat_at ? b : a));
    const kind: DeviceNowPlaying['kind'] =
        row.client_name === MUSIC_CLIENT_NAME
            ? 'music'
            : (row as { source?: string | null }).source === 'audiobookshelf'
              ? 'audiobook'
              : 'video';
    const base: DeviceNowPlaying = {
        kind,
        sessionId: row.id,
        title: '',
        positionSeconds: Math.max(0, row.position_ms / 1000),
        ...(row.runtime_ms ? { durationMs: row.runtime_ms } : {}),
        paused: row.status === 'PAUSED',
        rate: 1,
        observedAt: new Date(row.last_heartbeat_at).toISOString(),
        reported: false,
        availableCommands: [],
    };
    if (kind === 'music') return { ...base, music: { trackId: row.media_id } };
    if (kind === 'audiobook') return { ...base, audiobook: { bookId: row.media_id, chapters: [] } };
    return {
        ...base,
        video: { itemId: row.media_id, audioTracks: [], subtitleTracks: [], segments: [] },
    };
}
