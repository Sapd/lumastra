// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Classifies a media_files keyframe row for the copy-mode HLS playback path.
 *
 * The critical distinction is NULL vs empty array, which the on-demand playback
 * read path historically conflated (`keyframes && keyframes.length > 0` treats
 * both as "no data"):
 *
 *   - `keyframes IS NULL`  → the file has NEVER been keyframe-probed. Probe it
 *     on-demand (the first-play "Preparing video…" path).
 *   - `keyframes = '[]'`   → the file WAS probed and legitimately has no usable
 *     keyframes (odd container, all-intra quirk, probe edge case). This is a
 *     NEGATIVE CACHE: go straight to the degraded EVENT playlist and DO NOT
 *     re-probe — re-probing would stall 10–30s on EVERY play with no payoff,
 *     breaking the "this happens once per file" promise.
 *   - non-empty array      → use the cached keyframes for accurate VOD durations.
 *
 * Background Phase B (`tasks/builtin/native/media-probe.ts`) already persists
 * `[]` on a successful-but-empty probe, and `getFilesWithoutKeyframes` filters
 * `keyframes IS NULL` — so an empty array is the established sentinel for
 * "probed, nothing usable". This helper makes the playback read path honour the
 * same sentinel instead of re-probing forever.
 */

export type KeyframeAction =
    { kind: 'use'; keyframes: number[] } | { kind: 'negative-cache' } | { kind: 'probe' };

export function classifyKeyframeRow(
    fileRow: { keyframes: number[] | null } | null | undefined,
): KeyframeAction {
    const keyframes = fileRow?.keyframes;
    // NULL (or no row at all) → never probed → probe on demand.
    if (keyframes == null) return { kind: 'probe' };
    // Non-empty → cached keyframes available.
    if (keyframes.length > 0) return { kind: 'use', keyframes };
    // Empty, non-NULL → probed before, no usable keyframes → negative cache.
    return { kind: 'negative-cache' };
}
