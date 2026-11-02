// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * WebVTT Parser and Segment Generator
 *
 * Parses WebVTT content into structured cues and generates segments
 * for HLS subtitle delivery. Segments align with video segments to
 * ensure proper subtitle sync during seeking.
 *
 * References:
 * - WebVTT: https://www.w3.org/TR/webvtt1/
 * - HLS: https://datatracker.ietf.org/doc/html/rfc8216
 */

import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('WebVTTParser');

/**
 * A time range with start and end in seconds.
 */
export interface TimeRange {
    /** Start time in seconds */
    startSeconds: number;
    /** End time in seconds */
    endSeconds: number;
}

/**
 * A parsed WebVTT cue with timing and text.
 */
export interface ParsedCue extends TimeRange {
    /** Optional cue identifier */
    id?: string;
    /** Cue text content (may contain WebVTT formatting) */
    text: string;
    /** Cue settings (position, line, align, etc.) */
    settings?: string;
}

/**
 * Result of parsing a WebVTT file.
 */
export interface ParsedWebVTT {
    /** All parsed cues */
    cues: ParsedCue[];
    /** Header content (WEBVTT declaration and any metadata) */
    header: string;
    /** Original X-TIMESTAMP-MAP if present */
    timestampMap?: string;
}

/**
 * Parse WebVTT timestamp to seconds.
 * Handles both HH:MM:SS.mmm and MM:SS.mmm formats.
 *
 * @param timestamp - WebVTT timestamp string
 * @returns Time in seconds, or 0 if parsing fails
 */
export function parseVTTTimestamp(timestamp: string): number {
    const trimmed = timestamp.trim();
    const parts = trimmed.split(':');

    let result: number;

    if (parts.length === 3) {
        // HH:MM:SS.mmm
        const [hours, minutes, seconds] = parts;
        result = parseInt(hours, 10) * 3600 + parseInt(minutes, 10) * 60 + parseFloat(seconds);
    } else if (parts.length === 2) {
        // MM:SS.mmm
        const [minutes, seconds] = parts;
        result = parseInt(minutes, 10) * 60 + parseFloat(seconds);
    } else {
        return 0;
    }

    // Guard against NaN from malformed input
    return Number.isNaN(result) ? 0 : result;
}

/**
 * Format seconds to WebVTT timestamp (HH:MM:SS.mmm).
 *
 * @param seconds - Time in seconds (must be non-negative)
 * @returns Formatted timestamp string
 */
