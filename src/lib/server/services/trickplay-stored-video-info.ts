// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The video facts trickplay needs, taken from the probe the media-probe stage
 * already stored, so generation does not run ffprobe again for the same file.
 *
 * The stored duration is the reconciled runtime (`media-duration.ts`), where the
 * ffprobe trickplay used to run reads the raw container duration. They agree
 * unless the container duration is implausible.
 */

import type { StoredVideoProbeRow } from '../database/queries/media-files.queries.js';

export interface StoredVideoInfo {
    duration: number;
    width: number;
    height: number;
    codec: string;
    pixFmt: string;
}

/**
 * Map a stored probe row to what trickplay reads from ffprobe. Returns null
 * unless every field is present, so the caller probes the file as before:
 * a file never probed, a missing duration, or a stream without the pixel format
 * (GPU decode support is keyed on it) all fall back to ffprobe.
 */
export function videoInfoFromStoredProbe(row: StoredVideoProbeRow): StoredVideoInfo | null {
    if (row.probed_at === null) return null;
    const duration = row.duration_seconds;
    if (duration === null || !(duration > 0)) return null;
    if (!row.width || !row.height) return null;
    if (row.codec === null || row.pixel_format === null) return null;
    return {
        duration,
        width: row.width,
        height: row.height,
        codec: row.codec,
        pixFmt: row.pixel_format,
    };
}
