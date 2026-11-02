// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Target integrated loudness (LUFS) that {@link computeLufsGain} normalizes
 * toward. Exported so other modules import this single source of truth instead
 * of duplicating the `-14` literal.
 *
 * NOTE: `loudnessLufs` values used throughout the player are an **Essentia
 * approximation**, not a true EBU R128 integrated-loudness measurement. They're
 * good enough for relative track-to-track gain matching, but should not be
 * treated as broadcast-accurate R128 figures.
 */
export const TARGET_LUFS = -14;
const MIN_LUFS_GAIN = 0.25; // -12 dB floor
const MAX_LUFS_GAIN = 2.0; // +6 dB ceiling

/**
 * Compute a linear gain multiplier to bring a track to the target LUFS level.
 *
 * Formula: gain = 10^((targetLufs - trackLufs) / 20)
 * Clamped to [0.25, 2.0] to avoid extreme adjustments (±12 dB range).
 *
 * Returns 1.0 if loudnessLufs is undefined (no-op for unanalyzed tracks).
 */
export function computeLufsGain(
    loudnessLufs: number | undefined,
    targetLufs: number = TARGET_LUFS,
): number {
    if (loudnessLufs === undefined) return 1.0;
    const gain = Math.pow(10, (targetLufs - loudnessLufs) / 20);
    return Math.max(MIN_LUFS_GAIN, Math.min(MAX_LUFS_GAIN, gain));
}

/**
 * Apply LUFS gain to a user-controlled volume level.
 *
 * The user's volume setting is multiplied by the LUFS gain multiplier.
 * Result is clamped to [0, 1] (browser HTMLAudioElement constraint).
 *
 * Do NOT call this from setVolume() — that would fight user intent.
 * Call it only when initiating playback or crossfade.
 */
export function applyLufsGain(userVolume: number, loudnessLufs: number | undefined): number {
    const gain = computeLufsGain(loudnessLufs);
    return Math.max(0, Math.min(1, userVolume * gain));
}