export function formatVTTTimestamp(seconds: number): string {
    // Clamp to non-negative to avoid invalid WebVTT timestamps
    const clampedSeconds = Math.max(0, seconds);

    const hours = Math.floor(clampedSeconds / 3600);
    const minutes = Math.floor((clampedSeconds % 3600) / 60);
    const secs = clampedSeconds % 60;

    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toFixed(3).padStart(6, '0')}`;
}

/**
 * Parse WebVTT content into structured cues.
 *
 * @param content - Raw WebVTT content
 * @returns Parsed WebVTT with cues and metadata
 */
export function parseWebVTT(content: string): ParsedWebVTT {
    // Handle both LF and CRLF line endings
    const lines = content.split(/\r?\n/);
    const cues: ParsedCue[] = [];
    let header: string;
    let timestampMap: string | undefined;

    let i = 0;

    // Parse header (everything before first cue)
    // Header includes WEBVTT declaration, NOTE blocks, and metadata
    const headerLines: string[] = [];

    while (i < lines.length) {
        const line = lines[i];

        // Check for X-TIMESTAMP-MAP in header
        if (line.startsWith('X-TIMESTAMP-MAP=')) {
            timestampMap = line;
            headerLines.push(line);
            i++;
            continue;
        }

        // Check if this line starts a cue (timing line with -->)
        if (line.includes('-->')) {
            break;
        }

        // Check if this might be a cue identifier (next line would be timing)
        if (i + 1 < lines.length && lines[i + 1].includes('-->')) {
            break;
        }

        headerLines.push(line);
        i++;
    }

    header = headerLines.join('\n');

    // Parse cues
    while (i < lines.length) {
        const line = lines[i].trim();

        // Skip empty lines between cues
        if (line === '') {
            i++;
            continue;
        }

        // Check if this is a cue identifier (line before timing)
        let cueId: string | undefined;
        if (!line.includes('-->')) {
            // This might be a cue ID
            if (i + 1 < lines.length && lines[i + 1].includes('-->')) {
                cueId = line;
                i++;
            } else {
                // Not a cue, skip
                i++;
                continue;
            }
        }

        // Parse timing line
        const timingLine = lines[i];
        const timingMatch = timingLine.match(
            /^(\d{2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})(.*)$/,
        );

        if (!timingMatch) {
            i++;
            continue;
        }

        const startSeconds = parseVTTTimestamp(timingMatch[1]);
        const endSeconds = parseVTTTimestamp(timingMatch[2]);
        const settings = timingMatch[3]?.trim() || undefined;

        i++;

        // Collect cue text (until empty line or end of file)
        const textLines: string[] = [];
        while (i < lines.length && lines[i].trim() !== '') {
            textLines.push(lines[i]);
            i++;
        }

        const text = textLines.join('\n');

        if (text) {
            cues.push({
                id: cueId,
                startSeconds,
                endSeconds,
                text,
                settings,
            });
        }
    }

    // Sort cues by start time to handle poorly-formatted source files
    // (e.g., bad SRT→VTT conversions, merged/edited subtitles)
    // This ensures cues are always in chronological order regardless of source
    cues.sort((a, b) => a.startSeconds - b.startSeconds);

    logger.debug('Parsed WebVTT', {
        cueCount: cues.length,
        hasTimestampMap: !!timestampMap,
    });

    return { cues, header, timestampMap };
}

/**
 * Generate a WebVTT segment containing cues for a specific time range.
 *
 * Uses FIXED MPEGTS=0, so a cue's LOCAL time maps straight onto the media PTS:
 * - All segments use X-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000
 * - AVPlayer calculates PTS = MPEGTS + cue_time * 90000
 *
 * `seekOffsetSeconds` subtracts a constant from every cue. Callers serving HLS
 * should pass 0: after a seek the muxer runs with `-copyts` and emits ABSOLUTE
 * source PTS (measured on real media — see handleSubtitleSegment), so a non-zero
 * offset puts cues early by exactly that amount. The parameter survives for the
 * `sub_offset` diagnostic knob and for callers on a genuinely rebased timeline.
 *
 * An earlier comment here claimed `-avoid_negative_ts make_zero` resets PTS to 0
 * after seeking, which is how the offset came to be applied unconditionally. That
 * is only true when NOT seeking; the seeking path uses `-copyts`.
 *
 * @param cues - All parsed cues
 * @param contentStartSeconds - Absolute media time for segment start (for cue selection)
 * @param contentEndSeconds - Absolute media time for segment end (for cue selection)
 * @param segmentNumber - Segment index (for debug labeling only)
 * @param segmentDuration - Duration of each segment in seconds (default 6, unused but kept for API compat)
 * @param debug - Enable debug mode with visible segment labels
 * @param seekOffsetSeconds - Constant subtracted from every cue time. Pass 0 for
 *   HLS delivery; see the note above.
 * @returns WebVTT content for this segment
 */
export function generateSegment(
    cues: ParsedCue[],
    contentStartSeconds: number,
    contentEndSeconds: number,
    segmentNumber: number = 0,
    segmentDuration: number = 6,
    debug: boolean = false,
    seekOffsetSeconds: number = 0,
): string {
    void segmentDuration; // Kept for API compatibility

    const lines: string[] = [];

    // Use FIXED MPEGTS=0 for ALL segments to avoid discontinuity errors (-12783)
    // Cue times will be ABSOLUTE movie times, not segment-relative
    lines.push('WEBVTT');
    lines.push('X-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000');
    lines.push('');

    // Find cues that overlap with this segment's content time range
    const overlappingCues = getCuesInRange(cues, contentStartSeconds, contentEndSeconds);

    // If no cues in this segment, return empty segment (header only, no cues).
    // This prevents subtitle background from showing when nothing is speaking.
    // AVPlayer handles empty segments correctly (no playback issues).
    if (overlappingCues.length === 0) {
        // In debug mode, add a visible cue so you can see empty segments
        if (debug) {
            const relativeStart = contentStartSeconds - seekOffsetSeconds;
            const relativeEnd = contentEndSeconds - seekOffsetSeconds;

            // Safety check for valid timestamps
            if (relativeEnd > 0 && relativeStart < relativeEnd) {
                const dummyStart = formatVTTTimestamp(Math.max(0, relativeStart));
                const dummyEnd = formatVTTTimestamp(Math.max(0.001, relativeEnd));
                lines.push(`${dummyStart} --> ${dummyEnd}`);
                lines.push(`[seg ${segmentNumber}]`);
                lines.push('');
            }
        }
        // Return segment with no cues (or debug cue only)
        return lines.join('\n');
    }

    // Add each cue with timing RELATIVE to seek offset
    // This matches the video/audio timeline which is reset to 0 after seeking
    for (const cue of overlappingCues) {
        // Adjust cue times to be relative to seek position
        // Example: cue at 903s with seekOffset=900s becomes 3s
        const relativeCueStart = cue.startSeconds - seekOffsetSeconds;
        const relativeCueEnd = cue.endSeconds - seekOffsetSeconds;

        // Safety check: skip cues that would have negative or invalid timestamps
        // (this should never happen due to getCuesInRange filter, but add defense-in-depth)
        if (relativeCueStart < 0 || relativeCueEnd <= 0 || relativeCueStart >= relativeCueEnd) {
            logger.warn('Skipping cue with invalid relative timestamps', {
                cueStart: cue.startSeconds,
                cueEnd: cue.endSeconds,
                seekOffset: seekOffsetSeconds,
                relativeCueStart,
                relativeCueEnd,
            });
            continue;
        }

        // Optional cue ID
        if (cue.id) {
            lines.push(cue.id);
        }

        const startTs = formatVTTTimestamp(relativeCueStart);
        const endTs = formatVTTTimestamp(relativeCueEnd);
        const timingLine = cue.settings
            ? `${startTs} --> ${endTs} ${cue.settings}`
            : `${startTs} --> ${endTs}`;
        lines.push(timingLine);

        // Cue text
        lines.push(cue.text);

        // Empty line after cue
        lines.push('');
    }

    return lines.join('\n');
}

/**
 * Generate a debug subtitle segment with per-second timing cues.
 * Creates visible timing indicators to diagnose AVPlayer behavior.
 *
 * Uses MPEGTS=0 with cue times RELATIVE to seek position (same as generateSegment).
 * Display shows: [MM:SS | seg:N | rel:MM:SS]
 *
 * If timing is correct after seeking to 15:00:
 * - At video time 0:05, you see "[15:05 | seg:151 | rel:0:05]" displayed
 *
 * If timing is wrong (subtitle offset not applied):
 * - At video time 0:05, you see "[15:05 | seg:151 | rel:15:05]" displayed
 *
 * @param contentStartSeconds - Absolute media time for segment start
 * @param contentEndSeconds - Absolute media time for segment end
 * @param segmentNumber - Segment index
 * @param seekOffsetSeconds - Constant subtracted from every cue time. Pass 0 for
 *   HLS delivery; see the note above.
 * @returns WebVTT content with per-second debug timing cues
 */
export function generateDebugSegment(
    contentStartSeconds: number,
    contentEndSeconds: number,
    segmentNumber: number,
    seekOffsetSeconds: number = 0,
): string {
    const lines: string[] = [];

    // Use FIXED MPEGTS=0 for ALL segments (same as generateSegment)
    // This ensures consistent behavior and no discontinuity errors
    lines.push('WEBVTT');
    lines.push('X-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000');
    lines.push('');

    // Generate a cue for EACH SECOND in the segment
    const startSecond = Math.floor(contentStartSeconds);
    const endSecond = Math.ceil(contentEndSeconds);

    for (let sec = startSecond; sec < endSecond; sec++) {
        // Use cue times RELATIVE to seek offset (same approach as generateSegment)
        const relativeSec = sec - seekOffsetSeconds;
        const startTs = formatVTTTimestamp(relativeSec);
        const endTs = formatVTTTimestamp(relativeSec + 1);

        // Format ABSOLUTE content time as MM:SS or H:MM:SS for display
        const hours = Math.floor(sec / 3600);
        const mins = Math.floor((sec % 3600) / 60);
        const secs = sec % 60;

        const absoluteTimeDisplay =
            hours > 0
                ? `${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
                : `${mins}:${secs.toString().padStart(2, '0')}`;

        // Format RELATIVE time for comparison
        const relHours = Math.floor(relativeSec / 3600);
        const relMins = Math.floor((relativeSec % 3600) / 60);
        const relSecs = relativeSec % 60;

        const relativeTimeDisplay =
            relHours > 0
                ? `${relHours}:${relMins.toString().padStart(2, '0')}:${relSecs.toString().padStart(2, '0')}`
                : `${relMins}:${relSecs.toString().padStart(2, '0')}`;

        // Rich debug display: absolute time | segment number | relative time
        lines.push(`${startTs} --> ${endTs}`);
        lines.push(`[${absoluteTimeDisplay} | seg:${segmentNumber} | rel:${relativeTimeDisplay}]`);
        lines.push('');
    }

    // Fallback if segment is empty (shouldn't happen)
    if (lines.length === 3) {
        const fallbackStart = formatVTTTimestamp(contentStartSeconds - seekOffsetSeconds);
        const fallbackEnd = formatVTTTimestamp(contentEndSeconds - seekOffsetSeconds);
        lines.push(`${fallbackStart} --> ${fallbackEnd}`);
        lines.push(`[seg ${segmentNumber}]`);
        lines.push('');
    }

    return lines.join('\n');
}

