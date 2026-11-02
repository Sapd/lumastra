// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Mapping from the probe/start track shape to the player's
 * `MediaSourceInfo` streams.
 *
 * Extracted from `PlayerController.buildLumastraSource` so it can be tested:
 * the controller itself cannot be instantiated under vitest (Svelte 5 runes
 * plus DOM), and this mapping decides what the client-side track resolver is
 * allowed to see. A field silently dropped here disables a resolver rule with
 * nothing to catch it — which is exactly what happened to `title`.
 */

import type { AudioStreamInfo } from '$lib/types/playback';

/** The `tracks.audio[]` entry shape from the probe/start envelope. */
export interface LumastraAudioTrack {
    index: number;
    absoluteIndex?: number;
    codec: string;
    channels: number;
    language?: string | null;
    title?: string | null;
    default: boolean;
}

/**
 * Map probe/start audio tracks to the player's `AudioStreamInfo`.
 *
 * `title` is carried through in ADDITION to being folded into `displayTitle`.
 * They are not redundant: `displayTitle` is a presentation string with
 * fallbacks ("Audio 3" when nothing is tagged), while `title` is the raw
 * metadata the commentary / audio-description filter in
 * `$lib/shared/track-selection` matches on. Dropping `title` — as this mapping
 * originally did — left every track looking untitled, so the client-side
 * resolver filtered nothing while the server's filtered normally.
 */
export function mapLumastraAudioStreams(tracks: LumastraAudioTrack[]): AudioStreamInfo[] {
    return tracks.map((a) => ({
        // index = 0-based audio-relative (display / internal track switching).
        // absoluteIndex = canonical wire value for selecting/reporting this track.
        index: a.index,
        absoluteIndex: a.absoluteIndex,
        codec: a.codec,
        language: a.language ?? undefined,
        languageCode: a.language ?? undefined,
        displayTitle: a.title || a.language || `Audio ${a.index}`,
        title: a.title ?? undefined,
        channels: a.channels,
        isDefault: a.default,
    }));
}
