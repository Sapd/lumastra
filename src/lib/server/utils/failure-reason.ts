// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Condense a task's failure reason into something an operator can read.
 *
 * ============================================================================
 * WHY THIS EXISTS
 * ============================================================================
 * `plugin_failure_events.reason` was written by capping the string at 500
 * chars from the FRONT. For a reason that is a subprocess's captured stderr
 * that is exactly backwards: CLI tools print their preamble first and the
 * actual error last, so head-truncation keeps the boilerplate and discards the
 * only sentence that says what went wrong.
 *
 * Measured on prod 2026-09-11: all 705 unresolved `lumastra-intro-analyzer`
 * rows whose reason began `ffmpeg version ...` were exactly 500 characters
 * long and contained nothing but ffmpeg's build banner — version line, the
 * `configuration:` flag dump, and the `libav*` version table. Three hundred
 * distinct items had failed, and not one row said why. The failures were
 * unreadable by construction, not by accident.
 *
 * Two passes fix it:
 *
 *   1. Drop the known preamble. ffmpeg/ffprobe's banner is fixed-shape and
 *      carries no incident-specific information — the same ~1.5 KB on every
 *      run of that binary. Stripping it usually brings the reason under the
 *      cap on its own.
 *   2. If still over the cap, keep BOTH ends. The first line is typically the
 *      most specific framing ("FFmpeg exited with code 1 for /data/...") and
 *      the last lines carry the diagnosis, so a middle elision preserves the
 *      two parts that matter and says how much it dropped.
 */

/** Cap applied to a stored reason, matching `MAX_REASON_LEN` in
 *  plugin-failure-events.queries.ts and trickplay's in-marker convention. */
export const MAX_REASON_LEN = 500;

/**
 * Lines of an ffmpeg/ffprobe banner. Anchored per line, and deliberately
 * narrow: only shapes the binary itself emits before it does any work.
 *
 * `built with` and `configuration:` are the two banner lines that carry the
 * bulk of the bytes; the `libav*`/`libsw*` table is one line per library.
 */
const FFMPEG_BANNER_LINE =
    /^\s*(?:ffmpeg|ffprobe) version \S+.*$|^\s*built with .*$|^\s*configuration:.*$|^\s*lib(?:av\w+|sw\w+|postproc)\s+\d+\.\s*\d+\.\s*\d+.*$/i;

/**
 * Strip an ffmpeg/ffprobe banner wherever it appears in the text.
 *
 * Not prefix-only: a task that runs several ffmpeg passes and concatenates
 * their stderr interleaves banners with real output, and the banner is equally
 * worthless in the middle.
 */
function stripToolBanner(text: string): string {
    if (!/(?:ffmpeg|ffprobe) version /i.test(text)) return text;
    const kept = text.split('\n').filter((line) => !FFMPEG_BANNER_LINE.test(line));
    // Refuse to return nothing. A reason that was ONLY a banner still has to
    // say something, and "the banner" is more honest than an empty string.
    const joined = kept.join('\n').trim();
    return joined === '' ? text.trim() : joined;
}

/** Collapse runs of blank lines and trailing whitespace left behind by the
 *  banner strip, so the cap is spent on content rather than on the hole the
 *  filter just made. */
function tidy(text: string): string {
    return text
        .replace(/[ \t]+$/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * Condense `reason` to at most `maxLen` characters, keeping the informative
 * parts. Always returns a non-empty string for non-empty input.
 *
 * @param reason  Raw reason text (often a subprocess's combined output).
 * @param maxLen  Hard cap on the result length. Values below ~40 degrade to a
 *                plain head slice, since there is no room for two ends.
 */
export function condenseFailureReason(reason: string, maxLen: number = MAX_REASON_LEN): string {
    const cleaned = tidy(stripToolBanner(reason));
    if (cleaned.length <= maxLen) return cleaned;

    // Below this there is no room for a head, a tail and an honest marker, so
    // fall back to a plain head slice rather than emitting a string that is
    // mostly elision notice.
    const MIN_TWO_ENDED = 80;
    if (maxLen < MIN_TWO_ENDED) return cleaned.slice(0, maxLen);

    // Tail-weighted: the diagnosis lives at the end of a tool's output.
    // Build the marker from the ACTUAL omission, which depends on the marker's
    // own length — so compute with a placeholder, then re-measure and trim the
    // head to absorb any drift. Without the second pass an off-by-a-few marker
    // pushes the result over the caller's cap.
    const budget = maxLen;
    const markerFor = (n: number) => `\n… [${n} chars omitted] …\n`;
    let headLen = Math.max(1, Math.floor((budget - markerFor(cleaned.length).length) * 0.35));
    let tailLen = budget - headLen - markerFor(cleaned.length).length;
    let omitted = cleaned.length - headLen - tailLen;
    let marker = markerFor(omitted);

    // One correction pass: the marker's digit count may have changed.
    const overflow = headLen + marker.length + tailLen - budget;
    if (overflow > 0) {
        headLen = Math.max(1, headLen - overflow);
        omitted = cleaned.length - headLen - tailLen;
        marker = markerFor(omitted);
    }
    if (tailLen <= 0) return cleaned.slice(0, maxLen);

    const out = cleaned.slice(0, headLen) + marker + cleaned.slice(cleaned.length - tailLen);
    // Belt and braces: the cap is a database contract, never exceed it.
    return out.length > maxLen ? out.slice(0, maxLen) : out;
}
