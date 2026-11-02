// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { config } from '$lib/server/config.js';
import type { MusicCodec } from './types.js';

export const MP3_BITRATES = [64, 96, 128, 160, 192, 256, 320] as const;
export const OPUS_BITRATES = [32, 48, 64, 96, 128, 160, 192] as const;
export const AAC_BITRATES = [64, 96, 128, 160, 192, 256, 320] as const;
/** Same AAC encoder ladder; only the container differs. */
export const M4A_BITRATES = AAC_BITRATES;

const ALLOWED: Record<MusicCodec, readonly number[]> = {
    mp3: MP3_BITRATES,
    opus: OPUS_BITRATES,
    aac: AAC_BITRATES,
    m4a: M4A_BITRATES,
};

export function clampBitrate(codec: MusicCodec, requestedKbps: number): number {
    const allowed = ALLOWED[codec];
    // pick largest allowed ≤ requested
    let best = allowed[0];
    for (const v of allowed) {
        if (v <= requestedKbps && v > best) best = v;
    }
    if (best > requestedKbps) {
        // requested was below minimum
        return allowed[0];
    }
    return best;
}

/**
 * The bitrate used when the client names none: MUSIC_TRANSCODE_DEFAULT_BITRATE,
 * snapped to the codec's ladder (so 320 becomes 192 for opus, whose ladder
 * stops there).
 */
export function defaultBitrateFor(codec: MusicCodec): number {
    return clampBitrate(codec, config.MUSIC_TRANSCODE_DEFAULT_BITRATE);
}
