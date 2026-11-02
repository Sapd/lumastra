// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The feed a viewer picked for a station, remembered on this device: station
 * id → feed id. Opening the station plays that feed next
 * time instead of the server's default. Best effort — private windows and
 * blocked storage just forget, and a feed that stopped playing is dropped by
 * the caller (clearPreferredFeed).
 */

const STORAGE_KEY = 'lumastra:livetv-feeds:v1';
/** A viewer with an exotic lineup cannot grow the entry without bound. */
const MAX_ENTRIES = 200;

type FeedMap = Record<string, string>;

function read(): FeedMap {
    if (typeof localStorage === 'undefined') return {};
    try {
        const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const out: FeedMap = {};
        for (const [group, feed] of Object.entries(parsed)) {
            if (typeof feed === 'string') out[group] = feed;
        }
        return out;
    } catch {
        return {};
    }
}

function write(map: FeedMap): void {
    if (typeof localStorage === 'undefined') return;
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
    } catch {
        // Playback still switches; persistence is best effort in restricted browsers.
    }
}

/** The remembered feed of this station, if any. */
export function getPreferredFeed(stationId: string | undefined): string | undefined {
    if (!stationId) return undefined;
    return read()[stationId];
}

/**
 * Remember `feedId` for the station. Picking the station's default feed
 * forgets the choice, so the server's default (and later admin changes to it)
 * applies again.
 */
export function setPreferredFeed(
    stationId: string | undefined,
    feedId: string,
    isDefault: boolean,
): void {
    if (!stationId) return;
    const map = read();
    delete map[stationId];
    if (!isDefault) {
        // Re-insert last: the oldest entries are the ones trimmed.
        map[stationId] = feedId;
        const keys = Object.keys(map);
        for (const key of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) delete map[key];
    }
    write(map);
}

/** Forget the station's feed (it no longer plays or is no longer offered). */
export function clearPreferredFeed(stationId: string | undefined): void {
    if (!stationId) return;
    const map = read();
    if (!(stationId in map)) return;
    delete map[stationId];
    write(map);
}
