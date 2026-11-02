// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ffprobe's `format_name` for a playlist/reference-following container —
 * `hls`, `dash`, `concat`, `imf` — names a demuxer that resolves further
 * file references out of the probed file's own content rather than decoding
 * media directly. No legitimate movie/episode/album file in this app probes
 * as one of these: real containers report `mov,mp4,m4a,3gp,3g2,mj2`,
 * `matroska,webm`, `avi`, `mpegts`, etc. Lumastra also does not implement a
 * `.strm`-style virtual-playlist library feature, so there is no known
 * legitimate input this excludes.
 *
 * Refusing at the scanner's ingest gate (`probeFileForScan` in `shared.ts`,
 * used by `video-processor.ts` and `ancillary-processors.ts` for extras, which
 * sniffs the file's content with `sniffFileForPlaylist`
 * (`utils/playlist-sniff.ts`) before ffprobe and applies this function after
 * it) is the chokepoint
 * for playback, not for the DB row: `recordFileScanIssue` still upserts a
 * `media_files` STUB row (file_path + health_issues, no `media_item` link) so
 * the rejection is visible in the Ingest Map and the scanner's backoff
 * cooldown applies — the same shape as the pre-existing `filename_not_utf8`
 * case. What the refusal actually prevents is `attachFileToItem`/a
 * `media_file_items` link ever being created for it, so no playback query
 * (`selectFileForPlayback` and friends) can ever select it, and therefore no
 * downstream ffmpeg/ffprobe argv builder ever receives it — that is what
 * lets the ~18 other media-plane argv sites skip a per-site guard for this
 * input class. Rows written to `media_files` BEFORE this guard existed are
 * not retroactively re-checked; see `operator-notes.md` "## P1/R2" for a
 * read-only detection query and remediation.
 */
const PLAYLIST_CLASS_CONTAINER_TOKENS = new Set(['hls', 'dash', 'concat', 'imf']);

/** ffprobe's `format_name` is a comma-separated alias list; check every token. */
export function isPlaylistClassContainer(formatName: string | null | undefined): boolean {
    if (!formatName) return false;
    return formatName
        .split(',')
        .some((token) => PLAYLIST_CLASS_CONTAINER_TOKENS.has(token.trim().toLowerCase()));
}
