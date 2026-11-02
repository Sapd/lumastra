// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Play Session Client Info Service
 *
 * Tracks client app/player metadata for play sessions.
 * Entries are created from progress reports and used to enrich
 * active session listings in the admin UI.
 *
 * Backed by Valkey for multi-replica support.
 */

import { Logger } from '../utils/logger';
import { cacheGet, cacheSet, cacheDel, getKeysByPattern } from '$lib/server/cache/valkey.js';

const logger = Logger.for('PlaySessionDevice');

const CACHE_TTL_SECONDS = 24 * 60 * 60; // 24 hours

interface CachedEntry {
    deviceId: string;
    username: string;
    clientApp?: string;
    clientPlayerName?: string;
}

export interface PlaySessionClientInfo {
    clientApp?: string;
    clientPlayerName?: string;
}

function sessionKey(playSessionId: string): string {
    return 'device:session:v1:' + playSessionId;
}

/**
 * Update client info for an existing play session, or create a new entry.
 * Call this when receiving progress reports with app/playerName info.
 *
 * @param playSessionId - The Jellyfin play session ID
 * @param username - The username for security verification
 * @param clientInfo - The client app/player info to store
 * @param deviceId - Optional deviceId to use when creating a new entry
 */
export async function updatePlaySessionClientInfo(
    playSessionId: string,
    username: string,
    clientInfo: PlaySessionClientInfo,
    deviceId?: string,
): Promise<void> {
    if (!playSessionId) return;

    const raw = await cacheGet(sessionKey(playSessionId));

    if (!raw) {
        // No existing entry - create one if we have client info to store
        if (clientInfo.clientApp || clientInfo.clientPlayerName) {
            const entry: CachedEntry = {
                deviceId: deviceId || '',
                username,
                clientApp: clientInfo.clientApp,
                clientPlayerName: clientInfo.clientPlayerName,
            };
            await cacheSet(sessionKey(playSessionId), JSON.stringify(entry), CACHE_TTL_SECONDS);
            logger.debug('Created play session entry from progress report', {
                playSessionId: playSessionId.substring(0, 8) + '...',
                clientApp: clientInfo.clientApp,
                clientPlayerName: clientInfo.clientPlayerName,
                hasDeviceId: !!deviceId,
            });
        }
        return;
    }

    let entry: CachedEntry;
    try {
        entry = JSON.parse(raw) as CachedEntry;
    } catch {
        return;
    }

    // Verify username matches (security check)
    if (entry.username !== username) {
        logger.warn('Play session client info update - username mismatch', {
            playSessionId: playSessionId.substring(0, 8) + '...',
            expectedUser: username,
            cachedUser: entry.username,
        });
        return;
    }

    // Update only if new values provided
    if (clientInfo.clientApp) entry.clientApp = clientInfo.clientApp;
    if (clientInfo.clientPlayerName) entry.clientPlayerName = clientInfo.clientPlayerName;

    await cacheSet(sessionKey(playSessionId), JSON.stringify(entry), CACHE_TTL_SECONDS);

    logger.debug('Updated play session client info', {
        playSessionId: playSessionId.substring(0, 8) + '...',
        clientApp: entry.clientApp,
        clientPlayerName: entry.clientPlayerName,
    });
}

/**
 * Remove a play session from the cache.
 * Call this when playback stops.
 */
export async function removePlaySessionDevice(playSessionId: string): Promise<void> {
    if (!playSessionId) return;
    await cacheDel(sessionKey(playSessionId));
}

/**
 * Get client info for a play session.
 * Returns app/player info if available.
 */
export async function getPlaySessionClientInfo(
    playSessionId: string,
): Promise<PlaySessionClientInfo | undefined> {
    if (!playSessionId) return undefined;

    const raw = await cacheGet(sessionKey(playSessionId));
    if (!raw) return undefined;

    let entry: CachedEntry;
    try {
        entry = JSON.parse(raw) as CachedEntry;
    } catch {
        return undefined;
    }

    if (!entry.clientApp && !entry.clientPlayerName) return undefined;

    return {
        clientApp: entry.clientApp,
        clientPlayerName: entry.clientPlayerName,
    };
}

