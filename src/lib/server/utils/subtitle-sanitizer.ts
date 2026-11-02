// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Subtitle Sanitizer for WebVTT
 *
 * Converts and sanitizes subtitle content from various formats to clean WebVTT.
 * Handles tags that leak through when subtitles are converted between formats
 * (e.g., ASS→SRT→WebVTT conversions often leave behind invalid tags).
 *
 * Supported conversions:
 * - ASS/SSA tags ({\an}, {\b}, {\i}, etc.)
 * - Legacy SSA alignment ({\a})
 * - MicroDVD tags ({y:i}, {c:$color}, etc.)
 * - HTML font tags (<font>)
 * - ASS line breaks (\N, \n, \h)
 *
 * References:
 * - ASS/SSA: https://aeg-dev.github.io/AegiSite/docs/3.2/ass_tags/
 * - MicroDVD: https://wiki.multimedia.cx/index.php/MicroDVD
 * - WebVTT: https://www.w3.org/TR/webvtt1/
 * - SRT: https://en.wikipedia.org/wiki/SubRip
 */

import { Logger } from '$lib/server/utils/logger.js';
import { parseVTTTimestamp } from '$lib/server/utils/webvtt-parser.js';

const logger = Logger.for('SubtitleSanitizer');

export interface SanitizeResult {
    content: string;
    modified: boolean;
    changes: string[];
}

export interface SanitizeOptions {
    /** Log path for debugging (e.g., last 3 path segments) */
    logPath?: string;
    /** Whether to log changes */
    enableLogging?: boolean;
    /**
     * MPEGTS timestamp offset for X-TIMESTAMP-MAP (in 90kHz units).
     * When seeking in multi-audio HLS, video PTS is offset by -output_ts_offset.
     * Subtitles must match by setting X-TIMESTAMP-MAP=MPEGTS:{offset}.
     * Example: For seek to 780 seconds, pass 780 * 90000 = 70200000.
     */
    mpegtsOffset?: number;
    /**
     * Seek offset in seconds for filtering cues.
     * When set, removes cues that end before this time.
     * This ensures the first cue in the filtered output matches the seek position.
     */
    seekOffsetSeconds?: number;
}

/**
 * ASS/SSA numpad-style alignment mapping ({\anX})
 * Layout matches numeric keypad:
 *   7=TL  8=TC  9=TR
 *   4=ML  5=MC  6=MR
 *   1=BL  2=BC  3=BR
 */
const ASS_ALIGNMENT_MAP: Record<number, string> = {
    1: 'align:start', // bottom-left (line defaults to bottom)
    2: '', // bottom-center (WebVTT defaults)
    3: 'align:end', // bottom-right
    4: 'line:50% align:start', // middle-left
    5: 'line:50% align:center', // middle-center
    6: 'line:50% align:end', // middle-right
    7: 'line:0% align:start', // top-left
    8: 'line:0% align:center', // top-center
    9: 'line:0% align:end', // top-right
};

/**
 * Legacy SSA alignment mapping ({\aX})
 * Uses additive system: base (1-3) + 4 for top + 8 for middle
 *   Bottom: 1=left, 2=center, 3=right
 *   Top:    5=left, 6=center, 7=right (base + 4)
 *   Middle: 9=left, 10=center, 11=right (base + 8)
 */
const SSA_LEGACY_ALIGNMENT_MAP: Record<number, string> = {
    1: 'align:start', // bottom-left
    2: '', // bottom-center
    3: 'align:end', // bottom-right
    5: 'line:0% align:start', // top-left (1+4)
    6: 'line:0% align:center', // top-center (2+4)
    7: 'line:0% align:end', // top-right (3+4)
    9: 'line:50% align:start', // middle-left (1+8)
    10: 'line:50% align:center', // middle-center (2+8)
    11: 'line:50% align:end', // middle-right (3+8)
};

/**
 * Linear-time replacements for the whole-file `{..}(.*?){..}`, `{x:[^}]*}` and
 * `<font[^>]*>` patterns. A crafted sidecar repeats an opener thousands of
 * times with no closer; each regex attempt then rescans to the end of the
 * file, which is quadratic. These helpers look for the closer with one
 * `indexOf` per match and stop as soon as no closer is left anywhere.
 */

