// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Mute state at player start, and when a mute change is the user's to keep.
 *
 * A mute the player set itself (the muted-autoplay fallback) is never saved
 * as the user's preference: one blocked autoplay would otherwise start every
 * later video in that browser muted. On iOS the player always starts with
 * sound and shows the play button when autoplay is blocked. (This was first
 * written as the fix for the iOS first-segment playback loop; it is not —
 * that loop also happens unmuted.)
 */

/** The muted state to apply when the player loads a source. */
export function startupMuted(savedMuted: boolean, isIOS: boolean): boolean {
    return isIOS ? false : savedMuted;
}

/**
 * Whether a volumechange should be written to the saved preference.
 * `mutedByAutoplayFallback` = the player muted itself because autoplay with
 * sound was blocked; that mute is not the user's choice.
 */
export function shouldPersistVolumeChange(opts: {
    isInitialized: boolean;
    muted: boolean;
    mutedByAutoplayFallback: boolean;
}): boolean {
    if (!opts.isInitialized) return false;
    return !(opts.muted && opts.mutedByAutoplayFallback);
}
