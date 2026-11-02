// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { normalizeLanguage } from '$lib/shared/language-codes';

/**
 * Stream indices for external subtitle files (`external_subtitle_files` rows).
 *
 * A sidecar is not a stream of the container, so it gets a pseudo-index:
 * `1000 + position`, where position is its place in the file's
 * `getExternalSubtitlesForFile` order (with a fileId) or the item's
 * `getExternalSubtitlesForMediaItem` order (without). /j PlaybackInfo hands
 * these out and the subtitle resolver maps them back; the prefetcher skips
 * them. (The web player's own `1000 + i` labels tracks only — it fetches
 * sidecars by id.) No container has 1000 streams.
 */
export const EXTERNAL_SUBTITLE_INDEX_BASE = 1000;

export function externalSubtitleStreamIndex(position: number): number {
    return EXTERNAL_SUBTITLE_INDEX_BASE + position;
}

export function isExternalSubtitleStreamIndex(streamIndex: number): boolean {
    return streamIndex >= EXTERNAL_SUBTITLE_INDEX_BASE;
}

export function externalSubtitlePosition(streamIndex: number): number {
    return streamIndex - EXTERNAL_SUBTITLE_INDEX_BASE;
}

interface ExternalStreamRowLike {
    stream_type: string;
    stream_index: number;
    is_external: boolean | null;
    language: string | null;
    is_forced: boolean;
}

interface SidecarLike {
    language: string | null;
    is_forced: boolean;
}

function matchKey(language: string | null, isForced: boolean): string {
    return `${normalizeLanguage(language)}|${isForced ? 'forced' : 'full'}`;
}

/**
 * Pairs the media_streams rows marked external (a Jellyfin import) with the
 * file's sidecars: the k-th external row of a language + forced flag is the
 * k-th sidecar of the same (languages normalised, so `eng` matches `en`).
 * Returns stream_index -> sidecar position. A row without a partner has no
 * entry — there is no sidecar to serve for it.
 *
 * PlaybackInfo hides the paired sidecars (the row already lists them) and the
 * resolver serves a row's partner, so both read the same pairing.
 */
export function pairExternalStreamRowsWithSidecars(
    streams: readonly ExternalStreamRowLike[],
    sidecars: readonly SidecarLike[],
): Map<number, number> {
    const freeSidecars = new Map<string, number[]>();
    sidecars.forEach((sub, position) => {
        const key = matchKey(sub.language, sub.is_forced);
        const list = freeSidecars.get(key) ?? [];
        list.push(position);
        freeSidecars.set(key, list);
    });

    const pairs = new Map<number, number>();
    const rows = streams
        .filter((s) => s.stream_type === 'subtitle' && s.is_external === true)
        .sort((a, b) => a.stream_index - b.stream_index);
    for (const row of rows) {
        const position = freeSidecars.get(matchKey(row.language, row.is_forced))?.shift();
        if (position !== undefined) pairs.set(row.stream_index, position);
    }
    return pairs;
}