/** `.` in a JS regex does not match these. */
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/g;

/**
 * Remove `opener ... closeChar` spans (equivalent to
 * `opener[^closeChar]*closeChar` / `opener[^closeChar]+closeChar` when
 * `minBody` is 1). A span may contain further openers, like the regex.
 */
function stripSpans(content: string, opener: RegExp, closeChar: string, minBody = 0): string {
    const re = new RegExp(
        opener.source,
        opener.flags.includes('g') ? opener.flags : `${opener.flags}g`,
    );
    let out = '';
    let copied = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
        const bodyStart = m.index + m[0].length;
        const close = content.indexOf(closeChar, bodyStart);
        if (close === -1) break;
        if (close - bodyStart < minBody) {
            re.lastIndex = m.index + 1;
            continue;
        }
        out += content.slice(copied, m.index);
        copied = close + 1;
        re.lastIndex = copied;
    }
    return copied === 0 ? content : out + content.slice(copied);
}

/**
 * Replace `opener (.*?) closer` (single line, lazy) with `openTag$1closeTag`.
 * The closer is a literal; the first one after the opener on the same line wins.
 */
function replaceLinePairs(
    content: string,
    opener: RegExp,
    closer: string,
    openTag: string,
    closeTag: string,
): string {
    const re = new RegExp(
        opener.source,
        opener.flags.includes('g') ? opener.flags : `${opener.flags}g`,
    );
    const term = new RegExp(LINE_TERMINATOR.source, 'g');
    let out = '';
    let copied = 0;
    let closerAt = -1;
    let lineEnd = -1;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
        const bodyStart = m.index + m[0].length;
        if (closerAt !== -1 && closerAt < bodyStart) closerAt = -1;
        if (closerAt === -1) {
            closerAt = content.indexOf(closer, bodyStart);
            // No closer left anywhere: no later opener can match either.
            if (closerAt === -1) break;
        }
        if (lineEnd < bodyStart) {
            term.lastIndex = bodyStart;
            const t = term.exec(content);
            lineEnd = t ? t.index : content.length + 1;
        }
        if (closerAt > lineEnd) {
            // Closer is on a later line: openers up to the line end cannot match.
            re.lastIndex = Math.max(lineEnd, bodyStart);
            continue;
        }
        out +=
            content.slice(copied, m.index) +
            openTag +
            content.slice(bodyStart, closerAt) +
            closeTag;
        copied = closerAt + closer.length;
        re.lastIndex = copied;
    }
    return copied === 0 ? content : out + content.slice(copied);
}

/**
 * Remove ` region:<setting>` cue settings (`/\s+region:\S+/g`) without the
 * regex's per-whitespace-run rescans.
 */
function stripRegionSettings(line: string): string {
    const WS = /\s/;
    let out = '';
    let pos = 0;
    let from = 0;
    for (;;) {
        const r = line.indexOf('region:', from);
        if (r === -1) break;
        let start = r;
        while (start > pos && WS.test(line[start - 1])) start--;
        if (start === r) {
            from = r + 1;
            continue;
        }
        let end = r + 7;
        while (end < line.length && !WS.test(line[end])) end++;
        if (end === r + 7) {
            from = r + 1;
            continue;
        }
        out += line.slice(pos, start);
        pos = end;
        from = end;
    }
    return pos === 0 ? line : out + line.slice(pos);
}

/**
 * Convert ASS/SSA alignment tags to WebVTT cue settings.
 * Modifies the timing line to include position/alignment settings.
 */