/**
 * Get cues that START within a specific time range, sorted by start time.
 *
 * Per Apple's HLS Authoring Spec: "Segment each text file so that each cue
 * is completely contained within one segment."
 *
 * We only include cues that START in this segment (not ones that merely overlap).
 * This prevents the same cue from appearing in multiple segments with different
 * timings, which can confuse AVPlayer.
 *
 * A cue at 809-812s will only appear in the segment containing 809s.
 * The player should continue displaying it until 812s based on the end time.
 *
 * @param cues - All parsed cues
 * @param startSeconds - Segment start time
 * @param endSeconds - Segment end time
 * @returns Cues that start within the range, sorted by start time
 */
export function getCuesInRange(
    cues: ParsedCue[],
    startSeconds: number,
    endSeconds: number,
): ParsedCue[] {
    return cues
        .filter((cue) => cue.startSeconds >= startSeconds && cue.startSeconds < endSeconds)
        .sort((a, b) => a.startSeconds - b.startSeconds);
}

/**
 * Calculate segment index for a given time position.
 *
 * @param timeSeconds - Time position in seconds (clamped to >= 0)
 * @param segmentDuration - Duration of each segment in seconds (must be > 0)
 * @returns Segment index (0-based), or 0 if inputs are invalid
 */
export function getSegmentIndex(timeSeconds: number, segmentDuration: number): number {
    // Guard against invalid inputs
    if (segmentDuration <= 0) {
        return 0;
    }
    return Math.floor(Math.max(0, timeSeconds) / segmentDuration);
}

