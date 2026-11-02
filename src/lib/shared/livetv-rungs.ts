// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RungSpec } from '../../shared/livetv-proxy-types.js';

/** Fixed v1 Live TV quality ladder, ordered from highest to lowest bitrate. */
export type LiveTvRung = Readonly<RungSpec>;

export const LIVETV_RUNGS: readonly LiveTvRung[] = Object.freeze([
    Object.freeze({ id: '1080p8m', height: 1080, maxBitrate: 8_000_000, codec: 'h264' }),
    Object.freeze({ id: '720p4m', height: 720, maxBitrate: 4_000_000, codec: 'h264' }),
    Object.freeze({ id: '540p2m', height: 540, maxBitrate: 2_000_000, codec: 'h264' }),
    Object.freeze({ id: '360p1m', height: 360, maxBitrate: 1_000_000, codec: 'h264' }),
]);

export function resolveLiveTvRung(requestedBps: number): LiveTvRung | 'below_ladder' {
    return LIVETV_RUNGS.find((rung) => rung.maxBitrate <= requestedBps) ?? 'below_ladder';
}

export function getLiveTvRung(rungId: string): LiveTvRung | undefined {
    return LIVETV_RUNGS.find((rung) => rung.id === rungId);
}
