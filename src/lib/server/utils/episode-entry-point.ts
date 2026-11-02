// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Entry point of one episode inside a combined multi-episode file.
 *
 * A combined file (`S02E20E21`, `S01E01-02-03`, `S11E13-14-15-16`) is ONE video
 * holding N episodes back to back. It plays straight through and the timeline
 * spans the whole file, so the window is an ENTRY POINT, not a fence: opening
 * the third part starts at its first frame instead of replaying the first.
 *
 * Nothing here assumes two parts — the arity comes from the sibling rows, so
 * doubles, triples and quads all resolve the same way.
 */

import { isContiguousSet } from './episode-title.js';

/** Minimal shape of a `getFileSiblingEpisodes` row (bigints arrive as strings). */
export interface EpisodeEntrySibling {
    id: string;
    episode_number: number | null;
    /** Absent in older callers; a file spanning two seasons has no range. */
    season_number?: number | null;
    start_offset_ms: string | number | null;
    end_offset_ms: string | number | null;
}

export interface EpisodeEntryPoint {
    /** Start offset of the requested episode within its file. 0 for a plain file. */
    streamStartPositionMs: number;
    /** Whether the client should seek to `streamStartPositionMs` on a fresh play. */
    clientShouldSeek: boolean;
    /** First episode number on the file — only set when the file holds several. */
    episodeNumberStart?: number;
    /** Last episode number on the file — only set when the file holds several. */
    episodeNumberEnd?: number;
}

const NO_ENTRY_POINT: EpisodeEntryPoint = {
    streamStartPositionMs: 0,
    clientShouldSeek: false,
};

/** `Number.isFinite`, never `> 0` — NaN fails every comparison and 0 is a valid start. */
function toFiniteMs(value: string | number | null | undefined): number | null {
    if (value === null || value === undefined) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

/**
 * Resolve where `episodeId` starts inside the file it shares with `siblings`.
 *
 * `siblings` is every episode linked to the same default file, including the
 * requested one (i.e. `getFileSiblingEpisodes` output). A single-episode file
 * yields exactly one row and resolves to "no entry point": start 0, no seek.
 */
export function resolveEpisodeEntryPoint(
    siblings: readonly EpisodeEntrySibling[],
    episodeId: string,
): EpisodeEntryPoint {
    // One row (or none) means the file IS the episode — nothing to seek into.
    if (siblings.length <= 1) return NO_ENTRY_POINT;

    // The range spans the whole file regardless of which part was requested.
    // Deriving it from the requested episode would render "E21-E21" when you
    // open the last part of a combined file.
    const numbers = siblings
        .map((s) => s.episode_number)
        .filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0);

    const episodeNumberStart = numbers.length > 0 ? Math.min(...numbers) : undefined;
    const episodeNumberEnd = numbers.length > 0 ? Math.max(...numbers) : undefined;
    // A file an admin linked by hand may hold 9x37 + 9x41, or episodes of two
    // seasons: no range describes those, so none is reported.
    const range =
        episodeNumberStart !== undefined &&
        episodeNumberEnd !== undefined &&
        episodeNumberEnd > episodeNumberStart &&
        isContiguousSet(siblings, siblings[0].season_number ?? 0)
            ? { episodeNumberStart, episodeNumberEnd }
            : {};

    const self = siblings.find((s) => s.id === episodeId);
    if (!self) return { ...NO_ENTRY_POINT, ...range };

    const startMs = toFiniteMs(self.start_offset_ms);
    const endMs = toFiniteMs(self.end_offset_ms);

    // Both bounds are written together; a half-populated or inverted window means
    // the split could not be derived, so fall back to whole-file playback.
    if (startMs === null || endMs === null || endMs <= startMs || startMs < 0) {
        return { ...NO_ENTRY_POINT, ...range };
    }

    return {
        streamStartPositionMs: startMs,
        clientShouldSeek: true,
        ...range,
    };
}
