// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { QualityMode, TranscodingProfile } from '$lib/types/playback';

/**
 * Make the HLS master URL's quality cap reflect the LIVE quality selection.
 *
 * The server bakes the cap /info was asked for into its play_methods URLs, so
 * the cap is always replaced, never merely added: a cached info fetched under
 * an older selection must not keep capping the stream after the user switched
 * to 'auto' (or to a different fixed profile). Only 'fixed' mode carries a cap
 * — the VOD master has one variant, so the server must transcode down to it.
 */
export function applyLiveQualityCap(
    params: URLSearchParams,
    qualityMode: QualityMode,
    profile: Pick<TranscodingProfile, 'maxBitrate' | 'height'> | null | undefined,
): void {
    params.delete('maxBitrate');
    params.delete('maxHeight');
    if (qualityMode !== 'fixed' || !profile) return;
    if (profile.maxBitrate) params.set('maxBitrate', String(profile.maxBitrate));
    if (profile.height) params.set('maxHeight', String(profile.height));
}
