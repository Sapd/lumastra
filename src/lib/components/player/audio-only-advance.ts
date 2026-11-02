// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { QualityMode } from '$lib/types/playback';

/**
 * Audio-only advances WITHOUT navigating.
 *
 * The normal path (goToNextEpisode → onnextepisode → goto() → {#key itemId}) fully
 * remounts the player, destroying the media element. On iOS that ends the background
 * audio session at every episode boundary, and it also drops the session-only
 * audio-only mode itself. Scoped to episodes: playlist transitions can change media
 * type and keep the normal path.
 *
 * Excluded in a watch party: `watchTogether.broadcastNavigate(...)` (the normal
 * path's guest-sync signal) is not sent by the in-place path, and
 * `PlaybackManager.shouldAutoPlay()` returns false whenever
 * `isInWatchParty()` is true — an in-place swap in a party would load the new
 * source and never call `.play()`, silently stalling the host, and guests
 * would stay on the old episode. Falls back to the normal navigate path,
 * which already handles both correctly.
 */
export function shouldAdvanceInPlace(
    qualityMode: QualityMode,
    nextItemType: 'episode' | 'playlist',
    isInWatchParty: boolean,
): boolean {
    return qualityMode === 'audio-only' && nextItemType === 'episode' && !isInWatchParty;
}