function convertAlignmentTags(content: string): {
    content: string;
    changed: boolean;
} {
    const lines = content.split('\n');
    let lastTimingLineIndex = -1;
    let changed = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Track timing lines (contain "-->")
        if (line.includes('-->')) {
            lastTimingLineIndex = i;
            continue;
        }

        // Check for modern {\anX} or legacy {\aX} at start of cue text
        const modernMatch = line.match(/^\{\\an(\d)\}/);
        const legacyMatch = !modernMatch ? line.match(/^\{\\a(\d{1,2})\}/) : null;
        const alignMatch = modernMatch || legacyMatch;
        const isLegacy = !!legacyMatch;

        if (alignMatch && lastTimingLineIndex >= 0) {
            const alignNum = parseInt(alignMatch[1]);
            const map = isLegacy ? SSA_LEGACY_ALIGNMENT_MAP : ASS_ALIGNMENT_MAP;
            const settings = map[alignNum];

            // Extract just the timestamps from the timing line
            const timingLine = lines[lastTimingLineIndex];
            const timingMatch = timingLine.match(/^([\d:.]+\s*-->\s*[\d:.]+)/);

            if (timingMatch && settings !== undefined) {
                // Replace timing line with timestamps + converted settings
                lines[lastTimingLineIndex] = settings
                    ? `${timingMatch[1]} ${settings}`
                    : timingMatch[1];
                changed = true;
            }

            // Remove the alignment tag from text
            lines[i] = isLegacy
                ? line.replace(/\{\\a\d{1,2}\}/, '')
                : line.replace(/\{\\an\d\}/, '');

            // Only process first alignment tag per cue
            lastTimingLineIndex = -1;
        }

        // Reset on empty line (end of cue)
        if (line.trim() === '') {
            lastTimingLineIndex = -1;
        }
    }

    return { content: lines.join('\n'), changed };
}

/**
 * Convert ASS bold/italic/underline tags to WebVTT equivalents.
 * Handles various formats:
 * - {\b1}...{\b0} - standard bold
 * - {\b700}...{\b0} - bold with font weight (100-900)
 * - {\i1}...{\i0} - italic
 * - {\u1}...{\u0} - underline
 */
function convertAssStyleTags(content: string): {
    content: string;
    changed: boolean;
} {
    const original = content;

    // Bold: {\b1}...{\b0} or {\b<weight>}...{\b0} where weight > 0
    // Matches {\b1}, {\b100}, {\b700}, etc. but not {\b0}
    content = replaceLinePairs(content, /\{\\b[1-9]\d*\}/, '{\\b0}', '<b>', '</b>');
    // Italic: {\i1}...{\i0}
    content = replaceLinePairs(content, /\{\\i1\}/, '{\\i0}', '<i>', '</i>');
    // Underline: {\u1}...{\u0}
    content = replaceLinePairs(content, /\{\\u1\}/, '{\\u0}', '<u>', '</u>');

    return { content, changed: content !== original };
}

/**
 * Convert ASS line breaks and special characters.
 * These appear as literal text, NOT in curly braces:
 * - \N = hard line break (always breaks)
 * - \n = soft line break (breaks in certain wrap modes)
 * - \h = hard space (non-breaking space)
 */
function convertAssLineBreaks(content: string): {
    content: string;
    changed: boolean;
} {
    const original = content;

    content = content
        .replace(/\\N/g, '\n') // Hard line break
        .replace(/\\n/g, '\n') // Soft line break (treat same as hard in WebVTT)
        .replace(/\\h/g, ' '); // Hard space → regular space (WebVTT has no NBSP)

    return { content, changed: content !== original };
}

/**
 * Convert MicroDVD style tags to WebVTT.
 * MicroDVD uses {y:X} for lowercase (affects current line) or {Y:X} for
 * uppercase (affects whole subtitle). Common in old DivX subtitle files.
 */
function convertMicroDVDStyleTags(content: string): {
    content: string;
    changed: boolean;
} {
    const original = content;

    content = content
        // {y:i} or {Y:i} → <i> (italic)
        .replace(/\{[yY]:i\}/g, '<i>')
        // {y:b} or {Y:b} → <b> (bold)
        .replace(/\{[yY]:b\}/g, '<b>')
        // {y:u} or {Y:u} → <u> (underline)
        .replace(/\{[yY]:u\}/g, '<u>');

    return { content, changed: content !== original };
}

/**
 * Strip MicroDVD tags that have no WebVTT equivalent.
 * - {c:$BBGGRR} / {C:$BBGGRR} - color (note: BGR format, not RGB!)
 * - {f:fontname} / {F:fontname} - font face
 * - {s:size} / {S:size} - font size
 * - {P:x,y} - position
 * - {H:charset} - character set
 * - {y:s} / {Y:s} - strikethrough (no WebVTT equivalent)
 */
