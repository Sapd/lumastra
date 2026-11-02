// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { TranscodingProfile } from '$lib/types/playback.js';

/**
 * Stable, collision-free `{#each}` key for one quality option.
 *
 * `profile.mode` alone is NOT an identity. It used to work by accident: the VOD
 * ladder (DEFAULT_TRANSCODING_PROFILES) declares no `mode` at all, so the old
 * `profile.mode ?? profile.maxBitrate` fell through to the bitrate — which is unique
 * within that list. The Live TV ladder marks every rung `mode: 'fixed'`, so all four
 * collapsed onto the single key `'fixed'`, and any resolution band holding two rungs
 * (the SD band holds 540p2m and 360p1m) crashed the whole menu with
 * `each_key_duplicate` the moment it opened.
 *
 * Keying on all three identifying fields is what makes this independent of whether a
 * given ladder happens to populate `mode`, and of how many rungs land in one band.
 */
export function qualityOptionKey(profile: TranscodingProfile): string {
    return `${profile.mode ?? 'fixed'}:${profile.height}:${profile.maxBitrate}`;
}
