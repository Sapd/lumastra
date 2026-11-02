// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import {
    PlaybackProgressSchema,
    buildPlaybackProgress as buildProgress,
    type PlaybackProgress,
} from './api-playback-progress.js';

// One PlaybackProgress schema for the whole API (package 11 owns the definition).
export { PlaybackProgressSchema };
export type { PlaybackProgress };

/** Reporting-side builder: a finished item reads as fraction 1 even when its position was reset. */
export function buildPlaybackProgress({
    positionMs,
    durationMs,
    finished,
    updatedAt,
}: Omit<PlaybackProgress, 'fraction'>): PlaybackProgress {
    return buildProgress({
        positionMs,
        durationMs,
        finished,
        updatedAt,
        fraction: finished ? 1 : null,
    });
}
