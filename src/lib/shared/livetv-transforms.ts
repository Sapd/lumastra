// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * LiveTV → Server-Driven UI transforms (shared between server and client)
 *
 * Converts LiveTV domain types to UniversalMediaItem for rendering
 * in the unified card/section system.
 */

import type { LiveTvStation, LiveTvChannel } from '$lib/schemas/livetv.js';
import type { UniversalMediaItem } from '$lib/types/server-driven-ui.js';
import * as m from '$lib/paraglide/messages.js';

/**
 * Get the remaining minutes for a program.
 *
 * @param endTime - ISO 8601 end time string
 * @param now - Current timestamp in milliseconds (Date.now())
 * @returns Remaining minutes (ceiled), or undefined if ended/missing
 */
export function getRemainingMinutes(endTime: string | undefined, now: number): number | undefined {
    if (!endTime) return undefined;

    const endMs = new Date(endTime).getTime();
    if (isNaN(endMs)) return undefined;

    const remainingMs = endMs - now;
    if (remainingMs <= 0) return undefined;

    return Math.ceil(remainingMs / 60_000);
}

const OFF_AIR_TITLES = new Set([
    'sendepause',
    'sendeschluss',
    'no programming',
    'no program',
    'off air',
    'off-air',
    'pause',
]);

/**
 * Whether an EPG program title indicates an off-air placeholder rather than
 * real programming. Matches the whole (trimmed) title, case-insensitively,
 * so real shows containing "pause" are not misclassified.
 */
export function isOffAirProgram(title: string | undefined | null): boolean {
    if (!title) return false;
    return OFF_AIR_TITLES.has(title.trim().toLowerCase());
}

/**
 * Format remaining program time for display, using paraglide messages.
 * Below 90 minutes shows "Xm"; at or above shows "Xh Ym".
 */
export function formatRemainingTime(minutes: number): string {
    if (minutes < 90) {
        return m.livetv_remaining_m({ minutes });
    }
    return m.livetv_remaining_hm({ hours: Math.floor(minutes / 60), minutes: minutes % 60 });
}

/**
 * Filter channels by search query (client-side).
 * Matches against channel name, category, and current program title (case-insensitive).
 */
export function filterChannels<T extends LiveTvStation | LiveTvChannel>(
    channels: T[],
    query: string,
): T[] {
    if (!query.trim()) return channels;

    const q = query.trim().toLowerCase();
    return channels.filter((ch) => {
        if (ch.name.toLowerCase().includes(q)) return true;
        if (ch.category?.toLowerCase().includes(q)) return true;
        if (
            ('nowNext' in ch ? ch.nowNext.current : ch.currentProgram)?.title
                ?.toLowerCase()
                .includes(q)
        )
            return true;
        return false;
    });
}

/**
 * Convert a LiveTvStation to a UniversalMediaItem for Server-Driven UI rendering.
 *
 * - mediaType → 'tvchannel'
 * - aspectRatio → 'video' (landscape cards for TV channels)
 * - subtitle → current program title if available, undefined otherwise
 */
export function liveTvChannelToUniversalItem(
    channel: LiveTvStation | LiveTvChannel,
): UniversalMediaItem {
    return {
        id: 'feedId' in channel ? channel.id : (channel.backupGroupId ?? channel.id),
        title: channel.name,
        mediaType: 'tvchannel',
        aspectRatio: 'video',
        image: channel.images?.primary?.href ?? '',
        subtitle:
            ('nowNext' in channel ? channel.nowNext.current : channel.currentProgram)?.title ??
            undefined,
        externalIds: {
            internal: 'feedId' in channel ? channel.id : (channel.backupGroupId ?? channel.id),
        },
        nativeStreamUrl: `/api/livetv/stations/${'feedId' in channel ? channel.id : (channel.backupGroupId ?? channel.id)}`,
        isAvailable: true,
        canRequest: false,
    };
}

/**
 * Format a "What's On Now" subtitle for the home page carousel.
 *
 * Returns "Program Title · Ends in X min" if a program is airing,
 * or undefined if no current program.
 *
 * @param channel - LiveTV channel with optional currentProgram
 * @param now - Current timestamp in milliseconds (default: Date.now())
 * @param formatEndsIn - i18n formatter for "Ends in X min" (e.g., m.livetv_ends_in)
 */
export function formatWhatsOnSubtitle(
    channel: LiveTvStation | LiveTvChannel,
    now: number = Date.now(),
    formatEndsIn: (params: { minutes: number }) => string = ({ minutes }) =>
        `Ends in ${minutes} min`,
): string | undefined {
    const program = 'nowNext' in channel ? channel.nowNext.current : channel.currentProgram;
    if (!program) return undefined;

    const remaining = getRemainingMinutes(program.endTime, now);
    if (remaining === undefined) return program.title;
    return `${program.title} · ${formatEndsIn({ minutes: remaining })}`;
}

/**
 * Convert a LiveTvStation to a UniversalMediaItem for the "What's On Now" carousel.
 *
 * Like liveTvChannelToUniversalItem but with an enhanced subtitle showing
 * the current program title and time remaining.
 */
export function liveTvChannelToWhatsOnItem(
    channel: LiveTvStation | LiveTvChannel,
    now: number = Date.now(),
    formatEndsIn?: (params: { minutes: number }) => string,
): UniversalMediaItem {
    return {
        id: 'feedId' in channel ? channel.id : (channel.backupGroupId ?? channel.id),
        title: channel.name,
        mediaType: 'tvchannel',
        aspectRatio: 'video',
        image: channel.images?.primary?.href ?? '',
        subtitle: formatWhatsOnSubtitle(channel, now, formatEndsIn),
        externalIds: {
            internal: 'feedId' in channel ? channel.id : (channel.backupGroupId ?? channel.id),
        },
        nativeStreamUrl: `/api/livetv/stations/${'feedId' in channel ? channel.id : (channel.backupGroupId ?? channel.id)}`,
        isAvailable: true,
        canRequest: false,
    };
}

/**
 * Move the user's favorite stations to the front, in favorite order; the rest
 * keep their order. `stationIdOf` maps an entry to its station UUID (the id
 * `/api/livetv/favorites` returns).
 */
export function orderFavoritesFirst<T>(
    entries: T[],
    favoriteStationIds: readonly string[],
    stationIdOf: (entry: T) => string,
): T[] {
    if (favoriteStationIds.length === 0) return entries;
    const rank = new Map(favoriteStationIds.map((id, index) => [id, index]));
    const favorites = entries.filter((entry) => rank.has(stationIdOf(entry)));
    favorites.sort((a, b) => rank.get(stationIdOf(a))! - rank.get(stationIdOf(b))!);
    return [...favorites, ...entries.filter((entry) => !rank.has(stationIdOf(entry)))];
}