function stripMicroDVDTags(content: string): {
    content: string;
    changed: boolean;
} {
    const original = content;

    // Match {X:...} where X is a MicroDVD control code
    content = stripSpans(content, /\{[yYcCfFsSPH]:/, '}');

    return { content, changed: content !== original };
}

/**
 * Strip HTML <font> tags which are common in SRT but invalid in WebVTT.
 * Preserves the text content, just removes the font wrapper.
 * Example: <font color="red" size="5">text</font> → text
 */
function stripHtmlFontTags(content: string): {
    content: string;
    changed: boolean;
} {
    const original = content;

    content = stripSpans(content, /<font/i, '>') // Opening font tag with any attributes
        .replace(/<\/font>/gi, ''); // Closing font tag

    return { content, changed: content !== original };
}

/**
 * Strip remaining ASS tags that we can't convert.
 * These include colors, fonts, effects, animations, karaoke, etc.
 *
 * ASS tag format: {\tagname} or {\tagname(params)}
 * The backslash after { is the signature of ASS tags.
 */
function stripRemainingAssTags(content: string): {
    content: string;
    changed: boolean;
} {
    const original = content;

    // Pattern: {\...} where content starts with backslash
    content = stripSpans(content, /\{\\/, '}', 1);

    return { content, changed: content !== original };
}

/**
 * Remove malformed WebVTT Region syntax.
 * Jellyfin sometimes outputs: "Region: id:subtitle width:80% ..."
 * WebVTT spec requires: "REGION\nid:subtitle\nwidth:80%\n..."
 *
 * Rather than trying to fix the format, we just remove the malformed
 * regions entirely. Subtitles will display without custom positioning,
 * which is better than not displaying at all.
 */
function removeMalformedRegions(content: string): {
    content: string;
    changed: boolean;
} {
    const hasMalformedRegion = /^Region:\s/m.test(content);

    if (!hasMalformedRegion) {
        return { content, changed: false };
    }

    // Remove lines starting with "Region:"
    const lines = content.split('\n').filter((line) => {
        const trimmed = line.trim();
        return !trimmed.startsWith('Region:');
    });

    // Also remove region references from cue settings
    const result = lines
        .map((line) => {
            if (line.includes('-->')) {
                return stripRegionSettings(line);
            }
            return line;
        })
        .join('\n');

    return { content: result, changed: true };
}

/**
 * Main sanitization function.
 * Processes WebVTT content and converts/strips invalid subtitle tags.
 *
 * @param vttContent - The WebVTT content to sanitize
 * @param options - Optional configuration
 * @returns Sanitized content and metadata about changes made
 */
export function sanitizeWebVTT(vttContent: string, options: SanitizeOptions = {}): SanitizeResult {
    const { logPath = '', enableLogging = true } = options;
    const changes: string[] = [];
    let content = vttContent;

    // Step 1: Convert ASS alignment tags to WebVTT cue settings
    {
        const result = convertAlignmentTags(content);
        if (result.changed) {
            content = result.content;
            changes.push('alignment');
        }
    }

    // Step 2: Convert ASS bold/italic/underline to WebVTT tags
    {
        const result = convertAssStyleTags(content);
        if (result.changed) {
            content = result.content;
            changes.push('ass-styles');
        }
    }

    // Step 3: Convert ASS line breaks (\N, \n, \h)
    {
        const result = convertAssLineBreaks(content);
        if (result.changed) {
            content = result.content;
            changes.push('line-breaks');
        }
    }

    // Step 4: Convert MicroDVD style tags
    {
        const result = convertMicroDVDStyleTags(content);
        if (result.changed) {
            content = result.content;
            changes.push('microdvd-styles');
        }
    }

    // Step 5: Strip remaining MicroDVD tags
    {
        const result = stripMicroDVDTags(content);
        if (result.changed) {
            content = result.content;
            changes.push('microdvd-stripped');
        }
    }

    // Step 6: Strip HTML <font> tags
    {
        const result = stripHtmlFontTags(content);
        if (result.changed) {
            content = result.content;
            changes.push('html-font');
        }
    }

    // Step 7: Strip remaining ASS tags
    {
        const result = stripRemainingAssTags(content);
        if (result.changed) {
            content = result.content;
            changes.push('ass-stripped');
        }
    }

    // Step 8: Remove malformed Region syntax
    {
        const result = removeMalformedRegions(content);
        if (result.changed) {
            content = result.content;
            changes.push('regions');
        }
    }

    // Log if changes were made
    if (enableLogging && changes.length > 0) {
        logger.info('SUBTITLE SANITIZED', {
            path: logPath,
            changes: changes.join(', '),
        });
    }

    return {
        content,
        modified: changes.length > 0,
        changes,
    };
}

/**
 * Ensure X-TIMESTAMP-MAP header is present and correct for fMP4 HLS.
 *
 * AVPlayer requires X-TIMESTAMP-MAP to sync WebVTT times with video PTS.
 * Jellyfin either:
 * - Hardcodes MPEGTS:900000 (wrong - causes 10s delay)
 * - Omits the header entirely (wrong - AVPlayer can't sync)
 *
 * This function ensures the header is always present with the correct MPEGTS offset.
 *
 * When seeking, video PTS is offset by -output_ts_offset (e.g., 780 seconds = PTS 70200000).
 * Subtitles must match by setting X-TIMESTAMP-MAP=MPEGTS:{offset}, which tells AVPlayer:
 * "WebVTT time 00:00:00 corresponds to video PTS {offset}".
 *
 * This way, when playing at video PTS 70200000, AVPlayer looks for subtitle at
 * LOCAL time (70200000 - 70200000) / 90000 = 0 seconds, which correctly matches
 * subtitles from the beginning of the timeline.
 *
 * @param vttContent - The WebVTT content
 * @param options - Optional configuration (including mpegtsOffset for seeking)
 * @returns Updated content and whether it was modified
 */
export function fixTimestampMap(
    vttContent: string,
    options: SanitizeOptions = {},
): { content: string; modified: boolean; originalPts?: string } {
    const { logPath = '', enableLogging = true, mpegtsOffset = 0 } = options;

    const correctHeader = `X-TIMESTAMP-MAP=MPEGTS:${mpegtsOffset},LOCAL:00:00:00.000`;

    // Check if header already exists
    const match = vttContent.match(/X-TIMESTAMP-MAP=MPEGTS:(\d+),LOCAL:00:00:00\.000/);

    if (match) {
        // Header exists - check if it matches our target offset
        const existingOffset = parseInt(match[1], 10);
        if (existingOffset === mpegtsOffset) {
            return { content: vttContent, modified: false };
        }

        // Replace with correct offset value
        const originalPts = match[1];
        const content = vttContent.replace(
            /X-TIMESTAMP-MAP=MPEGTS:\d+,LOCAL:00:00:00\.000/,
            correctHeader,
        );

        if (enableLogging) {
            logger.info('SUBTITLE FIX: Replaced X-TIMESTAMP-MAP', {
                path: logPath,
                originalPts,
                originalSeconds: Math.round(existingOffset / 90000),
                newOffset: mpegtsOffset,
                newSeconds: Math.round(mpegtsOffset / 90000),
            });
        }

        return { content, modified: true, originalPts };
    }

    // Header missing - add it after WEBVTT declaration
    // WebVTT format: "WEBVTT" followed by optional header block, then blank line
    const content = vttContent.replace(/^(WEBVTT[^\n]*\n)/, `$1${correctHeader}\n`);

    if (content === vttContent) {
        // No WEBVTT header found - can't add timestamp map safely
        if (enableLogging) {
            logger.warn('SUBTITLE: No WEBVTT header found, cannot add X-TIMESTAMP-MAP', {
                path: logPath,
            });
        }
        return { content: vttContent, modified: false };
    }

    if (enableLogging) {
        logger.info('SUBTITLE FIX: Added missing X-TIMESTAMP-MAP', {
            path: logPath,
            mpegtsOffset,
            offsetSeconds: Math.round(mpegtsOffset / 90000),
        });
    }

    return { content, modified: true };
}

/**
 * Filter WebVTT cues to only include those that are visible at or after the seek position.
 * This removes cues that have already ended before the seek time.
 *
 * After seeking to a specific time, AVPlayer may not resync subtitle positioning.
 * By filtering out past cues, the first cue in the file will be the correct one
 * for the current playback position.
 *
 * @param vttContent - The WebVTT content
 * @param seekOffsetSeconds - The seek position in seconds
 * @returns Filtered content and modification info
 */
function filterCuesForSeekPosition(
    vttContent: string,
    seekOffsetSeconds: number,
): { content: string; modified: boolean; removedCount: number } {
    if (seekOffsetSeconds <= 0) {
        return { content: vttContent, modified: false, removedCount: 0 };
    }

    const lines = vttContent.split('\n');
    const outputLines: string[] = [];
    let inCue = false;
    let currentCueLines: string[] = [];
    let currentCueEndTime = 0;
    let removedCount = 0;

    for (const line of lines) {
        // Check for timing line (contains "-->")
        const timingMatch = line.match(
            /^(\d{2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})/,
        );

        if (timingMatch) {
            // This is the start of a cue
            inCue = true;
            currentCueLines = [line];
            currentCueEndTime = parseVTTTimestamp(timingMatch[2]);
        } else if (inCue) {
            if (line.trim() === '') {
                // End of cue - decide whether to keep it
                currentCueLines.push(line);

                // Keep cue if it ends AFTER the seek position
                // (i.e., the cue is visible at or after seek time)
                if (currentCueEndTime > seekOffsetSeconds) {
                    outputLines.push(...currentCueLines);
                } else {
                    removedCount++;
                }

                inCue = false;
                currentCueLines = [];
            } else {
                currentCueLines.push(line);
            }
        } else {
            // Header or other non-cue content - always keep
            outputLines.push(line);
        }
    }

    // Handle last cue if file doesn't end with blank line
    if (inCue && currentCueLines.length > 0) {
        if (currentCueEndTime > seekOffsetSeconds) {
            outputLines.push(...currentCueLines);
        } else {
            removedCount++;
        }
    }

    return {
        content: outputLines.join('\n'),
        modified: removedCount > 0,
        removedCount,
    };
}

/**
 * Full WebVTT processing pipeline for HLS subtitle delivery.
 * Combines timestamp map fix, cue filtering, and tag sanitization.
 *
 * @param vttContent - Raw WebVTT content from Jellyfin
 * @param options - Optional configuration
 * @returns Processed content ready for player consumption
 */
export function processWebVTTForHLS(
    vttContent: string,
    options: SanitizeOptions = {},
): SanitizeResult {
    const allChanges: string[] = [];

    // Step 1: Fix X-TIMESTAMP-MAP for timing (replace 900000 with 0)
    const timestampResult = fixTimestampMap(vttContent, options);
    if (timestampResult.modified) {
        vttContent = timestampResult.content;
        allChanges.push('timestamp-map');
    }

    // Step 2: Filter cues based on seek position (if specified)
    // This ensures AVPlayer's subtitle engine starts at the correct position
    if (options.seekOffsetSeconds && options.seekOffsetSeconds > 0) {
        const filterResult = filterCuesForSeekPosition(vttContent, options.seekOffsetSeconds);
        if (filterResult.modified) {
            vttContent = filterResult.content;
            allChanges.push(`filtered-${filterResult.removedCount}-cues`);

            if (options.enableLogging !== false) {
                logger.debug('Filtered cues for seek position', {
                    path: options.logPath,
                    seekOffsetSeconds: options.seekOffsetSeconds,
                    removedCount: filterResult.removedCount,
                });
            }
        }
    }

    // Step 3: Sanitize subtitle tags
    const sanitizeResult = sanitizeWebVTT(vttContent, {
        ...options,
        enableLogging: false,
    });
    if (sanitizeResult.modified) {
        vttContent = sanitizeResult.content;
        allChanges.push(...sanitizeResult.changes);
    }

    // Log combined changes
    if (options.enableLogging !== false && allChanges.length > 0) {
        logger.info('SUBTITLE PROCESSED', {
            path: options.logPath,
            changes: allChanges.join(', '),
        });
    }

    return {
        content: vttContent,
        modified: allChanges.length > 0,
        changes: allChanges,
    };
}