/**
 * Get all cached client info, keyed by username.
 * Used by sessions endpoint to merge client info into sessions.
 * Returns a Map of username -> playSessionId -> clientInfo
 */
export async function getAllPlaySessionClientInfo(): Promise<
    Map<string, Map<string, PlaySessionClientInfo>>
> {
    const result = new Map<string, Map<string, PlaySessionClientInfo>>();

    const keys = await getKeysByPattern('device:session:v1:*');
    if (keys.length === 0) return result;

    const raws = await Promise.all(keys.map((k) => cacheGet(k)));

    for (let i = 0; i < keys.length; i++) {
        const raw = raws[i];
        if (!raw) continue;

        let entry: CachedEntry;
        try {
            entry = JSON.parse(raw) as CachedEntry;
        } catch {
            continue;
        }

        if (!entry.clientApp && !entry.clientPlayerName) continue;

        // Extract playSessionId from key: 'device:session:v1:<playSessionId>'
        const playSessionId = keys[i].slice('device:session:v1:'.length);

        let userMap = result.get(entry.username);
        if (!userMap) {
            userMap = new Map();
            result.set(entry.username, userMap);
        }

        userMap.set(playSessionId, {
            clientApp: entry.clientApp,
            clientPlayerName: entry.clientPlayerName,
        });
    }

    return result;
}

/**
 * Get client info by deviceId and username.
 * Fallback for when Jellyfin doesn't provide PlaySessionId in the session.
 * Returns the most recent client info for this device.
 */
export async function getClientInfoByDeviceId(
    deviceId: string,
    username: string,
): Promise<PlaySessionClientInfo | undefined> {
    if (!deviceId || !username) return undefined;

    const keys = await getKeysByPattern('device:session:v1:*');
    if (keys.length === 0) return undefined;

    const raws = await Promise.all(keys.map((k) => cacheGet(k)));

    let best: PlaySessionClientInfo | undefined;

    for (const raw of raws) {
        if (!raw) continue;

        let entry: CachedEntry;
        try {
            entry = JSON.parse(raw) as CachedEntry;
        } catch {
            continue;
        }

        if (entry.deviceId !== deviceId || entry.username !== username) continue;
        if (!entry.clientApp && !entry.clientPlayerName) continue;

        // Return the first match found (TTL ensures entries are fresh)
        best = {
            clientApp: entry.clientApp,
            clientPlayerName: entry.clientPlayerName,
        };
        break;
    }

    return best;
}

/**
 * Pre-fetch all device session entries in one SCAN + batch GET.
 * Returns a lookup object for both playSessionId and deviceId-based resolution.
 */
export async function prefetchAllDeviceSessions(): Promise<{
    byPlaySessionId: Map<string, PlaySessionClientInfo>;
    byDeviceUser: Map<string, PlaySessionClientInfo>;
}> {
    const byPlaySessionId = new Map<string, PlaySessionClientInfo>();
    const byDeviceUser = new Map<string, PlaySessionClientInfo>();

    const keys = await getKeysByPattern('device:session:v1:*');
    if (keys.length === 0) return { byPlaySessionId, byDeviceUser };

    const raws = await Promise.all(keys.map((k) => cacheGet(k)));

    for (let i = 0; i < keys.length; i++) {
        const raw = raws[i];
        if (!raw) continue;

        let entry: CachedEntry;
        try {
            entry = JSON.parse(raw) as CachedEntry;
        } catch {
            continue;
        }

        if (!entry.clientApp && !entry.clientPlayerName) continue;

        const info: PlaySessionClientInfo = {
            clientApp: entry.clientApp,
            clientPlayerName: entry.clientPlayerName,
        };

        const playSessionId = keys[i].slice('device:session:v1:'.length);
        byPlaySessionId.set(playSessionId, info);

        if (entry.deviceId && entry.username) {
            // Last-write wins for deviceId+username (same as getClientInfoByDeviceId behavior)
            byDeviceUser.set(`${entry.deviceId}:${entry.username}`, info);
        }
    }

    return { byPlaySessionId, byDeviceUser };
}
