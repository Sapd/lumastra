// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Jellyfin's HLS URL shapes, mapped onto the files our HLS engine writes.
 *
 * Jellyfin addresses a transcode by a playlist id in the PATH:
 *   - `hls/{playlistId}/stream.m3u8`            (HlsSegmentController, legacy)
 *   - `hls/{playlistId}/{playlistId}{N}.{ext}`  (HlsSegmentController, legacy;
 *      Jellyfin names segment files `<playlist id><index>.<ext>`)
 *   - `hls1/{playlistId}/{N}.{ext}`             (DynamicHlsController; `-1.mp4`
 *      is the fMP4 init segment)
 * Ours identifies the job by the `PlaySessionId` query param and serves the
 * job's files directly under `hls/`: `master.m3u8` (for a muxed job, its media
 * playlist), `segment_NNNNN.{ts,m4s}`, `init_0.mp4`, and `stream_N/…`,
 * `subs_N/…` for demux. A Jellyfin-shaped path is rewritten to ours, so the
 * one segment handler (handleHlsSegment) serves both; there is no second
 * pipeline. Paths already in our layout pass through unchanged.
 */

/** Top-level names our own HLS layout uses (handleHlsSegment). */
const OWN_TOP_LEVEL = /^(?:stream_[^/]+|subs_[^/]+)$/;

/** A segment index the segment handler accepts (parseSegmentPath caps at 999999). */
const MAX_SEGMENT_INDEX = 999_999;

function segmentName(index: number, ext: string): string | null {
    if (!Number.isSafeInteger(index) || index > MAX_SEGMENT_INDEX) return null;
    const e = ext.toLowerCase();
    if (index === -1 && e === 'mp4') return 'init_0.mp4';
    if (index < 0) return null;
    // Jellyfin's fMP4 segments are `.mp4`; ours are `.m4s`.
    const ours = e === 'mp4' ? 'm4s' : e;
    if (ours !== 'ts' && ours !== 'm4s') return null;
    return `segment_${String(index).padStart(5, '0')}.${ours}`;
}

/**
 * The `hls1/{playlistId}/{segmentId}.{container}` segment, as our file name.
 * Null when the segment id or container is not one our engine writes.
 */
export function hls1SegmentPath(segment: string): string | null {
    const m = /^(-?\d{1,7})\.([a-z0-9]{1,4})$/i.exec(segment);
    if (!m) return null;
    return segmentName(Number(m[1]), m[2]);
}

/**
 * The path below `/Videos/{itemId}/hls/` as our segment handler names it.
 * Our own paths are returned unchanged.
 */
export function aliasJellyfinHlsPath(segmentPath: string): string {
    const parts = segmentPath.split('/');
    if (parts.length !== 2) return segmentPath;
    const [playlistId, file] = parts;
    if (!playlistId || !file || OWN_TOP_LEVEL.test(playlistId)) return segmentPath;

    if (/^stream\.m3u8$/i.test(file)) return 'master.m3u8';

    // `{playlistId}{N}.{ext}` — the legacy segment file name.
    const dot = file.lastIndexOf('.');
    if (dot > 0) {
        const stem = file.slice(0, dot);
        const ext = file.slice(dot + 1);
        if (stem.toLowerCase().startsWith(playlistId.toLowerCase())) {
            const rest = stem.slice(playlistId.length);
            if (/^\d{1,7}$/.test(rest)) {
                const name = segmentName(Number(rest), ext);
                if (name) return name;
            }
        }
    }

    // A playlist served at `hls/{playlistId}/stream.m3u8` carries our relative
    // URIs (`segment_00000.ts`, `init_0.mp4`), which resolve below the
    // playlist id: drop it.
    return file;
}

/**
 * Jellyfin clients send `playSessionId` (camelCase); the segment handler
 * reads `PlaySessionId`. Copies the first spelling found onto `PlaySessionId`.
 */
export function normalizePlaySessionIdParam(url: URL): void {
    if (url.searchParams.has('PlaySessionId')) return;
    for (const [key, value] of url.searchParams) {
        if (key.toLowerCase() === 'playsessionid' && value) {
            url.searchParams.set('PlaySessionId', value);
            return;
        }
    }
}