/**
 * Calculate time range for a segment using ABSOLUTE timeline mapping.
 *
 * Segment numbers ALWAYS map to absolute media time:
 * - Segment 0 = 0-6s
 * - Segment 1 = 6-12s
 * - Segment 150 = 900-906s
 *
 * This is INDEPENDENT of where FFmpeg currently is or where playback started.
 * The seekOffsetSeconds parameter is NO LONGER USED for time range calculation
 * (kept for backward compatibility but ignored).
 *
 * The VOD playlist approach means:
 * 1. Playlist shows full timeline from segment 0 to end
 * 2. AVPlayer loads playlist once, can seek anywhere
 * 3. Segments map to absolute positions
 * 4. Timestamp adjustment (for cue times) happens in generateSegment()
 *
 * @param segmentIndex - Segment index (0-based, clamped to >= 0)
 * @param segmentDuration - Duration of each segment in seconds (must be > 0)
 * @param totalDuration - Total media duration (for clamping last segment)
 * @param seekOffsetSeconds - DEPRECATED: No longer used for calculation (kept for API compat)
 * @returns Start and end times for the segment in absolute movie time
 */
export function getSegmentTimeRange(
    segmentIndex: number,
    segmentDuration: number,
    totalDuration: number,
    seekOffsetSeconds: number = 0,
): TimeRange {
    void seekOffsetSeconds; // Explicitly ignore - kept for backward compatibility

    // Guard against invalid inputs
    const safeIndex = Math.max(0, segmentIndex);
    const safeDuration = Math.max(0, segmentDuration);
    const safeTotal = Math.max(0, totalDuration);

    // ABSOLUTE timeline mapping: segment N always maps to N*duration seconds
    const startSeconds = safeIndex * safeDuration;
    const endSeconds = Math.min(startSeconds + safeDuration, safeTotal);
    return { startSeconds, endSeconds };
}
