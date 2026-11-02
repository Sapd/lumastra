// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Playback Display Helpers — player-side wrappers.
 *
 * The player carries Jellyfin-style PascalCase play methods
 * (`DirectPlay | DirectStream | Transcode`) for legacy reasons. Labels and
 * badge classes are sourced from the shared canonical utility so the player
 * UI stays in lockstep with admin pills/dashboards. (ref: DL-008)
 */

import {
    getPlayMethodShortLabel,
    getPlayMethodBadgeClass as getCanonicalBadgeClass,
    toPlayMethodOrDefault,
} from '$lib/utils/playback-method';

export type PlayMethod = 'DirectPlay' | 'DirectStream' | 'Transcode' | 'AudioOnly';

/** Short pill label. `DirectStream` renders as `Remux` — the stream is remuxed. */
export function getPlayMethodLabel(method: PlayMethod): string {
    return getPlayMethodShortLabel(toPlayMethodOrDefault(method));
}

/** CSS badge class (`badge-direct | badge-remux | badge-transcode`). */
export function getPlayMethodBadgeClass(method: PlayMethod): string {
    return getCanonicalBadgeClass(toPlayMethodOrDefault(method));
}

/**
 * `S02E20-E21` for a combined multi-episode file, `S02E20` otherwise.
 *
 * The range start must come from the FILE's first episode, not from the episode
 * that happens to be open: entering the Recess two-parter on its second half
 * (E21) once rendered "S02E21-E21" because the start was taken from the current
 * episode. Server-side `buildCombinedEpisodeTitle` is the source of both bounds.
 */
export function formatEpisodeRangeCode(
    seasonNumber: number | undefined,
    startEpisode: number | undefined,
    endEpisode?: number,
): string {
    const s = String(seasonNumber || 1).padStart(2, '0');
    const start = startEpisode || 1;
    const eStart = String(start).padStart(2, '0');

    if (endEpisode === undefined || endEpisode <= start) {
        return `S${s}E${eStart}`;
    }
    return `S${s}E${eStart}-E${String(endEpisode).padStart(2, '0')}`;
}
