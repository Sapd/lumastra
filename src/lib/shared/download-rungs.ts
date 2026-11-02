// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The offline-download quality ladder.
 *
 * ## Why this is NOT `LIVETV_RUNGS`
 *
 * Live TV rungs are sized for a stream the viewer can abandon at any second, on
 * a link the server controls, and they exist to avoid rebuffering. A download is
 * the opposite trade: the bytes are paid for exactly once, up front, often on a
 * metered connection, and then live on a phone with finite storage. At Live TV's
 * 1080p/8 Mbps a two-hour film is ~7.2 GB — larger than many of the originals
 * people are trying to avoid downloading. These rungs are therefore sized like
 * the offline profiles commercial apps ship (roughly 2–4 Mbps at 1080p), where
 * the quality loss is acceptable precisely because the alternative is not
 * downloading the film at all.
 *
 * ## Why h264 + AAC, always
 *
 * The whole point of a rendition is that it plays LOCALLY, on the device that
 * asked for it, with no server in the loop to fix a codec mismatch. h264 High +
 * AAC-LC in MP4 is the only combination that is universally decodable across
 * every iOS/tvOS/Android/desktop target we care about. Offering hevc or av1 here
 * would re-introduce exactly the "downloaded a file it can't play" failure this
 * feature exists to remove.
 *
 * Ordered highest-quality first.
 */

export interface DownloadRung {
    /** Stable wire id — the client sends this back to request the rendition. */
    id: string;
    /** Target height in pixels; width follows from the source's aspect ratio. */
    height: number;
    /** Target video bitrate in bits/sec. */
    videoBitrate: number;
    /** Target audio bitrate in bits/sec (stereo AAC). */
    audioBitrate: number;
    /** Human label for a picker row, e.g. "1080p". */
    label: string;
}

export const DOWNLOAD_RUNGS: readonly DownloadRung[] = Object.freeze([
    Object.freeze({
        id: '1080p',
        height: 1080,
        videoBitrate: 4_000_000,
        audioBitrate: 160_000,
        label: '1080p',
    }),
    Object.freeze({
        id: '720p',
        height: 720,
        videoBitrate: 2_500_000,
        audioBitrate: 128_000,
        label: '720p',
    }),
    Object.freeze({
        id: '540p',
        height: 540,
        videoBitrate: 1_200_000,
        audioBitrate: 128_000,
        label: '540p',
    }),
    Object.freeze({
        id: '360p',
        height: 360,
        videoBitrate: 600_000,
        audioBitrate: 96_000,
        label: '360p',
    }),
]);

export function getDownloadRung(rungId: string): DownloadRung | undefined {
    return DOWNLOAD_RUNGS.find((rung) => rung.id === rungId);
}

/**
 * MP4 container/muxing overhead as a fraction of media bitrate.
 *
 * Measured against faststart MP4s produced by this pipeline: moov atom, per-sample
 * tables and interleaving land in the 1–2% range for feature-length content. 2% is
 * the pessimistic end, chosen because a download-size estimate that reads LOW is
 * the one that hurts — a user on a metered connection budgets against the number
 * we show them.
 */
const CONTAINER_OVERHEAD = 1.02;

/**
 * Estimated size of one rendition, in bytes.
 *
 * Deliberately a bitrate × duration approximation, not a probe: it has to be
 * answerable for every rung at once, instantly, before any encode exists. The
 * encoder targets these bitrates with a capped VBR, so real output lands within
 * roughly ±10% — good enough for "720p · ~1.4 GB" and never presented as exact.
 *
 * Returns `null` for an unknown duration rather than 0: a zero would render as
 * "0 B" and read as a free download.
 */
export function estimateRenditionBytes(
    rung: DownloadRung,
    durationMs: number | null,
    /**
     * Whether the encode will carry an audio track. A source with no audio
     * stream is encoded `-an`, so quoting its audio bitrate over-states the
     * download by a fixed amount.
     *
     * Defaults to `true` because the series-candidates path runs off rows that
     * carry no stream facts and deliberately never probe — it has no answer to
     * give, and over-quoting is the safe direction per CONTAINER_OVERHEAD above.
     */
    hasAudio = true,
): number | null {
    if (durationMs === null || !Number.isFinite(durationMs) || durationMs <= 0) return null;
    const seconds = durationMs / 1000;
    const bits = (rung.videoBitrate + (hasAudio ? rung.audioBitrate : 0)) * seconds;
    return Math.round((bits / 8) * CONTAINER_OVERHEAD);
}

/**
 * Rungs worth offering for a source of a given height.
 *
 * Upscaling is never useful for a download — it costs bitrate and storage to
 * invent detail — so a 720p source offers 720p and below. A source shorter than
 * the smallest rung still offers that smallest rung, so the picker is never
 * empty (that path re-encodes at the source's own height; see the scale filter's
 * `min()` clamp in the args builder).
 */
export function rungsForSourceHeight(sourceHeight: number | null): DownloadRung[] {
    if (sourceHeight === null || !Number.isFinite(sourceHeight) || sourceHeight <= 0) {
        return [...DOWNLOAD_RUNGS];
    }
    const applicable = DOWNLOAD_RUNGS.filter((rung) => rung.height <= sourceHeight);
    return applicable.length > 0 ? applicable : [DOWNLOAD_RUNGS[DOWNLOAD_RUNGS.length - 1]];
}

/**
 * The rung the encoder will ACTUALLY use for a request, given the source.
 *
 * Sizing a download off the requested rung rather than this one is the exact
 * defect that shipped in the music round (`clampBitrate`): the estimate and the
 * encode disagree, and every item in the pool is mis-budgeted by the difference.
 * The clamp lives here, beside `estimateRenditionBytes`, so a caller cannot
 * reach one without the other being available.
 *
 * `rungsForSourceHeight` is ordered highest-first and never empty, so the head
 * of the offered list is the best rung the source can carry. An unknown height
 * yields the full ladder, so the request passes through unclamped.
 *
 * Returns `undefined` for an unknown rung id — the caller turns that into a
 * 422 rather than silently substituting a quality nobody asked for.
 */
export function clampRungForHeight(
    rungId: string,
    sourceHeight: number | null,
): DownloadRung | undefined {
    const requested = getDownloadRung(rungId);
    if (!requested) return undefined;
    const offered = rungsForSourceHeight(sourceHeight);
    return offered.find((rung) => rung.id === requested.id) ?? offered[0];
}
