// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Stream-index conventions — the single sanctioned place to reason about the
 * three different "index" meanings that media streams carry.
 *
 * This file is platform-agnostic (no server- or browser-specific imports) so
 * both the player components and the transcoding pipeline import the SAME
 * converters instead of each rolling their own — which is what caused the
 * recurring "wrong audio language" class of bug.
 *
 * ## The three conventions
 *
 *  - **Absolute stream index** — the raw ffmpeg/ffprobe `stream.index`, counting
 *    video + audio + subtitle streams together. For a file with 1 video + 2 audio,
 *    the audio streams are absolute index 1 and 2. This is what Jellyfin's
 *    `AudioStreamIndex` and the DB `media_streams.stream_index` use, and it is the
 *    canonical WIRE convention for selecting an audio track.
 *
 *  - **Audio-relative index** — a 0-based counter among audio streams only
 *    (the 1st audio track is 0, the 2nd is 1, …). This is what ffmpeg's
 *    `-map 0:a:N` stream specifier expects. NEVER send this across the wire.
 *
 *  - **Array position** — an index into a specific in-memory array. Equal to the
 *    audio-relative index only when the array is exactly the audio streams in order.
 *
 * The branded types below make the compiler reject passing one where another is
 * expected, so a relative index can never silently be used as an absolute one.
 */

/** Raw ffmpeg/ffprobe stream index (counts video + audio + subtitle). */
export type AbsoluteStreamIndex = number & {
    readonly __absoluteStreamIndex: unique symbol;
};

/** 0-based index among audio streams only (for ffmpeg `-map 0:a:N`). */
export type AudioRelativeIndex = number & {
    readonly __audioRelativeIndex: unique symbol;
};

/** Tag a plain number as an absolute stream index. */
export function asAbsoluteStreamIndex(n: number): AbsoluteStreamIndex {
    return n as AbsoluteStreamIndex;
}

/** Tag a plain number as an audio-relative index. */
export function asAudioRelativeIndex(n: number): AudioRelativeIndex {
    return n as AudioRelativeIndex;
}

/**
 * A stream entry carrying BOTH conventions — e.g. an ffprobe audio stream, or the
 * `tracks.audio[]` entries the server sends to the player. `audioRelativeIndex` is
 * the display/`-map 0:a:N` index; `absoluteIndex` is the wire/selection index.
 */
export interface DualIndexedAudioStream {
    audioRelativeIndex: number;
    absoluteIndex: number;
}

/**
 * Translate a 0-based audio-relative index to the absolute stream index, by
 * looking it up in the stream list. Returns `undefined` when no such audio
 * stream exists.
 */
export function audioRelativeToAbsolute(
    streams: readonly DualIndexedAudioStream[],
    relative: number,
): AbsoluteStreamIndex | undefined {
    const match = streams.find((s) => s.audioRelativeIndex === relative);
    return match ? asAbsoluteStreamIndex(match.absoluteIndex) : undefined;
}

/**
 * Translate an absolute stream index to its 0-based audio-relative index.
 * Returns `undefined` when the absolute index is not an audio stream.
 */
export function absoluteToAudioRelative(
    streams: readonly DualIndexedAudioStream[],
    absolute: number,
): AudioRelativeIndex | undefined {
    const match = streams.find((s) => s.absoluteIndex === absolute);
    return match ? asAudioRelativeIndex(match.audioRelativeIndex) : undefined;
}

/**
 * A track list whose `.index` field holds the ABSOLUTE stream index.
 *
 * Branded, so an array whose `index` is an audio-relative or array position
 * cannot be passed to the absolute-index resolvers below — that substitution is
 * the whole "wrong audio language" bug class this file exists to prevent, and
 * it type-checked silently for as long as this field was a plain number.
 */
export interface AbsoluteIndexedTrack {
    index: AbsoluteStreamIndex;
}

export interface ResolvedAudioTrack<T> {
    /** 0-based position within the provided array (for `-map 0:a:N` / array access). */
    position: number;
    /** The matched track, or the fallback first track (may be undefined if empty). */
    track: T | undefined;
    /** True when an exact absolute-index match was found; false = fell back to first. */
    matched: boolean;
}

/**
 * Resolve which audio track an ABSOLUTE stream index refers to, returning the
 * 0-based ARRAY POSITION to feed ffmpeg (`-map 0:a:N`) along with the matched
 * track. Falls back to the first track (position 0) when no exact match exists,
 * matching the historical "default to track 0" behaviour.
 *
 * The input `tracks` must use the ABSOLUTE convention on `.index` (as the server
 * `AudioTrackInfo` does). Passing the absolute index as a branded type prevents
 * accidentally feeding an audio-relative or array index here.
 */
export function resolveAudioTrackByAbsoluteIndex<T extends AbsoluteIndexedTrack>(
    tracks: readonly T[],
    absolute: AbsoluteStreamIndex,
): ResolvedAudioTrack<T> {
    const position = tracks.findIndex((t) => t.index === absolute);
    if (position >= 0) {
        return { position, track: tracks[position], matched: true };
    }
    return { position: 0, track: tracks[0], matched: false };
}

/**
 * The absolute stream index to select when the request named no audio track.
 *
 * Returns the file's own default track, falling back to the first audio stream,
 * falling back to 0 for an empty list (nothing to select — the caller maps no
 * audio at all).
 *
 * ## Why this is not just `?? 0`
 *
 * Every muxed-transcode call site used to default `hlsAudioTrackIndex` to `0`.
 * But 0 is an ABSOLUTE index, and absolute 0 is the VIDEO stream on essentially
 * every file — so it matched no audio track, `resolveAudioTrackByAbsoluteIndex`
 * reported `matched: false`, and the pipeline silently fell through to
 * container order. That gave clients which omit an explicit audio index (the
 * Jellyfin master.m3u8 path) a different default than the web player, whose
 * resolver has always been `isDefault`-aware.
 *
 * Call this at EVERY site that needs the fallback, with the same arguments.
 * The mapping step and the audio-encoding step resolve the track separately;
 * if they disagree the output carries one track's audio described by another
 * track's metadata, which is worse than the bug this fixes.
 */
export function defaultAudioAbsoluteIndex(
    tracks: readonly (AbsoluteIndexedTrack & { isDefault?: boolean })[],
): AbsoluteStreamIndex {
    const preferred = tracks.find((t) => t.isDefault) ?? tracks[0];
    return asAbsoluteStreamIndex(preferred?.index ?? 0);
}
