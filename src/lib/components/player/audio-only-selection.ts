// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { PlayerProbe } from './player-probe';
import type { QualityMode, TranscodingProfile } from '$lib/types/playback';
import { ORIGINAL_PROFILE } from '$lib/types/playback';

/**
 * Audio-only is an EXPLICIT user choice and is deliberately absent from the
 * availability-fallback list in resolveAvailableLumastraMethod: a viewer whose other
 * methods are all unavailable must get an error, not a silent downgrade to a
 * video-less stream.
 *
 * Returns 'not-applicable' when the user is not in audio-only mode, so the caller
 * proceeds with its normal recommended/fallback logic.
 */
export function selectAudioOnlyMethod(
    info: PlayerProbe,
    qualityMode: QualityMode,
): 'audio_only' | null | 'not-applicable' {
    if (qualityMode !== 'audio-only') return 'not-applicable';
    return info.activeVersion.availableMethods.includes('audio_only') ? 'audio_only' : null;
}

/** Audio-only and watch parties are mutually exclusive: a backgrounded participant is
 *  a state the sync-pin logic does not handle. Joining a party reverts to video. */
export function revertAudioOnlyForParty(
    qualityMode: QualityMode,
    previous: TranscodingProfile | null,
): TranscodingProfile | null {
    if (qualityMode !== 'audio-only') return null;
    return previous ?? ORIGINAL_PROFILE;
}
